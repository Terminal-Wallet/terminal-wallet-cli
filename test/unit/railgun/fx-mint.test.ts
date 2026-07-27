/**
 * f(x) fxMint open, built offline.
 *
 * The whole family hinges on the position NFT reaching the shield step. If it
 * does not, the batch still builds, still estimates, and still sends — and the
 * position is minted to an ephemeral account that the wallet ratchets past and
 * never touches again. So the assertions here are about the NFT surviving:
 * that the recipe emits one, that it carries the predicted id, and that the
 * cookbook→SDK rename keeps the recipient.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName, NFTTokenType } from "@railgun-community/shared-models";
import {
  FxMintOpenRecipe,
  RecipeInput,
  resolvePool,
} from "@railgun-community/cookbook";
import { toShieldNFTRecipients } from "../../../src/railgun/transaction/cross-contract";
import { FXMINT_GAS_FLOOR } from "../../../src/railgun/transaction/fx/mint";
import { primeRailgunFees, privateRecipient } from "../../_support";

const POOL = "wstETH-Long";
const POSITION_ID = 1981n;
const COLLATERAL = 2_000_000_000_000_000_000n; // 2 wstETH
const TARGET_DEBT = 1_000_000_000_000_000_000_000n; // 1,000 fxUSD

const openOutput = async () => {
  primeRailgunFees();
  const pool = resolvePool(POOL);
  const recipe = new FxMintOpenRecipe({
    pool: POOL,
    targetDebt: TARGET_DEBT,
    predictedPositionId: POSITION_ID,
    borrowFeeRatio: 0n,
  });
  const input: RecipeInput = {
    networkName: NetworkName.Ethereum,
    railgunAddress: privateRecipient,
    erc20Amounts: [
      {
        tokenAddress: pool.collateralToken,
        decimals: pool.collateralDecimals,
        amount: COLLATERAL,
      },
    ],
    nfts: [],
  };
  return { output: await recipe.getRecipeOutput(input), pool };
};

test("opening a position needs no provider — the pool ref carries the collateral", async () => {
  const { output, pool } = await openOutput();
  assert.equal(pool.collateralToken, "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0");
  assert.equal(pool.collateralDecimals, 18n);
  assert.ok(output.crossContractCalls.length > 0);
});

test("the position NFT comes out addressed to the pool, at the predicted id", async () => {
  const { output, pool } = await openOutput();
  assert.equal(output.nftRecipients.length, 1, "exactly one position is minted");
  const [nft] = output.nftRecipients;
  assert.equal(nft.nftAddress, pool.address);
  assert.equal(nft.nftTokenType, NFTTokenType.ERC721);
  assert.equal(nft.amount, 1n, "a position is a single ERC-721, not a balance");
  // The id is hex, unpadded — 1981 is 0x7bd. A batch built for the wrong id
  // shields an NFT the executor does not own and reverts.
  assert.equal(nft.tokenSubID, "0x7bd");
  assert.equal(BigInt(nft.tokenSubID), POSITION_ID);
});

test("the rename hands the SDK a shield recipient that keeps this wallet", async () => {
  const { output } = await openOutput();
  const [shielded] = toShieldNFTRecipients(output.nftRecipients);
  assert.equal(shielded.recipientAddress, privateRecipient);
  assert.equal(shielded.tokenSubID, "0x7bd");
  assert.equal(shielded.amount, 1n);
});

test("the minted fxUSD is shielded back alongside the position", async () => {
  const { output } = await openOutput();
  const fxUSD = output.erc20AmountRecipients.find(
    (r) =>
      r.tokenAddress.toLowerCase() ===
      "0x085780639CC2cACd35E474e71f4d000e2405d8f6".toLowerCase(),
  );
  assert.ok(fxUSD, "fxUSD is not being shielded back");
  assert.equal(fxUSD.recipient, privateRecipient);
  assert.ok(fxUSD.amount > 0n);
});

test("the wallet's floor is above the recipe's unmeasured one", async () => {
  const { output } = await openOutput();
  // The recipe declares 1.5M, carried over from a pre-7702 version and never
  // measured under a relay-adapt batch. The wallet holds fx to the floor it
  // measured for a private swap, which does strictly less work.
  assert.equal(output.minGasLimit, 1_500_000n, "the recipe's own declared floor");
  assert.ok(
    FXMINT_GAS_FLOOR > output.minGasLimit,
    "the wallet floor must override the recipe's",
  );
});
