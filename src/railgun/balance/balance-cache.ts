import {
  NetworkName,
  RailgunBalancesEvent,
  RailgunNFTAmount,
  RailgunWalletBalanceBucket,
  TXIDVersion,
} from "@railgun-community/shared-models";
import {
  BalanceBucketCacheMap,
  BalanceCacheMap,
} from "../../models/balance-models";
import { ERC20Token } from "../../models/token-models";
import { mapLimited } from "../../util/concurrency";
import {
  getERC20AddressesForChain,
  getERC20Balance,
  getTokenInfo,
  initTokenDatabase,
  tokenDatabase,
} from "./token-util";
import { bigIntToHex } from "../../util/util";
import { TokenDatabaseMap } from "../../models/token-models";
import { getChainForName } from "../network/network-util";
import { getCurrentEthersWallet } from "../wallet/public-utils";
import { ChainIDToNameMap } from "../../models/network-models";
import { getCurrentRailgunID } from "../wallet/wallet-util";

const CACHE_TIMEOUT = 10 * 1000; // 5 minutes;

export const publicERC20BalanceCache: BalanceCacheMap = {};
export const privateERC20BalanceCache: BalanceBucketCacheMap = {};

/**
 * Shielded NFTs, keyed chain.type > chain.id > walletID > collection:tokenID.
 *
 * The engine has reported these on every balance event all along; the wallet
 * destructured the event and dropped them, which is why it could not say what
 * positions it held. Not bucketed like the ERC20 cache: an NFT is one
 * indivisible thing, and the question asked of it is "do I hold it", not "how
 * much of it is spendable".
 */
export const privateNFTCache: NumMapType<
  NumMapType<MapType<MapType<MapType<MapType<RailgunNFTAmount>>>>>
> = {};

/** An NFT's identity — a collection plus a token id within it. */
/**
 * How many token-metadata reads run at once.
 *
 * Each miss is three sequential contract calls, so this is the real RPC
 * pressure — kept low because it replaces a deliberate throttle.
 */
const TOKEN_INFO_CONCURRENCY = 4;

export const nftKey = (nft: RailgunNFTAmount): string =>
  `${nft.nftAddress.toLowerCase()}:${BigInt(nft.tokenSubID).toString()}`;

//not currently used
export const getBalanceCaches = () => {
  return {
    publicERC20BalanceCache,
    privateERC20BalanceCache,
    tokenDatabase,
  };
};

export const loadTokenDBCache = (tokenDBCache: TokenDatabaseMap) => {
  const dbTypes = Object.keys(tokenDBCache);
  dbTypes?.forEach((_type) => {
    const type = parseInt(_type);
    const chainIDs = Object.keys(tokenDBCache[type]);
    chainIDs?.forEach((_id) => {
      const id = parseInt(_id);
      const chainName = ChainIDToNameMap[id];
      initTokenDatabase(chainName);
      tokenDatabase[type][id] = tokenDBCache[type][id];
    });
  });
};

//not currently used
// export const loadBalanceCaches = (
//   publicCache: BalanceCacheMap,
//   privateCache: BalanceCacheMap,
// ) => {
//   const pubTypes = Object.keys(publicCache);
//   pubTypes?.forEach((_type) => {
//     const type = parseInt(_type);
//     const chainIDs = Object.keys(publicCache[type]);
//     chainIDs?.forEach((_id) => {
//       const id = parseInt(_id);
//       publicERC20BalanceCache[type][id] = publicCache[type][id];
//     });
//   });
//   const privTypes = Object.keys(privateCache);
//   privTypes?.forEach((_type) => {
//     const type = parseInt(_type);
//     const chainIDs = Object.keys(privateCache[type]);
//     chainIDs?.forEach((_id) => {
//       const id = parseInt(_id);
//       privateERC20BalanceCache[type][id] = privateCache[type][id];
//     });
//   });
// };

