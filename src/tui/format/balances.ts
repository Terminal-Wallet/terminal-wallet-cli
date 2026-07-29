/**
 * Pure helpers for the deck's portfolio rail. The rail shows BOTH the private
 * and public sides at once as a single scrollable list: a `PRIVATE` section
 * (each token grouped — a total header row that carries the Spendable tag, with
 * an indented sub-row tree only for the non-spendable POI buckets) then a flat
 * `PUBLIC` section. These functions own the section structure and the row→token
 * index mapping so the blessed shell stays a thin renderer (and unit-testable).
 */
import { RailgunWalletBalanceBucket } from "@railgun-community/shared-models";
import { NftBalance, TokenBalance } from "../store";

/** A rendered rail row. `token`/`kind` are set only on clickable balance rows. */
export interface PortfolioRow {
  text: string;
  token?: TokenBalance;
  kind?: "private" | "public"; // which section the balance row came from
  /**
   * Set on both lines of a position, so clicking either opens it.
   *
   * A position is not a token — it has no amount to seed a builder with — so
   * it carries itself rather than a `token`, and the click handler tells the
   * two apart by which field is set.
   */
  nft?: NftBalance;
}

/** A token's private balance grouped across its buckets, with summed totals. */
export interface TokenGroup {
  symbol: string;
  totalAmount: string; // summed amount as a plain decimal string (display)
  totalUsd?: number; // summed USD across buckets; undefined when no prices
  buckets: TokenBalance[]; // the per-(token,bucket) rows, in arrival order
}

/** Short label + colour for a POI bucket (Spendable highlighted green). */
export const bucketTag = (
  bucket?: string,
): { short: string; color: string } => {
  switch (bucket) {
    case RailgunWalletBalanceBucket.Spendable:
      return { short: "spendable", color: "green" };
    case RailgunWalletBalanceBucket.ShieldPending:
      return { short: "shielding", color: "yellow" };
    case RailgunWalletBalanceBucket.ShieldBlocked:
      return { short: "blocked", color: "red" };
    case RailgunWalletBalanceBucket.ProofSubmitted:
      return { short: "proving", color: "yellow" };
    case RailgunWalletBalanceBucket.MissingInternalPOI:
    case RailgunWalletBalanceBucket.MissingExternalPOI:
      return { short: "poi-pending", color: "yellow" };
    default:
      return { short: "", color: "gray" };
  }
};

/** Parse a formatUSD string ("$1,234.56" / "—" / undefined) back to a number. */
const parseUsd = (s?: string): number | undefined => {
  if (!s || s === "—") return undefined;
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return isFinite(n) ? n : undefined;
};

/**
 * Group flat per-(token,bucket) private balances by token symbol, preserving
 * first-seen order, and sum each token's amount + USD across its buckets. The
 * amount sum is display-precision (parsed from the formatted string), matching
 * the rail's own truncation — it is not used for spend math.
 */
export const groupPrivateByToken = (items: TokenBalance[]): TokenGroup[] => {
  const order: string[] = [];
  const map = new Map<string, { amount: number; usd?: number; buckets: TokenBalance[] }>();
  for (const b of items) {
    let g = map.get(b.symbol);
    if (!g) {
      g = { amount: 0, usd: undefined, buckets: [] };
      map.set(b.symbol, g);
      order.push(b.symbol);
    }
    g.buckets.push(b);
    const amt = parseFloat(b.amount);
    if (isFinite(amt)) g.amount += amt;
    const usd = parseUsd(b.usd);
    if (usd !== undefined) g.usd = (g.usd ?? 0) + usd;
  }
  return order.flatMap((symbol) => {
    const g = map.get(symbol);
    // `order` is derived from `map`, so this cannot miss — but a filter says so
    // without asserting, and stays correct if the two ever diverge.
    return g
      ? [{ symbol, totalAmount: String(g.amount), totalUsd: g.usd, buckets: g.buckets }]
      : [];
  });
};

/**
 * A glanceable rollup of private funds NOT in the Spendable bucket — distinct
 * tokens per pending bucket kind (e.g. "1 shielding · 2 poi-pending"). Empty
 * when everything is spendable. Surfaced in the PRIVATE header so pending POI /
 * shield funds are visible without scanning every per-bucket sub-row.
 */
