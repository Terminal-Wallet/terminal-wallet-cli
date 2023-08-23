import { NetworkName } from "@railgun-community/shared-models";
import { getWalletWeb3 } from "../wallet/wallet-util";
import { formatUnits } from "ethers";

type FeeHistoryBlock = {
  blockNumber: number | string;
  baseFeePerGas: bigint;
  gasUsedRatio: number;
  priorityFeePerGas: bigint[];
};

const avg = (arr: bigint[]): bigint => {
  const sum = arr.reduce((a, v) => a + v);
  const avgsum = BigInt(Math.round(Number(sum) / arr.length));
  return avgsum;
};

export type CustomGasEstimate = {
  gasPrice: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  baseFeePerGas: bigint;
  slow: bigint;
  average: bigint;
  fast: bigint;
};

export const formatFeeHistory = (
  result: any,
  includePending: boolean,
  historicalBlocks: number,
): FeeHistoryBlock[] => {
  let blockNum = result.oldestBlock;
  let index = 0;
  const blocks: FeeHistoryBlock[] = [];

  while (blockNum < result.oldestBlock + BigInt(result.reward.length)) {
    const newPriorityFeePerGas = result.reward[index].map((x: string) =>
      BigInt(x),
    );
    blocks.push({
      blockNumber: blockNum,
      baseFeePerGas: result.baseFeePerGas[index],
      gasUsedRatio: result.gasUsedRatio[index],
      priorityFeePerGas: newPriorityFeePerGas,
    });
    blockNum += 1n;
    index += 1;
  }

  if (includePending) {
    blocks.push({
      blockNumber: "pending",
      baseFeePerGas: BigInt(result.baseFeePerGas[historicalBlocks]),
      gasUsedRatio: NaN,
      priorityFeePerGas: [],
    });
  }

  return blocks;
};

export const getGasEstimates = async (
  chainName: NetworkName,
): Promise<CustomGasEstimate> => {
  const historicalBlocks = 40;
  const web3 = getWalletWeb3();

  const gasPrice = await web3.eth.getGasPrice();
  const currentBlockNumber = "pending";

  const feeHistory = (await web3.eth.getFeeHistory(
    historicalBlocks,
    currentBlockNumber,
    [60, 80, 95],
  )) as unknown as {
    oldestBlock: bigint;
    reward: [string[]];
    baseFeePerGas: bigint[];
    gasUsedRatio: bigint[];
  };

  const baseFeePerGas = feeHistory.baseFeePerGas[
    feeHistory.baseFeePerGas.length - 1
  ] as bigint;

  const blocks: FeeHistoryBlock[] = formatFeeHistory(
    feeHistory,
    false,
    historicalBlocks,
  );
  const slow = avg(blocks.map((b) => b.priorityFeePerGas[0] as bigint));
  const average = avg(blocks.map((b) => b.priorityFeePerGas[1] as bigint));
  const fast = avg(blocks.map((b) => b.priorityFeePerGas[2] as bigint));

  const maxPriorityFeePerGas = average; 

  const maxFeePerGas = maxPriorityFeePerGas + baseFeePerGas;

  return {
    gasPrice,
    maxFeePerGas,
    maxPriorityFeePerGas,
    baseFeePerGas,
    slow,
    average,
    fast,
  };
};

export const getGasEstimateMatrix = (gasEstimate: CustomGasEstimate) => {
  const {
    gasPrice: _gasPrice,
    maxFeePerGas: _maxFeePerGas,
    maxPriorityFeePerGas: _maxPriorityFeePerGas,
    baseFeePerGas,
    slow,
    average,
    fast,
  } = gasEstimate;

  const gasPrice = formatUnits(_gasPrice, "gwei");
  const maxFeePerGas = formatUnits(_maxFeePerGas, "gwei");
  const maxPriorityFeePerGas = formatUnits(_maxPriorityFeePerGas, "gwei");

  const matrix = {
    recommended: {
      gasPrice,
      maxFeePerGas,
      maxPriorityFeePerGas,
    },
    slow: {
      gasPrice,
      maxFeePerGas: formatUnits(slow + baseFeePerGas, "gwei"),
      maxPriorityFeePerGas: formatUnits(slow, "gwei"),
    },
    average: {
      gasPrice,
      maxFeePerGas: formatUnits(average + baseFeePerGas, "gwei"),
      maxPriorityFeePerGas: formatUnits(average, "gwei"),
    },
    fast: {
      gasPrice,
      maxFeePerGas: formatUnits(fast + baseFeePerGas, "gwei"),
      maxPriorityFeePerGas: formatUnits(fast, "gwei"),
    },
  };
  return matrix;
};
