/**
 * Closing an f(x) position — the way out.
 *
 * Unwinding is the mirror of opening: the position NFT is unshielded into the
 * batch, the debt token is unshielded to repay the debt, the pool hands back
 * the collateral, and everything left is shielded again. The position NFT comes
 * back either way — f(x) empties a position on close, it never destroys it, so
 * a full close and a partial one differ only in how much debt is left.
 *
 * How MUCH can be repaid is not a free choice. It is bounded by the debt token
 * the wallet holds, less RAILGUN's unshield fee, less the pool's repay fee — and
 * the cookbook computes that, because getting it wrong either leaves dust debt
 * or tries to repay more than was unshielded. `computeFxClose` is that
 * calculation, and it is used rather than reimplemented.
 */
import {
  NetworkName,
  NFTTokenType,
  RailgunERC20Recipient,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";
import { Contract } from "ethers";
import {
  FX_POOL_RATIO_ABI,
  FxMintCloseRecipe,
  FxMintClose_ZeroXSwap_ComboMeal,
  FxMintPoolRef,
  RecipeERC20Amount,
  RecipeERC20Info,
  RecipeInput,
  RecipeOutput,
  computeFxClose,
  getFxPool,
  getFxPosition,
  makeEphemeralExecutor,
  resolvePool,
} from "@railgun-community/cookbook";
import { CrossContractInputs, toShieldNFTRecipients } from "../cross-contract";
import { getCurrentRailgunAddress } from "../../wallet/wallet-util";
import {
  getCurrentEphemeralInfo,
  syncEphemeralIndexOnce,
} from "../../wallet/ephemeral-util";
import { getProviderForChain } from "../../network/network-util";
import { getRailgunFeeBasisPoints } from "../../engine/engine";
import {
  FXMINT_GAS_FLOOR,
  FXMINT_SWAP_SLIPPAGE_BPS,
  isFxSupportedNetwork,
} from "./mint";
import { needsSwapLeg } from "../morpho/vault";
import { capWithdrawForDebtRatio } from "./close-guard";
import { fullCloseRequirement, FullCloseRequirement } from "./full-close";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fxmint-close");

export interface FxMintCloseBuild extends CrossContractInputs {
  /**
   * What the batch would do, step by step, as the recipe reported it. Returned
   * rather than formatted here: the renderer decides how to show it, and the
   * transaction layer must not import the renderer.
   */
  steps: RecipeOutput["stepOutputs"];
  pool: ReturnType<typeof resolvePool>;
  positionId: bigint;
  /** Debt token the batch will repay. */
  repayAmount: bigint;
  /** Collateral the pool will release. */
  withdrawColl: bigint;
  /**
   * Whether any debt is left. NOT whether the NFT survives — it always does:
   * f(x) empties a position rather than destroying it, proved on mainnet by
   * tx 0x73d732bc..., which sent the pool's own full-close sentinel and left
   * ownerOf still returning the RAILGUN proxy.
   */
  partialClose: boolean;
  /** Whether the released collateral was swapped on the way back. */
  swapped: boolean;
  /**
   * What a FULL close would need, and how far short this is.
   *
   * A close silently degrades to partial when the debt token does not cover the
   * whole debt, and the gap is often a fraction of a percent. Returned so the
   * caller can say so before the user commits, rather than leaving them to
   * derive it from two fee ratios.
   */
  fullClose: FullCloseRequirement;
}

/**
 * Build a close for a position the wallet holds.
 *
 * `shieldedDebtToken` is what the wallet can put toward the debt. Passing less
 * than the full debt is how a partial close is asked for — the recipe works out
 * the rest, including whether the position survives.
 *
 * `receiveAs` swaps the released collateral before it is shielded, so the
 * proceeds come back as something other than wstETH or WBTC. Naming the
 * collateral itself is the same as omitting it.
 *
 * Note the asymmetry: the debt is ALWAYS repaid in the pool's own debt token —
 * fxUSD on a long, the volatile asset on a short. THIS path's combo swaps on
 * the way OUT only, so a wallet holding none of that token cannot close a
 * position here regardless of what else it holds. `dust-close.ts` is the way
 * round that: the cookbook also ships a swap-THEN-close combo, which buys the
 * debt token first.
 */
export const getFxMintCloseInputs = async (
  chainName: NetworkName,
  poolRef: FxMintPoolRef,
  positionId: bigint,
  shieldedDebtToken: bigint,
  encryptionKey: string,
  receiveAs?: { tokenAddress: string; decimals: number },
): Promise<FxMintCloseBuild> => {
  if (!isFxSupportedNetwork(chainName)) {
    throw new Error(`f(x) is Ethereum-only; this wallet is on ${chainName}.`);
  }

  const provider = getProviderForChain(chainName);
  const railgunAddress = getCurrentRailgunAddress();
  const pool = resolvePool(poolRef);

  await syncEphemeralIndexOnce(chainName, encryptionKey);
  const { address: ephemeralAddress, index: ephemeralIndex } =
    await getCurrentEphemeralInfo(chainName, encryptionKey);

  const [position, poolState] = await Promise.all([
    getFxPosition(positionId, poolRef, provider),
    getFxPool(poolRef, provider),
  ]);

  // The unshield fee is taken off the debt token on the way out, so the repay
  // has to be sized against what actually arrives, not what was sent. Guessing it
  // would size the repay against money that never turns up, and the batch
  // reverts after the proof is paid for.
  const fees = getRailgunFeeBasisPoints(chainName);
  if (!fees) {
    throw new Error(
      `RAILGUN fees are not known for ${chainName} yet — wait for the engine to load.`,
    );
  }
  // Before computeFxClose, which refuses a zero debt with wording about a
  // proportional withdraw being undefined — true, and not what the user needs
  // to read. A closed position stays in the wallet as an empty one, so
  // selecting it here is an easy mistake rather than an exotic one.
  if (position.debt <= 0n) {
    throw new Error(
      "This position is already empty — nothing is owed, so there is nothing to close.",
    );
  }
  const amounts = computeFxClose({
    // Both of these are NATIVE token amounts. The cookbook used to take the
    // position's raw figures here and derive the native ones itself; it now
    // takes what `getFxPosition` reports directly, which is the same number on
    // a long and differs by the manager's scaling factor on a short.
    collateral: position.collateralAmount,
    debt: position.debt,
    availableDebtToken: shieldedDebtToken,
    repayFeeRatio: poolState.repayFeeRatio,
    // Zero on a long and 0.1% on a short. Required rather than defaulted since
    // -fx.3, because defaulting it silently over-declared a short's collateral.
    withdrawFeeRatio: poolState.withdrawFeeRatio,
    railgunUnshieldFeeBps: fees.unshield,
  });

  const fullClose = fullCloseRequirement({
    debt: position.debt,
    repayFeeRatio: poolState.repayFeeRatio,
    railgunUnshieldFeeBps: fees.unshield,
    availableDebtToken: shieldedDebtToken,
  });

  log.debug(
    `close ${positionId} on ${pool.address} as ephemeral [${ephemeralIndex}] ` +
      `${ephemeralAddress}: repay ${amounts.repayAmount}, withdraw ` +
      `${amounts.withdrawColl}, partial=${amounts.partialClose}`,
  );
  if (!fullClose.closesFully) {
    // The number the user would otherwise have to derive themselves.
    log.warn(
      `close ${positionId} will be PARTIAL: closing outright needs ` +
        `${fullClose.required} of the debt token and ${shieldedDebtToken} is ` +
        `available — short by ${fullClose.shortfall}. A partial close leaves the ` +
        `position open and still accruing debt.`,
    );
  }

  if (amounts.repayAmount <= 0n) {
    throw new Error(
      "Not enough of the debt token is shielded to repay any of this position's debt.",
    );
  }

  const positionNFT: RailgunNFTAmount = {
    nftAddress: pool.address,
    tokenSubID: `0x${positionId.toString(16)}`,
    nftTokenType: NFTTokenType.ERC721,
    amount: 1n,
  };

  // A debt is repaid in the pool's own debt token, which is fxUSD on the long
  // pools and the volatile asset on the shorts. Read off the descriptor rather
  // than named, so the wrong token is not unshielded for a pool this predates.
  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = [
    {
      tokenAddress: pool.debtToken,
      decimals: pool.debtDecimals,
      amount: shieldedDebtToken,
    },
  ];

  // A partial close leaves a residual position, and the pool checks ITS debt
  // ratio. The proportional withdrawal above is sized in native collateral and
  // arrives at the pool converted to raw, slightly inflated — negligible until
  // the residual is small, at which point the ratio is computed over almost
  // nothing and the inflation dominates it. Cap the withdrawal so the residual
  // stays inside the pool's range. A full close is sent as the pool's own
  // sentinel and leaves no residual, so it is left alone.
  let { withdrawColl } = amounts;
  if (amounts.partialClose) {
    const [minRatio, maxRatio] = await new Contract(
      pool.address,
      FX_POOL_RATIO_ABI,
      provider,
    ).getDebtRatioRange();
    void minRatio;
    const guard = capWithdrawForDebtRatio({
      rawColls: position.rawColls,
      rawDebts: position.rawDebts,
      debt: position.debt,
      collateralAmount: position.collateralAmount,
      debtRatio: position.debtRatio,
      maxRatio,
      repayAmount: amounts.repayAmount,
      withdrawColl: amounts.withdrawColl,
    });
    if (guard.clamped) {
      log.warn(
        `close ${positionId}: proportional withdraw ${amounts.withdrawColl} would ` +
          `leave a debt ratio of ${guard.projectedRatio} against a maximum of ` +
          `${maxRatio}; withdrawing ${guard.withdrawColl} instead to land near ` +
          `${guard.targetRatio}. The repay is unchanged — the difference stays ` +
          `as collateral in the position.`,
      );
    }
    ({ withdrawColl } = guard);
  }

  const fxOpts = {
    pool: poolRef,
    positionId,
    repayAmount: amounts.repayAmount,
    withdrawColl,
    approveAmount: amounts.approveAmount,
    withdrawFeeRatio: poolState.withdrawFeeRatio,
    partialClose: amounts.partialClose,
  };
  const swapTo = needsSwapLeg(receiveAs?.tokenAddress, pool.collateralToken)
    ? receiveAs
    : undefined;
  const buyERC20Info: RecipeERC20Info | undefined = swapTo && {
    tokenAddress: swapTo.tokenAddress,
    decimals: BigInt(swapTo.decimals),
  };
  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    // The position has to be IN the batch: `operate` requires the executor to
    // own it, and the executor is a fresh account that holds nothing until the
    // unshield puts it there.
    nfts: [{ ...positionNFT, recipient: railgunAddress }],
  };
  const recipeOutput = buyERC20Info
    ? await new FxMintClose_ZeroXSwap_ComboMeal({
        ...fxOpts,
        buyERC20Info,
        swapSlippageBasisPoints: FXMINT_SWAP_SLIPPAGE_BPS,
        recipient: makeEphemeralExecutor(ephemeralAddress, "fxmint close"),
      }).getComboMealOutput(recipeInput)
    : await new FxMintCloseRecipe(fxOpts).getRecipeOutput(recipeInput);

  const relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] =
    recipeOutput.erc20AmountRecipients.map(({ tokenAddress }) => ({
      tokenAddress,
      recipientAddress: railgunAddress,
    }));

  return {
    pool,
    positionId,
    repayAmount: amounts.repayAmount,
    withdrawColl: amounts.withdrawColl,
    partialClose: amounts.partialClose,
    swapped: Boolean(swapTo),
    fullClose,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts: [positionNFT],
    // Whatever the recipe declares. A full close declares no NFT output, and
    // the NFT still comes back — RelayAdapt returns it as an unspent leftover
    // rather than a declared shield, since nothing in the batch consumes it.
    relayAdaptShieldNFTRecipients: toShieldNFTRecipients(
      recipeOutput.nftRecipients,
    ),
    relayAdaptShieldERC20Addresses,
    steps: recipeOutput.stepOutputs,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit:
      recipeOutput.minGasLimit > FXMINT_GAS_FLOOR
        ? recipeOutput.minGasLimit
        : FXMINT_GAS_FLOOR,
  };
};
