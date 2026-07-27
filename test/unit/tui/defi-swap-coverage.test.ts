/**
 * Which flows can take a token that is not the one the protocol wants.
 *
 * Every DeFi action has a token it deals in — a vault's asset, a pool's
 * collateral, fxUSD for an f(x) debt. Holding something else should not mean
 * two transactions, so the cookbook's combo meals fuse a 0x swap into the same
 * batch. This pins which direction each card actually covers, because the
 * answer is NOT uniform and the gap is easy to mistake for an oversight.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { txBuilderConfigs } from "../../../src/tui/screens/tx-builder-configs";

const fieldsOf = (id: string) =>
  txBuilderConfigs[id](NetworkName.Ethereum).fields;

test("a vault deposit can be paid for with any shielded token", () => {
  // swap → deposit. The token row is what you PAY with.
  assert.ok(fieldsOf("morpho-vault-deposit").includes("token"));
});

test("a vault redemption can come back as any token", () => {
  // redeem → swap. The buy row is what you come back AS.
  assert.ok(fieldsOf("morpho-vault-redeem").includes("buyToken"));
});

test("opening an f(x) position can be paid for with any shielded token", () => {
  // swap → open.
  assert.ok(fieldsOf("fx-mint-open").includes("token"));
});

test("closing an f(x) position can return the collateral as any token", () => {
  // close → swap. This is the OUT side.
  assert.ok(fieldsOf("fx-mint-close").includes("buyToken"));
});

test("closing cannot be paid for with anything but fxUSD, and does not pretend to", () => {
  // The asymmetry, asserted so it is a documented limit rather than a bug
  // someone rediscovers. An f(x) debt is denominated in fxUSD and the shipped
  // combo swaps on the way OUT only — there is no swap → close recipe — so a
  // wallet holding no fxUSD cannot close a position regardless of what else it
  // holds. Closing that gap needs an upstream combo, not a field here.
  const close = txBuilderConfigs["fx-mint-close"](NetworkName.Ethereum);
  assert.ok(
    !close.fields.includes("token"),
    "a pay-with row would imply a swap into fxUSD that no recipe performs",
  );
  assert.ok(close.fixedToken, "the repay token is pinned, not chosen");
});

test("every DeFi card explains its batch before it is signed", () => {
  // A combo is several recipes chained, so consenting to the ends is not
  // consenting to the middle.
  for (const id of [
    "morpho-vault-deposit",
    "morpho-vault-redeem",
    "fx-mint-open",
    "fx-mint-close",
  ]) {
    assert.ok(
      txBuilderConfigs[id](NetworkName.Ethereum).previewLegs,
      `${id} does not describe its steps`,
    );
  }
});

test("every DeFi card is relay-adapt, so the fee gate finds a 7702 broadcaster", () => {
  for (const id of [
    "morpho-vault-deposit",
    "morpho-vault-redeem",
    "fx-mint-open",
    "fx-mint-close",
  ]) {
    assert.equal(
      txBuilderConfigs[id](NetworkName.Ethereum).relayAdapt,
      true,
      `${id} is not marked relay-adapt`,
    );
  }
});
