/**
 * Every core event needs a producer AND a consumer.
 *
 * The reconciliation against the reference branch found three events —
 * scan:progress, scan:complete, balances:refreshed — that were declared,
 * folded by the adapter and acted on by the deck, but emitted by nobody. The
 * sync bars never moved and balances never re-read when a scan landed. Nothing
 * failed to compile and no test broke, because a union member that is never
 * constructed is perfectly valid TypeScript.
 *
 * So this asserts the wiring itself, by reading the source. Crude, and it
 * catches exactly the class of defect that a type checker cannot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Resolved from the repo root rather than import.meta — the test tsconfig
// targets CommonJS, where import.meta is unavailable.
const SRC = resolve(process.cwd(), "src");
const EVENTS = join(SRC, "core/events.ts");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory()
      ? walk(full)
      : full.endsWith(".ts")
        ? [full]
        : [];
  });

const declared = (): string[] => {
  const source = readFileSync(EVENTS, "utf-8");
  return [
    ...new Set(
      [...source.matchAll(/\{ type: "([a-z:]+)"/g)].map((m) => m[1]),
    ),
  ].sort();
};

const sourcesExcept = (...skip: string[]): string[] =>
  walk(SRC).filter((f) => !skip.some((s) => f.endsWith(s)));

const mentions = (files: string[], needle: string): boolean =>
  files.some((f) => readFileSync(f, "utf-8").includes(needle));

test("every declared core event is emitted somewhere", () => {
  const producers = sourcesExcept("core/events.ts");
  const orphans = declared().filter(
    (type) => !mentions(producers, `type: "${type}"`),
  );
  assert.deepEqual(
    orphans,
    [],
    `declared but never emitted — the deck would wait forever: ${orphans.join(", ")}`,
  );
});

test("every declared core event is handled by the adapter", () => {
  // The other direction: an event nobody folds is a producer shouting into a
  // void. The adapter's exhaustiveness guard catches this at compile time, so
  // this is belt-and-braces — but it costs nothing and states the intent.
  const adapter = readFileSync(join(SRC, "tui/adapter.ts"), "utf-8");
  const unhandled = declared().filter(
    (type) => !adapter.includes(`case "${type}"`),
  );
  assert.deepEqual(unhandled, [], `no fold case: ${unhandled.join(", ")}`);
});

test("both merkletrees have a scan callback registered", () => {
  // The reference branch registers one per tree. Registering only the UTXO one
  // leaves the TXID tree unobserved: its progress bar never moves, and "fully
  // synced" is decided from a tree nothing is watching.
  const init = readFileSync(join(SRC, "railgun/wallet/wallet-init.ts"), "utf-8");
  assert.match(init, /setOnUTXOMerkletreeScanCallback\(/);
  assert.match(init, /setOnTXIDMerkletreeScanCallback\(/);
});
