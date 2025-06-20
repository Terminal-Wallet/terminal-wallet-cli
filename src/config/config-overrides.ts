import { NetworkName, getAvailableProviderJSONs } from "@railgun-community/shared-models";
import { loadConfigForNetwork, remoteConfig } from "../network/network-util";
import configDefaults from "./config-defaults"
import { getProviderObjectFromURL } from "../models/network-models";

export const featureFlags: Record<string, any> = {}

export const getFlagsForNetwork = (networkName: NetworkName) => {
    return featureFlags[networkName];
}

export const overrideMainConfig = async (version: string) => {
    const overrides = await loadConfigForNetwork();
    if ('apiKeys' in overrides) {
        for (const key in overrides.apiKeys) {
            const value = overrides.apiKeys[key];
            configDefaults.apiKeys[key] = value
        }
    }
    const networks = overrides.network;
    for (const chainid in networks) {
        const network = networks[chainid];
        const networkFlags = network.flags;
        featureFlags[network.name] = networkFlags;

        const newProviders = network.providers;
        const _providers = [];
        for (const provider of newProviders) {
            if (typeof provider == 'string') {
                const newProvider = getProviderObjectFromURL(provider);
                _providers.push(newProvider);
            } else if ('provider' in provider) {
                _providers.push(provider);
            } else {
                throw new Error("Unknown provider type")
            }
        }
        configDefaults.networkConfig[network.name as NetworkName].providers = _providers;
    }
}


export const versionCheck = (version: string) => {
    console.log(("v" + version).grey);

    if (version < remoteConfig.minVersionNumber) {
        console.log("This version is less than the minimum stable version.".bgRed);
        console.log('DEPRECATED Version. Download @', "https://www.terminal-wallet.com".bgBlue);
        process.exit(69);
    }
    if (version < remoteConfig.currentVersionNumber) {
        console.log('Theres a new version available!!'.rainbow, "Download Links:".zebra, "https://www.terminal-wallet.com".bgBlue)
    }
}