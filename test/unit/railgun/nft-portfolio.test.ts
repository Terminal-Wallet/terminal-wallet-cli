/**
 * Shielded NFTs, from the engine event to the rail.
 *
 * The engine has reported `nftAmounts` on every balance event all along; the
 * wallet destructured the event and dropped them, which is why it could not say
 * which positions it held. Nothing failed — the field simply went nowhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NFTTokenType,
  NetworkName,
  RailgunWalletBalanceBucket,
} from "@railgun-community/shared-models";
import {
  getPrivateNFTsForChain,
  updatePrivateBalancesForChain,
} from "../../../src/railgun/balance/balance-cache";
import { describeNFT, describeNFTs, nftTokenId } from "../../../src/railgun/balance/nft-util";
import { buildPortfolioRows } from "../../../src/tui/format/balances";

const POOL = "0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8";
const KNOWN = [{ address: POOL, name: "wstETH-Long", kind: "fx-position" as const }];

const nft = (over = {}) => ({
  nftAddress: POOL,
  nftTokenType: NFTTokenType.ERC721,
  tokenSubID: "0x7bd",
  amount: 1n,
  ...over,
});

test("a position is named by its pool and its id, in decimal", () => {
  const shown = describeNFT(nft(), KNOWN);
  // The chain stores the id as hex; every protocol UI shows it as 1981.
  assert.equal(shown.label, "wstETH-Long #1981");
  assert.equal(shown.kind, "fx-position");
});

test("an unknown collection still shows something usable", () => {
  const shown = describeNFT(nft({ nftAddress: "0x1234567890abcdef1234567890abcdef12345678" }), KNOWN);
  assert.match(shown.label, /^0x1234…5678 #1981$/);
  assert.equal(shown.kind, undefined, "unrecognised collections are not positions");
});

test("the collection match ignores address case", () => {
  assert.equal(describeNFT(nft({ nftAddress: POOL.toLowerCase() }), KNOWN).kind, "fx-position");
});

test("a malformed token id is shown rather than swallowed", () => {
  // It is still what the wallet holds; hiding it would hide the position.
  assert.equal(nftTokenId("not-hex"), "not-hex");
});

const renderers = {
  tag: (t: string) => t,
  publicRow: (b: { symbol: string }) => b.symbol,
  privHeader: (g: { symbol: string }) => g.symbol,
  privBucket: () => "bucket",
  nftRow: (n: { label: string }) => `  ${n.label}`,
};

test("positions get their own rail section, not a row among the tokens", () => {
  const rows = buildPortfolioRows([], [], "—", "—", renderers as never, undefined, [
    { label: "wstETH-Long #1981", amount: "1", kind: "fx-position" },
  ]);
  const text = rows.map((r) => r.text);
  assert.ok(text.includes("POSITIONS"), "no POSITIONS heading");
  assert.ok(text.some((t) => t.includes("wstETH-Long #1981")));
  assert.ok(
    text.indexOf("POSITIONS") < text.indexOf("PUBLIC"),
    "positions belong with the private holdings, above PUBLIC",
  );
});

test("no positions means no section at all, rather than an empty one", () => {
  const rows = buildPortfolioRows([], [], "—", "—", renderers as never, undefined, []);
  assert.ok(!rows.map((r) => r.text).includes("POSITIONS"));
});

test("a position row is not clickable as a token", () => {
  // Seeding a builder from a position would resolve it as a fungible balance.
  const rows = buildPortfolioRows([], [], "—", "—", renderers as never, undefined, [
    { label: "wstETH-Long #1981", amount: "1" },
  ]);
  const row = rows.find((r) => r.text.includes("#1981"));
  assert.equal(row?.token, undefined);
});

test("describeNFTs maps the whole set", () => {
  const all = describeNFTs([nft(), nft({ tokenSubID: "0x1" })], KNOWN);
  assert.deepEqual(all.map((n) => n.label), ["wstETH-Long #1981", "wstETH-Long #1"]);
});

test("the cache replaces the NFT set, so a spent position disappears", async () => {
  const WALLET = "wallet-under-test";
  const event = (nfts: unknown[]) =>
    ({
      chain: { type: 0, id: 1 },
      erc20Amounts: [],
      nftAmounts: nfts,
      balanceBucket: RailgunWalletBalanceBucket.Spendable,
      railgunWalletID: WALLET,
    }) as never;

  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([nft(), nft({ tokenSubID: "0x1" })]),
  );
  assert.equal(getPrivateNFTsForChain(NetworkName.Ethereum, WALLET).length, 2);

  // The engine reports the whole set each time. Merging would keep showing a
  // position that has since been spent — the wallet would offer to top up
  // something it no longer holds.
  await updatePrivateBalancesForChain(NetworkName.Ethereum, event([nft()]));
  const left = getPrivateNFTsForChain(NetworkName.Ethereum, WALLET);
  assert.equal(left.length, 1);
  assert.equal(left[0].tokenSubID, "0x7bd");
});

test("a zero-amount NFT is not held", async () => {
  const WALLET = "zero-amount-wallet";
  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    {
      chain: { type: 0, id: 1 },
      erc20Amounts: [],
      // A fully-closed fx position burns the NFT and reports it at 0.
      nftAmounts: [nft({ amount: 0n })],
      balanceBucket: RailgunWalletBalanceBucket.Spendable,
      railgunWalletID: WALLET,
    } as never,
  );
  assert.deepEqual(getPrivateNFTsForChain(NetworkName.Ethereum, WALLET), []);
});
