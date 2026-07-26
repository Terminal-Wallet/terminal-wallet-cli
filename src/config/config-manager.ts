/**
 * App config manager — replaces startup ENV vars with a persisted, editable
 * config file (twallet.config.json at the run dir, gitignored). Drives the
 * default boot network, the remote-config RPC, and per-network RPC overrides.
 *
 * Shape (all optional):
 * {
 *   "defaultNetwork": "EthereumSepolia",
 *   "remoteConfigRpc": "https://eth-mainnet.../v2/KEY",
 *   "providers": { "EthereumSepolia": ["https://eth-sepolia.../v2/KEY"] }
 * }
 */
import fs from "fs";
import path from "path";
import { NetworkName } from "@railgun-community/shared-models";
import configDefaults from "./config-defaults";
import { getProviderObjectFromURL } from "../models/network-models";

export interface AppConfig {
  defaultNetwork?: string;
  remoteConfigRpc?: string;
  providers?: Record<string, string[]>;
  /**
   * Simulation mode: inject demo balances and run tx flows up to (not including)
   * proof generation / broadcast, so the pipeline is testable without funds.
   */
  simulate?: boolean;
}

const CONFIG_PATH = path.join(process.cwd(), "twallet.config.json");

let cache: AppConfig | undefined;

export const loadAppConfig = (): AppConfig => {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as AppConfig;
  } catch {
    cache = {};
  }
  return cache;
};

const asNetworkName = (key?: string): NetworkName | undefined => {
  if (!key) return undefined;
  const value = (NetworkName as Record<string, NetworkName>)[key];
  return value;
};

/** Network forced by config (overrides the keychain), if set. */
export const configuredDefaultNetwork = (): NetworkName | undefined =>
  asNetworkName(loadAppConfig().defaultNetwork);

/** Configured mainnet RPC for fetching the remote-config contract, if set. */
export const configuredRemoteConfigRpc = (): string | undefined =>
  loadAppConfig().remoteConfigRpc;

/** Apply per-network RPC provider overrides into configDefaults. */
export const applyProviderOverrides = (): void => {
  const { providers } = loadAppConfig();
  if (!providers) return;
  for (const [key, urls] of Object.entries(providers)) {
    const network = asNetworkName(key);
    if (!network || !Array.isArray(urls) || urls.length === 0) continue;
    const entry = configDefaults.networkConfig[network];
    if (entry) entry.providers = urls.map(getProviderObjectFromURL);
  }
};
