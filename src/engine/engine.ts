import {
  loadProvider,
  startRailgunEngine,
  stopRailgunEngine,
  getProver,
  SnarkJSGroth16 as Groth16,
  pauseAllPollingProviders,
  resumeIsolatedPollingProviderForNetwork,
  refreshBalances as scanUpdatesForMerkletreeAndWallets,
  setLoggers,
} from "@railgun-community/wallet";
import {
  FallbackProviderJsonConfig,
  FeesSerialized,
  NetworkName,
  getAvailableProviderJSONs,
  isDefined,
  removeUndefineds,
} from "@railgun-community/shared-models";
import { groth16 } from "snarkjs";
import configDefaults from "../config/config-defaults";
import LevelDOWN from "leveldown";
import { createArtifactStore } from "../db/artifact-store";
import { setRailgunFees } from "@railgun-community/cookbook";
import { getChainForName, remoteConfig } from "../network/network-util";
import { getProviderObjectFromURL } from "../models/network-models";
import { walletManager } from "../wallet/wallet-manager";
import { saveKeychainFile } from "../wallet/wallet-cache";

const RAILGUN_DB_PATH = configDefaults.engine.databasePath;
const RAILGUN_ARTIFACT_PATH = configDefaults.engine.artifactPath;

let railgunEngineRunning = false;
export const isEngineRunning = () => {
  return railgunEngineRunning;
};

const interceptLog = {
  log: (log: string) => {
    console.log(log);
  },
  error: (err: any) => {
    console.log(err);
  },
};

export const getCustomProviders = () => {
  return walletManager.keyChain.customProviders;
};

export const removeCustomProvider = (
  chainName: NetworkName,
  rpcURL: string,
) => {
  const chain = getChainForName(chainName);

  if (isDefined(walletManager.keyChain.customProviders)) {
    delete walletManager.keyChain.customProviders[chain.type][chain.id][rpcURL];
    const { keyChainPath } = configDefaults.engine;
    saveKeychainFile(walletManager.keyChain, keyChainPath);
  }
};

