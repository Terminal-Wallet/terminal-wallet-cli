import { test } from "node:test";
import assert from "node:assert/strict";
import { onCoreEvent, emitCoreEvent } from "../../../src/core/events";

test("emit delivers to subscribers; unsubscribe stops delivery", () => {
  const got: string[] = [];
  const off = onCoreEvent((e) => got.push(e.type));
  emitCoreEvent({ type: "status:message", text: "hi" });
  off();
  emitCoreEvent({ type: "status:message", text: "bye" });
  assert.deepEqual(got, ["status:message"]);
});

test("a throwing handler never breaks emit for others", () => {
  // A faulty renderer must not be able to take core logic down with it.
  const off1 = onCoreEvent(() => {
    throw new Error("boom");
  });
  let reached = false;
  const off2 = onCoreEvent(() => {
    reached = true;
  });
  emitCoreEvent({ type: "broadcaster:status", connected: true });
  off1();
  off2();
  assert.equal(reached, true);
});

test("emitting with no subscribers is safe", () => {
  // Core emits during boot, long before any renderer attaches.
  assert.doesNotThrow(() =>
    emitCoreEvent({ type: "scan:complete", tree: "utxo" }),
  );
});

test("every subscriber sees the event, not just the first", () => {
  const seen: number[] = [];
  const offs = [1, 2, 3].map((n) => onCoreEvent(() => seen.push(n)));
  emitCoreEvent({ type: "status:message", text: "fan-out" });
  offs.forEach((off) => off());
  assert.deepEqual(seen, [1, 2, 3]);
});

test("unsubscribing twice is harmless", () => {
  const off = onCoreEvent(() => undefined);
  off();
  assert.doesNotThrow(() => off());
});
