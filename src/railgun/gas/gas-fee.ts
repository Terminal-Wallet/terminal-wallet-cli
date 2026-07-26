import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits, parseUnits, FeeData } from "ethers";
import { getFirstPollingProviderForChain } from "../network/network-util";
import { promiseTimeout } from "../../util/util";
import { FeeHistoryResponse } from "../../models/gas-models";
import { CustomGasEstimate } from "../../models/gas-models";
import { FeeHistoryBlock } from "../../models/gas-models";
import { createLogger } from "../../platform/logger";

const log = createLogger("gas-fee");

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

/**
 * Priority-fee percentiles behind the slow / average / fast tiers.
 *
 * The distribution of tips in a block is steeply skewed and effectively
 * bimodal: most transactions pay almost nothing, and a large cohort pays
 * whatever their wallet defaults to — 2 gwei, overwhelmingly. Measured on
 * mainnet at a 0.062 gwei base fee, the median tip per percentile ran
 * p25 0.001 · p50 0.025 · p75 0.29 · p80 0.60 · p90 1.42 · p95 2.00.
 *
 * So anything at or above p80 samples the defaults cohort rather than the
 * market, and p95 lands on exactly 2 gwei almost regardless of conditions —
 * a fixed price wearing a percentile's clothes. These three sit below that
 * cliff, and put "slow" at roughly what public trackers quote as low.
 */
export const REWARD_PERCENTILES = [25, 50, 75];

/**
 * The smallest tip worth offering.
 *
 * Below the median the tip distribution is degenerate rather than merely
 * cheap — measured at a 0.0795 gwei base fee, p25 was 0.0014 gwei against a
 * p50 of 0.05. So in quiet conditions this floor, not the percentile, is what
 * "slow" actually means, and it has to be a figure that gets a transaction
 * mined rather than the smallest number a block has ever accepted.
 *
 * It was briefly 0.005, argued from block inclusion: blocks do include tips
 * that small. Inclusion turned out not to be the binding constraint. A
 * broadcaster enforces its own minimum and rejects what is under it outright,
 * and "slow" read as untrustworthy even when it would have worked. 0.025 sits
 * just under the typical median tip and above the 0.02 this used to be, which
 * never drew a complaint.
 */
export const MIN_PRIORITY_FEE = parseUnits("0.025", "gwei");

/**
 * The three tiers, from one reward-percentile column per tier. The median
 * across sampled blocks — not the mean, which a few spike blocks drag far
 * above the fee a normal transaction needs.
 */
export const tiersFromRewards = (
  rewardsPerBlock: bigint[][],
): { slow: bigint; average: bigint; fast: bigint } => {
  const atPercentile = (index: number): bigint => {
    const column = median(rewardsPerBlock.map((r) => r[index]));
    return column > MIN_PRIORITY_FEE ? column : MIN_PRIORITY_FEE;
  };
  return {
    slow: atPercentile(0),
    average: atPercentile(1),
    fast: atPercentile(2),
  };
};

/**
 * Base-fee headroom in the max fee, as a percentage.
 *
 * `maxFeePerGas` is a ceiling, not a price: a self-signed transaction pays
 * `baseFee + tip` whatever the ceiling is. Set to exactly `tip + baseFee` it
 * covers only the base fee at the moment it was read, and the base fee moves —
 * up to 12.5% per block. By the time a proof is generated and the transaction
 * submitted, a ceiling with no headroom no longer covers the base fee, and a
 * broadcaster rejects it outright: "must cover the current base fee plus a
 * minimum priority fee".
 *
 * 2x is the usual convention (ethers' own getFeeData uses it) and absorbs
 * roughly six consecutive full blocks.
 *
 * It is not free for a broadcaster send, which is why this is a named constant
 * rather than a multiplier inline. A broadcaster charges
 * `feePerUnitGas x calculateGasLimit(estimate) x maxFeePerGas` — its fee scales
 * with the CEILING, not with what the transaction ends up paying — and that fee
 * is committed inside the proof, so it cannot be recomputed later against a
 * fresher base fee. Headroom therefore buys reliability with real money, and
 * the number is a trade rather than a default.
 */
const BASE_FEE_HEADROOM_PCT = 200n;

/**
 * The ceiling to submit for a given tip: the tip plus room for the base fee to
 * rise. Every tier and preset goes through here so they cannot drift apart.
 */
export const maxFeeFor = (priorityFee: bigint, baseFee: bigint): bigint =>
  priorityFee + (baseFee * BASE_FEE_HEADROOM_PCT) / 100n;

export const getGasEstimates = async (
  chainName: NetworkName,
): Promise<CustomGasEstimate> => {
  const historicalBlocks = 40;
  const currentBlockNumber = "latest";
  const rewardPercentiles = REWARD_PERCENTILES;
  const provider = getFirstPollingProviderForChain(chainName);

  const gasPricePromise = await promiseTimeout(
    provider.send("eth_gasPrice", []),
    10 * 1000,
  ).catch((err) => {
    log.info(err.message);
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
    log.info(err.message);
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
  const { slow, average, fast } = tiersFromRewards(
    blocks.map((b) => b.priorityFeePerGas),
  );

  // The auto-default is the middle tier: the tip a normal transaction pays.
  const maxPriorityFeePerGas = average;
  const maxFeePerGas = maxFeeFor(maxPriorityFeePerGas, baseFeePerGas);

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
      maxFeePerGas: formatUnits(maxFeeFor(slow, baseFeePerGas), "gwei"),
      maxPriorityFeePerGas: formatUnits(slow, "gwei"),
    },
    average: {
      gasPrice,
      maxFeePerGas: formatUnits(maxFeeFor(average, baseFeePerGas), "gwei"),
      maxPriorityFeePerGas: formatUnits(average, "gwei"),
    },
    fast: {
      gasPrice,
      maxFeePerGas: formatUnits(maxFeeFor(fast, baseFeePerGas), "gwei"),
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
    maxFeePerGas: maxFeeFor(priority, baseFeePerGas),
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
