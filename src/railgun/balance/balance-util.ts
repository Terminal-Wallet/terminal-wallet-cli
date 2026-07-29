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

/** An address, shortened, for a token whose symbol could not be read. */
const short = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
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
  // Awaited. This was `.map(async …)` with nothing awaiting the array it
  // returned, so the list was empty at `return` and filled some ticks later —
  // whether a caller saw a token depended on how many microtasks happened to
  // have run by the time it looked. See the note on the private reader below.
  for (const tokenAddress of erc20Addresses) {
    const bigIntAmount = BigInt(cache[tokenAddress].balance.amount);
    if (bigIntAmount <= 0n) continue;
    const info = await getTokenInfo(chainName, tokenAddress).catch(
      () => undefined,
    );
    if (!info) continue;
    balances.push({
      tokenAddress,
      amount: bigIntAmount,
      decimals: info.decimals,
      name: info.name,
      symbol: info.symbol,
    });
  }

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

/**
 * Spendable private balances — the list every send flow spends from.
 *
 * It was declared synchronous and built its result inside `.map(async …)` with
 * nothing awaiting it, so the array it returned was EMPTY at the moment it
 * returned and filled some microtasks later. Callers that happened to await
 * something afterwards saw a full list; callers that read `.length` straight
 * away saw nothing. That is why a wallet with funds could report no spendable
 * tokens, and why the fee gate — whose default balance source is this function
 * — could not find the fee token and passed a transaction it should have
 * refused.
 *
 * Now awaited, like the two readers below it, and in key order rather than
 * completion order so two reads of an unchanged cache agree.
 */
export const getPrivateERC20BalancesForChain = async (
  chainName: NetworkName,
  balanceBucket: RailgunWalletBalanceBucket = RailgunWalletBalanceBucket.Spendable,
): Promise<RailgunDisplayBalance[]> => {
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
  const balances: RailgunDisplayBalance[] = [];
  for (const tokenAddress of Object.keys(cache)) {
    const entry = cache[tokenAddress];
    const bigIntAmount = BigInt(entry.balance.amount);
    if (bigIntAmount <= 0n) continue;
    // A token whose metadata could not be read is deliberately absent, the same
    // rule getAllPrivateERC20BalancesForChain applies: this is a spend list, and
    // an amount typed against guessed decimals is wrong by whatever the guess
    // was wrong by. It stays visible on the rail through the bucket reader.
    if (entry.unresolved) continue;
    const info = await getTokenInfo(chainName, tokenAddress).catch(
      () => undefined,
    );
    if (!info) continue;
    balances.push({
      tokenAddress,
      amount: bigIntAmount,
      decimals: info.decimals,
      name: info.name,
      symbol: info.symbol,
    });
  }

  return balances;
};

/** A display balance tagged with the POI bucket the amount currently sits in. */
export interface BucketBalance extends RailgunDisplayBalance {
  bucket: RailgunWalletBalanceBucket;
  /** The symbol and decimals are unknown, so the amount must not be formatted. */
  unresolved?: boolean;
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
      // A token whose decimals could not be read is deliberately absent from
      // this list. It is shown on the rail so the holding is visible, but an
      // amount typed against guessed decimals is off by whatever the guess was
      // wrong by — and this is the list the send flows spend from.
      if (cache[tokenAddress].unresolved) continue;
      totals[tokenAddress] =
        (totals[tokenAddress] ?? 0n) + BigInt(cache[tokenAddress].balance.amount);
    }
  }

  const balances: RailgunDisplayBalance[] = [];
  for (const tokenAddress of Object.keys(totals)) {
    if (totals[tokenAddress] <= 0n) continue;
    // Unresolved entries are already filtered out, so a failure here is a
    // token that resolved once and cannot be read now. Skipping it keeps the
    // rest spendable rather than failing the whole list.
    const info = await getTokenInfo(chainName, tokenAddress).catch(() => undefined);
    if (!info) continue;
    balances.push({
      tokenAddress,
      amount: totals[tokenAddress],
      decimals: info.decimals,
      name: info.name,
      symbol: info.symbol,
    });
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
      const entry = cache[tokenAddress];
      const amount = BigInt(entry.balance.amount);
      if (amount <= 0n) continue;
      // Never throws. This used to call getTokenInfo bare, so a single token
      // whose metadata could not be read took down the whole read — and the
      // caller's catch turned that into an empty portfolio rather than one
      // missing row.
      const info = entry.unresolved
        ? undefined
        : await getTokenInfo(chainName, tokenAddress).catch(() => undefined);
      rows.push({
        tokenAddress,
        amount,
        decimals: info?.decimals ?? entry.balance.decimals,
        name: info?.name ?? tokenAddress,
        symbol: info?.symbol ?? short(tokenAddress),
        bucket: bucket as RailgunWalletBalanceBucket,
        ...(info ? {} : { unresolved: true }),
      });
    }
  }
  return rows;
};
