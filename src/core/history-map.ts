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

/**
 * A relay-adapt bundle the SDK has no category for.
 *
 * A private swap unshields one token and receives a DIFFERENT one back into
 * the same wallet in a single transaction. That fits none of the five
 * categories the SDK reports, so it arrives as `Unknown` and the feed called it
 * "Activity" — the least informative label available, on one of the largest
 * things the wallet does. Every 7702 flow lands here: the swap, and anything
 * else that unshields and re-shields in one bundle.
 *
 * Told apart by shape, since the item carries no relay-adapt flag. Change
 * returns in the SAME token it left in, so testing the received tokens against
 * the unshielded ones is what separates a swap from an ordinary unshield with
 * change.
 */
export const looksLikeSwap = (item: TransactionHistoryItem): boolean => {
  if (!item.unshieldERC20Amounts.length || !item.receiveERC20Amounts.length) {
    return false;
  }
  const sent = new Set(
    item.unshieldERC20Amounts.map((a) => a.tokenAddress.toLowerCase()),
  );
  return item.receiveERC20Amounts.some(
    (a) => !sent.has(a.tokenAddress.toLowerCase()),
  );
};

/**
 * Whether an item put funds into the shielded pool.
 *
 * An explicit shield, or a relay-adapt bundle that received tokens back — the
 * re-shield half of a swap, a vault deposit, an fx mint. A private transfer IN
 * also receives tokens but was already shielded, so it starts no shield clock
 * and is excluded by category.
 */
export const isShielding = (item: TransactionHistoryItem): boolean =>
  item.category === TransactionHistoryItemCategory.ShieldERC20s ||
  (item.category === TransactionHistoryItemCategory.Unknown &&
    item.receiveERC20Amounts.length > 0);

/** The label for an item, including the shapes the SDK reports as Unknown. */
export const categoryLabel = (item: TransactionHistoryItem): string => {
  const known = CATEGORY_LABEL[item.category];
  if (known && known !== "Activity") return known;
  return looksLikeSwap(item) ? "Swap" : (known ?? "Activity");
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
        category: categoryLabel(item),
        // A swap moves value within the wallet rather than in or out of it.
        direction: DIRECTION[item.category] ?? "neutral",
        timestamp: item.timestamp ?? undefined,
        amounts: await formatAmounts(chainName, pickAmounts(item), resolveToken),
        memo: firstMemo(item),
        blockNumber: item.blockNumber ?? undefined,
        version: item.version,
        fee,
        via: fee ? "broadcaster" : "self-signed",
        change,
        shielded: isShielding(item),
      };
    }),
  );
  entries.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0)); // newest first
  return entries;
};
