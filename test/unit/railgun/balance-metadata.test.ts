/**
 * A token whose symbol cannot be read is still a token you hold.
 *
 * `getTokenInfo` makes three sequential contract calls on a miss and throws if
 * any of them fails. The balance-cache write caught that and did `continue`,
 * so the balance was never written at all — the holding vanished from the
 * portfolio rather than appearing unnamed. Because `getTokenInfo` caches into a
 * PERSISTED database, whichever tokens happened to resolve on one pass were
 * instant on the next, so a later refresh filled the rail in and the whole
 * thing read as flakiness rather than as dropped data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const cache = readFileSync(join(SRC, "railgun/balance/balance-cache.ts"), "utf-8");
const util = readFileSync(join(SRC, "railgun/balance/balance-util.ts"), "utf-8");

test("a failed metadata read no longer drops the balance", () => {
  // The exact shape of the bug: catch to undefined, then `continue`.
  assert.ok(
    !/if \(!info\) \{\s*continue;/.test(cache),
    "a token whose metadata failed is being skipped, which hides the holding",
  );
  assert.match(cache, /unresolved: true/);
});

test("metadata is resolved once per distinct token, not once per bucket", () => {
  // Seven buckets across two txid versions is the same handful of tokens
  // looked at fourteen times.
  assert.match(cache, /new Set\(erc20Amounts\.map\(\(a\) => a\.tokenAddress\)\)/);
  assert.match(cache, /mapLimited\(distinct, TOKEN_INFO_CONCURRENCY/);
});

test("the fixed per-token sleep is gone", () => {
  // It ran BEFORE the result was checked, so it slept just as long when the
  // metadata came from the local database and no call was made — roughly half
  // a minute of pure waiting before balances:refreshed was emitted, which is
  // the only thing that makes the deck re-read.
  assert.ok(
    !/await delay\(500\)/.test(cache),
    "the unconditional per-token sleep is still there",
  );
});

test("reading balances for display never throws on one bad token", () => {
  // It called getTokenInfo bare, so a single unreadable token took down the
  // whole read — and the caller's catch turned that into an empty portfolio
  // rather than one missing row.
  const at = util.indexOf("export const getPrivateBalancesByBucketForChain");
  assert.ok(at > 0);
  const body = util.slice(at, at + 1600);
  assert.ok(
    !/await getTokenInfo\([^)]*\);/.test(body.replace(/\.catch\([^)]*\)/g, "")),
    "an uncaught getTokenInfo remains in the display read",
  );
  assert.match(body, /unresolved: true/);
});

test("an unresolved token is not offered to the send flows", () => {
  // Spend-affecting: an amount typed against guessed decimals is wrong by
  // whatever the guess was wrong by. Visible on the rail, absent from the
  // picker.
  const at = util.indexOf("export const getAllPrivateERC20BalancesForChain");
  assert.ok(at > 0);
  const body = util.slice(at, at + 1600);
  assert.match(body, /if \(cache\[tokenAddress\]\.unresolved\) continue;/);
});

test("neither balance reader returns before it has read anything", () => {
  // Both were built inside `.map(async …)` with nothing awaiting the array it
  // produced, so `return balances` handed back an EMPTY list that filled some
  // microtasks later. Whether a caller saw a token came down to how many ticks
  // had passed before it looked — which is why a funded wallet could report no
  // spendable tokens, and why the fee gate could not find the fee token and
  // passed a transaction it should have refused.
  for (const reader of [
    "getPublicERC20BalancesForChain",
    "getPrivateERC20BalancesForChain",
  ]) {
    const at = util.indexOf(`export const ${reader}`);
    assert.ok(at > 0, `${reader} is gone`);
    const body = util.slice(at, at + 2000);
    assert.ok(
      !/\.map\(async \(tokenAddress\)/.test(body),
      `${reader} still builds its result in a fire-and-forget map`,
    );
    assert.match(
      body,
      /for \(const tokenAddress of/,
      `${reader} does not read its tokens in an awaited loop`,
    );
  }
});

test("the spendable reader is async, so a caller cannot read it too early", () => {
  const at = util.indexOf("export const getPrivateERC20BalancesForChain");
  const body = util.slice(at, at + 400);
  assert.match(body, /= async \(/, "the spendable reader is still synchronous");
  assert.match(body, /Promise<RailgunDisplayBalance\[\]>/);
});

test("the spendable reader drops unresolved tokens like its siblings", () => {
  const at = util.indexOf("export const getPrivateERC20BalancesForChain");
  const body = util.slice(at, at + 2000);
  assert.match(body, /if \(entry\.unresolved\) continue;/);
});

test("an unresolved balance is not formatted, and not counted", () => {
  const feeders = readFileSync(join(SRC, "tui/feeders.ts"), "utf-8");
  // Formatting under placeholder decimals turns a 6-decimal token into a
  // number a trillion times too large. A wrong figure is worse than none.
  assert.match(feeders, /unreadable — retrying/);
  assert.match(feeders, /priv\.filter\(\(b\) => !b\.unresolved\)/);
});
