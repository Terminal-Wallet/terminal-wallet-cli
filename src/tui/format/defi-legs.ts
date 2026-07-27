/**
 * What a DeFi batch actually does, step by step.
 *
 * A combo meal is several recipes chained, and each recipe is several steps —
 * so "deposit into a vault" can be a swap, two approvals, a deposit and a
 * shield, in one signature. Showing only the amount in and the amount out
 * asks the user to consent to the middle without seeing it.
 *
 * The cookbook already reports this: every `RecipeOutput` carries
 * `stepOutputs`, and each step names itself and declares what it spends and
 * produces. Nothing has to be inferred — this reads the ledger the recipe
 * built and turns it into lines.
 */
import { formatUnits } from "ethers";
import { RecipeOutput } from "@railgun-community/cookbook";

export interface DefiLeg {
  /** The step's own name. */
  name: string;
  /** What it consumes, already formatted. Absent when it consumes nothing. */
  spends?: string;
  /** What it produces. Absent when it produces nothing fungible. */
  gives?: string;
  /** A position moving in or out of this step. */
  nft?: "in" | "out";
  /**
   * Framing rather than substance — the unshield, approvals and the shield.
   * They matter for clear signing but they are not the thing being done, so a
   * renderer can dim them.
   */
  plumbing: boolean;
}

/** Steps that are how RAILGUN works rather than what the user asked for. */
const PLUMBING = /^(unshield|shield|approve)/i;

const trimAmount = (value: string): string => {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  const [whole, frac = ""] = trimmed.split(".");
  return frac.length > 6 ? `${whole}.${frac.slice(0, 6)}` : trimmed;
};

/**
 * `symbolOf` resolves a token address to a ticker. Unknown addresses fall back
 * to a short form rather than being hidden — a step moving a token nobody can
 * name is exactly the one worth showing.
 */
export const defiLegs = (
  output: RecipeOutput,
  symbolOf: (tokenAddress: string) => string | undefined,
): DefiLeg[] => {
  const amount = (
    entries: { tokenAddress: string; decimals: bigint; amount?: bigint; expectedBalance?: bigint }[],
  ): string | undefined => {
    const parts = entries
      .map((entry) => {
        const raw = entry.amount ?? entry.expectedBalance;
        if (raw === undefined || raw <= 0n) return undefined;
        const symbol =
          symbolOf(entry.tokenAddress) ?? `${entry.tokenAddress.slice(0, 6)}…`;
        return `${trimAmount(formatUnits(raw, Number(entry.decimals)))} ${symbol}`;
      })
      .filter((part): part is string => part !== undefined);
    return parts.length ? parts.join(" + ") : undefined;
  };

  return output.stepOutputs.map((step) => ({
    name: step.name.replace(/\s*\(Default\)$/, ""),
    spends: amount(step.spentERC20Amounts ?? []),
    gives: amount(step.outputERC20Amounts ?? []),
    nft: (step.spentNFTs ?? []).length
      ? ("in" as const)
      : (step.outputNFTs ?? []).length
        ? ("out" as const)
        : undefined,
    plumbing: PLUMBING.test(step.name),
  }));
};

/**
 * The legs as display lines.
 *
 * One line per step, because the question a reader has is "what happens, in
 * what order" and a wrapped paragraph does not answer it.
 */
export const defiLegLines = (
  legs: DefiLeg[],
  tag: (text: string, color: string) => string,
): string[] =>
  legs.map((leg, index) => {
    const colour = leg.plumbing ? "gray" : "white";
    const marker = tag(index === legs.length - 1 ? "└" : "├", "gray");
    const flow = [
      leg.spends,
      leg.gives ? `→ ${leg.gives}` : undefined,
      leg.nft === "out" ? "→ position" : leg.nft === "in" ? "position →" : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return `${marker} ${tag(leg.name, colour)}${flow ? `  ${tag(flow, "gray")}` : ""}`;
  });
