/**
 * Transaction history (activity feed) — a NEW capability that was fully
 * supported by the SDK (`getWalletTransactionHistory`) but unused by the app.
 *
 * This module owns the SDK fetch; the pure mapping (SDK item → CoreHistoryItem)
 * lives in ./history-map so it can be unit-tested without the SDK. No UI imports.
 */
import { Chain, NetworkName } from "@railgun-community/shared-models";
import { getWalletTransactionHistory } from "@railgun-community/wallet";
import { getChainForName } from "./network/network-util";
import { getTokenInfo } from "./balance/token-util";
import { emitCoreEvent, CoreHistoryItem } from "../core/events";
import { mapHistoryItems } from "../core/history-map";

/**
 * Fetch + format the wallet's transaction history and emit it to the UI.
 * Returns the entries too (newest first) for callers that want them directly.
 */
export const loadTransactionHistory = async (
  chainName: NetworkName,
  railgunWalletID: string,
): Promise<CoreHistoryItem[]> => {
  const chain: Chain = getChainForName(chainName);
  const items = await getWalletTransactionHistory(chain, railgunWalletID, undefined);
  const entries = await mapHistoryItems(chainName, items, getTokenInfo);
  emitCoreEvent({ type: "history:updated", items: entries });
  return entries;
};
