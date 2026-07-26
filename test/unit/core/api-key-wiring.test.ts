/**
 * The 0x API key reaches the SDK.
 *
 * `updateApiKey()` copies the key from `configDefaults.apiKeys` — which the
 * remote-config fetch fills — into the 0x SDK's `ZeroXConfig.API_KEY`. It is
 * exported and was never called: `main.ts` was rewritten during the
 * restructure and the call went with it. The key was fetched correctly and sat
 * unused, so every swap quote failed with "no API key configured" while the
 * config plainly contained one.
 *
 * The symbol-delta reconciliation could not see this. `updateApiKey` is
 * exported in both trees, so it never appeared as missing — a delta of exported
 * names says nothing about whether anything calls them. Hence a wiring test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

test("the deck hands the key to the SDK during boot", () => {
  const entry = read("tui/entry.ts");
  assert.match(entry, /updateApiKey\(\)/, "the deck never installs the 0x key");
});

test("it happens after the fetch that provides the key", () => {
  // configDefaults.apiKeys is empty until overrideMainConfig resolves, so
  // installing first would copy nothing.
  const entry = read("tui/entry.ts");
  const fetched = entry.indexOf("await overrideMainConfig(");
  const installed = entry.indexOf("updateApiKey()");
  assert.ok(fetched > 0 && installed > 0);
  assert.ok(
    installed > fetched,
    "the key is installed before the remote config that supplies it",
  );
});

test("it happens before anything can quote", () => {
  const entry = read("tui/entry.ts");
  const installed = entry.indexOf("updateApiKey()");
  const wallet = entry.indexOf("await initializeWalletSystems()");
  assert.ok(installed < wallet, "the wallet comes up before the key is installed");
});

test("the selftest reports whether the key resolved", () => {
  // A swap failing for a missing key is much easier to read here than from
  // inside a failed transaction.
  const report = read("diagnostic/report.ts");
  assert.match(report, /updateApiKey\(\)/);
  assert.match(report, /0x key/);
});

test("the selftest reports presence, never the key itself", () => {
  const report = read("diagnostic/report.ts");
  const step = report.slice(
    report.indexOf('await step("remote config"'),
    report.indexOf('await step("railgun engine"'),
  );
  assert.match(step, /present|MISSING/);
  assert.ok(
    !/\$\{\s*zeroX\s*\}|apiKeys\.zeroXApi\s*\}/.test(step),
    "the diagnostic would print the API key",
  );
});
