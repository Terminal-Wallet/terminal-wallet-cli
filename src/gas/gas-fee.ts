import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits, parseUnits, FeeData } from "ethers";
import { getFirstPollingProviderForChain } from "../network/network-util";
import { promiseTimeout } from "../util/util";
import { FeeHistoryResponse } from "../models/gas-models";
import { CustomGasEstimate } from "../models/gas-models";
import { FeeHistoryBlock } from "../models/gas-models";

// Median across the sampled blocks. Priority-fee percentiles are dominated by MEV/urgent
// tips, so an arithmetic mean is dragged far above the typical fee by a few spike blocks;
// the median reflects the fee a normal transaction actually needs.
const median = (arr: bigint[]): bigint => {
  const sorted = arr
    .filter((v): v is bigint => typeof v === "bigint")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length === 0) {
    return 0n;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2n;
};

export const formatFeeHistory = (
  result: any,
  includePending: boolean,
  historicalBlocks: number,
): FeeHistoryBlock[] => {
  let blockNum = result.oldestBlock;
  let index = 0;
  const blocks: FeeHistoryBlock[] = [];

  while (
    blockNum < result.oldestBlock + BigInt(result.reward.length) &&
    isDefined(result.reward[index])
  ) {
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
  const currentBlockNumber = "latest";
  const rewardPercentiles = [60, 80, 95];
  const provider = getFirstPollingProviderForChain(chainName);

  const gasPricePromise = await promiseTimeout(
    provider.send("eth_gasPrice", []),
    10 * 1000,
  ).catch((err) => {
    console.log(err.message);
    return undefined;
  });

  if (!isDefined(gasPricePromise)) {
    throw new Error("Unable to get Gas Price");
  }

  const gasPrice = BigInt(gasPricePromise);
  if (!isDefined(gasPrice)) {
    throw new Error("Gas Price is Null");
  }

  const feeHistoryPromise = await promiseTimeout(
    provider.send("eth_feeHistory", [
      historicalBlocks,
      currentBlockNumber,
      rewardPercentiles,
    ]),
    10 * 1000,
  ).catch((err) => {
    console.log(err.message);
    return undefined;
  });

  if (!isDefined(feeHistoryPromise)) {
    throw new Error("Unable to get gas fee history.");
  }

  const feeHistory = feeHistoryPromise as FeeHistoryResponse;

  const baseFeePerGas = BigInt(
    feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1],
  ) as bigint;

  feeHistory.oldestBlock = BigInt(feeHistory.oldestBlock);

  const blocks: FeeHistoryBlock[] = formatFeeHistory(
    feeHistory,
    false,
    historicalBlocks,
  );
  const slow = median(blocks.map((b) => b.priorityFeePerGas[0] as bigint));
  const average = median(blocks.map((b) => b.priorityFeePerGas[1] as bigint));
  const fast = median(blocks.map((b) => b.priorityFeePerGas[2] as bigint));

  // Inclusion floor: the median can collapse to 0 when most sampled blocks report no tip at the
  // percentile, which would leave a tx with a 0 priority fee (starved, may never mine). Keep a
  // small minimum so the auto-default is always mineable.
  const MIN_PRIORITY_FEE = parseUnits("0.02", "gwei");
  const maxPriorityFeePerGas =
    average > MIN_PRIORITY_FEE ? average : MIN_PRIORITY_FEE;

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

// --- Gas-fee tiers as raw bigints, for the per-transaction gas-fee matrix prompt ---

export type GasTierKey = "slow" | "average" | "fast";

export type GasTier = {
  key: GasTierKey;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
};

export type GasFeeTiers = {
  chainName: NetworkName;
  baseFeePerGas: bigint;
  gasPrice: bigint;
  tiers: GasTier[];
};

// EIP-1559 tiers derived from feeHistory percentiles (60/80/95). maxFee = priority + base.
export const getGasFeeTiers = async (
  chainName: NetworkName,
): Promise<GasFeeTiers> => {
  const estimate = await getGasEstimates(chainName);
  const { baseFeePerGas, gasPrice, slow, average, fast } = estimate;
  const tier = (key: GasTierKey, priority: bigint): GasTier => ({
    key,
    maxPriorityFeePerGas: priority,
    maxFeePerGas: priority + baseFeePerGas,
  });
  return {
    chainName,
    baseFeePerGas,
    gasPrice,
    tiers: [tier("slow", slow), tier("average", average), tier("fast", fast)],
  };
};

// --- Per-build gas-fee override (user selection during transaction build) ---
// A single build is single-chain; the selection is keyed by chain and cleared when a new
// build starts, so a stale override can never bleed into the next transaction.

let selectedGasFee: { chainName: NetworkName; feeData: FeeData } | undefined;

export const setGasFeeSelection = (
  chainName: NetworkName,
  feeData: FeeData,
): void => {
  selectedGasFee = { chainName, feeData };
};

export const getGasFeeSelection = (
  chainName: NetworkName,
): FeeData | undefined =>
  isDefined(selectedGasFee) && selectedGasFee.chainName === chainName
    ? selectedGasFee.feeData
    : undefined;

export const clearGasFeeSelection = (): void => {
  selectedGasFee = undefined;
};
