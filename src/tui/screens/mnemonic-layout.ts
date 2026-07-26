/**
 * Pure responsive layout for the recovery-phrase modal: choose a column count
 * that fits the available width and chunk the (1-based numbered) words into rows.
 * Renderer-agnostic so the column math is unit-tested; the blessed modal formats
 * + colours the cells.
 */
export interface MnemonicCell {
  n: number; // 1-based word index
  word: string;
}

// A cell renders as "NN. word" + a small gap. BIP39 words are ≤ 8 chars, so a
// 14-col cell holds the widest comfortably.
const CELL_W = 14;
const MAX_COLS = 4; // cap for readability even on very wide terminals

/** Column count that fits `width`, clamped to [1, MAX_COLS]. */
export const mnemonicColumns = (width: number): number => {
  const cols = Math.floor((Math.max(0, width) + 2) / CELL_W);
  return Math.min(MAX_COLS, Math.max(1, cols));
};

/** Numbered word grid: rows of cells, `mnemonicColumns(width)` per row. */
export const layoutMnemonic = (words: string[], width: number): MnemonicCell[][] => {
  const cols = mnemonicColumns(width);
  const rows: MnemonicCell[][] = [];
  for (let i = 0; i < words.length; i += cols) {
    rows.push(words.slice(i, i + cols).map((word, j) => ({ n: i + j + 1, word })));
  }
  return rows;
};
