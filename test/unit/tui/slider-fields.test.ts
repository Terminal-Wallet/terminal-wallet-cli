/**
 * The slider rows, as the builder sees them.
 *
 * A slider is an INPUT METHOD, not a second source of truth: it writes through
 * to `amount` and `debt`, and the overspend gate, the fee reservation and
 * submit keep reading only those. So validation asks for the resolved amount,
 * never the slider position — a slider sitting at 40% with nothing resolved
 * behind it is an incomplete build, not a valid one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BuilderState,
  fieldDisplay,
  validate,
} from "../../../src/tui/screens/tx-builder-core";

const base: BuilderState = { gas: undefined };
const plain = (s: string) => s.replace(/\{[^}]*\}/g, "");

test("an untouched slider says how to move it", () => {
  assert.match(fieldDisplay("collateralPct", base), /←/);
  assert.match(fieldDisplay("debtRatio", base), /←/);
});

test("a slider shows its bar, its percent, and what it resolved to", () => {
  const shown = plain(
    fieldDisplay("collateralPct", { ...base, collateralPct: 0.64, amount: "0.005404" }),
  );
  assert.match(shown, /64%/);
  assert.match(shown, /0\.005404/);
  assert.match(shown, /[█░]{14}/, "a 14-cell bar");
});

test("the loan slider is shown to a tenth, like the design reference", () => {
  const shown = plain(fieldDisplay("debtRatio", { ...base, debtRatio: 0.4, debt: "4.09" }));
  assert.match(shown, /40\.0%/);
  assert.match(shown, /4\.09 fxUSD/);
});

test("a slider with nothing resolved behind it is incomplete", () => {
  // The position could not be built from a percentage alone, and letting it
  // through would reach submit with no amount.
  const v = validate(["collateralPct", "debtRatio"], { ...base, collateralPct: 0.5, debtRatio: 0.4 });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["collateral", "an amount to mint"]);
});

test("once resolved, the sliders satisfy the same gate a typed amount would", () => {
  const v = validate(["collateralPct", "debtRatio"], {
    ...base,
    collateralPct: 0.5,
    amount: "1.0",
    debtRatio: 0.4,
    debt: "1000",
  });
  assert.equal(v.ok, true);
});

test("a zero slider is not a build", () => {
  const v = validate(["collateralPct"], { ...base, collateralPct: 0, amount: undefined });
  assert.equal(v.ok, false);
});
