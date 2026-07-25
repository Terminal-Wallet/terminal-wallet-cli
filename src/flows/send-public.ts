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
import { resetBalanceScan } from "../railgun/wallet/private-wallet";

export interface SendPublicDeps {
  currentWallet: () => {
    sendTransaction: (t: any) => Promise<TransactionResponse>;
  };
  txUrl: (chainName: NetworkName, hash: string) => string;
  resetScan: () => void;
  watchSelf: (tx: TransactionResponse) => Promise<void>;
  notifyMined: (chainName: NetworkName, hash: string) => void;
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
};

export const sendPublicTransaction = async (
  populatedTransaction: ContractTransaction,
  chainName: NetworkName,
  deps: SendPublicDeps = defaultDeps,
): Promise<SendOutcome> => {
  const wallet = deps.currentWallet();
  const txResult = await wallet.sendTransaction(populatedTransaction);
  deps.resetScan();
  void deps.watchSelf(txResult).then(() => deps.notifyMined(chainName, txResult.hash));
  return { hash: txResult.hash, url: deps.txUrl(chainName, txResult.hash) };
};
