/**
 * The bounded fan-out behind every asset scan.
 *
 * Two properties matter and both are load-bearing. The ceiling is what keeps a
 * scan from getting itself rate-limited — and a throttled read is reported as
 * a failure, which is how "the node would not answer" turns into "this account
 * is empty". Input ordering is what keeps each result paired with the item it
 * was read for; a pool returning results as they finish would report one
 * token's balance under another's symbol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimited } from "../../../src/util/concurrency";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("results come back in input order, not completion order", async () => {
  // Deliberately inverted: the last item finishes first.
  const out = await mapLimited([30, 20, 10], 3, async (ms) => {
    await tick(ms);
    return ms;
  });
  assert.deepEqual(out, [30, 20, 10]);
});

test("never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapLimited(Array.from({ length: 25 }, (_, i) => i), 4, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(1);
    inFlight--;
  });
  assert.equal(peak, 4, `peak concurrency was ${peak}, limit was 4`);
});

test("the limit is a real bound — a serial run would not reach it", async () => {
  // The control: if mapLimited silently degraded to a sequential loop the
  // test above would still pass with peak 1, so assert the pool is actually
  // parallel by requiring it to reach the ceiling.
  let peak = 0;
  let inFlight = 0;
  await mapLimited(Array.from({ length: 12 }, (_, i) => i), 6, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await tick(2);
    inFlight--;
  });
  assert.equal(peak, 6, "the pool ran fewer at once than the limit allows");
});

test("every item is visited exactly once", async () => {
  const seen: number[] = [];
  const items = Array.from({ length: 17 }, (_, i) => i);
  await mapLimited(items, 5, async (i) => {
    await tick(1);
    seen.push(i);
  });
  assert.deepEqual([...seen].sort((a, b) => a - b), items);
});

test("a limit above the item count does not spawn idle workers or hang", async () => {
  const out = await mapLimited([1, 2], 50, async (n) => n * 2);
  assert.deepEqual(out, [2, 4]);
});

test("an empty list resolves without running anything", async () => {
  let calls = 0;
  const out = await mapLimited([], 4, async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("a rejection propagates rather than resolving with a hole", async () => {
  await assert.rejects(
    mapLimited([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("read failed");
      return n;
    }),
    /read failed/,
  );
});

test("the index is passed through", async () => {
  const out = await mapLimited(["a", "b", "c"], 2, async (item, i) => `${i}${item}`);
  assert.deepEqual(out, ["0a", "1b", "2c"]);
});
