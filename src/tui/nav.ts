/**
 * Pure 2D menu navigation.
 *
 * Grid movement is the bug-prone part of a keyboard UI — wrapping at edges,
 * skipping disabled entries, jumping between columns — so it is kept free of
 * any renderer and unit-tested on its own.
 */
import { MenuAction, MenuGroup, GROUP_ORDER } from "./actions";

export interface NavColumn {
  group: MenuGroup;
  ids: string[]; // selectable (non-disabled) action ids, in display order
}

export interface NavPos {
  col: number;
  row: number;
}

export type NavDir = "left" | "right" | "up" | "down";

export const clampIndex = (n: number, max: number): number =>
  Math.max(0, Math.min(n, max));

/** Selectable ids grouped by column, dropping columns with nothing selectable. */
export const buildNavColumns = (actions: MenuAction[]): NavColumn[] =>
  GROUP_ORDER.map((group) => ({
    group,
    ids: actions
      .filter((a) => a.group === group && !a.disabled)
      .map((a) => a.id),
  })).filter((c) => c.ids.length > 0);

/**
 * Move the cursor in 2D: left/right change columns (row clamped into the new,
 * possibly shorter, column); up/down wrap within the current column.
 */
export const moveCursor = (
  cols: NavColumn[],
  pos: NavPos,
  dir: NavDir,
): NavPos => {
  if (cols.length === 0) return pos;
  let { col, row } = pos;
  const ncols = cols.length;

  if (dir === "left" || dir === "right") {
    col = dir === "left" ? (col - 1 + ncols) % ncols : (col + 1) % ncols;
    row = clampIndex(row, cols[col].ids.length - 1);
  } else {
    const len = cols[col].ids.length;
    const r = clampIndex(row, len - 1);
    row = dir === "up" ? (r - 1 + len) % len : (r + 1) % len;
  }
  return { col, row };
};

/** The selected action id at a position (undefined if out of range). */
export const idAt = (cols: NavColumn[], pos: NavPos): string | undefined =>
  cols[pos.col]?.ids[pos.row];

// --- who owns the input -------------------------------------------------

/** What the deck can be showing over itself. */
export type DeckMode = "home" | "palette" | "build";

/** What a click on the deck's own chrome should do, given what is over it. */
export type ClickVerdict =
  /** Nothing is in the way. */
  | "act"
  /** A chooser is in the way, and choosing something else is a fair answer. */
  | "closeThenAct"
  /** Half a transaction is in the way. Say so; do not throw it away. */
  | "refuse"
  /** A dialog is in the way and its scrim already ate the click. */
  | "ignore";

/**
 * What a click on the deck means while something is over it.
 *
 * The deck's chrome stays visible behind whatever is on top, and every bit of
 * it is clickable. Clicking a stat card or a balance with the transaction card
 * open put a second screen ON TOP of a half-built transaction and orphaned the
 * one underneath: the new screen owns the mode, so Escape closed that instead,
 * and the card could no longer be reached at all.
 *
 * Three answers rather than a yes/no, because the three cases genuinely differ.
 * The palette is a chooser — clicking something else IS the choice, so it
 * closes and acts. The card holds work that cannot be recreated by clicking
 * again, so it refuses and says why. A dialog's scrim has already swallowed
 * the click, so anything reaching here under one is a stray.
 */
export const deckClickVerdict = (
  mode: DeckMode,
  modalDepth: number,
): ClickVerdict => {
  if (modalDepth > 0) return "ignore";
  if (mode === "build") return "refuse";
  if (mode === "palette") return "closeThenAct";
  return "act";
};

/**
 * Whether the deck's own Escape should act.
 *
 * Escape is exempt from the modal key grab (`screen.ignoreLocked`) so a dialog
 * can always be dismissed even after focus moves underneath it — which means
 * every screen-level Escape handler hears it too. Without this the Escape that
 * closed the card's token picker also closed the card behind it, dropping the
 * user back on the deck mid-build.
 */
export const escapeReachesDeck = (modalDepth: number): boolean =>
  modalDepth === 0;
