/**
 * Overlapping refreshes must not let a stale read win.
 *
 * The engine emits one balance event per bucket, so `balances:refreshed`
 * arrives in a burst. Each refresh does several awaits — private balances,
 * public balances, prices — before it emits, so a burst of them finishes out of
 * order and the LAST TO FINISH wins, which is not the last to start. A read
 * that began against a half-filled cache could land after one that saw
 * everything, leaving the rail on the older picture until something else
 * happened to trigger a refresh. That is what "doesn't fully load until you
 * refresh by hand" was.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The shape under test, kept here rather than exported from feeders.ts — the
 * factory reaches the engine, the network and the price API on construction,
 * so it cannot be built in a unit test. This is the same eight lines.
 */
const coalesce = (work: () => Promise<void>): (() => Promise<void>) => {
  let running = false;
  let again = false;
  return async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await work();
      } while (again);
    } finally {
      running = false;
    }
  };
};

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("never runs two at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const run = coalesce(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(5);
    inFlight--;
  });
  await Promise.all([run(), run(), run(), run()]);
  assert.equal(peak, 1, `two reads overlapped (peak ${peak})`);
});

test("a request arriving mid-run still gets a run after it", async () => {
  // The control for the whole fix: dropping the concurrent request instead of
  // queueing it is precisely the bug, because the dropped one is the one that
  // would have seen the fully-populated cache.
  const seen: number[] = [];
  let cacheVersion = 0;
  // Captured at the START, which is the point: a read that begins against a
  // half-filled cache carries that snapshot all the way to its emit.
  const run = coalesce(async () => {
    const startedWith = cacheVersion;
    await tick(5);
    seen.push(startedWith);
  });

  const first = run();
  // The engine finishes filling the cache while the first read is in flight.
  cacheVersion = 1;
  const second = run();
  await Promise.all([first, second]);

  assert.deepEqual(seen, [0, 1]);
  assert.equal(
    seen.at(-1),
    1,
    "the final read must reflect the latest cache, not whichever finished last",
  );
});

test("a burst collapses to one trailing run, not one per request", async () => {
  let runs = 0;
  const run = coalesce(async () => {
    runs++;
    await tick(5);
  });
  await Promise.all([run(), run(), run(), run(), run()]);
  assert.equal(runs, 2, "one in flight plus exactly one trailing catch-up");
});

test("a throwing run does not wedge the loop", async () => {
  let calls = 0;
  const run = coalesce(async () => {
    calls++;
    throw new Error("read failed");
  });
  await assert.rejects(run(), /read failed/);
  // Without the finally, `running` would stay true and every later refresh
  // would be silently dropped for the rest of the session.
  await assert.rejects(run(), /read failed/);
  assert.equal(calls, 2);
});
