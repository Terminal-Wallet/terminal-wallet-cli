/**
 * Nothing the renderer draws may have a width the terminal decides.
 *
 * blessed lays a frame out by measuring text with its own width table, and the
 * terminal then draws it. When the two disagree by a cell the frame breaks:
 * either a glyph's second half lands on the border, or blessed reserves a
 * column the terminal never fills and the text after it is eaten.
 *
 * Both directions have been seen here. Emoji measured as one cell and drawn as
 * two broke the card row and let the password prompt bleed past its edge. The
 * fix widened blessed's table and forced emoji presentation with VARIATION
 * SELECTOR-16 — which on a terminal that draws those glyphs narrow inverted the
 * error, rendering "TWALLET" as "WALLET" and eating every label's spaces.
 *
 * No static width is right on every terminal, so the rule is not "measure
 * emoji correctly" but "do not use a glyph of arguable width". What remains is
 * an allowlist of marks with no emoji presentation.
 *
 * This checks EVERY string in the renderer, not just `label:`/`title:`/
 * `content:` properties. The property-matching version missed
 * `select("🛡 POI Tools", …)` — a positional argument that becomes a modal
 * title — and the warning marks inside builder lines, which overflow a frame
 * exactly as a label does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import unicode from "blessed/lib/unicode";

const SRC = resolve(process.cwd(), "src");
const TUI = join(SRC, "tui");

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
 * Marks with no emoji presentation, so no terminal has cause to widen them:
 * box drawing, block elements (the sparkline), arrows and geometric shapes.
 *
 * Anything added here should be checked against the emoji data first. U+25AA ▪
 * and U+25B6 ▶ look like peers of these and are not, because ▪️ and ▶️ exist.
 */
const NARROW_MARKS =
  "·—…▲▼▸◂✕✗✓✔→↻─│┌┐└┘├┤┬┴┼░▒▓█▁▂▃▄▅▆▇▀■□●○◆◇«»‹›⧉";
const ALLOWED = new Set([...NARROW_MARKS].map((c) => c.codePointAt(0) as number));

/** Codepoints a terminal may legitimately draw at two cells. */
const arguableWidth = (codePoint: number): boolean =>
  !ALLOWED.has(codePoint) &&
  (codePoint > 0xffff || // every emoji block
    codePoint === 0xfe0f || // VS16 — forces emoji (wide) presentation
    (codePoint >= 0x2300 && codePoint <= 0x2bff)); // symbols, mixed narrow/emoji

test("the renderer uses no glyph of arguable width", () => {
  const offenders: string[] = [];
  for (const file of walk(TUI)) {
    readFileSync(file, "utf-8")
      .split("\n")
      .forEach((line, index) => {
        for (const char of new Set(line)) {
          const point = char.codePointAt(0);
          if (point === undefined || !arguableWidth(point)) continue;
          offenders.push(
            `${relative(process.cwd(), file)}:${index + 1}  ${char} ` +
              `(U+${point.toString(16).toUpperCase()})`,
          );
        }
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `the terminal decides how wide these are, so no frame containing them is safe:\n  ${offenders.join("\n  ")}`,
  );
});

test("the scan covers the renderer (guarding the guard)", () => {
  // A walk that found nothing would pass the check above for the wrong reason.
  const files = walk(TUI);
  assert.ok(files.length > 20, `only walked ${files.length} renderer files`);
  const marksInUse = new Set<string>();
  for (const file of files) {
    for (const char of readFileSync(file, "utf-8")) {
      if (ALLOWED.has(char.codePointAt(0) as number)) marksInUse.add(char);
    }
  }
  assert.ok(
    marksInUse.size >= 8,
    `the renderer uses only ${marksInUse.size} of the allowed marks, which suggests the scan is not reading what it thinks`,
  );
});

test("blessed's width table is left alone", () => {
  // The patch that used to live here wrapped unicode.charWidth. Any future
  // version of that idea is a compensation for a glyph that should not be
  // there in the first place.
  const offenders = walk(SRC)
    .filter((file) => {
      const source = readFileSync(file, "utf-8");
      return source.includes("blessed/lib/unicode") || source.includes("charWidth");
    })
    .map((file) => relative(process.cwd(), file));
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
