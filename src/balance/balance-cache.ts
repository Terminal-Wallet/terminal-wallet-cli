import {
  NetworkName,
  RailgunBalancesEvent,
} from "@railgun-community/shared-models";
import { BalanceCacheMap } from "../models/balance-models";
import {
  getERC20AddressesForChain,
  getERC20Balance,
  getTokenInfo,
  initTokenDatabase,
  tokenDatabase,
} from "./token-util";
import { bigIntToHex, delay } from "../util/util";
import { TokenDatabaseMap } from "../models/token-models";
import { getChainForName } from "../network/network-util";
import { getCurrentEthersWallet } from "../wallet/public-utils";
import { ChainIDToNameMap } from "../models/network-models";

const CACHE_TIMEOUT = 10 * 1000; // 5 minutes;

export const publicERC20BalanceCache: BalanceCacheMap = {};
export const privateERC20BalanceCache: BalanceCacheMap = {};

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
export const loadBalanceCaches = (
  publicCache: BalanceCacheMap,
  privateCache: BalanceCacheMap,
) => {
  const pubTypes = Object.keys(publicCache);
  pubTypes?.forEach((_type) => {
    const type = parseInt(_type);
    const chainIDs = Object.keys(publicCache[type]);
    chainIDs?.forEach((_id) => {
      const id = parseInt(_id);
      publicERC20BalanceCache[type][id] = publicCache[type][id];
    });
  });
  const privTypes = Object.keys(privateCache);
  privTypes?.forEach((_type) => {
    const type = parseInt(_type);
    const chainIDs = Object.keys(privateCache[type]);
    chainIDs?.forEach((_id) => {
      const id = parseInt(_id);
      privateERC20BalanceCache[type][id] = privateCache[type][id];
    });
  });
};

export const initPublicBalanceCachesForChain = (chainName: NetworkName) => {
  const chain = getChainForName(chainName);
  initTokenDatabase(chainName);

  publicERC20BalanceCache[chain.type] ??= {};
  publicERC20BalanceCache[chain.type][chain.id] ??= {};
};

export const initPrivateBalanceCachesForChain = (chainName: NetworkName) => {
  const chain = getChainForName(chainName);
  privateERC20BalanceCache[chain.type] ??= {};
  privateERC20BalanceCache[chain.type][chain.id] ??= {};
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
};

export const resetBalanceCachesForChain = (chainName: NetworkName) => {
  resetPrivateBalanceCachesForChain(chainName);
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
  initPrivateBalanceCachesForChain(chainName);

  const { erc20Amounts /*nftAmounts*/ } = erc20Balances;

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
    privateERC20BalanceCache[chain.type][chain.id][tokenAddress] = {
      timestamp: Date.now(),
      balance: { tokenAddress, amount: bigIntToHex(amount), decimals },
    };
  }
};

export const getPrivateERC20BalanceForChain = (
  chainName: NetworkName,
  tokenAddress: string,
): bigint => {
  const chain = getChainForName(chainName);
  initPrivateBalanceCachesForChain(chainName);

  const token = privateERC20BalanceCache[chain.type][chain.id][tokenAddress];
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
