/**
 * Fee helpers — protocol fee math, and the persisted default fee preference.
 *
 * Merged because they are both small, both pure, and both about "what does
 * this cost and who pays it". Kept out of the deps adapters so a preview can
 * be computed without touching the SDK.
 */
export const FEE_DENOM = 1_000_000_000n;

/** Protocol fee charged on `amount` at `basisPoints` (out of FEE_DENOM). */
export const protocolFee = (amount: bigint, basisPoints: bigint): bigint =>
  (amount * basisPoints) / FEE_DENOM;

/** Basis points as a human percentage (e.g. 2_500_000n → 0.25). */
export const feePct = (basisPoints: bigint): number =>
  (Number(basisPoints) / Number(FEE_DENOM)) * 100;

import { FeeMode } from "./spec";

/** The persistable string form of a chosen fee mode (broadcaster → self-signer). */
export const feePrefValue = (fee: FeeMode): string =>
  fee.kind === "external-signer" ? `external:${fee.label}` : "self-signer";

/**
 * Parse a stored preference into a signer choice. An "external:<label>" pref
 * whose signer no longer exists falls back to self-signer (the signer may have
 * been removed since the default was set).
 */
export const parseFeePref = (
  pref: string | undefined,
  knownLabels: string[],
): { kind: "self-signer" } | { kind: "external-signer"; label: string } => {
  const prefix = "external:";
  if (pref && pref.startsWith(prefix)) {
    const label = pref.slice(prefix.length);
    if (knownLabels.includes(label)) return { kind: "external-signer", label };
  }
  return { kind: "self-signer" };
};
