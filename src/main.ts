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
import { clearConsoleBuffer, setConsoleTitle } from "./util/error-util";

const main = async () => {
  setConsoleTitle();
  const code = await runDiagnostic(process.argv.slice(2));
  process.exit(code);
};

clearConsoleBuffer();
main().catch((err: Error) => {
  // Nothing below this point can report, so write plainly and fail loudly.
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
