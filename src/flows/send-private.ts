/**
 * Shared send step for private transactions (transfer / unshield / unshield-base
 * / private swap). Picks the broadcaster (Waku) or self-signer path, submits,
 * then — matching the original builder — resets the balance scan and watches the
 * tx in the background, emitting a "mined" status when it lands.
 *
 * All SDK/side-effecting calls are injected (default = real) so the path
 * selection, relay-adapt wiring, and post-submit behavior are unit-testable.
 */
import {
  NetworkName,
  RailgunPopulateTransactionResponse,
} from "@railgun-community/shared-models";
import { TransactionResponse } from "ethers";
import { RailgunTransaction } from "../models/transaction-models";
import { WalletCache } from "../models/wallet-models";
import { FeeMode, useRelayAdapt } from "./spec";
import { SendOutcome } from "./run";
import { emitCoreEvent } from "../core/events";
import { getBroadcasterTranaction } from "../railgun/transaction/private/private-tx";
import { getEthersWalletForSigner } from "../railgun/wallet/public-utils";
import { getExternalSignerWallet } from "../railgun/wallet/external-signers";
import { getTransactionURLForChain } from "../railgun/network/network-util";
import { waitForRelayedTx, waitForTx } from "../railgun/transaction/public/public-tx";
import { TxSettlement } from "../railgun/transaction/public/settlement";
import { resetBalanceScan } from "../railgun/wallet/private-wallet";
import { ratchetEphemeralIfRelayAdapt } from "../railgun/wallet/ephemeral-util";
import { getRelayAdaptFailure } from "../railgun/transaction/relay-adapt-error";

export interface SendPrivateDeps {
  broadcast: (
    tx: any,
    chainName: NetworkName,
    relayAdapt: boolean,
  ) => Promise<{ send: () => Promise<string> }>;
  signerWallet: (
    signer: WalletCache,
    chainName: NetworkName,
  ) => Promise<{ sendTransaction: (t: any) => Promise<TransactionResponse> }>;
  externalSignerWallet: (
    label: string,
    chainName: NetworkName,
  ) => Promise<{ sendTransaction: (t: any) => Promise<TransactionResponse> }>;
  txUrl: (chainName: NetworkName, hash: string) => string;
  /** Reset the balance scan so balances refresh after submission. */
  resetScan: () => void;
  /** Wait for a broadcaster-relayed tx hash to settle, and say how it settled. */
  watchRelayed: (chainName: NetworkName, hash: string) => Promise<TxSettlement>;
  /** Wait for a self-signed tx response to settle, and say how it settled. */
  watchSelf: (tx: TransactionResponse) => Promise<TxSettlement>;
  /** Surface a "mined" status. */
  notifyMined: (chainName: NetworkName, hash: string) => void;
  /** Surface a transaction the chain rejected outright. */
  notifyReverted: (chainName: NetworkName, hash: string) => void;
  /** Surface a transaction whose outcome could not be read. */
  notifyUnsettled: (
    chainName: NetworkName,
    hash: string,
    reason: string,
  ) => void;
  /**
   * The failure a mined relay-adapt batch is carrying, if any. A relay-adapt
   * transaction can succeed while the work inside it reverts.
   */
  relayAdaptFailure: (
    chainName: NetworkName,
    hash: string,
  ) => Promise<string | undefined>;
  /** Surface a batch that mined without doing what it said. */
  notifyBatchFailed: (
    chainName: NetworkName,
    hash: string,
    reason: string,
  ) => void;
}

