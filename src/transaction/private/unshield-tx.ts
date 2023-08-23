import {
  FeeTokenDetails,
  NetworkName,
  RailgunERC20AmountRecipient,
  SelectedRelayer,
  TransactionGasDetails,
  isDefined,
} from "@railgun-community/shared-models";
import {
  calculateRelayerFeeERC20Amount,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
} from "@railgun-community/wallet";
import { formatUnits } from "ethers";
import { ProgressBar } from "../../ui/progressBar-ui";
import { getCurrentRailgunID } from "../../wallet/wallet-util";
import {
  calculateSelfSignedGasEstimate,
  getTransactionGasDetails,
} from "./private-tx";
import { PrivateGasEstimate } from "../../models/transaction-models";
import { getCurrentNetwork } from "../../engine/engine";
import { ERC20Token } from "../../models/token-models";

export const getOutputGasEstimate = async (
  originalGasDetails: TransactionGasDetails,
  gasEstimate: bigint,
  feeTokenInfo: ERC20Token,
  feeTokenDetails: FeeTokenDetails | undefined,
  relayerSelection: SelectedRelayer | undefined,
  overallBatchMinGasPrice: Optional<bigint>,
) => {
  const estimatedGasDetails = { ...originalGasDetails, gasEstimate };
  const { symbol } = feeTokenInfo;
  let relayerFeeERC20Recipient;
  let estimatedCost = 0;
  if (feeTokenDetails && relayerSelection) {
    console.log("Calculating Relayer Fee... This may take a few moments.");
    const relayerFeeAmountDetails = await calculateRelayerFeeERC20Amount(
      feeTokenDetails,
      estimatedGasDetails,
    );

    estimatedCost = parseFloat(
      formatUnits(relayerFeeAmountDetails.amount, feeTokenInfo.decimals),
    );

    // if self relayed, this will be returned undefined.
    relayerFeeERC20Recipient = {
      tokenAddress: feeTokenDetails.tokenAddress,
      amount: relayerFeeAmountDetails.amount,
      recipientAddress: relayerSelection.railgunAddress,
    } as RailgunERC20AmountRecipient;
  } else {
    const selfSignedCost = calculateSelfSignedGasEstimate(estimatedGasDetails);
    estimatedCost = parseFloat(
      formatUnits(selfSignedCost, feeTokenInfo.decimals),
    );
  }

  return {
    symbol,
    estimatedGasDetails,
    estimatedCost,
    relayerFeeERC20Recipient,
    overallBatchMinGasPrice,
  };
};

export const getUnshieldERC20TransactionGasEstimate = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  encryptionKey: string,
  relayerSelection?: SelectedRelayer,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();

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
    overallBatchMinGasPrice,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
  } = gasDetailsResult;
  console.log(
    "Getting Gas Estimate for UNSHIELD Transaction...... this may take some time",
  );
  const { gasEstimate, relayerFeeCommitment } =
    await gasEstimateForUnprovenUnshield(
      chainName,
      railgunWalletID,
      encryptionKey,
      erc20AmountRecipients,
      [], // nftAmountRecipients
      originalGasDetails,
      feeTokenDetails,
      sendWithPublicWallet,
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

export const getProvedUnshieldERC20Transaction = async (
  encryptionKey: string,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  privateGasEstimate: PrivateGasEstimate,
) => {
  const chainName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();

  const progressBar = new ProgressBar("Starting Proof Generation");
  const progressCallback = (
    progress: number,
    progressStats?: { done: number; total: number },
  ) => {
    if (isDefined(progressStats)) {
      progressBar.updateProgress(
        `Transaction Proof Generation | [${progressStats.done}/${progressStats.total}]`,
        progress,
      );
    } else {
      progressBar.updateProgress(`Transaction Proof Generation`, progress);
    }
  };

  const {
    relayerFeeERC20Recipient,
    overallBatchMinGasPrice,
    estimatedGasDetails,
  } = privateGasEstimate;
  const sendWithPublicWallet =
    typeof relayerFeeERC20Recipient !== "undefined" ? false : true;

  try {
    await generateUnshieldProof(
      chainName,
      railgunWalletID,
      encryptionKey,
      erc20AmountRecipients,
      [], // nftAmountRecipients
      relayerFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      progressCallback,
    ).finally(() => {
      progressBar.complete();
    });

    const { transaction, nullifiers } = await populateProvedUnshield(
      chainName,
      railgunWalletID,
      erc20AmountRecipients,
      [], // nftAmountRecipients
      relayerFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      estimatedGasDetails,
    );
    return { transaction, nullifiers };
  } catch (err) {
    const error = err as Error;
    console.log(error.message);
  }
};