export const initPublicBalanceCachesForChain = (chainName: NetworkName) => {
  const chain = getChainForName(chainName);
  initTokenDatabase(chainName);

  publicERC20BalanceCache[chain.type] ??= {};
  publicERC20BalanceCache[chain.type][chain.id] ??= {};
};

export const initPrivateBalanceCachesForChain = (
  chainName: NetworkName,
  balanceBucket: RailgunWalletBalanceBucket = RailgunWalletBalanceBucket.Spendable,
  railgunWalletID: string,
  txidVersion: string = TXIDVersion.V2_PoseidonMerkle,
) => {
  const chain = getChainForName(chainName);
  privateERC20BalanceCache[chain.type] ??= {};
  privateERC20BalanceCache[chain.type][chain.id] ??= {};
  privateERC20BalanceCache[chain.type][chain.id][balanceBucket] ??= {};
  privateERC20BalanceCache[chain.type][chain.id][balanceBucket][
    railgunWalletID
  ] ??= {};
  privateNFTCache[chain.type] ??= {};
  privateNFTCache[chain.type][chain.id] ??= {};
  privateNFTCache[chain.type][chain.id][txidVersion] ??= {};
  privateNFTCache[chain.type][chain.id][txidVersion][balanceBucket] ??= {};
  privateNFTCache[chain.type][chain.id][txidVersion][balanceBucket][railgunWalletID] ??= {};
};

export const resetPublicBalanceCachesForChain = (chainName: NetworkName) => {
  const chain = getChainForName(chainName);
  publicERC20BalanceCache[chain.type] = {};
  publicERC20BalanceCache[chain.type][chain.id] = {};
};

export const resetPrivateBalanceCachesForChain = (chainName: NetworkName) => {
  const chain = getChainForName(chainName);
  privateERC20BalanceCache[chain.type] = {};
  privateERC20BalanceCache[chain.type][chain.id] = {};
  privateNFTCache[chain.type] = {};
  privateNFTCache[chain.type][chain.id] = {};
};

/**
 * The shielded NFTs this wallet holds on a chain, across every txid version and
 * bucket.
 *
 * Unioned rather than read from V2/Spendable alone: the wallet's holdings are
 * the sum of what each txid version reports, and a position that has been
 * shielded but has not finished maturing is held — showing nothing until it
 * clears hides a position the wallet owns. Deduped by collection:id, so the
 * same position seen under two versions or two buckets is still one position.
 */
export const getPrivateNFTsForChain = (
  chainName: NetworkName,
  railgunWalletID: string = getCurrentRailgunID(),
): RailgunNFTAmount[] => {
  const chain = getChainForName(chainName);
  const byVersion = privateNFTCache[chain.type]?.[chain.id];
  if (!byVersion) return [];
  const merged: MapType<RailgunNFTAmount> = {};
  for (const version of Object.keys(byVersion)) {
    const byBucket = byVersion[version];
    if (!byBucket) continue;
    for (const bucket of Object.keys(byBucket)) {
      const owned = byBucket[bucket]?.[railgunWalletID];
      if (!owned) continue;
      for (const key of Object.keys(owned)) merged[key] = owned[key];
    }
  }
  return Object.values(merged);
};

/**
 * Which bucket each held NFT sits in, keyed the same way as the cache.
 *
 * `getPrivateNFTsForChain` unions the buckets so a maturing position is still
 * listed — correct, and it necessarily discards WHICH bucket each came from.
 * That is the difference between "you hold this" and "you can spend this", and
 * without it a spend fails inside the engine with a message about an empty
 * balance. Returned separately rather than folded into the union so that
 * function keeps its single meaning.
 *
 * A note can appear under both txid versions; every bucket it is seen in is
 * collected, and the caller resolves them with `bestAvailability`.
 */
