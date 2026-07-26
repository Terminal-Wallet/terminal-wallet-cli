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
