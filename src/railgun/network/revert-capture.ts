/**
 * Keep the chain's revert reason, which the SDK discards.
 *
 * A relay-adapt failure is wrapped as "RelayAdapt multicall failed at index N"
 * before the SDK's sanitizer runs. The sanitizer matches on the message, so the
 * rewritten one no longer matches any of its known contract errors and falls
 * through to a branch that returns a fresh Error with no `cause`. The actual
 * reason — "RailgunSmartWallet: Invalid Merkle Root", "Note Already Spent" —
 * never escapes, and "index UNKNOWN" is what the user is left with.
 *
 * So the reason is read where it still exists: the provider's own rejection,
 * before the SDK sees it.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { getProviderForChain } from "./network-util";
import { createLogger } from "../../platform/logger";

const log = createLogger("revert");

interface EstimatingProvider {
  estimateGas: (tx: unknown) => Promise<bigint>;
  __revertCaptureInstalled?: boolean;
}

let lastRevert: string | undefined;

/** Known reverts, with what to do about them. */
const GUIDANCE: [RegExp, string][] = [
  [
    /invalid merkle root/i,
    "your local merkletree does not match the chain — run a full rescan",
  ],
  [/note already spent/i, "these notes were already spent — rescan balances"],
  [/invalid note value/i, "the amount is not valid for these notes"],
  [/unsupported token/i, "this token cannot interact with the RAILGUN contract"],
  [/not enough gas supplied/i, "the gas limit was below the relay-adapt floor"],
];

const reasonOf = (err: unknown): string | undefined => {
  const e = err as { shortMessage?: string; reason?: string; message?: string };
  return e?.reason ?? e?.shortMessage ?? e?.message;
};

/**
 * Wrap the chain provider's estimateGas so a revert reason is recorded.
 * Idempotent — a second call on the same provider is a no-op.
 */
export const installRevertCapture = (chainName: NetworkName): void => {
  let provider: EstimatingProvider;
  try {
    provider = getProviderForChain(chainName) as unknown as EstimatingProvider;
  } catch {
    return; // pre-boot; the caller retries after the provider loads
  }
  if (!provider?.estimateGas || provider.__revertCaptureInstalled) return;

  const estimate = provider.estimateGas.bind(provider);
  provider.estimateGas = async (tx: unknown) => {
    try {
      return await estimate(tx);
    } catch (err) {
      const reason = reasonOf(err);
      if (reason) {
        lastRevert = reason;
        log.debug(`estimateGas reverted: ${reason}`);
      }
      throw err;
    }
  };
  provider.__revertCaptureInstalled = true;
};

/** A revert reason with what to do about it, when it is one we recognise. */
export const describeRevert = (reason: string): string => {
  const hint = GUIDANCE.find(([pattern]) => pattern.test(reason))?.[1];
  return hint ? `${reason} — ${hint}` : reason;
};

/**
 * The last revert reason, described. Cleared as it is read, so a later
 * unrelated failure cannot inherit it.
 */
export const takeLastRevert = (): string | undefined => {
  const reason = lastRevert;
  lastRevert = undefined;
  return reason === undefined ? undefined : describeRevert(reason);
};
