/**
 * Full-height scrollable modals: the live log stream, and a transaction review.
 *
 * One implementation serves both because they differ only in whether the
 * content changes underneath them. A live modal re-reads on every store change
 * and pins to the bottom; a static one is rendered once.
 */
import blessed from "blessed";
import { NetworkName } from "@railgun-community/shared-models";
import { DeckContext } from "../context";
import { createModal } from "../widgets/modal";
import { copyToClipboard } from "../widgets/clipboard";
import { txReviewBody } from "../format/tx-review";
import { getState, subscribe } from "../store";
import { getInputProvider } from "../../core/input";
import { CoreHistoryItem } from "../../core/history";

interface ScrollModalOptions {
  title: string;
  getContent: () => string;
  accent: string;
  /** Re-read on every store change and stay pinned to the bottom. */
  live: boolean;
  /** Whether the content carries blessed markup. Raw text must say false. */
  tags?: boolean;
  copy?: { label: string; run: () => void };
  /**
   * Render as a list of selectable lines rather than a block of text, so a
   * single line can be read against a cursor and copied on its own.
   */
  selectable?: boolean;
}

/**
 * Resolves when the modal closes.
 *
 * A caller in a menu loop has to be able to wait: the ephemeral console opened
 * its history this way, got a void back, looped, and drew its own menu on top
 * of the popup it had just opened — which then had to be closed twice, in the
 * wrong order.
 */
const openScrollModal = (
  ctx: DeckContext,
  {
    title,
    getContent,
    accent,
    live,
    tags = false,
    copy,
    selectable = false,
  }: ScrollModalOptions,
): Promise<void> =>
  new Promise<void>((resolveClosed) => {
  let done: () => void = () => undefined;
  const footer = selectable
    ? "↑/↓ select · c copy line · a copy all · Esc close"
    : `↑/↓ · PgUp/PgDn scroll${copy ? ` · c copy ${copy.label}` : ""} · Esc close`;
  const { box, guardFocus, close } = createModal(blessed, ctx.screen, {
    title,
    widthPct: 88,
    maxWidth: 160, // a panel, not a dialog — see modalWidth
    height: Math.max(8, ((ctx.screen.height as number) || 24) - 4),
    accent,
    footer,
    onDismiss: () => done(),
  });

  const shared = {
    parent: box,
    top: 0,
    left: 0,
    right: 0,
    bottom: 1,
    tags,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
    vi: true,
    scrollbar: { ch: " ", style: { bg: "green" } },
  } as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: any = selectable
    ? blessed.list({
        ...shared,
        items: [],
        style: { selected: { bg: accent, fg: "black" } },
      })
    : blessed.box(shared);

  const lines = (): string[] => getContent().split("\n");

  /**
   * Follow the tail only while the cursor is already on the last line. Once
   * someone has scrolled up to read something, dragging them back to the
   * bottom on every arriving line is what made this pane unusable.
   */
  const atTail = (): boolean =>
    body.items === undefined || body.selected >= body.items.length - 1;

  const refresh = () => {
    if (!selectable) {
      body.setContent(getContent());
      return;
    }
    const follow = atTail();
    const previous = body.selected ?? 0;
    const next = lines();
    body.setItems(next);
    body.select(follow ? next.length - 1 : Math.min(previous, next.length - 1));
  };

  refresh();
  if (live && !selectable) {
    body.setScrollPerc(100);
  }

  const unsubscribe = live
    ? subscribe(() => {
        const follow = atTail();
        refresh();
        if (!selectable && follow) body.setScrollPerc(100);
        ctx.screen.render();
      })
    : undefined;

  // Unsubscribing on close is what stops a dismissed modal from redrawing
  // forever behind whatever replaced it.
  done = () => {
    unsubscribe?.();
    close();
    resolveClosed();
  };

  if (selectable) {
    const copyLine = () => {
      const line = lines()[body.selected ?? 0];
      if (line === undefined) return;
      copyToClipboard(line);
      getInputProvider().notify("Copied line");
    };
    const copyAll = () => {
      copyToClipboard(getContent());
      getInputProvider().notify(`Copied ${lines().length} lines`);
    };
    // Bound on both, because focus may sit on either after a scroll.
    for (const target of [body, box]) {
      target.key(["c"], copyLine);
      target.key(["a"], copyAll);
    }
  } else if (copy) {
    const doCopy = () => {
      copy.run();
      getInputProvider().notify(`Copied ${copy.label}`);
    };
    body.key(["c"], doCopy);
    box.key(["c"], doCopy);
  }
  body.key(["escape", "q"], done);
  box.key(["escape", "q"], done);

  guardFocus(body);
  body.focus();
  ctx.screen.render();
  });

/** A static, scrollable block of already-formatted text. */
export const showText = (
  ctx: DeckContext,
  title: string,
  body: string,
  accent = "cyan",
): Promise<void> =>
  openScrollModal(ctx, {
    title,
    getContent: () => body,
    accent,
    live: false,
    tags: true,
  });

/** The engine and SDK log stream, live. */
export const showLogs = (ctx: DeckContext): Promise<void> =>
  openScrollModal(ctx, {
    title: "logs · engine + SDK + status (live)",
    getContent: () => getState().logs.join("\n") || "…",
    accent: "yellow",
    live: true,
    selectable: true,
  });

/** Everything known about one transaction. */
export const showTxReview = (
  ctx: DeckContext,
  item: CoreHistoryItem,
): Promise<void> =>
  openScrollModal(ctx, {
    title: `transaction · ${item.category}`,
    getContent: () => txReviewBody(item, getState().network as NetworkName),
    accent: "cyan",
    live: false,
    tags: true,
    copy: { label: "tx id", run: () => copyToClipboard(item.txid) },
  });
