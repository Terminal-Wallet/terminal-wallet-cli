/**
 * The only place headless mode writes to a stream.
 *
 * stdout carries exactly one thing: the result document. That is the whole
 * contract — a caller pipes it into `jq` and gets an answer, or it does not
 * work at all. Everything else the wallet has to say goes to stderr, including
 * the SDK's provider health checks, which are chatty enough to print whole HTML
 * error bodies.
 *
 * The routing is done with a log SINK rather than by changing the logger's
 * defaults, because that is the seam that already exists. It has one sharp
 * edge, and it is the reason `run.ts` never calls `processSafeExit`: three
 * separate paths in `lifecycle.ts` call `setLogSink(undefined)` on their way
 * out, and the default routing underneath sends `info` to stdout. A shutdown
 * that released the sink and then logged would put a line in front of the JSON.
 *
 * Exempt from the raw-stdio guard, and the exemption is the point: this file is
 * where the writes are allowed to be so that nowhere else needs them.
 */
import fs from "fs";
import path from "path";
import { setLogSink } from "./logger";

/** Send every log line to stderr, whatever its level. */
export const installStderrLogSink = (): void => {
  setLogSink(({ level, namespace, text }) => {
    process.stderr.write(`terminal-wallet:${level}:${namespace} ${text}\n`);
  });
};

/** One line of human-facing text, on stderr where it cannot corrupt the payload. */
export const writeStderr = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

/**
 * Exactly these bytes, no newline.
 *
 * For the masked password prompt, which has to decide character by character
 * what reaches the terminal — a line-oriented writer cannot express "echo the
 * prompt and swallow what is typed after it". It lives here so that file stays
 * the only one allowed to touch a stream.
 */
export const writeStderrRaw = (text: string): void => {
  process.stderr.write(text);
};

/** The stream a prompt should be attached to. Never stdout. */
export const promptStream = (): NodeJS.WriteStream => process.stderr;

/** The payload. Called once, at the very end. */
export const writeStdout = (text: string): void => {
  process.stdout.write(text);
};

/**
 * Write the result file.
 *
 * Refuses to overwrite: a clobbered result is an untraceable record of
 * something that may have moved funds, and a caller that passed the same path
 * twice is more likely to have made a mistake than to have meant it. 0600
 * because the document names amounts, addresses and a wallet.
 *
 * Never throws. This runs on the way out, after a transaction may already have
 * been broadcast, so a failure here must not take the exit path with it — the
 * caller gets a warning on the envelope and the payload still reaches stdout.
 */
export const writeResultFile = (
  filePath: string,
  contents: string,
): { ok: true } | { ok: false; error: string } => {
  try {
    const resolved = path.resolve(filePath);
    fs.writeFileSync(resolved, contents, { mode: 0o600, flag: "wx" });
    return { ok: true };
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error:
        code === "EEXIST"
          ? `${filePath} already exists; refusing to overwrite it`
          : `could not write ${filePath}: ${(err as Error).message}`,
    };
  }
};
