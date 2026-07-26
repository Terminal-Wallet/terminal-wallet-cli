/**
 * What the bottom bar says, and for how long.
 *
 * Two faults, one line. A message was set and never cleared, so the last thing
 * to happen became a permanent label — "Balances synced." sat there for the
 * rest of the session. And `tx:progress` wrote a percentage and a phase into
 * the store that nothing read, so the transaction progress bar simply did not
 * render; the bar existed, the state existed, and no one joined them.
 *
 * Precedence is the design: work in flight beats a message, because it is the
 * thing being waited on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { footerStatus, statusLive, FooterState } from "../../../src/tui/format/footer";

const NOW = 1_000_000;

const state = (patch: Partial<FooterState> = {}): FooterState => ({
  scanProgress: -1,
  scanLabel: "",
  status: "",
  ...patch,
});

test("an idle bar says ready, and is not highlighted", () => {
  const shown = footerStatus(state(), NOW);
  assert.equal(shown.text, "ready");
  assert.equal(shown.active, false);
});

test("a live message is shown", () => {
  const shown = footerStatus(
    state({ status: "Balances synced.", statusUntil: NOW + 1000 }),
    NOW,
  );
  assert.equal(shown.text, "Balances synced.");
  assert.equal(shown.active, true);
});

test("an expired message is not", () => {
  // The reported fault: it never cleared from the bottom.
  const shown = footerStatus(
    state({ status: "Balances synced.", statusUntil: NOW - 1 }),
    NOW,
  );
  assert.equal(shown.text, "ready");
  assert.equal(shown.active, false);
});

test("a message with no expiry stays", () => {
  // Progress-style updates hold the bar until the next one replaces them,
  // rather than flickering away in the gap between updates.
  const shown = footerStatus(state({ status: "POI InProgress 3/9 (33%)" }), NOW);
  assert.equal(shown.text, "POI InProgress 3/9 (33%)");
});

test("work in flight shows a bar and its label", () => {
  // The part that never rendered at all.
  const shown = footerStatus(
    state({ scanProgress: 40, scanLabel: "Generating proof…" }),
    NOW,
  );
  assert.match(shown.text, /█/, "no progress bar");
  assert.match(shown.text, /Generating proof…$/);
  assert.equal(shown.active, true);
});

test("work in flight outranks a live message", () => {
  // A message from a minute ago on top of a running proof is worse than
  // useless — it is the thing the user is not waiting on.
  const shown = footerStatus(
    state({
      scanProgress: 10,
      scanLabel: "Submitting transaction…",
      status: "Balances synced.",
      statusUntil: NOW + 60_000,
    }),
    NOW,
  );
  assert.match(shown.text, /Submitting transaction…$/);
  assert.doesNotMatch(shown.text, /Balances synced/);
});

test("zero percent is still work in flight", () => {
  // -1 is idle; 0 is "started". An `>= 0` check is the difference between a
  // proof announcing itself and a bar that only appears once it is underway.
  assert.match(footerStatus(state({ scanProgress: 0 }), NOW).text, /█|░/);
});

test("work with no label still says something", () => {
  const shown = footerStatus(state({ scanProgress: 50 }), NOW);
  assert.match(shown.text, /Working$/);
});

test("statusLive is what decides, not the presence of text", () => {
  assert.equal(statusLive(state({ status: "" }), NOW), false);
  assert.equal(statusLive(state({ status: "x" }), NOW), true);
  assert.equal(statusLive(state({ status: "x", statusUntil: NOW }), NOW), false);
  assert.equal(statusLive(state({ status: "x", statusUntil: NOW + 1 }), NOW), true);
});
