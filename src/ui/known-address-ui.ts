const { Input, Select, AutoComplete } = require("enquirer");
import { isDefined } from "@railgun-community/shared-models";
import { KnownAddressKey, WalletCache } from "../models/wallet-models";
import { getPrivateAddressPrompt, getPublicAddressPrompt } from "./address-ui";
import { confirmPromptCatch } from "./confirm-ui";
import { saveKeychainFile } from "../wallet/wallet-cache";
import { walletManager } from "../wallet/wallet-manager";
import configDefaults from "../config/config-defaults";
import { getCurrentWalletName } from "../wallet/wallet-util";

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
  knownAddresses?: KnownAddressKey[],
) => {
  const walletNames = Object.keys(wallets);
  for (const walletName of walletNames) {
    const { publicAddress, railgunWalletAddress } = wallets[walletName];
    updateKnownAddress(walletName, publicAddress, railgunWalletAddress, false);
  }
  if (isDefined(knownAddresses)) {
    for (const knownAddress of knownAddresses) {
      const { name, publicAddress, privateAddress } = knownAddress;
      updateKnownAddress(name, publicAddress, privateAddress);
    }
  }
};

export const getKnownAddressNamePrompt = async (
  nickName?: string,
): Promise<string | undefined> => {
  const prompt = new Input({
    header: " ",
    message: nickName ? `Change ${nickName}` : "Enter a Nickname:",
    validate: (name: string) => name.trim() !== "",
  });

  const result = await prompt.run().catch(confirmPromptCatch);
  if (result === false) return undefined;
  return result;
};

export const runAddKnownAddress = async () => {
  const addressChoices = getKnownAddressNames().map((a) => {
    const { allowEdit, publicAddress, privateAddress } =
      getKnownAddressInfoForName(a);
    return {
      name: a,
      message: allowEdit ? `Edit [${a}]` : `[${a}]`.padEnd(20, "."),
      disabled: allowEdit
        ? false
        : `Pub: [${publicAddress}] | Priv: [${privateAddress}]`,
    };
  });

  const knownAddressPrompt = new Select({
    header: " ",
    message: "Known Address Editor",
    choices: [
      ...addressChoices,
      { name: "add-new", message: "Add New" },
      { name: "exit-menu", message: "Go Back" },
    ],
    multiple: false,
  });
  const knownAddressOption = await knownAddressPrompt
    .run()
    .catch(confirmPromptCatch);

  if (knownAddressOption === "exit-menu") {
    return;
  }
  let selectedName;

  if (knownAddressOption === "add-new") {
    const newName = await getKnownAddressNamePrompt();
    if (isDefined(newName)) {
      selectedName = newName;
    } else {
      return;
    }
  } else {
    selectedName = knownAddressOption;
  }
  const { publicAddress: currentPublic, privateAddress: currentPrivate } =
    knownAddresses[selectedName] ?? {};

  const publicAddress = await getPublicAddressPrompt(
    currentPublic ? `Current: [${currentPublic}] | ` : "",
  );
  const privateAddress = await getPrivateAddressPrompt(
    currentPrivate ? `Current: [${currentPrivate}] | ` : "",
  );

  const newPublicAddress = publicAddress ?? currentPublic;
  const newPrivateAddress = privateAddress ?? currentPrivate;
  updateKnownAddress(selectedName, newPublicAddress, newPrivateAddress);
  await updateKnownAddresses();
};

export const runInputRailgunAddress = async (
  symbol: string,
  isShieldEvent: boolean,
) => {
  const names = getKnownAddressNames();

  let choices = ["Enter Address".dim, ...names];
  if (isShieldEvent) {
    choices = [...names, "Enter Address".dim];
  }

  const prompt = new AutoComplete({
    header: " ",
    message: `${symbol}Selecting Address for Private Transaction`,
    hint: "(input name of known address. <up arrow>/<down arrow> to navigate. <enter> to select.)",
    limit: choices.length,
    choices,
    format() {
      if (!this.focused) return this.input;

      if (this.state.submitted) {
        return "";
      }

      return this.input;
    },
  });

  const result = await prompt.run().catch(confirmPromptCatch);
  if (names.includes(result)) {
    const { privateAddress } = getKnownAddressInfoForName(result);
    return privateAddress;
  }
  if (result) {
    const addressResult = await getPrivateAddressPrompt(symbol);
    return addressResult;
  }
};

export const runInputPublicAddress = async (
  symbol: string,
  isShieldEvent: boolean,
) => {
  const names = getKnownAddressNames();
  let choices = ["Enter Address".dim, ...names];
  if (isShieldEvent) {
    choices = [...names, "Enter Address".dim];
  }
  const prompt = new AutoComplete({
    header: " ",
    message: `${symbol}Selecting Address for Public Transaction.`,
    hint: "(input name of known address. <up arrow>/<down arrow> to navigate. <enter> to select.)",
    limit: choices.length,
    choices,
    format() {
      if (!this.focused) return this.input;

      if (this.state.submitted) {
        return "";
      }

      return this.input;
    },
  });

  const result = await prompt.run().catch(confirmPromptCatch);
  if (names.includes(result)) {
    const { publicAddress } = getKnownAddressInfoForName(result);
    return publicAddress;
  }
  if (result) {
    const addressResult = await getPublicAddressPrompt(symbol);
    return addressResult;
  }
};