export const pendingSummary = (rows: TokenBalance[]): string => {
  const symbolsByKind = new Map<string, Set<string>>(); // short tag → distinct symbols
  for (const r of rows) {
    const { short } = bucketTag(r.bucket);
    if (!short || short === "spendable") continue;
    const forKind = symbolsByKind.get(short) ?? new Set<string>();
    forKind.add(r.symbol);
    symbolsByKind.set(short, forKind);
  }
  return [...symbolsByKind.entries()]
    .map(([short, syms]) => `${syms.size} ${short}`)
    .join(" · ");
};

/** True when a token group holds any funds in the Spendable bucket. */
export const hasSpendable = (g: TokenGroup): boolean =>
  g.buckets.some((b) => bucketTag(b.bucket).short === "spendable");

/** Render hooks supplied by the shell so this module stays render-agnostic. */
export interface PortfolioRenderers {
  tag: (text: string, color: string) => string;
  publicRow: (b: TokenBalance) => string; // a flat public balance cell
  // a token's total header cell; `spendable` flags whether to tag it Spendable
  privHeader: (g: TokenGroup, spendable: boolean) => string;
  privBucket: (b: TokenBalance) => string; // an indented per-bucket sub-row
  nftRow: (n: NftBalance) => string; // a shielded position
}

/**
 * Build the full portfolio rail: a grouped PRIVATE section then a flat PUBLIC
 * section, with per-section totals. The Spendable bucket is folded onto the
 * token header (tagged there); the indented sub-row tree is emitted only for
 * the remaining non-spendable buckets, so a fully-spendable token shows just its
 * header. Header/empty/spacer and per-bucket sub-rows carry no `token` so a
 * click on them is ignored; the per-token header row is the clickable seed
 * target (seeding is by symbol).
 */
export const buildPortfolioRows = (
  privGroups: TokenGroup[],
  pub: TokenBalance[],
  privTotal: string,
  pubTotal: string,
  r: PortfolioRenderers,
  /** Appended to the pending summary; see format/shield-timer.ts. */
  pendingNote: (summary: string) => string = (summary) => summary,
  /** Shielded NFTs. Omitted entirely when there are none, rather than shown empty. */
  nfts: NftBalance[] = [],
): PortfolioRow[] => {
  const rows: PortfolioRow[] = [];
  const sectionHead = (name: string, total: string, note = "") => {
    const sum = total && total !== "—" ? `  Σ ${total}` : "";
    rows.push({ text: r.tag(name, "white") + r.tag(sum, "green") + note });
  };

  const pending = pendingSummary(privGroups.flatMap((g) => g.buckets));
  sectionHead(
    "PRIVATE",
    privTotal,
    pending ? r.tag(`   ○ ${pendingNote(pending)}`, "yellow") : "",
  );
  if (privGroups.length) {
    for (const g of privGroups) {
      // The header is the clickable token row; seeding resolves by symbol, so a
      // lightweight token carrying the symbol + total is enough.
      const token: TokenBalance = { symbol: g.symbol, amount: g.totalAmount };
      rows.push({ text: r.privHeader(g, hasSpendable(g)), token, kind: "private" });
      // Spendable lives on the header; only the other buckets form the tree.
      for (const b of g.buckets) {
        if (bucketTag(b.bucket).short === "spendable") continue;
        rows.push({ text: r.privBucket(b) });
      }
    }
  } else {
    rows.push({ text: r.tag("  no private balances", "gray") });
  }

  if (nfts.length) {
    rows.push({ text: "" });
    // Its own section rather than a row among the tokens: a position is not a
    // balance, it has no USD figure here, and it is not spendable by amount.
    rows.push({ text: r.tag("POSITIONS", "white") });
    for (const nft of nfts) {
      // One list item per LINE. A renderer returning an embedded newline draws
      // two lines from one item, and every row below it is then one off the
      // index a click maps back to — the rail would seed the builder with the
      // wrong token.
      for (const line of r.nftRow(nft).split("\n")) rows.push({ text: line, nft });
    }
  }

  rows.push({ text: "" });

  sectionHead("PUBLIC", pubTotal);
  if (pub.length) {
    for (const b of pub) rows.push({ text: r.publicRow(b), token: b, kind: "public" });
  } else {
    rows.push({ text: r.tag("  no public balances", "gray") });
  }
  return rows;
};
