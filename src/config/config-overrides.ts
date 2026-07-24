import { NetworkName, isDefined } from "@railgun-community/shared-models";
import {
  loadConfigForNetwork,
  remoteConfig,
  setRemoteConfig,
} from "../network/network-util";
import configDefaults from "./config-defaults";
import {
  getProviderObjectFromURL,
  RemoteConfig,
} from "../models/network-models";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../../package.json");

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
    console.log("[remote-config] Using built-in fallback config.".grey);
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
};

export const versionCheck = (version: string) => {
  console.log(("v" + version).grey);

  if (version < remoteConfig.minVersionNumber) {
    console.log("This version is less than the minimum stable version.".bgRed);
    console.log(
      "DEPRECATED Version. Download @",
      "https://www.terminal-wallet.com".bgBlue,
    );
    process.exit(69);
  }
  if (version < remoteConfig.currentVersionNumber) {
    console.log(
      "Theres a new version available!!".rainbow,
      "Download Links:".zebra,
      "https://www.terminal-wallet.com".bgBlue,
    );
  }
};
