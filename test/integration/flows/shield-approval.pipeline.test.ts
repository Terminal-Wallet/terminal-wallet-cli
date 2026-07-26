import { test } from "node:test";
import assert from "node:assert/strict";
import { runApprovals } from "../../../src/flows/approval-flow";
import { runTransaction } from "../../../src/flows/run";
import { ShieldSpec } from "../../../src/flows/spec";
import {
  collectEvents,
  makeApprovalDeps,
  makeRunDeps,
  shieldSpec,
} from "../../_support";


// A shield is a public (no-proof) tx gated behind ERC20 approvals: approvals must
// all confirm before the shield tx runs.
const runShield = (onSend: () => void) =>
  runTransaction(
    shieldSpec(),
    makeRunDeps<ShieldSpec>({
      prove: undefined,
      estimateGas: async () => ({ fee: 1 }),
      send: async () => {
        onSend();
        return { hash: "0xshield", url: "https://scan/0xshield" };
      },
    }),
    collectEvents().emit,
  );

test("approvals confirmed → shield tx runs (estimate→send, no prove)", async () => {
  const { deps, calls } = makeApprovalDeps();
  const approval = await runApprovals(deps);
  assert.equal(approval.ok, true);
  assert.equal(calls.sent.length, 1, "the needed approval was sent");

  let shieldRan = false;
  const out = await runShield(() => {
    shieldRan = true;
  });
  assert.equal(out.ok, true);
  assert.equal(shieldRan, true);
});

test("a declined approval halts the flow before the shield tx runs", async () => {
  const { deps } = makeApprovalDeps({ confirm: async () => false });
  const approval = await runApprovals(deps);
  assert.equal(approval.ok, false);
  assert.equal(approval.declined, true);

  let shieldRan = false;
  if (approval.ok) {
    await runShield(() => {
      shieldRan = true;
    });
  }
  assert.equal(shieldRan, false, "shield must not run when an approval is declined");
});
