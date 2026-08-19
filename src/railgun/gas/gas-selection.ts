/**
 * Pure gas-selection helpers — turn the slow/standard/fast fee matrix
 * (gas-fee.ts) into concrete overrides and apply them to a transaction's gas,
 * respecting the chain's EVM gas type (legacy gasPrice vs EIP-1559 maxFee).
 * No IO; the matrix fetch + prompts live in ui/collect-gas.ts.
 */
import {
  EVMGasType,
  NETWORK_CONFIG,
  NetworkName,
  TransactionGasDetails,
} from "@railgun-community/shared-models";
import { CustomGasEstimate } from "../../models/gas-models";
import { maxFeeFor } from "./gas-fee";

/** A concrete gas override in wei, tagged by EVM gas type. */
export type GasOverride =
  | { evmGasType: EVMGasType.Type0 | EVMGasType.Type1; gasPrice: bigint }
  | {
      evmGasType: EVMGasType.Type2;
      maxFeePerGas: bigint;
      maxPriorityFeePerGas: bigint;
    };

export interface GasPreset {
  key: "slow" | "standard" | "fast";
  override: GasOverride;
}

/** The EVM gas type a chain transacts with from a personal wallet. */
export const evmGasTypeForChain = (chainName: NetworkName): EVMGasType =>
  NETWORK_CONFIG[chainName].defaultEVMGasType;

/** The per-gas price an override charges (maxFee for Type2, gasPrice for legacy). */
// GasOverride is Type0|Type1 or Type2 by construction — a Type4 request is
// built as Type2, since both carry the same 1559 fields.
export const priceField = (o: GasOverride): bigint =>
  o.evmGasType === EVMGasType.Type2 ? o.maxFeePerGas : o.gasPrice;

/** Build slow/standard/fast overrides from a fee-history estimate. */
export const presetsFromEstimate = (
  evmGasType: EVMGasType,
  est: CustomGasEstimate,
): GasPreset[] => {
  // Type4 prices like Type2 — both are 1559.
  const mk = (key: GasPreset["key"], priority: bigint): GasPreset =>
    evmGasType === EVMGasType.Type2 || evmGasType === EVMGasType.Type4
      ? {
          key,
          override: {
            evmGasType: EVMGasType.Type2,
            maxFeePerGas: maxFeeFor(priority, est.baseFeePerGas),
            maxPriorityFeePerGas: priority,
          },
        }
      : {
          key,
          // Legacy chains don't vary gasPrice by speed — the presets all use the
          // node's current gasPrice; only "custom" lets the user override it.
          override: {
            evmGasType: evmGasType as EVMGasType.Type0 | EVMGasType.Type1,
            gasPrice: est.gasPrice,
          },
        };
  return [mk("slow", est.slow), mk("standard", est.average), mk("fast", est.fast)];
};

/** Build a custom override from entered wei values (undefined if incomplete). */
export const customOverride = (
  evmGasType: EVMGasType,
  fields: {
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  },
): GasOverride | undefined => {
  // Type4 takes the same 1559 fields as Type2.
  if (evmGasType === EVMGasType.Type2 || evmGasType === EVMGasType.Type4) {
    if (fields.maxFeePerGas === undefined || fields.maxPriorityFeePerGas === undefined)
      return undefined;
    return {
      evmGasType: EVMGasType.Type2,
      maxFeePerGas: fields.maxFeePerGas,
      maxPriorityFeePerGas: fields.maxPriorityFeePerGas,
    };
  }
  if (fields.gasPrice === undefined) return undefined;
  return {
    evmGasType: evmGasType as EVMGasType.Type0 | EVMGasType.Type1,
    gasPrice: fields.gasPrice,
  };
};

