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
import { ensureFocus } from "../widgets/focus-guard";
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
  /** Rows of the box the grid can actually show — set when the grid is laid. */
  let viewport = 0;
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

  /**
   * A card's two lines: the verb, and what it does to your money.
   *
   * The second line used to name the category, which the header directly above
   * the card already says — and it never appeared anyway, because a card three
   * rows tall with a line border has exactly one row of content. Cards are four
   * rows now and the line carries the action's own hint.
   *
   * The cursor is the FILL behind the text, not a colour in it. A block of
   * colour reads instantly across a grid; green, on black text, because blue
   * and cyan both looked washed out on a solid background.
   */
  const face = (card: LaidCard, selected = false): string => {
    if (card.disabled) {
      return `${tag(card.label, "gray")}\n${tag("unavailable", "gray")}`;
    }
    // Black on the fill, or the label sits white-on-green and reads as
    // washed out; the hint follows it rather than staying dim-on-bright.
    const label = selected
      ? `{bold}${tag(card.label, "black")}{/bold}`
      : tag(card.label, "white");
    return `${label}\n${tag(card.hint ?? "", selected ? "black" : "gray")}`;
  };

  /**
   * Keep the cursor's card on screen.
   *
   * Only a pane too small for the whole grid scrolls at all, and there the
   * arrow keys move the cursor rather than the view — so a card below the fold
   * would be selectable, invisible, and impossible to tell apart from one that
   * is simply not there.
   */
  const scrollToCursor = () => {
    if (!layout || layout.height <= viewport) return;
    const card = layout.cards.find((c) => c.id === cursor);
    if (!card) return;
    const top = (box as unknown as { childBase: number }).childBase ?? 0;
    // The header sits one row above the card, and it names what the card is.
    const wanted = Math.max(0, card.y - 1);
    const next =
      wanted < top
        ? wanted
        : card.y + card.h > top + viewport
          ? card.y + card.h - viewport
          : top;
    if (next !== top) {
      (box as unknown as { scrollTo: (n: number) => void }).scrollTo(next);
    }
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
    // The cards are appended to `box`, which is scrollable in a short pane —
    // and appending into a scrollable parent with nothing focused throws from
    // inside blessed's Element constructor.
    ensureFocus(ctx.screen, box);
    const innerWidth = Math.max(18, ((box.width as number) || 60) - 4);
    const { kind } = host.seeded();
    const cards = buildPaletteCards(getState().baseSymbol, kind);

    // Keep the cursor somewhere usable: the previously selected card may have
    // been gated out by whatever token is now seeded.
    const enabled = cards.filter((c) => !c.disabled);
    if (!cursor || !enabled.some((c) => c.id === cursor)) {
      cursor = enabled[0]?.id ?? cards[0]?.id ?? "";
    }

    // Four rows a card is one for the label and one for the hint. In a short
    // pane that does not fit, and the grid used to simply draw past the bottom
    // of the box — cards rendered over the border, and the last category was on
    // screen but unreachable. Drop the hint line first, since which flows exist
    // is what the grid is for; if even that does not fit — a narrow pane
    // collapses to one column — let the box scroll rather than lose a card.
    const available = Math.max(
      1,
      ((box.height as number) || 24) - ((box.iheight as number) || 0),
    );
    const grid = (cardH: number) =>
      layoutGrid(cards, { width: innerWidth, minCardW: 19, gap: 1, cardH });
    layout = grid(4);
    if (layout.height > available) layout = grid(3);
    // `scrollable` is a real property on every blessed element; the typings
    // only admit it as a constructor option.
    (box as unknown as { scrollable: boolean }).scrollable =
      layout.height > available;
    viewport = available;

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
        autoFocus: false, // a button triggers; it must never hold the keys
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

    scrollToCursor();
    highlight();
  };

  const move = (direction: "left" | "right" | "up" | "down") => {
    if (!layout) return;
    cursor = gridNav(layout.rows, cursor, direction, isDisabled);
    scrollToCursor();
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
