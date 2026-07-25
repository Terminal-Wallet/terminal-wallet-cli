import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits, parseUnits } from "ethers";
import { confirmPromptCatch } from "./confirm-ui";
import { tokenSelectionPrompt } from "./token-ui";
import { getTokenAmountSelectionPrompt, runAddTokenPrompt } from "./token-ui";
import {
  TokenChainInfo,
  getERC20TokenInfosForChain,
  getTokenInfo,
} from "../railgun/balance/token-util";
import { SwapQuoteData } from "@railgun-community/cookbook";
import { Zer0XSwapOutput, Zer0XSwapSelection } from "../models/0x-models";
import { getWrappedTokenInfoForChain } from "../railgun/network/network-util";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select } = require("enquirer");

export const runSwapBuyTokenSelectionPrompt = async (
  chainName: NetworkName,
  sellTokenSymbol: string,
  isPublic: boolean = false,
): Promise<TokenChainInfo | undefined> => {
  const availableTokens = (await getERC20TokenInfosForChain(chainName)).filter(
    (a) => {
      return a.symbol !== sellTokenSymbol;
    },
  );
  const choices = availableTokens.map((token: TokenChainInfo, i) => {
    return {
      value: `${token.symbol}`,
      message: `[${token.symbol.cyan}] ${token.name}`,
    };
  });
  const wrappedInfo = getWrappedTokenInfoForChain(chainName);

  let buyChoices = [];
  if (!isPublic) {
    buyChoices = [...choices, { name: "add-token", message: "Add Token" }];
  } else {
    buyChoices = [
      {
        value: wrappedInfo.symbol,
        message: `[${wrappedInfo.symbol.cyan}] ${wrappedInfo.shortPublicName}`,
      },
      ...choices,
      { name: "add-token", message: "Add Token" },
    ];
  }

  const prompt = new Select({
    header: " ",
    message: "Select Token to Swap Into",
    choices: buyChoices,
  });
  const result = await prompt.run().catch(confirmPromptCatch);
  if (result) {
    if (result === "add-token") {
      await runAddTokenPrompt(chainName);

      return runSwapBuyTokenSelectionPrompt(
        chainName,
        sellTokenSymbol,
        isPublic,
      );
    }

    if (result === wrappedInfo.symbol) {
      const wrappedResult = {
        tokenAddress: wrappedInfo.wrappedAddress,
        name: wrappedInfo.shortPublicName,
        decimals: wrappedInfo.decimals,
        symbol: wrappedInfo.symbol,
      };
      return wrappedResult;
    }

    const selectedBuyToken = availableTokens.find((a) => {
      return a.symbol === result;
    });
    return selectedBuyToken;
  }
  return undefined;
};

export const runSwapTokenSelectionPrompt = async (
  chainName: NetworkName,
  publicTransfer: boolean = false,
): Promise<Zer0XSwapSelection | undefined> => {
  const transferType = publicTransfer ? "Publicly" : "Privately";

  const swapSelection = await tokenSelectionPrompt(
    chainName,
    `Swap ERC20 Tokens ${transferType}`,
    false,
    publicTransfer,
    undefined,
    publicTransfer,
  );

  if (!isDefined(swapSelection)) {
    return undefined;
  }

  const { amount, amountReadable, symbol, decimals } = swapSelection;

  const currentMax = formatUnits(amount, decimals);
  const swapSellAmount = await getTokenAmountSelectionPrompt(
    swapSelection,
    currentMax,
  );

  if (!isDefined(swapSellAmount)) {
    return undefined;
  }
  const buyERC20TokenInfo = await runSwapBuyTokenSelectionPrompt(
    chainName,
    symbol,
    publicTransfer,
  );
  if (!isDefined(buyERC20TokenInfo)) {
    return undefined;
  }

  const bnSwapSellAmount = parseUnits(swapSellAmount, swapSelection.decimals);

  const sellTokenAddress = swapSelection.tokenAddress;
  const buyTokenAddress = buyERC20TokenInfo.tokenAddress;

  return {
    amount: bnSwapSellAmount,
    symbol,
    buySymbol: buyERC20TokenInfo.symbol,
    sellTokenAddress,
    buyTokenAddress,
  };
};

// Formatting moved to the transaction layer so the swap core need not import
// this module. Re-exported for existing call sites.
export { getReadablePricesFromQuote } from "../railgun/transaction/zeroX/swap-format";
