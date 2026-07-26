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
import {
  getCurrentRailgunID,
  getCurrentWalletGasBalance,
  shouldDisplayPrivateBalances,
} from "../wallet/wallet-util";
import { readablePrecision } from "../../util/util";
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

/** A display balance tagged with the POI bucket the amount currently sits in. */
export interface BucketBalance extends RailgunDisplayBalance {
  bucket: RailgunWalletBalanceBucket;
}

/**
 * All private balances for the current wallet, summed across EVERY balance
 * bucket (Spendable + ShieldPending + the POI-pending buckets), excluding Spent.
 * For DISPLAY only: a freshly-shielded or POI-pending balance lives in a
 * non-Spendable bucket and would otherwise be invisible in the portfolio.
 * Sending still uses the Spendable-only getPrivateERC20BalancesForChain.
 */
export const getAllPrivateERC20BalancesForChain = async (
  chainName: NetworkName,
): Promise<RailgunDisplayBalance[]> => {
  const chain = getChainForName(chainName);
  const byChain = privateERC20BalanceCache[chain.type]?.[chain.id];
  if (!byChain) return [];
  const walletID = getCurrentRailgunID();

  const totals: Record<string, bigint> = {};
  for (const bucket of Object.keys(byChain)) {
    if (bucket === RailgunWalletBalanceBucket.Spent) continue;
    const cache = byChain[bucket]?.[walletID];
    if (!cache) continue;
    for (const tokenAddress of Object.keys(cache)) {
      totals[tokenAddress] =
        (totals[tokenAddress] ?? 0n) + BigInt(cache[tokenAddress].balance.amount);
    }
  }

  const balances: RailgunDisplayBalance[] = [];
  for (const tokenAddress of Object.keys(totals)) {
    if (totals[tokenAddress] <= 0n) continue;
    const { name, symbol, decimals } = await getTokenInfo(chainName, tokenAddress);
    balances.push({ tokenAddress, amount: totals[tokenAddress], decimals, name, symbol });
  }
  return balances;
};

/**
 * Private balances for the current wallet, split per (token, bucket) so the UI
 * can show which funds are Spendable vs still pending (ShieldPending / POI).
 * One entry per (token, bucket) with a positive amount; Spent is excluded.
 * For DISPLAY only — sending still uses the Spendable-only getter above.
 */
export const getPrivateBalancesByBucketForChain = async (
  chainName: NetworkName,
): Promise<BucketBalance[]> => {
  const chain = getChainForName(chainName);
  const byChain = privateERC20BalanceCache[chain.type]?.[chain.id];
  if (!byChain) return [];
  const walletID = getCurrentRailgunID();

  const rows: BucketBalance[] = [];
  for (const bucket of Object.keys(byChain)) {
    if (bucket === RailgunWalletBalanceBucket.Spent) continue;
    const cache = byChain[bucket]?.[walletID];
    if (!cache) continue;
    for (const tokenAddress of Object.keys(cache)) {
      const amount = BigInt(cache[tokenAddress].balance.amount);
      if (amount <= 0n) continue;
      const { name, symbol, decimals } = await getTokenInfo(
        chainName,
        tokenAddress,
      );
      rows.push({
        tokenAddress,
        amount,
        decimals,
        name,
        symbol,
        bucket: bucket as RailgunWalletBalanceBucket,
      });
    }
  }
  return rows;
};
