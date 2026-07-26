/**
 * Copy text to the clipboard, best-effort. Primary path is an OSC 52 terminal
 * escape (works over SSH, no deps); we also fire a system clipboard helper
 * (pbcopy / xclip / wl-copy / clip) when present, since some terminals disable
 * OSC 52. Neither path can be reliably probed, so callers should always show a
 * "Copied" confirmation regardless.
 */
import { spawn } from "node:child_process";
import { osc52 } from "../osc52";

const trySystemClipboard = (text: string): void => {
  // Ordered by platform; the first present binary wins, the rest fail silently.
  const candidates: [string, string[]][] = [
    ["pbcopy", []],
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
    ["clip", []],
  ];
  for (const [cmd, args] of candidates) {
    try {
      const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => undefined); // binary not present → ignore
      child.stdin.on("error", () => undefined);
      child.stdin.end(text);
    } catch {
      /* ignore */
    }
  }
};

/** Best-effort copy: OSC 52 to the terminal + system clipboard helpers. */
export const copyToClipboard = (text: string): void => {
  try {
    process.stdout.write(osc52(text));
  } catch {
    /* not a TTY */
  }
  trySystemClipboard(text);
};
