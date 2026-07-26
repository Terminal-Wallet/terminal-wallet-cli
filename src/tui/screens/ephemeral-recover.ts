/**
 * Bring stranded assets at a prior ephemeral index back into RAILGUN.
 *
 * Split out of the console because it is the one action there that spends: it
 * picks assets, chooses who pays, builds a proof and broadcasts. The console
 * finds the account and hands over what is at it — this never asks which index,
 * because being asked was the reason the old flow could not be used.
 */
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { DeckContext } from "../context";
import { getInputProvider } from "../../core/input";
import { setState } from "../store";
import { showText } from "./popout";
import { recoverySummaryLines } from "../format/ephemeral";
import {
  getProvedEphemeralRecoveryTransaction,
  submitRecoveryTransaction,
  EphemeralAssetScan,
  RecoverableERC20,
} from "../../railgun/wallet/ephemeral-recovery";
import { collectFeeMode } from "../../flows/collect/fee";
import { runGasTierPrompt } from "./gas-tier";
import { clearGasFeeSelection } from "../../railgun/gas/gas-fee";
import { getTransactionURLForChain } from "../../railgun/network/network-util";

/** Nominal gas units for a relay-adapt recovery bundle, for the fee preview. */
const RECOVERY_GAS_UNITS = 2_800_000n;

/** The native asset's sentinel in the reshield picker. */
const NATIVE = "__native__";

/**
 * Pick which stranded assets to reshield. Everything is pre-selected, because
 * the usual answer is "all of it" and the picker exists for the exception.
 */
const pickAssets = async (
  nativeWei: bigint,
  erc20s: RecoverableERC20[],
): Promise<{ native: boolean; erc20s: RecoverableERC20[] } | undefined> => {
  const choices = [
    ...(nativeWei > 0n
      ? [
          {
            label: `ETH   ${formatUnits(nativeWei, 18)}`,
            value: NATIVE,
            hint: "wrap → WETH → shield",
          },
        ]
      : []),
    ...erc20s.map((token) => ({
      label: `${token.symbol.padEnd(8)} ${formatUnits(token.balance, token.decimals)}`,
      value: token.tokenAddress,
    })),
  ];
  const picked = await getInputProvider().multiSelect(
    "Select assets to reshield",
    choices,
    { initial: choices.map((choice) => choice.value) },
  );
  if (!isDefined(picked) || picked.length === 0) return undefined;
  return {
    native: picked.includes(NATIVE),
    erc20s: erc20s.filter((token) => picked.includes(token.tokenAddress)),
  };
};

export const runRecovery = async (
  ctx: DeckContext,
  chainName: NetworkName,
  encryptionKey: string,
  targetIndex: number,
  scan: EphemeralAssetScan,
): Promise<void> => {
  const provider = getInputProvider();
  // Start from a clean slate: a tier left over from an earlier operation would
  // silently price this one.
  clearGasFeeSelection();
  try {
    if (scan.nativeWei === 0n && scan.erc20s.length === 0) {
      provider.notify(`Nothing stranded at [${targetIndex}].`);
      return;
    }
    if (scan.method === "tokenlist") {
      provider.notify("Curated-list scan only — arbitrary tokens may be missed.");
    }

    const selection = await pickAssets(scan.nativeWei, scan.erc20s);
    if (!selection) {
      provider.notify("Nothing selected.");
      return;
    }

    // Who pays: a broadcaster relays it, or the public wallet self-broadcasts.
    // Never assumed — this is a real transaction with a real cost.
    const funding = await collectFeeMode(chainName, true, RECOVERY_GAS_UNITS);
    if (!funding) return;
    const broadcaster =
      funding.kind === "broadcaster" ? funding.broadcaster : undefined;
    const fundingLabel = broadcaster
      ? `broadcaster (fee token ${broadcaster.tokenAddress})`
      : "self-broadcast (your public wallet pays gas)";

    await runGasTierPrompt(chainName, RECOVERY_GAS_UNITS);

    setState({ status: "Building recovery proof…" });
    const proved = await getProvedEphemeralRecoveryTransaction(
      chainName,
      encryptionKey,
      targetIndex,
      {
        erc20s: selection.erc20s,
        nativeWei: selection.native ? scan.nativeWei : undefined,
      },
      broadcaster,
    );

    const assets = [
      ...(selection.native ? [`${formatUnits(scan.nativeWei, 18)} ETH`] : []),
      ...selection.erc20s.map(
        (token) => `${formatUnits(token.balance, token.decimals)} ${token.symbol}`,
      ),
    ].join(", ");
    const lines = recoverySummaryLines({
      assets,
      index: targetIndex,
      funding: fundingLabel,
      gasLimit: proved.transaction.gasLimit ?? 0n,
      maxFeePerGas: proved.transaction.maxFeePerGas ?? undefined,
      estimatedCost: `${proved.estimatedCost}`,
      feeSymbol: proved.feeSymbol,
    });
    await showText(ctx, "recovery · review", lines.join("\n"), "yellow");
    if (!(await provider.confirm("Send this recovery?"))) return;

    setState({ status: "Submitting recovery…" });
    const txHash = await submitRecoveryTransaction(chainName, proved, broadcaster);
    provider.notify(
      `Recovery submitted: ${getTransactionURLForChain(chainName, txHash)}`,
    );
    void ctx.refreshBalances();
    void ctx.refreshHistory();
  } catch (err) {
    provider.notify(`Recovery failed: ${(err as Error).message}`);
  } finally {
    // Every exit path, including a declined confirm and every early return
    // above, so a tier picked here can never price a later transaction.
    clearGasFeeSelection();
  }
};
