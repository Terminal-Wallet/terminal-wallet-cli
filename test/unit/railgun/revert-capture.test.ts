/**
 * Recovering the revert reason the SDK throws away.
 *
 * A relay-adapt failure is rewritten as "RelayAdapt multicall failed at index
 * N" before the SDK's sanitizer runs. The sanitizer matches on the message, so
 * the rewritten one matches none of its known contract errors and falls through
 * to a branch that returns a fresh Error with no cause. "Invalid Merkle Root"
 * — which the SDK itself knows to explain — never reaches the user.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  describeRevert,
  takeLastRevert,
} from "../../../src/railgun/network/revert-capture";

const SRC = resolve(process.cwd(), "src");

test("nothing is reported when no revert happened", () => {
  assert.equal(takeLastRevert(), undefined);
});

test("a known revert is described with what to do about it", () => {
  const described = describeRevert("RailgunSmartWallet: Invalid Merkle Root");
  assert.match(described, /Invalid Merkle Root/);
  assert.match(described, /full rescan/i, "says nothing about how to fix it");
});

test("every guidance entry actually fires", () => {
  for (const [reason, expect] of [
    ["execution reverted: RailgunSmartWallet: Note Already Spent", /rescan/i],
    ["RailgunSmartWallet: Invalid Note Value", /not valid/i],
    ["RailgunSmartWallet: Unsupported Token", /cannot interact/i],
    ["RelayAdapt: Not enough gas supplied", /relay-adapt floor/i],
  ] as [string, RegExp][]) {
    assert.match(describeRevert(reason), expect, `no guidance for: ${reason}`);
  }
});

test("an unrecognised revert is passed through unchanged", () => {
  // Better a raw reason than a wrong explanation.
  assert.equal(describeRevert("something new"), "something new");
});

test("the guidance table covers the revert that blocks a spend", () => {
  // Invalid Merkle Root means the local tree disagrees with the chain, and the
  // fix is a rescan — not something the raw message says.
  const source = readFileSync(join(SRC, "railgun/network/revert-capture.ts"), "utf-8");
  assert.match(source, /invalid merkle root/i);
  assert.match(source, /full rescan/i);
  assert.match(source, /note already spent/i);
});

test("the reason is cleared as it is read", () => {
  // A later, unrelated failure must not inherit an old revert.
  assert.equal(takeLastRevert(), undefined);
  assert.equal(takeLastRevert(), undefined);
});

test("the transaction path appends it to the reported error", () => {
  const run = readFileSync(join(SRC, "flows/run.ts"), "utf-8");
  assert.match(run, /takeLastRevert\(\)/);
  assert.match(run, /\$\{errDetail\(e\)\} ← \$\{revert\}/);
});

test("the deck installs the capture once the providers are up", () => {
  const entry = readFileSync(join(SRC, "tui/entry.ts"), "utf-8");
  const installed = entry.indexOf("installRevertCapture(");
  const walletUp = entry.indexOf("await initializeWalletSystems()");
  assert.ok(installed > 0, "never installed");
  assert.ok(installed > walletUp, "installed before the providers exist");
});
