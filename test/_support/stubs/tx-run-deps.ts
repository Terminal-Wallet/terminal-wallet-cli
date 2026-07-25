/**
 * Stub factory for the generic transaction pipeline's deps. Defaults are the
 * happy path (estimate → prove with progress → send); override any leg per test.
 * Generalized from the inline `happyDeps` in run-transaction.test.ts.
 */
import {
  TransactionRunDeps,
  SendOutcome,
} from "../../../src/flows/run";

export type DefaultSpec = { token: string };
export type DefaultGas = { fee: number };
export type DefaultProved = { proof: string };
export type DefaultResult = { hash: string; url: string };

export const makeRunDeps = <
  Spec = DefaultSpec,
  Gas = DefaultGas,
  Proved = DefaultProved,
  Result extends SendOutcome = DefaultResult,
>(
  over: Partial<TransactionRunDeps<Spec, Gas, Proved, Result>> = {},
): TransactionRunDeps<Spec, Gas, Proved, Result> => ({
  estimateGas: async () => ({ fee: 1 }) as Gas,
  prove: async (_spec, _gas, onProgress) => {
    onProgress(50, "halfway");
    onProgress(100);
    return { proof: "0xproof" } as Proved;
  },
  send: async () =>
    ({ hash: "0xhash", url: "https://scan/0xhash" }) as Result,
  ...over,
});

/** A leg that always throws — for failure-propagation tests. */
export const throwing =
  (message: string) =>
  async (): Promise<never> => {
    throw new Error(message);
  };

export const throwingEstimate = (message = "estimate failed") =>
  throwing(message);
export const throwingSend = (message = "send failed") => throwing(message);
export const throwingProve = (message = "prove failed") => throwing(message);
