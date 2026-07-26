/**
 * Border chrome must not contain a glyph whose width the terminal decides.
 *
 * blessed lays a frame out by measuring its label with its own width table, and
 * the terminal then draws it. When the two disagree by a cell the frame breaks:
 * either the glyph's second half lands on the border, or blessed reserves a
 * column the terminal never fills and the text after it is eaten.
 *
 * Both directions have now been seen in this app. Emoji were once measured as
 * one cell and drawn as two, which broke the card row and let the password
 * prompt bleed past its own edge. The fix widened blessed's table and marked
 * each glyph with VARIATION SELECTOR-16 to force emoji presentation — and on a
 * terminal that draws those same glyphs narrow, that inverted the error: the
 * title bar rendered "TWALLET" as "WALLET" and every label lost its spaces.
 *
 * There is no static width that is right on every terminal, so the rule is not
 * "measure emoji correctly" but "do not put a glyph of arguable width on a
 * border". What remains is an allowlist of marks with no emoji presentation,
 * which every terminal draws in one cell. That is checkable here, unlike the
 * question of what any particular terminal does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
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

/**
 * `label:` / `title:` / `content:` values — quoted or templated.
 *
 * Content matters as much as label: a wide glyph in a modal body overflows the
 * frame the same way a label does.
 */
const CHROME = /\b(?:label|title|content):\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

const chromeLiterals = (): { file: string; text: string }[] =>
  walk(SRC).flatMap((file) =>
    [...readFileSync(file, "utf-8").matchAll(CHROME)].map(([, , text]) => ({
      file: relative(process.cwd(), file),
      text,
    })),
  );

/**
 * Marks with no emoji presentation, so no terminal has cause to widen them.
 * Anything added here should be checked against the emoji data first — U+25AA
 * looks like a peer of these and is not one, because ▪️ exists.
 */
const NARROW_MARKS = "·—…▲▼▸◂✕→↻─│┌┐└┘├┤┬┴┼░▒▓■□●○◆◇«»‹›✓✔✗";
const ALLOWED = new Set([...NARROW_MARKS].map((c) => c.codePointAt(0) as number));

/** Codepoints a terminal may legitimately draw at two cells. */
const argubleWidth = (codePoint: number): boolean =>
  !ALLOWED.has(codePoint) &&
  (codePoint > 0xffff || // every emoji block
    codePoint === 0xfe0f || // VS16 — forces emoji (wide) presentation
    (codePoint >= 0x2300 && codePoint <= 0x2bff)); // symbols, mixed narrow/emoji

test("the pattern actually finds the chrome (guarding the guard)", () => {
  const found = chromeLiterals();
  assert.ok(found.length > 20, `only matched ${found.length} labels/titles`);
  assert.ok(
    found.some((l) => l.text.includes("wallet")),
    "did not match the card labels",
  );
});

test("no border chrome carries a glyph of arguable width", () => {
  const offenders: string[] = [];
  for (const { file, text } of chromeLiterals()) {
    for (const char of text) {
      const point = char.codePointAt(0);
      if (point === undefined || !argubleWidth(point)) continue;
      offenders.push(`${file}: ${char} (U+${point.toString(16).toUpperCase()})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the terminal decides how wide these are, so the frame is not safe:\n  ${offenders.join("\n  ")}`,
  );
});

test("nothing blessed draws forces emoji presentation", () => {
  // VARIATION SELECTOR-16 is how a narrow glyph becomes a wide one. It is the
  // mechanism behind the second failure, not merely a symptom of it.
  //
  // Scoped to the renderer: the OS window title (platform/console.ts) is drawn
  // by the terminal emulator in its own title bar, not laid out by blessed, so
  // a wide glyph there cannot land on a frame.
  const offenders = walk(join(SRC, "tui"))
    .filter((f) => readFileSync(f, "utf-8").includes("️"))
    .map((f) => relative(process.cwd(), f));
  assert.deepEqual(offenders, [], "U+FE0F present");
});

test("blessed's width table is left alone", () => {
  // The patch that used to live here wrapped unicode.charWidth. Any future
  // version of that idea is a compensation for a glyph that should not be on a
  // border in the first place.
  const offenders = walk(SRC)
    .filter((f) => {
      const src = readFileSync(f, "utf-8");
      return src.includes("blessed/lib/unicode") || src.includes("charWidth");
    })
    .map((f) => relative(process.cwd(), f));
  assert.deepEqual(offenders, [], "blessed's unicode tables are being patched");
});

test("every allowed mark measures one cell", () => {
  // blessed agreeing is necessary but not sufficient — it was already the
  // agreeing party when the terminal drew two cells. This catches an addition
  // that even blessed considers wide.
  for (const glyph of NARROW_MARKS) {
    assert.equal(unicode.charWidth(glyph), 1, `${glyph} is not one cell to blessed`);
  }
});

test("the marks the chrome actually uses are all allowed", () => {
  // Guards the guard the other way: a rule that permits everything would pass
  // the offender check while permitting nothing useful.
  const used = new Set<string>();
  for (const { text } of chromeLiterals()) {
    for (const char of text) {
      if (ALLOWED.has(char.codePointAt(0) as number)) used.add(char);
    }
  }
  assert.ok(used.size >= 5, `chrome uses only ${used.size} of the allowed marks`);
});
