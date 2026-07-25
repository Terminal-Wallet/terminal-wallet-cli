/**
 * Balance formatting for the terminal — column widths, headers, and the styled
 * balance lines.
 *
 * These build display strings rather than compute anything, so they belong to
 * the renderer. They sat in the balance layer, which meant reading a balance
 * pulled in terminal styling and the wallet could not report balances to
 * anything that was not a TTY.
 */
import "colors";
import { stripColors } from "colors";
import {
  NetworkName,
  RailgunWalletBalanceBucket,
  isDefined,
} from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { RailgunDisplayBalance } from "../models/balance-models";
import { walletManager } from "../railgun/wallet/wallet-manager";
import {
  getPrivateERC20BalancesForChain,
  getPublicERC20BalancesForChain,
} from "../railgun/balance/balance-util";
import { getChainForName } from "../railgun/network/network-util";
import configDefaults from "../config/config-defaults";
import { shouldDisplayPrivateBalances } from "../railgun/wallet/wallet-util";

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

  if (!isDefined(maxBalanceLengthItem)) {
    return 0;
  }
  return formatUnits(maxBalanceLengthItem.amount, maxBalanceLengthItem.decimals)
    .length;
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

export const getPrivateDisplayBalances = async (chainName: NetworkName, bucketType: RailgunWalletBalanceBucket) => {

  const CHAIN_NAME = configDefaults.networkConfig[chainName].name.toUpperCase();
  const display: string[] = [];

  const isPrivate = shouldDisplayPrivateBalances();
  const balances = isPrivate
    ? await getPrivateERC20BalancesForChain(chainName, bucketType)
    : await getPublicERC20BalancesForChain(chainName, true);


  if(bucketType !== RailgunWalletBalanceBucket.Spendable){
    if(balances.length === 0){
      return ""
    }
    if(!isPrivate){
      // if not private, only show set of balances once. dont add header.
      return ""
    }
  }
  const balanceType = isPrivate ? "PRIVATE" : "PUBLIC";
  const header = `${CHAIN_NAME.green} ${ isPrivate ? bucketType.green : ''} ${balanceType} BALANCES`;
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
