import { generateNewWalletPrompt } from "../ui/wallet-info-ui";
import { confirmPrompt } from "../ui/confirm-ui";
import {
  createRailgunWallet,
  getWalletMnemonic,
  loadWalletByID,
  setOnBalanceUpdateCallback,
  setOnMerkletreeScanCallback,
} from "@railgun-community/wallet";
import {
  NetworkName,
  RailgunWalletInfo,
  isDefined,
} from "@railgun-community/shared-models";
import {
  loadTokenDBCache,
  resetBalanceCachesForChain,
} from "../balance/balance-cache";
import { getRailgunKeychains, saveKeychainFile } from "./wallet-cache";
import { KeychainFile, TMPWalletInfo } from "../models/wallet-models";
import {
  initRailgunEngine,
  loadEngineProvidersForNetwork,
} from "../engine/engine";
import { initWakuClient, startWakuClient } from "../waku/connect-waku";
import { importKnownAddressesFromWallet } from "../ui/known-address-ui";
import { processSafeExit } from "../util/error-util";
import {
  getEthersWallet,
  getProviderURLForChain,
} from "../network/network-util";
import { walletManager } from "./wallet-manager";
import { scanBalancesCallback, merkelTreeScanCallback } from "./scan-callbacks";
import { getSaltedPassword } from "./wallet-password";
import { confirmGetPasswordPrompt } from "../ui/password-ui";
import { computePasswordHash, getIV } from "../util/crypto";
import configDefaults from "../config/config-defaults";
import Web3 from "web3";

export const generateKeychainPrompt = async (
  index: number = 0,
): Promise<KeychainFile> => {
  const saltIV = getIV();
  const salt = await computePasswordHash(saltIV, 32);

  if (isDefined(salt)) {
    const keychain: KeychainFile = {
      name: `.plasma_${index}`,
      salt, // this is used to generate encryption key, computePasswordHash(inputPassword, salt)
    };
    return keychain;
  } else {
    throw new Error("KeyChain Salt Generation Failed.");
  }
};

export const initializeKeychainSystem = async (): Promise<KeychainFile> => {
  const { keyChainPath } = configDefaults.engine;
  const keychains = await getRailgunKeychains(keyChainPath);

  if (keychains.length > 0) {
    // we have keychains. run selection prompt. or return if only 1 available.
    if (keychains.length === 1) {
      return keychains[0];
    }
    // run selection here.
    // will implement this after.
    console.log("Multiple wallets found, returning first");
    return keychains[0];
  }
  try {
    const keychain = await generateKeychainPrompt();

    saveKeychainFile(keychain, keyChainPath);

    return keychain;
  } catch (error) {
    console.log((error as Error).message);
    const confirm = await confirmPrompt(`TRY AGAIN?`, {
      initial: false,
    });
    if (!confirm) {
      await processSafeExit();
    }
    return initializeKeychainSystem();
  }
};

export const freshRailgunWallet = async (
  mnemonic: string,
  isInitilization?: boolean,
): Promise<RailgunWalletInfo | undefined> => {
  try {
    walletManager.hashedPassword = await getSaltedPassword();
    if (!isDefined(walletManager.hashedPassword)) {
      throw new Error("Hashed Password Timed Out");
    }
    if (isInitilization) {
      const confirmed = await confirmGetPasswordPrompt(
        walletManager,
        {
          validate: (value: string) => {
            return value !== "" && value !== " " && value.length >= 8;
          },
        },
      );

      if (!confirmed) {
        throw new Error("Passwords Do Not Match.");
      }
    }
    console.log("Generating Wallet... this may take a few moments.".yellow);

    const wallet = await createRailgunWallet(
      walletManager.hashedPassword,
      mnemonic,
      undefined,
    ).catch((err) => {
      console.log(err.message);
      throw new Error("Failed to Initialize Railgun Wallet.");
    });
    return wallet;
  } catch (error) {
    const confirm = await confirmPrompt(`TRY AGAIN?`, {
      initial: false,
    });
    if (!confirm) {
      return undefined;
    }
    return freshRailgunWallet(mnemonic, isInitilization);
  }
};

export const initilizeFreshWallet = async (isInit = false) => {
  const walletInfo: TMPWalletInfo | undefined = await generateNewWalletPrompt();
  if (!walletInfo) {
    return undefined;
  }
  const railWalletInfo = await freshRailgunWallet(walletInfo.mnemonic, isInit);
  let wallet;
  if (isDefined(railWalletInfo)) {
    wallet = {
      railgunWalletID: railWalletInfo.id,
      railgunWalletAddress: railWalletInfo.railgunAddress,
      derivationIndex: walletInfo.derivationIndex,
      publicAddress: "",
    };
    walletManager.activeWalletName = walletInfo.walletName;
    walletManager.keyChain.selectedWallet = walletManager.activeWalletName;

    if (walletManager.keyChain.wallets) {
      walletManager.keyChain.wallets[walletManager.activeWalletName] = wallet;
    }

    walletManager.currentActiveWallet = wallet;

    walletManager.railgunWalletID = railWalletInfo.id;
    walletManager.railgunWalletAddress = railWalletInfo.railgunAddress;
    const { keyChainPath } = configDefaults.engine;
    saveKeychainFile(walletManager.keyChain, keyChainPath);
  } else {
    return undefined;
  }
  return wallet;
};

