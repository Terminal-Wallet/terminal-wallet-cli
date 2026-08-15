/**
 * Which broadcasters the wallet is allowed to see.
 *
 * The SDK's filter is `!allowlist || allowlist.includes(address)`. That makes
 * the allow list a very sharp instrument with two failure modes on either side
 * of it: `undefined` admits every broadcaster on the network, and an empty
 * ARRAY admits none, because `[]` is truthy and `[].includes(x)` is false.
 *
 * The policy is that the allow list holds the trusted fee signers, so only
 * those broadcasters are reachable. Both sides speak the same address space:
 * the filter runs over fee-cache keys, which are `feeMessageData.railgunAddress`
 * — the field `trustedFeeSigner` is matched against. A signer address IS a
 * broadcaster address.
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
 * the calls being asserted against — so reading the raw file would match prose
 * describing a rule rather than the code implementing it.
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

test("an allow list of trusted signers hides every other broadcaster", () => {
  // The intended consequence, shown rather than described.
  const seen = [TRUSTED_SIGNER, OTHER_BROADCASTER];
  assert.deepEqual(sdkFilter(seen, [TRUSTED_SIGNER], undefined), [TRUSTED_SIGNER]);
});

test("CONTROL: an undefined allow list admits the whole network", () => {
  // The fail-OPEN side. This is what an empty configured list would collapse
  // to, which is why the resolver below must never return one.
  const seen = [TRUSTED_SIGNER, OTHER_BROADCASTER];
  assert.deepEqual(sdkFilter(seen, undefined, undefined), seen);
});

test("CONTROL: an empty-array allow list admits nobody", () => {
  // The fail-CLOSED side, and the reason `[]` is never a safe seed value: it
  // is truthy, so it is a restriction to the empty set rather than the absence
  // of a restriction.
  const seen = [TRUSTED_SIGNER, OTHER_BROADCASTER];
  assert.deepEqual(sdkFilter(seen, [], undefined), []);
});

test("the allow list is loaded with the trusted fee signers", () => {
  const source = read("railgun/waku/connect-waku.ts");
  assert.match(
    source,
    /const signers = trustedFeeSigners\(\)/,
    "boot no longer resolves the trusted fee signers",
  );
  assert.match(
    source,
    /initializeLists\(signers,/,
    "boot no longer restricts broadcasters to the trusted fee signers",
  );
  assert.ok(
    !/initializeLists\(\[\]/.test(source),
    "boot starts with no address restriction, admitting every broadcaster",
  );
});

test("the resolver falls back to the baked-in signer rather than to nothing", () => {
  // An unreachable remote config is the case `fallbackRemoteConfig` exists for.
  // Returning [] there would widen the app from one permitted broadcaster to
  // every broadcaster on the network, exactly when least is known about them.
  const source = read("railgun/waku/connect-waku.ts");
  assert.match(
    source,
    /configured\.length > 0 \? configured : \[DEFAULT_TRUSTED_FEE_SIGNER\]/,
    "the trusted-signer resolver can return an empty list",
  );
});

test("CONTROL: the two filters disagree about case, so the list is normalized", () => {
  // AddressFilter does an exact `includes`; the SDK's fee-signer check
  // lowercases both sides. A config carrying a mixed-case address would pass
  // fee trust and match nothing here, removing every broadcaster with no
  // indication why. Shown rather than described:
  const advertised = TRUSTED_SIGNER; // canonical, lowercase
  const mixedCase = TRUSTED_SIGNER.toUpperCase();
  assert.deepEqual(sdkFilter([advertised], [mixedCase], undefined), []);
  assert.deepEqual(
    sdkFilter([advertised], [mixedCase.toLowerCase()], undefined),
    [advertised],
  );

  const source = read("railgun/waku/connect-waku.ts");
  assert.match(
    source,
    /\.map\(\(address\) => address\.toLowerCase\(\)\)/,
    "the trusted-signer list is not normalized before it becomes the allow list",
  );
});

test("fee-signature trust is still enforced, through the option that means it", () => {
  // The allow list narrows WHO is reachable; it does not replace the SDK's own
  // fee-signature check. Both controls stay on.
  const source = read("railgun/waku/connect-waku.ts");
  assert.match(
    source,
    /broadcasterOptions\.trustedFeeSigner = remoteConfig\.trustedFeeSigner/,
  );
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

test("CONTROL: the filter mutators do not seed themselves with an empty array", () => {
  // Seeded with `[]`, blocking one broadcaster before any allow-list mutation
  // set the allow list to the empty set and hid every broadcaster at once.
  const source = read("railgun/waku/broadcaster-util.ts");
  assert.ok(
    !/let currentAllowList[^=]*=\s*\[\]/.test(source),
    "the allow list is seeded with [], which admits nobody",
  );
  assert.ok(
    !/let currentBlockList[^=]*=\s*\[\]/.test(source),
    "the block list is seeded with []",
  );
});

test("CONTROL: pushing to a filter does not mutate the base list in place", () => {
  // `currentAllowList = baseAllowList` followed by `.push()` edits the module's
  // base list, so resetting the filters restores the mutated list rather than
  // the configured one.
  const source = read("railgun/waku/broadcaster-util.ts");
  assert.ok(
    !/currentAllowList = baseAllowList;\s*\n\s*\}/.test(source),
    "the allow list aliases the base list before being pushed to",
  );
  assert.match(source, /startFrom\(baseAllowList\)/);
  assert.match(source, /startFrom\(baseBlockList\)/);
});
