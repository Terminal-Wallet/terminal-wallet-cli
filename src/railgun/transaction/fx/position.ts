/**
 * f(x) fxMint pools, as the wallet sees them.
 *
 * The id prediction this module used to hand-roll now ships in the cookbook:
 * `getNextPositionId()` is in `FX_POOL_ABI` and `getNextFxPositionId` reads it,
 * so the local ABI fragment is gone and the reader is re-exported under the
 * name the call sites already use.
 */
import { Provider } from "ethers";
import {
  FxMintPoolRef,
  KNOWN_POOLS,
  getNextFxPositionId,
} from "@railgun-community/cookbook";
import { KnownCollection } from "../../balance/nft-util";
import { createLogger } from "../../../platform/logger";

const log = createLogger("fx-position");

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
  const next = await getNextFxPositionId(poolRef, provider);
  log.debug(`pool ${JSON.stringify(poolRef)} will mint position ${next}`);
  return next;
};
