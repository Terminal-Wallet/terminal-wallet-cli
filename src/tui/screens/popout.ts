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
}

const openScrollModal = (
  ctx: DeckContext,
  { title, getContent, accent, live, tags = false, copy }: ScrollModalOptions,
): void => {
  let done: () => void = () => undefined;
  const { box, guardFocus, close } = createModal(blessed, ctx.screen, {
    title,
    widthPct: 88,
    height: Math.max(8, ((ctx.screen.height as number) || 24) - 4),
    accent,
    footer: `↑/↓ · PgUp/PgDn scroll${copy ? ` · c copy ${copy.label}` : ""} · Esc close`,
    onDismiss: () => done(),
  });

  const body = blessed.box({
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
  });

  const refresh = () => body.setContent(getContent());
  refresh();
  if (live) {
    body.setScrollPerc(100);
  }

  const unsubscribe = live
    ? subscribe(() => {
        refresh();
        body.setScrollPerc(100);
        ctx.screen.render();
      })
    : undefined;

  // Unsubscribing on close is what stops a dismissed modal from redrawing
  // forever behind whatever replaced it.
  done = () => {
    unsubscribe?.();
    close();
  };

  if (copy) {
    const doCopy = () => {
      copy.run();
      getInputProvider().notify(`Copied ${copy.label}`);
    };
    // Bound on both, because focus may sit on either after a scroll.
    body.key(["c"], doCopy);
    box.key(["c"], doCopy);
  }
  body.key(["escape", "q"], done);
  box.key(["escape", "q"], done);

  guardFocus(body);
  body.focus();
  ctx.screen.render();
};

/** A static, scrollable block of already-formatted text. */
export const showText = (
  ctx: DeckContext,
  title: string,
  body: string,
  accent = "cyan",
): void =>
  openScrollModal(ctx, {
    title,
    getContent: () => body,
    accent,
    live: false,
    tags: true,
  });

/** The engine and SDK log stream, live. */
export const showLogs = (ctx: DeckContext): void =>
  openScrollModal(ctx, {
    title: "logs · engine + SDK (live)",
    getContent: () => getState().logs.join("\n") || "…",
    accent: "yellow",
    live: true,
  });

/** Everything known about one transaction. */
export const showTxReview = (
  ctx: DeckContext,
  item: CoreHistoryItem,
): void =>
  openScrollModal(ctx, {
    title: `transaction · ${item.category}`,
    getContent: () => txReviewBody(item, getState().network as NetworkName),
    accent: "cyan",
    live: false,
    tags: true,
    copy: { label: "tx id", run: () => copyToClipboard(item.txid) },
  });
