import { NetworkName, isDefined } from "@railgun-community/shared-models";
import "colors";
import {
  advanceEphemeralIndex,
  getCurrentEphemeralInfo,
  getEphemeralAddressForIndex,
  getEphemeralHistory,
  setEphemeralIndex,
  syncEphemeralIndexFromHistory,
} from "../wallet/ephemeral-util";
import {
  getProvedEphemeralRecoveryTransaction,
  scanEphemeralAssets,
  submitRecoveryTransaction,
} from "../wallet/ephemeral-recovery";
import { runFeeTokenSelector } from "./token-ui";
import { gasFeeMatrixPrompt } from "./gas-ui";
import { clearGasFeeSelection } from "../gas/gas-fee";
import { getTransactionURLForChain } from "../network/network-util";
import { getSaltedPassword } from "../wallet/wallet-password";
import { formatUnits } from "ethers";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "./confirm-ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, NumberPrompt, MultiSelect } = require("enquirer");

const ephemeralAdminLoop = async (
  chainName: NetworkName,
  encryptionKey: string,
): Promise<void> => {
  let info: { index: number; address: string };
  try {
    info = await getCurrentEphemeralInfo(chainName, encryptionKey);
  } catch (err) {
    console.log(
      `Could not read ephemeral state: ${(err as Error).message}`.red,
    );
    await confirmPromptCatchRetry("");
    return;
  }

  const prompt = new Select({
    header: " ",
    message:
      `7702 Ephemeral Accounts — ${chainName}\n` +
      `  current index : ${`${info.index}`.cyan}\n` +
      `  address       : ${info.address.grey}`,
    choices: [
      { name: "show", message: "Show current ephemeral" },
      { name: "balances", message: "Show on-chain balances (current index)" },
      { name: "recover", message: "Recover stranded funds (reshield)" },
      { name: "history", message: "Show history" },
      { name: "sync", message: "Sync index from history" },
      { name: "advance", message: "Advance to next ephemeral (ratchet +1)" },
      { name: "set", message: "Set / reset current index" },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });

  const option = await prompt.run().catch(confirmPromptCatch);
  if (!isDefined(option) || option === "exit-menu") {
    return;
  }

  switch (option) {
    case "show": {
      console.log(
        `Ephemeral index ${`${info.index}`.cyan}  ->  ${info.address.green}`,
      );
      await confirmPromptCatchRetry("");
      break;
    }
    case "balances": {
      try {
        const scan = await scanEphemeralAssets(chainName, info.address);
        console.log(
          `Ephemeral [${`${info.index}`.cyan}] ${info.address.grey}`,
        );
        const native = formatUnits(scan.nativeWei, 18);
        console.log(
          `  ${"ETH".padEnd(8)} ${scan.nativeWei > 0n ? native.green : native.grey}`,
        );
        for (const t of scan.erc20s) {
          console.log(
            `  ${t.symbol.padEnd(8)} ${formatUnits(t.balance, t.decimals).green}  ${t.tokenAddress.grey}`,
          );
        }
        if (scan.nativeWei === 0n && scan.erc20s.length === 0) {
          console.log("  (nothing stranded at this ephemeral)".grey);
        }
        if (scan.method === "tokenlist") {
          console.log(
            "  note: log scan unavailable — curated token list only; arbitrary tokens may be missed."
              .yellow,
          );
        }
      } catch (err) {
        console.log(`Balance lookup failed: ${(err as Error).message}`.red);
      }
      await confirmPromptCatchRetry("");
      break;
    }
    case "recover": {
      clearGasFeeSelection(); // start fresh; no stale tier from a prior op
      const idxInput = new NumberPrompt({
        header: " ",
        message: "Recover from ephemeral index:",
        initial: info.index,
      });
      const idxVal = await idxInput.run().catch(confirmPromptCatch);
      if (!isDefined(idxVal)) {
        break;
      }
      const targetIndex = Math.trunc(Number(idxVal));
      if (!Number.isInteger(targetIndex) || targetIndex < 0) {
        console.log("Index must be a non-negative integer.".red);
        await confirmPromptCatchRetry("");
        break;
      }
      try {
        const address = await getEphemeralAddressForIndex(
          chainName,
          encryptionKey,
          targetIndex,
        );
        console.log(
          `Scanning ephemeral [${`${targetIndex}`.cyan}] ${address.grey} ...`,
        );
        const scan = await scanEphemeralAssets(chainName, address);
        const hasNative = scan.nativeWei > 0n;
        if (!hasNative && scan.erc20s.length === 0) {
          console.log("Nothing stranded at this ephemeral.".grey);
          await confirmPromptCatchRetry("");
          break;
        }
        if (scan.method === "tokenlist") {
          console.log(
            "  note: curated-list scan only; arbitrary tokens may be missed.".yellow,
          );
        }

        // Selective picker — choose which stranded assets to reshield (all pre-selected).
        const NATIVE = "__native__";
        const pickChoices = [
          ...(hasNative
            ? [
                {
                  name: NATIVE,
                  message: `ETH   ${formatUnits(scan.nativeWei, 18)}  (wrap -> WETH -> shield)`,
                },
              ]
            : []),
          ...scan.erc20s.map((t) => ({
            name: t.tokenAddress,
            message: `${t.symbol.padEnd(8)} ${formatUnits(t.balance, t.decimals)}`,
          })),
        ];
        const picker = new MultiSelect({
          header: " ",
          message:
            "Select assets to reshield (space to toggle, enter to confirm)",
          choices: pickChoices,
          initial: pickChoices.map((c) => c.name),
        });
        const picked: string[] | undefined = await picker
          .run()
          .catch(confirmPromptCatch);
        if (!isDefined(picked) || picked.length === 0) {
          console.log("Nothing selected.".grey);
          break;
        }
        const pickedNative = picked.includes(NATIVE);
        const pickedERC20s = scan.erc20s.filter((t) =>
          picked.includes(t.tokenAddress),
        );

        // 1) Signer / fee funding — broadcaster (relayed) or self-broadcast, never assumed.
        const funding = await runFeeTokenSelector(chainName, [], undefined, true);
        const broadcaster = funding?.bestBroadcaster;
        const fundingLabel = isDefined(broadcaster)
          ? `broadcaster (fee token ${broadcaster.tokenAddress})`
          : "self-broadcast (your public wallet pays gas)";

        // 2) Gas price — pick a tier (or keep the conservative default).
        await gasFeeMatrixPrompt(chainName);

        // 3) Build the proof (respects the gas selection above).
        console.log("Building recovery proof...".yellow);
        const proved = await getProvedEphemeralRecoveryTransaction(
          chainName,
          encryptionKey,
          targetIndex,
          {
            erc20s: pickedERC20s,
            nativeWei: pickedNative ? scan.nativeWei : undefined,
          },
          broadcaster,
        );

        // 4) Confirm with the action + resolved gas displayed.
        const summary = [
          ...(pickedNative ? [`${formatUnits(scan.nativeWei, 18)} ETH`] : []),
          ...pickedERC20s.map(
            (t) => `${formatUnits(t.balance, t.decimals)} ${t.symbol}`,
          ),
        ].join(", ");
        const gwei = (v?: bigint) =>
          isDefined(v) ? `${formatUnits(v, "gwei")} gwei` : "n/a";
        const tx = proved.transaction;
        console.log("");
        console.log("Recovery summary".yellow);
        console.log(`  reshield : ${summary.green}  -> your RAILGUN balance`);
        console.log(`  from     : ephemeral [${`${targetIndex}`.cyan}]`);
        console.log(`  funding  : ${fundingLabel}`);
        console.log(
          `  gas      : limit ${`${tx.gasLimit}`.cyan}, maxFee ${gwei(tx.maxFeePerGas as bigint)}`,
        );
        console.log(
          `  est cost : ${`${proved.estimatedCost}`.cyan} ${proved.feeSymbol}`,
        );
        console.log("");
        const confirmed = await confirmPrompt("Send this recovery?");
        if (!confirmed) {
          break;
        }

        console.log("Submitting recovery...".yellow);
        const txHash = await submitRecoveryTransaction(
          chainName,
          proved,
          broadcaster,
        );
        console.log(
          `Recovery submitted: ${getTransactionURLForChain(chainName, txHash).green}`,
        );
      } catch (err) {
        console.log(`Recovery failed: ${(err as Error).message}`.red);
      } finally {
        // Clear the picked gas tier on EVERY exit path (incl. a declined-confirm or
        // nothing-selected break) so it can never leak into a later flow.
        clearGasFeeSelection();
      }
      await confirmPromptCatchRetry("");
      break;
    }
    case "history": {
      try {
        const { currentIndex, earlierOmitted, entries } =
          await getEphemeralHistory(chainName, encryptionKey);
        console.log(
          `Ephemeral history — ${chainName} · current index ${`${currentIndex}`.cyan}`,
        );
        if (earlierOmitted > 0) {
          console.log(`  (${earlierOmitted} earlier ephemeral(s) omitted)`.grey);
        }
        for (const entry of entries) {
          const isCurrent = entry.index === currentIndex;
          const marker = isCurrent ? "→".cyan : "  ";
          const status = isCurrent
            ? "current".cyan
            : entry.usedForUnshield
            ? "unshield/swap".green
            : "used".grey;
          console.log(
            `${marker} [${`${entry.index}`.padStart(4)}] ${entry.address}  ${status}`,
          );
        }
      } catch (err) {
        console.log(`History unavailable: ${(err as Error).message}`.red);
      }
      await confirmPromptCatchRetry("");
      break;
    }
    case "sync": {
      try {
        const { before, after } = await syncEphemeralIndexFromHistory(
          chainName,
          encryptionKey,
        );
        console.log(
          before === after
            ? `Index already in sync at ${`${after}`.cyan}.`
            : `Index realigned ${`${before}`.yellow} -> ${`${after}`.green}.`,
        );
      } catch (err) {
        console.log(`Sync failed: ${(err as Error).message}`.red);
      }
      await confirmPromptCatchRetry("");
      break;
    }
    case "advance": {
      const confirmed = await confirmPrompt(
        `Advance the ephemeral index past ${info.index}? The current address (${info.address}) will be skipped for future ops.`,
      );
      if (confirmed) {
        try {
          const { before, after } = await advanceEphemeralIndex(chainName);
          console.log(
            `Ephemeral index ${`${before}`.yellow} -> ${`${after}`.green}.`,
          );
        } catch (err) {
          console.log(`Advance failed: ${(err as Error).message}`.red);
        }
      }
      await confirmPromptCatchRetry("");
      break;
    }
    case "set": {
      const input = new NumberPrompt({
        header: " ",
        message: "Set ephemeral index to:",
        initial: info.index,
      });
      const value = await input.run().catch(confirmPromptCatch);
      if (isDefined(value)) {
        const target = Math.trunc(Number(value));
        if (!Number.isInteger(target) || target < 0) {
          console.log("Index must be a non-negative integer.".red);
        } else {
          let confirmed = true;
          if (target < info.index) {
            confirmed = await confirmPrompt(
              `Setting the index below the current (${info.index}) can reuse an already-spent ephemeral, which makes the nonce-0 7702 authorization invalid and can strand funds. Continue?`,
            );
          }
          if (confirmed) {
            try {
              await setEphemeralIndex(chainName, target);
              console.log(`Ephemeral index set to ${`${target}`.green}.`);
            } catch (err) {
              console.log(`Set failed: ${(err as Error).message}`.red);
            }
          }
        }
      }
      await confirmPromptCatchRetry("");
      break;
    }
    default:
      break;
  }

  await ephemeralAdminLoop(chainName, encryptionKey);
};

// Day-to-day management console for the wallet's 7702 relay-adapt ephemeral accounts.
// Tier 1: local index operations only — no RPC address queries, no fund movement.
// Password-gated on entry because it can mutate the persisted ephemeral index.
export const runEphemeralAdminPrompt = async (
  chainName: NetworkName,
): Promise<void> => {
  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) {
    return;
  }
  await ephemeralAdminLoop(chainName, encryptionKey);
};
