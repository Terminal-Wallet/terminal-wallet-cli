/**
 * Adjusting an f(x) position that already exists.
 *
 * Four actions, one shape: the position NFT is unshielded into the batch,
 * `operate` moves the collateral and the debt by some delta, and the NFT is
 * shielded back — the position always survives, so unlike a close it always
 * comes back.
 *
 * They differ only in which delta is non-zero, and in what has to be unshielded
 * alongside the NFT to pay for it:
 *
 *   topup             more collateral, same debt      unshields collateral
 *   topup + borrow    more collateral, more debt      unshields collateral
 *   borrow more       same collateral, more debt      unshields nothing
 *   repay             same collateral, less debt      unshields the debt token
 */
import {
  NetworkName,
  NFTTokenType,
  RailgunERC20Recipient,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";
import {
  FxMintBorrowMoreRecipe,
  FxMintPoolRef,
  FxMintRepayDebtRecipe,
  FxMintTopupAndBorrowRecipe,
  FxMintTopupRecipe,
  RecipeERC20Amount,
  RecipeInput,
  RecipeOutput,
  ZeroXSwap_FxMintTopupAndBorrow_ComboMeal,
  ZeroXSwap_FxMintTopup_ComboMeal,
  computeFxRepay,
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
import { needsSwapLeg } from "../morpho/vault";
import {
  FXMINT_GAS_FLOOR,
  FXMINT_SWAP_SLIPPAGE_BPS,
  isFxSupportedNetwork,
} from "./mint";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fxmint-adjust");

export type FxAdjustAction =
  | "topup"
  | "topup-and-borrow"
  | "borrow-more"
  | "repay";

export interface FxMintAdjustBuild extends CrossContractInputs {
  action: FxAdjustAction;
  pool: ReturnType<typeof resolvePool>;
  positionId: bigint;
  /** Collateral added, in the pool's collateral token. Zero for debt-only moves. */
  collateralAdded: bigint;
  /** Debt token borrowed (positive) or repaid (negative). */
  debtDelta: bigint;
  /** Whether a 0x swap into the collateral was folded in. */
  swapped: boolean;
  steps: RecipeOutput["stepOutputs"];
}

/** Which token this action has to unshield to pay for itself. */
const spendTokenFor = (
  action: FxAdjustAction,
  pool: ReturnType<typeof resolvePool>,
  payWith?: { tokenAddress: string; decimals: number },
): { tokenAddress: string; decimals: number } | undefined => {
  if (action === "borrow-more") return undefined; // borrowing costs nothing up front
  if (action === "repay") {
    // The pool's debt token, not fxUSD by name: a short pool's debt is the
    // volatile asset, and on one of them it is 8-decimal.
    return {
      tokenAddress: pool.debtToken,
      decimals: Number(pool.debtDecimals),
    };
  }
  return (
    payWith ?? {
      tokenAddress: pool.collateralToken,
      decimals: Number(pool.collateralDecimals),
    }
  );
};

/** The one branch that differs per action, kept apart from the shared plumbing. */
const buildOutput = async (args: {
  action: FxAdjustAction;
  poolRef: FxMintPoolRef;
  positionId: bigint;
  debtChange: bigint;
  borrowFeeRatio: bigint;
  repayFeeRatio: bigint;
  chainName: NetworkName;
  provider: ReturnType<typeof getProviderForChain>;
  executor: ReturnType<typeof makeEphemeralExecutor>;
  swapFrom?: { tokenAddress: string; decimals: number };
  shieldedDebtToken: bigint;
  recipeInput: RecipeInput;
}): Promise<RecipeOutput> => {
  const {
    action,
    poolRef,
    positionId,
    debtChange,
    borrowFeeRatio,
    repayFeeRatio,
    chainName,
    executor,
    swapFrom,
    shieldedDebtToken,
    recipeInput,
  } = args;
  const sellERC20Info = swapFrom && {
    tokenAddress: swapFrom.tokenAddress,
    decimals: BigInt(swapFrom.decimals),
  };

  if (action === "topup") {
    return sellERC20Info
      ? new ZeroXSwap_FxMintTopup_ComboMeal({
          pool: poolRef,
          positionId,
          sellERC20Info,
          swapSlippageBasisPoints: FXMINT_SWAP_SLIPPAGE_BPS,
          recipient: executor,
        }).getComboMealOutput(recipeInput)
      : new FxMintTopupRecipe({ pool: poolRef, positionId }).getRecipeOutput(
          recipeInput,
        );
  }

  if (action === "topup-and-borrow") {
    const opts = {
      pool: poolRef,
      positionId,
      additionalDebt: debtChange,
      borrowFeeRatio,
    };
    return sellERC20Info
      ? new ZeroXSwap_FxMintTopupAndBorrow_ComboMeal({
          ...opts,
          sellERC20Info,
          swapSlippageBasisPoints: FXMINT_SWAP_SLIPPAGE_BPS,
          recipient: executor,
        }).getComboMealOutput(recipeInput)
      : new FxMintTopupAndBorrowRecipe(opts).getRecipeOutput(recipeInput);
  }

  if (action === "borrow-more") {
    return new FxMintBorrowMoreRecipe({
      pool: poolRef,
      positionId,
      additionalDebt: debtChange,
      borrowFeeRatio,
    }).getRecipeOutput(recipeInput);
  }

  // Repay. How much can actually be repaid is bounded by what survives the
  // unshield fee and the pool's repay fee, and the cookbook computes that —
  // sizing it on the amount SENT would try to spend money that never arrives.
  const fees = getRailgunFeeBasisPoints(chainName);
  if (!fees) {
    throw new Error(
      `RAILGUN fees are not known for ${chainName} yet — wait for the engine to load.`,
    );
  }
  const position = await getFxPosition(positionId, poolRef, args.provider);
  const amounts = computeFxRepay({
    // Native debt-token units, which is what `getFxPosition` reports and what
    // the repay step spends. Equal to the raw figure on a long; on a short they
    // differ by the manager's scaling factor.
    debt: position.debt,
    availableDebtToken: shieldedDebtToken,
    desiredRepayAmount: shieldedDebtToken,
    repayFeeRatio,
    railgunUnshieldFeeBps: fees.unshield,
  });
  if (amounts.repayAmount <= 0n) {
    throw new Error(
      "Not enough of the debt token is shielded to repay any of this debt.",
    );
  }
  return new FxMintRepayDebtRecipe({
    pool: poolRef,
    positionId,
    repayAmount: amounts.repayAmount,
    approveAmount: amounts.approveAmount,
    repayFeeRatio,
  }).getRecipeOutput(recipeInput);
};

/**
 * Adjust a position the wallet holds.
 *
 * `amount` is denominated in whatever the action spends — collateral for a
 * topup, the debt token for a repay — and is ignored for a borrow-more, which
 * spends nothing. `debtChange` is the debt token to borrow, for the two actions
 * that borrow.
 *
 * `payWith` swaps into the collateral first, for the topups. A repay is always
 * in the pool's own debt token: the debt is denominated in it and no shipped
 * combo swaps into it.
 */
export const getFxMintAdjustInputs = async (
  chainName: NetworkName,
  action: FxAdjustAction,
  poolRef: FxMintPoolRef,
  positionId: bigint,
  amount: bigint,
  debtChange: bigint,
  encryptionKey: string,
  payWith?: { tokenAddress: string; decimals: number },
): Promise<FxMintAdjustBuild> => {
  if (!isFxSupportedNetwork(chainName)) {
    throw new Error(`f(x) is Ethereum-only; this wallet is on ${chainName}.`);
  }

  const provider = getProviderForChain(chainName);
  const railgunAddress = getCurrentRailgunAddress();
  const pool = resolvePool(poolRef);

  await syncEphemeralIndexOnce(chainName, encryptionKey);
  const { address: ephemeralAddress, index: ephemeralIndex } =
    await getCurrentEphemeralInfo(chainName, encryptionKey);
  const executor = makeEphemeralExecutor(ephemeralAddress, `fxmint ${action}`);

  const poolState = await getFxPool(poolRef, provider);
  const spend = spendTokenFor(action, pool, payWith);
  const swapFrom =
    spend && action !== "repay" && needsSwapLeg(spend.tokenAddress, pool.collateralToken)
      ? spend
      : undefined;

  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = spend
    ? [
        {
          tokenAddress: spend.tokenAddress,
          decimals: BigInt(spend.decimals),
          amount,
        },
      ]
    : [];

  const positionNFT: RailgunNFTAmount = {
    nftAddress: pool.address,
    tokenSubID: `0x${positionId.toString(16)}`,
    nftTokenType: NFTTokenType.ERC721,
    amount: 1n,
  };
  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    // `operate` requires the executor to own the position, and the executor is
    // a fresh account that holds nothing until the unshield puts it there.
    nfts: [{ ...positionNFT, recipient: railgunAddress }],
  };

  log.debug(
    `${action} ${positionId} on ${pool.address} as ephemeral [${ephemeralIndex}] ` +
      `${ephemeralAddress}: spend ${amount}, debt ${debtChange}`,
  );

  const recipeOutput = await buildOutput({
    action,
    poolRef,
    positionId,
    debtChange,
    borrowFeeRatio: poolState.borrowFeeRatio,
    repayFeeRatio: poolState.repayFeeRatio,
    chainName,
    provider,
    executor,
    swapFrom,
    shieldedDebtToken: amount,
    recipeInput,
  });

  const relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] =
    recipeOutput.erc20AmountRecipients.map(({ tokenAddress }) => ({
      tokenAddress,
      recipientAddress: railgunAddress,
    }));

  const shieldNFTs = toShieldNFTRecipients(recipeOutput.nftRecipients);
  if (!shieldNFTs.length) {
    // An adjust always keeps the position. Nothing coming back means it would
    // be left at an ephemeral account the wallet ratchets past.
    throw new Error(
      "The adjust recipe produced no position NFT to shield back.",
    );
  }

  return {
    action,
    pool,
    positionId,
    collateralAdded: action === "topup" || action === "topup-and-borrow" ? amount : 0n,
    debtDelta: action === "repay" ? -amount : debtChange,
    swapped: Boolean(swapFrom),
    steps: recipeOutput.stepOutputs,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts: [positionNFT],
    relayAdaptShieldNFTRecipients: shieldNFTs,
    relayAdaptShieldERC20Addresses,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit:
      recipeOutput.minGasLimit > FXMINT_GAS_FLOOR
        ? recipeOutput.minGasLimit
        : FXMINT_GAS_FLOOR,
  };
};
