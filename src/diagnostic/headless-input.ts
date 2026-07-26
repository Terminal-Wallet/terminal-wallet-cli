/**
 * Input provider for the headless diagnostic.
 *
 * Built on node:readline rather than a prompt library on purpose. The terminal
 * UI is being rebuilt around this seam, and an implementation shaped around the
 * old enquirer flow would bias the seam toward blocking request/response
 * prompting — which is the wrong shape for a live UI. This host answers only
 * what the diagnostic genuinely needs and refuses the rest loudly.
 *
 * Non-interactive by construction when there is no TTY: every method returns
 * undefined rather than hanging forever on a pipe. That is what keeps
 * `--selftest` safe to run unattended.
 */
import readline from "node:readline";
import { WalletInputProvider, InputChoice } from "../core/input";
import { TMPWalletInfo } from "../models/wallet-models";
import { createLogger } from "../platform/logger";

const log = createLogger("input");

const isInteractive = (): boolean =>
  process.stdin.isTTY === true && process.stdout.isTTY === true;

/**
 * Read a line, optionally without echoing it.
 *
 * readline has no masked mode, so for secrets we mute the output stream and
 * write the prompt ourselves. `terminal: true` is still required — without it
 * readline never installs the keypress handling that makes `_writeToOutput`
 * reachable, and the password would echo in the clear.
 */
const readLine = (
  prompt: string,
  { secret = false }: { secret?: boolean } = {},
): Promise<string | undefined> =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (secret) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (rl as any)._writeToOutput = (chunk: string) => {
        // Let the prompt itself through; swallow the typed characters.
        if (chunk.includes(prompt)) {
          process.stdout.write(chunk);
        }
      };
    }

    rl.question(prompt, (answer) => {
      rl.close();
      if (secret) {
        process.stdout.write("\n");
      }
      resolve(answer);
    });

    rl.on("SIGINT", () => {
      rl.close();
      resolve(undefined);
    });
  });

const unsupported = (what: string): undefined => {
  log.error(
    `the headless diagnostic cannot ${what}; run this from the terminal UI`,
  );
  return undefined;
};

export const headlessInputProvider: WalletInputProvider = {
  async promptPassword(message: string): Promise<string | undefined> {
    if (!isInteractive()) {
      log.error("a password is required but no TTY is attached");
      return undefined;
    }
    const answer = await readLine(`${message} `, { secret: true });
    return answer !== undefined && answer.length > 0 ? answer : undefined;
  },

  async promptNewWallet(): Promise<TMPWalletInfo | undefined> {
    // Creating a wallet means handling a mnemonic. That belongs in a UI that
    // can present and confirm it properly, not in a diagnostic.
    return unsupported("create a wallet");
  },

  async confirm(message: string): Promise<boolean> {
    if (!isInteractive()) {
      return false;
    }
    const answer = await readLine(`${message} [y/N] `);
    return (answer ?? "").trim().toLowerCase().startsWith("y");
  },

  notify(message: string): void {
    log.info(message);
  },

  async select(
    message: string,
    choices: InputChoice[],
  ): Promise<string | undefined> {
    if (!isInteractive() || choices.length === 0) {
      return undefined;
    }
    log.info(message);
    choices.forEach((choice, index) => {
      log.info(`  ${index + 1}) ${choice.label}${choice.hint ? ` — ${choice.hint}` : ""}`);
    });
    const answer = await readLine("select a number: ");
    const index = Number.parseInt((answer ?? "").trim(), 10) - 1;
    return Number.isInteger(index) && index >= 0 && index < choices.length
      ? choices[index].value
      : undefined;
  },

  async multiSelect(
    message: string,
    choices: InputChoice[],
    opts?: { initial?: string[] },
  ): Promise<string[] | undefined> {
    if (!isInteractive() || choices.length === 0) {
      return undefined;
    }
    log.info(message);
    choices.forEach((choice, index) => {
      const preselected = opts?.initial?.includes(choice.value) ? "x" : " ";
      log.info(
        `  [${preselected}] ${index + 1}) ${choice.label}${choice.hint ? ` — ${choice.hint}` : ""}`,
      );
    });
    const answer = await readLine("select numbers (comma-separated, blank = keep): ");
    if (answer === undefined) {
      return undefined;
    }
    const trimmed = answer.trim();
    if (!trimmed) {
      return opts?.initial ?? [];
    }
    // Anything unparseable is dropped rather than guessed at — this picks which
    // assets get moved, so a typo must not silently widen the set.
    const picked = trimmed
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10) - 1)
      .filter((index) => Number.isInteger(index) && index >= 0 && index < choices.length)
      .map((index) => choices[index].value);
    return [...new Set(picked)];
  },

  async input(
    message: string,
    opts?: { password?: boolean; hint?: string },
  ): Promise<string | undefined> {
    if (!isInteractive()) {
      return undefined;
    }
    const suffix = opts?.hint ? ` (${opts.hint})` : "";
    const answer = await readLine(`${message}${suffix} `, {
      secret: opts?.password,
    });
    return answer !== undefined && answer.length > 0 ? answer : undefined;
  },
};
