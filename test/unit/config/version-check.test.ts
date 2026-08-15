/**
 * The version gate, which is the operator's remote kill switch.
 *
 * `minVersionNumber` is published in the on-chain remote config and blocks the
 * app from running (exit 69). A comparison that is wrong in the blocking
 * direction locks users out of a build that is actually current, remotely, and
 * cannot be undone quickly. So the ordering is asserted directly rather than
 * inferred from the two call sites.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "../../../src/config/config-overrides";

const older = (a: string, b: string) =>
  assert.ok(compareVersions(a, b) < 0, `${a} should be older than ${b}`);
const newer = (a: string, b: string) =>
  assert.ok(compareVersions(a, b) > 0, `${a} should be newer than ${b}`);
const same = (a: string, b: string) =>
  assert.equal(compareVersions(a, b), 0, `${a} should equal ${b}`);

test("CONTROL: the two-digit segment that string comparison got wrong", () => {
  // "2.0.10" < "2.0.9" is true lexicographically. That is the whole reason this
  // function exists: at the tenth patch the app would nag that a newer version
  // was available while running it, and a floor of 2.0.9 would lock it out.
  assert.ok("2.0.10" < "2.0.9", "the string comparison is no longer wrong here");
  newer("2.0.10", "2.0.9");
  newer("2.0.11", "2.0.9");
  newer("1.10.0", "1.9.0");
  newer("10.0.0", "9.0.0");
});

test("ordinary ordering", () => {
  older("2.0.0", "2.0.1");
  older("1.9.9", "2.0.0");
  newer("2.0.1", "2.0.0");
  same("2.0.0", "2.0.0");
});

test("this patch runs against a 2.0.0 remote config", () => {
  // The live case: the on-chain artifact still says 2.0.0 and cannot be
  // updated yet. 2.0.1 must neither be blocked nor reported as out of date.
  assert.ok(compareVersions("2.0.1", "2.0.0") >= 0, "2.0.1 would be blocked");
  assert.ok(compareVersions("2.0.1", "2.0.0") > 0, "2.0.1 would be nagged");
});

test("missing segments count as zero", () => {
  same("2.1", "2.1.0");
  same("2", "2.0.0");
  older("2.1", "2.1.1");
});

test("a pre-release suffix does not throw or invert", () => {
  // This gates a download prompt, not a package resolver. A pre-release
  // ordering alongside its release costs a nag; throwing costs the boot.
  assert.doesNotThrow(() => compareVersions("2.0.0-rc.1", "2.0.0"));
  same("2.0.0-rc.1", "2.0.0");
  older("1.0.0-rc.1", "2.0.0");
});

test("CONTROL: a pre-release does not outrank its own release", () => {
  // Splitting on "." before stripping the suffix reads "0-rc" and "1" as two
  // further segments, making 2.0.0-rc.1 NEWER than 2.0.0 — suppressing the
  // upgrade prompt on exactly the build most likely to need it.
  assert.ok(
    compareVersions("2.0.0-rc.1", "2.0.0") <= 0,
    "a release candidate ranks above its release",
  );
});

test("an empty or absent floor never blocks", () => {
  // A remote config with no minVersionNumber must not brick every client.
  assert.ok(compareVersions("2.0.1", "") >= 0);
  assert.ok(compareVersions("2.0.1", "0.0.0") > 0);
  assert.ok(compareVersions("2.0.1", undefined as unknown as string) >= 0);
});

test("comparison is antisymmetric", () => {
  const versions = ["0.0.0", "1.9.0", "2.0.0", "2.0.9", "2.0.10", "2.1", "10.0.0"];
  for (const a of versions) {
    for (const b of versions) {
      const ab = compareVersions(a, b);
      const ba = compareVersions(b, a);
      // Summed rather than negated: Math.sign(0) is 0 and -Math.sign(0) is -0,
      // which strictEqual distinguishes.
      assert.equal(
        Math.sign(ab) + Math.sign(ba),
        0,
        `${a} vs ${b} is inconsistent (${ab} / ${ba})`,
      );
    }
  }
});
