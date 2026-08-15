import { NetworkName, isDefined } from "@railgun-community/shared-models";
import {
  loadConfigForNetwork,
  remoteConfig,
  setRemoteConfig,
} from "../railgun/network/network-util";
import configDefaults from "./config-defaults";
import { applyProviderOverrides } from "./config-manager";
import {
  getProviderObjectFromURL,
  RemoteConfig,
} from "../models/network-models";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../../package.json");
import { createLogger } from "../platform/logger";

const log = createLogger("config");

export const featureFlags: Record<string, any> = {};

export const getFlagsForNetwork = (networkName: NetworkName) => {
  return featureFlags[networkName];
};

// Built-in fallback remote config — installed when the on-chain remote config can't be fetched
// or parsed, so the app runs on baked-in defaults (public RPCs from config-defaults) instead of
// exiting. Flags default to enabled for the supported mainnets; POI/bootstrap/peers are empty
// (POI is limited on the fallback, which only triggers when remote config is unavailable).
const ALL_ENABLED = {
  canSendPublic: true,
  canSendShielded: true,
  canShield: true,
  canUnshield: true,
  canSwapPublic: true,
  canSwapShielded: true,
  canRelayAdapt: true,
};

const buildFallbackRemoteConfig = (): RemoteConfig => {
  const network: RemoteConfig["network"] = {};
  const mainnets = [
    NetworkName.Ethereum,
    NetworkName.Polygon,
    NetworkName.BNBChain,
    NetworkName.Arbitrum,
  ];
  for (const name of mainnets) {
    const cfg = configDefaults.networkConfig[name];
    network[cfg.chainId] = {
      name,
      providers: cfg.providers,
      flags: ALL_ENABLED,
    };
  }
  return {
    currentVersionNumber: version,
    minVersionNumber: "0.0.0",
    bootstrap: [],
    wakuPubSubTopic: "/waku/2/rs/5/1",
    additionalDirectPeers: [],
    publicPoiAggregatorUrls: [],
    blacklist: [],
    apiKeys: configDefaults.apiKeys,
    network,
    trustedFeeSigner:
      "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k",
  };
};

export const fallbackRemoteConfig: RemoteConfig = buildFallbackRemoteConfig();

export const overrideMainConfig = async (_version: string) => {
  const overrides = await loadConfigForNetwork();
  // If the remote config is unavailable, run on the built-in fallback rather than exiting.
  const effective = overrides ?? fallbackRemoteConfig;
  if (!isDefined(overrides)) {
    setRemoteConfig(fallbackRemoteConfig);
    log.warn(
      "remote config unavailable; running on the built-in fallback (baked-in public RPCs)",
    );
  }

  if (isDefined(effective.apiKeys)) {
    for (const key in effective.apiKeys) {
      configDefaults.apiKeys[key] = effective.apiKeys[key];
    }
  }

  const networks = effective.network;
  for (const chainid in networks) {
    const network = networks[chainid];
    featureFlags[network.name] = network.flags;

    // Only override the baked-in providers when the config actually supplies some; otherwise
    // keep the config-defaults providers as the per-network fallback.
    const newProviders = network.providers;
    if (Array.isArray(newProviders) && newProviders.length > 0) {
      const _providers = [];
      for (const provider of newProviders) {
        if (typeof provider == "string") {
          _providers.push(getProviderObjectFromURL(provider));
        } else if ("provider" in provider) {
          _providers.push(provider);
        } else {
          throw new Error("Unknown provider type");
        }
      }
      const networkConfig =
        configDefaults.networkConfig[network.name as NetworkName];
      if (isDefined(networkConfig)) {
        networkConfig.providers = _providers;
      }
    }
  }

  // Last, so an explicitly configured provider list wins over both the baked-in
  // defaults and whatever the remote config supplies. Dropping a dead endpoint
  // is otherwise only possible by editing the defaults.
  applyProviderOverrides();
};

export type VersionVerdict =
  | { ok: true; newer?: string }
  | { ok: false; message: string };

/**
 * Compare two dotted version strings numerically.
 *
 * `<` on the strings themselves is lexicographic, which agrees with semver only
 * while every segment is a single digit. `"2.0.10" < "2.0.9"` is true, so the
 * tenth patch of a line reads as older than the ninth: the app would report a
 * newer version was available when it was running it, and a minVersionNumber of
 * "2.0.9" would lock every 2.0.10 client out with exit 69. That floor is the
 * operator's kill switch, and it is published on-chain, so the failure would be
 * both remote and slow to undo.
 *
 * Missing segments count as 0, so "2.1" and "2.1.0" are equal.
 *
 * A pre-release suffix is dropped, so "2.0.0-rc.1" compares equal to "2.0.0"
 * rather than either side of it. Splitting on "." first would read "0-rc" and
 * "1" as two more segments and rank the candidate ABOVE its own release, which
 * is the one direction that matters here: it would suppress the upgrade prompt
 * on the build most likely to need it. Semver ranks a pre-release below its
 * release; this gates a download prompt rather than a package resolver, and
 * treating them as the same version is close enough to cost only a nag.
 *
 * Returns <0 when a is older, 0 when equal, >0 when a is newer.
 */
export const compareVersions = (a: string, b: string): number => {
  const parts = (v: string): number[] =>
    String(v ?? "")
      .split("-")[0]
      .split(".")
      .map((segment) => {
        const parsed = Number.parseInt(segment, 10);
        return Number.isNaN(parsed) ? 0 : parsed;
      });
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

/**
 * Compare the running build against the remote config's version floor.
 *
 * Returns a verdict rather than exiting. This is the operator's kill switch for
 * a build with a known problem, and a config module that calls process.exit
 * cannot be tested, cannot tear a renderer down first, and gives whatever is on
 * screen no chance to say why it vanished. The caller decides.
 */
export const versionCheck = (version: string): VersionVerdict => {
  log.debug(`version ${version}`);

  if (compareVersions(version, remoteConfig.minVersionNumber) < 0) {
    return {
      ok: false,
      message:
        `this build (${version}) is older than the minimum supported version ` +
        `(${remoteConfig.minVersionNumber}). Download a current build from ` +
        `https://www.terminal-wallet.com`,
    };
  }
  if (compareVersions(version, remoteConfig.currentVersionNumber) < 0) {
    return {
      ok: true,
      newer:
        `a newer version is available (${remoteConfig.currentVersionNumber}); ` +
        `you are on ${version}. https://www.terminal-wallet.com`,
    };
  }
  return { ok: true };
};
