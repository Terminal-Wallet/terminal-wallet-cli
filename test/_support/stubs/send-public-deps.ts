/** Stub factory for SendPublicDeps with a call recorder. */
import { NetworkName } from "@railgun-community/shared-models";
import { TransactionResponse } from "ethers";
import { SendPublicDeps } from "../../../src/flows/send-public";

export interface SendPublicCalls {
  sent?: unknown;
  reset: number;
  watched?: { hash: string };
  mined?: { chain: NetworkName; hash: string };
  reverted?: { chain: NetworkName; hash: string };
  unsettled?: { chain: NetworkName; hash: string; reason: string };
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
    // Settles as mined by default; a revert test overrides it.
    watchSelf: async (tx) => {
      calls.watched = { hash: tx.hash };
      return { kind: "mined" as const };
    },
    notifyMined: (chain, hash) => {
      calls.mined = { chain, hash };
    },
    notifyReverted: (chain, hash) => {
      calls.reverted = { chain, hash };
    },
    notifyUnsettled: (chain, hash, reason) => {
      calls.unsettled = { chain, hash, reason };
    },
    ...over,
  };
  return { deps, calls };
};