export const initializeEthersWallet = async () => {
  walletManager.hashedPassword = await getSaltedPassword();
  if (!isDefined(walletManager.hashedPassword)) {
    throw new Error("Hashed Password Timed Out");
  }

  if (walletManager.keyChain.wallets) {
    const currentWallet = walletManager.currentActiveWallet;
    const { railgunWalletID, derivationIndex } = currentWallet;
    const walletMnemonic = await getWalletMnemonic(
      walletManager.hashedPassword,
      railgunWalletID,
    );
    const ethersWallet = getEthersWallet(
      walletMnemonic,
      derivationIndex,
      walletManager.keyChain.currentNetwork ?? NetworkName.Ethereum,
    );
    walletManager.currentEthersWallet = ethersWallet;
    const { publicAddress } =
      walletManager.keyChain.wallets[walletManager.activeWalletName];
    if (!publicAddress) {
      walletManager.keyChain.wallets[
        walletManager.activeWalletName
      ].publicAddress = walletManager.currentEthersWallet.address;
      const { keyChainPath } = configDefaults.engine;
      saveKeychainFile(walletManager.keyChain, keyChainPath);
    }
  }
};

export const initRailgunWallet = async (): Promise<
  RailgunWalletInfo | undefined
> => {
  try {
    walletManager.hashedPassword = await getSaltedPassword("Enter Password:");
    if (!isDefined(walletManager.hashedPassword)) {
      throw new Error("Hashed Password Timed Out");
    }
    const wallet = await loadWalletByID(
      walletManager.hashedPassword,
      walletManager.railgunWalletID,
      false,
    );
    return wallet;
  } catch (error) {
    console.log((error as Error).message);
  }

  await processSafeExit();
};

export const setupWeb3Provider = (chainName: NetworkName) => {
  const providerURL = getProviderURLForChain(chainName);
  if (!isDefined(walletManager.web3)) {
    walletManager.web3 = new Web3(providerURL);
  } else {
    walletManager.web3.setProvider(providerURL);
  }
};

export const initializeWalletSystems = async () => {
  try {
    await initRailgunEngine();
  } catch (err) {
    console.log("engine init erro");
    walletManager.hashedPassword = undefined;
    walletManager.comparisonRefHash = undefined;
    initializeWalletSystems();
    return;
  }

  walletManager.keyChain = await initializeKeychainSystem();
  setOnBalanceUpdateCallback(scanBalancesCallback);
  setOnMerkletreeScanCallback(merkelTreeScanCallback);

  const currentNetwork =
    walletManager.keyChain.currentNetwork ?? NetworkName.Ethereum;
  initWakuClient()
    .then(async () => {
      await startWakuClient(currentNetwork);
    })
    .catch(async (err: Error) => {
      throw new Error(`WAKU Failed to Initialize. ${err.message}`);
    });

  walletManager.saltedPassword = walletManager.keyChain.salt;
  let wallet;
  if (!walletManager.keyChain.wallets) {
    walletManager.keyChain.wallets = {};

    wallet = await initilizeFreshWallet(true);
    if (wallet) {
      walletManager.currentActiveWallet = wallet;
    } else {
      throw new Error("Something strange happened during wallet generation.");
    }
  } else {
    importKnownAddressesFromWallet(
      walletManager.keyChain.wallets,
      walletManager.keyChain.knownAddresses,
    );
    const walletNames = Object.keys(walletManager.keyChain.wallets);
    walletManager.activeWalletName =
      walletManager.keyChain.selectedWallet ?? walletNames[0];
    walletManager.keyChain.selectedWallet = walletManager.activeWalletName;
    wallet = walletManager.keyChain.wallets[walletManager.activeWalletName];
    walletManager.currentActiveWallet = wallet;
    walletManager.railgunWalletID = wallet.railgunWalletID;
    walletManager.railgunWalletAddress = wallet.railgunWalletAddress;
    const railgunWalletResult = await initRailgunWallet();
  }
  if (walletManager.keyChain.cachedTokenInfo) {
    loadTokenDBCache(walletManager.keyChain.cachedTokenInfo);
  }

  if (isDefined(walletManager.keyChain.displayPrivate)) {
    walletManager.displayPrivate = walletManager.keyChain.displayPrivate;
  }
  if (isDefined(walletManager.keyChain.responsiveMenu)) {
    walletManager.responsiveMenu = walletManager.keyChain.responsiveMenu;
  }

  if (wallet) {
    await loadEngineProvidersForNetwork(currentNetwork);
    await initializeEthersWallet();
  }

  if (
    currentNetwork === NetworkName.Ethereum ||
    currentNetwork === NetworkName.Polygon
  ) {
    setupWeb3Provider(currentNetwork);
  }
};

export const reinitWalletForChain = async (chainName: NetworkName) => {
  resetBalanceCachesForChain(chainName);
  await loadEngineProvidersForNetwork(chainName);
  await initializeEthersWallet();
};
