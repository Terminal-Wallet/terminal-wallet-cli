/**
 * f(x) fxMint — minting fxUSD against collateral, as a private 7702 relay-adapt
 * batch.
 *
 * Opening a position deposits collateral and mints both fxUSD and an ERC-721
 * that represents the position. That NFT is what makes the whole family work
 * here: it is a bearer token, so it gets shielded into RAILGUN alongside the
 * fxUSD and can later be unshielded to whatever fresh ephemeral account the
 * next batch runs as. Nothing is bound to an address that this wallet will
 * never use again.
 */
import {
  NetworkName,
  RailgunERC20Recipient,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";
import {
  FxMintOpenRecipe,
  FxMintPoolRef,
  RecipeERC20Amount,
  RecipeERC20Info,
  RecipeInput,
  RecipeOutput,
  ZeroXSwap_FxMintOpen_ComboMeal,
  getFxPool,
  makeEphemeralExecutor,
  resolvePool,
} from "@railgun-community/cookbook";
import {
  CrossContractInputs,
  toShieldNFTRecipients,
} from "../cross-contract";
import { getCurrentRailgunAddress } from "../../wallet/wallet-util";
import {
  getCurrentEphemeralInfo,
  syncEphemeralIndexOnce,
} from "../../wallet/ephemeral-util";
import { getProviderForChain } from "../../network/network-util";
import { needsSwapLeg } from "../morpho/vault";
import { getNextPositionId } from "./position";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fxmint");

/** f(x) is deployed on Ethereum only; every recipe rejects other networks. */
export const isFxSupportedNetwork = (chainName: NetworkName): boolean =>
  chainName === NetworkName.Ethereum;

/**
 * The gas floor an fx batch runs with.
 *
 * MEASURED. The first real mainnet mint (0x252155ef…) carried 3,016,590 and
 * consumed 2,917,543 without ever completing. Traced per leg:
 *
 *   RAILGUN unshield   1,121,136   (40% of the batch)
 *   approve + 0x swap    209,278   (7.5%)
 *   fx operate            548,398
 *   shield               885,471   REVERTED
 *
 * Inside that shield the call into the RailgunSmartWallet was given 780,728,
 * consumed 768,540 — 98.4% — and reverted with NO revert data at all. No data
 * plus near-total consumption is out of gas, not a `require`.
 *
 * Note what this says about the swap: it is 7.5% of the batch. A BARE open,
 * with no swap leg at all, would still have used about 2.58M and hit the same
 * wall — so the floor is not a combo-only concern, and splitting it per flow
 * would leave the cheaper path just as broken.
 *
 * The floor therefore covers the whole batch INCLUDING a shield that actually
 * completes. Not set arbitrarily high either: it is baked into the action data
 * as a `gasleft()` require, so an excessive one makes the transaction carry gas
 * it cannot use and can revert the estimate on the floor check itself.
 */
export const FXMINT_GAS_FLOOR = 4_000_000n;

/**
 * How wide the swap leg may slip when the position is opened with something
 * other than the pool's collateral. Matches the standalone private swap.
 */
export const FXMINT_SWAP_SLIPPAGE_BPS = 320;

export interface FxMintOpenBuild extends CrossContractInputs {
  /**
   * What the batch would do, step by step, as the recipe reported it. Returned
   * rather than formatted here: the renderer decides how to show it, and the
   * transaction layer must not import the renderer.
   */
  steps: RecipeOutput["stepOutputs"];
  pool: ReturnType<typeof resolvePool>;
  /** The id the batch expects the pool to mint. */
  positionId: bigint;
  collateral: { tokenAddress: string; decimals: number; amount: bigint };
  /** Whether a 0x swap into the collateral was folded into the same batch. */
  swapped: boolean;
  /** fxUSD the position will owe, before the pool's borrow fee. */
  targetDebt: bigint;
  borrowFeeRatio: bigint;
}

/**
 * Build "open a position": put up collateral, mint `targetDebt` of fxUSD, and
 * shield both the fxUSD and the position NFT back to this wallet.
 *
 * `payWith` is what the collateral is bought with. Naming the pool's own
 * collateral is the same as omitting it — there is nothing to swap, and the
 * cookbook's combo refuses to trade the collateral for itself. Anything else
 * folds a 0x swap into the front of the same batch, so a position can be opened
 * from whatever happens to be shielded rather than only from wstETH or WBTC.
 *
 * The encryption key is required and is not prompted for here: the batch
 * executes as an ephemeral EOA derived from it, and a transaction primitive
 * that stops to ask the user for a password is hidden control flow.
 */
export const getFxMintOpenInputs = async (
  chainName: NetworkName,
  poolRef: FxMintPoolRef,
  collateralAmount: bigint,
  targetDebt: bigint,
  encryptionKey: string,
  payWith?: { tokenAddress: string; decimals: number },
): Promise<FxMintOpenBuild> => {
  if (!isFxSupportedNetwork(chainName)) {
    throw new Error(`f(x) is Ethereum-only; this wallet is on ${chainName}.`);
  }

  const provider = getProviderForChain(chainName);
  const railgunAddress = getCurrentRailgunAddress();
  const pool = resolvePool(poolRef);

  // The batch executes as this account, so it is what mints and holds the
  // position before the shield step takes it. Realign the index first so the
  // address the calldata is built against is the one the estimate and proof
  // derive.
  await syncEphemeralIndexOnce(chainName, encryptionKey);
  const { address: ephemeralAddress, index: ephemeralIndex } =
    await getCurrentEphemeralInfo(chainName, encryptionKey);

  // The borrow fee is read rather than assumed: it is applied to the debt on
  // chain, and the recipe needs the same ratio to work out the net fxUSD it can
  // declare as output.
  const { borrowFeeRatio } = await getFxPool(poolRef, provider);
  const positionId = await getNextPositionId(poolRef, provider);
  log.debug(
    `open on ${pool.address} as ephemeral [${ephemeralIndex}] ${ephemeralAddress}, ` +
      `position ${positionId}, debt ${targetDebt}, borrowFeeRatio ${borrowFeeRatio}`,
  );

  const swapFrom = needsSwapLeg(payWith?.tokenAddress, pool.collateralToken)
    ? payWith
    : undefined;
  const spendToken = swapFrom ?? {
    tokenAddress: pool.collateralToken,
    decimals: Number(pool.collateralDecimals),
  };

  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = [
    {
      tokenAddress: spendToken.tokenAddress,
      decimals: BigInt(spendToken.decimals),
      amount: collateralAmount,
    },
  ];

  const fxOpts = {
    pool: poolRef,
    targetDebt,
    predictedPositionId: positionId,
    borrowFeeRatio,
  };
  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    nfts: [],
  };
  const sellERC20Info: RecipeERC20Info | undefined = swapFrom && {
    tokenAddress: swapFrom.tokenAddress,
    decimals: BigInt(swapFrom.decimals),
  };
  const recipeOutput = sellERC20Info
    ? await new ZeroXSwap_FxMintOpen_ComboMeal({
        ...fxOpts,
        sellERC20Info,
        swapSlippageBasisPoints: FXMINT_SWAP_SLIPPAGE_BPS,
        recipient: makeEphemeralExecutor(ephemeralAddress, "fxmint open"),
      }).getComboMealOutput(recipeInput)
    : await new FxMintOpenRecipe(fxOpts).getRecipeOutput(recipeInput);

  const relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] =
    recipeOutput.erc20AmountRecipients.map(({ tokenAddress }) => ({
      tokenAddress,
      recipientAddress: railgunAddress,
    }));

  const relayAdaptShieldNFTRecipients = toShieldNFTRecipients(
    recipeOutput.nftRecipients,
  );
  if (!relayAdaptShieldNFTRecipients.length) {
    // Without this the batch mints the position to the ephemeral account and
    // shields nothing, leaving it on an address the wallet ratchets past.
    throw new Error("The open recipe produced no position NFT to shield.");
  }

  return {
    pool,
    positionId,
    collateral: {
      tokenAddress: spendToken.tokenAddress,
      decimals: Number(spendToken.decimals),
      amount: collateralAmount,
    },
    swapped: Boolean(swapFrom),
    targetDebt,
    borrowFeeRatio,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    // Opening mints the position rather than spending one, so nothing is
    // unshielded on the NFT side.
    relayAdaptUnshieldNFTAmounts: [] as RailgunNFTAmount[],
    relayAdaptShieldNFTRecipients,
    steps: recipeOutput.stepOutputs,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit:
      recipeOutput.minGasLimit > FXMINT_GAS_FLOOR
        ? recipeOutput.minGasLimit
        : FXMINT_GAS_FLOOR,
  };
};
