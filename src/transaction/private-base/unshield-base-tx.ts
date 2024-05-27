import {
  NetworkName,
  RailgunERC20Amount,
  RailgunERC20AmountRecipient,
  RailgunPopulateTransactionResponse,
  SelectedBroadcaster,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import {
  calculateBroadcasterFeeERC20Amount,
  gasEstimateForUnprovenUnshieldBaseToken,
  generateUnshieldBaseTokenProof,
  populateProvedUnshieldBaseToken,
} from "@railgun-community/wallet";
import { formatUnits } from "ethers";
import { ProgressBar } from "../../ui/progressBar-ui";
import {
  calculateSelfSignedGasEstimate,
  getTransactionGasDetails,
} from "../private/private-tx";
import { PrivateGasEstimate } from "../../models/transaction-models";
import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { getCurrentNetwork } from "../../engine/engine";

export const getUnshieldBaseTokenGasEstimate = async (
  chainName: NetworkName,
  _wrappedERC20Amount: RailgunERC20AmountRecipient,
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const gasDetailsResult = await getTransactionGasDetails(
    chainName,
    broadcasterSelection,
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
  const wrappedERC20Amount: RailgunERC20Amount = {
    tokenAddress: _wrappedERC20Amount.tokenAddress, // wETH
    amount: _wrappedERC20Amount.amount, // hexadecimal amount
  };
  console.log(
    "Getting Gas Estimate for Transaction...... this may take some time",
  );
  const { gasEstimate, broadcasterFeeCommitment } =
    await gasEstimateForUnprovenUnshieldBaseToken(
      txIDVersion,
      chainName,
      _wrappedERC20Amount.recipientAddress,
      railgunWalletID,
      encryptionKey,
      wrappedERC20Amount,
      originalGasDetails,
      feeTokenDetails,
      sendWithPublicWallet,
    );

  const estimatedGasDetails = { ...originalGasDetails, gasEstimate };
  const { symbol } = feeTokenInfo;
  let broadcasterFeeERC20Recipient;
  let estimatedCost = 0;
  if (feeTokenDetails && broadcasterSelection) {
    console.log("Calculating Gas Fee...... this may take some time");
    const broadcasterFeeAmountDetails =
      await calculateBroadcasterFeeERC20Amount(
        feeTokenDetails,
        estimatedGasDetails,
      );

    estimatedCost = parseFloat(
      formatUnits(broadcasterFeeAmountDetails.amount, feeTokenInfo.decimals),
    );

    // if self relayed, this will be returned undefined.
    broadcasterFeeERC20Recipient = {
      tokenAddress: broadcasterFeeAmountDetails.tokenAddress,
      amount: broadcasterFeeAmountDetails.amount,
      recipientAddress: broadcasterSelection.railgunAddress,
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
    broadcasterFeeERC20Recipient,
    overallBatchMinGasPrice,
  };
};

export const getProvedUnshieldBaseTokenTransaction = async (
  encryptionKey: string,
  erc20AmountRecipient: RailgunERC20AmountRecipient,
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
    broadcasterFeeERC20Recipient,
    overallBatchMinGasPrice,
    estimatedGasDetails,
  } = privateGasEstimate;

  const sendWithPublicWallet =
    typeof broadcasterFeeERC20Recipient !== "undefined" ? false : true;
  try {
    const wrappedERC20Amount: RailgunERC20Amount = {
      tokenAddress: erc20AmountRecipient.tokenAddress, // wETH
      amount: erc20AmountRecipient.amount, // hexadecimal amount
    };

    await generateUnshieldBaseTokenProof(
      txIDVersion,
      chainName,
      erc20AmountRecipient.recipientAddress,
      railgunWalletID,
      encryptionKey,
      wrappedERC20Amount,
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      progressCallback,
    ).finally(() => {
      progressBar.complete();
    });

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedUnshieldBaseToken(
        txIDVersion,
        chainName,
        erc20AmountRecipient.recipientAddress,
        railgunWalletID,
        erc20AmountRecipient,
        broadcasterFeeERC20Recipient,
        sendWithPublicWallet,
        overallBatchMinGasPrice,
        estimatedGasDetails,
      );

    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (err) {
    const error = err as Error;
    console.log(error.message);
    return undefined;
  }
};
