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
import path from "path";
import { rimrafSync } from "rimraf";
import configDefaults from "../config/config-defaults";
import { stopEngine } from "../railgun/engine/engine";
import { stopWakuClient } from "../railgun/waku/connect-waku";
import { clearConsoleBuffer } from "./console";
import { errMessage, withTimeout } from "./errors";
import { createLogger, setLogSink } from "./logger";

const log = createLogger("lifecycle");

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
    log.error("uncaughtException", err);
    void processSafeExit(1);
  });
};
