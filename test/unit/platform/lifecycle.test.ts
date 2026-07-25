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
