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
import { getTransactionURLForChain } from "../railgun/network/network-util";
import { waitForRelayedTx, waitForTx } from "../railgun/transaction/public/public-tx";
import { resetBalanceScan } from "../railgun/wallet/private-wallet";
import { ratchetEphemeralIfRelayAdapt } from "../railgun/wallet/ephemeral-util";

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
  /** Wait for a broadcaster-relayed tx hash to mine. */
  watchRelayed: (chainName: NetworkName, hash: string) => Promise<void>;
  /** Wait for a self-signed tx response to mine. */
  watchSelf: (tx: TransactionResponse) => Promise<void>;
  /** Surface a "mined" status. */
  notifyMined: (chainName: NetworkName, hash: string) => void;
}

const defaultDeps: SendPrivateDeps = {
  broadcast: (tx, chainName, relayAdapt) =>
    getBroadcasterTranaction(tx, chainName, relayAdapt),
  signerWallet: (signer, chainName) =>
    getEthersWalletForSigner(signer, chainName),
  // External signers (an imported private key paying the gas) arrive with the
  // encrypted signer store. The FeeMode contract already carries the variant so
  // callers and tests can express it; only this default binding is absent, and
  // it fails loudly rather than silently doing something else.
  externalSignerWallet: () => {
    throw new Error(
      "External signers are not wired yet; use the self-signer or a broadcaster.",
    );
  },
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
    void deps.watchRelayed(chainName, hash).then(() => deps.notifyMined(chainName, hash));
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
  void deps.watchSelf(txResult).then(() => deps.notifyMined(chainName, txResult.hash));
  return { hash: txResult.hash, url: deps.txUrl(chainName, txResult.hash) };
};