const defaultDeps: SendPrivateDeps = {
  broadcast: (tx, chainName, relayAdapt) =>
    getBroadcasterTranaction(tx, chainName, relayAdapt),
  signerWallet: (signer, chainName) =>
    getEthersWalletForSigner(signer, chainName),
  externalSignerWallet: (label, chainName) =>
    getExternalSignerWallet(label, chainName),
  txUrl: getTransactionURLForChain,
  resetScan: resetBalanceScan,
  watchRelayed: (chainName, hash) => waitForRelayedTx(chainName, hash),
  watchSelf: (tx) => waitForTx(tx),
  notifyMined: (chainName, hash) =>
    emitCoreEvent({
      type: "status:message",
      text: `Transaction mined: ${getTransactionURLForChain(chainName, hash)}`,
      durationMs: 30000,
      replace: true,
    }),
  notifyReverted: (chainName, hash) =>
    emitCoreEvent({
      type: "status:message",
      text:
        `Transaction REVERTED — nothing was sent. ` +
        `${getTransactionURLForChain(chainName, hash)}`,
      durationMs: 120000,
      replace: true,
    }),
  notifyUnsettled: (chainName, hash, reason) =>
    emitCoreEvent({
      type: "status:message",
      // Not a failure and not a success: the transaction is on chain and its
      // outcome is simply unread. Saying "mined" here is what this whole path
      // exists to stop.
      text:
        `Transaction broadcast, but its outcome could not be confirmed ` +
        `(${reason}) — ${getTransactionURLForChain(chainName, hash)}`,
      durationMs: 120000,
      replace: true,
    }),
  relayAdaptFailure: getRelayAdaptFailure,
  notifyBatchFailed: (chainName, hash, reason) =>
    emitCoreEvent({
      type: "status:message",
      // The transaction mined, so "failed" needs saying plainly or it reads as
      // a warning about something that still worked.
      text:
        `Transaction mined but the batch did not complete (${reason}). ` +
        `Funds may be recoverable from the ephemeral account: ` +
        `${getTransactionURLForChain(chainName, hash)}`,
      durationMs: 120000,
      replace: true,
    }),
};

/**
 * Report the batch, once the watcher has stopped watching.
 *
 * Two questions, asked in order, because the second only makes sense if the
 * first says yes. Did the transaction execute at all — the receipt's status,
 * which is the only authority on that? And if it did, did the work inside the
 * batch complete — the relay-adapt CallError, which is a separate failure a
 * successful receipt can still be carrying.
 *
 * Only a settlement of `mined` reaches the second question. A revert has no
 * batch to interrogate, and an unread outcome must not be reported as either
 * one.
 */
const settled = async (
  deps: SendPrivateDeps,
  chainName: NetworkName,
  hash: string,
  isRelayAdapt: boolean,
  settlement: TxSettlement,
): Promise<void> => {
  if (settlement.kind === "unknown") {
    deps.notifyUnsettled(chainName, hash, settlement.reason);
    return;
  }
  if (settlement.kind === "reverted") {
    deps.notifyReverted(chainName, hash);
    return;
  }
  const failure = isRelayAdapt
    ? await deps.relayAdaptFailure(chainName, hash)
    : undefined;
  if (failure) deps.notifyBatchFailed(chainName, hash, failure);
  else deps.notifyMined(chainName, hash);
};

/**
 * Advance the ephemeral index after a successful submission.
 *
 * Relay-adapt bundles execute from a per-call ephemeral account. Reusing one
 * would invalidate the next bundle's authorization nonce and can sweep residual
 * balance left at that address, so the index must move exactly once per
 * successful send.
 *
 * The helper no-ops on anything that is not a type-4 transaction, so calling it
 * on every send path is correct and keeps the rule in one place instead of at
 * each of the three call sites it used to be spread across.
 */
export const sendPrivateTransaction = async (
  proved: RailgunPopulateTransactionResponse,
  fee: FeeMode,
  chainName: NetworkName,
  type: RailgunTransaction,
  deps: SendPrivateDeps = defaultDeps,
): Promise<SendOutcome> => {
  if (fee.kind === "broadcaster") {
    const finalTx = await deps.broadcast(
      {
        ...proved,
        feesID: fee.broadcaster.tokenFee.feesID,
        selectedBroadcasterAddress: fee.broadcaster.railgunAddress,
      },
      chainName,
      useRelayAdapt(type),
    );
    const hash = await finalTx.send();
    await ratchetEphemeralIfRelayAdapt(chainName, proved.transaction);
    deps.resetScan();
    void deps
      .watchRelayed(chainName, hash)
      .then((settlement) =>
        settled(deps, chainName, hash, useRelayAdapt(type), settlement),
      );
    return { hash, url: deps.txUrl(chainName, hash) };
  }

  // Self-sign: pay gas with your own public wallet, or an imported external key.
  const wallet =
    fee.kind === "external-signer"
      ? await deps.externalSignerWallet(fee.label, chainName)
      : await deps.signerWallet(fee.signer, chainName);
  const txResult = await wallet.sendTransaction(proved.transaction);
  await ratchetEphemeralIfRelayAdapt(chainName, proved.transaction);
  deps.resetScan();
  void deps
    .watchSelf(txResult)
    .then((settlement) =>
      settled(deps, chainName, txResult.hash, useRelayAdapt(type), settlement),
    );
  return { hash: txResult.hash, url: deps.txUrl(chainName, txResult.hash) };
};
