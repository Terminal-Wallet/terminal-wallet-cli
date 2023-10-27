import {
  RecipeERC20Amount,
  RecipeERC20Info,
  RecipeInput,
  RecipeOutput,
  SwapQuoteData,
  SwapQuoteParams,
  ZeroXConfig,
  ZeroXQuote,
  ZeroXSwapRecipe,
} from "@railgun-community/cookbook";
import {
  NetworkName,
  RailgunERC20Recipient,
  RailgunPopulateTransactionResponse,
  SelectedRelayer,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import configDefaults from "../../config/config-defaults";
import {
  gasEstimateForUnprovenCrossContractCalls,
  generateCrossContractCallsProof,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
  getCurrentWalletPublicAddress,
} from "../../wallet/wallet-util";
import { getOutputGasEstimate } from "../private/unshield-tx";
import {
  PrivateGasDetails,
  PrivateGasEstimate,
} from "../../models/transaction-models";
import { ProgressBar } from "../../ui/progressBar-ui";
import { calculatePublicTransactionGasDetais } from "../public/public-tx";
import { getCurrentNetwork } from "../../engine/engine";
import { ContractTransaction } from "ethers";
import { getTokenInfo } from "../../balance/token-util";
import { getReadablePricesFromQuote } from "../../ui/zer0x-ui";
import {
  Zer0XSwap,
  Zer0XSwapOutput,
  Zer0XSwapTokenInput,
} from "../../models/0x-models";
import { getTransactionGasDetails } from "../private/private-tx";

const zeroXApiKey = configDefaults.apiKeys.zeroXApi;
ZeroXConfig.API_KEY = zeroXApiKey;

export const getZer0XSwapInputs = async (
  chainName: NetworkName,
  sellTokenInput: Zer0XSwapTokenInput,
  buyTokenInput: Zer0XSwapTokenInput,
  amount: bigint,
  slippagePercentage = 0.05,
  isPublic = false,
): Promise<Zer0XSwap> => {
  const { decimals: sellTokenDecimals } = await getTokenInfo(
    chainName,
    sellTokenInput.tokenAddress,
  );
  const { decimals: buyTokenDecimals } = await getTokenInfo(
    chainName,
    buyTokenInput.tokenAddress,
  );

  const sellERC20Info: RecipeERC20Info = {
    ...sellTokenInput,
    decimals: BigInt(sellTokenDecimals),
  };

  const buyERC20Info: RecipeERC20Info = {
    ...buyTokenInput,
    decimals: BigInt(buyTokenDecimals),
  };

  const relayAdaptUnshieldERC20Amounts = [{ ...sellERC20Info, amount }];

  // PRIVATE SWAP FUNCTIONS
  if (!isPublic) {
    // FORCE US AS RECIPIENT FOR NOW
    const privateSwapRecipient = getCurrentRailgunAddress();

    const swap = new ZeroXSwapRecipe(
      sellERC20Info,
      buyERC20Info,
      BigInt(slippagePercentage),
      privateSwapRecipient,
    );
    const recipeInput: RecipeInput = {
      networkName: chainName,
      railgunAddress: privateSwapRecipient,
      erc20Amounts: relayAdaptUnshieldERC20Amounts,
      nfts: [],
    };
    const { minGasLimit } = swap.config;
    const recipeOutput: RecipeOutput = await swap.getRecipeOutput(recipeInput);
    const { crossContractCalls, erc20AmountRecipients } = recipeOutput;

    const relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] =
      erc20AmountRecipients.map((shieldAmount) => {
        const { tokenAddress } = shieldAmount;
        return { tokenAddress, recipientAddress: privateSwapRecipient };
      });

    const swapAmounts = swap.getBuySellAmountsFromRecipeOutput(
      recipeOutput,
    ) as Zer0XSwapOutput;
    const quote = swap.getLatestQuote();

    const readableSwapPrices = await getReadablePricesFromQuote(
      chainName,
      quote,
      swapAmounts,
    );

    return {
      recipe: swap,
      quote,
      swapAmounts,
      readableSwapPrices,
      relayAdaptUnshieldERC20Amounts,
      relayAdaptShieldERC20Addresses,
      crossContractCalls,
      minGasLimit,
    };
  }
  const quoteParams: SwapQuoteParams = {
    networkName: chainName,
    sellERC20Amount: relayAdaptUnshieldERC20Amounts[0],
    buyERC20Info,
    slippageBasisPoints: BigInt(slippagePercentage),
    isRailgun: false,
  };
  const quote = await ZeroXQuote.getSwapQuote(quoteParams);
  const swapAmounts: Zer0XSwapOutput = {
    sellUnshieldFee: 0n,
    buyShieldFee: 0n,
    buyAmount: quote.buyERC20Amount.amount,
    buyMinimum: quote.minimumBuyAmount,
  };

  const readableSwapPrices = await getReadablePricesFromQuote(
    chainName,
    quote,
    swapAmounts,
  );
  return {
    recipe: undefined,
    quote,
    swapAmounts,
    readableSwapPrices,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses: [],
    crossContractCalls: [quote.crossContractCall],
  };
};

