import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { WalletCache } from "../models/wallet-models";
import { getCurrentNetwork } from "../engine/engine";
import { getChainForName, getProviderForChain } from "../network/network-util";
import { walletManager } from "./wallet-manager";
import { saveKeychainFile } from "./wallet-cache";
import configDefaults from "../config/config-defaults";


export const isMenuResponsive = () => {
  return walletManager.responsiveMenu;
};

export const shouldShowSender = () => {
  return walletManager.showSenderAddress;
}

export const toggleShouldShowSender = () =>{
  const { keyChainPath } = configDefaults.engine;
  walletManager.showSenderAddress = !walletManager.showSenderAddress;
  walletManager.keyChain.showSenderAddress = walletManager.showSenderAddress;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
}

export const toggleResponsiveMenu = () => {
  walletManager.responsiveMenu = !walletManager.responsiveMenu;
  const { keyChainPath } = configDefaults.engine;
  walletManager.keyChain.responsiveMenu = walletManager.responsiveMenu;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

export const shouldDisplayPrivateBalances = () => {
  return walletManager.displayPrivate;
};

export const togglePrivateBalances = () => {
  walletManager.displayPrivate = !walletManager.displayPrivate;
  const { keyChainPath } = configDefaults.engine;
  walletManager.keyChain.displayPrivate = walletManager.displayPrivate;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

export const getWalletInfoForName = (walletName: string): WalletCache => {
  if (!walletManager.keyChain || !walletManager.keyChain.wallets) {
    throw new Error("No Keychain Loaded.");
  }
  return walletManager.keyChain.wallets[walletName];
};

export const getWalletIDforName = (walletName: string) => {
  return getWalletInfoForName(walletName).railgunWalletID;
};

export const getCurrentWalletPublicAddress = () => {
  const { publicAddress } = walletManager.currentActiveWallet;
  if (!publicAddress) {
    throw new Error("No Public Address loaded.");
  }
  return publicAddress;
};

export const getCurrentWalletName = () => {
  return walletManager.activeWalletName;
};

export const getCurrentRailgunID = () => {
  return walletManager.railgunWalletID;
};

export const getCurrentRailgunAddress = () => {
  return walletManager.railgunWalletAddress;
};

// export const getPrivateBalanceCache = () => {
//   return walletManager.privateBalanceCache;
// };

export const getWalletNames = () => {
  if (!walletManager.keyChain || !walletManager.keyChain.wallets) {
    return [];
  }
  return Object.keys(walletManager.keyChain.wallets);
};

type GasBalanceCache = {
  amount: bigint;
  timestamp: number;
};

// <chain.type><chain.id><address>
const gasBalanceCache: NumMapType<NumMapType<MapType<GasBalanceCache>>> = {};

export const getGasBalanceForAddress = async (address: string) => {
  const currentNetwork = getCurrentNetwork();
  const chain = getChainForName(currentNetwork);

  gasBalanceCache[chain.type] ??= {};
  gasBalanceCache[chain.type][chain.id] ??= {};

  const cache = gasBalanceCache[chain.type][chain.id][address];

  if (isDefined(cache)) {
    const timeDifference = Date.now() - cache.timestamp;
    if (timeDifference < 30 * 1000) {
      return cache.amount;
    }
    //
  }

  const provider = getProviderForChain(currentNetwork);
  const gasBalance = await provider.getBalance(address).catch((err) => {
    return undefined;
  });
  if (isDefined(gasBalance)) {
    gasBalanceCache[chain.type][chain.id][address] = {
      amount: gasBalance,
      timestamp: Date.now(),
    };

    return gasBalance;
  }
  return 0n;
};

export const getCurrentWalletGasBalance = async () => {
  const gasBalance = await getGasBalanceForAddress(
    getCurrentWalletPublicAddress(),
  );
  return gasBalance;
};
