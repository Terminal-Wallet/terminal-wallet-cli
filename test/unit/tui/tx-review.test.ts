/**
 * The transaction review body.
 *
 * Worth testing on its own because it is the one place user-supplied text — a
 * memo — is rendered into a blessed panel, and blessed treats braces as markup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { txReviewBody } from "../../../src/tui/format/tx-review";
import { CoreHistoryItem } from "../../../src/core/history";

const item = (over: Partial<CoreHistoryItem> = {}): CoreHistoryItem => ({
  txid: "0xabc123",
  category: "Send",
  direction: "out",
  amounts: [{ symbol: "ETH", amount: "1.5" }],
  ...over,
});

const CHAIN = NetworkName.Ethereum;

test("renders the essentials", () => {
  const out = txReviewBody(item(), CHAIN);
  assert.match(out, /SEND/);
  assert.match(out, /sent/);
  assert.match(out, /1\.5/);
  assert.match(out, /ETH/);
  assert.match(out, /0xabc123/);
});

test("a memo cannot inject blessed markup", () => {
  // blessed reads {…} as styling. An unsanitised memo could corrupt the rest of
  // the panel or restyle it, and the memo is the one field an outside party
  // controls — it arrives attached to a received transaction.
  const out = txReviewBody(
    item({ memo: "hi {red-fg}INJECTED{/} there" }),
    CHAIN,
  );
  assert.ok(!out.includes("{red-fg}"), "markup survived sanitisation");
  assert.ok(out.includes("INJECTED"), "the text itself should still be shown");
});

test("distinguishes a broadcaster fee from a self-signed send", () => {
  const relayed = txReviewBody(
    item({ fee: { symbol: "USDC", amount: "0.42" }, via: "broadcaster" }),
    CHAIN,
  );
  assert.match(relayed, /via broadcaster/);
  assert.match(relayed, /0\.42/);

  const selfSigned = txReviewBody(item(), CHAIN);
  assert.match(selfSigned, /self-signed/);
});

test("an entry with no amounts still renders", () => {
  // History can contain activity with nothing to show — an empty list must not
  // produce a blank Amounts section with no explanation.
  const out = txReviewBody(item({ amounts: [], category: "Activity" }), CHAIN);
  assert.match(out, /Amounts/);
  assert.match(out, /—/);
});

test("change outputs are shown separately from the amounts sent", () => {
  const out = txReviewBody(
    item({ change: [{ symbol: "ETH", amount: "0.25" }] }),
    CHAIN,
  );
  assert.match(out, /Change/);
  assert.match(out, /0\.25/);
});

test("optional fields are omitted rather than rendered empty", () => {
  const out = txReviewBody(item(), CHAIN);
  assert.ok(!out.includes("Memo"), "no memo section without a memo");
  assert.ok(!out.includes("Block"), "no block line without a block number");
});
