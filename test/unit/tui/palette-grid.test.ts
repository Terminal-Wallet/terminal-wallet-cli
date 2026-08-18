/**
 * The palette's model — and the geometry that silently ate it.
 *
 * Every card's text is clipped by the card, not by anything in the source, so
 * `actions.ts` only ever told you what a card was MEANT to say. Seven of the
 * eight labels were being cut mid-word ("Deposit into Vault" read "Deposit
 * into"), and the second line — which the renderer has always written — could
 * never appear at all, because a card three rows tall with a line border has
 * exactly one row of content.
 *
 * Nothing failed. It just read badly, and only on screen. Hence the width
 * assertions: they are the part a type cannot hold.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPaletteCards,
  isCardGated,
  layoutGrid,
  CATEGORY_ORDER,
} from "../../../src/tui/screens/palette-grid";
import { txBuilderConfigs } from "../../../src/tui/screens/tx-builder-configs";

/**
 * The narrowest a card's text can be.
 *
 * `layoutGrid` never returns a card narrower than `minCardW`, so the tightest
 * case is that minimum, less the line border and the one-column padding on each
 * side. The palette passes 19.
 */
const MIN_CARD_W = 19;
// Two border cells and two padding cells, then ONE more the renderer keeps
// for itself — measured, not derived. A 15-character hint word-wraps and the
// overflow is dropped, since a card has exactly one hint line, so the previous
// figure of 15 passed hints that render clipped. `scripts/palette-preview.ts`
// is what settles this: the geometry is the authority, not the arithmetic.
const CONTENT_W = MIN_CARD_W - 2 - 2 - 1;

test("no card label is wider than the narrowest card", () => {
  for (const card of buildPaletteCards("ETH")) {
    assert.ok(
      card.label.length <= CONTENT_W,
      `"${card.label}" is ${card.label.length} wide, over ${CONTENT_W} — it will be cut`,
    );
  }
});

test("no card hint is wider than the narrowest card", () => {
  for (const card of buildPaletteCards("ETH")) {
    const hint = card.hint ?? "";
    assert.ok(
      hint.length <= CONTENT_W,
      `"${hint}" is ${hint.length} wide, over ${CONTENT_W} — it will be cut`,
    );
  }
});

test("every card carries a hint — the second line is real now, not decoration", () => {
  for (const card of buildPaletteCards("ETH")) {
    assert.ok(card.hint, `${card.id} has no hint`);
  }
});

test("a label alone is ambiguous, so label plus category is what must be unique", () => {
  // Two cards read "Send" and two read "Swap"; the header above them is what
  // separates them. That only works if the pair is unique.
  const seen = new Set<string>();
  for (const card of buildPaletteCards("ETH")) {
    const key = `${card.category}/${card.label}`;
    assert.ok(!seen.has(key), `two ${card.category} cards both read "${card.label}"`);
    seen.add(key);
  }
});

test("a public token gates every action that spends the private balance", () => {
  const cards = buildPaletteCards("ETH", "public");
  const gated = cards.filter((c) => c.disabled).map((c) => c.id);
  assert.deepEqual(gated.sort(), [
    "fx-mint-close",
    // Spends the private balance twice over: the debt token AND the token sold
    // to cover the shortfall.
    "fx-mint-dust-close",
    "fx-mint-manage",
    "fx-mint-open",
    "morpho-vault-deposit",
    "morpho-vault-redeem",
    "private-swap",
    "private-transfer",
    "unshield-private-balances",
  ]);
});

test("a private token gates the public actions, and only those", () => {
  const cards = buildPaletteCards("ETH", "private");
  const gated = cards.filter((c) => c.disabled).map((c) => c.id);
  assert.deepEqual(gated.sort(), [
    "public-swap",
    "public-transfer",
    "shield-public-balances",
  ]);
});

test("the swap cards gate by their category, with no rule of their own", () => {
  // They used to live in a SWAP section that said nothing about which balance
  // they spend, so both had to be named by id in the gating rule.
  assert.equal(isCardGated({ id: "private-swap", category: "PRIVATE" }, "public"), true);
  assert.equal(isCardGated({ id: "public-swap", category: "PUBLIC" }, "private"), true);
  assert.equal(isCardGated({ id: "private-swap", category: "PRIVATE" }, "private"), false);
});

test("Other is never gated, whatever is selected", () => {
  for (const kind of ["private", "public", undefined] as const) {
    const other = buildPaletteCards("ETH", kind).find((c) => c.id === "other");
    assert.equal(other?.disabled ?? false, false);
  }
});

test("every category that has cards is laid out — an unlisted one is dropped", () => {
  const cards = buildPaletteCards("ETH");
  const used = new Set(cards.map((c) => c.category));
  for (const category of used) {
    assert.ok(
      CATEGORY_ORDER.includes(category),
      `${category} has cards but is not in CATEGORY_ORDER, so layoutGrid drops it`,
    );
  }
  const layout = layoutGrid(cards, { width: 60, minCardW: MIN_CARD_W, gap: 1, cardH: 4 });
  assert.equal(layout.cards.length, cards.length, "a card was dropped by the layout");
});

test("a card is never laid out narrower than the minimum its text was sized for", () => {
  for (const width of [60, 46, 40, 30, 22]) {
    const layout = layoutGrid(buildPaletteCards("ETH"), {
      width,
      minCardW: MIN_CARD_W,
      gap: 1,
      cardH: 4,
    });
    for (const card of layout.cards) {
      assert.ok(
        card.w >= MIN_CARD_W,
        `at pane width ${width} a card came out ${card.w} wide`,
      );
    }
  }
});

test("every openable card has a builder config under the same id", () => {
  // Missing one is a silent failure: the centre pane switches into build mode
  // and then finds nothing to build, leaving a blank pane and no message.
  for (const card of buildPaletteCards("ETH")) {
    if (card.id === "other") continue;
    assert.ok(
      txBuilderConfigs[card.id],
      `${card.id} is on the palette with no builder config`,
    );
  }
});
