/**
 * Stub run-deps for the cross-contract (private swap / cookbook recipe) pipeline,
 * so the swap rail is exercised THROUGH runTransaction without the un-DI'd inner
 * SDK calls in cross-contract.ts (a real seam there is tracked as a follow-up).
 * Pair with fixtures.crossContractSpec() and swapToCrossContractInputs().
 */
import { RailgunPopulateTransactionResponse } from "@railgun-community/shared-models";
import {
  TransactionRunDeps,
  SendOutcome,
} from "../../../src/flows/run";
import { CrossContractSpec } from "../../../src/flows/deps/cross-contract";
import { PrivateGasEstimate } from "../../../src/models/transaction-models";
import { privateGasEstimate } from "../fixtures/gas";
import { provedTransaction } from "../fixtures/proved";

type Proved = RailgunPopulateTransactionResponse;

export type CrossContractRunDeps = TransactionRunDeps<
  CrossContractSpec,
  PrivateGasEstimate,
  Proved,
  SendOutcome
>;

export const makeCrossContractRunDeps = (
  over: Partial<CrossContractRunDeps> = {},
): CrossContractRunDeps => ({
  estimateGas: async () => privateGasEstimate(),
  prove: async (_spec, _gas, onProgress) => {
    onProgress(50, "proving swap");
    onProgress(100);
    return provedTransaction();
  },
  send: async () => ({ hash: "0xswapHash", url: "https://scan/0xswapHash" }),
  ...over,
});
