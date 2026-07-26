/**
 * Token USD prices via DefiLlama's free coins API (no key required):
 *   GET https://coins.llama.fi/prices/current/{chain}:{addr},{chain}:{addr}
 *
 * DefiLlama only indexes mainnets — testnets (Sepolia/Amoy) resolve to no chain
 * key and return an empty map, so callers degrade gracefully (no USD shown).
 */
import { NetworkName } from "@railgun-community/shared-models";

const DEFILLAMA_BASE = "https://coins.llama.fi/prices/current/";

/** RAILGUN network → DefiLlama chain key (undefined = unsupported/testnet). */
export const defiLlamaChainKey = (network: NetworkName): string | undefined => {
  switch (network) {
    case NetworkName.Ethereum:
      return "ethereum";
    case NetworkName.BNBChain:
      return "bsc";
    case NetworkName.Polygon:
      return "polygon";
    case NetworkName.Arbitrum:
      return "arbitrum";
    default:
      return undefined; // testnets / hardhat: no price data
  }
};

/** Pure: parse a DefiLlama coins response into a lowercased address → USD map. */
export const parsePriceResponse = (
  chainKey: string,
  body: { coins?: Record<string, { price?: number }> },
): Record<string, number> => {
  const out: Record<string, number> = {};
  const coins = body.coins ?? {};
  for (const [key, value] of Object.entries(coins)) {
    // key is `${chainKey}:${address}` — strip the prefix, lowercase the address.
    const prefix = `${chainKey}:`;
    if (!key.startsWith(prefix)) continue;
    const address = key.slice(prefix.length).toLowerCase();
    if (typeof value?.price === "number") out[address] = value.price;
  }
  return out;
};

/**
 * Fetch USD prices for `tokenAddresses` on `network`. Returns a lowercased
 * address → USD map (empty on unsupported chains or any fetch error — prices
 * are non-critical and must never break the dashboard).
 */
export const getTokenPricesUSD = async (
  network: NetworkName,
  tokenAddresses: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, number>> => {
  const chainKey = defiLlamaChainKey(network);
  if (!chainKey || tokenAddresses.length === 0) return {};
  const coins = tokenAddresses
    .map((a) => `${chainKey}:${a}`)
    .join(",");
  try {
    const res = await fetchImpl(`${DEFILLAMA_BASE}${coins}`);
    if (!res.ok) return {};
    const body = (await res.json()) as {
      coins?: Record<string, { price?: number }>;
    };
    return parsePriceResponse(chainKey, body);
  } catch {
    return {};
  }
};
