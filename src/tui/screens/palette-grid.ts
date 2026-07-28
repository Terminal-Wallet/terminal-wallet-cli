/**
 * Pure model for the deck's "defi-card" command palette: the action catalog
 * (src/ui-ink/actions.ts) mapped to a small set of category-grouped cards, plus
 * a responsive grid layout and 2D keyboard navigation. No blessed imports — the
 * deck renders this; the logic stays unit-testable.
 *
 * Categories: PRIVATE / PUBLIC, then one per protocol, then OTHER. The
 * header carries the qualifier so a card only has to name the verb — which is
 * why two cards can both read "Send" without being ambiguous. Protocol actions
 * all spend the private balance and gate like PRIVATE. OTHER is a synthetic
 * card that opens the cookbook extension point.
 */
import { buildActions, MenuGroup } from "../actions";

export type PaletteCategory =
  | "PRIVATE"
  | "PUBLIC"
  | "MORPHO"
  | "F(X)"
  | "OTHER";

/** The balance set a seeded token came from (anchored to the rail section). */
export type TokenKind = "private" | "public";

export interface PaletteCard {
  id: string;
  label: string;
  /** The card's second line — what the action does, not what it is called. */
  hint?: string;
  category: PaletteCategory;
  disabled?: boolean; // gated out by the seeded token's kind
}

export type NavDir = "left" | "right" | "up" | "down";

/** Action ids the palette can open — the single source mirroring the old filter. */
const OPENABLE = new Set([
  "private-transfer",
  "unshield-private-balances",
  "shield-public-balances",
  "public-transfer",
  "private-swap",
  "public-swap",
  "morpho-vault-deposit",
  "morpho-vault-redeem",
  "fx-mint-open",
  "fx-mint-manage",
  "fx-mint-close",
]);

const CATEGORY_OF: Partial<Record<MenuGroup, PaletteCategory>> = {
  "Private Actions": "PRIVATE",
  "Public Actions": "PUBLIC",
  Morpho: "MORPHO",
  "f(x)": "F(X)",
};

export const CATEGORY_ORDER: PaletteCategory[] = [
  "PRIVATE",
  "PUBLIC",
  "MORPHO",
  "F(X)",
  "OTHER",
];

/** The categories that spend the private balance, and so gate together. */
const PRIVATE_SPENDING: PaletteCategory[] = ["PRIVATE", "MORPHO", "F(X)"];

/**
 * Whether a card is gated out by the seeded token's kind — a public token
 * cannot start a private action, and the reverse.
 *
 * Swaps used to sit in their own category, which said nothing about which
 * balance they spend, so both had to be named here by id. They now live in the
 * PRIVATE and PUBLIC sections with everything else that spends the same money,
 * and the rule is about categories again. OTHER is never gated; no seeded
 * token gates nothing.
 */
export const isCardGated = (
  card: Pick<PaletteCard, "id" | "category">,
  kind: TokenKind | undefined,
): boolean => {
  if (!kind || card.category === "OTHER") return false;
  return kind === "private"
    ? card.category === "PUBLIC"
    : PRIVATE_SPENDING.includes(card.category);
};

/** The palette's card set: openable actions grouped by category + a synthetic Other. */
export const buildPaletteCards = (
  baseSymbol: string,
  kind?: TokenKind,
): PaletteCard[] => {
  const cards: PaletteCard[] = buildActions(baseSymbol).flatMap((a) => {
    const category = CATEGORY_OF[a.group];
    return OPENABLE.has(a.id) && category
      ? [
          {
            id: a.id,
            label: a.label,
            hint: a.hint,
            category,
            disabled: isCardGated({ id: a.id, category }, kind),
          },
        ]
      : [];
  });
  cards.push({
    id: "other",
    label: "Other\u2026",
    hint: "more recipes",
    category: "OTHER",
  });
  return cards;
};

export interface LaidCard extends PaletteCard {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaletteLayout {
  cards: LaidCard[];
  headers: { category: PaletteCategory; label: string; y: number }[];
  rows: string[][]; // card-id rows, in visual order, for keyboard nav
  cols: number;
  width: number;
  height: number; // total rows used (header + card rows)
}

export interface LayoutOpts {
  width: number;
  minCardW?: number;
  gap?: number;
  cardH?: number;
}

/**
 * Lay the cards out as category sections (a header row, then the category's cards
 * wrapped into `cols` columns). Responsive: `cols` shrinks with width, down to 1.
 */
export const layoutGrid = (cards: PaletteCard[], opts: LayoutOpts): PaletteLayout => {
  const gap = opts.gap ?? 1;
  const minCardW = opts.minCardW ?? 14;
  const cardH = opts.cardH ?? 3;
  const cols = Math.max(1, Math.floor((opts.width + gap) / (minCardW + gap)));
  const cardW = Math.max(
    1,
    Math.floor((opts.width - gap * (cols - 1)) / cols),
  );

  const laid: LaidCard[] = [];
  const headers: PaletteLayout["headers"] = [];
  const rows: string[][] = [];
  let y = 0;
  for (const cat of CATEGORY_ORDER) {
    const inCat = cards.filter((c) => c.category === cat);
    if (!inCat.length) continue;
    headers.push({ category: cat, label: cat, y });
    y += 1; // header row
    for (let i = 0; i < inCat.length; i += cols) {
      const rowCards = inCat.slice(i, i + cols);
      rows.push(rowCards.map((c) => c.id));
      rowCards.forEach((c, j) => {
        laid.push({ ...c, x: j * (cardW + gap), y, w: cardW, h: cardH });
      });
      y += cardH;
    }
  }
  return { cards: laid, headers, rows, cols, width: opts.width, height: y };
};

/**
 * Move the selection across the row-major card grid; returns the new card id.
 * `isDisabled` (optional) makes nav skip gated cards: it keeps stepping in the
 * same direction over disabled cells and stays put if none is reachable.
 */
export const gridNav = (
  rows: string[][],
  current: string,
  dir: NavDir,
  isDisabled: (id: string) => boolean = () => false,
): string => {
  if (!rows.length) return current;
  let r = 0;
  let c = 0;
  for (let i = 0; i < rows.length; i++) {
    const j = rows[i].indexOf(current);
    if (j >= 0) {
      r = i;
      c = j;
      break;
    }
  }
  const step = (rr: number, cc: number): [number, number] => {
    if (dir === "left") return [rr, Math.max(0, cc - 1)];
    if (dir === "right") return [rr, Math.min(rows[rr].length - 1, cc + 1)];
    if (dir === "up") {
      const nr = Math.max(0, rr - 1);
      return [nr, Math.min(cc, rows[nr].length - 1)];
    }
    const nr = Math.min(rows.length - 1, rr + 1);
    return [nr, Math.min(cc, rows[nr].length - 1)];
  };
  let [nr, nc] = step(r, c);
  while (isDisabled(rows[nr][nc])) {
    const [pr, pc] = [nr, nc];
    [nr, nc] = step(nr, nc);
    if (nr === pr && nc === pc) return current; // no enabled cell this way
  }
  return rows[nr][nc];
};
