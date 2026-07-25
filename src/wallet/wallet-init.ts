import { generateNewWalletPrompt } from "../ui/wallet-info-ui";
import { confirmPrompt } from "../ui/confirm-ui";
import {
  createRailgunWallet,
  getWalletMnemonic,
  loadWalletByID,
  setOnBalanceUpdateCallback,
  setOnUTXOMerkletreeScanCallback,
  setOnWalletPOIProofProgressCallback,
  setBatchListCallback,
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
import { processSafeExit } from "../platform/lifecycle";
import { getEthersWallet } from "../network/network-util";
import { walletManager } from "./wallet-manager";
import {
  scanBalancesCallback,
  merkelTreeScanCallback,
  poiScanCallback,
  batchListCallback
} from "./scan-callbacks";
import { getSaltedPassword } from "./wallet-password";
import { confirmGetPasswordPrompt } from "../ui/password-ui";
import { computePasswordHash, getIV } from "../platform/crypto";
import configDefaults from "../config/config-defaults";
import { createLogger } from "../platform/logger";

const log = createLogger("wallet-init");

export const generateKeychainPrompt = async (
  index: number = 0,
): Promise<KeychainFile> => {
  const saltIV = getIV();
  const salt = await computePasswordHash(saltIV, 32);

  if (isDefined(salt)) {
    const keychain: KeychainFile = {
      name: `.plasma_${index}`,
      salt: `0x${salt}`, // this is used to generate encryption key, computePasswordHash(inputPassword, salt)
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
    // Selecting between keychains needs the input seam; it lands with the
    // keychain work. Until then this is at least visible instead of silent.
    log.warn(
      `${keychains.length} keychains found; using ${keychains[0].name}. ` +
        "Selecting between them is not implemented yet.",
    );
    return keychains[0];
  }
  try {
    const keychain = await generateKeychainPrompt();

    saveKeychainFile(keychain, keyChainPath);

    return keychain;
  } catch (error) {
    log.error("keychain initialization failed", error);
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
      const confirmed = await confirmGetPasswordPrompt(walletManager, {
        validate: (value: string) => {
          return value !== "" && value !== " " && value.length >= 8;
        },
      });

      if (!confirmed) {
        throw new Error("Passwords Do Not Match.");
      }
    }
    log.info("generating wallet; this may take a few moments");

    const wallet = await createRailgunWallet(
      walletManager.hashedPassword,
      mnemonic,
      undefined,
    ).catch((err: unknown) => {
      log.error("createRailgunWallet failed", err);
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
    log.error("failed to load the railgun wallet", error);
  }

  await processSafeExit(1);
};

export const initializeWalletSystems = async () => {
  try {
    await initRailgunEngine();
  } catch (err) {
    // Engine init failing used to clear the password and call this function
    // again — unbounded recursion on a failure that is almost never transient
    // (a held LevelDB lock, a missing artifact path). Fail fast instead: the
    // wallet cannot do anything useful without an engine.
    log.error("railgun engine failed to initialize", err);
    walletManager.hashedPassword = undefined;
    walletManager.comparisonRefHash = undefined;
    throw err;
  }

  walletManager.keyChain = await initializeKeychainSystem();
  setBatchListCallback(batchListCallback)
  setOnBalanceUpdateCallback(scanBalancesCallback);
  setOnUTXOMerkletreeScanCallback(merkelTreeScanCallback);
  setOnWalletPOIProofProgressCallback(poiScanCallback);

  const currentNetwork =
    walletManager.keyChain.currentNetwork ?? NetworkName.Ethereum;

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
    if(isDefined(walletManager.keyChain.showSenderAddress)){
      walletManager.showSenderAddress = walletManager.keyChain.showSenderAddress;
    }
    const railgunWalletResult = await initRailgunWallet();
  }

  // Wallet has been loded; initalize waku now to avoid console message flooding password input.
  initWakuClient()
    .then(async () => {
      await startWakuClient(currentNetwork);
    })
    .catch((err: unknown) => {
      // Deliberately not awaited, so waku never blocks the password prompt. But
      // the previous `throw` here landed inside a detached promise: it became an
      // unhandled rejection that boot's caller never saw, so a wallet with no
      // broadcaster connection looked like a wallet that booted fine. Report it.
      log.error("waku failed to initialize; broadcasters unavailable", err);
    });
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
};

export const reinitWalletForChain = async (chainName: NetworkName) => {
  resetBalanceCachesForChain(chainName);
  await loadEngineProvidersForNetwork(chainName);
  await initializeEthersWallet();
};
