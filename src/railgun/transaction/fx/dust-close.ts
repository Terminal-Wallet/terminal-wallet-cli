/**
 * Closing a position outright when the debt token alone will not cover it.
 *
 * The ordinary close is bounded by the debt token the wallet holds shielded.
 * Short of the full debt it silently becomes a PARTIAL close, leaving a residue
 * that keeps accruing interest. Repeatedly that leaves dust positions nobody
 * finishes off, because the amount still owed is smaller than the effort of
 * working out what to shield.
 *
 * This raises the difference by selling a token the user chooses. The cookbook
 * ships the combo for it — `ZeroXSwap_FxMintClose_ComboMeal` is swap-THEN-close
 * and buys the pool's debt token, the mirror of the close-then-swap combo the
 * ordinary path uses.
 *
 * The user picks WHICH token. The amount is computed here, because that is the
 * part they were being asked to derive from two fee ratios and a swap rate.
 */
import { NetworkName, NFTTokenType, RailgunERC20Recipient, RailgunNFTAmount } from "@railgun-community/shared-models";
import {
  FxMintPoolRef,
  RecipeERC20Amount,
  RecipeERC20Info,
  RecipeInput,
  RecipeOutput,
  ZeroXSwap_FxMintClose_ComboMeal,
  ZeroXV2Quote,
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
import {
  inBatchDebtTokenForFullClose,
  netOfUnshieldFee,
  sellAmountForDebtToken,
} from "./full-close";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fxmint-dust-close");

/**
 * Extra sell size over the probe rate, in basis points.
 *
 * Covers the rate moving between the probe and the real size, and the gap
 * between a quote and the guaranteed fill. Surplus debt token is re-shielded,
 * so erring high costs a little slippage; erring low costs a proof, a
 * broadcaster fee, and a position that is still open.
 */
export const DUST_CLOSE_SELL_BUFFER_BPS = 200n;

export interface FxDustCloseBuild extends CrossContractInputs {
  steps: RecipeOutput["stepOutputs"];
  pool: ReturnType<typeof resolvePool>;
  positionId: bigint;
  /** Token sold to raise the shortfall, and how much of it. */
  soldToken: { tokenAddress: string; decimals: number; amount: bigint };
  /** Debt token the swap guarantees, at worst. */
  guaranteedDebtToken: bigint;
  repayAmount: bigint;
  withdrawColl: bigint;
  /** False when the batch closes outright, which is the whole point. */
  partialClose: boolean;
}

/**
 * Build a full close funded by selling `payWith`.
 *
 * `payWithAvailable` is the shielded balance of that token — used only to probe
 * the swap rate and to refuse early when the position cannot be closed with it.
 */
export const getFxDustCloseInputs = async (
  chainName: NetworkName,
  poolRef: FxMintPoolRef,
  positionId: bigint,
  shieldedDebtToken: bigint,
  payWith: { tokenAddress: string; decimals: number },
  payWithAvailable: bigint,
  encryptionKey: string,
): Promise<FxDustCloseBuild> => {
  if (!isFxSupportedNetwork(chainName)) {
    throw new Error(`f(x) is Ethereum-only; this wallet is on ${chainName}.`);
  }
  const provider = getProviderForChain(chainName);
  const railgunAddress = getCurrentRailgunAddress();
  const pool = resolvePool(poolRef);

  if (payWith.tokenAddress.toLowerCase() === pool.debtToken.toLowerCase()) {
    throw new Error(
      "Paying with the debt token itself needs no swap — use the ordinary close.",
    );
  }
  if (payWith.tokenAddress.toLowerCase() === pool.collateralToken.toLowerCase()) {
    // The combo rejects this pairing too, but only after a quote. Naming the
    // pool here is the difference between "pick something else" and a stack
    // trace out of the cookbook.
    throw new Error(
      `This pool pays out ${pool.collateralToken} on close, so it cannot also ` +
        `be sold to fund the repay. Choose a different token.`,
    );
  }
  if (payWithAvailable <= 0n) {
    throw new Error(`No shielded balance of the chosen token to sell.`);
  }

  await syncEphemeralIndexOnce(chainName, encryptionKey);
  const { address: ephemeralAddress } = await getCurrentEphemeralInfo(
    chainName,
    encryptionKey,
  );
  const [position, poolState] = await Promise.all([
    getFxPosition(positionId, poolRef, provider),
    getFxPool(poolRef, provider),
  ]);
  const fees = getRailgunFeeBasisPoints(chainName);
  if (!fees) {
    throw new Error(
      `RAILGUN fees are not known for ${chainName} yet — wait for the engine to load.`,
    );
  }

  // Everything below is measured INSIDE the batch, after RAILGUN's unshield fee
  // has been taken. The swap's output is already inside, so it pays no such fee.
  const neededInBatch = inBatchDebtTokenForFullClose(
    position.debt,
    poolState.repayFeeRatio,
  );
  // Nothing owed is not the same as "you can already afford it", and saying the
  // latter sends the user to a close that will also refuse. f(x) empties a
  // position rather than destroying it, so a closed one sits here at 0/0 and is
  // a perfectly ordinary thing to select by mistake.
  if (position.debt <= 0n) {
    throw new Error(
      "This position is already empty — nothing is owed, so there is nothing to close.",
    );
  }
  const existingInBatch = netOfUnshieldFee(shieldedDebtToken, fees.unshield);
  const shortfall =
    neededInBatch > existingInBatch ? neededInBatch - existingInBatch : 0n;
  if (shortfall === 0n) {
    throw new Error(
      "The shielded debt token already covers this position — use the ordinary close.",
    );
  }

  const buyERC20Info: RecipeERC20Info = {
    tokenAddress: pool.debtToken,
    decimals: BigInt(pool.debtDecimals),
  };
  const sellERC20Info = {
    tokenAddress: payWith.tokenAddress,
    decimals: BigInt(payWith.decimals),
    isBaseToken: false,
  };

  /** Guaranteed debt token out for a given IN-BATCH sell amount. */
  const guaranteedFor = async (sellInBatch: bigint): Promise<bigint> => {
    const quote = await ZeroXV2Quote.getSwapQuote({
      networkName: chainName,
      sellERC20Amount: {
        tokenAddress: payWith.tokenAddress,
        decimals: BigInt(payWith.decimals),
        amount: sellInBatch,
      },
      buyERC20Info,
      slippageBasisPoints: FXMINT_SWAP_SLIPPAGE_BPS,
      isRailgun: true,
      recipient: ephemeralAddress,
    });
    return quote.minimumBuyAmount;
  };

  // Probe with the whole balance to learn the rate, then size down to what is
  // actually needed. Probing at the full balance rather than a token amount
  // keeps the probe on the same side of the book as the real trade.
  const probeInBatch = netOfUnshieldFee(payWithAvailable, fees.unshield);
  const probeGuaranteed = await guaranteedFor(probeInBatch);
  if (probeGuaranteed < shortfall) {
    throw new Error(
      `Selling the entire shielded balance of that token raises at most ` +
        `${probeGuaranteed} of the debt token, and ${shortfall} is needed to close ` +
        `this position outright. Choose a token with more in it.`,
    );
  }

  let sellInBatch = sellAmountForDebtToken({
    needed: shortfall,
    probeSell: probeInBatch,
    probeGuaranteed,
    bufferBps: DUST_CLOSE_SELL_BUFFER_BPS,
  });
  if (sellInBatch > probeInBatch) sellInBatch = probeInBatch;
  let guaranteed = await guaranteedFor(sellInBatch);
  // One correction, then take the whole balance. A quote that still falls short
  // twice is a market this size cannot be filled in, and looping on it just
  // spends the user's time before failing.
  if (guaranteed < shortfall && sellInBatch < probeInBatch) {
    sellInBatch = probeInBatch;
    guaranteed = probeGuaranteed;
  }
  if (guaranteed < shortfall) {
    throw new Error(
      `The swap guarantees only ${guaranteed} of the debt token against a ` +
        `${shortfall} shortfall. Widen slippage or choose another token.`,
    );
  }

  // Size the close against what is certain to be in the batch. `computeFxClose`
  // is told the unshield fee is zero because both figures are already net of it.
  const amounts = computeFxClose({
    collateral: position.collateralAmount,
    debt: position.debt,
    availableDebtToken: existingInBatch + guaranteed,
    repayFeeRatio: poolState.repayFeeRatio,
    withdrawFeeRatio: poolState.withdrawFeeRatio,
    railgunUnshieldFeeBps: 0n,
  });
  if (amounts.partialClose) {
    // The guard in close-guard.ts exists for partial closes; this path promises
    // a full one, and quietly delivering a partial would be the original bug.
    throw new Error(
      "Sizing did not reach a full close; refusing to build a partial one here.",
    );
  }

  // Gross the sell back up so the unshield delivers the in-batch amount.
  const sellGross =
    (sellInBatch * 10_000n) / (10_000n - BigInt(fees.unshield)) + 1n;
  const sellUnshield = sellGross > payWithAvailable ? payWithAvailable : sellGross;

  log.debug(
    `dust close ${positionId}: shortfall ${shortfall}, selling ${sellUnshield} ` +
      `of ${payWith.tokenAddress} for >= ${guaranteed}, repay ${amounts.repayAmount}`,
  );

  const positionNFT: RailgunNFTAmount = {
    nftAddress: pool.address,
    tokenSubID: `0x${positionId.toString(16)}`,
    nftTokenType: NFTTokenType.ERC721,
    amount: 1n,
  };
  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = [
    {
      tokenAddress: pool.debtToken,
      decimals: pool.debtDecimals,
      amount: shieldedDebtToken,
    },
    {
      tokenAddress: payWith.tokenAddress,
      decimals: BigInt(payWith.decimals),
      amount: sellUnshield,
    },
  ];

  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    nfts: [{ ...positionNFT, recipient: railgunAddress }],
  };
  const recipeOutput = await new ZeroXSwap_FxMintClose_ComboMeal({
    pool: poolRef,
    positionId,
    repayAmount: amounts.repayAmount,
    withdrawColl: amounts.withdrawColl,
    approveAmount: amounts.approveAmount,
    withdrawFeeRatio: poolState.withdrawFeeRatio,
    partialClose: false,
    sellERC20Info,
    swapSlippageBasisPoints: FXMINT_SWAP_SLIPPAGE_BPS,
    recipient: makeEphemeralExecutor(ephemeralAddress, "fxmint dust close"),
  }).getComboMealOutput(recipeInput);

  const relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] =
    recipeOutput.erc20AmountRecipients.map(({ tokenAddress }) => ({
      tokenAddress,
      recipientAddress: railgunAddress,
    }));

  return {
    pool,
    positionId,
    soldToken: {
      tokenAddress: payWith.tokenAddress,
      decimals: payWith.decimals,
      amount: sellUnshield,
    },
    guaranteedDebtToken: guaranteed,
    repayAmount: amounts.repayAmount,
    withdrawColl: amounts.withdrawColl,
    partialClose: false,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts: [positionNFT],
    // A full close declares no NFT output; the NFT still returns as an unspent
    // leftover, because f(x) empties a position rather than destroying it.
    relayAdaptShieldNFTRecipients: toShieldNFTRecipients(recipeOutput.nftRecipients),
    relayAdaptShieldERC20Addresses,
    steps: recipeOutput.stepOutputs,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit:
      recipeOutput.minGasLimit > FXMINT_GAS_FLOOR
        ? recipeOutput.minGasLimit
        : FXMINT_GAS_FLOOR,
  };
};
