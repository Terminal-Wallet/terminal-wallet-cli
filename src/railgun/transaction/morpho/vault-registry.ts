/**
 * The vaults worth offering, from Morpho's own indexer.
 *
 * A hardcoded list goes stale in both directions: it misses vaults that grew,
 * and it keeps offering ones that have since been flagged. Morpho runs a public
 * indexer built off the vault factories' own events, and — the part that
 * matters — it reports a live `warnings` array per vault, which is how a vault
 * whose deposits are disabled or which is carrying bad debt announces itself.
 *
 * That is what makes an automatic list defensible rather than reckless. A list
 * built from TVL alone would happily offer a vault that cannot be withdrawn
 * from.
 *
 * The curated list stays as the fallback. A wallet that cannot reach an API
 * must still be able to act on the vaults it already knows are sound, and a
 * network blip must not empty the picker.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { MORPHO_VAULTS, MorphoVaultRef } from "./vault";
import { createLogger } from "../../../platform/logger";

const log = createLogger("morpho-registry");

const ENDPOINT = "https://blue-api.morpho.org/graphql";

/** Ethereum. The vault flows are Ethereum-only anyway. */
const CHAIN_ID = 1;

/**
 * Below this a redemption starts to depend on the curator rebalancing, which is
 * not something the wallet can promise. Deliberately conservative: a vault the
 * user cannot get out of is worse than one they never saw.
 */
const MIN_LIQUIDITY_USD = 2_000_000;
const MIN_TVL_USD = 5_000_000;

/** How long a fetched list is reused before asking again. */
const CACHE_MS = 10 * 60 * 1000;

/**
 * Vaults offered per asset, best first.
 *
 * The indexer lists dozens for USDC alone. A picker with thirty rows for one
 * token is not a choice, it is a search problem — and the ones past the first
 * few differ only in curator. Capped per asset rather than overall so a
 * long-tail asset is not crowded out by USDC.
 */
const PER_ASSET = 3;

export interface MorphoVaultListing extends MorphoVaultRef {
  assetSymbol: string;
  /**
   * The asset's address, from the same response.
   *
   * Carried so the picker can match a vault against the wallet's balances
   * without an RPC round trip each — reading it per vault made opening the
   * picker cost one call per vault listed.
   */
  assetAddress?: string;
  assetDecimals?: number;
  /** Net APY as a fraction — 0.0419 is 4.19%. */
  netApy?: number;
  tvlUsd?: number;
  liquidityUsd?: number;
}

interface ApiWarning {
  type?: string;
  level?: string;
}
interface ApiVault {
  address?: string;
  name?: string;
  asset?: { symbol?: string; address?: string; decimals?: number };
  state?: { totalAssetsUsd?: number; netApy?: number };
  liquidity?: { usd?: number };
  warnings?: ApiWarning[];
}

const V1_QUERY = `{
  vaults(first: 100, orderBy: TotalAssetsUsd, orderDirection: Desc,
         where: { chainId_in: [${CHAIN_ID}], listed: true }) {
    items {
      address name
      asset { symbol address decimals }
      state { totalAssetsUsd netApy }
      liquidity { usd }
      warnings { type level }
    }
  }
}`;

const V2_QUERY = `{
  vaultV2s(first: 100, orderBy: TotalAssetsUsd, orderDirection: Desc,
           where: { chainId_in: [${CHAIN_ID}] }) {
    items {
      address name
      asset { symbol address decimals }
      totalAssetsUsd
      netApy
      listed
      warnings { type level }
    }
  }
}`;

/** A vault the indexer is warning about, at the level that means "do not". */
const hasRedWarning = (vault: ApiVault): boolean =>
  (vault.warnings ?? []).some((w) => w.level === "RED");

const usable = (
  address: string | undefined,
  tvl: number | undefined,
  liquidity: number | undefined,
): address is string =>
  typeof address === "string" &&
  /^0x[0-9a-fA-F]{40}$/.test(address) &&
  (tvl ?? 0) >= MIN_TVL_USD &&
  // V2 does not report a liquidity figure; TVL alone has to carry it there.
  (liquidity === undefined || liquidity >= MIN_LIQUIDITY_USD);

const post = async (query: string, signal: AbortSignal): Promise<unknown> => {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
    signal,
  });
  if (!response.ok) throw new Error(`morpho api ${response.status}`);
  return response.json();
};

