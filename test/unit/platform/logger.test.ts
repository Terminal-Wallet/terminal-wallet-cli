/**
 * The logger's job that actually matters: a secret must never reach a sink.
 *
 * These run against the real module with its real sinks, capturing
 * process.stdout/stderr writes — testing the redaction in isolation would prove
 * the regex works, not that the thing writing the line uses it.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../../src/platform/logger";

const MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PRIVATE_KEY =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

let written: string[] = [];
let restore: Array<() => void> = [];

const capture = () => {
  for (const stream of [process.stdout, process.stderr] as const) {
    const original = stream.write.bind(stream);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).write = (chunk: any, ...rest: any[]) => {
      written.push(String(chunk));
      return true;
    };
    restore.push(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (stream as any).write = original;
    });
  }
};

beforeEach(() => {
  written = [];
  restore = [];
  capture();
});

afterEach(() => {
  for (const undo of restore) {
    undo();
  }
});

const output = () => written.join("");

test("a mnemonic never reaches the sink", () => {
  const log = createLogger("test");
  log.error(`recovery phrase: ${MNEMONIC}`);
  assert.ok(!output().includes(MNEMONIC), "mnemonic leaked");
  assert.match(output(), /\[REDACTED\]/);
});

test("a private key never reaches the sink", () => {
  const log = createLogger("test");
  log.error(`key ${PRIVATE_KEY}`);
  assert.ok(!output().includes(PRIVATE_KEY), "private key leaked");
  assert.match(output(), /\[REDACTED\]/);
});

test("secret-named object keys are masked whatever the value looks like", () => {
  const log = createLogger("test");
  log.error({ password: "hunter2", encryptionKey: "abc", chain: "Ethereum" });
  const out = output();
  assert.ok(!out.includes("hunter2"), "password leaked");
  assert.ok(!out.includes("abc"), "encryptionKey leaked");
  assert.ok(out.includes("Ethereum"), "non-secret fields should survive");
});

test("an Error's stack is scrubbed, not just its message", () => {
  const log = createLogger("test");
  // The stack string embeds the message, so redacting only `.message` leaks the
  // secret through `.stack` — which is what gets logged.
  log.error(new Error(`failed for key ${PRIVATE_KEY}`));
  assert.ok(!output().includes(PRIVATE_KEY), "private key leaked via stack");
});

test("secrets nested inside arrays and objects are reached", () => {
  const log = createLogger("test");
  log.error({ wallets: [{ detail: { mnemonic: MNEMONIC } }] });
  assert.ok(!output().includes(MNEMONIC), "nested mnemonic leaked");
});

test("a 24-word mnemonic is caught too", () => {
  const log = createLogger("test");
  const twentyFour = `${MNEMONIC} ${MNEMONIC}`;
  log.error(twentyFour);
  assert.ok(!output().includes(MNEMONIC), "24-word mnemonic leaked");
});

test("ordinary prose is NOT redacted", () => {
  // Regression: the original pattern matched any run of a dozen lowercase
  // words, so RPC error bodies and provider HTML came out full of [REDACTED]
  // and the logs lost the detail they existed to carry.
  const log = createLogger("test");
  const prose =
    "This website is using a security service to protect itself from online " +
    "attacks. The action you just performed triggered the security solution.";
  log.error(prose);
  assert.ok(
    !output().includes("[REDACTED]"),
    `prose was redacted: ${output()}`,
  );
});

test("a realistic RPC error body survives intact", () => {
  const log = createLogger("test");
  const body =
    "server response 403 Forbidden requestUrl https://eth.merkle.io " +
    "responseBody Sorry you have been blocked You are unable to access";
  log.error(body);
  assert.ok(!output().includes("[REDACTED]"), "RPC error body was mangled");
});

test("info goes to stdout and error to stderr", () => {
  const seen: string[] = [];
  for (const undo of restore) {
    undo();
  }
  restore = [];
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = () => (seen.push("stdout"), true);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = () => (seen.push("stderr"), true);
  try {
    const log = createLogger("test");
    log.info("hello");
    log.error("bad");
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = outWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = errWrite;
  }
  // Diagnostics must not corrupt piped stdout.
  assert.deepEqual(seen, ["stdout", "stderr"]);
});
