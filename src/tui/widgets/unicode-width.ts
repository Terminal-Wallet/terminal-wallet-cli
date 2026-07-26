/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Teach blessed that emoji are two cells wide.
 *
 * blessed measures text with its own `charWidth`, a hardcoded range check
 * written before the emoji blocks existed. It knows the CJK and fullwidth
 * ranges — `＋` measures 2 correctly — but every emoji comes back as 1 while
 * the terminal draws it across two cells. blessed then places the border one
 * column early, the glyph's second half lands on top of it, and the frame
 * visibly breaks. Astral emoji are affected as much as BMP ones; the surrogate
 * pair is irrelevant to the width table.
 *
 * `strWidth` delegates to `charWidth`, and the renderer's two "skip the second
 * cell of a wide char" branches call it directly, so patching this one function
 * covers measurement and drawing together. Both renderer branches are gated on
 * `fullUnicode`, which the deck enables.
 *
 * Installed once, before any screen is created.
 *
 * The ambiguous cases are the reason `emoji()` exists below. Codepoints like
 * U+2699 GEAR are East Asian Ambiguous: Unicode says one cell, most modern
 * terminals draw two, and neither answer is right everywhere. Appending
 * VARIATION SELECTOR-16 forces emoji presentation, which makes the width
 * unambiguous — and blessed already scores VS16 as zero, so the pair measures
 * exactly 2.
 */
import unicode from "blessed/lib/unicode";

/** U+FE0F — forces emoji (wide) presentation on an otherwise-ambiguous glyph. */
const VARIATION_SELECTOR_16 = "️";

/**
 * Emoji-presentation codepoints blessed scores as 1.
 *
 * The astral blocks are wholesale; the BMP entries are listed because those
 * ranges are shared with single-cell dingbats the layout relies on (`✕`, `→`,
 * `▲`), and widening those would break the very frames this exists to fix.
 */
const BMP_EMOJI = new Set([
  0x231a, 0x231b, 0x23f0, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x267f,
  0x2693, 0x2699, 0x26a0, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4,
  0x26c5, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd,
  0x2705, 0x270a, 0x270b, 0x2728, 0x274c, 0x274e, 0x2753, 0x2754, 0x2755,
  0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b22,
  0x2b50, 0x2b55,
]);

export const isWideEmoji = (codePoint: number): boolean =>
  (codePoint >= 0x1f000 && codePoint <= 0x1faff) || BMP_EMOJI.has(codePoint);

let installed = false;

/** Idempotent — a second call is a no-op rather than a double-wrap. */
export const installEmojiWidth = (): void => {
  if (installed) return;
  installed = true;

  const original = unicode.charWidth.bind(unicode);
  (unicode as any).charWidth = (str: string | number, i?: number): number => {
    const point =
      typeof str !== "number" ? unicode.codePointAt(str, i ?? 0) : str;
    return isWideEmoji(point) ? 2 : original(str as any, i as any);
  };
};

/**
 * Mark a glyph as emoji-presentation so its width is not left to the terminal's
 * interpretation. Use for anything drawn on a border.
 */
export const emoji = (glyph: string): string =>
  glyph.endsWith(VARIATION_SELECTOR_16) ? glyph : glyph + VARIATION_SELECTOR_16;
