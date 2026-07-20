import { NetworkName, isDefined } from "@railgun-community/shared-models";
import "colors";
import { FeeData, formatUnits, parseUnits } from "ethers";
import {
  getGasFeeTiers,
  setGasFeeSelection,
  GasTierKey,
} from "../gas/gas-fee";
import { confirmPromptCatch } from "./confirm-ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, NumberPrompt } = require("enquirer");

const gwei = (value: bigint): string => formatUnits(value, "gwei");

const TIER_LABELS: Record<GasTierKey, string> = {
  slow: "Slow  (60%)",
  average: "Average (80%)",
  fast: "Fast  (95%)",
};

// Per-transaction gas-fee matrix. Presents the network's slow/average/fast EIP-1559 tiers
// (plus a custom entry) and, when a gas-limit estimate is already known, the approximate
// total cost per tier. The chosen fee is stored as the build's gas override and returned;
// selecting "keep current" leaves whatever is already set. All flows honor the override via
// getFeeDetailsForChain.
export const gasFeeMatrixPrompt = async (
  chainName: NetworkName,
  gasLimit?: bigint,
): Promise<FeeData | undefined> => {
  let tiers;
  try {
    tiers = await getGasFeeTiers(chainName);
  } catch (err) {
    console.log(
      `Could not load gas tiers (${(err as Error).message}); keeping default gas.`
        .grey,
    );
    return undefined;
  }

  const costSuffix = (maxFeePerGas: bigint): string =>
    isDefined(gasLimit)
      ? `  ~${formatUnits(maxFeePerGas * gasLimit, "ether")} ETH`
      : "";

  const choices = tiers.tiers.map((tier) => ({
    name: tier.key as string,
    message:
      `${TIER_LABELS[tier.key].padEnd(14)} ` +
      `max ${gwei(tier.maxFeePerGas).padStart(9)} gwei · ` +
      `prio ${gwei(tier.maxPriorityFeePerGas).padStart(8)} gwei` +
      costSuffix(tier.maxFeePerGas),
  }));
  choices.push({
    name: "custom",
    message: "Custom…  (enter max fee / priority in gwei)",
  });
  choices.push({ name: "keep", message: "Keep current".grey });

  const prompt = new Select({
    header: " ",
    message: `Gas Fee — ${chainName}  (base fee ${gwei(tiers.baseFeePerGas)} gwei)`,
    choices,
    multiple: false,
  });

  const choice = await prompt.run().catch(confirmPromptCatch);
  if (!isDefined(choice) || choice === "keep") {
    return undefined;
  }

  let maxFeePerGas: bigint;
  let maxPriorityFeePerGas: bigint;

  if (choice === "custom") {
    const maxInput = new NumberPrompt({
      header: " ",
      message: "Max fee per gas (gwei):",
      float: true,
    });
    const maxValue = await maxInput.run().catch(confirmPromptCatch);
    const prioInput = new NumberPrompt({
      header: " ",
      message: "Max priority fee per gas (gwei):",
      float: true,
    });
    const prioValue = await prioInput.run().catch(confirmPromptCatch);
    if (!isDefined(maxValue) || !isDefined(prioValue)) {
      return undefined;
    }
    try {
      maxFeePerGas = parseUnits(`${maxValue}`, "gwei");
      maxPriorityFeePerGas = parseUnits(`${prioValue}`, "gwei");
    } catch {
      console.log("Invalid gwei value; keeping default gas.".red);
      return undefined;
    }
    if (maxFeePerGas <= 0n) {
      console.log("Max fee must be greater than zero.".red);
      return undefined;
    }
    if (maxPriorityFeePerGas > maxFeePerGas) {
      console.log("Priority fee cannot exceed max fee.".red);
      return undefined;
    }
  } else {
    const tier = tiers.tiers.find((entry) => entry.key === choice);
    if (!isDefined(tier)) {
      return undefined;
    }
    ({ maxFeePerGas, maxPriorityFeePerGas } = tier);
  }

  // gasPrice aligns to the chosen effective price so legacy/Type-1 (broadcaster) flows,
  // which read gasPrice, use the same tier the user picked.
  const feeData = {
    gasPrice: maxFeePerGas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  } as FeeData;

  setGasFeeSelection(chainName, feeData);
  console.log(
    `Gas fee set — max ${gwei(maxFeePerGas)} gwei · priority ${gwei(
      maxPriorityFeePerGas,
    )} gwei`.green,
  );
  return feeData;
};
