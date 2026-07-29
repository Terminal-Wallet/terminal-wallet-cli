/**
 * Process lifecycle — bounded shutdown, signal handling, and the last-resort
 * exception handlers.
 *
 * Two things here are not how they were:
 *
 * 1. Shutdown is BOUNDED. `stopEngine`/`stopWakuClient` talk to native modules
 *    and a libp2p mesh; either can hang. An unbounded teardown means the exit
 *    path never completes and the process has to be killed, which is how a
 *    LevelDB lock gets left behind.
 *
 * 2. Failures EXIT NON-ZERO. Previously every exit was code 0 — including the
 *    ones reached from an uncaught exception — so a supervisor, a CI job, or a
 *    shell `&&` saw success no matter what happened.
 *
 * Handlers are installed explicitly via `installProcessHandlers()` rather than
 * as an import side effect, so importing this module in a test does not hijack
 * the test runner's own exception handling.
 */
import fs from "fs";
import path from "path";
import { rimrafSync } from "rimraf";
import configDefaults from "../config/config-defaults";
import { stopEngine } from "../railgun/engine/engine";
import { stopWakuClient } from "../railgun/waku/connect-waku";
import { clearConsoleBuffer } from "./console";
import { errMessage, withTimeout } from "./errors";
import { createLogger, redactText, setLogSink } from "./logger";
import { closeLogFile } from "./log-file";

const log = createLogger("lifecycle");

/**
 * How to put the terminal back before reporting a fatal error.
 *
 * A full-screen renderer draws into the alternate buffer and diverts the log
 * sink into a pane of its own. Both are gone the moment the process dies, so
 * the last thing written — the reason it died — was the one thing nobody could
 * read. The renderer registers its teardown here; the handlers below run it
 * FIRST, so what follows lands on a terminal that is showing it.
 */
let restoreTerminal: (() => void) | undefined;

export const setTerminalRestore = (restore: (() => void) | undefined): void => {
  restoreTerminal = restore;
};

/**
 * Where a fatal error is written down, since a terminal scrolls and a pane dies.
 *
 * Beside the wallet's own state, which is also cwd-relative — the database, the
 * artifacts and the keychain all resolve from where the wallet was started, so
 * a crash report that did not would be the odd one out.
 */
export const CRASH_LOG = "twallet-crash.log";

/**
 * How large the log may get before the previous generation is rolled off.
 *
 * A file that only ever grows is a file nobody opens. Two generations is
 * enough to keep "it crashed again, differently" readable without becoming
 * something the wallet has to manage.
 */
export const CRASH_LOG_LIMIT_BYTES = 256 * 1024;

/** Roll the log over when it has outgrown its bound. Never throws. */
const rollCrashLog = (target: string): void => {
  try {
    if (fs.statSync(target).size < CRASH_LOG_LIMIT_BYTES) return;
    fs.renameSync(target, `${target}.1`);
  } catch {
    // No file yet, or a filesystem that will not rename. Either way the append
    // below is still the right next step.
  }
};

export const writeCrashReport = (kind: string, err: unknown): string | undefined => {
  try {
    const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
    // Redacted like every other sink. A stack embeds the message it was thrown
    // with, and this one is written to a file that outlives the process — so
    // it is the last place a mnemonic should be allowed to land.
    const stack = redactText(raw);
    const target = path.join(process.cwd(), CRASH_LOG);
    rollCrashLog(target);
    // 0600. This file sits next to the wallet's database and outlives the
    // process, and redaction only catches the shapes it knows — a 64-hex key
    // and a BIP39 phrase. Everything else a stack carries (recipients, the
    // ephemeral executor address, calldata) survives it, so the file must not
    // be readable by anyone but its owner. Without the mode it was created
    // 0644.
    fs.appendFileSync(
      target,
      `\n=== ${new Date().toISOString()} ${kind}\n${stack}\n`,
      { mode: 0o600 },
    );
    // `mode` only applies when the file is created, so a log that already
    // exists from a build that lacked it would keep 0644 forever.
    fs.chmodSync(target, 0o600);
    return target;
  } catch {
    // A crash report that throws would replace the error being reported.
    return undefined;
  }
};