/** Apply an override to a TransactionGasDetails (private/shield), keeping gasEstimate. */
/**
 * Apply a chosen gas price to existing gas details.
 *
 * An override sets a PRICE; it does not decide the transaction type. The
 * override is built from the chain's default EVM gas type, which is never
 * Type4 — so taking the type from it downgrades a 7702 relay-adapt transaction
 * that is about to be submitted as type 4, and the estimate and proof no longer
 * describe what gets sent.
 *
 * Type4 is therefore preserved from `details`, and a legacy-shaped override is
 * mapped onto the 1559 fields it needs.
 *
 * A legacy override carries only a gasPrice, so the tip has to come from
 * somewhere. It used to be 0, which is a transaction no block will include: the
 * ceiling was the user's chosen price and the miner's share of it was nothing.
 * The tip already on `details` is kept instead — it was derived from the
 * network and is the figure the estimate was built around — clamped to the
 * chosen ceiling, since a tip above the max fee is rejected outright.
 */

/**
 * The tip to keep when a legacy override lands on a 1559 transaction.
 *
 * Carries the existing tip across, bounded by the new ceiling. Zero would be
 * unmineable; a tip larger than the max fee is invalid.
 */
const clampTip = (details: TransactionGasDetails, ceiling: bigint): bigint => {
  const existing =
    "maxPriorityFeePerGas" in details ? details.maxPriorityFeePerGas : 0n;
  return existing > ceiling ? ceiling : existing;
};

export const applyOverrideToDetails = (
  details: TransactionGasDetails,
  o: GasOverride,
): TransactionGasDetails => {
  const evmGasType =
    details.evmGasType === EVMGasType.Type4 ? EVMGasType.Type4 : o.evmGasType;
  const base = { evmGasType, gasEstimate: details.gasEstimate };

  if (evmGasType === EVMGasType.Type2 || evmGasType === EVMGasType.Type4) {
    return (
      o.evmGasType === EVMGasType.Type2
        ? { ...base, maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas }
        : {
            ...base,
            maxFeePerGas: priceField(o),
            maxPriorityFeePerGas: clampTip(details, priceField(o)),
          }
    ) as TransactionGasDetails;
  }
  return { ...base, gasPrice: priceField(o) } as TransactionGasDetails;
};

/** Apply an override to a populated ethers tx (public), keeping gasLimit. */
export const applyOverrideToTx = <
  T extends {
    gasPrice?: unknown;
    maxFeePerGas?: unknown;
    maxPriorityFeePerGas?: unknown;
  },
>(
  tx: T,
  o: GasOverride,
): T => {
  const copy = { ...tx } as Record<string, unknown>;
  delete copy.gasPrice;
  delete copy.maxFeePerGas;
  delete copy.maxPriorityFeePerGas;
  if (o.evmGasType === EVMGasType.Type2) {
    copy.maxFeePerGas = o.maxFeePerGas;
    copy.maxPriorityFeePerGas = o.maxPriorityFeePerGas;
  } else {
    copy.gasPrice = o.gasPrice;
  }
  return copy as T;
};

/** The 20% headroom shared-models adds in calculateGasLimit. */
const GAS_LIMIT_BUFFER_BPS = 12_000n;
const BPS = 10_000n;

/**
 * The gas estimate behind a populated gas limit.
 *
 * `calculateGasLimit` multiplies the estimate by 1.2 and the SDK writes that
 * onto the transaction, so the populated limit is the only place the figure
 * survives — the proved transaction does not carry the estimate itself.
 *
 * A broadcaster is quoted the estimate, not the limit, because it applies that
 * same 1.2x itself before submitting. Forwarding the already-padded figure
 * compounds to 1.44x, and the broadcaster fee — committed inside the proof as
 * `feePerUnitGas x calculateGasLimit(gasEstimate) x maxFeePerGas` — only ever
 * covers 1.2x. So the padded figure asks a broadcaster to submit with more gas
 * than it was paid for, which it is entitled to refuse.
 *
 * Integer division, so the result can be one wei of gas below the original.
 */
export const unbufferGasLimit = (populated: bigint): bigint =>
  (populated * BPS) / GAS_LIMIT_BUFFER_BPS;
