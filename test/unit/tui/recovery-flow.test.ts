/**
 * Recovery goes through the builder, not its own modals.
 *
 * It used to drive its own sequence over the ephemeral console's list: an
 * informational summary that could only be dismissed, then a SEPARATE yes/no
 * that opened behind it — while the console still held the escape key and tore
 * the whole stack down when it was pressed. So the review told you nothing and
 * could not be acted on, and the thing that actually authorised the send was
 * hidden behind the list.
 *
 * The builder already owns that job: completeness, overspend, one review that
 * IS the confirmation, a fresh password, then send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { NetworkName } from "@railgun-community/shared-models";
import { txBuilderConfigs } from "../../../src/tui/screens/tx-builder-configs";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");
const console_ = read("tui/screens/ephemeral-console.ts");

test("recovery is a builder flow", () => {
  const cfg = txBuilderConfigs["ephemeral-recovery"](NetworkName.Ethereum);
  assert.equal(cfg.verb, "Recover");
  assert.ok(cfg.fields.includes("account"), "it picks an account, not a token");
  assert.ok(cfg.loadAccounts, "it must list the stranded accounts");
  assert.equal(cfg.relayAdapt, true, "a recovery is a relay-adapt batch");
});

test("it contributes its own breakdown, having no token or amount", () => {
  // Without this the review panel would be blank — a recovery moves whatever
  // the failed batch left, so there is nothing for the standard amount lines
  // to describe.
  const cfg = txBuilderConfigs["ephemeral-recovery"](NetworkName.Ethereum);
  assert.ok(cfg.previewLines, "recovery would be reviewed against an empty panel");
});

test("the hand-rolled modal sequence is gone, not merely bypassed", () => {
  assert.ok(
    !existsSync(join(SRC, "tui/screens/ephemeral-recover.ts")),
    "two recovery paths is worse than the broken one",
  );
  assert.ok(!/runRecovery/.test(console_), "the console still references the old flow");
});

test("the console closes itself before handing over", () => {
  // The bug was driving modals over a list that still owned the escape key.
  const at = console_.indexOf("const recover =");
  assert.ok(at > 0, "no recover handler");
  const body = console_.slice(at, at + 400);
  assert.match(body, /done\(\)/, "the console must close first");
  assert.match(body, /ctx\.openFlow\("ephemeral-recovery"\)/);
  assert.ok(
    body.indexOf("done()") < body.indexOf("openFlow"),
    "closing must happen before the handover, or both own the pane",
  );
});