let cache: { at: number; vaults: MorphoVaultListing[] } | undefined;

/** The curated list, in the shape the API path returns. */
const fallback = (): MorphoVaultListing[] =>
  MORPHO_VAULTS.map((vault) => ({
    ...vault,
    // The asset is read from the vault itself when a build runs, so the symbol
    // here is only a label; the name already carries it.
    assetSymbol: vault.name.split(" ").pop() ?? "",
  }));

/**
 * Every vault worth offering, newest data first.
 *
 * Never throws and never returns empty: an unreachable or changed API falls
 * back to the curated list, because a picker with nothing in it reads as "this
 * wallet cannot do vaults" rather than "the network is down".
 */
export const listMorphoVaults = async (
  chainName: NetworkName,
  timeoutMs = 15_000,
): Promise<MorphoVaultListing[]> => {
  if (chainName !== NetworkName.Ethereum) return [];
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.vaults;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Independently: V2 failing must not cost us V1. They are separate types in
    // the schema, so a change to one does not imply a change to the other.
    const [v1, v2] = await Promise.all([
      post(V1_QUERY, controller.signal).catch((err) => {
        log.debug("morpho V1 query failed", err);
        return undefined;
      }),
      post(V2_QUERY, controller.signal).catch((err) => {
        log.debug("morpho V2 query failed", err);
        return undefined;
      }),
    ]);

    const vaults: MorphoVaultListing[] = [];
    const seen = new Set<string>();
    const take = (
      raw: ApiVault[],
      generation: MorphoVaultRef["generation"],
      tvlOf: (v: ApiVault) => number | undefined,
      apyOf: (v: ApiVault) => number | undefined,
    ) => {
      for (const vault of raw) {
        if (hasRedWarning(vault)) continue;
        const liquidity = vault.liquidity?.usd;
        const tvl = tvlOf(vault);
        if (!usable(vault.address, tvl, liquidity)) continue;
        const key = vault.address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        vaults.push({
          name: vault.name ?? key,
          vaultAddress: vault.address,
          generation,
          assetSymbol: vault.asset?.symbol ?? "",
          assetAddress: vault.asset?.address,
          assetDecimals: vault.asset?.decimals,
          netApy: apyOf(vault),
          tvlUsd: tvl,
          liquidityUsd: liquidity,
        });
      }
    };

    // Optional all the way down: either half may be undefined because it failed
    // on its own, and either may have changed shape.
    const v1Items =
      (v1 as { data?: { vaults?: { items?: ApiVault[] } } } | undefined)?.data
        ?.vaults?.items ?? [];
    const v2Items =
      (
        v2 as
          | {
              data?: {
                vaultV2s?: {
                  items?: (ApiVault & {
                    listed?: boolean;
                    totalAssetsUsd?: number;
                    netApy?: number;
                  })[];
                };
              };
            }
          | undefined
      )?.data?.vaultV2s?.items ?? [];

    take(v1Items, "V1", (v) => v.state?.totalAssetsUsd, (v) => v.state?.netApy);
    take(
      v2Items.filter((v) => v.listed !== false),
      "V2",
      (v) => (v as { totalAssetsUsd?: number }).totalAssetsUsd,
      (v) => (v as { netApy?: number }).netApy,
    );

    if (!vaults.length) throw new Error("no usable vaults in the response");

    // Already ordered by TVL, so taking the first few per asset keeps the best
    // of each rather than the best overall.
    const perAsset = new Map<string, number>();
    const offered = vaults.filter((vault) => {
      const key = vault.assetSymbol.toLowerCase();
      const taken = perAsset.get(key) ?? 0;
      if (taken >= PER_ASSET) return false;
      perAsset.set(key, taken + 1);
      return true;
    });

    log.debug(
      `morpho registry: ${offered.length} vaults offered from ${vaults.length} usable`,
    );
    cache = { at: Date.now(), vaults: offered };
    return offered;
  } catch (err) {
    log.debug("morpho registry unavailable; using the curated list", err);
    return fallback();
  } finally {
    clearTimeout(timer);
  }
};

/** Drop the cached list — for a manual refresh. */
export const resetMorphoVaultCache = (): void => {
  cache = undefined;
};
