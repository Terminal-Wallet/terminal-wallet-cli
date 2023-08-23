import {
  EVMGasType,
  NETWORK_CONFIG,
  NetworkName,
  TransactionGasDetails,
  TransactionGasDetailsType1,
  TransactionGasDetailsType2,
  isDefined,
} from "@railgun-community/shared-models";
import { ContractTransaction } from "ethers";
import { throwError } from "../util/util";
import { getGasEstimateMatrix, getGasEstimates } from "./gas-fee";
import { getProviderForChain } from "../network/network-util";

export const calculatePublicGasFee = async (
  transaction: ContractTransaction,
) => {
  const { gasPrice, maxFeePerGas, gasLimit } = transaction;

  if (typeof gasLimit !== "undefined") {
    if (typeof gasPrice !== "undefined") {
      return gasPrice * gasLimit;
    }
    if (typeof maxFeePerGas !== "undefined") {
      return maxFeePerGas * gasLimit;
    }
  }
  throw new Error("No Gas present Details in Transaction");
};

export const calculateEstimatedGasCost = (
  estimatedDetails: TransactionGasDetails,
) => {
  const { gasEstimate } = estimatedDetails;

  if (typeof estimatedDetails.gasEstimate !== "undefined") {
    if (
      typeof (estimatedDetails as TransactionGasDetailsType1).gasPrice !==
      "undefined"
    ) {
      return (
        (estimatedDetails as TransactionGasDetailsType1).gasPrice * gasEstimate
      );
    }
    if (
      typeof (estimatedDetails as TransactionGasDetailsType2).maxFeePerGas !==
      "undefined"
    ) {
      return (
        (estimatedDetails as TransactionGasDetailsType2).maxFeePerGas *
        gasEstimate
      );
    }
  }
  throw new Error("No Gas present Details in Transaction");
};

export const getPublicGasEstimate = async (
  chainName: NetworkName,
  transaction: ContractTransaction,
) => {
  try {
    const provider = getProviderForChain(chainName);
    const gasEstimate = await provider
      .estimateGas(transaction)
      .catch(throwError);
    return gasEstimate;
  } catch (error) {
    console.log(error);
    throw new Error("Gas Estimation Error");
  }
};

export const getFeeDetailsForChain = async (chainName: NetworkName) => {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (chainName) {
    case NetworkName.Ethereum:
    case NetworkName.Polygon: {
      const currentGasEstimate = await getGasEstimates(chainName);
      // const estimateResults = getGasEstimateMatrix(currentGasEstimate);

      const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } =
        currentGasEstimate;

      return {
        gasPrice,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
    }
  }
  const provider = getProviderForChain(chainName);
  const feeData = await provider.getFeeData().catch((err) => {
    return undefined;
  });
  if (isDefined(feeData)) {
    return feeData;
  }
  throw new Error("Unable to get Gas Fee Data");
};

export const getPublicGasDetails = async (
  chainName: NetworkName,
  gasEstimate: bigint,
  isShield = false,
) => {
  const feeData = await getFeeDetailsForChain(chainName);
  const { gasPrice, maxFeePerGas, maxPriorityFeePerGas } = feeData;
  let gasDetailsInfo: {
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  } = { gasPrice: gasPrice ?? 0n };

  const { defaultEVMGasType } = NETWORK_CONFIG[chainName];

  // SELECTED DEFAULT because these are transacted through a personal wallet.
  switch (defaultEVMGasType) {
    case EVMGasType.Type0:
    case EVMGasType.Type1: {
      gasDetailsInfo.gasPrice = gasPrice ?? 0n;
      break;
    }
    case EVMGasType.Type2: {
      gasDetailsInfo = {
        maxFeePerGas: maxFeePerGas ?? gasPrice ?? 0n,
        maxPriorityFeePerGas: maxPriorityFeePerGas ?? 0n,
      };
      break;
    }
  }

  if (isShield) {
    const gasDetails = {
      evmGasType: defaultEVMGasType,
      gasEstimate,
      ...gasDetailsInfo,
    } as TransactionGasDetails;

    return gasDetails;
  }
  const gasDetails = {
    gasLimit: gasEstimate,
    ...gasDetailsInfo,
  };
  return gasDetails;
};
