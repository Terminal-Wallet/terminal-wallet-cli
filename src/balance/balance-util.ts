import {
  NETWORK_CONFIG,
  NetworkName,
  RailgunWalletBalanceBucket,
  isDefined,
} from "@railgun-community/shared-models";
import {
  RailgunDisplayBalance,
  RailgunReadableAmount,
} from "../models/balance-models";
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
import { readablePrecision } from "../util/util";
import { stripColors } from "colors";
import configDefaults from "../config/config-defaults";
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

export const getMaxBalanceLength = (
  balances: RailgunDisplayBalance[],
): number => {
  const maxBalanceLengthItem =
    balances.length > 0
      ? balances.reduce((a, c) => {
          return formatUnits(a.amount, a.decimals).length >
            formatUnits(c.amount, c.decimals).length
            ? a
            : c;
        })
      : undefined;

  const maxBalanceLength = isDefined(maxBalanceLengthItem)
    ? formatUnits(maxBalanceLengthItem.amount, maxBalanceLengthItem.decimals)
        .length
    : 0;
  return maxBalanceLength;
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

export const getMaxSymbolLengthFromBalances = (
  balances: RailgunDisplayBalance[],
) => {
  return balances.length > 0
    ? balances.reduce((a, c) => {
        return a.symbol.length > c.symbol.length ? a : c;
      }).symbol.length
    : 0;
};

export const getDisplayStringFromBalance = (
  balance: RailgunDisplayBalance,
  maxBalanceLength: number,
  maxSymbolLength: number,
) => {
  const balanceString = formatUnits(balance.amount, balance.decimals);

  const balanceDisplayString = `${
    balanceString.padEnd(maxBalanceLength, "0").bold
  } | [${balance.symbol.padEnd(maxSymbolLength, " ").cyan}] ${balance.name}`;
  return balanceDisplayString;
};

export const getPrivateDisplayBalances = async (
  chainName: NetworkName,
  bucketType: RailgunWalletBalanceBucket,
) => {
  const CHAIN_NAME = configDefaults.networkConfig[chainName].name.toUpperCase();
  const display: string[] = [];

  const isPrivate = shouldDisplayPrivateBalances();
  const balances = isPrivate
    ? await getPrivateERC20BalancesForChain(chainName, bucketType)
    : await getPublicERC20BalancesForChain(chainName, true);

  if (bucketType !== RailgunWalletBalanceBucket.Spendable) {
    if (balances.length === 0) {
      return "";
    }
    if (!isPrivate) {
      // if not private, only show set of balances once. dont add header.
      return "";
    }
  }
  const balanceType = isPrivate ? "PRIVATE" : "PUBLIC";
  const header = `${CHAIN_NAME.green} ${
    isPrivate ? bucketType.green : ""
  } ${balanceType} BALANCES`;
  const headLen = stripColors(header).length;
  display.push("");
  const headerLine = `${header}`;
  const headerPad = "".padEnd(70 - headLen, "=");
  display.push(`${headerLine} ${headerPad.grey}`);

  if (balances.length === 0) {
    const balanceHeader = walletManager.menuLoaded ? "NO" : "LOADING";
    display.push(`${balanceHeader} Balances...`.grey);
    display.push("".padEnd(70, "=").grey);
    return display.join("\n");
  }

  const maxSymbolLength = getMaxSymbolLengthFromBalances(balances);
  const maxBalanceLength = getMaxBalanceLength(balances);
  for (const bal of balances) {
    const balanceDisplayString = getDisplayStringFromBalance(
      bal,
      maxBalanceLength,
      maxSymbolLength,
    );
    display.push(balanceDisplayString);
  }

  const footer = "".padEnd(70, "=");
  display.push(`${footer.grey}`);
  return display.join("\n");
};
