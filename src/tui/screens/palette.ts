/**
 * The command palette — a grid of action cards in the centre pane.
 *
 * A grid rather than a filtered list because the actions are few, fixed, and
 * worth seeing all at once: which flows exist is itself information, and a card
 * that is greyed out tells you why you cannot do the thing you were reaching
 * for.
 *
 * Gating comes from the selected token. Choosing a private balance and then a
 * public action is a mistake the grid can refuse in advance rather than letting
 * it fail three steps later inside a builder.
 *
 * The factory owns the cards it creates and destroys them on close — leaving
 * them parented to a hidden box would keep them taking keypresses.
 */
import blessed from "blessed";
import { DeckContext } from "../context";
import { getState } from "../store";
import { tag } from "../format/tags";
import { getInputProvider } from "../../core/input";
import {
  buildPaletteCards,
  layoutGrid,
  gridNav,
  LaidCard,
  PaletteLayout,
  TokenKind,
} from "./palette-grid";
import { listCookbookRecipes } from "./cookbook-recipes";
import { RailgunDisplayBalance } from "../../models/balance-models";

export interface PaletteHost {
  ctx: DeckContext;
  /** The box the grid is drawn into. */
  box: blessed.Widgets.BoxElement;
  /** The token currently seeded from the portfolio rail, if any. */
  seeded: () => { token?: RailgunDisplayBalance; kind?: TokenKind };
  /** Run the chosen flow. The palette closes itself first. */
  onSelect: (flowId: string, seed?: RailgunDisplayBalance) => void;
  /** Called when the palette closes so the host can restore the centre pane. */
  onClose: () => void;
}

export interface Palette {
  open: () => void;
  close: () => void;
  /** Re-lay the grid — after a resize, or when the seeded token changes. */
  rebuild: () => void;
}

