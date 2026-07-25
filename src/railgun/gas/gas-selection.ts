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
export const priceField = (o: GasOverride): bigint =>
  o.evmGasType === EVMGasType.Type2 ? o.maxFeePerGas : o.gasPrice;

/** Build slow/standard/fast overrides from a fee-history estimate. */
export const presetsFromEstimate = (
  evmGasType: EVMGasType,
  est: CustomGasEstimate,
): GasPreset[] => {
  const mk = (key: GasPreset["key"], priority: bigint): GasPreset =>
    evmGasType === EVMGasType.Type2
      ? {
          key,
          override: {
            evmGasType: EVMGasType.Type2,
            maxFeePerGas: priority + est.baseFeePerGas,
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
  if (evmGasType === EVMGasType.Type2) {
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
export const applyOverrideToDetails = (
  details: TransactionGasDetails,
  o: GasOverride,
): TransactionGasDetails => {
  const base = { evmGasType: o.evmGasType, gasEstimate: details.gasEstimate };
  return (
    o.evmGasType === EVMGasType.Type2
      ? { ...base, maxFeePerGas: o.maxFeePerGas, maxPriorityFeePerGas: o.maxPriorityFeePerGas }
      : { ...base, gasPrice: o.gasPrice }
  ) as TransactionGasDetails;
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
