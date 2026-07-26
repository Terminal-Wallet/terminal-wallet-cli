/**
 * Relay-adapt flows only ever see 7702-capable broadcasters.
 *
 * The waku client's lookups take a fourth argument, `use7702Only`. Without it
 * they consider every broadcaster, so a type-4 relay-adapt transaction can be
 * handed one that cannot execute it, and the fee-token list can offer a token
 * no 7702 broadcaster accepts — a dead end where the token lists and then
 * finding a broadcaster for it returns nothing.
 *
 * Asserted by reading the source: the argument is optional and same-typed as
 * the one before it, so nothing else catches its absence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requires7702Broadcaster } from "../../../src/flows/caps";
import { RailgunTransaction } from "../../../src/models/transaction-models";

const SRC = resolve(process.cwd(), "src");
const fee = () => readFileSync(join(SRC, "flows/collect/fee.ts"), "utf-8");

/** Arguments of the call starting at `open`, split at depth 0. */
const argsAt = (source: string, open: number): string[] => {
  let depth = 0;
  let start = open + 1;
  const args: string[] = [];
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        args.push(source.slice(start, i));
        return args.map((a) => a.trim()).filter(Boolean);
      }
    } else if (c === "," && depth === 1) {
      args.push(source.slice(start, i));
      start = i + 1;
    }
  }
  return args;
};

test("every broadcaster lookup in the fee collector passes use7702Only", () => {
  const source = fee();
  const names = ["findBestBroadcaster", "findBroadcastersForToken"];
  let found = 0;
  for (const name of names) {
    const needle = `waku.${name}(`;
    let at = source.indexOf(needle);
    while (at !== -1) {
      found += 1;
      const args = argsAt(source, at + needle.length - 1);
      assert.equal(
        args.length,
        4,
        `${name} called with ${args.length} args — use7702Only missing`,
      );
      at = source.indexOf(needle, at + 1);
    }
  }
  assert.ok(found >= 4, `only found ${found} lookups`);
});

test("relay-adapt fee tokens are intersected with what 7702 broadcasters accept", () => {
  const source = fee();
  assert.match(source, /findAllBroadcastersForChain\(chain, true, true\)/);
  assert.match(source, /if \(accepted && !accepted\.has\(/);
});

test("the intersection only applies to relay-adapt flows", () => {
  // A direct private transfer is not 7702 and must keep its full token list.
  assert.match(fee(), /const accepted = relayAdapt\s*\n?\s*\?/);
});

test("the capability predicate agrees with which flows are relay-adapt", () => {
  // requires7702Broadcaster is the model's answer; the collector's `relayAdapt`
  // flag is the builder's. They must not diverge.
  assert.equal(requires7702Broadcaster(RailgunTransaction.Private0XSwap), true);
  assert.equal(requires7702Broadcaster(RailgunTransaction.UnshieldBase), true);
  assert.equal(requires7702Broadcaster(RailgunTransaction.Transfer), false);
  assert.equal(requires7702Broadcaster(RailgunTransaction.Unshield), false);
});