export const createPalette = (host: PaletteHost): Palette => {
  const { ctx, box } = host;
  let layout: PaletteLayout | undefined;
  let cursor = "";
  let elements: {
    id: string;
    el: blessed.Widgets.BoxElement;
    /** Kept so the cursor can be drawn INTO the card's text, not just around it. */
    card?: LaidCard;
  }[] = [];

  const clear = () => {
    for (const e of elements) e.el.destroy();
    elements = [];
  };

  const isDisabled = (id: string): boolean =>
    !!layout?.cards.find((c) => c.id === id)?.disabled;

  /** Two lines: the action, and what kind of action it is. */
  /**
   * A card's text. The cursor is the FILL behind it, not a colour in it.
   *
   * A block of colour is the right signal here — it reads instantly across a
   * grid. Green, on black text: blue was the original and looked wrong on a
   * solid background, and cyan was no better.
   */
  const face = (card: LaidCard, selected = false): string => {
    const kind =
      card.category === "PRIVATE"
        ? "private"
        : card.category === "PUBLIC"
          ? "public"
          : card.category === "SWAP"
            ? "0x swap"
            : card.category === "DEFI"
              ? "morpho"
              : "cookbook";
    if (card.disabled) {
      return `${tag(card.label, "gray")}\n${tag("unavailable", "gray")}`;
    }
    // Black on the fill, or the label sits white-on-green and reads as
    // washed out; the sub-label follows it rather than staying dim-on-bright.
    const label = selected
      ? `{bold}${tag(card.label, "black")}{/bold}`
      : tag(card.label, "white");
    return `${label}\n${tag(kind, selected ? "black" : "gray")}`;
  };

  const highlight = () => {
    for (const e of elements) {
      if (e.id.startsWith("__h_")) continue;
      const disabled = isDisabled(e.id);
      const selected = e.id === cursor && !disabled;
      // The border carries it, not a fill. These cards are large, and a solid
      // background on one is a lot of colour to say "the cursor is here" —
      // which is all it means. Bold picks the text up with it.
      e.el.style.border.fg = disabled ? "gray" : selected ? "cyan" : "gray";
      // The fill is the highlight; the border says which one Enter takes.
      e.el.style.bg = selected ? "green" : undefined;
      if (e.card) e.el.setContent(face(e.card, selected));
    }
  };

  /** The cookbook extension point. Nothing is wired to it yet, and it says so. */
  const openOther = async () => {
    const recipes = listCookbookRecipes();
    if (!recipes.length) {
      getInputProvider().notify("Cookbook integrations — coming soon.");
      return;
    }
    const choice = await getInputProvider().select(
      "Other — cookbook recipes",
      recipes.map((r) => ({
        label: r.label,
        value: r.id,
        hint: r.available ? r.hint : "coming soon",
      })),
    );
    if (!choice) return;
    const recipe = recipes.find((r) => r.id === choice);
    if (recipe && !recipe.available) {
      getInputProvider().notify(`${recipe.label} — coming soon.`);
    }
  };

  const close = () => {
    box.hide();
    clear();
    host.onClose();
  };

  const select = () => {
    if (!cursor) return;
    if (isDisabled(cursor)) {
      // Say why, rather than doing nothing and looking broken.
      const { kind } = host.seeded();
      const other = kind === "private" ? "public" : "private";
      getInputProvider().notify(
        `That action needs a ${other} token — a ${kind ?? "different"} token is selected.`,
      );
      return;
    }
    if (cursor === "other") {
      void openOther();
      return;
    }
    // Closed before the flow starts, not after. Whatever runs next owns the
    // centre pane, and cards left alive under it would still take keypresses.
    const { token } = host.seeded();
    close();
    host.onSelect(cursor, token);
  };


  const rebuild = () => {
    clear();
    const innerWidth = Math.max(18, ((box.width as number) || 60) - 4);
    const { kind } = host.seeded();
    const cards = buildPaletteCards(getState().baseSymbol, kind);

    // Keep the cursor somewhere usable: the previously selected card may have
    // been gated out by whatever token is now seeded.
    const enabled = cards.filter((c) => !c.disabled);
    if (!cursor || !enabled.some((c) => c.id === cursor)) {
      cursor = enabled[0]?.id ?? cards[0]?.id ?? "";
    }

    layout = layoutGrid(cards, {
      width: innerWidth,
      minCardW: 18,
      gap: 1,
      cardH: 3,
    });

    for (const header of layout.headers) {
      elements.push({
        id: `__h_${header.category}`,
        el: blessed.box({
          parent: box,
          top: header.y,
          left: 0,
          height: 1,
          width: innerWidth,
          tags: true,
          content: tag(header.label, "cyan"),
        }),
      });
    }

    for (const card of layout.cards) {
      const el = blessed.box({
        parent: box,
        top: card.y,
        left: card.x,
        width: card.w,
        height: card.h,
        tags: true,
        mouse: true,
        clickable: true,
        border: { type: "line" },
        padding: { left: 1, right: 1 },
        // No hover style: `mouseover` below moves the CURSOR onto the card,
        // and `highlight` styles the cursor. Having both meant two different
        // rules painting the same card for the same reason, and the mouse one
        // could not tell you which card Enter would actually take.
        style: { border: { fg: "gray" } },
        content: face(card),
      });
      el.on("click", () => {
        cursor = card.id;
        select();
      });
      el.on("mouseover", () => {
        if (isDisabled(card.id)) return;
        cursor = card.id;
        highlight();
        ctx.screen.render();
      });
      elements.push({ id: card.id, el, card });
    }

    highlight();
  };

  const move = (direction: "left" | "right" | "up" | "down") => {
    if (!layout) return;
    cursor = gridNav(layout.rows, cursor, direction, isDisabled);
    highlight();
    ctx.screen.render();
  };

  box.key(["left", "h"], () => move("left"));
  box.key(["right", "l"], () => move("right"));
  box.key(["up", "k"], () => move("up"));
  box.key(["down", "j"], () => move("down"));
  box.key(["enter"], () => select());
  box.key(["escape"], () => close());

  return {
    open: () => {
      box.show();
      rebuild();
      box.focus();
      ctx.render();
    },
    close,
    rebuild,
  };
};
