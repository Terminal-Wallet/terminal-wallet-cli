/**
 * Durable accounts for positions that are keyed to an address.
 *
 * Most things this wallet does use a fresh ephemeral account and then ratchet
 * past it, which is what keeps one batch unlinkable from the next. That works
 * because the things it holds are BEARER instruments — vault shares are ERC-20,
 * an f(x) position is an ERC-721 — so they can be shielded and later unshielded
 * to whatever account happens to be current.
 *
 * Morpho Blue positions are not bearer. They are ledger state inside the Blue
 * contract keyed by `onBehalf`, and they cannot be transferred. Supplying
 * collateral from a fresh account that is then ratcheted past would strand it:
 * the account that could withdraw it is one the wallet never uses again.
 *
 * So a position needs an account that stays reachable. The design constraint is
 * that reaching it must never be something an ORDINARY flow can do by accident,
 * because the never-reuse rule exists for a reason — a reused account holding
 * residual ETH or WETH can be swept by a later relay-adapt wrap step.
 *
 * The answer is a disjoint namespace. Position accounts live at index
 * BASE + slot, far above anything the ordinary counter can reach: it advances
 * by one per type-4 send, and history reconciliation walks the low indices with
 * a small gap limit. Nothing in the SDK or this wallet can hand a band index to
 * a normal flow, so the separation is structural rather than a guard someone
 * has to remember.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { getEphemeralAddressForIndex } from "./ephemeral-util";

/**
 * The first index reserved for position accounts.
 *
 * Chosen to be unreachable rather than merely unlikely. BIP-32 hardened
 * segments allow anything below 2^31, so this is well inside the derivable
 * range while being far beyond a counter that moves one step per transaction.
 */
export const POSITION_INDEX_BASE = 1_000_000;

/**
 * How many position accounts a wallet may hold.
 *
 * A hard ceiling, not a wrapping one: wrapping would silently hand a second
 * position the account of a first that is still open, and Morpho would treat
 * them as one position with both sets of collateral and debt.
 */
export const MAX_POSITION_SLOTS = 64;

export class PositionSlotsExhausted extends Error {
  constructor() {
    super(
      `All ${MAX_POSITION_SLOTS} position accounts are in use. Close a position before opening another.`,
    );
    this.name = "PositionSlotsExhausted";
  }
}

/** Whether an index belongs to the reserved band rather than the ordinary run. */
export const isPositionIndex = (index: number): boolean =>
  Number.isInteger(index) &&
  index >= POSITION_INDEX_BASE &&
  index < POSITION_INDEX_BASE + MAX_POSITION_SLOTS;

/**
 * The ephemeral index backing a slot.
 *
 * Deterministic, so a wallet restored from its seed on another machine derives
 * the same accounts and can still reach its positions — the registry is a
 * convenience, never the only way back.
 */
export const positionIndexForSlot = (slot: number): number => {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_POSITION_SLOTS) {
    throw new PositionSlotsExhausted();
  }
  return POSITION_INDEX_BASE + slot;
};

/** The slot an index belongs to, or undefined if it is not a position index. */
export const slotForPositionIndex = (index: number): number | undefined =>
  isPositionIndex(index) ? index - POSITION_INDEX_BASE : undefined;

/** The address a slot's position lives at. Derived locally; no RPC, no leak. */
export const positionAccountAddress = (
  chainName: NetworkName,
  encryptionKey: string,
  slot: number,
): Promise<string> =>
  getEphemeralAddressForIndex(
    chainName,
    encryptionKey,
    positionIndexForSlot(slot),
  );

/**
 * The lowest slot not present in `taken`.
 *
 * Absence from the registry is NOT on its own evidence that a slot is free —
 * a registry can be lost or predate a rediscovery — so callers must confirm
 * against the chain before allocating. This only proposes.
 */
export const nextFreeSlot = (taken: readonly number[]): number => {
  const used = new Set(taken);
  for (let slot = 0; slot < MAX_POSITION_SLOTS; slot++) {
    if (!used.has(slot)) return slot;
  }
  throw new PositionSlotsExhausted();
};
