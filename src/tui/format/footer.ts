/**
 * What the bottom bar says.
 *
 * Three things compete for one line, and the order between them is the whole
 * design. Work in flight wins: while a proof is generating or a scan is
 * running, that is the only thing the user is waiting on, and a message from a
 * minute ago sitting on top of it is worse than useless. A message comes next,
 * and only until it expires — a status line that never clears stops being a
 * status and becomes a label, which is how "Balances synced." ended up pinned
 * there for the rest of the session.
 *
 * Pure so the precedence can be asserted directly. `now` is a parameter for the
 * same reason.
 */
import { progressBar } from "./dashboard";

export interface FooterState {
  /** 0..100 while work is in flight; -1 when idle. */
  scanProgress: number;
  /** What that work is. Empty when there is nothing to say about it. */
  scanLabel: string;
  /** The most recent message, or "" for none. */
  status: string;
  /** Epoch ms after which `status` is stale. Undefined means it does not expire. */
  statusUntil?: number;
}

/** Whether a status message is still worth showing. */
export const statusLive = (state: FooterState, now: number): boolean =>
  state.status !== "" &&
  (state.statusUntil === undefined || now < state.statusUntil);

/**
 * The left-hand portion of the bottom bar, and whether it is noteworthy enough
 * to colour. Returns the text only — the caller owns the key hints beside it.
 */
export const footerStatus = (
  state: FooterState,
  now: number,
  barWidth = 18,
): { text: string; active: boolean } => {
  if (state.scanProgress >= 0) {
    const label = state.scanLabel || "Working";
    return { text: `${progressBar(state.scanProgress, barWidth)} ${label}`, active: true };
  }
  if (statusLive(state, now)) {
    return { text: state.status, active: true };
  }
  return { text: "ready", active: false };
};
