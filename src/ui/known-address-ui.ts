import {
  KnownAddress,
  getKnownAddressNames,
  getKnownAddresses,
  getKnownAddressInfoForName,
  updateKnownAddress,
  updateKnownAddresses,
} from "../railgun/wallet/address-book";

// Re-exported so the existing prompt call sites keep working; the state and
// persistence live in the wallet layer now, not here.
export {
  getKnownAddressNames,
  getKnownAddresses,
  getKnownAddressInfoForName,
  updateKnownAddress,
  updateKnownAddresses,
  importKnownAddressesFromWallet,
} from "../railgun/wallet/address-book";

const { Input, Select, AutoComplete } = require("enquirer");
import { isDefined } from "@railgun-community/shared-models";
import { KnownAddressKey, WalletCache } from "../models/wallet-models";
import { getPrivateAddressPrompt, getPublicAddressPrompt } from "./address-ui";
import { confirmPromptCatch } from "./confirm-ui";
import { walletManager } from "../railgun/wallet/wallet-manager";
import configDefaults from "../config/config-defaults";
import { getCurrentWalletName } from "../railgun/wallet/wallet-util";

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
    getKnownAddresses()[selectedName] ?? {};

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
