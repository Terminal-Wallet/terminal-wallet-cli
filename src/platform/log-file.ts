/**
 * The log that survives the session.
 *
 * Everything else the wallet says is transient: the status line expires, the
 * log pane dies with the process, and the terminal scrollback is gone the
 * moment the screen is restored. So when a transaction that moved real funds
 * failed, there was nothing left to read — the only record of why was a footer
 * message that a stuck progress bar had already hidden, and by the time anyone
 * went looking the process was gone.
 *
 * Deliberately small. This is a diagnostic tail, not an audit log: a bounded
 * file with one rotation. Redaction has already happened upstream — the logger
 * scrubs every argument before any sink sees it — so nothing here needs to know
 * what a secret looks like.
 *
 * Written with `writeSync` to an open descriptor rather than through a write
 * stream. A stream buffers and flushes on the event loop, which loses precisely
 * the lines worth having when the thing being diagnosed is a crash or a kill —
 * and its asynchronous open reports failure as an unhandled 'error' event,
 * which would take the wallet down over a log file.
 */
import fs from "fs";
import path from "path";
import { setDurableSink } from "./logger";

/**
 * How much history to keep, per file.
 *
 * Two files of this, so the worst case on disk is double. Sized to hold a
 * session's worth of engine chatter rather than a week's: the question this
 * answers is always "what happened just now".
 */
const MAX_BYTES = 2 * 1024 * 1024;

const LOG_NAME = "terminal-wallet.log";

let fd: number | undefined;
let written = 0;
let filePath: string | undefined;

/** Where the log lives, once opened. Shown to the user when something fails. */
export const logFilePath = (): string | undefined => filePath;

/** Give up quietly. Nothing this module does is worth breaking the wallet for. */
const disable = (): void => {
  setDurableSink(undefined);
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already gone */
    }
  }
  fd = undefined;
  filePath = undefined;
};

const rotate = (): void => {
  if (!filePath || fd === undefined) return;
  try {
    fs.closeSync(fd);
    // One generation. Keeping more would need a retention policy, and the
    // question this file answers is never about last week.
    fs.renameSync(filePath, `${filePath}.1`);
    fd = fs.openSync(filePath, "a", 0o600);
    written = 0;
  } catch {
    disable();
  }
};

/**
 * Start writing the durable log.
 *
 * Failure is not fatal and not fatal-looking: a wallet that refuses to start
 * because it could not open a log file is worse than one with no log. On any
 * error the sink is simply never installed.
 */
export const installLogFile = (dir = process.cwd()): void => {
  if (fd !== undefined) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const at = path.join(dir, LOG_NAME);
    // 0600, for the same reason the crash log is: this sits next to the wallet
    // database, it outlives the process, and redaction upstream only catches
    // the shapes it knows — a 64-hex key and a BIP39 phrase. What it leaves is
    // still a privacy record: recipients, the ephemeral executor address, and
    // the 0zk address next to the public one. `mode` applies only on create, so
    // an existing log from a build without it is corrected too.
    fd = fs.openSync(at, "a", 0o600);
    fs.fchmodSync(fd, 0o600);
    filePath = at;
    written = fs.statSync(at).size;
  } catch {
    disable();
    return;
  }

  const append = (text: string): void => {
    if (fd === undefined) return;
    try {
      fs.writeSync(fd, text);
      written += text.length;
      if (written >= MAX_BYTES) rotate();
    } catch {
      disable();
    }
  };

  append(`--- session start ${new Date().toISOString()} ---\n`);
  setDurableSink((line) => append(`${new Date().toISOString()} ${line}\n`));
};

/** Stop writing, on teardown. Safe to call when nothing was ever installed. */
export const closeLogFile = (): void => disable();
