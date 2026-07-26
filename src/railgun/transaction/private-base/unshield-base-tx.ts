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
import {
  calculateSelfSignedGasEstimate,
  getTransactionGasDetails,
} from "../private/private-tx";
import { PrivateGasEstimate } from "../../../models/transaction-models";
import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { syncEphemeralIndexOnce } from "../../wallet/ephemeral-util";
import { getCurrentNetwork } from "../../engine/engine";
import { emitCoreEvent } from "../../../core/events";
import { createLogger } from "../../../platform/logger";

const log = createLogger("unshield-base");

export const getUnshieldBaseTokenGasEstimate = async (
  chainName: NetworkName,
  _wrappedERC20Amount: RailgunERC20AmountRecipient,
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  // Base-token unshield runs through the 7702 relay-adapt path; realign the ephemeral
  // index with history once before the SDK derives the ephemeral address for this op.
  await syncEphemeralIndexOnce(chainName, encryptionKey);

  // Base-token unshield is always a 7702 (type-4) relay-adapt tx — flag it so the gas details
  // stay Type4 (EIP-1559) instead of being downgraded to Type1 for the broadcaster, which
  // would zero the priority fee on the populated tx.
  const gasDetailsResult = await getTransactionGasDetails(
    chainName,
    broadcasterSelection,
    true,
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
  const wrappedERC20Amount: RailgunERC20Amount = {
    tokenAddress: _wrappedERC20Amount.tokenAddress, // wETH
    amount: _wrappedERC20Amount.amount, // hexadecimal amount
  };
  log.info(
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
    log.info("Calculating Gas Fee...... this may take some time");
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

  const { broadcasterFeeERC20Recipient, estimatedGasDetails } =
    privateGasEstimate;
  // EIP-7702 relay-adapt does not commit an overall-batch-min-gas-price (type-4 maxFeePerGas
  // governs pricing). A non-zero value reverts as "Gas price too low", so pin it to 0.
  const overallBatchMinGasPrice = 0n;

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
    log.error(error.message);
    return undefined;
  }
};
