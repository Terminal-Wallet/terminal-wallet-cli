/**
 * The Morpho vault recipes, built offline.
 *
 * These assert the SHAPE the wallet's mapping depends on: which calls come out,
 * what gets shielded back, and — the control — that nothing NFT-shaped appears.
 * The wallet drops `nftRecipients` on the floor (every SDK NFT argument is a
 * hardcoded `[]`), so a recipe that started emitting one would strand it with
 * no error anywhere. This test is what notices.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import {
  MorphoVaultV1DepositRecipe,
  RecipeInput,
  makeEphemeralExecutor,
} from "@railgun-community/cookbook";
import {
  SELECTOR,
  UNGATED_VAULT,
  encode,
  makeFakeProvider,
  primeRailgunFees,
  privateRecipient,
  TOKENS,
} from "../../_support";
import { receivedLeg } from "../../../src/railgun/transaction/morpho/vault";

const VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB";
const EXECUTOR = "0x1234567890AbcdEF1234567890aBcdef12345678";
const DEPOSIT_ASSETS = 1_000_000_000n; // 1,000 USDC at 6dp
const EXPECTED_SHARES = 900_000_000_000_000_000_000n; // 900 shares at 18dp

const vaultProvider = () =>
  makeFakeProvider({
    ...UNGATED_VAULT,
    [`${VAULT}:${SELECTOR.asset}`]: encode(["address"], [TOKENS.USDC.address]),
    [`${VAULT}:${SELECTOR.decimals}`]: encode(["uint8"], [18]),
    [`${TOKENS.USDC.address}:${SELECTOR.decimals}`]: encode(["uint8"], [6]),
    [`${VAULT}:${SELECTOR.previewDeposit}`]: encode(
      ["uint256"],
      [EXPECTED_SHARES],
    ),
  });

const depositOutput = async () => {
  primeRailgunFees();
  const { provider, calls } = vaultProvider();
  const recipe = new MorphoVaultV1DepositRecipe(
    VAULT,
    100n,
    makeEphemeralExecutor(EXECUTOR),
    provider,
  );
  const input: RecipeInput = {
    networkName: NetworkName.Ethereum,
    railgunAddress: privateRecipient,
    erc20Amounts: [
      {
        tokenAddress: TOKENS.USDC.address,
        decimals: BigInt(TOKENS.USDC.decimals),
        amount: DEPOSIT_ASSETS,
      },
    ],
    nfts: [],
  };
  return { output: await recipe.getRecipeOutput(input), calls };
};

test("a vault deposit builds with no network beyond the vault's own reads", async () => {
  const { output, calls } = await depositOutput();
  assert.ok(output.crossContractCalls.length > 0, "produces calldata");
  assert.deepEqual(
    [...new Set(calls.map((c) => c.selector))].sort(),
    [
      SELECTOR.decimals,
      SELECTOR.previewDeposit,
      SELECTOR.asset,
      // Since cookbook -fx.3 the recipe asks whether the vault is gated before
      // it builds, because a gated V2 vault refuses this wallet's fresh
      // ephemeral executor outright and the batch would mine having done
      // nothing.
      SELECTOR.receiveSharesGate,
      SELECTOR.sendSharesGate,
      SELECTOR.receiveAssetsGate,
      SELECTOR.sendAssetsGate,
    ].sort(),
    "reads the vault's own state and its gates, and nothing else",
  );
});

test("a vault deposit shields the shares back, and nothing NFT-shaped", async () => {
  const { output } = await depositOutput();
  const shares = output.erc20AmountRecipients.find(
    (r) => r.tokenAddress.toLowerCase() === VAULT.toLowerCase(),
  );
  assert.ok(shares, "the share token comes back to be shielded");
  assert.equal(shares.recipient, privateRecipient, "shielded to this wallet");
  // The control: the wallet cannot carry an NFT across the seam, so a Tier-A
  // recipe must not produce one.
  assert.equal(output.nftRecipients.length, 0, "no NFT output");
});

test("the deposit carries the recipe's own gas floor, not the no-floor default", async () => {
  const { output } = await depositOutput();
  assert.equal(output.minGasLimit, 2_900_000n);
});

test("receivedLeg reports the expected amount and the floor it will accept", async () => {
  const { output } = await depositOutput();
  const leg = receivedLeg(output, VAULT);
  assert.equal(leg.tokenAddress.toLowerCase(), VAULT.toLowerCase());
  assert.equal(leg.decimals, 18);
  // A vault clamps to the slippage floor on execution, so the reviewed figure
  // and the committed figure are two different numbers.
  assert.ok(leg.minimum <= leg.amount, "the floor is not above the estimate");
  assert.ok(leg.amount > 0n, "an amount was quoted");
});

test("receivedLeg refuses to guess when the recipe produced no such output", async () => {
  const { output } = await depositOutput();
  assert.throws(
    () => receivedLeg(output, TOKENS.WETH.address),
    /produced no .* output to shield/,
  );
});
