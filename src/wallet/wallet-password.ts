import { getPasswordPrompt } from "../ui/password-ui";
import { isDefined } from "@railgun-community/shared-models";
import { hashString } from "../util/crypto";
import { walletManager } from "./wallet-manager";

export const clearHashedPassword = () => {
  walletManager.hashedPassword = undefined;
};

export const getSaltedPassword = async (
  overrideMessage?: string,
): Promise<string | undefined> => {
  if (walletManager.hashedPassword) {
    return walletManager.hashedPassword;
  }

  try {
    walletManager.hashedPassword = await getPasswordPrompt(
      overrideMessage ?? "Enter your password:",
      {
        validate: (value: string) => {
          return value !== "" && value !== " " && value.length >= 8;
        },
      },
      walletManager.saltedPassword,
    );
    if (!isDefined(walletManager.hashedPassword)) {
      throw new Error("No Password Entered.");
    }

    if (!isDefined(walletManager.comparisonRefHash)) {
      walletManager.comparisonRefHash = hashString(
        walletManager.hashedPassword,
      );
    } else {
      const comparisonRef = hashString(walletManager.hashedPassword);
      if (comparisonRef != walletManager.comparisonRefHash) {
        clearHashedPassword();
        throw new Error("Password Incorrect.");
      }
    }

    return walletManager.hashedPassword;
  } catch (error) {
    console.log((error as Error).message);
    walletManager.comparisonRefHash = undefined;
    walletManager.hashedPassword = undefined;
    return undefined;
  }
};
