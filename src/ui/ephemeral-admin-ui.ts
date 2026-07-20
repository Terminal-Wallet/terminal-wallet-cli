import { NetworkName, isDefined } from "@railgun-community/shared-models";
import "colors";
import {
  advanceEphemeralIndex,
  getCurrentEphemeralInfo,
  getEphemeralHistory,
  setEphemeralIndex,
  syncEphemeralIndexFromHistory,
} from "../wallet/ephemeral-util";
import { getSaltedPassword } from "../wallet/wallet-password";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "./confirm-ui";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, NumberPrompt } = require("enquirer");

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
