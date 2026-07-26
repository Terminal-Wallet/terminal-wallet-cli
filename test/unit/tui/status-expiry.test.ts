/**
 * The adapter side of the status bar: messages that expire.
 *
 * `status:message` carries a `durationMs`, and the adapter dropped it — every
 * message was written to the store with no lifetime, so the bar kept the last
 * thing said forever. The renderer decides what is stale, which means the
 * adapter's job is to record WHEN it goes stale.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { emitCoreEvent } from "../../../src/core/events";
import { attachCoreAdapter } from "../../../src/tui/adapter";
import { getState, setState } from "../../../src/tui/store";
import { statusLive } from "../../../src/tui/format/footer";
import blessed from "blessed";
import { createBlessedInputProvider } from "../../../src/tui/input-provider";

attachCoreAdapter();

// notify() only emits now, so the provider needs no real screen to exercise it.
const notifier = createBlessedInputProvider(blessed, {
  render: () => undefined,
} as never);

beforeEach(() => {
  setState({ status: "", statusUntil: undefined, scanProgress: -1, scanLabel: "" });
});

test("a message is stamped with when it stops being current", () => {
  const before = Date.now();
  emitCoreEvent({ type: "status:message", text: "Scan kicked" });
  const { status, statusUntil } = getState();
  assert.equal(status, "Scan kicked");
  assert.ok(statusUntil !== undefined, "no expiry recorded, so it never clears");
  assert.ok(statusUntil > before, "expiry is already in the past");
});

test("an explicit duration is honoured", () => {
  emitCoreEvent({ type: "status:message", text: "long one", durationMs: 60_000 });
  const { statusUntil } = getState();
  assert.ok(statusUntil !== undefined);
  assert.ok(
    statusUntil - Date.now() > 30_000,
    "the caller's durationMs was ignored",
  );
});

test("the expiry is what the renderer reads", () => {
  emitCoreEvent({ type: "status:message", text: "brief", durationMs: 1 });
  const s = getState();
  assert.equal(statusLive(s, Date.now() + 5), false, "still shown after expiry");
  assert.equal(statusLive(s, Date.now() - 5), true, "not shown while current");
});

test("POI progress holds the bar instead of expiring", () => {
  // It updates continuously; an expiry would blank it between updates.
  emitCoreEvent({
    type: "poi:progress",
    status: "InProgress",
    index: 3,
    total: 9,
    progress: 33,
  });
  const s = getState();
  assert.match(s.status, /POI InProgress 3\/9/);
  assert.equal(s.statusUntil, undefined, "progress should not time out");
  assert.equal(statusLive(s, Date.now() + 3_600_000), true);
});

test("a transaction result ends the progress bar", () => {
  // Otherwise the bar sits at whatever percentage it reached when it finished.
  emitCoreEvent({ type: "tx:progress", phase: "prove", pct: 40 });
  assert.equal(getState().scanProgress, 40);
  emitCoreEvent({ type: "tx:result", ok: true, hash: "0xdeadbeef" });
  assert.equal(getState().scanProgress, -1, "the bar was left in flight");
  assert.equal(getState().scanLabel, "");
});

test("a message reaches the log as well as the bar", () => {
  setState({ logs: [] });
  emitCoreEvent({ type: "status:message", text: "something worth keeping" });
  assert.ok(
    getState().logs.some((l) => l.includes("something worth keeping")),
    "the status was displayed but not recorded",
  );
});

test("a notification is visible even after an earlier message expired", () => {
  // The regression this guards: notify() wrote `status` straight to the store
  // and left whatever `statusUntil` the previous message had set. Once that
  // passed, every later notification was discarded as stale before it was
  // drawn — which is how "Nothing stranded at this ephemeral" turned into the
  // console appearing to do nothing at all.
  emitCoreEvent({ type: "status:message", text: "Scanning…", durationMs: 1 });
  const afterExpiry = Date.now() + 5_000;

  notifier.notify("Nothing stranded at this ephemeral.");

  const s = getState();
  assert.equal(s.status, "Nothing stranded at this ephemeral.");
  assert.equal(
    statusLive(s, afterExpiry),
    true,
    "the notification was treated as stale on arrival",
  );
});

test("a notification is recorded, not just shown", () => {
  setState({ logs: [] });
  notifier.notify("something the user should be able to re-read");
  assert.ok(
    getState().logs.some((l) => l.includes("re-read")),
    "notifications do not reach the log",
  );
});
