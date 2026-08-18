/**
 * Whether a shielded NFT can actually be spent right now.
 *
 * The wallet holds an NFT as a shielded note, and a note is not spendable the
 * moment it exists — it carries a POI (proof of innocence) state, which the
 * engine exposes as a balance BUCKET. Only `Spendable` may be spent; the rest
 * are held-but-not-yet-usable.
 *
 * This distinction is invisible without help, and its absence reads as loss.
 * A failed relay-adapt batch re-shields what it unshielded, which does not
 * return the original note — it nullifies it and writes a NEW commitment, and
 * the new one starts un-matured. The position is on-chain, owned by RAILGUN,
 * and the wallet correctly lists it, but a spend fails deep in the engine with
 * `RAILGUN spendable private NFT balance too low` — a message that describes an
 * empty wallet, for a position the user can see. Naming the state is the fix.
 *
 * Pure: the bucket is passed in, so this needs no engine and no chain.
 */
import { RailgunWalletBalanceBucket } from "@railgun-community/shared-models";

export type NFTAvailability = "spendable" | "pending" | "blocked" | "unknown";

/**
 * Bucket -> availability.
 *
 * `MissingInternalPOI` / `MissingExternalPOI` count as pending rather than
 * blocked: they mean the proof has not been gathered YET, which resolves on its
 * own. `ShieldBlocked` is the one that does not, and it is the one worth
 * colouring differently — waiting on it is waiting forever.
 */
export const availabilityForBucket = (
  bucket: string | undefined,
): NFTAvailability => {
  switch (bucket) {
    case RailgunWalletBalanceBucket.Spendable:
      return "spendable";
    case RailgunWalletBalanceBucket.ShieldBlocked:
      return "blocked";
    case RailgunWalletBalanceBucket.ShieldPending:
    case RailgunWalletBalanceBucket.ProofSubmitted:
    case RailgunWalletBalanceBucket.MissingInternalPOI:
    case RailgunWalletBalanceBucket.MissingExternalPOI:
      return "pending";
    default:
      // Includes Spent, which should never reach a held-NFT list, and any
      // bucket a future engine adds. Claiming "spendable" for something this
      // does not recognise is the one answer that could lose a user money.
      return "unknown";
  }
};

/**
 * The most favourable bucket an NFT appears under.
 *
 * The cache is keyed by (txid version, bucket) and the same note can be
 * reported under both V2 and V3, so one NFT can carry two buckets. Spendable
 * wins: if any version says it can be spent, it can be.
 */
const RANK: Record<NFTAvailability, number> = {
  spendable: 0,
  pending: 1,
  unknown: 2,
  blocked: 3,
};

export const bestAvailability = (
  buckets: readonly (string | undefined)[],
): NFTAvailability => {
  if (buckets.length === 0) return "unknown";
  return buckets
    .map(availabilityForBucket)
    .reduce((best, next) => (RANK[next] < RANK[best] ? next : best));
};

/** Whether a spend built against this NFT can succeed. */
export const isSpendable = (availability: NFTAvailability): boolean =>
  availability === "spendable";

export interface AvailabilityLabel {
  text: string;
  colour: "green" | "yellow" | "red" | "gray";
  /** Why it cannot be spent, for a status line. Empty when it can. */
  note: string;
}

/**
 * How the state reads on screen.
 *
 * "pending" says what is happening AND that it resolves by itself, because the
 * question it has to answer is "is my position stuck?".
 */
export const availabilityLabel = (
  availability: NFTAvailability,
): AvailabilityLabel => {
  switch (availability) {
    case "spendable":
      return { text: "ready", colour: "green", note: "" };
    case "pending":
      return {
        text: "maturing",
        colour: "yellow",
        note: "held, not yet spendable — private proofs are still settling; this clears on its own",
      };
    case "blocked":
      return {
        text: "blocked",
        colour: "red",
        note: "this shield was blocked and will not become spendable",
      };
    default:
      return {
        text: "unknown",
        colour: "gray",
        note: "spendability could not be determined; treat as not yet spendable",
      };
  }
};
