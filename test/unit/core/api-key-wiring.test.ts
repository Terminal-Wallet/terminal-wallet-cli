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

/**
 * The version floor.
 *
 * `versionCheck` is the operator's kill switch: a build below
 * `remoteConfig.minVersionNumber` is not allowed to run. It was dead for the
 * same reason the API key was — main.ts was rewritten without it — so a build
 * marked unusable would have started anyway.
 */

test("the deck enforces the version floor at boot", () => {
  const entry = read("tui/entry.ts");
  assert.match(entry, /versionCheck\(version\)/);
  assert.match(entry, /process\.exit\(69\)/, "the floor is checked but not enforced");
});

test("it tears the screen down before reporting and exiting", () => {
  // Otherwise the reason goes into a log pane that is about to stop existing
  // and the app simply vanishes.
  const entry = read("tui/entry.ts");
  const block = entry.slice(entry.indexOf("const verdict = versionCheck("));
  const guard = block.slice(0, block.indexOf("process.exit(69)"));
  assert.match(guard, /releaseDeckLogSink\(\)/, "log sink still holds the output");
  assert.match(guard, /screen\.destroy\(\)/, "blessed still owns the terminal");
});

test("versionCheck returns a verdict rather than exiting itself", async () => {
  // A config module that calls process.exit cannot be tested and gives the
  // renderer no chance to clean up.
  const source = read("config/config-overrides.ts");
  const fn = source.slice(source.indexOf("export const versionCheck"));
  assert.ok(
    !/process\.exit/.test(fn.slice(0, fn.indexOf("\n};"))),
    "versionCheck exits the process directly",
  );
});

/**
 * The user's own RPC overrides.
 *
 * `applyProviderOverrides` reads provider URLs from app config into
 * configDefaults. It was collected and never called, so a configured endpoint
 * was silently ignored and the only way to avoid a bad public RPC was editing
 * the baked-in defaults by hand.
 */

test("provider overrides are applied during config boot", () => {
  const overrides = read("config/config-overrides.ts");
  assert.match(overrides, /applyProviderOverrides\(\)/);
});

test("an explicit provider list wins over the remote config", () => {
  // The remote config assigns networkConfig.providers wholesale. Applying the
  // user's overrides before that would discard them, leaving no way to drop a
  // dead endpoint short of editing the baked-in defaults.
  const overrides = read("config/config-overrides.ts");
  const remoteAssign = overrides.lastIndexOf("networkConfig.providers = _providers");
  const applied = overrides.lastIndexOf("applyProviderOverrides()");
  assert.ok(remoteAssign > 0 && applied > 0);
  assert.ok(applied > remoteAssign, "the remote config overwrites the user's providers");
});
