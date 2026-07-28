/**
 * The deck context exists so screens can be driven without a deck.
 *
 * Every screen used to be a closure inside one 1,900-line file, calling that
 * file's internals directly. Nothing could be moved out and nothing could be
 * opened in a test. These assert the property that changed: a screen takes a
 * handle, and a fake handle is enough.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeckContext } from "../../../src/tui/context";
import { refreshAfterSwitch } from "../../../src/tui/screens/addresses";

const fakeContext = () => {
  const calls: string[] = [];
  const ctx: DeckContext = {
    // No screen is touched by the refresh path; a cast keeps the fake honest
    // about that rather than stubbing a widget tree nobody uses.
    screen: undefined as unknown as DeckContext["screen"],
    render: () => calls.push("render"),
    openFlow: (flowId: string) => calls.push(`flow:${flowId}`),
    refreshIdentity: () => calls.push("identity"),
    refreshBalances: async () => {
      calls.push("balances");
    },
    refreshChainStats: async () => {
      calls.push("chainStats");
    },
    refreshHistory: async () => {
      calls.push("history");
    },
  };
  return { ctx, calls };
};

test("a switch refreshes identity, balances and chain stats, then redraws", async () => {
  const { ctx, calls } = fakeContext();
  await refreshAfterSwitch(ctx);
  // History is requested but deliberately not awaited, so it is excluded from
  // the ordering assertion — including it would be asserting a race.
  assert.deepEqual(
    calls.filter((c) => c !== "history"),
    ["identity", "balances", "chainStats", "render"],
  );
});

test("history is requested, but not waited on", async () => {
  // It is the slowest of the four and the least urgent: a slow or failing
  // history load must not hold up the balances the user just switched to see.
  const { ctx, calls } = fakeContext();
  await refreshAfterSwitch(ctx);
  assert.ok(calls.includes("history"), "history was never requested");
});

test("the redraw happens last", async () => {
  // Rendering before the feeders have run would paint the previous wallet's
  // balances and then leave them there until something else caused a redraw.
  const { ctx, calls } = fakeContext();
  await refreshAfterSwitch(ctx);
  const awaited = calls.filter((c) => c !== "history");
  assert.equal(awaited.at(-1), "render");
});

test("identity is refreshed before balances", async () => {
  // Balances are keyed by the active wallet and chain, so announcing the new
  // identity first is what makes the balances that follow belong to it.
  const { ctx, calls } = fakeContext();
  await refreshAfterSwitch(ctx);
  assert.ok(calls.indexOf("identity") < calls.indexOf("balances"));
});

test("a slow feeder is awaited, not fired and forgotten", async () => {
  const order: string[] = [];
  const ctx: DeckContext = {
    screen: undefined as unknown as DeckContext["screen"],
    render: () => order.push("render"),
    openFlow: (flowId: string) => order.push(`flow:${flowId}`),
    refreshIdentity: () => order.push("identity"),
    refreshBalances: () =>
      new Promise((resolve) =>
        setTimeout(() => {
          order.push("balances");
          resolve();
        }, 10),
      ),
    refreshChainStats: async () => {
      order.push("chainStats");
    },
    refreshHistory: async () => {
      order.push("history");
    },
  };
  await refreshAfterSwitch(ctx);
  assert.deepEqual(
    order.filter((c) => c !== "history"),
    ["identity", "balances", "chainStats", "render"],
  );
});
