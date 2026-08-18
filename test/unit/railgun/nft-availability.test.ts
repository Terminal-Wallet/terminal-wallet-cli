/**
 * Whether a shielded NFT can be spent, and whether the screen says so.
 *
 * Built from a real incident: a failed relay-adapt close re-shielded position
 * 1981, which nullified the old note and wrote a NEW one. The position was
 * on-chain and owned by RAILGUN, the wallet listed it, and the next spend died
 * inside the engine with `RAILGUN spendable private NFT balance too low` — a
 * message that describes an empty wallet. The user reasonably concluded the NFT
 * was stuck in an ephemeral address.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RailgunWalletBalanceBucket } from "@railgun-community/shared-models";
import {
  availabilityForBucket,
  availabilityLabel,
  bestAvailability,
  isSpendable,
} from "../../../src/railgun/balance/nft-availability";
import { describeNFT, describeNFTs } from "../../../src/railgun/balance/nft-util";

const POOL = "0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8";
const NFT = { nftAddress: POOL, tokenSubID: "0x7bd", nftTokenType: 0, amount: 1n } as never;
const KNOWN = [{ address: POOL, name: "wstETH-Long", kind: "fx-position" as const }];
const KEY = `${POOL.toLowerCase()}:1981`;

test("only Spendable is spendable", () => {
  assert.equal(availabilityForBucket(RailgunWalletBalanceBucket.Spendable), "spendable");
  assert.ok(isSpendable("spendable"));
});

test("the POI buckets read as maturing, not as loss", () => {
  // These resolve on their own, which is the single fact the user needs.
  for (const bucket of [
    RailgunWalletBalanceBucket.ShieldPending,
    RailgunWalletBalanceBucket.ProofSubmitted,
    RailgunWalletBalanceBucket.MissingInternalPOI,
    RailgunWalletBalanceBucket.MissingExternalPOI,
  ]) {
    assert.equal(availabilityForBucket(bucket), "pending", `${bucket} misread`);
    assert.ok(!isSpendable(availabilityForBucket(bucket)));
    assert.match(availabilityLabel("pending").note, /clears on its own/);
  }
});

test("a blocked shield is distinguished from one that is merely waiting", () => {
  // Waiting for a blocked shield is waiting forever.
  assert.equal(availabilityForBucket(RailgunWalletBalanceBucket.ShieldBlocked), "blocked");
  assert.equal(availabilityLabel("blocked").colour, "red");
  assert.doesNotMatch(availabilityLabel("blocked").note, /clears on its own/);
});

test("CONTROL: an unrecognised bucket never reads as spendable", () => {
  // Claiming spendable for something unknown is the one answer that can cost
  // the user a proof and a broadcaster fee.
  for (const bucket of [undefined, "", "SomeFutureBucket", RailgunWalletBalanceBucket.Spent]) {
    assert.equal(availabilityForBucket(bucket as string), "unknown");
    assert.ok(!isSpendable(availabilityForBucket(bucket as string)));
  }
});

test("the best bucket wins when a note is seen under two txid versions", () => {
  // The cache is keyed by (version, bucket), so one NFT can carry two.
  assert.equal(
    bestAvailability([
      RailgunWalletBalanceBucket.ShieldPending,
      RailgunWalletBalanceBucket.Spendable,
    ]),
    "spendable",
  );
  assert.equal(
    bestAvailability([
      RailgunWalletBalanceBucket.ShieldBlocked,
      RailgunWalletBalanceBucket.ShieldPending,
    ]),
    "pending",
  );
});

test("no buckets at all is unknown, not spendable", () => {
  assert.equal(bestAvailability([]), "unknown");
});

test("describeNFT reports the availability when buckets are supplied", () => {
  const out = describeNFT(NFT, KNOWN, { [KEY]: [RailgunWalletBalanceBucket.ShieldPending] });
  assert.equal(out.availability, "pending");
  assert.equal(out.label, "wstETH-Long #1981");
});

test("CONTROL: omitting buckets leaves availability undefined, not spendable", () => {
  // A caller that does not know must not be mistaken for one reporting good
  // news. `undefined` is falsy at every call site; "spendable" is not.
  const out = describeNFT(NFT, KNOWN);
  assert.equal(out.availability, undefined);
  assert.ok(!isSpendable(out.availability as never));
});

test("an NFT missing from the bucket map is unknown rather than spendable", () => {
  // The union list and the bucket map are built from the same cache, but a
  // race between them must not invent spendability.
  const out = describeNFT(NFT, KNOWN, {});
  assert.equal(out.availability, "unknown");
});

test("describeNFTs threads buckets through the whole list", () => {
  const out = describeNFTs([NFT], KNOWN, {
    [KEY]: [RailgunWalletBalanceBucket.Spendable],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].availability, "spendable");
});

test("every availability has a label, and only the good one is green", () => {
  assert.equal(availabilityLabel("spendable").colour, "green");
  assert.equal(availabilityLabel("spendable").note, "");
  for (const a of ["pending", "blocked", "unknown"] as const) {
    assert.notEqual(availabilityLabel(a).colour, "green");
    assert.ok(availabilityLabel(a).note.length > 0, `${a} has no explanation`);
  }
});
