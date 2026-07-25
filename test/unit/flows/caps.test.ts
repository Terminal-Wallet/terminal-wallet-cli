import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import {
  flowCaps,
  initLegs,
  addToken,
  addRecipient,
  removeLeg,
  setLegField,
  setSharedRecipient,
  canAddToken,
  canAddRecipient,
  distinctRecipients,
  groupByToken,
  validateLegs,
  toRecipients,
} from "../../../src/flows/caps";

const TOK = (sym: string, addr: string) => ({
  symbol: sym, name: sym, tokenAddress: addr, decimals: 18, amount: 0n,
});

test("flowCaps encodes the matrix incl. unshield single-recipient + shield 0zk default", () => {
  assert.deepEqual(flowCaps("private-transfer"), { multiToken: true, maxRecipients: Infinity, recipientKind: "0zk" });
  assert.deepEqual(flowCaps("public-transfer"), { multiToken: true, maxRecipients: Infinity, recipientKind: "0x" });
  const shield = flowCaps("shield-public-balances");
  assert.equal(shield.recipientKind, "0zk");
  assert.equal(shield.recipientDefaultOwn, true);
  const unshield = flowCaps("unshield-private-balances");
  assert.equal(unshield.maxRecipients, 1);
  assert.equal(unshield.recipientKind, "0x");
});

test("addToken blocked when the flow is single-token", () => {
  const single = { multiToken: false, maxRecipients: 1, recipientKind: "0x" as const };
  let s = initLegs();
  s = setLegField(s, s.legs[0].id, "token", TOK("USDC", "0xusdc"));
  assert.equal(canAddToken(s, single), false);
  assert.equal(addToken(s, single).legs.length, 1); // no-op
  const multi = flowCaps("public-transfer");
  assert.equal(canAddToken(s, multi), true);
  assert.equal(addToken(s, multi).legs.length, 2);
});

test("unshield blocks a second recipient; sends allow many", () => {
  const unshield = flowCaps("unshield-private-balances");
  let s = initLegs();
  s = setLegField(s, s.legs[0].id, "recipient", "0xONE");
  assert.equal(canAddRecipient(s, unshield), false);
  assert.equal(addRecipient(s, unshield, s.legs[0].id).legs.length, 1); // blocked

  const send = flowCaps("private-transfer");
  let p = initLegs();
  p = setLegField(p, p.legs[0].id, "token", TOK("USDC", "0xusdc"));
  p = setLegField(p, p.legs[0].id, "recipient", "0zkA");
  assert.equal(canAddRecipient(p, send), true);
  p = addRecipient(p, send, p.legs[0].id);
  assert.equal(p.legs.length, 2);
  assert.equal(p.legs[1].token?.tokenAddress, "0xusdc"); // reuses the token
});

test("setSharedRecipient writes one recipient to every leg (unshield)", () => {
  let s = initLegs();
  s = setLegField(s, s.legs[0].id, "token", TOK("USDC", "0xusdc"));
  s = addToken(s, flowCaps("unshield-private-balances"));
  s = setLegField(s, s.legs[1].id, "token", TOK("DAI", "0xdai"));
  s = setSharedRecipient(s, "0xONE");
  assert.deepEqual(distinctRecipients(s), ["0xone"]);
});

test("validateLegs enforces completeness + the recipient cap", () => {
  const unshield = flowCaps("unshield-private-balances");
  let s = initLegs();
  s = setLegField(s, s.legs[0].id, "token", TOK("USDC", "0xusdc"));
  s = setLegField(s, s.legs[0].id, "amount", "10");
  s = setLegField(s, s.legs[0].id, "recipient", "0xONE");
  assert.equal(validateLegs(s, unshield).ok, true);
  // force two distinct recipients → privacy violation
  s = { legs: [...s.legs, { id: "x", token: TOK("DAI", "0xdai"), amount: "5", recipient: "0xTWO" }], seq: s.seq + 1 };
  const v = validateLegs(s, unshield);
  assert.equal(v.ok, false);
  assert.ok(v.violations[0].includes("ONE recipient"));
});

test("groupByToken groups legs sharing a token; toRecipients consolidates dupes", () => {
  let s = initLegs();
  const usdc = TOK("USDC", "0xusdc");
  s = setLegField(s, s.legs[0].id, "token", usdc);
  s = setLegField(s, s.legs[0].id, "amount", "10");
  s = setLegField(s, s.legs[0].id, "recipient", "0xA");
  s = addRecipient(s, flowCaps("public-transfer"), s.legs[0].id);
  s = setLegField(s, s.legs[1].id, "amount", "5");
  s = setLegField(s, s.legs[1].id, "recipient", "0xA"); // same token+recipient → consolidates
  assert.equal(groupByToken(s).length, 1);
  const recips = toRecipients(s);
  assert.equal(recips.length, 1);
  assert.equal(recips[0].amount, parseUnits("15", 18));
});

test("removeLeg never empties the state", () => {
  let s = initLegs();
  s = removeLeg(s, s.legs[0].id);
  assert.equal(s.legs.length, 1);
});

test("an unrecognised flow fails CLOSED, not open", () => {
  // If someone adds a flow and forgets to register it here, the safe failure is
  // the most restrictive cell in the matrix — single token, single recipient.
  // Defaulting to "unbounded" would silently hand a new flow the ability to
  // fan out to multiple public recipients in one transaction.
  const unknown = flowCaps("some-flow-added-later");
  assert.equal(unknown.maxRecipients, 1);
  assert.equal(unknown.multiToken, false);
});

test("the unshield single-recipient rule is a privacy invariant", () => {
  // Unshielding to several distinct public addresses in one transaction funds
  // them all from one shielded note set, which links them on-chain. This must
  // hold regardless of what is drawing the screen — that is why it lives in
  // flows/ and not in the renderer.
  assert.equal(flowCaps("unshield-private-balances").maxRecipients, 1);
});
