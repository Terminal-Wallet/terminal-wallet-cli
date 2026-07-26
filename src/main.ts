/**
 * Entry point.
 *
 * The wallet is being rebuilt around a renderer-agnostic core, so the terminal
 * UI is not wired here yet. Until it is, this entry runs the diagnostic — which
 * boots the same systems the real app does and reports what it finds:
 *
 *   terminal-wallet --selftest    no wallet, no password, safe to automate
 *   terminal-wallet               full boot + state dump (prompts once)
 *
 * Both survive once the UI lands; the diagnostic is how you tell a wallet
 * problem from a network problem without reading a rendered screen.
 */
import { runDiagnostic } from "./diagnostic/report";
import { clearConsoleBuffer, setConsoleTitle } from "./platform/console";
import { installProcessHandlers } from "./platform/lifecycle";
import { createLogger } from "./platform/logger";

const log = createLogger("main");

const main = async () => {
  // Before anything that can fail, so a crash during boot is reported and torn
  // down rather than swallowed.
  installProcessHandlers();
  setConsoleTitle();

  const argv = process.argv.slice(2);

  // The diagnostic modes are explicit. They stay available after the UI becomes
  // the default, because "is it the wallet or the network" is much easier to
  // answer from a state dump than from a rendered screen.
  if (argv.includes("--selftest") || argv.includes("--status")) {
    process.exit(await runDiagnostic(argv));
  }

  // Loaded on demand: the terminal UI pulls in blessed and builds a screen, and
  // the diagnostic modes above have no use for either.
  const { runDeck } = await import("./tui/entry.js");
  await runDeck();
};

clearConsoleBuffer();
main().catch((err: unknown) => {
  log.error("fatal error during startup", err);
  process.exit(1);
});