export const getPrivateNFTBucketsForChain = (
  chainName: NetworkName,
  railgunWalletID: string = getCurrentRailgunID(),
): MapType<string[]> => {
  const chain = getChainForName(chainName);
  const byVersion = privateNFTCache[chain.type]?.[chain.id];
  const buckets: MapType<string[]> = {};
  if (!byVersion) return buckets;
  for (const version of Object.keys(byVersion)) {
    const byBucket = byVersion[version];
    if (!byBucket) continue;
    for (const bucket of Object.keys(byBucket)) {
      const owned = byBucket[bucket]?.[railgunWalletID];
      if (!owned) continue;
      for (const key of Object.keys(owned)) {
        (buckets[key] ??= []).push(bucket);
      }
    }
  }
  return buckets;
};

export const resetBalanceCachesForChain = (chainName: NetworkName) => {
  // No need to do this anymore with new upgrades?
  // Balances stored by chain.type > chain.id > BalanceBucket > walletID > tokenaddress
  // resetPrivateBalanceCachesForChain(chainName);
  resetPublicBalanceCachesForChain(chainName);
};

export const updatePublicBalancesForChain = async (
  chainName: NetworkName,
  forceRescan = false,
): Promise<void> => {
  const chain = getChainForName(chainName);
  const public0XAddress = getCurrentEthersWallet().address;
  initPublicBalanceCachesForChain(chainName);
  const addresses = getERC20AddressesForChain(chainName);
  const stale = addresses.filter((tokenAddress) => {
    const cached = publicERC20BalanceCache[chain.type][chain.id][tokenAddress];
    if (!cached || forceRescan) return true;
    return Date.now() - cached.timestamp >= CACHE_TIMEOUT;
  });

  // Concurrent and fault-tolerant, for the same two reasons the private side
  // is. `getTokenInfo` was called bare here, so ONE token in the curated list
  // whose metadata could not be read threw and abandoned every token after it
  // in the loop — and the sleep ran per token on a list that is walked again
  // for every balance bucket.
  await mapLimited(stale, TOKEN_INFO_CONCURRENCY, async (tokenAddress: string) => {
    const info = await getTokenInfo(chainName, tokenAddress).catch(() => undefined);
    // Public balances are a display figure, and one shown under guessed
    // decimals is wrong rather than merely missing — so an unreadable token is
    // left out here and picked up whenever its metadata resolves.
    if (!info) return;
    const amount = await getERC20Balance(chainName, tokenAddress, public0XAddress);
    publicERC20BalanceCache[chain.type][chain.id][tokenAddress] = {
      timestamp: Date.now(),
      balance: {
        tokenAddress,
        amount: bigIntToHex(amount),
        decimals: info.decimals,
      },
    };
  });
};

