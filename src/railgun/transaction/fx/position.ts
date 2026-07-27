/**
 * Reading f(x) fxMint pool state the cookbook does not expose.
 *
 * The cookbook reads pools and existing positions, but it cannot tell you the id
 * a NEW position is about to get — `FxMintOpenRecipe` requires
 * `predictedPositionId` up front and bakes it into the NFT the batch shields,
 * and the ABI the cookbook ships has no counter. The pools do expose one.
 *
 * This belongs upstream: adding `getNextPositionId()` to the cookbook's
 * `FX_POOL_ABI` would let `getFxPool` return it with the rest of the pool state
 * and reduce this module to a re-export.
 */
import { Provider, Contract } from "ethers";
import { FxMintPoolRef, resolvePool } from "@railgun-community/cookbook";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fx-position");

/**
 * Verified against mainnet on both pools: this returns the id the next mint
 * will be assigned, not a count. The wstETH-Long pool reported 1981 while
 * `ownerOf(1980)` resolved to a holder and `ownerOf(1981)` reverted, so the
 * value is used as-is with no adjustment.
 */
const FX_NEXT_POSITION_ID_ABI = [
  "function getNextPositionId() view returns (uint256)",
];

/**
 * The id the pool will assign to the next position it mints.
 *
 * This is a prediction and it can lose a race: if anyone opens a position
 * between this read and the batch landing, the id moves and the batch tries to
 * shield an NFT the executor does not own. That reverts the whole batch rather
 * than stranding anything — collateral and debt unwind together — so losing the
 * race costs gas, not funds.
 */
export const getNextPositionId = async (
  poolRef: FxMintPoolRef,
  provider: Provider,
): Promise<bigint> => {
  const { address } = resolvePool(poolRef);
  const contract = new Contract(address, FX_NEXT_POSITION_ID_ABI, provider);
  const next: bigint = await contract.getNextPositionId();
  log.debug(`pool ${address} will mint position ${next}`);
  return next;
};
