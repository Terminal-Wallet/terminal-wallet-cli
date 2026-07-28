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
import {
  getERC20AddressesForChain,
  getERC20Balance,
  getTokenInfo,
  initTokenDatabase,
  tokenDatabase,
} from "./token-util";
import { bigIntToHex, delay } from "../../util/util";
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
  for (const index in addresses) {
    const tokenAddress = addresses[index];
    const cached = publicERC20BalanceCache[chain.type][chain.id][tokenAddress];
    if (cached) {
      const timeElapsed = Date.now() - cached.timestamp;
      if (timeElapsed < CACHE_TIMEOUT && !forceRescan) {
        continue;
      }
    }

    const { decimals } = await getTokenInfo(chainName, tokenAddress);
    const amount = await getERC20Balance(
      chainName,
      tokenAddress,
      public0XAddress,
    );
    publicERC20BalanceCache[chain.type][chain.id][tokenAddress] = {
      timestamp: Date.now(),
      balance: {
        tokenAddress,
        amount: bigIntToHex(amount),
        decimals,
      },
    };
    await delay(500);
  }
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

  for (const erc20Amount of erc20Amounts) {
    const { tokenAddress, amount } = erc20Amount;
    const info = await getTokenInfo(chainName, tokenAddress).catch((err) => {
      return undefined;
    });
    await delay(500);
    if (!info) {
      continue;
    }

    const { decimals } = info;
    privateERC20BalanceCache[chain.type][chain.id][balanceBucket][
      railgunWalletID
    ][tokenAddress] = {
      timestamp: Date.now(),
      balance: { tokenAddress, amount: bigIntToHex(amount), decimals },
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
