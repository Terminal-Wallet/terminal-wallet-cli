/**
 * NFTs cross the relay-adapt seam.
 *
 * A protocol position that is an ERC-721 — an f(x) fxMint position — has to be
 * unshielded into the batch, operated on, and shielded back. The SDK's 7702
 * estimate and proof have taken NFT arguments all along; this wallet passed
 * `[]` in every one of those positions, which is why no position flow could
 * work.
 *
 * The dangerous property is that `[]` is *valid*. The cookbook's step validator
 * only checks that every INPUT NFT reappears in the outputs, so an empty input
 * list passes and the batch fails on-chain instead. Nothing above this file
 * would notice a regression, so the source guard below is the thing that does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NFTTokenType } from "@railgun-community/shared-models";
import {
  CrossContractInputs,
  toShieldNFTRecipients,
} from "../../../src/railgun/transaction/cross-contract";
import { crossContractInputs, privateRecipient } from "../../_support";

const SRC = resolve(process.cwd(), "src");
const crossContract = readFileSync(
  join(SRC, "railgun/transaction/cross-contract.ts"),
  "utf-8",
);

const positionNFT = {
  nftAddress: "0xF1D0F1D0F1D0F1D0F1D0F1D0F1D0F1D0F1D0F1D0",
  tokenSubID: "0x2a",
  nftTokenType: NFTTokenType.ERC721,
  amount: 1n,
};

test("the cookbook's NFT recipient becomes the SDK's, field for field", () => {
  const [renamed] = toShieldNFTRecipients([
    { ...positionNFT, recipient: privateRecipient },
  ]);
  assert.deepEqual(renamed, {
    ...positionNFT,
    recipientAddress: privateRecipient,
  });
  assert.ok(
    !("recipient" in renamed),
    "the cookbook's field name must not survive the rename",
  );
});

test("a position NFT round trip is expressible as cross-contract inputs", () => {
  const inputs: CrossContractInputs = crossContractInputs({
    relayAdaptUnshieldNFTAmounts: [positionNFT],
    relayAdaptShieldNFTRecipients: toShieldNFTRecipients([
      { ...positionNFT, recipient: privateRecipient },
    ]),
  });
  assert.equal(inputs.relayAdaptUnshieldNFTAmounts?.length, 1);
  assert.equal(
    inputs.relayAdaptShieldNFTRecipients?.[0].recipientAddress,
    privateRecipient,
  );
});

test("token-only recipes still build without naming the NFT fields", () => {
  // Optional on purpose: every existing caller constructs this type as a
  // literal, and making the fields required would have been a wide edit for no
  // behaviour.
  const inputs = crossContractInputs();
  assert.equal(inputs.relayAdaptUnshieldNFTAmounts, undefined);
  assert.equal(inputs.relayAdaptShieldNFTRecipients, undefined);
});

test("the SDK calls receive the NFT arrays, not empty literals", () => {
  // The guard that matters. All three SDK calls — estimate, prove, populate —
  // take the NFT lists in argument positions 6 and 8. A regression here is
  // invisible: it type-checks, it estimates, and the batch reverts on-chain.
  assert.equal(
    (crossContract.match(/relayAdaptUnshieldNFTAmounts,/g) ?? []).length,
    3,
    "unshield NFTs are not passed to all three SDK calls",
  );
  assert.equal(
    (crossContract.match(/relayAdaptShieldNFTRecipients,/g) ?? []).length,
    3,
    "shield NFT recipients are not passed to all three SDK calls",
  );
  assert.ok(
    !/^\s*\[\],\s*$/m.test(crossContract),
    "an empty-array placeholder is back in an SDK argument position",
  );
});
