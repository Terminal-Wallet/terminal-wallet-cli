/**
 * Two sliders, four recipes, and the pairs that are not recipes at all.
 *
 * The cookbook's four adjust actions do not span every combination of deltas.
 * The screen has to refuse the gaps BY NAME rather than round them to the
 * nearest shipped action — silently doing something other than what the
 * sliders showed is the worst outcome available on a screen that moves
 * collateral.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planFxManage, fxManageVerb } from "../../../src/railgun/transaction/fx/manage";

const plan = (collateralDelta: bigint, debtDelta: bigint) =>
  planFxManage({ collateralDelta, debtDelta });

test("collateral in, no debt change, is a top-up", () => {
  const p = plan(10n, 0n);
  assert.deepEqual(p, { ok: true, action: "topup", collateralDelta: 10n, debtDelta: 0n });
  assert.equal(fxManageVerb(p), "Add collateral");
});

test("debt up, no collateral, is borrowing more", () => {
  const p = plan(0n, 500n);
  assert.deepEqual(p, { ok: true, action: "borrow-more", collateralDelta: 0n, debtDelta: 500n });
  assert.equal(fxManageVerb(p), "Borrow");
});

test("both up is the combined recipe", () => {
  const p = plan(10n, 500n);
  assert.deepEqual(p, {
    ok: true,
    action: "topup-and-borrow",
    collateralDelta: 10n,
    debtDelta: 500n,
  });
  assert.equal(fxManageVerb(p), "Add & borrow");
});

test("debt down is a repay, and the amount is handed over positive", () => {
  // The cookbook step takes an amount, not a signed delta — the sign lives in
  // the action. Passing -500 through would repay a negative amount or revert.
  const p = plan(0n, -500n);
  assert.deepEqual(p, { ok: true, action: "repay", collateralDelta: 0n, debtDelta: 500n });
  assert.equal(fxManageVerb(p), "Repay");
});

test("adding collateral while repaying is refused, not rounded", () => {
  // Neither shipped recipe does both. Picking whichever half is larger would
  // move collateral the user did not agree to move.
  const p = plan(10n, -500n);
  assert.equal(p.ok, false);
  assert.match(p.ok === false ? p.reason : "", /two transactions/);
});

test("withdrawing collateral is refused and says where to do it", () => {
  const p = plan(-10n, 0n);
  assert.equal(p.ok, false);
  assert.match(p.ok === false ? p.reason : "", /close the position/);
});

test("no change at all is not a transaction", () => {
  const p = plan(0n, 0n);
  assert.equal(p.ok, false);
  assert.match(p.ok === false ? p.reason : "", /nothing to change/);
});

test("every accepted plan names one of the four shipped actions", () => {
  // The guard against a fifth action being invented by a later edit: the
  // cookbook has exactly these, and a plan naming anything else would build a
  // recipe that does not exist.
  const shipped = new Set(["topup", "topup-and-borrow", "borrow-more", "repay"]);
  for (const [c, d] of [
    [10n, 0n],
    [0n, 500n],
    [10n, 500n],
    [0n, -500n],
  ] as [bigint, bigint][]) {
    const p = plan(c, d);
    assert.equal(p.ok, true);
    assert.ok(p.ok && shipped.has(p.action), `unshipped action for (${c}, ${d})`);
  }
});

test("an accepted plan never carries a negative amount", () => {
  for (const [c, d] of [
    [10n, 0n],
    [0n, 500n],
    [10n, 500n],
    [0n, -500n],
  ] as [bigint, bigint][]) {
    const p = plan(c, d);
    assert.ok(p.ok);
    if (!p.ok) continue;
    assert.ok(p.collateralDelta >= 0n, "negative collateral reached a recipe");
    assert.ok(p.debtDelta >= 0n, "negative debt reached a recipe");
  }
});
