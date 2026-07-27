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
  let elements: { id: string; el: blessed.Widgets.BoxElement }[] = [];

  const clear = () => {
    for (const e of elements) e.el.destroy();
    elements = [];
  };

  const isDisabled = (id: string): boolean =>
    !!layout?.cards.find((c) => c.id === id)?.disabled;

  /** Two lines: the action, and what kind of action it is. */
  const face = (card: LaidCard): string => {
    const kind =
      card.category === "PRIVATE"
        ? "private"
        : card.category === "PUBLIC"
          ? "public"
          : card.category === "SWAP"
            ? "0x swap"
            : "cookbook";
    return card.disabled
      ? `${tag(card.label, "gray")}\n${tag("unavailable", "gray")}`
      : `${tag(card.label, "white")}\n${tag(kind, "gray")}`;
  };

  const highlight = () => {
    for (const e of elements) {
      if (e.id.startsWith("__h_")) continue;
      const disabled = isDisabled(e.id);
      const selected = e.id === cursor && !disabled;
      e.el.style.border.fg = disabled ? "gray" : selected ? "cyan" : "gray";
      // Cyan on black, which is what selection looks like everywhere else in
      // the deck — the portfolio rail's row, the stepper's current step. The
      // blue this used to be matched nothing and read as a different kind of
      // state.
      e.el.style.bg = selected ? "cyan" : undefined;
      e.el.style.fg = selected ? "black" : undefined;
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
        style: {
          border: { fg: "gray" },
          hover: { border: { fg: card.disabled ? "gray" : "cyan" } },
        },
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
      elements.push({ id: card.id, el });
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
