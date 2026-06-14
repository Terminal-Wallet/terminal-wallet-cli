import { HDNodeWallet, Mnemonic } from "ethers";
import { SignerId, TMPWalletInfo } from "../models/wallet-models";
import { confirmPrompt, confirmPromptCatch } from "./confirm-ui";
import { deriveRailgunSeedFromExternalSigner } from "../wallet/signer/seed-derivation";
import {
  getSignerBackend,
  listExternalSignerBackends,
} from "../wallet/signer/registry";
const { Input, NumberPrompt, Select, Password } = require("enquirer");

export const getWalletNamePrompt = async () => {
  const prompt = new Input({
    header: " ",
    message: "Wallet Name:",
    validate: (name: string) => name.trim() !== "",
  });

  const result = await prompt.run().catch(confirmPromptCatch);
  return result;
};

export const getMnemonicPrompt = async () => {
  const prompt = new Password({
    header: " ",
    message: "Wallet Mnemonic:",
    validate: (mnemonic: string) => {
      return Mnemonic.isValidMnemonic(mnemonic);
    },
  });

  const result = await prompt.run().catch(confirmPromptCatch);
  return result;
};

export const getDerivationIndex = async () => {
  const prompt = new NumberPrompt({
    header: " ",
    message: `Derivation Index:`,
    initial: 0,
    min: 0,
  });

  const result = await prompt.run().catch(confirmPromptCatch);
  return result;
};

const connectExternalSignerPrompt = async (
  walletName: string,
  signerId: SignerId,
  derivationIndex: number,
): Promise<TMPWalletInfo | undefined> => {
  const backend = await getSignerBackend(signerId);

  let addressIndex = derivationIndex;
  const selectIndex = await confirmPrompt(
    "Select Address Index? -- Default: 0",
  );
  if (selectIndex) {
    const selectedIndex = await getDerivationIndex();
    if (selectedIndex === false) {
      return undefined;
    }
    addressIndex = selectedIndex;
  }

  try {
    console.log(
      `Connect your ${backend.label} and confirm the prompts on the device...`
        .cyan,
    );
    const { mnemonic: derivedSeed, publicAddress } =
      await deriveRailgunSeedFromExternalSigner(signerId, addressIndex);
    return {
      mnemonic: derivedSeed,
      walletName,
      derivationIndex: addressIndex,
      signer: signerId,
      publicAddress,
    };
  } catch (error) {
    console.log((error as Error).message.red);
    const retry = await confirmPrompt("Try Again?", { initial: false });
    if (retry) {
      return connectExternalSignerPrompt(walletName, signerId, addressIndex);
    }
    return undefined;
  }
};

export const generateNewWalletPrompt = async (
  _walletName?: string,
  _walletMnemonic?: string,
  _walletIndex = 0,
): Promise<TMPWalletInfo | undefined> => {
  const externalBackends = await listExternalSignerBackends();
  const generateOptionPrompt = new Select({
    header: " ",
    message: "Wallet Generation",
    choices: [
      { name: "new-wallet", message: "New Wallet" },
      { name: "import-seed", message: "Import Seed" },
      ...externalBackends.map((backend) => ({
        name: `signer:${backend.id}`,
        message: backend.label,
      })),
    ],
    multiple: false,
  });
  const generateOption = await generateOptionPrompt
    .run()
    .catch(confirmPromptCatch);

  let mnemonic = _walletMnemonic;
  let walletName = _walletName;
  let derivationIndex = _walletIndex;
  if (!generateOption) {
    return undefined;
  }

  if (!walletName) {
    const newWalletName = await getWalletNamePrompt();
    if (newWalletName) {
      walletName = newWalletName;
    } else {
      return undefined;
    }
  }

  if (generateOption.startsWith("signer:")) {
    if (!walletName) {
      return undefined;
    }
    const signerId = generateOption.replace("signer:", "") as SignerId;
    return connectExternalSignerPrompt(walletName, signerId, derivationIndex);
  }

  if (generateOption && !mnemonic) {
    switch (generateOption) {
      case "new-wallet": {
        const newEthersWallet = HDNodeWallet.createRandom();
        mnemonic = newEthersWallet.mnemonic?.phrase;

        break;
      }
      case "import-seed": {
        const seedWalletMnemonic = await getMnemonicPrompt();
        if (seedWalletMnemonic) {
          mnemonic = seedWalletMnemonic;
        }
        break;
      }

      default:
        break;
    }
  }
  const selectIndex = await confirmPrompt(
    "Select Address Index? -- Default: 0",
  );
  if (selectIndex) {
    const selectedIndex = await getDerivationIndex();
    if (selectedIndex !== false) {
      derivationIndex = selectedIndex;
    } else {
      return undefined;
    }
  }
  if (
    mnemonic === undefined ||
    walletName === undefined ||
    derivationIndex === undefined
  ) {
    console.log("There was an issue! Please Try Again!");
    return generateNewWalletPrompt(walletName, mnemonic, derivationIndex);
  }

  return {
    mnemonic,
    walletName,
    derivationIndex,
  };
};
