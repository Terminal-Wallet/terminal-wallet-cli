/**
 * Which broadcasters the wallet is allowed to see.
 *
 * The SDK's filter is `!allowlist || allowlist.includes(address)`, so an empty
 * allow list admits everyone and a populated one admits ONLY its members. That
 * makes the allow list a very sharp instrument, and it was being loaded with
 * the wrong thing: `initializeLists(remoteConfig.trustedFeeSigner as string[])`
 * put a single fee-signer address in it, so every other broadcaster was
 * filtered out of existence. A ranked favourite could never become available,
 * because it was never in the list to be found.
 *
 * The two are unrelated controls. Fee-signature trust is enforced by the SDK
 * through `broadcasterOptions.trustedFeeSigner`; the address allow list is an
 * operator-level restriction on WHO may be talked to at all.
 *
 * These read the source, because reaching the real filter means starting a
 * libp2p mesh.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

/**
 * Source with comments stripped.
 *
 * These assertions are about what the code DOES, and the comments here quote
 * the call being asserted against — so reading the raw file finds the bug
 * described in the prose explaining that it was fixed.
 */
const read = (rel: string): string =>
  readFileSync(join(SRC, rel), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const TRUSTED_SIGNER = "0zk1qyzgh9ctuxm6d06gmax39xutjgraw";
const OTHER_BROADCASTER = "0zk1qykotherbroadcasteraddress00";

/** The SDK's rule, reproduced so the consequence is demonstrated, not asserted. */
const sdkFilter = (
  addresses: string[],
  allowlist: string[] | string | undefined,
  blocklist: string[] | undefined,
): string[] =>
  addresses
    .filter((a) => !allowlist || allowlist.includes(a))
    .filter((a) => !blocklist || !blocklist.includes(a));

test("CONTROL: an allow list holding one fee signer hides every other broadcaster", () => {
  // The consequence, shown rather than described. It does not matter whether
  // the value arrives as a string or an array — both admit exactly one.
  const seen = [TRUSTED_SIGNER, OTHER_BROADCASTER];
  assert.deepEqual(sdkFilter(seen, TRUSTED_SIGNER, undefined), [TRUSTED_SIGNER]);
  assert.deepEqual(sdkFilter(seen, [TRUSTED_SIGNER], undefined), [TRUSTED_SIGNER]);
  assert.deepEqual(sdkFilter(seen, undefined, undefined), seen);
});

test("CONTROL: the trusted fee signer is not used as an address allow list", () => {
  // The exact call that caused it. If this returns, a favourite that is not the
  // fee signer can never appear however long the wait is.
  const source = read("railgun/waku/connect-waku.ts");
  assert.ok(
    !/initializeLists\(\s*remoteConfig\.trustedFeeSigner/.test(source),
    "the fee signer is being passed as the broadcaster address allow list",
  );
  assert.match(
    source,
    /initializeLists\(\[\]/,
    "boot should start with no address restriction",
  );
});

test("fee-signature trust is still enforced, through the option that means it", () => {
  // The point of the fix is that one control replaced the other, not that a
  // control was removed.
  const source = read("railgun/waku/connect-waku.ts");
  assert.match(source, /broadcasterOptions\.trustedFeeSigner = remoteConfig\.trustedFeeSigner/);
});

test("a config value declared string-or-array is normalized before it is used", () => {
  // `includes` on an array is a membership test; on a string it is a substring
  // test. Same method name, different question.
  const source = read("railgun/waku/connect-waku.ts");
  assert.match(source, /Array\.isArray\(value\) \? value : \[value\]/);
});

test("CONTROL: blocking a broadcaster does not clear the allow list", () => {
  // The two setters disagreed: one passed both lists, the other passed
  // `undefined` for the allow list, so whichever ran last decided the filters
  // and blocking someone silently widened the allow list to everyone.
  const source = read("railgun/waku/broadcaster-util.ts");
  assert.ok(
    !/setAddressFilters\(undefined,/.test(source),
    "blocking still wipes the allow list as a side effect",
  );
  const calls = source.match(/setAddressFilters\([^)]*\)/g) ?? [];
  assert.equal(calls.length, 3, "expected one call per list mutation");
  for (const call of calls) {
    assert.match(
      call,
      /currentAllowList,\s*currentBlockList/,
      `${call} does not set both lists`,
    );
  }
});
