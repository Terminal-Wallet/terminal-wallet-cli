import {
  RecipeERC20Amount,
  SwapQuoteData,
  ZeroXSwapRecipe,
  ZeroXV2SwapRecipe,
} from "@railgun-community/cookbook";
import { RailgunERC20Recipient } from "@railgun-community/shared-models";
import { ContractTransaction } from "ethers";

export type Zer0XSwapOutput = {
  sellUnshieldFee: bigint;
  buyAmount: bigint;
  buyMinimum: bigint;
  buyShieldFee: bigint;
};

export type Zer0XReadablePrices = {
  price: string;
  guaranteedPrice: string;
  sellFee: string;
  sellAmount: string;
  buyAmount: string;
  buyMinimum: string;
  buyFee: string;
};

export type Zer0XSwap = {
  recipe: Optional<ZeroXSwapRecipe | ZeroXV2SwapRecipe>;
  quote: Optional<SwapQuoteData>;
  swapAmounts: Zer0XSwapOutput;
  readableSwapPrices: Zer0XReadablePrices;
  relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[];
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[];
  crossContractCalls: ContractTransaction[];
  minGasLimit?: Optional<bigint>;
};

export type Zer0XSwapTokenInput = {
  tokenAddress: string;
  isBaseToken: boolean;
};

export type Zer0XSwapSelection = {
  amount: bigint;
  symbol: string;
  buySymbol: string;
  sellTokenAddress: string;
  buyTokenAddress: string;
};

export type Zer0XSwapSelectionInfo = {
  selections: Zer0XSwapSelection;
  zer0XInputs: Zer0XSwap;
};
