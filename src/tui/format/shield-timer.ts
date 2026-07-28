/**
 * When shielded funds become spendable.
 *
 * A shield sits in the ShieldPending bucket for an hour before it can be spent.
 * The bucket says *that* funds are waiting; it carries no clock, so "shielding"
 * with no other information reads as indefinite — the one question worth
 * answering is how much longer.
 *
 * Local transaction history has the timestamps. A shield still inside the
 * window is one whose funds are still pending, which is the same statement the
 * bucket is making, so the oldest of those is what matures next.
 *
 * Approximate by construction, and only in the safe direction: history that has
 * not caught up yet yields no countdown rather than a wrong one.
 */
import { POI_SHIELD_PENDING_SEC } from "@railgun-community/shared-models";
import { CoreHistoryItem } from "../../core/history";

export interface ShieldCountdown {
  /** Unix seconds at which the earliest pending shield matures. */
  readyAt: number;
  /** Whole seconds remaining; never negative. */
  remainingSec: number;
}

/**
 * The next shield to mature, from history. `now` is unix seconds.
 *
 * Undefined when nothing shielded within the window — which includes the case
 * where history has not loaded, deliberately: no clock is better than one
 * counting down to the wrong moment.
 */
export const nextShieldMaturity = (
  items: CoreHistoryItem[],
  now: number,
): ShieldCountdown | undefined => {
  const windowStart = now - POI_SHIELD_PENDING_SEC;
  const pending = items
    .filter(
      (item) =>
        // The FLAG, not the label. A relay-adapt re-shield is labelled "Swap"
        // or "Activity" and shields all the same; keying on the label meant no
        // countdown for the funds the DeFi flows produce.
        item.shielded === true &&
        typeof item.timestamp === "number" &&
        item.timestamp > windowStart &&
        item.timestamp <= now,
    )
    .map((item) => item.timestamp as number);
  if (!pending.length) return undefined;

  const oldest = Math.min(...pending);
  const readyAt = oldest + POI_SHIELD_PENDING_SEC;
  return { readyAt, remainingSec: Math.max(0, Math.ceil(readyAt - now)) };
};

/** "42m" · "8m 20s" · "35s" — coarse while far out, precise near the end. */
export const formatRemaining = (remainingSec: number): string => {
  if (remainingSec <= 0) return "any moment";
  const minutes = Math.floor(remainingSec / 60);
  const seconds = remainingSec % 60;
  if (minutes >= 10) return `${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

/**
 * The note beside the PRIVATE header: what is pending, and when the first of it
 * frees up. Without a countdown it keeps the bare summary rather than implying
 * a clock it does not have.
 */
export const pendingNote = (
  summary: string,
  countdown: ShieldCountdown | undefined,
): string =>
  countdown
    ? `${summary} · spendable in ${formatRemaining(countdown.remainingSec)}`
    : summary;
