import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { ERC20Token, TokenDatabaseMap } from "../models/token-models";
import { Contract } from "ethers";
import { ERC20_ABI } from "../abi";
import {
  getChainForName,
  getProviderForChain,
  getWrappedTokenInfoForChain,
} from "../network/network-util";
import configDefaults from "../config/config-defaults";
import { walletManager } from "../wallet/wallet-manager";
import { saveKeychainFile } from "../wallet/wallet-cache";

const ZERO_X_PROXY_BASE_TOKEN_ADDRESS =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

export type TokenChainInfo = {
  tokenAddress: string;
  name: string;
  decimals: number;
  symbol: string;
};
export const tokenDatabase: TokenDatabaseMap = {};
export const initTokenDatabase = (chainName: NetworkName) => {
  const chain = getChainForName(chainName);
  tokenDatabase[chain.type] ??= {};
  tokenDatabase[chain.type][chain.id] ??= {};
};

export const updateCachedTokenData = () => {
  if (walletManager.keyChain) {
    walletManager.keyChain.cachedTokenInfo = tokenDatabase;
    const { keyChainPath } = configDefaults.engine;
    saveKeychainFile(walletManager.keyChain, keyChainPath);
  }
};

export const getERC20AddressesForChain = (chainName: NetworkName): string[] => {
  const chain = getChainForName(chainName);
  const defaultAddresses = configDefaults.tokenConfig[chainName].map(
    (address) => address.toLowerCase(),
  );
  const addresses = Object.keys(tokenDatabase[chain.type][chain.id]).filter(
    (address: string) => {
      return defaultAddresses.includes(address.toLowerCase()) === false;
    },
  );
  const fAddresses = addresses.map((faddress) => faddress.toLowerCase());
  const addressList = [...defaultAddresses, ...fAddresses];
  if (addressList.length > 0) {
    return addressList;
  }
  return [];
};

export const getInfoContract = async (
  tokenAddress: string,
  provider: any,
): Promise<ERC20Token> => {
  const contract = new Contract(
    tokenAddress,
    [
      "function symbol() view returns (string)",
      "function name() view returns (string)",
      "function decimals() view returns (uint8)",
    ],
    provider,
  );
  const decimals: bigint = await contract.decimals();
  const symbol: string = await contract.symbol();
  const name: string = await contract.name();
  return { decimals: parseInt(decimals.toString(10)), symbol, name };
};

export const getTokenInfo = async (
  chainName: NetworkName,
  tokenAddress: string,
): Promise<ERC20Token> => {
  const chain = getChainForName(chainName);
  initTokenDatabase(chainName);
  const token = tokenDatabase[chain.type][chain.id][tokenAddress];
  if (token) {
    return token;
  }

  if (tokenAddress.toLowerCase() === ZERO_X_PROXY_BASE_TOKEN_ADDRESS) {
    const wrappedInfo = getWrappedTokenInfoForChain(chainName);
    const wrappedInsert = {
      name: wrappedInfo.shortPublicName,
      symbol: wrappedInfo.symbol,
      decimals: wrappedInfo.decimals,
    };
    tokenDatabase[chain.type][chain.id][tokenAddress] = wrappedInsert;
    return wrappedInsert;
  }
  const provider = getProviderForChain(chainName);
  const result = await getInfoContract(tokenAddress, provider).catch((err) => {
    return undefined;
  });
  if (result) {
    tokenDatabase[chain.type][chain.id][tokenAddress] = result;
    updateCachedTokenData();
    return result;
  }
  throw new Error(`Token Address: ${tokenAddress} is not in tokenDatabase`);
};

export const getERC20TokenInfosForChain = async (chainName: NetworkName) => {
  const addresses = getERC20AddressesForChain(chainName);
  const tokenInfos: TokenChainInfo[] = [];
  for (let index = 0; index < addresses.length; index++) {
    const tokenAddress = addresses[index];
    const tokenInfo = await getTokenInfo(chainName, tokenAddress);
    if (tokenInfo.symbol != getWrappedTokenInfoForChain(chainName).symbol) {
      tokenInfos.push({
        tokenAddress,
        ...tokenInfo,
      });
    }
  }
  return tokenInfos;
};

export const getERC20Balance = async (
  chainName: NetworkName,
  tokenAddress: string,
  ownerAddress: string,
): Promise<bigint> => {
  const provider = getProviderForChain(chainName) as unknown as any;
  const contract = new Contract(tokenAddress, ERC20_ABI, provider);
  const balance = await contract.balanceOf(ownerAddress).catch((err) => {
    return undefined;
  });
  if (isDefined(balance)) {
    return balance;
  }
  return 0n;
};
