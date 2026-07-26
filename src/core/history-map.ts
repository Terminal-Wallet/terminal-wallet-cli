/**
 * Pure transaction-history mapping — SDK-free so it's unit-testable. Takes raw
 * TransactionHistoryItems + an injected token resolver and returns UI-ready
 * CoreHistoryItems (amounts decimal-formatted, newest first). The SDK fetch
 * lives in transaction-history.ts, which delegates here.
 */
import {
  NetworkName,
  RailgunERC20Amount,
  TransactionHistoryItem,
  TransactionHistoryItemCategory,
} from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import {
  CoreHistoryAmount,
  CoreHistoryItem,
} from "./history";

/** Resolve a token's display info. In production this is balance/token-util's getTokenInfo. */
export type TokenResolver = (
  chainName: NetworkName,
  tokenAddress: string,
) => Promise<{ symbol: string; decimals: number }>;

const CATEGORY_LABEL: Record<TransactionHistoryItemCategory, string> = {
  [TransactionHistoryItemCategory.ShieldERC20s]: "Shield",
  [TransactionHistoryItemCategory.UnshieldERC20s]: "Unshield",
  [TransactionHistoryItemCategory.TransferSendERC20s]: "Send",
  [TransactionHistoryItemCategory.TransferReceiveERC20s]: "Receive",
  [TransactionHistoryItemCategory.Unknown]: "Activity",
};

const DIRECTION: Record<
  TransactionHistoryItemCategory,
  CoreHistoryItem["direction"]
> = {
  [TransactionHistoryItemCategory.ShieldERC20s]: "in",
  [TransactionHistoryItemCategory.TransferReceiveERC20s]: "in",
  [TransactionHistoryItemCategory.UnshieldERC20s]: "out",
  [TransactionHistoryItemCategory.TransferSendERC20s]: "out",
  [TransactionHistoryItemCategory.Unknown]: "neutral",
};

const pickAmounts = (item: TransactionHistoryItem): RailgunERC20Amount[] => {
  switch (item.category) {
    case TransactionHistoryItemCategory.TransferReceiveERC20s:
    case TransactionHistoryItemCategory.ShieldERC20s:
      return item.receiveERC20Amounts;
    case TransactionHistoryItemCategory.TransferSendERC20s:
      return item.transferERC20Amounts;
    case TransactionHistoryItemCategory.UnshieldERC20s:
      return item.unshieldERC20Amounts;
    default:
      return [
        ...item.receiveERC20Amounts,
        ...item.transferERC20Amounts,
        ...item.unshieldERC20Amounts,
      ];
  }
};

const firstMemo = (item: TransactionHistoryItem): string | undefined => {
  const send = item.transferERC20Amounts.find((a) => a.memoText);
  if (send?.memoText) return send.memoText;
  const recv = item.receiveERC20Amounts.find((a) => a.memoText);
  return recv?.memoText ?? undefined;
};

const formatAmounts = async (
  chainName: NetworkName,
  amounts: RailgunERC20Amount[],
  resolveToken: TokenResolver,
): Promise<CoreHistoryAmount[]> =>
  Promise.all(
    amounts.map(async (a) => {
      try {
        const { symbol, decimals } = await resolveToken(chainName, a.tokenAddress);
        return { symbol, amount: formatUnits(a.amount, decimals) };
      } catch {
        return {
          symbol: `${a.tokenAddress.slice(0, 6)}…`,
          amount: a.amount.toString(),
        };
      }
    }),
  );

/** Map raw SDK history items to UI-ready entries, newest first. */
export const mapHistoryItems = async (
  chainName: NetworkName,
  items: TransactionHistoryItem[],
  resolveToken: TokenResolver,
): Promise<CoreHistoryItem[]> => {
  const entries: CoreHistoryItem[] = await Promise.all(
    items.map(async (item) => {
      const fee = item.broadcasterFeeERC20Amount
        ? (await formatAmounts(chainName, [item.broadcasterFeeERC20Amount], resolveToken))[0]
        : undefined;
      const change = item.changeERC20Amounts?.length
        ? await formatAmounts(chainName, item.changeERC20Amounts, resolveToken)
        : undefined;
      return {
        txid: item.txid,
        category: CATEGORY_LABEL[item.category] ?? "Activity",
        direction: DIRECTION[item.category] ?? "neutral",
        timestamp: item.timestamp ?? undefined,
        amounts: await formatAmounts(chainName, pickAmounts(item), resolveToken),
        memo: firstMemo(item),
        blockNumber: item.blockNumber ?? undefined,
        version: item.version,
        fee,
        via: fee ? "broadcaster" : "self-signed",
        change,
      };
    }),
  );
  entries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)); // newest first
  return entries;
};
