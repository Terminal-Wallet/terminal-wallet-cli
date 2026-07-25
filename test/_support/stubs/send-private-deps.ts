/**
 * Stub factory for SendPrivateDeps with a call recorder, so path selection
 * (broadcaster / self-signer / external-signer), relay-adapt wiring, and
 * post-submit behavior (resetScan, watch, notifyMined) are assertable.
 * Generalized from the inline `spyDeps()` in send-private.test.ts.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { TransactionResponse } from "ethers";
import { SendPrivateDeps } from "../../../src/flows/send-private";

export interface SendPrivateCalls {
  broadcast?: { tx: unknown; chain: NetworkName; relayAdapt: boolean };
  signer?: { signer: unknown; chain: NetworkName };
  externalSigner?: { label: string; chain: NetworkName };
  sent?: unknown;
  reset: number;
  watched?: { kind: "relayed" | "self"; hash: string };
  mined?: { chain: NetworkName; hash: string };
}

const txResponse = (hash: string): TransactionResponse =>
  ({ hash }) as unknown as TransactionResponse;

export const makeSendPrivateDeps = (
  over: Partial<SendPrivateDeps> = {},
): { deps: SendPrivateDeps; calls: SendPrivateCalls } => {
  const calls: SendPrivateCalls = { reset: 0 };
  const deps: SendPrivateDeps = {
    broadcast: async (tx, chain, relayAdapt) => {
      calls.broadcast = { tx, chain, relayAdapt };
      return { send: async () => "0xbroadcastHash" };
    },
    signerWallet: async (signer, chain) => {
      calls.signer = { signer, chain };
      return {
        sendTransaction: async (t) => {
          calls.sent = t;
          return txResponse("0xselfHash");
        },
      };
    },
    externalSignerWallet: async (label, chain) => {
      calls.externalSigner = { label, chain };
      return {
        sendTransaction: async (t) => {
          calls.sent = t;
          return txResponse("0xexternalHash");
        },
      };
    },
    txUrl: (_chain, hash) => `https://scan/${hash}`,
    resetScan: () => {
      calls.reset += 1;
    },
    watchRelayed: async (_chain, hash) => {
      calls.watched = { kind: "relayed", hash };
    },
    watchSelf: async (tx) => {
      calls.watched = { kind: "self", hash: tx.hash };
    },
    notifyMined: (chain, hash) => {
      calls.mined = { chain, hash };
    },
    ...over,
  };
  return { deps, calls };
};
