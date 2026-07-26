/**
 * Seam-based gas-speed selection. Surfaces the slow/standard/fast fee matrix
 * (plus a custom entry) at the confirm step, through the input-provider so it
 * runs natively in blessed AND legacy. Returns a concrete GasOverride, the
 * sentinel "keep" (matrix unavailable → proceed with the auto estimate), or
 * undefined (the user cancelled).
 */
import { EVMGasType, NetworkName } from "@railgun-community/shared-models";
import { formatUnits, parseUnits } from "ethers";
import { getInputProvider } from "../../core/input";
import { getGasEstimates } from "../../railgun/gas/gas-fee";
import {
  presetsFromEstimate,
  customOverride,
  priceField,
  GasOverride,
} from "../../railgun/gas/gas-selection";

export type GasChoice = GasOverride | "keep" | undefined;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const gwei = (wei: bigint) => `${formatUnits(wei, "gwei")} gwei`;
const costOf = (o: GasOverride, gasEstimate: bigint, decimals: number) =>
  formatUnits(priceField(o) * gasEstimate, decimals);

export const collectGasSelection = async (
  chainName: NetworkName,
  evmGasType: EVMGasType,
  gasEstimate: bigint,
  symbol: string,
  baseDecimals: number,
): Promise<GasChoice> => {
  const provider = getInputProvider();

  let est;
  try {
    est = await getGasEstimates(chainName);
  } catch {
    // No fee history (some RPCs / testnets) — keep the auto estimate.
    provider.notify("Gas matrix unavailable — using the auto estimate.");
    return "keep";
  }

  const presets = presetsFromEstimate(evmGasType, est);
  const choices: { label: string; value: string }[] = presets.map((p) => ({
    label: `${cap(p.key)}  ~${costOf(p.override, gasEstimate, baseDecimals)} ${symbol}  (${gwei(
      priceField(p.override),
    )})`,
    value: p.key,
  }));
  choices.push({ label: "Custom…", value: "custom" });

  const pick = await provider.select("Gas speed", choices);
  if (!pick) return undefined;
  if (pick !== "custom") {
    return presets.find((p) => p.key === pick)?.override ?? "keep";
  }

  // Custom entry — EIP-1559 (maxFee + priority) or legacy (gasPrice).
  try {
    // Type4 is 1559-priced, so it collects the same two fields.
    if (evmGasType === EVMGasType.Type2 || evmGasType === EVMGasType.Type4) {
      const mf = await provider.input("Max fee per gas (gwei)");
      if (!mf) return undefined;
      const mp = await provider.input("Max priority fee per gas (gwei)");
      if (!mp) return undefined;
      return (
        customOverride(evmGasType, {
          maxFeePerGas: parseUnits(mf, "gwei"),
          maxPriorityFeePerGas: parseUnits(mp, "gwei"),
        }) ?? undefined
      );
    }
    const gp = await provider.input("Gas price (gwei)");
    if (!gp) return undefined;
    return customOverride(evmGasType, { gasPrice: parseUnits(gp, "gwei") }) ?? undefined;
  } catch {
    provider.notify("Invalid gas value.");
    return undefined;
  }
};