export const setCustomProviderStatus = (
  chainName: NetworkName,
  rpcURL: string,
  enabled: boolean,
) => {
  const chain = getChainForName(chainName);

  if (!isDefined(walletManager.keyChain.customProviders)) {
    walletManager.keyChain.customProviders = {};
    walletManager.keyChain.customProviders[chain.type] ??= {};
    walletManager.keyChain.customProviders[chain.type][chain.id] ??= {};
  }

  walletManager.keyChain.customProviders[chain.type][chain.id][rpcURL] =
    enabled;

  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

export const getCustomProvidersForChain = (
  chainName: NetworkName,
): MapType<boolean> | undefined => {
  const chain = getChainForName(chainName);
  const customProviders = getCustomProviders();
  if (!isDefined(customProviders)) {
    return undefined;
  }

  if (!isDefined(customProviders[chain.type])) {
    customProviders[chain.type] ??= {};
    customProviders[chain.type][chain.id] ??= {};
    const { keyChainPath } = configDefaults.engine;
    saveKeychainFile(walletManager.keyChain, keyChainPath);
  }

  const chainProviders = customProviders[chain.type][chain.id];

  return chainProviders;
};

export const initRailgunEngine = async () => {
  if (isEngineRunning()) {
    return;
  }
  const engineDatabase = new LevelDOWN(RAILGUN_DB_PATH);
  const artifactStorage = createArtifactStore(RAILGUN_ARTIFACT_PATH);
  const shouldDebug = true;
  const useNativeArtifacts = false;
  const skipMerkelTreeScans = false;
  const poiNodeURLs = remoteConfig.publicPoiAggregatorUrls ?? [];
  const customPOIList = undefined;

  await startRailgunEngine(
    "terminalwallet",
    engineDatabase,
    shouldDebug,
    artifactStorage,
    useNativeArtifacts,
    skipMerkelTreeScans,
    poiNodeURLs,
    customPOIList,
  );

  getProver().setSnarkJSGroth16(groth16 as Groth16);
  setLoggers(interceptLog.log, interceptLog.error);

  railgunEngineRunning = true;
};

const loadedRailgunNetworks: MapType<boolean> = {};
let currentLoadedNetwork: NetworkName;

export const getCurrentNetwork = () => {
  if (currentLoadedNetwork) {
    return currentLoadedNetwork;
  }
  throw new Error("No Network Loaded.");
};

export const rescanBalances = async (chainName: NetworkName) => {
  const chain = getChainForName(chainName);

  const walletIdFilter = walletManager.railgunWalletID;
  await scanUpdatesForMerkletreeAndWallets(chain, [walletIdFilter]);
};

export const isDefaultProvider = (chainName: NetworkName, rpcURL: string) => {
  const { providers } = configDefaults.networkConfig[chainName];

  const filteredDefaults = providers.filter(({ provider }) => {
    if (rpcURL === provider) {
      return true;
    }
    return false;
  });
  return filteredDefaults.length > 0;
};

export const getCustomProviderEnabledStatus = (
  chainName: NetworkName,
  rpcURL: string,
) => {
  const chainProviders = getCustomProvidersForChain(chainName);
  if (!isDefined(chainProviders)) {
    return true; // undefined?
  }

  const status = chainProviders[rpcURL];
  if (isDefined(status)) {
    return status;
  }
  return true;
};

export const getProviderPromptOptions = (chainName: NetworkName) => {
  const customProviders = getCustomProvidersForChain(chainName);

  const { providers } = configDefaults.networkConfig[chainName];
  if (isDefined(customProviders)) {
    const filteredDefaults = providers.filter(({ provider }) => {
      if (isDefined(customProviders[provider])) {
        return false;
      }
      return true;
    });

    const unsetDefaultPrompts = filteredDefaults.map(({ provider }) => {
      return {
        name: provider,
        message: `[${"Enabled ".green.dim}] ${provider}`,
      };
    });

    const customPrompts = Object.keys(customProviders).map((provider) => {
      const providerEnabled = customProviders[provider];
      return {
        name: provider,
        message: `[${
          providerEnabled ? "Enabled ".green.dim : "Disabled".yellow.dim
        }] ${provider}`,
      };
    });

    return [...unsetDefaultPrompts, ...customPrompts];
  } else {
    const defaultProviders = providers.map(({ provider }) => {
      return {
        name: provider,
        message: `[${"Enabled ".green.dim}] ${provider}`,
      };
    });
    return defaultProviders;
  }
};
export const loadProviderList = async (chainName: NetworkName) => {
  if (!isDefined(chainName)) {
    throw new Error("No chainName provided.");
  }
  const customProviders = getCustomProvidersForChain(chainName);
  const { providers, chainId } = configDefaults.networkConfig[chainName];
  let combinedProviders = providers;
  if (isDefined(customProviders)) {
    const filteredDefaults = providers.filter(({ provider }) => {
      if (customProviders[provider] === false) {
        return false;
      }
      return true;
    });

    const refObjects = Object.keys(customProviders).map((key) => {
      if (customProviders[key]) {
        return getProviderObjectFromURL(key);
      }
      return undefined;
    });
    const customProviderJSONs = removeUndefineds(refObjects);

    combinedProviders = [...customProviderJSONs, ...filteredDefaults];
  }
  const availableProviders = await getAvailableProviderJSONs(
    chainId,
    [...combinedProviders],
    console.error,
  );
  const newRPCJsonConfig: FallbackProviderJsonConfig = {
    chainId,
    providers: availableProviders,
  };
  const rpcPollingInterval = 20 * 1000;
  pauseAllPollingProviders(chainName);
  const { feesSerialized } = await loadProvider(
    newRPCJsonConfig,
    chainName,
    rpcPollingInterval,
  );
  const feesShield = BigInt(
    feesSerialized.shieldFeeV3 ?? feesSerialized.shieldFeeV2,
  );
  const feesUnshield = BigInt(
    feesSerialized.unshieldFeeV3 ?? feesSerialized.shieldFeeV2,
  );

  setRailgunFees(chainName, feesShield, feesUnshield);
  loadedRailgunNetworks[chainName] = true;
  currentLoadedNetwork = chainName;
};

export const loadEngineProvidersForNetwork = async (chainName: NetworkName) => {
  if (chainName === currentLoadedNetwork && loadedRailgunNetworks[chainName]) {
    await rescanBalances(chainName);
    return;
  }

  if (loadedRailgunNetworks[chainName]) {
    currentLoadedNetwork = chainName;
    resumeIsolatedPollingProviderForNetwork(chainName);
    await rescanBalances(chainName);
    return;
  }

  await loadProviderList(chainName);
};

export const pauseEngineProvidersExcept = (
  chainName: Optional<NetworkName>,
) => {
  pauseAllPollingProviders(chainName);
};

export const resumeEngineProvider = (chainName: NetworkName) => {
  resumeIsolatedPollingProviderForNetwork(chainName);
};

export const stopEngine = async () => {
  if (!isEngineRunning()) {
    return;
  }
  await stopRailgunEngine().catch((err) => {
    console.log(err);
    stopEngine();
  });
  return;
};
