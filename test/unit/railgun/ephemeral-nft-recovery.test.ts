/**
 * A position stranded at an ephemeral account can be brought back.
 *
 * Recovery scanned ERC-20s and native only, so a batch that mined with a
 * reverted inner call could leave an f(x) position NFT on an address the wallet
 * ratchets past and never touches again. The NFT is the position — losing track
 * of it loses the collateral behind it.
 *
 * The source guards below are what hold: the fund path itself needs a chain,
 * but "does the proof carry the NFT list" is exactly the thing that was
 * silently `[]` for the whole life of the module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { holdsAssets } from "../../../src/tui/format/ephemeral-rows";
import { EphemeralAssetScan } from "../../../src/railgun/wallet/ephemeral-recovery";

const SRC = resolve(process.cwd(), "src");
const recovery = readFileSync(
  join(SRC, "railgun/wallet/ephemeral-recovery.ts"),
  "utf-8",
);

const scan = (over: Partial<EphemeralAssetScan> = {}): EphemeralAssetScan => ({
  address: "0xephemeral",
  nativeWei: 0n,
  erc20s: [],
  nfts: [],
  method: "logs",
  unreadable: 0,
  ...over,
});

test("an account holding only a position is not reported as empty", () => {
  // It used to be: the row said "—" and the recover prompt refused to open,
  // so the position was invisible and unreachable at the same time.
  const row = {
    index: 3,
    address: "0xephemeral",
    isCurrent: false,
    usedForUnshield: false,
    scan: scan({
      nfts: [{ nftAddress: "0xpool", tokenSubID: "0x1092", label: "wstETH-Long #4242" }],
    }),
  };
  assert.equal(holdsAssets(row), true);
});

test("a genuinely empty account is still empty", () => {
  const row = {
    index: 3,
    address: "0xephemeral",
    isCurrent: false,
    usedForUnshield: false,
    scan: scan(),
  };
  assert.equal(holdsAssets(row), false);
});

test("an unscanned row is not claimed to be empty", () => {
  const row = {
    index: 3,
    address: "0xephemeral",
    isCurrent: false,
    usedForUnshield: false,
  };
  assert.equal(holdsAssets(row), false, "unknown is not the same as empty");
});

test("estimate, prove and populate all carry the NFT recipients", () => {
  // These three argument positions took `[]` unconditionally. A regression here
  // type-checks, estimates, mines — and leaves the position where it was.
  const inCall = (fn: string) => {
    const at = recovery.indexOf(fn);
    assert.ok(at > 0, `${fn} not found`);
    return recovery.slice(at, at + 700).includes("shieldNFTRecipients,");
  };
  assert.ok(inCall("gasEstimateForUnprovenCrossContractCalls7702("), "estimate");
  assert.ok(inCall("generateCrossContractCallsProof7702("), "prove");
  assert.ok(inCall("populateProvedCrossContractCalls("), "populate");
  assert.ok(
    !/relayAdaptShieldNFTRecipients/.test(recovery),
    "an empty placeholder is back in the shield-NFT position",
  );
});

test("ERC-721 transfers are told apart from ERC-20 by their topic count", () => {
  // Both emit Transfer. ERC-721 indexes the token id, so it has a fourth topic.
  // Without the split an incoming NFT was scanned as a token and balanceOf —
  // which returns the holder's NFT COUNT — made it look like a real balance.
  assert.match(recovery, /topics\.length === 4/);
  assert.match(recovery, /topics\.length === 3/);
});

test("a candidate is only recoverable if it is still owned now", () => {
  // A log says an NFT arrived, not that it stayed.
  assert.match(recovery, /ownerOf/);
  assert.match(recovery, /owner\.toLowerCase\(\) !== address\.toLowerCase\(\)/);
});

test("recovery still refuses to build when nothing is selected", () => {
  assert.match(recovery, /Nothing selected to recover/);
  assert.match(recovery, /nfts\.length === 0/);
});
