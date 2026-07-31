/**
 * Nothing on the deck path writes to the terminal directly.
 *
 * The deck draws the whole screen. A console.log lands on top of it, blessed
 * never learns its output was overwritten, and the log pane stays empty — the
 * message goes to the one place it cannot be read. The logger's sink exists so
 * every line reaches the pane instead; a direct write bypasses it.
 *
 * Exempt: the diagnostic, which runs without a screen and IS console output;
 * platform/console.ts, which owns raw terminal control; and the clipboard's
 * OSC52, which is a control sequence rather than output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";

const SRC = resolve(process.cwd(), "src");

const EXEMPT = [
  "diagnostic/",          // no screen; console IS the output
  "platform/console.ts",  // owns raw terminal control
  "platform/logger.ts",   // the sink of last resort
  "platform/output.ts",   // the one writer a screenless face may use
  "tui/widgets/clipboard.ts", // OSC52 is a control sequence
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });

/** Strip comments so prose mentioning "console" is not a finding. */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const offenders = (pattern: RegExp): string[] =>
  walk(SRC)
    .filter((f) => !EXEMPT.some((e) => f.includes(e)))
    .flatMap((f) => {
      const lines = code(readFileSync(f, "utf-8")).split("\n");
      return lines
        .map((l, i) => (pattern.test(l) ? `${relative(process.cwd(), f)}:${i + 1}` : ""))
        .filter(Boolean);
    });

test("no console.* outside the diagnostic", () => {
  const found = offenders(/\bconsole\.(log|error|warn|info|debug|trace)\s*\(/);
  assert.deepEqual(
    found,
    [],
    `these paint over the deck instead of reaching the log pane:\n  ${found.join("\n  ")}`,
  );
});

test("no direct process.stdout/stderr writes", () => {
  const found = offenders(/process\.(stdout|stderr)\.write\s*\(/);
  assert.deepEqual(found, [], `raw stream writes:\n  ${found.join("\n  ")}`);
});

test("the exemption list does not grow silently", () => {
  // Each entry is a deliberate decision with a reason written next to it. A
  // sixth appearing without one is how the guard stops guarding: the whole
  // value here is that adding a write somewhere new is inconvenient enough to
  // require saying why.
  assert.equal(EXEMPT.length, 5, "an exemption was added or removed");
  assert.ok(
    EXEMPT.includes("platform/output.ts"),
    "the screenless writer must stay the only new one",
  );
});

test("the scan actually reaches the whole tree", () => {
  // The previous sweep piped through `head` and reported ten matches from one
  // exempt directory, so 28 real ones went unseen. Assert the walk is wide.
  const files = walk(SRC);
  assert.ok(files.length > 90, `only walked ${files.length} files`);
  assert.ok(files.some((f) => f.includes("railgun/transaction")));
  assert.ok(files.some((f) => f.includes("tui/screens")));
});
