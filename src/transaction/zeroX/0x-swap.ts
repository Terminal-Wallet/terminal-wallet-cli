import {
  RecipeERC20Amount,
  RecipeERC20Info,
  RecipeInput,
  RecipeOutput,
  ZeroXConfig,
  ZeroXV2SwapRecipe,
  ZeroXV2Quote,
  SwapQuoteDataV2,
  SwapQuoteParamsV2,
} from "@railgun-community/cookbook";
import {
  EVMGasType,
  NetworkName,
  RailgunERC20Recipient,
  RailgunPopulateTransactionResponse,
  SelectedBroadcaster,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import configDefaults from "../../config/config-defaults";
import {
  gasEstimateForUnprovenCrossContractCalls7702,
  generateCrossContractCallsProof7702,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
  getCurrentWalletPublicAddress,
} from "../../wallet/wallet-util";
import {
  syncEphemeralIndexOnce,
  getCurrentEphemeralInfo,
} from "../../wallet/ephemeral-util";
import { getSaltedPassword } from "../../wallet/wallet-password";
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
import { getCurrentEthersWallet } from "../../wallet/public-utils";

export const updateApiKey = () => {
  const zeroXApiKey = configDefaults.apiKeys.zeroXApi;
  ZeroXConfig.API_KEY = zeroXApiKey;
};
export const getSwapQuote = async (
  chainName: NetworkName,
  sellERC20Amount: RecipeERC20Amount,
  buyERC20Info: RecipeERC20Info,
  slippagePercentage = 500,
  isRailgun = false,
  activeWalletAddress?: string,
): Promise<SwapQuoteDataV2> => {
  const quoteParams: SwapQuoteParamsV2 = {
    networkName: chainName,
    sellERC20Amount,
    buyERC20Info,
    slippageBasisPoints: slippagePercentage,
    isRailgun,
    // rc.1 renamed the taker field to `recipient` (required): getQuoteParams sets
    // taker/txOrigin = recipient directly. For a public swap this is the user's own wallet.
    recipient: activeWalletAddress as string,
  };
  const quote = await ZeroXV2Quote.getSwapQuote(quoteParams);

  return quote;
};

// The stock 0x V2 recipe fetches its swap quote with taker/txOrigin defaulting to the
// network's relayAdaptContract (see ZeroXV2Quote.getQuoteParams). Under EIP-7702 the
// relay-adapt code executes *as the ephemeral EOA*, so the swap's on-chain taker/recipient
// must be that ephemeral address — otherwise the bought tokens are routed to the
// (non-executing) relay-adapt contract and the downstream shield step operates on the wrong
// account. This subclass injects the ephemeral address as the quote's activeWalletAddress so
// the generated cross-contract calls target it.
class Ephemeral7702ZeroXV2SwapRecipe extends ZeroXV2SwapRecipe {
  private readonly ephemeralAddress: string;
  private readonly buyERC20InfoForQuote: RecipeERC20Info;
  private readonly slippageBasisPointsForQuote: number;

  constructor(
    sellERC20Info: RecipeERC20Info,
    buyERC20Info: RecipeERC20Info,
    slippageBasisPoints: number,
    destinationAddress: string,
    ephemeralAddress: string,
  ) {
    super(sellERC20Info, buyERC20Info, slippageBasisPoints, destinationAddress);
    this.ephemeralAddress = ephemeralAddress;
    this.buyERC20InfoForQuote = buyERC20Info;
    this.slippageBasisPointsForQuote = slippageBasisPoints;
  }

  async getSwapQuote(
    networkName: NetworkName,
    sellERC20Amount: RecipeERC20Amount,
  ): Promise<SwapQuoteDataV2> {
    // The 0x quote's taker/txOrigin must be the ephemeral EOA that the 7702 relay-adapt
    // executes as — otherwise the calldata routes the bought tokens to the network's
    // relayAdaptContract (observed on-chain). rc.1 exposes this as the required `recipient`
    // field (getQuoteParams sets taker/txOrigin = recipient), so we pass it explicitly. No
    // isRailgun coupling anymore — keep isRailgun:true for correct proxy routing.
    return ZeroXV2Quote.getSwapQuote({
      networkName,
      sellERC20Amount,
      buyERC20Info: this.buyERC20InfoForQuote,
      slippageBasisPoints: this.slippageBasisPointsForQuote,
      isRailgun: true,
      recipient: this.ephemeralAddress,
    });
  }
}

export const getZer0XSwapInputs = async (
  chainName: NetworkName,
  sellTokenInput: Zer0XSwapTokenInput,
  buyTokenInput: Zer0XSwapTokenInput,
  amount: bigint,
  slippageBasisPoints = 500,
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

    // Derive the ephemeral EOA that the 7702 relay-adapt will execute as, so the swap quote
    // is built with that address as taker/recipient (not the relay-adapt contract). Sync the
    // ephemeral index first so this address matches the one the proof/submission derive.
    const encryptionKey = await getSaltedPassword();
    if (!isDefined(encryptionKey)) {
      throw new Error("Cannot build private swap: wallet is locked.");
    }
    await syncEphemeralIndexOnce(chainName, encryptionKey);
    const { address: ephemeralAddress } = await getCurrentEphemeralInfo(
      chainName,
      encryptionKey,
    );

    const swap = new Ephemeral7702ZeroXV2SwapRecipe(
      sellERC20Info,
      buyERC20Info,
      slippageBasisPoints,
      privateSwapRecipient,
      ephemeralAddress,
    );
    const recipeInput: RecipeInput = {
      networkName: chainName,
      railgunAddress: privateSwapRecipient,
      erc20Amounts: relayAdaptUnshieldERC20Amounts,
      nfts: [],
    };
    // The swap runs a variable external 0x call whose estimateGas under-shoots the real
    // relay-adapt execution; it MUST use the recipe's minGasLimit floor (e.g. 2.7M for
    // swap-and-shield) or it submits an under-gassed tx and reverts out-of-gas. (Only the
    // deterministic recovery ops can safely use 0n.)
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

  const currentPublicWalletAddress = getCurrentEthersWallet().address;

  const quote = await getSwapQuote(
    chainName,
    relayAdaptUnshieldERC20Amounts[0],
    buyERC20Info,
    slippageBasisPoints,
    false,
    currentPublicWalletAddress,
  );
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

export const getZer0XSwapTransactionGasEstimate = async (
  chainName: NetworkName,
  zer0XSwapInputs: Zer0XSwap,
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  // Private swaps run through the 7702 relay-adapt path; realign the ephemeral index with
  // history once before the SDK derives the ephemeral address for this op.
  await syncEphemeralIndexOnce(chainName, encryptionKey);

  const gasDetailsResult = await getTransactionGasDetails(
    chainName,
    broadcasterSelection,
    true
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

  const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls7702(
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
    broadcasterSelection,
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

  const { broadcasterFeeERC20Recipient, estimatedGasDetails } =
    privateGasEstimate as PrivateGasEstimate;
  // EIP-7702 relay-adapt does not use the overall-batch-min-gas-price commitment — pricing
  // is governed by the type-4 maxFeePerGas. Committing a non-zero value makes the
  // RailgunSmartWallet gas-price check revert ("Gas price too low") whenever the effective
  // type-4 gas price falls below it, so pin it to 0 (matching the SDK's own 7702 estimate).
  const overallBatchMinGasPrice = 0n;
  const sendWithPublicWallet =
    typeof broadcasterFeeERC20Recipient !== "undefined" ? false : true;
  try {
    await generateCrossContractCallsProof7702(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      relayAdaptUnshieldERC20Amounts,
      [],
      relayAdaptShieldERC20Addresses,
      [],
      crossContractCalls,
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      minGasLimit,
      progressCallback,
    ).finally(() => {
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
        broadcasterFeeERC20Recipient,
        sendWithPublicWallet,
        overallBatchMinGasPrice,
        estimatedGasDetails,
      );
    transaction.type = EVMGasType.Type4
    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (err) {
    const error = err as Error;
    console.log(
      "ERROR getting proved transaction.",
      error.message,
      error.cause,
    );
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
