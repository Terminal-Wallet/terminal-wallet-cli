import { NetworkName } from "@railgun-community/shared-models";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select } = require("enquirer");


// UNUSED
export const networkSelectionPrompt = async (): Promise<NetworkName> => {
  const prompt = new Select({
    header: " ",
    message: "Select Chain",
    choices: [
      "Ethereum",
      "Binance Smart Chain",
      "Polygon",
      "Arbitrum",
      "EthereumSepolia",
    ],
  });

  const result = await prompt.run();
  if (result) {
    return result as NetworkName;
  }
  return NetworkName.Ethereum;
};
