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
    nextShieldMaturity([{ txid: "0x", category: "Shield", direction: "in", amounts: [] } as CoreHistoryItem], NOW),
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
