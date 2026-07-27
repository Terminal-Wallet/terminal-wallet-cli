/**
 * Closing an f(x) position — the way out.
 *
 * Unwinding is the mirror of opening: the position NFT is unshielded into the
 * batch, fxUSD is unshielded to repay the debt, the pool hands back collateral,
 * and everything left is shielded again. A full close burns the NFT; a partial
 * one keeps it, so the two differ in whether it comes back.
 *
 * How MUCH can be repaid is not a free choice. It is bounded by the fxUSD the
 * wallet holds, less RAILGUN's unshield fee, less the pool's repay fee — and
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
import {
  FX_ADDRESSES,
  FxMintCloseRecipe,
  FxMintPoolRef,
  RecipeERC20Amount,
  RecipeInput,
  computeFxClose,
  getFxPool,
  getFxPosition,
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
import { FXMINT_GAS_FLOOR, isFxSupportedNetwork } from "./mint";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fxmint-close");

export interface FxMintCloseBuild extends CrossContractInputs {
  pool: ReturnType<typeof resolvePool>;
  positionId: bigint;
  /** fxUSD the batch will repay. */
  repayAmount: bigint;
  /** Collateral the pool will release. */
  withdrawColl: bigint;
  /**
   * Whether the position survives. A partial close keeps the NFT and shields it
   * back; a full close burns it, so nothing comes back on the NFT side.
   */
  partialClose: boolean;
}

/**
 * Build a close for a position the wallet holds.
 *
 * `shieldedFxUSD` is what the wallet can put toward the debt. Passing less than
 * the full debt is how a partial close is asked for — the recipe works out the
 * rest, including whether the position survives.
 */
export const getFxMintCloseInputs = async (
  chainName: NetworkName,
  poolRef: FxMintPoolRef,
  positionId: bigint,
  shieldedFxUSD: bigint,
  encryptionKey: string,
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

  // The unshield fee is taken off the fxUSD on the way out, so the repay has to
  // be sized against what actually arrives, not what was sent. Guessing it
  // would size the repay against money that never turns up, and the batch
  // reverts after the proof is paid for.
  const fees = getRailgunFeeBasisPoints(chainName);
  if (!fees) {
    throw new Error(
      `RAILGUN fees are not known for ${chainName} yet — wait for the engine to load.`,
    );
  }
  const amounts = computeFxClose({
    rawColls: position.rawColls,
    rawDebts: position.rawDebts,
    collateralBalance: poolState.collateralBalance,
    totalRawColls: poolState.totalRawColls,
    shieldedFxUSD,
    repayFeeRatio: poolState.repayFeeRatio,
    railgunUnshieldFeeBps: fees.unshield,
  });

  log.debug(
    `close ${positionId} on ${pool.address} as ephemeral [${ephemeralIndex}] ` +
      `${ephemeralAddress}: repay ${amounts.repayAmount}, withdraw ` +
      `${amounts.withdrawColl}, partial=${amounts.partialClose}`,
  );

  if (amounts.repayAmount <= 0n) {
    throw new Error(
      "Not enough shielded fxUSD to repay any of this position's debt.",
    );
  }

  const positionNFT: RailgunNFTAmount = {
    nftAddress: pool.address,
    tokenSubID: `0x${positionId.toString(16)}`,
    nftTokenType: NFTTokenType.ERC721,
    amount: 1n,
  };

  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = [
    {
      tokenAddress: FX_ADDRESSES.fxUSD,
      decimals: 18n,
      amount: shieldedFxUSD,
    },
  ];

  const recipe = new FxMintCloseRecipe({
    pool: poolRef,
    positionId,
    repayAmount: amounts.repayAmount,
    withdrawColl: amounts.withdrawColl,
    approveAmount: amounts.approveAmount,
    partialClose: amounts.partialClose,
  });
  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    // The position has to be IN the batch: `operate` requires the executor to
    // own it, and the executor is a fresh account that holds nothing until the
    // unshield puts it there.
    nfts: [{ ...positionNFT, recipient: railgunAddress }],
  };
  const recipeOutput = await recipe.getRecipeOutput(recipeInput);

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
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts: [positionNFT],
    // A full close burns the position, so the recipe declares no NFT output and
    // this is empty — which is correct, not a gap.
    relayAdaptShieldNFTRecipients: toShieldNFTRecipients(
      recipeOutput.nftRecipients,
    ),
    relayAdaptShieldERC20Addresses,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit:
      recipeOutput.minGasLimit > FXMINT_GAS_FLOOR
        ? recipeOutput.minGasLimit
        : FXMINT_GAS_FLOOR,
  };
};
