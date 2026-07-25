/** Stub factory for SendPublicDeps with a call recorder. */
import { NetworkName } from "@railgun-community/shared-models";
import { TransactionResponse } from "ethers";
import { SendPublicDeps } from "../../../src/flows/send-public";

export interface SendPublicCalls {
  sent?: unknown;
  reset: number;
  watched?: { hash: string };
  mined?: { chain: NetworkName; hash: string };
}

const txResponse = (hash: string): TransactionResponse =>
  ({ hash }) as unknown as TransactionResponse;

export const makeSendPublicDeps = (
  over: Partial<SendPublicDeps> = {},
): { deps: SendPublicDeps; calls: SendPublicCalls } => {
  const calls: SendPublicCalls = { reset: 0 };
  const deps: SendPublicDeps = {
    currentWallet: () => ({
      sendTransaction: async (t) => {
        calls.sent = t;
        return txResponse("0xpublicHash");
      },
    }),
    txUrl: (_chain, hash) => `https://scan/${hash}`,
    resetScan: () => {
      calls.reset += 1;
    },
    watchSelf: async (tx) => {
      calls.watched = { hash: tx.hash };
    },
    notifyMined: (chain, hash) => {
      calls.mined = { chain, hash };
    },
    ...over,
  };
  return { deps, calls };
};
