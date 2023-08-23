import {
  validateEthAddress,
  validateRailgunAddress,
} from "@railgun-community/wallet";
import { confirmPromptCatch } from "./confirm-ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Input } = require("enquirer");

export const getPrivateAddressPrompt = async (symbol: string) => {
  const prompt = new Input({
    header: " ",
    message: `${symbol} Please enter a 0zk Address.`,
    validate: (value: string) => {
      return validateRailgunAddress(value);
    },
  });

  const resultAddress = await prompt.run().catch(confirmPromptCatch);

  if (resultAddress) {
    return resultAddress;
  }
  return undefined;
};
export const getPublicAddressPrompt = async (symbol: string) => {
  const prompt = new Input({
    header: " ",
    message: `${symbol} Please enter a 0x PUBLIC Address.`,
    validate: (value: string) => {
      return validateEthAddress(value);
    },
  });

  const resultAddress = await prompt.run().catch(confirmPromptCatch);

  if (resultAddress) {
    return resultAddress;
  }
  return undefined;
};

export const getFormattedAddress = (railgunAddress: string) => {
  const formatted = `${railgunAddress.slice(0, 5)}...${railgunAddress.slice(
    -5,
  )}`;
  return formatted;
};
