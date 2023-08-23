import {
  NetworkName,
  RailgunERC20Amount,
} from "@railgun-community/shared-models";

import { formatUnits } from "ethers";
import { getTokenInfo } from "../balance/token-util";
import { RailgunReadableAmount } from "../models/balance-models";

const convertReadable = (tokenAmount: bigint, decimals: number) => {
  const converted = formatUnits(tokenAmount, decimals);
  return converted;
};

export const readablePrecision = (
  amount: bigint,
  decimals: number,
  precision: number,
) => {
  return parseFloat(formatUnits(amount, decimals)).toFixed(precision);
};

export const readableAmounts = async (
  tokenBalances: RailgunERC20Amount[],
  chainName: NetworkName,
): Promise<RailgunReadableAmount[]> => {
  const result = Promise.all(
    tokenBalances.map(async (balance) => {
      const { decimals, symbol, name } = await getTokenInfo(
        chainName,
        balance.tokenAddress,
      );

      const converted = convertReadable(balance.amount, decimals);

      return {
        ...balance,
        symbol,
        decimals,
        name,
        amountReadable: converted.toString() ?? "0",
      };
    }),
  );
  return result;
};

export const delay = (delayInMS: number): Promise<void> => {
  return new Promise((resolve) => {
    return setTimeout(resolve, delayInMS);
  });
};

export const throwError = (err: Error) => {
  throw err;
};

/*
 * Creates a promise that rejects in <ms> milliseconds
 */
export function promiseTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise((_resolve, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error(`TIMEOUT: ${ms} ms.`));
    }, ms);
  });

  return Promise.race([promise, timeout])
    .then((result) => result as T)
    .catch((err) => {
      throw err;
    });
}

export const bigIntToHex = (n: bigint): string => {
  return `0x${n.toString(16)}`;
};

// only use for hex strings without 0x prefix.
export const hexToBigInt = (hexString: string) => {
  return BigInt(`0x${hexString}`);
};

export const maxBigInt = (b1: bigint, b2: bigint) => {
  return b1 > b2 ? b1 : b2;
};

export const minBigInt = (b1: bigint, b2: bigint) => {
  return b1 < b2 ? b1 : b2;
};

export function removeUndefineds<T>(a: Optional<T>[]): T[] {
  const newArray: T[] = [];
  for (const item of a) {
    if (item != null) {
      newArray.push(item);
    }
  }
  return newArray;
}
