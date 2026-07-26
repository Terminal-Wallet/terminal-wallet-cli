import {
  FeeTokenDetails,
  NetworkName,
  RailgunERC20AmountRecipient,
  RailgunPopulateTransactionResponse,
  SelectedBroadcaster,
  TXIDVersion,
  TransactionGasDetails,
  isDefined,
} from "@railgun-community/shared-models";
import {
  calculateBroadcasterFeeERC20Amount,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
} from "@railgun-community/wallet";
import { formatUnits } from "ethers";
import { getCurrentRailgunID } from "../../wallet/wallet-util";
import {
  calculateSelfSignedGasEstimate,
  getTransactionGasDetails,
} from "./private-tx";
import { PrivateGasEstimate } from "../../../models/transaction-models";
import { getCurrentNetwork } from "../../engine/engine";
import { ERC20Token } from "../../../models/token-models";
import { emitCoreEvent } from "../../../core/events";
import { createLogger } from "../../../platform/logger";

const log = createLogger("unshield");

export const getOutputGasEstimate = async (
  originalGasDetails: TransactionGasDetails,
  gasEstimate: bigint,
  feeTokenInfo: ERC20Token,
  feeTokenDetails: FeeTokenDetails | undefined,
  broadcasterSelection: SelectedBroadcaster | undefined,
  overallBatchMinGasPrice: Optional<bigint>,
) => {
  const estimatedGasDetails = { ...originalGasDetails, gasEstimate };
  const { symbol } = feeTokenInfo;
  let broadcasterFeeERC20Recipient;
  let estimatedCost = 0;
  if (feeTokenDetails && broadcasterSelection) {
    log.info("Calculating Broadcaster Fee... This may take a few moments.");
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
      tokenAddress: feeTokenDetails.tokenAddress,
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

export const getUnshieldERC20TransactionGasEstimate = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
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
    log.warn("Failed to get Gas Details for Transaction");
    return undefined;
  }
  const {
    originalGasDetails,
    overallBatchMinGasPrice,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
  } = gasDetailsResult;
  log.info(
    "Getting Gas Estimate for UNSHIELD Transaction...... this may take some time",
  );
  const { gasEstimate, broadcasterFeeCommitment } =
    await gasEstimateForUnprovenUnshield(
      txIDVersion,
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
    broadcasterSelection,
    overallBatchMinGasPrice,
  );
};

export const getProvedUnshieldERC20Transaction = async (
  encryptionKey: string,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  privateGasEstimate: PrivateGasEstimate,
): Promise<Optional<RailgunPopulateTransactionResponse>> => {
  const chainName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  // Proof progress goes out on the core bus: the wallet reports how far along it
  // is, and whatever is attached decides how to show it. Previously this drove a
  // terminal progress bar directly, which is why proof generation could not run
  // without a TTY.
  const progressCallback = (progress: number, progressStats: string) => {
    emitCoreEvent({
      type: "tx:progress",
      phase: "prove",
      pct: progress,
      message: isDefined(progressStats)
        ? `Generating proof — ${progressStats}`
        : "Generating proof",
    });
  };

  const {
    broadcasterFeeERC20Recipient,
    overallBatchMinGasPrice,
    estimatedGasDetails,
  } = privateGasEstimate;
  const sendWithPublicWallet =
    typeof broadcasterFeeERC20Recipient !== "undefined" ? false : true;

  try {
    await generateUnshieldProof(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      erc20AmountRecipients,
      [], // nftAmountRecipients
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      progressCallback,
    ).finally(() => {
    });

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedUnshield(
        txIDVersion,
        chainName,
        railgunWalletID,
        erc20AmountRecipients,
        [], // nftAmountRecipients
        broadcasterFeeERC20Recipient,
        sendWithPublicWallet,
        overallBatchMinGasPrice,
        estimatedGasDetails,
      );
    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (err) {
    const error = err as Error;
    log.error(error.message);
  }
};
