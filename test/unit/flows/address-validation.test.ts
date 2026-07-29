/**
 * The last check between a typo and an irreversible send.
 *
 * The rule this replaces was shape-only: `/^0zk[0-9a-z]+$/i` with
 * `length >= 20`, and a bare 40-hex match with no checksum. A real RAILGUN
 * address is 127 characters, so the 0zk rule accepted a fifth of one — which is
 * precisely what a truncated paste looks like. The deck could survive that
 * because a human reads the address off the review screen; a headless `--confirm`
 * has no review screen, so the validator has to be the check rather than a hint.
 *
 * Addresses here are built with the SDK's own encoder rather than pasted, so the
 * test carries no real address and still exercises a real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RailgunEngine } from "@railgun-community/engine";
import { addressKindError } from "../../../src/flows/address";

/** A genuine 0zk address: encoded by the SDK, so it carries a real checksum. */
const realZk = (seed: number): string =>
  RailgunEngine.encodeAddress({
    masterPublicKey: BigInt(seed) * 1_000_000_007n,
    viewingPublicKey: Uint8Array.from(Array.from({ length: 32 }, (_, i) => (i + seed) % 251)),
    chain: undefined,
    version: 1,
  } as never);

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // correct EIP-55

test("a real 0zk address is accepted", () => {
  const address = realZk(3);
  assert.equal(address.length, 127);
  assert.equal(addressKindError("0zk", address), undefined);
});

test("a truncated 0zk paste is refused", () => {
  // The control. Twenty-plus characters of lowercase alphanumerics after `0zk`
  // is exactly what the old rule was satisfied by.
  const truncated = realZk(3).slice(0, 32);
  assert.ok(truncated.length >= 20 && /^0zk[0-9a-z]+$/i.test(truncated));
  assert.match(addressKindError("0zk", truncated) ?? "", /Not a RAILGUN/);
});

test("a single flipped character in a 0zk address is refused", () => {
  const address = realZk(7);
  const flipped =
    address.slice(0, -1) + (address.slice(-1) === "a" ? "b" : "a");
  assert.equal(flipped.length, address.length);
  assert.ok(addressKindError("0zk", flipped), "a bad checksum was accepted");
});

test("a 0x address in a 0zk field is named, not just rejected", () => {
  assert.match(addressKindError("0zk", WETH) ?? "", /public 0x address/);
});

test("a 0zk address in a 0x field is named, not just rejected", () => {
  assert.match(addressKindError("0x", realZk(1)) ?? "", /private 0zk address/);
});

test("a checksummed 0x address is accepted, and so is an all-lowercase one", () => {
  // All-lowercase carries no checksum to fail, and is what most explorers and
  // block-scanners hand you. Refusing it would reject valid addresses.
  assert.equal(addressKindError("0x", WETH), undefined);
  assert.equal(addressKindError("0x", WETH.toLowerCase()), undefined);
});

test("a mixed-case 0x address with a broken checksum is refused", () => {
  // The control for the 0x side: shape alone cannot see this.
  const broken = "0xC02AAA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
  assert.match(broken, /^0x[0-9a-fA-F]{40}$/, "still a well-shaped 40-hex");
  assert.ok(addressKindError("0x", broken), "a bad EIP-55 checksum was accepted");
});

test("blank and whitespace are refused for both kinds", () => {
  for (const kind of ["0x", "0zk"] as const) {
    assert.ok(addressKindError(kind, ""));
    assert.ok(addressKindError(kind, "   "));
  }
});
