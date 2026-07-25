import {
  NETWORK_CONFIG,
  NetworkName,
  RailgunWalletBalanceBucket,
  isDefined,
} from "@railgun-community/shared-models";
import {
  RailgunDisplayBalance,
  RailgunReadableAmount,
} from "../../models/balance-models";
import {
  getPrivateERC20BalanceForChain,
  initPrivateBalanceCachesForChain,
  initPublicBalanceCachesForChain,
  privateERC20BalanceCache,
  publicERC20BalanceCache,
} from "./balance-cache";
import {
  getChainForName,
  getWrappedTokenInfoForChain,
} from "../network/network-util";
import { getTokenInfo } from "./token-util";
import { formatUnits } from "ethers";
import "colors";
import {
  getCurrentRailgunID,
  getCurrentWalletGasBalance,
  shouldDisplayPrivateBalances,
} from "../wallet/wallet-util";
import { readablePrecision } from "../../util/util";
import { stripColors } from "colors";
import configDefaults from "../../config/config-defaults";
import { walletManager } from "../wallet/wallet-manager";

export const getWrappedTokenBalance = async (
  chainName: NetworkName,
  useGasBalance = false,
) => {
  const wrappedInfo = getWrappedTokenInfoForChain(chainName);

  const { name } = await getTokenInfo(chainName, wrappedInfo.wrappedAddress);

  const wrappedBalance = useGasBalance
    ? await getCurrentWalletGasBalance()
    : getPrivateERC20BalanceForChain(chainName, wrappedInfo.wrappedAddress);
  const wrappedDecimals = NETWORK_CONFIG[chainName].baseToken.decimals;
  const wrappedReadableAmount: RailgunReadableAmount = {
    symbol: useGasBalance ? wrappedInfo.symbol : wrappedInfo.wrappedSymbol,
    name,
    tokenAddress: wrappedInfo.wrappedAddress,
    amount: wrappedBalance,
    amountReadable: readablePrecision(wrappedBalance, wrappedDecimals, 8),
    decimals: wrappedDecimals,
  };
  return wrappedReadableAmount;
};


export const getPublicERC20BalancesForChain = async (
  chainName: NetworkName,
  showBaseBalance = false,
): Promise<RailgunDisplayBalance[]> => {
  const chain = getChainForName(chainName);
  initPublicBalanceCachesForChain(chainName);
  const cache = publicERC20BalanceCache[chain.type][chain.id];
  if (!cache) {
    return [];
  }
  const erc20Addresses = Object.keys(cache);
  const balances: RailgunDisplayBalance[] = [];
  erc20Addresses.map(async (tokenAddress) => {
    const { name, symbol, decimals } = await getTokenInfo(
      chainName,
      tokenAddress,
    );
    const { amount } = cache[tokenAddress].balance;
    const bigIntAmount = BigInt(amount);

    if (bigIntAmount > 0n) {
      balances.push({
        tokenAddress,
        amount: bigIntAmount,
        decimals,
        name,
        symbol,
      });
    }
  });

  if (showBaseBalance) {
    const wrappedReadableAmount = (await getWrappedTokenBalance(
      chainName,
      true,
    )) as RailgunDisplayBalance;
    wrappedReadableAmount.name = wrappedReadableAmount.name.replace(
      "Wrapped ",
      "",
    );
    const balancesWithBase = [wrappedReadableAmount, ...balances];
    return balancesWithBase;
  }

  return balances;
};

export const getPrivateERC20BalancesForChain = (
  chainName: NetworkName,
  balanceBucket: RailgunWalletBalanceBucket = RailgunWalletBalanceBucket.Spendable,
): RailgunDisplayBalance[] => {
  const chain = getChainForName(chainName);
  initPrivateBalanceCachesForChain(
    chainName,
    balanceBucket,
    getCurrentRailgunID(),
  );
  const cache =
    privateERC20BalanceCache[chain.type][chain.id][balanceBucket][
      getCurrentRailgunID()
    ];
  if (!cache) {
    return [];
  }
  const erc20Addresses = Object.keys(cache);
  const balances: RailgunDisplayBalance[] = [];
  erc20Addresses.map(async (tokenAddress) => {
    const { name, symbol, decimals } = await getTokenInfo(
      chainName,
      tokenAddress,
    );
    const { amount } = cache[tokenAddress].balance;
    const bigIntAmount = BigInt(amount);
    if (bigIntAmount > 0n) {
      balances.push({
        tokenAddress,
        amount: bigIntAmount,
        decimals,
        name,
        symbol,
      });
    }
  });

  return balances;
};



