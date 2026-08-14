/**
 * A batch shown as what it does, not just what goes in and out.
 *
 * A combo meal is several recipes chained and each recipe is several steps, so
 * one signature can be a swap, two approvals, a protocol call and a shield.
 * Showing only the ends asks the user to consent to the middle unseen.
 *
 * Built against a real recipe output rather than a hand-made fixture, so the
 * shape being rendered is the shape the cookbook actually produces.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { FxMintOpenRecipe, resolvePool } from "@railgun-community/cookbook";
import { defiLegLines, defiLegs } from "../../../src/tui/format/defi-legs";
import { primeRailgunFees, privateRecipient } from "../../_support";

const SYMBOLS: Record<string, string> = {
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wstETH",
  "0x085780639cc2cacd35e474e71f4d000e2405d8f6": "fxUSD",
};
const symbolOf = (a: string) => SYMBOLS[a.toLowerCase()];

const openOutput = async () => {
  primeRailgunFees();
  const pool = resolvePool("wstETH-Long");
  const recipe = new FxMintOpenRecipe({
    pool: "wstETH-Long",
    targetDebt: 1000n * 10n ** 18n,
    predictedPositionId: 4242n,
    borrowFeeRatio: 0n,
  });
  return recipe.getRecipeOutput({
    networkName: NetworkName.Ethereum,
    railgunAddress: privateRecipient,
    erc20Amounts: [
      {
        tokenAddress: pool.collateralToken,
        decimals: pool.collateralDecimals,
        amount: 2n * 10n ** 18n,
      },
    ],
    nfts: [],
  });
};

test("every step of the batch becomes a leg, in order", async () => {
  const legs = defiLegs(await openOutput(), symbolOf);
  assert.deepEqual(
    legs.map((l) => l.name),
    ["Unshield", "Approve ERC20 Spender", "f(x) Open Position", "Shield"],
  );
});

test("the protocol call is substance; the rest is plumbing", async () => {
  // So a renderer can dim the framing without hiding it — it still has to be
  // visible to consent to.
  const legs = defiLegs(await openOutput(), symbolOf);
  const substantive = legs.filter((l) => !l.plumbing).map((l) => l.name);
  assert.deepEqual(substantive, ["f(x) Open Position"]);
});

test("a leg says what it spends and what it gives, with symbols", async () => {
  const legs = defiLegs(await openOutput(), symbolOf);
  const open = legs.find((l) => l.name === "f(x) Open Position");
  assert.match(open?.spends ?? "", /wstETH$/);
  assert.match(open?.gives ?? "", /fxUSD$/);
  // 2 wstETH in, less the 0.25% unshield fee, is what reaches the pool.
  assert.match(open?.spends ?? "", /^1\.995 /);
});

test("the position appears as a leg output, not as a token", async () => {
  const legs = defiLegs(await openOutput(), symbolOf);
  assert.equal(legs.find((l) => l.name === "f(x) Open Position")?.nft, "out");
  assert.equal(legs.find((l) => l.name === "Shield")?.nft, "out");
});

test("an unnameable token is shown short rather than hidden", async () => {
  // A step moving a token nobody can name is the one most worth seeing.
  const legs = defiLegs(await openOutput(), () => undefined);
  const open = legs.find((l) => l.name === "f(x) Open Position");
  assert.match(open?.gives ?? "", /^\d[\d.]* 0x0857…$/);
});

test("amounts are trimmed rather than shown to eighteen places", async () => {
  const legs = defiLegs(await openOutput(), symbolOf);
  for (const leg of legs) {
    for (const part of [leg.spends, leg.gives]) {
      if (!part) continue;
      const frac = part.split(" ")[0].split(".")[1] ?? "";
      assert.ok(frac.length <= 6, `"${part}" shows too many decimals`);
    }
  }
});

test("the lines render as an ordered tree, last leg closed", async () => {
  const lines = defiLegLines(await openOutput().then((o) => defiLegs(o, symbolOf)), (t) => t);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith("├"));
  assert.ok(lines[lines.length - 1].startsWith("└"));
  assert.ok(lines.some((l) => l.includes("→")), "a flow arrow should appear");
});
