/**
 * Emoji on borders, and the width patch that makes them safe.
 *
 * blessed measures text with a hardcoded range check written before the emoji
 * blocks existed. Every emoji comes back as one cell while the terminal draws
 * two, so blessed places the border a column early, the glyph's second half
 * lands on it, and the frame breaks. That is the wonky card row and the
 * password prompt bleeding past its own edge.
 *
 * The fix is `installEmojiWidth`, which widens the one function both the
 * measurement path (`strWidth`) and the renderer's two skip-a-cell branches go
 * through. These assert the two things that have to stay true for it to hold:
 * the patch is installed before any screen exists, and every glyph the chrome
 * actually uses is one the patch recognises. An emoji outside its table would
 * still measure 1 and still break the frame — silently, since it renders fine
 * in blessed's own buffer.
 *
 * What cannot be asserted here: whether a real terminal draws these at two
 * cells. `screen.screenshot()` returns blessed's internal grid, which is
 * self-consistent either way. That part is verified by looking at it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  isWideEmoji,
  emoji,
  installEmojiWidth,
} from "../../../src/tui/widgets/unicode-width";
import unicode from "blessed/lib/unicode";

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

/** `label:` / `title:` values — quoted or templated. Templates matter: the
 *  chrome uses them to interpolate `emoji()`, and a quote-only pattern would
 *  match nothing and pass for the wrong reason. */
const CHROME = /\b(?:label|title):\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

const chromeLiterals = (): { file: string; text: string }[] =>
  walk(SRC).flatMap((file) =>
    [...readFileSync(file, "utf-8").matchAll(CHROME)].map(([, , text]) => ({
      file: relative(process.cwd(), file),
      text,
    })),
  );

/**
 * Single-cell marks the layout is built from. They share a block with the
 * emoji, so they are named rather than range-excluded.
 */
const SAFE_SINGLE_CELL = new Set(
  [..."·—…▲▼✕▸→─│┌┐└┘├┤┬┴┼░▒▓■□●○◆◇«»‹›✓✔✗"].map((c) => c.codePointAt(0)!),
);

/** Anything the terminal is liable to draw wide, and so must be in the table. */
const suspicious = (codePoint: number): boolean =>
  !SAFE_SINGLE_CELL.has(codePoint) &&
  (codePoint > 0xffff || (codePoint >= 0x2300 && codePoint <= 0x2bff));

test("the pattern actually finds the chrome (guarding the guard)", () => {
  const found = chromeLiterals();
  assert.ok(found.length > 20, `only matched ${found.length} labels/titles`);
  assert.ok(
    found.some((l) => l.text.includes("wallet")),
    "did not match the card labels, which are template literals",
  );
});

test("every emoji used in border chrome is one the width patch knows", () => {
  const unknown: string[] = [];
  for (const { file, text } of chromeLiterals()) {
    for (const char of text) {
      const point = char.codePointAt(0);
      if (point === undefined || !suspicious(point)) continue;
      if (point === 0xfe0f) continue; // variation selector, width 0
      if (!isWideEmoji(point)) {
        unknown.push(`${file}: ${char} (U+${point.toString(16).toUpperCase()})`);
      }
    }
  }
  assert.deepEqual(
    unknown,
    [],
    `not in the patch's table, so still measured as one cell:\n  ${unknown.join("\n  ")}`,
  );
});

test("the deck installs the patch before it builds a screen", () => {
  // Order matters: blessed caches nothing, but a screen created first would
  // measure its own chrome with the unpatched function.
  const entry = readFileSync(join(SRC, "tui/entry.ts"), "utf-8");
  const install = entry.indexOf("installEmojiWidth()");
  const screen = entry.indexOf("blessed.screen({");
  assert.ok(install > 0, "installEmojiWidth is never called");
  assert.ok(screen > 0);
  assert.ok(install < screen, "the screen is built before the patch is installed");
});

test("the patch makes blessed measure emoji as two cells", () => {
  installEmojiWidth();
  assert.equal(unicode.charWidth("👤"), 2, "astral emoji");
  assert.equal(unicode.charWidth(emoji("⚙")), 2, "ambiguous BMP emoji");
  // The whole label, which is what the border is positioned against.
  assert.equal(unicode.strWidth(` ${emoji("⚙")} utilities `), 14);
});

test("the patch leaves single-cell glyphs alone", () => {
  // Widening these would break the frames it exists to fix — they are the
  // box-drawing and arrows the layout is built from.
  installEmojiWidth();
  for (const glyph of ["·", "—", "…", "▲", "▼", "✕", "▸", "→", "─", "a"]) {
    assert.equal(unicode.charWidth(glyph), 1, `${glyph} should stay one cell`);
  }
});

test("emoji() marks a glyph as emoji-presentation, and is idempotent", () => {
  // Without VS16 an ambiguous codepoint is one cell to some terminals and two
  // to others, and no static answer is right for both.
  const marked = emoji("⚙");
  assert.equal(marked, "⚙️");
  assert.equal(emoji(marked), marked, "double-marking would add a second selector");
});

test("installEmojiWidth is idempotent", () => {
  // It wraps a module-level function; wrapping twice would double-count and
  // report 4 cells for one glyph.
  installEmojiWidth();
  installEmojiWidth();
  assert.equal(unicode.charWidth("👤"), 2);
});
