import { computePasswordHash } from "../util/crypto";
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
  expectedHash: string,
  options?: object,
): Promise<boolean> => {
  const refPassword = await getPasswordPrompt(
    "Confirm your password:",
    options,
  );

  if (refPassword) {
    return refPassword === expectedHash;
  }

  return false;
};
