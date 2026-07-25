/**
 * Swap-quote formatting — pure decimal conversion, no prompts and no styling.
 *
 * It lived in the swap prompt module, so the swap transaction core imported a
 * prompt-heavy renderer file purely to format numbers. That was the last thing
 * making the transaction layer unable to run without a terminal attached.
 */
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { SwapQuoteData } from "@railgun-community/cookbook";
import { Zer0XSwapOutput } from "../../../models/0x-models";
import { getTokenInfo } from "../../balance/token-util";

export const getReadablePricesFromQuote = async (
  chainName: NetworkName,
  quote: Optional<SwapQuoteData>,
  swapAmounts: Zer0XSwapOutput,
) => {
  //
  if (!isDefined(quote)) {
    throw new Error("No Quote Availble.");
  }
  const {
    price,
    guaranteedPrice,
    buyERC20Amount,
    sellTokenAddress,
    sellTokenValue,
  } = quote;
  const { decimals } = buyERC20Amount;
  const { decimals: sellTokenDecimals } = await getTokenInfo(
    chainName,
    sellTokenAddress,
  );
  // rc.1: quote price/guaranteedPrice are denominated in the sell token's decimals
  // (getSwapQuote uses parseUnits(..., sellERC20Amount.decimals)), not a fixed constant.
  const fPrice = formatUnits(price, sellTokenDecimals);
  const fGuaranteedPrice = formatUnits(guaranteedPrice, sellTokenDecimals);
  const {
    sellUnshieldFee: sellFee,
    buyAmount,
    buyMinimum,
    buyShieldFee: buyFee,
  } = swapAmounts;

  const fSellFee = formatUnits(sellFee, sellTokenDecimals);
  const fSellAmount = formatUnits(BigInt(sellTokenValue), sellTokenDecimals);
  const fBuyAmount = formatUnits(buyAmount, decimals);
  const fBuyMinimum = formatUnits(buyMinimum, decimals);
  const fBuyFee = formatUnits(buyFee, decimals);

  return {
    price: fPrice,
    guaranteedPrice: fGuaranteedPrice,
    sellFee: fSellFee,
    sellAmount: fSellAmount,
    buyAmount: fBuyAmount,
    buyMinimum: fBuyMinimum,
    buyFee: fBuyFee,
  };
};
