/**
 * The gas-fee matrix, as a persisted per-chain override.
 *
 * Distinct from `flows/collect/gas.ts`, which returns a choice for one build's
 * gas field. This one *sets* the selection that `getFeeDetailsForChain` reads,
 * for flows that construct a transaction outside the builder — recovery being
 * the one that needs it. The caller owns clearing it, on every exit path, so a
 * tier picked for a recovery can never leak into the next transaction.
 *
 * Presents the network's slow/average/fast EIP-1559 tiers plus a custom entry,
 * with an approximate total cost per tier when a gas limit is known.
 */
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { FeeData, formatUnits, parseUnits } from "ethers";
import { getInputProvider } from "../../core/input";
import { getGasFeeTiers, setGasFeeSelection, GasTierKey } from "../../railgun/gas/gas-fee";
import { tag } from "../format/tags";

const gwei = (value: bigint): string => formatUnits(value, "gwei");

const TIER_LABELS: Record<GasTierKey, string> = {
  slow: "Slow  (25%)",
  average: "Average (50%)",
  fast: "Fast  (75%)",
};

export type CustomTier =
  | { ok: true; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { ok: false; message: string };

/**
 * Validate a hand-entered tier.
 *
 * Three ways to get this wrong, and each is silent if unchecked: a value that
 * is not a number at all, a zero max fee (a transaction that can never be
 * mined), and a priority above the max (which most nodes reject outright).
 */
export const parseCustomTier = (
  maxRaw: string | undefined,
  priorityRaw: string | undefined,
): CustomTier => {
  if (!maxRaw?.trim() || !priorityRaw?.trim()) {
    return { ok: false, message: "Cancelled." };
  }
  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;
  try {
    maxFeePerGas = parseUnits(maxRaw.trim(), "gwei");
    maxPriorityFeePerGas = parseUnits(priorityRaw.trim(), "gwei");
  } catch {
    return { ok: false, message: "Invalid gwei value; keeping default gas." };
  }
  if (maxFeePerGas <= 0n) {
    return { ok: false, message: "Max fee must be greater than zero." };
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    return { ok: false, message: "Priority fee cannot exceed max fee." };
  }
  return { ok: true, maxFeePerGas, maxPriorityFeePerGas };
};

/**
 * `gasPrice` is set to the chosen `maxFeePerGas` on purpose.
 *
 * Type-1 / legacy paths — which is what a broadcaster submission becomes — read
 * `gasPrice` and ignore the 1559 fields. Without this they would silently use
 * the network default instead of the tier the user picked.
 */
export const feeDataForTier = (
  maxFeePerGas: bigint,
  maxPriorityFeePerGas: bigint,
): FeeData =>
  ({ gasPrice: maxFeePerGas, maxFeePerGas, maxPriorityFeePerGas }) as FeeData;

/**
 * Returns the selection it persisted, or undefined when the tier is unchanged —
 * either because the user kept the current one, cancelled, or the tiers could
 * not be loaded. Undefined always means "nothing was set".
 */
export const runGasTierPrompt = async (
  chainName: NetworkName,
  gasLimit?: bigint,
): Promise<FeeData | undefined> => {
  const provider = getInputProvider();

  let tiers;
  try {
    tiers = await getGasFeeTiers(chainName);
  } catch (err) {
    provider.notify(
      `Could not load gas tiers (${(err as Error).message}); keeping default gas.`,
    );
    return undefined;
  }

  const costSuffix = (maxFeePerGas: bigint): string =>
    isDefined(gasLimit)
      ? `  ~${formatUnits(maxFeePerGas * gasLimit, "ether")} ETH`
      : "";

  const choices = tiers.tiers.map((tier) => ({
    label:
      `${TIER_LABELS[tier.key].padEnd(14)} ` +
      `max ${gwei(tier.maxFeePerGas).padStart(9)} gwei · ` +
      `prio ${gwei(tier.maxPriorityFeePerGas).padStart(8)} gwei` +
      costSuffix(tier.maxFeePerGas),
    value: tier.key as string,
  }));
  choices.push({
    label: "Custom…  (enter max fee / priority in gwei)",
    value: "custom",
  });
  choices.push({ label: tag("Keep current", "gray"), value: "keep" });

  const choice = await provider.select(
    `Gas Fee — ${chainName}  (base fee ${gwei(tiers.baseFeePerGas)} gwei)`,
    choices,
  );
  if (!isDefined(choice) || choice === "keep") {
    return undefined;
  }

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;

  if (choice === "custom") {
    const maxRaw = await provider.input("Max fee per gas (gwei)");
    const priorityRaw = await provider.input("Max priority fee per gas (gwei)");
    const parsed = parseCustomTier(maxRaw, priorityRaw);
    if (!parsed.ok) {
      if (parsed.message !== "Cancelled.") provider.notify(parsed.message);
      return undefined;
    }
    ({ maxFeePerGas, maxPriorityFeePerGas } = parsed);
  } else {
    const tier = tiers.tiers.find((entry) => entry.key === choice);
    if (!isDefined(tier)) return undefined;
    ({ maxFeePerGas, maxPriorityFeePerGas } = tier);
  }

  const feeData = feeDataForTier(maxFeePerGas, maxPriorityFeePerGas);
  setGasFeeSelection(chainName, feeData);
  provider.notify(
    `Gas fee set — max ${gwei(maxFeePerGas)} gwei · priority ${gwei(maxPriorityFeePerGas)} gwei`,
  );
  return feeData;
};
