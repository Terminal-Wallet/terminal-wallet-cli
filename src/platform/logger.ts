/**
 * Structured, namespaced logger with secret redaction.
 *
 * Deliberately dependency-free: it imports nothing (no `colors`, no core, no ui)
 * so it is safe to use from any layer — including `core/*`, which the boundary
 * lint forbids from importing UI — and can never introduce an import cycle.
 *
 * Levels: debug < info < warn < error. The active threshold comes from the
 * environment, resolved once at module load:
 *   - TW_LOG_LEVEL = debug | info | warn | error   (default: info)
 *   - TW_VERBOSE   = 1 | true                       (alias for debug)
 *
 * Sinks: info -> stdout; debug/warn/error -> stderr (so diagnostics never
 * corrupt piped stdout). No file sink (deferred).
 *
 * Redaction: every argument is scrubbed before it is written. Secret-named
 * object keys are masked, and mnemonic/private-key shaped strings are masked,
 * at ALL levels (including debug). Secrets must never reach a sink.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const resolveThreshold = (): LogLevel => {
  const verbose = (process.env.TW_VERBOSE ?? "").toLowerCase();
  if (verbose === "1" || verbose === "true") {
    return "debug";
  }
  const raw = (process.env.TW_LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
};

// Resolved once at load. Boot reads env before this matters; tests that need a
// different level set the env before importing.
const threshold = resolveThreshold();

export const isDebugEnabled = (): boolean =>
  LEVEL_ORDER[threshold] <= LEVEL_ORDER.debug;

const REDACTED = "[REDACTED]";

// Object keys whose values are secrets regardless of shape.
const SECRET_KEYS = new Set([
  "mnemonic",
  "privatekey",
  "private_key",
  "encryptionkey",
  "encryption_key",
  "password",
  "hashedpassword",
  "hashed_password",
  "saltedpassword",
  "seed",
  "secret",
  "ciphertext",
]);

// A 64-hex private key (optionally 0x-prefixed), as a whole token.
const PRIVATE_KEY_RE = /\b(0x)?[0-9a-fA-F]{64}\b/g;

// A BIP39 mnemonic: exactly 12 or 24 words, each 3-8 lowercase letters (the
// whole wordlist fits that), separated by single spaces.
//
// The looser `([a-z]+\s+){11,23}[a-z]+` this replaces matched any dozen
// lowercase words in a row — which is most English prose. In practice it
// redacted chunks of RPC error bodies and provider HTML, destroying the
// diagnostic value of the very logs this module exists to produce. Anchoring on
// BIP39's actual shape keeps real phrases caught and leaves prose alone:
// ordinary sentences contain short words ("a", "is", "to"), punctuation, and
// capitals, any of which break the run.
const MNEMONIC_RE = /\b(?:[a-z]{3,8} ){11}[a-z]{3,8}(?:(?: [a-z]{3,8}){12})?\b/g;

const redactString = (value: string): string =>
  value.replace(PRIVATE_KEY_RE, REDACTED).replace(MNEMONIC_RE, REDACTED);

const redact = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object" || depth > 4) {
    return value;
  }
  if (value instanceof Error) {
    // The stack string embeds the (unredacted) message, so scrub the whole
    // thing — never just the message — or secrets leak via the stack.
    const stack = value.stack ?? `${value.name}: ${value.message}`;
    return redactString(stack);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? REDACTED : redact(v, depth + 1);
  }
  return out;
};

const format = (arg: unknown): string => {
  const scrubbed = redact(arg);
  if (typeof scrubbed === "string") {
    return scrubbed;
  }
  try {
    return JSON.stringify(scrubbed);
  } catch {
    return String(scrubbed);
  }
};

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

const write = (
  level: LogLevel,
  namespace: string,
  args: unknown[],
): void => {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) {
    return;
  }
  const line = `terminal-wallet:${level}:${namespace} ${args
    .map(format)
    .join(" ")}\n`;
  if (level === "info") {
    process.stdout.write(line);
  } else {
    process.stderr.write(line);
  }
};

export const createLogger = (namespace: string): Logger => ({
  debug: (...args) => write("debug", namespace, args),
  info: (...args) => write("info", namespace, args),
  warn: (...args) => write("warn", namespace, args),
  error: (...args) => write("error", namespace, args),
});
