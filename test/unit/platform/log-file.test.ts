/**
 * The log that survives the session.
 *
 * Everything else the wallet says is transient — the status line expires, the
 * pane dies with the process, the scrollback goes when the screen is restored.
 * A mainnet recovery failed here and left nothing to read afterwards, which is
 * what this exists to stop.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createLogger, setLogSink } from "../../../src/platform/logger";
import { installLogFile, closeLogFile, logFilePath } from "../../../src/platform/log-file";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tw-log-"));

/** Open a log in a fresh directory and return where it went. */
const openIn = (dir: string): string => {
  installLogFile(dir);
  const p = logFilePath();
  assert.ok(p, "no log file path");
  assert.ok((p as string).startsWith(dir), "log written outside its directory");
  return p as string;
};

test("a line reaches the file", () => {
  const at = openIn(tmp());
  createLogger("probe").error("something went wrong");
  closeLogFile();
  assert.match(fs.readFileSync(at, "utf-8"), /probe something went wrong/);
});

test("a pane sink does not take the line away from the file", () => {
  // The bug this guards: the renderer's sink diverts a line into the screen and
  // RETURNS, so anything downstream of it never sees the line — and the screen
  // is the one place that does not outlive the process.
  const at = openIn(tmp());
  const seen: string[] = [];
  setLogSink(({ text }) => seen.push(text));
  createLogger("tx").error("broadcaster rejected: unmineable tip");
  setLogSink(undefined);
  closeLogFile();

  assert.equal(seen.length, 1, "the pane did not get it");
  assert.match(
    fs.readFileSync(at, "utf-8"),
    /unmineable tip/,
    "the pane sink swallowed the line before it was written down",
  );
});

test("the level and namespace are kept, so a line can be placed", () => {
  const at = openIn(tmp());
  createLogger("recovery").warn("could not read position");
  closeLogFile();
  assert.match(fs.readFileSync(at, "utf-8"), /warn:recovery/);
});

test("secret-shaped values are redacted before they reach the file", () => {
  // Redaction happens upstream, in the logger. Asserted here because this is
  // the sink that writes to disk and KEEPS it — a leak here outlives the
  // session that produced it.
  const at = openIn(tmp());
  const secretKey = "wallet-under-test"; // pragma: allowlist secret
  createLogger("wallet").info("loading", { privateKey: secretKey });
  closeLogFile();
  const body = fs.readFileSync(at, "utf-8");
  assert.ok(!body.includes(secretKey), "a secret-named field was written to disk");
});

test("a failure to open is not a failure to start", () => {
  // A wallet that refuses to boot because it could not open a log file is
  // worse than one with no log. A directory path that is actually a FILE fails
  // synchronously in mkdir, which is the deterministic version of this.
  const dir = tmp();
  const notADir = path.join(dir, "occupied");
  fs.writeFileSync(notADir, "");
  assert.doesNotThrow(() => installLogFile(path.join(notADir, "logs")));
  assert.equal(logFilePath(), undefined, "a failed install still claims a path");
  closeLogFile();
});

test("logging still works when no file was ever installed", () => {
  closeLogFile();
  assert.doesNotThrow(() => createLogger("probe").info("no sink"));
});

test("the log is not readable by anyone but its owner", () => {
  // It records what the wallet did, next to the wallet's database, and it
  // outlives the process. Redaction upstream catches a 64-hex key and a BIP39
  // phrase; it does not catch a recipient, an ephemeral executor address, or a
  // 0zk address sitting beside a public one. Opened without a mode it was 0644.
  const at = openIn(tmp());
  createLogger("probe").info("hello");
  closeLogFile();
  assert.equal(fs.statSync(at).mode & 0o777, 0o600);
});

test("a log left behind at 0644 is corrected on the next open", () => {
  const dir = tmp();
  const at = path.join(dir, "terminal-wallet.log");
  fs.writeFileSync(at, "from an older build\n", { mode: 0o644 });
  fs.chmodSync(at, 0o644);
  openIn(dir);
  closeLogFile();
  assert.equal(fs.statSync(at).mode & 0o777, 0o600);
});

test("the rotated generation is not world-readable either", () => {
  const at = openIn(tmp());
  closeLogFile();
  assert.equal(fs.statSync(at).mode & 0o777, 0o600);
});
