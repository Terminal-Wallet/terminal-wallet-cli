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
import { errMessage } from "./platform/errors";
import { createLogger } from "./platform/logger";

const log = createLogger("main");

const main = async () => {
  // Before anything that can fail, so a crash during boot is reported and torn
  // down rather than swallowed.
  installProcessHandlers();
  setConsoleTitle();
  const code = await runDiagnostic(process.argv.slice(2));
  process.exit(code);
};

clearConsoleBuffer();
main().catch((err: unknown) => {
  log.error("fatal error during startup", err);
  process.exit(1);
});