export const getSwapQuote = async (
  chainName: NetworkName,
  sellERC20Amount: RecipeERC20Amount,
  buyERC20Info: RecipeERC20Info,
  slippagePercentage = 0.05,
): Promise<SwapQuoteData> => {
  const quoteParams: SwapQuoteParams = {
    networkName: chainName,
    sellERC20Amount,
    buyERC20Info,
    slippageBasisPoints: BigInt(slippagePercentage),
    isRailgun: true,
  };
  const quote = await ZeroXQuote.getSwapQuote(quoteParams);
  return quote;
};

export const getZer0XSwapTransactionGasEstimate = async (
  chainName: NetworkName,
  zer0XSwapInputs: Zer0XSwap,
  encryptionKey: string,
  relayerSelection?: SelectedRelayer,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const gasDetailsResult = await getTransactionGasDetails(
    chainName,
    relayerSelection,
  );

  if (!gasDetailsResult) {
    console.log("Failed to get Gas Details for Transaction");
    return undefined;
  }

  const {
    originalGasDetails,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
    overallBatchMinGasPrice,
  } = gasDetailsResult as PrivateGasDetails;

  const {
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    crossContractCalls,
    minGasLimit,
  } = zer0XSwapInputs;

  const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls(
    txIDVersion,
    chainName,
    railgunWalletID,
    encryptionKey,
    relayAdaptUnshieldERC20Amounts,
    [],
    relayAdaptShieldERC20Addresses,
    [],
    crossContractCalls,
    originalGasDetails,
    feeTokenDetails,
    sendWithPublicWallet,
    minGasLimit,
  );
  return await getOutputGasEstimate(
    originalGasDetails,
    gasEstimate,
    feeTokenInfo,
    feeTokenDetails,
    relayerSelection,
    overallBatchMinGasPrice,
  );
};

export const getProvedZer0XSwapTransaction = async (
  encryptionKey: string,
  zer0XSwapInputs: Zer0XSwap,
  privateGasEstimate: PrivateGasEstimate,
): Promise<Optional<RailgunPopulateTransactionResponse>> => {
  const chainName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const progressBar = new ProgressBar("Starting Proof Generation");
  const progressCallback = (progress: number, progressStats: string) => {
    if (isDefined(progressStats)) {
      progressBar.updateProgress(
        `Transaction Proof Generation | [${progressStats}]`,
        progress,
      );
    } else {
      progressBar.updateProgress(`Transaction Proof Generation`, progress);
    }
  };

  const {
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    crossContractCalls,
    minGasLimit,
  } = zer0XSwapInputs;

  const {
    relayerFeeERC20Recipient,
    overallBatchMinGasPrice,
    estimatedGasDetails,
  } = privateGasEstimate as PrivateGasEstimate;
  const sendWithPublicWallet =
    typeof relayerFeeERC20Recipient !== "undefined" ? false : true;
  try {
    await generateCrossContractCallsProof(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      relayAdaptUnshieldERC20Amounts,
      [],
      relayAdaptShieldERC20Addresses,
      [],
      crossContractCalls,
      relayerFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      minGasLimit,
      progressCallback,
    )
      .catch((err) => {
        console.log("We errored out");
      })
      .finally(() => {
        progressBar.complete();
      });

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedCrossContractCalls(
        txIDVersion,
        chainName,
        railgunWalletID,
        relayAdaptUnshieldERC20Amounts,
        [],
        relayAdaptShieldERC20Addresses,
        [],
        crossContractCalls,
        relayerFeeERC20Recipient,
        sendWithPublicWallet,
        overallBatchMinGasPrice,
        estimatedGasDetails,
      );

    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (err) {
    const error = err as Error;
    console.log(error.message);
  }
};

export const calculateGasForPublicSwapTransaction = async (
  chainName: NetworkName,
  transaction: ContractTransaction,
) => {
  const from = getCurrentWalletPublicAddress();
  const finalTransaction = { ...transaction, from };

  const { privateGasEstimate, populatedTransaction } =
    await calculatePublicTransactionGasDetais(chainName, finalTransaction);

  return { privateGasEstimate, populatedTransaction };
};
