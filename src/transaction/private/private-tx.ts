import {
  RailgunERC20AmountRecipient,
  TransactionGasDetails,
  EVMGasType,
  FeeTokenDetails,
  NetworkName,
  getEVMGasTypeForTransaction,
  TransactionGasDetailsType1,
  SelectedBroadcaster,
  TransactionGasDetailsType2,
  isDefined,
  TXIDVersion,
  RailgunPopulateTransactionResponse,
} from "@railgun-community/shared-models";
import {
  calculateBroadcasterFeeERC20Amount,
  gasEstimateForUnprovenTransfer,
  generateTransferProof,
  populateProvedTransfer,
} from "@railgun-community/wallet";
import { parseUnits, formatUnits } from "ethers";
import { ProgressBar } from "../../ui/progressBar-ui";
import { getTokenInfo } from "../../balance/token-util";
import { getCurrentRailgunID, shouldShowSender } from "../../wallet/wallet-util";
import { getCurrentNetwork } from "../../engine/engine";
import { getWakuTransaction } from "../../waku/connect-waku";
import { ERC20Token } from "../../models/token-models";
import {
  PrivateGasDetails,
  PrivateGasEstimate,
} from "../../models/transaction-models";
import {
  getChainForName,
  getWrappedTokenInfoForChain,
} from "../../network/network-util";
import { getFeeDetailsForChain } from "../../gas/gas-util";

