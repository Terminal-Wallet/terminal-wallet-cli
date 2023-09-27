export type FeeHistoryResponse = {
    oldestBlock: bigint;
    reward: [string[]];
    baseFeePerGas: bigint[];
    gasUsedRatio: bigint[];
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
export type FeeHistoryBlock = {
  blockNumber: number | string;
  baseFeePerGas: bigint;
  gasUsedRatio: number;
  priorityFeePerGas: bigint[];
};
  