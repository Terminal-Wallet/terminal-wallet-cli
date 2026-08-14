/**
 * Shielded NFTs, from the engine event to the rail.
 *
 * The engine has reported `nftAmounts` on every balance event all along; the
 * wallet destructured the event and dropped them, which is why it could not say
 * which positions it held. Nothing failed — the field simply went nowhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const POOL = "0xF1D0F1D0F1D0F1D0F1D0F1D0F1D0F1D0F1D0F1D0";
const KNOWN = [{ address: POOL, name: "wstETH-Long", kind: "fx-position" as const }];

const nft = (over = {}) => ({
  nftAddress: POOL,
  nftTokenType: NFTTokenType.ERC721,
  tokenSubID: "0x1092",
  amount: 1n,
  ...over,
});

test("a position is named by its pool and its id, in decimal", () => {
  const shown = describeNFT(nft(), KNOWN);
  // The chain stores the id as hex; every protocol UI shows it as 4242.
  assert.equal(shown.label, "wstETH-Long #4242");
  assert.equal(shown.kind, "fx-position");
});

test("an unknown collection still shows something usable", () => {
  const shown = describeNFT(nft({ nftAddress: "0x1234567890abcdef1234567890abcdef12345678" }), KNOWN);
  assert.match(shown.label, /^0x1234…5678 #4242$/);
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
    { label: "wstETH-Long #4242", amount: "1", kind: "fx-position" },
  ]);
  const text = rows.map((r) => r.text);
  assert.ok(text.includes("POSITIONS"), "no POSITIONS heading");
  assert.ok(text.some((t) => t.includes("wstETH-Long #4242")));
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
    { label: "wstETH-Long #4242", amount: "1" },
  ]);
  const row = rows.find((r) => r.text.includes("#4242"));
  assert.equal(row?.token, undefined);
});

test("describeNFTs maps the whole set", () => {
  const all = describeNFTs([nft(), nft({ tokenSubID: "0x1" })], KNOWN);
  assert.deepEqual(all.map((n) => n.label), ["wstETH-Long #4242", "wstETH-Long #1"]);
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
  assert.equal(left[0].tokenSubID, "0x1092");
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

test("another bucket's event does not wipe the positions", async () => {
  // The engine emits one balance event PER BUCKET, and drainBalanceQueue
  // applies every one of them. The NFT set was stored per-wallet rather than
  // per-bucket and replaced wholesale on each event, so whichever bucket was
  // applied last decided what the rail showed: a position appeared when
  // Spendable landed and vanished when any other bucket arrived carrying no
  // NFTs. That is the "showed and then disappeared" report.
  const WALLET = "multi-bucket-wallet";
  const event = (nfts: unknown[], bucket: RailgunWalletBalanceBucket) =>
    ({
      chain: { type: 0, id: 1 },
      erc20Amounts: [],
      nftAmounts: nfts,
      balanceBucket: bucket,
      railgunWalletID: WALLET,
    }) as never;

  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([nft()], RailgunWalletBalanceBucket.Spendable),
  );
  assert.equal(getPrivateNFTsForChain(NetworkName.Ethereum, WALLET).length, 1);

  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([], RailgunWalletBalanceBucket.ShieldPending),
  );
  const still = getPrivateNFTsForChain(NetworkName.Ethereum, WALLET);
  assert.equal(still.length, 1, "a position held as Spendable survived an empty ShieldPending event");
  assert.equal(still[0].tokenSubID, "0x1092");
});

test("a position pending a shield is still shown, and only once", async () => {
  // Shielded positions arrive in ShieldPending first. Reporting nothing until
  // they clear hides a position the wallet does hold; reporting it from both
  // buckets after it clears would show it twice.
  const WALLET = "pending-position-wallet";
  const event = (nfts: unknown[], bucket: RailgunWalletBalanceBucket) =>
    ({
      chain: { type: 0, id: 1 },
      erc20Amounts: [],
      nftAmounts: nfts,
      balanceBucket: bucket,
      railgunWalletID: WALLET,
    }) as never;

  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([nft()], RailgunWalletBalanceBucket.ShieldPending),
  );
  assert.equal(
    getPrivateNFTsForChain(NetworkName.Ethereum, WALLET).length,
    1,
    "a position still maturing is held, and hiding it hides the position",
  );

  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([nft()], RailgunWalletBalanceBucket.Spendable),
  );
  assert.equal(
    getPrivateNFTsForChain(NetworkName.Ethereum, WALLET).length,
    1,
    "the same position in two buckets is one position",
  );
});

test("a second txid version does not erase the first's positions", async () => {
  // ACTIVE_TXID_VERSIONS is [V2_PoseidonMerkle, V3_PoseidonMerkle] and the
  // engine runs onBalancesUpdate for EACH, emitting one event per bucket per
  // version. A wallet that has only ever transacted on V2 still gets V3 events,
  // carrying V3's (empty) set.
  //
  // The cache ignored txidVersion, so V2's positions and V3's emptiness landed
  // on the same key and the later one won. ERC20s survived this because they
  // are written per token address — a merge — while the NFT set is written as a
  // whole map, so an empty V3 event erased everything V2 had just reported.
  const WALLET = "txid-version-wallet";
  const event = (nfts: unknown[], txidVersion: string) =>
    ({
      txidVersion,
      chain: { type: 0, id: 1 },
      erc20Amounts: [],
      nftAmounts: nfts,
      balanceBucket: RailgunWalletBalanceBucket.Spendable,
      railgunWalletID: WALLET,
    }) as never;

  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([nft(), nft({ tokenSubID: "0x1" })], "V2_PoseidonMerkle"),
  );
  assert.equal(getPrivateNFTsForChain(NetworkName.Ethereum, WALLET).length, 2);

  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([], "V3_PoseidonMerkle"),
  );
  assert.equal(
    getPrivateNFTsForChain(NetworkName.Ethereum, WALLET).length,
    2,
    "an empty V3 event must not erase what V2 reported",
  );
});

test("positions from both txid versions are shown together, once each", async () => {
  const WALLET = "both-versions-wallet";
  const event = (nfts: unknown[], txidVersion: string) =>
    ({
      txidVersion,
      chain: { type: 0, id: 1 },
      erc20Amounts: [],
      nftAmounts: nfts,
      balanceBucket: RailgunWalletBalanceBucket.Spendable,
      railgunWalletID: WALLET,
    }) as never;

  await updatePrivateBalancesForChain(NetworkName.Ethereum, event([nft()], "V2_PoseidonMerkle"));
  await updatePrivateBalancesForChain(
    NetworkName.Ethereum,
    event([nft(), nft({ tokenSubID: "0x2" })], "V3_PoseidonMerkle"),
  );
  const held = getPrivateNFTsForChain(NetworkName.Ethereum, WALLET);
  assert.equal(held.length, 2, "the same position in both versions is one position");
  assert.deepEqual(
    held.map((n) => n.tokenSubID).sort(),
    ["0x1092", "0x2"],
  );
});

test("the drain queue keys events by version AND bucket", () => {
  // The cache fix alone is not enough: drainBalanceQueue dedupes the queue
  // before applying it, so keying that map on the bucket dropped the V2 event
  // for a bucket entirely whenever a V3 event for the same bucket was queued
  // alongside it — the V2 balances never reached the cache to be stored.
  const src = readFileSync(
    resolve(process.cwd(), "src/railgun/wallet/scan-callbacks.ts"),
    "utf-8",
  );
  assert.ok(
    src.includes("buckets[`${balanceEvent.txidVersion}:${balanceEvent.balanceBucket}`]"),
    "the dedupe key must carry both fields, or one version's events discard the other's",
  );
});

test("the whole position, detail included, reaches the renderer", () => {
  // buildPortfolioRows owns the section structure; what a row LOOKS like is
  // the shell's job. So what it has to guarantee is that it hands the renderer
  // everything the position carries, rather than a name.
  const seen: { detail?: string }[] = [];
  buildPortfolioRows([], [], "—", "—", {
    ...renderers,
    nftRow: (n: { label: string; detail?: string }) => {
      seen.push(n);
      return `  ${n.label}`;
    },
  } as never, undefined, [
    {
      label: "wstETH-Long #4242",
      amount: "1",
      kind: "fx-position",
      detail: "82.1% ▲ near rebal · 0.0002 wstETH · 0.4911 fxUSD",
    },
  ]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].detail ?? "", /near rebal/);
});

test("the rail's own renderer draws the detail, and colours a warning", () => {
  // The rail listed positions by name alone. A position is the one holding
  // that can move against you while nobody is looking, so the screen most
  // likely to be open was the one least able to say it was near rebalance.
  const entry = readFileSync(
    resolve(process.cwd(), "src/tui/entry.ts"),
    "utf-8",
  );
  const at = entry.indexOf("const nftRow =");
  assert.ok(at > 0, "nftRow is gone");
  const body = entry.slice(at, at + 700);
  assert.match(body, /n\.detail/, "the renderer ignores the position's risk");
  assert.match(body, /includes\("▲"\)/, "a warned position is not coloured");
});

test("a two-line position row becomes two list items", () => {
  // One item per LINE. An embedded newline draws two lines from one item and
  // every row below it is then one off the index a click maps back to — the
  // rail would seed the builder with the wrong token.
  const rows = buildPortfolioRows([], [], "—", "—", {
    ...renderers,
    nftRow: (n: { label: string }) => `  ${n.label}\n     detail line`,
  } as never, undefined, [{ label: "wstETH-Long #4242", amount: "1" }]);
  assert.ok(
    !rows.some((r) => r.text.includes("\n")),
    "a row still carries an embedded newline",
  );
  assert.ok(rows.some((r) => r.text.includes("detail line")));
});
