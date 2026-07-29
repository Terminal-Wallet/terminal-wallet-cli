/**
 * Acting as a chosen ephemeral account.
 *
 * The override replaces the signer the SDK derives from, process-wide. Two of
 * them running at once would build each other's transactions, and one left
 * installed would sign every later batch as the wrong account — so the
 * guarantees worth testing are all about serialisation and clearing, not the
 * happy path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { overriddenEphemeralIndex } from "../../../src/railgun/wallet/ephemeral-override";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");
const override = read("railgun/wallet/ephemeral-override.ts");
const util = read("railgun/wallet/ephemeral-util.ts");
const recovery = read("railgun/wallet/ephemeral-recovery.ts");

test("nothing is overridden until something overrides it", () => {
  assert.equal(overriddenEphemeralIndex(), undefined);
});

test("the index and the address come from the same place", () => {
  // They used to be read separately: the index from the persisted counter, the
  // address through the override. During an override window those are two
  // different accounts, and every caller bakes the address into calldata — so
  // the pair being torn is a batch built for one account and executed as
  // another, not a logging cosmetic.
  const at = util.indexOf("export const getCurrentEphemeralInfo");
  const body = util.slice(at, util.indexOf("export const", at + 10));
  assert.match(body, /overriddenEphemeralIndex\(\)/, "the override is not consulted");
  assert.match(
    body,
    /getEphemeralAddressForIndex\(/,
    "the address must be derived from the index this returns",
  );
  assert.ok(
    !/getCurrentEphemeralAddress\(/.test(body),
    "reading the address separately is what tore the pair",
  );
});

test("the override is cleared in a finally, not on the success path", () => {
  // A throw between install and clear would leave the wallet signing as the
  // wrong account for everything afterwards.
  assert.match(override, /finally\s*\{/);
  const finallyAt = override.indexOf("} finally {");
  const tail = override.slice(finallyAt);
  assert.match(tail, /activeIndex = undefined/);
  assert.match(tail, /setCurrentEphemeralWallet as/, "the engine override must be cleared too");
});

test("overrides serialise rather than interleave", () => {
  // Two at once would build each other's transactions.
  assert.match(override, /queue/);
  assert.match(override, /queue\s*=\s*mine\.then/);
});

test("a queued override does not inherit the previous one's failure", () => {
  // Chaining with a single handler would reject every later override after one
  // failed build.
  assert.match(override, /queue\.then\(run, run\)/);
});

test("nesting is refused rather than silently clearing the outer window", () => {
  assert.match(override, /class EphemeralOverrideReentry/);
  assert.match(override, /if \(nested\.getStore\(\)\) throw new EphemeralOverrideReentry\(\)/);
});

test("the guard can tell nesting from concurrency", () => {
  // A module-global boolean was true for the whole duration of any override,
  // so a second CALLER — a recovery started while a swap was mid-build — was
  // rejected outright rather than queued, which is the opposite of what the
  // queue directly above it promises. Only a call genuinely inside another
  // override's own async stack may be refused.
  assert.match(override, /AsyncLocalStorage/);
  assert.match(override, /nested\.run\(true, \(\) => fn\(account\.address\)\)/);
  assert.ok(
    !/let inside = false/.test(override),
    "the module-global depth flag is still there, and cannot see call stacks",
  );
});

test("the persisted index is never moved by an override", () => {
  // The ratchet belongs to the account that was actually consumed, and an
  // override consumed a different one.
  assert.ok(
    !/setEphemeralIndex|advanceEphemeralIndex|ratchetEphemeral/.test(override),
    "an override must not touch the persisted counter",
  );
});

test("recovery uses the shared seam rather than its own inline override", () => {
  assert.match(recovery, /withEphemeralOverride\(/);
  assert.ok(
    !/setCurrentEphemeralWallet\(targetAccount\.signer\)/.test(recovery),
    "recovery is installing the override itself again",
  );
});