export const updatePrivateBalancesForChain = async (
  chainName: NetworkName,
  erc20Balances: RailgunBalancesEvent,
): Promise<void> => {
  const chain = getChainForName(chainName);

  const { erc20Amounts, nftAmounts, balanceBucket, railgunWalletID, txidVersion } =
    erc20Balances;
  // Defaulted rather than required: an event without one is treated as V2, so a
  // caller that predates this keeps the behaviour it had.
  const version = txidVersion ?? TXIDVersion.V2_PoseidonMerkle;
  initPrivateBalanceCachesForChain(
    chainName,
    balanceBucket,
    railgunWalletID,
    version,
  );

  // Replacement rather than a merge, so an NFT spent since the last event
  // disappears instead of lingering as a position the wallet no longer holds.
  //
  // Scoped to the (TXID VERSION, BUCKET) the event is describing, which is the
  // whole point. `ACTIVE_TXID_VERSIONS` is [V2, V3] and the engine runs a full
  // per-bucket emission for EACH, so an event's identity is both fields — and
  // any coarser key lets one event speak for another's funds.
  //
  // Both halves of that bit. Keyed on neither, a position appeared when
  // Spendable landed and vanished when any other bucket arrived without NFTs.
  // Keyed on bucket alone, a wallet that has only ever transacted on V2 still
  // receives V3 events carrying an empty set, and that emptiness erased what V2
  // had just reported. ERC20 balances survived the same collision only because
  // they are written per token address — a merge — while the NFT set is written
  // as a whole map.
  if (nftAmounts) {
    const owned: MapType<RailgunNFTAmount> = {};
    for (const nft of nftAmounts) {
      if (nft.amount > 0n) owned[nftKey(nft)] = nft;
    }
    privateNFTCache[chain.type][chain.id][version][balanceBucket][railgunWalletID] =
      owned;
  }

  // Resolve each DISTINCT token once, concurrently.
  //
  // This was a sequential loop with a fixed 500ms sleep per token — applied
  // before the result was even checked, so it slept just as long when the
  // metadata came from the local database and no RPC happened at all. With
  // seven buckets across two txid versions that is the same handful of tokens
  // looked at fourteen times over, and a wallet holding six of them spent
  // roughly half a minute asleep before `balances:refreshed` was emitted. The
  // deck's only automatic re-read is on that event, which is why the rail sat
  // half-empty until it was poked by hand.
  //
  // The sleep was rate-limit protection. A bounded pool is the same protection
  // expressed as a ceiling rather than as a wait, and `getTokenInfo` caches
  // into a persisted database, so the second bucket onward costs nothing.
  const resolved = new Map<string, ERC20Token | undefined>();
  const distinct = [...new Set(erc20Amounts.map((a) => a.tokenAddress))];
  await mapLimited(distinct, TOKEN_INFO_CONCURRENCY, async (tokenAddress: string) => {
    resolved.set(
      tokenAddress,
      await getTokenInfo(chainName, tokenAddress).catch(() => undefined),
    );
  });

  for (const erc20Amount of erc20Amounts) {
    const { tokenAddress, amount } = erc20Amount;
    const info = resolved.get(tokenAddress);
    // Recorded either way. A token whose symbol could not be read is still a
    // token the wallet holds, and dropping it — which is what used to happen —
    // took the balance off the portfolio entirely rather than showing it as
    // unnamed. `decimals` is a placeholder when unresolved and the read side
    // refuses to format an amount with it.
    privateERC20BalanceCache[chain.type][chain.id][balanceBucket][
      railgunWalletID
    ][tokenAddress] = {
      timestamp: Date.now(),
      balance: {
        tokenAddress,
        amount: bigIntToHex(amount),
        decimals: info?.decimals ?? 18,
      },
      ...(info ? {} : { unresolved: true }),
    };
  }
};

export const getPrivateERC20BalanceForChain = (
  chainName: NetworkName,
  tokenAddress: string,
  balanceBucket: RailgunWalletBalanceBucket = RailgunWalletBalanceBucket.Spendable,
): bigint => {
  const chain = getChainForName(chainName);
  initPrivateBalanceCachesForChain(
    chainName,
    balanceBucket,
    getCurrentRailgunID(),
  );

  const token =
    privateERC20BalanceCache[chain.type][chain.id][balanceBucket][
      getCurrentRailgunID()
    ][tokenAddress];
  if (token) {
    return BigInt(token.balance.amount);
  }
  return 0n;
};

// not currently used.
export const getPublicERC20BalanceForChain = async (
  chainName: NetworkName,
  tokenAddress: string,
  public0XAddress: string,
): Promise<bigint> => {
  const chain = getChainForName(chainName);
  initPublicBalanceCachesForChain(chainName);

  const token = publicERC20BalanceCache[chain.type][chain.id][tokenAddress];
  if (token) {
    const timeElapsed = Date.now() - token.timestamp;
    if (timeElapsed > CACHE_TIMEOUT) {
      await updatePublicBalancesForChain(chainName);
      const newToken =
        publicERC20BalanceCache[chain.type][chain.id][tokenAddress];
      if (newToken) {
        return BigInt(newToken.balance.amount);
      }
    } else {
      return BigInt(token.balance.amount);
    }
  }
  return 0n;
};
