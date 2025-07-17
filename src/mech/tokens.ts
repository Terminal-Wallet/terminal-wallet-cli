import { ZeroAddress } from "ethers";
import { NetworkName } from "@railgun-community/shared-models";
import {
  tokenAmountSelectionPrompt,
  tokenSelectionPrompt,
} from "../ui/token-ui";
import { Balances } from "./pilot";

export const promptTokenBalances = async (
  chainName: NetworkName,
): Promise<Balances> => {
  const selections = await tokenSelectionPrompt(
    chainName,
    `Select tokens to move into the mech`,
    true, // select multiple tokens
  );

  const amountSelections = await tokenAmountSelectionPrompt(
    selections,
    false, // private transfer
    true, // single recipient
    false,
    ZeroAddress, // don't ask for recipient address
  );

  return amountSelections.reduce((acc, selection) => {
    acc[selection.tokenAddress as `0x${string}`] = selection.selectedAmount;
    return acc;
  }, {} as Balances);
};
