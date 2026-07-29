/**
 * Send step for public (ethers) transactions: sign + send the populated tx with
 * the current wallet, then — matching the original builder — reset the balance
 * scan and watch the tx in the background. SDK/side-effects injected.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { ContractTransaction, TransactionResponse } from "ethers";
import { SendOutcome } from "./run";
import { emitCoreEvent } from "../core/events";
import { getCurrentEthersWallet } from "../railgun/wallet/public-utils";
import { getTransactionURLForChain } from "../railgun/network/network-util";
import { waitForTx } from "../railgun/transaction/public/public-tx";
import { TxSettlement } from "../railgun/transaction/public/settlement";
import { resetBalanceScan } from "../railgun/wallet/private-wallet";
import { ratchetEphemeralIfRelayAdapt } from "../railgun/wallet/ephemeral-util";

export interface SendPublicDeps {
  currentWallet: () => {
    sendTransaction: (t: any) => Promise<TransactionResponse>;
  };
  txUrl: (chainName: NetworkName, hash: string) => string;
  resetScan: () => void;
  watchSelf: (tx: TransactionResponse) => Promise<TxSettlement>;
  notifyMined: (chainName: NetworkName, hash: string) => void;
  /** Surface a transaction the chain rejected outright. */
  notifyReverted: (chainName: NetworkName, hash: string) => void;
  /** Surface a transaction whose outcome could not be read. */
  notifyUnsettled: (
    chainName: NetworkName,
    hash: string,
    reason: string,
  ) => void;
}

const defaultDeps: SendPublicDeps = {
  currentWallet: getCurrentEthersWallet,
  txUrl: getTransactionURLForChain,
  resetScan: resetBalanceScan,
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
      text:
        `Transaction broadcast, but its outcome could not be confirmed ` +
        `(${reason}) — ${getTransactionURLForChain(chainName, hash)}`,
      durationMs: 120000,
      replace: true,
    }),
};

export const sendPublicTransaction = async (
  populatedTransaction: ContractTransaction,
  chainName: NetworkName,
  deps: SendPublicDeps = defaultDeps,
): Promise<SendOutcome> => {
  const wallet = deps.currentWallet();
  const txResult = await wallet.sendTransaction(populatedTransaction);
  // Self-signed base-token shields are type-4 bundles too — they wrap and
  // shield through Relay-Adapt from an ephemeral account, without a broadcaster.
  // The helper no-ops on everything else.
  await ratchetEphemeralIfRelayAdapt(chainName, populatedTransaction);
  deps.resetScan();
  // The receipt decides, not the fact that the watcher returned. A public
  // transfer that reverts costs the gas and moves nothing, and reporting it as
  // mined is how a caller comes to believe a payment was made.
  void deps.watchSelf(txResult).then((settlement) => {
    if (settlement.kind === "reverted") {
      deps.notifyReverted(chainName, txResult.hash);
    } else if (settlement.kind === "unknown") {
      deps.notifyUnsettled(chainName, txResult.hash, settlement.reason);
    } else {
      deps.notifyMined(chainName, txResult.hash);
    }
  });
  return { hash: txResult.hash, url: deps.txUrl(chainName, txResult.hash) };
};
