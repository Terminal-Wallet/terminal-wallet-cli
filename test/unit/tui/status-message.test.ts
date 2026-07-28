/**
 * A status message has to outlive its own arrival.
 *
 * `statusLive` treats a status whose `statusUntil` has passed as stale and the
 * footer renders "ready" instead. `setState` is a shallow merge, so writing
 * only `status` leaves the PREVIOUS message's expiry in place — and once that
 * older window has closed, every later message is discarded before it can be
 * drawn. Every builder and screen outcome was written that way, which is why a
 * failed recovery reported nothing: not a wrong message, an expired one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { getState, setState, setStatusMessage } from "../../../src/tui/store";
import { footerStatus, statusLive } from "../../../src/tui/format/footer";

const footerState = () => {
  const s = getState();
  return {
    status: s.status,
    statusUntil: s.statusUntil,
    scanProgress: s.scanProgress,
    scanLabel: s.scanLabel,
  };
};

test("a bare status write inherits a stale expiry and is dropped", () => {
  // The control. This must keep failing to render, or the guard below is
  // asserting a rule that costs nothing.
  setState({ status: "old", statusUntil: Date.now() - 1 });
  setState({ status: "Failed: not enough gas" });
  assert.equal(
    statusLive(footerState(), Date.now()),
    false,
    "a bare write should still be stale — that is the bug being guarded against",
  );
  assert.equal(footerStatus(footerState(), Date.now()).text, "ready");
});

test("setStatusMessage gives the message its own lifetime", () => {
  setState({ status: "old", statusUntil: Date.now() - 1 });
  setStatusMessage("Failed: not enough gas");
  const now = Date.now();
  assert.equal(statusLive(footerState(), now), true);
  assert.equal(footerStatus(footerState(), now).text, "Failed: not enough gas");
});

test("a message still expires on its own schedule", () => {
  setStatusMessage("transient", 50);
  const later = Date.now() + 5_000;
  assert.equal(statusLive(footerState(), later), false);
});

test("the progress bar outranks the status line", () => {
  // Why a stuck bar hid every outcome: the status was set correctly and simply
  // never got to the screen.
  setStatusMessage("Failed: not enough gas");
  setState({ scanProgress: 100, scanLabel: "Generating 7702 recovery proof" });
  const shown = footerStatus(footerState(), Date.now()).text;
  assert.ok(shown.includes("Generating 7702 recovery proof"));
  assert.ok(!shown.includes("Failed"), "the bar masks the outcome underneath it");
  setState({ scanProgress: -1, scanLabel: "" });
});

test("no screen writes the status bar without an expiry", () => {
  // The adapter owns its own expiry handling (it also drives a render timer);
  // everything else must go through setStatusMessage.
  const TUI = resolve(process.cwd(), "src/tui");
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      if (path.endsWith("adapter.ts") || path.endsWith("store.ts")) continue;
      if (/setState\(\{\s*status:/.test(readFileSync(path, "utf-8"))) {
        offenders.push(path.slice(TUI.length + 1));
      }
    }
  };
  walk(TUI);
  assert.deepEqual(
    offenders,
    [],
    `these write status without an expiry, so the message is dropped: ${offenders.join(", ")}`,
  );
});