export const getOriginalGasDetailsForPrivateTransaction = async (
  chainName: NetworkName,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasDetails | undefined> => {
  try {
    const feeData = await getFeeDetailsForChain(chainName);
    const gasPrice = feeData.gasPrice ?? 0n;
    const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const maxPriorityFeePerGas =
      feeData.maxPriorityFeePerGas ?? maxFeePerGas ?? parseUnits("1", "gwei");
    let evmGasType;
    let sendWithPublicWallet = false;
    let feeTokenDetails: Optional<FeeTokenDetails>;
    let feeTokenDecimals: Optional<number>;
    let overallBatchMinGasPrice: Optional<bigint>;
    let originalGasDetails: TransactionGasDetails;
    let feeTokenInfo: ERC20Token;
    if (broadcasterSelection) {
      evmGasType = getEVMGasTypeForTransaction(
        chainName,
        false,
      ) as EVMGasType.Type1;
    } else {
      evmGasType = getEVMGasTypeForTransaction(chainName, true);
      sendWithPublicWallet = true;
    }

    switch (evmGasType) {
      // broadcaster network transactions
      case EVMGasType.Type0:
      case EVMGasType.Type1: {
        originalGasDetails = {
          evmGasType, // Type 1 for relayed transactions
          gasEstimate: 0n, // Always 0, we don't have this yet.
          gasPrice: gasPrice ?? 0n,
        } as TransactionGasDetailsType1;
        overallBatchMinGasPrice = originalGasDetails.gasPrice;
        break;
      }
      // self relayed transactions
      case EVMGasType.Type2: {
        originalGasDetails = {
          evmGasType, // Type 2 for self-relayed transactions
          gasEstimate: 0n, // Always 0, we don't have this yet.
          maxFeePerGas, //: maxFeePerGas,
          maxPriorityFeePerGas, //: maxFeePerGas,
        } as TransactionGasDetailsType2;
        overallBatchMinGasPrice = undefined; //originalGasDetails.maxFeePerGas;
      }
    }

    // true for self-signing, false for Broadcaster.
    if (!sendWithPublicWallet) {
      feeTokenDetails = broadcasterSelection
        ? {
          tokenAddress: broadcasterSelection.tokenAddress,
          feePerUnitGas: BigInt(broadcasterSelection.tokenFee.feePerUnitGas),
        }
        : undefined;

      if (feeTokenDetails) {
        feeTokenInfo = await getTokenInfo(
          chainName,
          feeTokenDetails.tokenAddress,
        );
      } else {
        throw new Error("Missing Fee Token Details");
      }
    } else {
      feeTokenDetails = undefined;
      const { symbol, decimals } = getWrappedTokenInfoForChain(chainName);
      feeTokenInfo = {
        symbol,
        decimals,
      } as ERC20Token;
    }
    return {
      originalGasDetails: originalGasDetails!,
      overallBatchMinGasPrice,
      sendWithPublicWallet,
      feeTokenDetails,
      feeTokenInfo,
    };
  } catch (error) {
    console.log(error);
    return undefined;
  }
};

export const getTransactionGasDetails = async (
  chainName: NetworkName,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasDetails | undefined> => {
  const gasDetailsResult = await getOriginalGasDetailsForPrivateTransaction(
    chainName,
    broadcasterSelection,
  );
  if (!gasDetailsResult) {
    return undefined;
  }

  return gasDetailsResult;
};

export const calculateSelfSignedGasEstimate = (
  estimatedGasDetails: TransactionGasDetails,
) => {
  const { gasEstimate, evmGasType } = estimatedGasDetails;
  switch (evmGasType) {
    case EVMGasType.Type0:
    case EVMGasType.Type1: {
      return estimatedGasDetails.gasPrice * gasEstimate;
    }
    case EVMGasType.Type2: {
      return estimatedGasDetails.maxFeePerGas * gasEstimate;
    }
    default: {
      throw new Error("Invalid Gas Estimate");
    }
  }
};

export const getPrivateTransactionGasEstimate = async (
  chainName: NetworkName,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
  memoText = "",
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
  console.log("Getting Gas Estimate for Transaction...");

  const { gasEstimate } = await gasEstimateForUnprovenTransfer(
    txIDVersion,
    chainName,
    railgunWalletID,
    encryptionKey,
    memoText,
    erc20AmountRecipients,
    [], // nftAmountRecipients
    originalGasDetails,
    feeTokenDetails,
    sendWithPublicWallet,
  );

  const estimatedGasDetails = { ...originalGasDetails, gasEstimate };
  const { symbol } = feeTokenInfo;
  let broadcasterFeeERC20Recipient;
  let estimatedCost = 0;
  if (feeTokenDetails && broadcasterSelection) {
    console.log("Calculating Gas Fee... this may take some time");
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

export const getProvedPrivateTransaction = async (
  encryptionKey: string,
  erc20AmountRecipients: RailgunERC20AmountRecipient[],
  privateGasEstimate: PrivateGasEstimate,
  memoText = "",
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

  // NEED TODO: need to add toggle for this as well.
  const showSenderAddressToRecipient = shouldShowSender();
  const proofStartTime = Date.now();
  try {
    await generateTransferProof(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      showSenderAddressToRecipient,
      memoText,
      erc20AmountRecipients,
      [], // nftAmountRecipients
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      progressCallback,
    )
      .catch((err) => {
        console.log("We errored out");
      })
      .finally(() => {
        progressBar.complete();
      });
    const proofEndTime = Date.now();
    const proofTimeElapsed = (proofEndTime - proofStartTime) / 1000;
    console.log(`Proof Generation Took ${proofTimeElapsed}s`);
    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedTransfer(
        txIDVersion,
        chainName,
        railgunWalletID,
        showSenderAddressToRecipient,
        memoText,
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
    console.log(error.message);
  }
};

export const getBroadcasterTranaction = async (
  tx: any,
  networkName: NetworkName,
  useRelayAdapt: boolean,
) => {
  const txidVersion = TXIDVersion.V2_PoseidonMerkle;
  const { to, data } = tx.transaction;
  const { nullifiers, preTransactionPOIsPerTxidLeafPerList } = tx;
  const broadcasterFeesID = tx.feesID;
  const chain = getChainForName(networkName);
  const overallBatchMinGasPrice = tx.transaction.gasPrice;
  const relayTx = getWakuTransaction();
  const encryptedTransaction = await relayTx.create(
    txidVersion,
    to,
    data,
    tx.selectedBroadcasterAddress,
    broadcasterFeesID,
    chain,
    nullifiers,
    overallBatchMinGasPrice,
    useRelayAdapt,
    preTransactionPOIsPerTxidLeafPerList,
  );
  return encryptedTransaction;
};
