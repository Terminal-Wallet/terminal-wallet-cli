/**
 * The send gate.
 *
 * This is the last pure decision before a transaction is reviewed and
 * broadcast, so it is asserted directly rather than through a mounted builder.
 * Two properties matter: nothing incomplete or unaffordable gets through, and
 * the order is stable — a build that is both incomplete and overspending should
 * be told to finish itself first, because the overspend figure is meaningless
 * until it is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import { preflight, BuilderState } from "../../../src/tui/screens/tx-builder-core";
import { flowCaps, LegsState } from "../../../src/flows/caps";
import { TokenOverspend } from "../../../src/flows/balance";
import { RailgunDisplayBalance } from "../../../src/models/balance-models";

const token = (symbol: string, held: string): RailgunDisplayBalance =>
  ({
    symbol,
    tokenAddress: `0x${symbol.toLowerCase()}`,
    decimals: 18,
    amount: parseUnits(held, 18),
  }) as RailgunDisplayBalance;

const WETH = token("WETH", "10");

const complete: BuilderState = {
  gas: undefined,
  token: WETH,
  amount: "1",
  address: "0x1111111111111111111111111111111111111111",
};

const FIELDS = ["token", "amount", "address"] as const;

const overspendOf = (by: string): TokenOverspend[] => [
  { token: WETH, overBy: parseUnits(by, 18) } as TokenOverspend,
];

test("a complete, affordable build passes", () => {
  assert.deepEqual(
    preflight({ fields: [...FIELDS], state: complete, overspend: [] }),
    { ok: true },
  );
});

test("a missing field blocks and names itself", () => {
  const result = preflight({
    fields: [...FIELDS],
    state: { ...complete, address: undefined },
    overspend: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "fields");
  assert.match(result.ok === false ? result.message : "", /recipient/);
});

test("an amount of zero is missing, not present", () => {
  // "0" is a filled-in field and an unsendable transaction. The distinction is
  // the whole reason validate() checks the value rather than the presence.
  const result = preflight({
    fields: [...FIELDS],
    state: { ...complete, amount: "0" },
    overspend: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "fields");
});

test("an overspend blocks a build that is otherwise complete", () => {
  const result = preflight({
    fields: [...FIELDS],
    state: complete,
    overspend: overspendOf("0.25"),
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "overspend");
  assert.match(result.ok === false ? result.message : "", /Overspends WETH by 0\.25/);
});

test("incompleteness is reported before overspend", () => {
  // Both are wrong. Reporting the overspend first would quote a shortfall
  // computed from a build the user has not finished describing.
  const result = preflight({
    fields: [...FIELDS],
    state: { ...complete, address: undefined },
    overspend: overspendOf("0.25"),
  });
  assert.equal(result.ok === false && result.reason, "fields");
});

test("unfinished legs are reported before the fields they would fill", () => {
  const legs: LegsState = { legs: [{ id: "leg-0", token: WETH }], seq: 1 };
  const result = preflight({
    fields: [...FIELDS],
    state: { gas: undefined, legs },
    legs,
    caps: flowCaps("send-private-balances"),
    overspend: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "legs");
});

test("legs are only checked when the flow has them", () => {
  // A single-token flow passes no legs; the gate must not invent an empty
  // LegsState and fail every non-multi-leg send.
  assert.deepEqual(
    preflight({ fields: [...FIELDS], state: complete, overspend: [] }),
    { ok: true },
  );
});

// --- optional fields ---------------------------------------------------------

/**
 * The send gate deliberately re-decides rather than trusting the summary's
 * verdict — which is right, and means it has to be told the same things the
 * summary was. It was not: the f(x) close marks its buy token optional, the
 * form reported "ready", and Build & Send then refused it as incomplete.
 */
test("an optional field does not block the send", () => {
  const result = preflight({
    fields: [...FIELDS, "buyToken"],
    optionalFields: ["buyToken"],
    state: complete,
    overspend: [],
  });
  assert.deepEqual(result, { ok: true });
});

test("CONTROL: without the optional list the same build is refused", () => {
  // The bug, shown rather than described. Omitting the list is what the send
  // path did while the summary passed it.
  const result = preflight({
    fields: [...FIELDS, "buyToken"],
    state: complete,
    overspend: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /buy token/);
});

test("optional does not excuse a field that is genuinely required", () => {
  // Marking one row optional must not soften the others.
  const result = preflight({
    fields: [...FIELDS, "buyToken"],
    optionalFields: ["buyToken"],
    state: { ...complete, amount: undefined },
    overspend: [],
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /amount/);
});

test("naming a field optional that is not in the form changes nothing", () => {
  const result = preflight({
    fields: [...FIELDS],
    optionalFields: ["memo", "buyToken"],
    state: complete,
    overspend: [],
  });
  assert.deepEqual(result, { ok: true });
});
