/**
 * No double-width glyphs in border chrome.
 *
 * blessed positions a border by counting JavaScript string length. Terminals
 * draw by display width, and the two disagree for emoji — `⚙`, `⬢`, `⛽`, `⭐`
 * and `＋` all report length 1 and occupy two cells. blessed reserves one, the
 * terminal takes two, and every character after the label shifts by one: the
 * box's top border visibly breaks, and a wide glyph in a modal's body pushes
 * that line out past the frame.
 *
 * Astral emoji fail the other way (length 2, drawn as 2) and are no safer to
 * rely on, so both are banned from labels and titles. Content inside a list row
 * is free to use whatever it likes — it is clipped, not measured against a
 * frame.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const SRC = resolve(process.cwd(), "src");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? walk(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });

/**
 * Characters a terminal draws wider than their JavaScript length.
 *
 * Three groups, listed rather than swept by range, because the ranges overlap
 * heavily with single-cell dingbats the layout depends on — an over-broad rule
 * would ban `✕` and `→` and be quietly turned off:
 *
 *  - everything outside the BMP (a surrogate pair, always emoji here)
 *  - the fullwidth forms block
 *  - the BMP codepoints that default to emoji presentation, which are the
 *    dangerous ones: length 1, drawn as 2
 */
const BMP_EMOJI = new Set([
  "\u231A", "\u231B", "\u23F0", "\u23F3", "\u25FD", "\u25FE",
  "\u2614", "\u2615", "\u267F", "\u2693", "\u2699", "\u26A0", "\u26A1",
  "\u26AA", "\u26AB", "\u26BD", "\u26BE", "\u26C4", "\u26C5", "\u26CE",
  "\u26D4", "\u26EA", "\u26F2", "\u26F3", "\u26F5", "\u26FA", "\u26FD",
  "\u2705", "\u270A", "\u270B", "\u2728", "\u274C", "\u274E", "\u2753",
  "\u2754", "\u2755", "\u2757", "\u2795", "\u2796", "\u2797", "\u27B0",
  "\u27BF", "\u2B1B", "\u2B1C", "\u2B22", "\u2B50", "\u2B55",
]);

const isWide = (text: string): boolean => {
  for (const char of text) {
    if (char.codePointAt(0)! > 0xffff) return true; // astral
    if (char >= "\uFF01" && char <= "\uFF60") return true; // fullwidth
    if (BMP_EMOJI.has(char)) return true;
  }
  return false;
};

/** `label: "..."` and `title: "..."` string literals — the chrome measured against a frame. */
const CHROME = /\b(?:label|title):\s*(["'])((?:\\.|(?!\1).)*)\1/g;

test("no border chrome uses a glyph the terminal draws wide", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, "utf-8");
    for (const [, , literal] of source.matchAll(CHROME)) {
      if (isWide(literal)) {
        offenders.push(`${relative(process.cwd(), file)}: ${JSON.stringify(literal)}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these shift the border they sit on:\n  ${offenders.join("\n  ")}`,
  );
});

test("the detector recognises the glyphs that actually broke the deck", () => {
  // Guarding the guard: a regex that matched nothing would pass the test above
  // for the wrong reason. Every one of these was on a border.
  for (const glyph of ["👤", "⬢", "📡", "⛽", "⚙", "🔑", "🔒", "🚫", "⭐", "＋"]) {
    assert.ok(isWide(glyph), `${glyph} should be flagged`);
  }
});

test("single-cell glyphs the UI relies on are not flagged", () => {
  // Over-broad would be its own problem — these are genuinely one cell and the
  // layout is built on them.
  for (const glyph of ["·", "—", "…", "▲", "▼", "✕", "▸", "→", "─"]) {
    assert.ok(!isWide(glyph), `${glyph} should be allowed`);
  }
});