/**
 * Put the screen away, say what happened, and leave a copy on disk.
 *
 * Order matters and is the whole point: restore the terminal, then release the
 * log sink, then write. Reversed — which is what it used to be — every word of
 * this goes into a pane that is already being destroyed.
 */
const reportFatal = (kind: string, err: unknown): void => {
  try {
    restoreTerminal?.();
  } catch {
    // Tearing down the renderer must not replace the error being reported.
  }
  setLogSink(undefined);
  closeLogFile();
  const written = writeCrashReport(kind, err);
  log.error(kind, err);
  if (written) {
    log.error(`written to ${written}`);
  }
};

/** Upper bound on module teardown before we stop waiting and exit anyway. */
export const SHUTDOWN_TIMEOUT_MS = 8000;

export type ShutdownResult = { ok: boolean; error?: string };

/**
 * Run a teardown, bounded. Never throws — the caller is on its way out and has
 * nowhere to report to; it gets a result to fold into the exit code instead.
 *
 * `work` is a parameter so this is testable without stopping a real engine.
 */
export const runBoundedShutdown = async (
  work: () => Promise<unknown>,
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
  label = "module shutdown",
): Promise<ShutdownResult> => {
  try {
    await withTimeout(Promise.resolve().then(work), timeoutMs, label);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
};

const killEngineAndWaku = async (): Promise<void> => {
  await stopWakuClient();
  await stopEngine();
};

/**
 * Shut the modules down and exit. A teardown failure forces a non-zero code
 * even when the caller asked for 0 — the process did not stop cleanly and
 * whatever launched it should know.
 */
export const processSafeExit = async (code = 0): Promise<never> => {
  // Whatever the renderer diverted logs into is about to stop being drawn.
  // Shutdown reporting belongs on the terminal from here on.
  setLogSink(undefined);
  closeLogFile();
  log.info("shutting down modules");
  const result = await runBoundedShutdown(killEngineAndWaku);
  if (!result.ok) {
    log.error("shutdown did not complete cleanly", result.error);
    code = code === 0 ? 1 : code;
  }
  clearConsoleBuffer();
  process.exit(code);
};

/** Destroy all local wallet state. Irreversible. */
export const processDestroyExit = async (): Promise<never> => {
  setLogSink(undefined);
  closeLogFile();
  log.warn("deleting database, artifacts, and keychains");
  const result = await runBoundedShutdown(killEngineAndWaku);
  if (!result.ok) {
    log.error("shutdown before destroy did not complete cleanly", result.error);
  }

  const { databasePath, artifactPath, keyChainPath } = configDefaults.engine;
  for (const target of [databasePath, artifactPath, keyChainPath]) {
    rimrafSync(path.join(process.cwd(), target));
  }

  clearConsoleBuffer();
  log.info("goodbye");
  process.exit(0);
};

// Library noise that is expected, harmless, and used to be silently swallowed.
// Suppressed from the default output but visible under TW_LOG_LEVEL=debug — the
// point is that nothing is discarded without a way to see it.
const KNOWN_NOISE = ["could not coalesce", "already held by process"];

const isKnownNoise = (message: string): boolean =>
  KNOWN_NOISE.some((fragment) => message.includes(fragment));

let installed = false;

/**
 * Install signal and last-resort exception handlers. Idempotent. Call once,
 * from the entry point, before anything that can fail.
 */
export const installProcessHandlers = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      log.debug(`received ${signal}; shutting down`);
      void processSafeExit(0);
    });
  }

  process.on("unhandledRejection", (err: unknown) => {
    const message = errMessage(err);
    if (isKnownNoise(message)) {
      log.debug("suppressed unhandledRejection", message);
      return;
    }
    // Not fatal on its own, so the screen stays: the wallet is still usable
    // and the pane can show this. The copy on disk is for when it is not.
    writeCrashReport("unhandledRejection", err);
    log.error("unhandledRejection", err);
  });

  process.on("uncaughtException", (err: unknown) => {
    const message = errMessage(err);
    if (isKnownNoise(message)) {
      log.debug("suppressed uncaughtException", message);
      return;
    }
    // The process is in an undefined state. Report it and tear down, rather
    // than swallowing it and limping on with corrupt state.
    reportFatal("uncaughtException", err);
    void processSafeExit(1);
  });
};
