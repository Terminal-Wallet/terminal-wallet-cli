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
  RecipeInput,
  getFxPool,
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
import { getNextPositionId } from "./position";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fxmint");

/** f(x) is deployed on Ethereum only; every recipe rejects other networks. */
export const isFxSupportedNetwork = (chainName: NetworkName): boolean =>
  chainName === NetworkName.Ethereum;

/**
 * The gas floor an fx batch runs with.
 *
 * The recipes' own `MIN_GAS_LIMIT_FXMINT_*` are carried over from a pre-7702
 * version and have never been measured under a relay-adapt batch — the local
 * build's own notes say to expect them to be wrong. The wallet has measured a
 * private swap at ~2.52M and floors it at 2.6M, so an fx batch, which does
 * strictly more, is held to the same floor rather than the recipe's 1.5M.
 *
 * Over-flooring costs headroom; under-flooring reverts after the proof is paid
 * for. Until these are measured on a real batch, take the headroom.
 */
export const FXMINT_GAS_FLOOR = 2_700_000n;

export interface FxMintOpenBuild extends CrossContractInputs {
  pool: ReturnType<typeof resolvePool>;
  /** The id the batch expects the pool to mint. */
  positionId: bigint;
  collateral: { tokenAddress: string; decimals: number; amount: bigint };
  /** fxUSD the position will owe, before the pool's borrow fee. */
  targetDebt: bigint;
  borrowFeeRatio: bigint;
}

/**
 * Build "open a position": deposit collateral, mint `targetDebt` of fxUSD, and
 * shield both the fxUSD and the position NFT back to this wallet.
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

  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = [
    {
      tokenAddress: pool.collateralToken,
      decimals: pool.collateralDecimals,
      amount: collateralAmount,
    },
  ];

  const recipe = new FxMintOpenRecipe({
    pool: poolRef,
    targetDebt,
    predictedPositionId: positionId,
    borrowFeeRatio,
  });
  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    nfts: [],
  };
  const recipeOutput = await recipe.getRecipeOutput(recipeInput);

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
      tokenAddress: pool.collateralToken,
      decimals: Number(pool.collateralDecimals),
      amount: collateralAmount,
    },
    targetDebt,
    borrowFeeRatio,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    // Opening mints the position rather than spending one, so nothing is
    // unshielded on the NFT side.
    relayAdaptUnshieldNFTAmounts: [] as RailgunNFTAmount[],
    relayAdaptShieldNFTRecipients,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit:
      recipeOutput.minGasLimit > FXMINT_GAS_FLOOR
        ? recipeOutput.minGasLimit
        : FXMINT_GAS_FLOOR,
  };
};
