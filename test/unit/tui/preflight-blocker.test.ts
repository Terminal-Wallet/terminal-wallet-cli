/**
 * Debt the collateral does not cover is an overspend.
 *
 * The generic gates only compare token balances, and borrowing against a
 * position spends nothing you hold — so a build that leaves the position past
 * the ceiling passes completeness, passes overspend, and reaches a review that
 * says nothing is wrong. It is the same mistake as sending more than you have
 * and is refused in the same place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { preflight } from "../../../src/tui/screens/tx-builder-core";
import { TokenOverspend } from "../../../src/flows/balance";

const token = {
  symbol: "wstETH",
  name: "wstETH",
  tokenAddress: "0x7f39",
  decimals: 18,
  amount: 10n ** 18n,
};

const base = {
  fields: ["position" as const],
  state: { gas: undefined, position: {} as never },
  overspend: [] as TokenOverspend[],
};

test("a flow's own refusal blocks the send", () => {
  const gate = preflight({
    ...base,
    blocker: "The collateral does not cover this much debt.",
  });
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? gate.message : "", /does not cover/);
});

test("no blocker leaves an otherwise valid build sendable", () => {
  assert.equal(preflight(base).ok, true);
});

test("the blocker is refused before a token overspend", () => {
  // Both are true when borrowing AND paying too much collateral. The debt
  // ceiling is the more specific complaint and the one that explains the
  // other, so a generic "reduce the amount" would send the user to the wrong
  // slider.
  const overspend: TokenOverspend[] = [
    { token, overBy: 5n, feeShare: 0n, causedByFee: false } as TokenOverspend,
  ];
  const gate = preflight({
    ...base,
    overspend,
    blocker: "The collateral does not cover this much debt.",
  });
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? gate.message : "", /does not cover/);
  assert.ok(
    !/reduce the amount/.test(gate.ok === false ? gate.message : ""),
    "the generic overspend wording won the more specific one",
  );
});

test("an incomplete build is still reported as incomplete first", () => {
  // Otherwise a card opens shouting about a ceiling before anything has been
  // chosen, and the first thing the user sees is an error they cannot act on.
  const gate = preflight({
    fields: ["position", "amount"],
    state: { gas: undefined },
    overspend: [],
    blocker: "The collateral does not cover this much debt.",
  });
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? gate.message : "", /Incomplete/);
});
