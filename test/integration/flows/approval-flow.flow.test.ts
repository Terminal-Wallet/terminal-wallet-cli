import { test } from "node:test";
import assert from "node:assert/strict";
import { runApprovals } from "../../../src/flows/approval-flow";
import { makeApprovalDeps } from "../../_support";

type Tx = string;

const items = [
  { symbol: "A", populatedTransaction: "txA" },
  { symbol: "B", populatedTransaction: "txB" },
];

test("no approvals needed → ok with nothing sent", async () => {
  const { deps, calls } = makeApprovalDeps<Tx>({ getNeeded: async () => [] });
  const r = await runApprovals(deps);
  assert.deepEqual(r, { ok: true, sent: 0, declined: false });
  assert.deepEqual(calls.sent, []);
});

test("confirming every approval sends them all in order", async () => {
  const { deps, calls } = makeApprovalDeps<Tx>({ getNeeded: async () => items });
  const r = await runApprovals(deps);
  assert.deepEqual(r, { ok: true, sent: 2, declined: false });
  assert.deepEqual(calls.sent, ["txA", "txB"]);
  // the prompt surfaces the prepared symbol + cost for each
  assert.equal(calls.confirmed.length, 2);
  assert.match(calls.confirmed[0], /Approve A \(cost 0\.01\)/);
});

test("declining the first approval stops the flow with ok:false and sends nothing", async () => {
  const { deps, calls } = makeApprovalDeps<Tx>({
    getNeeded: async () => items,
    confirm: async () => false,
  });
  const r = await runApprovals(deps);
  assert.deepEqual(r, { ok: false, sent: 0, declined: true });
  assert.deepEqual(calls.sent, [], "nothing sent after a decline");
});

test("declining midway stops after the already-sent approvals", async () => {
  let asked = 0;
  const { deps, calls } = makeApprovalDeps<Tx>({
    getNeeded: async () => items,
    confirm: async () => {
      asked += 1;
      return asked === 1; // approve the first, decline the second
    },
  });
  const r = await runApprovals(deps);
  assert.deepEqual(r, { ok: false, sent: 1, declined: true });
  assert.deepEqual(calls.sent, ["txA"], "only the approved one was sent");
});
