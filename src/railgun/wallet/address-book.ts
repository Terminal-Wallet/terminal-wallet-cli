/**
 * Address-book cache (core) — extracted from ui/known-address-ui.ts so the
 * wallet boot (wallet-init) can import known-address data without pulling in a
 * prompt-heavy UI module. Pure state + persistence; no prompts, no UI.
 */
import { isDefined } from "@railgun-community/shared-models";
import { KnownAddressKey, WalletCache } from "../../models/wallet-models";
import { saveKeychainFile } from "./wallet-cache";
import { walletManager } from "./wallet-manager";
import configDefaults from "../../config/config-defaults";
import { getCurrentWalletName } from "./wallet-util";

export type KnownAddress = {
  publicAddress?: string;
  privateAddress?: string;
  allowEdit: boolean;
};

const knownAddresses: MapType<KnownAddress> = {};

export const getKnownAddressNames = () => {
  const currentWalletName = getCurrentWalletName();
  const nameList = Object.keys(knownAddresses).filter(
    (name) => currentWalletName !== name,
  );

  return [currentWalletName, ...nameList];
};

export const getKnownAddresses = () => {
  return knownAddresses;
};

export const updateKnownAddresses = async () => {
  const knownNames = getKnownAddressNames();
  const currentKnownAddresses = getKnownAddresses();
  const newKnownAddresses: KnownAddressKey[] = [];
  for (const name of knownNames) {
    const { allowEdit, publicAddress, privateAddress } =
      currentKnownAddresses[name];
    if (allowEdit) {
      newKnownAddresses.push({
        name,
        privateAddress,
        publicAddress,
      });
    }
  }
  walletManager.keyChain.knownAddresses = newKnownAddresses;
  const { keyChainPath } = configDefaults.engine;
  saveKeychainFile(walletManager.keyChain, keyChainPath);
};

export const getKnownAddressInfoForName = (keyName: string) => {
  return knownAddresses[keyName];
};

export const updateKnownAddress = (
  nickName: string,
  publicAddress?: string,
  privateAddress?: string,
  allowEdit = true,
) => {
  knownAddresses[nickName] = {
    publicAddress,
    privateAddress,
    allowEdit,
  };
};

export const importKnownAddressesFromWallet = (
  wallets: MapType<WalletCache>,
  savedKnownAddresses?: KnownAddressKey[],
) => {
  const walletNames = Object.keys(wallets);
  for (const walletName of walletNames) {
    const { publicAddress, railgunWalletAddress } = wallets[walletName];
    updateKnownAddress(walletName, publicAddress, railgunWalletAddress, false);
  }
  if (isDefined(savedKnownAddresses)) {
    for (const knownAddress of savedKnownAddresses) {
      const { name, publicAddress, privateAddress } = knownAddress;
      updateKnownAddress(name, publicAddress, privateAddress);
    }
  }
};
