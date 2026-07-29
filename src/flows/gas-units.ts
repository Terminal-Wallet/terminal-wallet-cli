/**
 * Nominal gas units per flow, before anything has been estimated.
 *
 * These drive two things that must agree: the broadcaster-fee preview, and the
 * amount the overspend check holds back so a send does not consume the balance
 * its own fee needs. An optimistic figure lets a build through that the real fee
 * cannot cover; a pessimistic one costs the user some headroom. Where a number
 * is a bound rather than a measurement it says so.
 *
 * In `flows/` rather than in the builder because a second host that reserved
 * different amounts would compute a different `max` for the same wallet on the
 * same chain, and the two would disagree about what is spendable.
 */

/** A private transfer or unshield: one proof, no contract calls. */
export const PRIVATE_GAS_UNITS = 250_000n;

/** A plain ERC20 transfer signed from the public wallet. */
export const PUBLIC_GAS_UNITS = 65_000n;

/**
 * Base-token shield: a 7702 relay-adapt bundle (wrap + shield), not a transfer.
 * Upper bound — delegation + execute + wrapBase + a shield commitment.
 */
export const SHIELD_BASE_GAS_UNITS = 450_000n;

/** Relay-adapt unshield-to-base: unshield + unwrap. Upper bound, not measured. */
export const RELAY_ADAPT_BASE_GAS_UNITS = 1_700_000n;

/** Private 0x swap: above the 2,520,949 measured by scripts/swap-estimate-probe. */
export const PRIVATE_SWAP_GAS_UNITS = 2_600_000n;
