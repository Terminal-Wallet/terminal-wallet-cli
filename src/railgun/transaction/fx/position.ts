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
import { FxMintPoolRef, KNOWN_POOLS, resolvePool } from "@railgun-community/cookbook";
import { KnownCollection } from "../../balance/nft-util";
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
 * The pools, as NFT collections.
 *
 * An f(x) pool is an ERC-721 whose tokens are its positions, so a shielded NFT
 * from one of these addresses is a position in that pool and the rail can say
 * so by name.
 */
export const fxPositionCollections = (): KnownCollection[] =>
  KNOWN_POOLS.map((pool) => ({
    address: pool.address,
    name: pool.name,
    kind: "fx-position" as const,
  }));

/**
 * The id the pool will assign to the next position it mints.
 *
 * This is a prediction and it can lose a race: if anyone opens a position
 * between this read and the batch landing, the pool assigns a different id and
 * the batch tries to shield an NFT the executor does not own.
 *
 * Do not assume that unwinds cleanly. The SDK builds both the estimate and the
 * proof with `requireSuccess = false`
 * (`@railgun-community/wallet/dist/services/transactions/tx-cross-contract-calls-7702.js`,
 * the `createActionData` calls), so a relay-adapt batch whose inner work fails
 * still mines: the unshield has already run and the value is at the ephemeral
 * account. Whether a failing NFT shield request reverts the batch or leaves the
 * position there has not been established on a fork, so treat a lost race as
 * possibly stranding rather than as free.
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
