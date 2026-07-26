/**
 * The drain loop that replaced the balance poller.
 *
 * Balances took up to ten seconds to appear because engine events were queued
 * and only drained on a timer. Removing the timer is only safe if work that
 * arrives *while* a drain is running is still collected — otherwise events
 * would sit in the queue until the next one happened to arrive and, on a quiet
 * wallet, indefinitely.
 *
 * That property is the whole reason this is a separate module: asserting it
 * through the balance pipeline would need an engine, and it would be asserted
 * by implication rather than directly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDrainLoop } from "../../../src/platform/drain";

/** A queue the loop takes from, plus a way to push into it. */
const makeQueue = <T>() => {
  let items: T[] = [];
  return {
    push: (item: T) => items.push(item),
    take: () => {
      const batch = items;
      items = [];
      return batch;
    },
    get length() {
      return items.length;
    },
  };
};

test("drains everything queued before it started", async () => {
  const queue = makeQueue<number>();
  const applied: number[][] = [];
  const drain = createDrainLoop(queue.take, async (batch) => {
    applied.push(batch);
  });

  queue.push(1);
  queue.push(2);
  await drain();

  assert.deepEqual(applied, [[1, 2]]);
  assert.equal(queue.length, 0);
});

test("an item that arrives mid-drain is collected without a second call", async () => {
  // The property the poller existed to cover. The loop re-reads the queue after
  // each await, so a late arrival rides the same pass.
  const queue = makeQueue<number>();
  const applied: number[][] = [];
  const drain = createDrainLoop(queue.take, async (batch) => {
    applied.push(batch);
    if (batch.includes(1)) queue.push(2); // lands while this apply is awaiting
  });

  queue.push(1);
  await drain();

  assert.deepEqual(applied, [[1], [2]], "the mid-drain arrival was dropped");
  assert.equal(queue.length, 0);
});

test("a re-entrant call does not start a second pass, and loses nothing", async () => {
  // What scanBalancesCallback does: push, then ask for a drain. If one is
  // already running the call returns immediately — and must still be safe,
  // because the running pass will see the item.
  const queue = makeQueue<number>();
  const applied: number[][] = [];
  let passes = 0;

  const drain = createDrainLoop(queue.take, async (batch) => {
    applied.push(batch);
    if (batch.includes(1)) {
      queue.push(2);
      await drain(); // re-entrant: returns at once, does not recurse
    }
  });

  queue.push(1);
  passes += 1;
  await drain();

  assert.equal(passes, 1);
  assert.deepEqual(applied, [[1], [2]]);
});

test("the queue is cleared before awaiting, so a batch is never applied twice", async () => {
  // Clearing after the await would re-collect the batch still sitting there.
  const queue = makeQueue<number>();
  const applied: number[][] = [];
  const drain = createDrainLoop(queue.take, async (batch) => {
    await new Promise((r) => setImmediate(r));
    applied.push(batch);
  });

  queue.push(1);
  await drain();

  assert.deepEqual(applied, [[1]]);
});

test("an empty queue is a no-op", async () => {
  const queue = makeQueue<number>();
  let calls = 0;
  const drain = createDrainLoop(queue.take, async () => {
    calls += 1;
  });
  await drain();
  assert.equal(calls, 0);
});

test("the in-flight flag is released even when apply throws", async () => {
  // A throw that left the flag set would wedge the loop permanently: every
  // later call returns early and balances stop updating for the session.
  const queue = makeQueue<number>();
  const drain = createDrainLoop(queue.take, async () => {
    throw new Error("apply failed");
  });

  queue.push(1);
  await assert.rejects(drain(), /apply failed/);
  assert.equal(drain.running, false, "the loop is wedged");

  // And it still works afterwards.
  const applied: number[][] = [];
  const recovered = createDrainLoop(queue.take, async (batch) => {
    applied.push(batch);
  });
  queue.push(2);
  await recovered();
  assert.deepEqual(applied, [[2]]);
});
