/**
 * How long until shielded funds are spendable.
 *
 * A shield waits an hour in the ShieldPending bucket. The bucket says only
 * *that* funds are pending, which reads as indefinite — the question worth
 * answering is how much longer, and the timestamps for it are in local history.
 *
 * A shield still inside the window is one whose funds are still pending, which
 * is the same statement the bucket is making. The oldest of those matures next.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POI_SHIELD_PENDING_SEC } from "@railgun-community/shared-models";
import {
  formatRemaining,
  nextShieldMaturity,
  pendingNote,
} from "../../../src/tui/format/shield-timer";
import { CoreHistoryItem } from "../../../src/core/history";

const NOW = 1_800_000_000; // unix seconds

const shield = (secondsAgo: number, txid = `0x${secondsAgo}`): CoreHistoryItem =>
  ({
    txid,
    category: "Shield",
    direction: "in",
    timestamp: NOW - secondsAgo,
    amounts: [],
    shielded: true,
  }) as CoreHistoryItem;

const other = (secondsAgo: number): CoreHistoryItem =>
  ({
    txid: `0xsend${secondsAgo}`,
    category: "Send",
    direction: "out",
    timestamp: NOW - secondsAgo,
    amounts: [],
  }) as CoreHistoryItem;

test("the hour comes from the SDK, not a number typed here", () => {
  assert.equal(POI_SHIELD_PENDING_SEC, 3600);
});

test("a recent shield gives the time left on it", () => {
  const countdown = nextShieldMaturity([shield(600)], NOW); // 10 minutes ago
  assert.ok(countdown);
  assert.equal(countdown.remainingSec, 3000); // 50 minutes
  assert.equal(countdown.readyAt, NOW - 600 + 3600);
});

test("the OLDEST pending shield is the one that matures next", () => {
  // Several shields in the window: the one you are waiting on is the earliest,
  // not the most recent.
  const countdown = nextShieldMaturity([shield(120), shield(3000), shield(900)], NOW);
  assert.ok(countdown);
  assert.equal(countdown.remainingSec, 600); // 3600 - 3000
});

test("a shield older than the window is not pending", () => {
  assert.equal(nextShieldMaturity([shield(3601)], NOW), undefined);
});

test("only shields count", () => {
  assert.equal(nextShieldMaturity([other(60)], NOW), undefined);
});

test("no history means no clock, rather than a wrong one", () => {
  // History that has not loaded must not produce a countdown to the epoch.
  assert.equal(nextShieldMaturity([], NOW), undefined);
  assert.equal(
    nextShieldMaturity([{ txid: "0x", category: "Shield", direction: "in", amounts: [], shielded: true } as CoreHistoryItem], NOW),
    undefined,
    "a shield with no timestamp produced a countdown",
  );
});

test("a shield timestamped in the future is ignored", () => {
  // Clock skew between the node and this machine, which would otherwise read
  // as an hour and a half remaining.
  assert.equal(nextShieldMaturity([shield(-120)], NOW), undefined);
});

test("remaining never goes negative", () => {
  const countdown = nextShieldMaturity([shield(3599)], NOW);
  assert.ok(countdown);
  assert.equal(countdown.remainingSec, 1);
});

test("the format is coarse far out and precise near the end", () => {
  assert.equal(formatRemaining(3000), "50m");
  assert.equal(formatRemaining(600), "10m");
  assert.equal(formatRemaining(500), "8m 20s");
  assert.equal(formatRemaining(35), "35s");
  assert.equal(formatRemaining(0), "any moment");
});

test("the note keeps the bare summary when there is no clock", () => {
  assert.equal(pendingNote("0.002 shielding", undefined), "0.002 shielding");
  assert.match(
    pendingNote("0.002 shielding", { readyAt: 0, remainingSec: 900 }),
    /spendable in 15m$/,
  );
});

test("a relay-adapt re-shield still starts the clock", () => {
  // A 7702 bundle that unshields, does something, and re-shields arrives from
  // the SDK as Unknown, so the feed labels it "Swap" or "Activity" — never
  // "Shield". Matching on the label meant the countdown never appeared for the
  // funds the DeFi flows actually produce, which are the ones most likely to
  // be sitting in ShieldPending.
  const now = 1_000_000;
  const found = nextShieldMaturity(
    [
      {
        txid: "0x1", category: "Swap", direction: "neutral",
        timestamp: now - 600, amounts: [], shielded: true,
      } as never,
    ],
    now,
  );
  assert.ok(found, "a re-shield puts funds in ShieldPending and has to be counted");
  assert.equal(found?.readyAt, now - 600 + POI_SHIELD_PENDING_SEC);
});

test("an unshield does not start a shield clock", () => {
  const now = 1_000_000;
  assert.equal(
    nextShieldMaturity(
      [{ txid: "0x1", category: "Unshield", direction: "out", timestamp: now - 60, amounts: [], shielded: false } as never],
      now,
    ),
    undefined,
  );
});

test("the countdown is computed from the current render's history", () => {
  // The deck mirrors `s.history` into a module variable so a click on the
  // activity list can map back to the row it landed on. The countdown was
  // reading that mirror — which is assigned AFTER the portfolio is built, so it
  // held the PREVIOUS render's history. The clock could therefore only appear
  // on the render after the shield reached history, and when nothing else
  // changed there was no such render and it never appeared at all.
  const entry = readFileSync(resolve(process.cwd(), "src/tui/entry.ts"), "utf-8");
  assert.match(
    entry,
    /nextShieldMaturity\(s\.history,/,
    "the countdown must read history from the state being rendered",
  );
  assert.ok(
    !/nextShieldMaturity\(history,/.test(entry),
    "reading the mirrored copy makes the countdown one render stale",
  );
});
