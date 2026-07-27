/**
 * Shutdown must be bounded and must report failure.
 *
 * `runBoundedShutdown` takes its work as a parameter precisely so this is
 * testable without stopping a real engine or a real libp2p mesh — which is the
 * whole reason a hung teardown used to be able to wedge the exit path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runBoundedShutdown,
  SHUTDOWN_TIMEOUT_MS,
  CRASH_LOG,
  CRASH_LOG_LIMIT_BYTES,
  writeCrashReport,
} from "../../../src/platform/lifecycle";
import { withTimeout, errMessage } from "../../../src/platform/errors";

test("a clean teardown reports ok", async () => {
  const result = await runBoundedShutdown(async () => undefined);
  assert.deepEqual(result, { ok: true });
});

test("a hung teardown is bounded rather than waiting forever", async () => {
  const started = Date.now();
  const result = await runBoundedShutdown(
    () => new Promise(() => undefined), // never settles
    50,
    "test teardown",
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /timed out after 50ms/);
  assert.ok(
    Date.now() - started < 1000,
    "should have given up promptly, not waited on the hung work",
  );
});

test("a throwing teardown reports the failure instead of escaping", async () => {
  const result = await runBoundedShutdown(async () => {
    throw new Error("leveldb lock held");
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "leveldb lock held");
});

test("a synchronous throw is caught too", async () => {
  const result = await runBoundedShutdown(() => {
    throw new Error("sync boom");
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "sync boom");
});

test("the default bound is finite", () => {
  assert.ok(Number.isFinite(SHUTDOWN_TIMEOUT_MS) && SHUTDOWN_TIMEOUT_MS > 0);
});

test("withTimeout clears its timer on success so the process can exit", async () => {
  // An uncleared timer keeps the event loop alive; if this leaked, node:test
  // would hang here rather than finishing.
  const value = await withTimeout(Promise.resolve("done"), 60_000, "work");
  assert.equal(value, "done");
});

test("errMessage handles the shapes that are actually thrown", () => {
  assert.equal(errMessage(new Error("boom")), "boom");
  assert.equal(errMessage("plain string"), "plain string");
  // SDK internals reject with bare objects carrying a message; reaching for
  // `.message` on `unknown` yields "undefined" and reports a failure as nothing.
  assert.equal(errMessage({ message: "from an object" }), "from an object");
  assert.equal(errMessage({ code: -32603 }), '{"code":-32603}');
});

// --- the crash log ------------------------------------------------------

test("the crash log is bounded, so it stays a file someone opens", async () => {
  // It is written from the exception handler, which cannot afford to care
  // whether it worked — so the rollover has to be the thing that never throws,
  // and the bound has to exist at all.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twallet-crash-"));
  const target = path.join(dir, CRASH_LOG);
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    fs.writeFileSync(target, "x".repeat(CRASH_LOG_LIMIT_BYTES + 1));
    writeCrashReport("uncaughtException", new Error("boom"));

    assert.ok(fs.existsSync(`${target}.1`), "the outgrown log was not rolled off");
    const fresh = fs.readFileSync(target, "utf-8");
    assert.match(fresh, /boom/, "the new report did not land");
    assert.ok(fresh.length < CRASH_LOG_LIMIT_BYTES, "the log kept growing");
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret in a stack does not reach the file", async () => {
  // The one path out of the process that does not go through the logger.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twallet-crash-"));
  const cwd = process.cwd();
  const phrase =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  try {
    process.chdir(dir);
    writeCrashReport("uncaughtException", new Error(`failed with ${phrase}`));
    const written = fs.readFileSync(path.join(dir, CRASH_LOG), "utf-8");
    assert.ok(!written.includes(phrase), "a recovery phrase reached the crash log");
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
