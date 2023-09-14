import { isDefined } from "@railgun-community/shared-models";
import { computePasswordHash, hashString } from "../util/crypto";
import { WalletManager } from "../wallet/wallet-manager";
import { confirmPrompt } from "./confirm-ui";
const { Password } = require("enquirer");

export const getPasswordPrompt = async (
  message: string,
  _options?: object,
  passwordSalt?: string,
): Promise<string | undefined> => {
  const options = _options ?? {};

  const prompt = new Password({
    header: " ",
    name: "password",
    message,
    ...options,
  });

  const result = await prompt.run().catch(async (err: any) => {
    const confirm = await confirmPrompt(`Do you wish to continue?`, {
      initial: true,
    });
    if (confirm) {
      return getPasswordPrompt(message, _options, passwordSalt);
    }
    return false;
  });
  if (result) {
    return await computePasswordHash(result, 32, passwordSalt);
  }
  return undefined;
};

export const confirmGetPasswordPrompt = async (
  walletManager: WalletManager,
  options?: object,
): Promise<boolean> => {
  const refPassword = await getPasswordPrompt(
    "Confirm your password:",
    {
      validate: (value: string) => {
        return value !== "" && value !== " " && value.length >= 8;
      },
    },
    walletManager.saltedPassword,
  );
  if (isDefined(refPassword)) {
    const computedHash = await hashString(refPassword);
    return computedHash === walletManager.comparisonRefHash;
  }

  return false;
};
