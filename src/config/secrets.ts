/**
 * Operator secrets — read from disk at runtime, never compiled in.
 *
 * Deliberately a SEPARATE file from twallet.config.json. That one holds RPC
 * endpoints and is the file an operator pastes when asking for help with a
 * connection problem; a signing key must not travel with it.
 *
 * Shape of twallet.secrets.json (all optional), at the run directory:
 * {
 *   "remoteConfigSignerKey": "0x…"
 * }
 *
 * NOTHING IN THIS FILE IS BUNDLED. ship.mjs runs esbuild with `bundle: true`
 * over dist/main.js, so every module reachable by import is inlined into the
 * shipped binary. A key written into a .ts file under src/ would therefore be
 * distributed to every user. It is read from disk, or from the environment, and
 * both are resolved at run time.
 *
 * The environment wins over the file, so CI and one-off runs never need the key
 * on disk at all.
 */
import fs from "fs";
import path from "path";
import { createLogger } from "../platform/logger";

const log = createLogger("secrets");

export interface AppSecrets {
  /** Private key authorized to publish the on-chain remote-config artifact. */
  remoteConfigSignerKey?: string;
}

/**
 * Resolved per call, not once at import.
 *
 * A module-level constant freezes the path to whatever the working directory
 * was when the module first loaded, which is not necessarily the directory the
 * wallet is being run from by the time a secret is wanted.
 */
const secretsPath = (): string =>
  path.join(process.cwd(), "twallet.secrets.json");

const ENV_KEYS: Record<keyof AppSecrets, string> = {
  remoteConfigSignerKey: "TWALLET_REMOTE_CONFIG_SIGNER_KEY",
};

let cache: AppSecrets | undefined;

/**
 * Refuse a key file other accounts can read.
 *
 * A private key at 0644 is readable by every process on the box, which defeats
 * the point of keeping it out of the repo. Warn rather than throw: the operator
 * may be on a single-user machine and blocking boot over a mode bit is its own
 * failure. On Windows the mode is not meaningful, so this is skipped.
 */
const warnOnLoosePermissions = (file: string): void => {
  if (process.platform === "win32") return;
  try {
    const { mode } = fs.statSync(file);
    // eslint-disable-next-line no-bitwise
    if ((mode & 0o077) !== 0) {
      log.warn(
        `${path.basename(file)} is readable by other accounts ` +
          `(mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
      );
    }
  } catch {
    /* unreadable stat is not itself a reason to fail */
  }
};

const loadSecretsFile = (): AppSecrets => {
  if (cache) return cache;
  const file = secretsPath();
  try {
    const raw = fs.readFileSync(file, "utf-8");
    warnOnLoosePermissions(file);
    cache = JSON.parse(raw) as AppSecrets;
  } catch {
    // Absent or malformed is the normal case: almost nobody running this wallet
    // is publishing a remote config.
    cache = {};
  }
  return cache;
};

/**
 * Resolve one secret. Environment first, then the file.
 *
 * Returns undefined rather than throwing, so a caller decides whether the
 * capability is simply unavailable or the run cannot continue.
 */
const secret = (field: keyof AppSecrets): string | undefined => {
  const fromEnv = process.env[ENV_KEYS[field]]?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = loadSecretsFile()[field]?.trim();
  return fromFile ? fromFile : undefined;
};

/** The remote-config publishing key, if this operator has one. */
export const remoteConfigSignerKey = (): string | undefined =>
  secret("remoteConfigSignerKey");

/** Whether a remote-config publishing key is configured at all. */
export const hasRemoteConfigSignerKey = (): boolean =>
  remoteConfigSignerKey() !== undefined;

/**
 * Safe to print. Enough to confirm WHICH key is loaded without disclosing it —
 * a diagnostic that echoed the key would put it in the log file the user then
 * sends to someone.
 */
export const describeSecrets = (): string => {
  const configured = hasRemoteConfigSignerKey();
  if (!configured) return "remote-config signer: not configured";
  const source = process.env[ENV_KEYS.remoteConfigSignerKey]?.trim()
    ? "env"
    : "twallet.secrets.json";
  return `remote-config signer: configured (${source})`;
};

/** Test seam — drops the memoized file so a rewritten file is picked up. */
export const resetSecretsCache = (): void => {
  cache = undefined;
};
