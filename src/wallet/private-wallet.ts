import { loadWalletByID, unloadWalletByID } from "@railgun-community/wallet";
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { saveKeychainFile } from "./wallet-cache";
import { WalletCache } from "../models/wallet-models";
import { loadEngineProvidersForNetwork } from "../engine/engine";
import { switchWakuNetwork } from "../waku/connect-waku";
import { walletManager } from "./wallet-manager";
import {
  initilizeFreshWallet,
  reinitWalletForChain,
  setupWeb3Provider,
} from "./wallet-init";
import { updateCachedTokenData } from "../balance/token-util";
import configDefaults from "../config/config-defaults";
import { getSaltedPassword } from "./wallet-password";

const railgunWallets: MapType<WalletCache> = {};

export const resetMerkelScan = () => {
  walletManager.merkelScanComplete = false;
};

export const resetPrivateCache = () => {
  walletManager.privateBalanceCache = [];
};

export const resetBalanceScan = () => {
  resetPrivateCache();
  walletManager.menuLoaded = false;
};
export const resetMenuForScan = () => {
  resetMerkelScan();
  resetBalanceScan();
};

export const switchRailgunNetwork = async (chainName: NetworkName) => {
  resetMenuForScan();

  walletManager.keyChain.currentNetwork = chainName;
  updateCachedTokenData();
  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
  await switchWakuNetwork(chainName);
  await loadEngineProvidersForNetwork(chainName);

  if (chainName === NetworkName.Ethereum || chainName === NetworkName.Polygon) {
    setupWeb3Provider(chainName);
  }
};

// export const awaitBalancesLoaded = async (): Promise<void> => {
//   return new Promise(async (resolve, reject) => {
//     while (!walletManager.merkelScanComplete) {
//       await delay(100);
//     }
//     resolve();
//   });
// };

export const switchRailgunWallet = async (
  walletName: string,
): Promise<boolean | undefined> => {
  if (!walletManager.keyChain.wallets) {
    return;
  }

  if (walletName === walletManager.activeWalletName) {
    return;
  }

  const _hashedPassword = await getSaltedPassword();

  if (!isDefined(_hashedPassword)) {
    return;
  }
  const {
    railgunWalletID: newRailgunWalletID,
    railgunWalletAddress: newRailgunWalletAddress,
  } = walletManager.keyChain.wallets[walletName];
  walletManager.railgunWalletID = newRailgunWalletID;
  walletManager.railgunWalletAddress = newRailgunWalletAddress;

  unloadWalletByID(walletManager.railgunWalletID);
  resetMenuForScan();

  const newWallet = await loadWalletByID(
    _hashedPassword,
    walletManager.railgunWalletID,
    false,
  );
  console.log(`Loading wallet ${walletName}, Please Wait...`);

  walletManager.keyChain.selectedWallet = walletName;
  walletManager.activeWalletName = walletName;
  const currentNetwork =
    walletManager.keyChain.currentNetwork ?? NetworkName.Ethereum;
  walletManager.currentActiveWallet =
    walletManager.keyChain.wallets[walletName];
  updateCachedTokenData();
  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);

  await reinitWalletForChain(currentNetwork);
  return true;
};

export const runFreshWalletPrompt = async (chainName: NetworkName) => {
  const newWalletInfo = await initilizeFreshWallet();
  if (isDefined(newWalletInfo)) {
    resetMenuForScan();
    await reinitWalletForChain(chainName);

    return newWalletInfo;
  }
  return undefined;
};
