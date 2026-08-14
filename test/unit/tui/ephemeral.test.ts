/**
 * The 7702 ephemeral console's guards.
 *
 * A 7702 authorization is signed against nonce 0. Pointing the wallet back at
 * an index whose account has already transacted therefore produces an
 * authorization the network rejects, and anything routed through it can strand.
 * `advance` and `set` are the two verbs that can get there by hand, so what
 * they refuse and what they warn about is asserted here rather than left to a
 * modal's wording.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnits } from "ethers";
import {
  parseIndex,
  rewindsIndex,
  rewindWarning,
  advanceWarning,
  balanceLines,
  historyLines,
} from "../../../src/tui/format/ephemeral";
import { EphemeralAssetScan } from "../../../src/railgun/wallet/ephemeral-recovery";

const scan = (over: Partial<EphemeralAssetScan> = {}): EphemeralAssetScan =>
  ({
    address: "0xabc",
    nativeWei: 0n,
    erc20s: [],
    nfts: [],
    method: "logs",
    ...over,
  }) as EphemeralAssetScan;

const strip = (s: string) => s.replace(/\{[^}]*\}/g, "");

// --- index parsing ---------------------------------------------------------

test("a plain index is accepted", () => {
  assert.deepEqual(parseIndex("4"), { ok: true, index: 4 });
});

test("zero is a valid index", () => {
  // The first ephemeral. Rejecting it as falsy would make index 0 unreachable.
  assert.deepEqual(parseIndex("0"), { ok: true, index: 0 });
});

test("a negative index is refused", () => {
  const result = parseIndex("-1");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /non-negative/);
});

test("a non-numeric index is refused rather than coerced", () => {
  const result = parseIndex("seven");
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /non-negative/);
});

test("an empty or cancelled entry is a cancel, not an error", () => {
  // The console distinguishes these: a cancel says nothing, a bad value warns.
  assert.deepEqual(parseIndex(undefined), { ok: false, message: "Cancelled." });
  assert.deepEqual(parseIndex("   "), { ok: false, message: "Cancelled." });
});

test("a fractional index truncates toward zero", () => {
  assert.deepEqual(parseIndex("3.9"), { ok: true, index: 3 });
});

// --- the rewind guard ------------------------------------------------------

test("only a rewind needs confirmation", () => {
  assert.equal(rewindsIndex(5, 4), true);
  assert.equal(rewindsIndex(5, 5), false, "staying put is not a rewind");
  assert.equal(rewindsIndex(5, 9), false, "jumping forward lands on a fresh account");
});

test("the rewind warning names the current index and the consequence", () => {
  // This wording is the guard. It has to say what goes wrong, not just ask.
  const warning = rewindWarning(7);
  assert.match(warning, /below the current \(7\)/);
  assert.match(warning, /already-spent ephemeral/);
  assert.match(warning, /nonce-0 7702 authorization invalid/);
  assert.match(warning, /strand funds/);
});

test("the advance warning names the address being skipped", () => {
  const warning = advanceWarning(3, "0xdead");
  assert.match(warning, /past 3\?/);
  assert.match(warning, /0xdead/);
  assert.match(warning, /skipped for future ops/);
});

// --- read-only rendering ---------------------------------------------------

test("an empty ephemeral says so rather than showing a bare zero", () => {
  const lines = balanceLines(2, "0xabc", scan()).map(strip);
  assert.ok(lines.some((l) => l.includes("nothing stranded at this ephemeral")));
});

test("a curated-list scan admits it may have missed tokens", () => {
  // An empty result from this scan is not proof the account is empty, and the
  // user is about to decide whether to bother recovering.
  const lines = balanceLines(2, "0xabc", scan({ method: "tokenlist" })).map(strip);
  assert.ok(lines.some((l) => l.includes("arbitrary tokens may be missed")));
});

test("a log scan makes no such claim", () => {
  const lines = balanceLines(2, "0xabc", scan({ method: "logs" })).map(strip);
  assert.ok(!lines.some((l) => l.includes("arbitrary tokens may be missed")));
});

test("balances list the native asset and every token found", () => {
  const lines = balanceLines(
    1,
    "0xabc",
    scan({
      nativeWei: parseUnits("1.5", 18),
      erc20s: [
        {
          tokenAddress: "0xusdc",
          symbol: "USDC",
          decimals: 6,
          balance: parseUnits("200", 6),
        },
      ],
    }),
  ).map(strip);
  assert.ok(lines.some((l) => l.includes("ETH") && l.includes("1.5")));
  assert.ok(lines.some((l) => l.includes("USDC") && l.includes("200")));
});

test("balances list a stranded position", () => {
  const lines = balanceLines(
    1,
    "0xabc",
    scan({
      nfts: [
        {
          nftAddress: "0xc6de",
          tokenSubID: "0x1092",
          label: "f(x) position #4242",
        },
      ],
    }),
  ).map(strip);
  assert.ok(lines.some((l) => l.includes("f(x) position #4242")));
});

test("an account holding only a position is not reported as empty", () => {
  // The state a failed f(x) mint actually leaves: the position minted, the
  // re-shield reverted, so the NFT is the only thing there. Saying "nothing
  // stranded" here tells the user to walk away from a live position.
  const lines = balanceLines(
    1,
    "0xabc",
    scan({
      nfts: [
        {
          nftAddress: "0xc6de",
          tokenSubID: "0x1092",
          label: "f(x) position #4242",
        },
      ],
    }),
  ).map(strip);
  assert.ok(
    !lines.some((l) => l.includes("nothing stranded at this ephemeral")),
    "a held position must not read as an empty account",
  );
});

test("balance reads the node refused are not reported as an empty account", () => {
  // The scanner maps a failed read to "no balance found". If the screen then
  // prints an unqualified "nothing stranded", a throttled RPC gives a stranded
  // account a clean bill of health and the user walks away from it.
  const lines = balanceLines(2, "0xabc", scan({ unreadable: 3 })).map(strip);
  assert.ok(
    lines.some((l) => /3 .*could not be read|could not read 3/i.test(l)),
    "the count of unreadable balances must be stated",
  );
});

test("a fully readable scan makes no such caveat", () => {
  const lines = balanceLines(2, "0xabc", scan({ unreadable: 0 })).map(strip);
  assert.ok(!lines.some((l) => /could not be read/i.test(l)));
});

test("history marks the current index and distinguishes how each was used", () => {
  const lines = historyLines(2, 3, [
    { index: 1, address: "0x1", usedForUnshield: true },
    { index: 2, address: "0x2", usedForUnshield: false },
  ]).map(strip);
  assert.ok(lines.some((l) => l.includes("3 earlier ephemeral(s) omitted")));
  assert.ok(lines.some((l) => l.includes("0x1") && l.includes("unshield/swap")));
  const current = lines.find((l) => l.includes("0x2"));
  assert.ok(current?.includes("current"), "the wallet's current index is marked");
});
