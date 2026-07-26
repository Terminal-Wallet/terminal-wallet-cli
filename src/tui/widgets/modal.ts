/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Shared modal chrome for blessed dialogs. The important part is the SCRIM: a
 * full-screen backdrop created just under the modal (above the dashboard) so
 *  - clicks outside the modal hit the scrim, never the dashboard underneath
 *    (no click-through, the modal can't lose focus to a stray click), and
 *  - the very click that OPENED the modal (on a menu button below) lands on the
 *    scrim too, instead of bleeding onto the modal's list/button as an
 *    accidental submit.
 * No timers are involved (purely z-order), so this is deterministic and testable.
 *
 * Modals are also given a MAX width so they stay centered and reasonably sized
 * on very wide terminals instead of stretching edge-to-edge.
 */
export const MAX_MODAL_WIDTH = 72;
export const MIN_MODAL_WIDTH = 40;

/** Modal width in columns: `pct` of the screen, clamped to [MIN, MAX]. */
export const modalWidth = (screen: any, pct: number): number => {
  const cols = (screen.width as number) || 80;
  return Math.max(
    MIN_MODAL_WIDTH,
    Math.min(Math.floor((cols * pct) / 100), MAX_MODAL_WIDTH),
  );
};

export interface ModalChrome {
  box: any;
  scrim: any;
  /** Re-assert modal focus after an outside (scrim) click. */
  guardFocus: (el: any) => void;
  close: () => void;
}

export interface ModalOptions {
  title: string;
  widthPct: number;
  height: number;
  accent?: string;
  footer?: string;
  /**
   * The caller's cancel path — what the [x] button and an outside click do.
   *
   * Required for those to work at all: the chrome can destroy its widgets but
   * has no idea how the caller resolves, and closing without resolving would
   * hang the promise behind the modal. Without it the modal keeps the older
   * behaviour of refusing to be dismissed by a stray click.
   */
  onDismiss?: () => void;
  /**
   * Only the explicit buttons get out — an outside click is ignored. For the
   * password prompt, where a stray click while confirming a spend is the most
   * expensive click in the app. The [x] still works; it is unambiguous.
   */
  hardened?: boolean;
}

/** How many modals are currently up. See the grab in `createModal`. */
let openModals = 0;

/** For tests and teardown — the count is process-wide, like `screen.grabKeys`. */
export const openModalCount = (): number => openModals;

export const createModal = (
  blessed: any,
  screen: any,
  opts: ModalOptions,
): ModalChrome => {
  const accent = opts.accent ?? "cyan";

  // Backdrop — created BEFORE the modal box so it sits just below it in z-order
  // (above the dashboard). Captures every click outside the modal rectangle.
  const scrim = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    mouse: true,
    clickable: true,
    // CRITICAL: blessed autofocuses any clickable element on click (screen's
    // global "element click" handler). Without autoFocus:false, a scrim click
    // steals focus from the modal's textbox, emitting a blur. blessed attaches
    // a textbox's keypress listener on nextTick but removes it synchronously on
    // blur — so a blur racing the deferred attach leaves an unremovable zombie
    // keypress listener, and every later keystroke registers twice. Keeping the
    // scrim non-focusable means stray clicks never blur the input.
    autoFocus: false,
    style: { bg: "black" },
  });

  const box = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: modalWidth(screen, opts.widthPct),
    height: opts.height,
    border: { type: "line" },
    label: ` ${opts.title} `,
    tags: true,
    shadow: true,
    padding: { left: 1, right: 1 },
    style: { border: { fg: accent }, label: { fg: accent } },
  });

  if (opts.footer) {
    blessed.text({
      parent: box,
      bottom: 0,
      left: 1,
      right: 1,
      tags: true,
      content: `{gray-fg}${opts.footer}{/}`,
    });
  }

  // Counted rather than set, because modals nest: a notify over a select, a
  // review over a menu. Releasing the grab when the inner one closes would hand
  // the deck's global keys back while a modal was still up, so `q` would quit
  // the app from inside a dialog.
  openModals += 1;
  screen.grabKeys = true;

  let closed = false;
  const close = () => {
    if (closed) return; // a double close would decrement for a modal already gone
    closed = true;
    openModals = Math.max(0, openModals - 1);
    if (openModals === 0) screen.grabKeys = false;
    box.destroy();
    scrim.destroy();
    screen.render();
  };

  const dismissable = typeof opts.onDismiss === "function";
  const dismiss = () => opts.onDismiss?.();

  // An [x] on the border, beside the label. Always available, on every modal
  // including the hardened one — an explicit close is never the wrong answer,
  // and "how do I get out of this" should not require knowing a key.
  //
  // autoFocus:false for the same reason the scrim has it: clicking a focusable
  // element blurs whatever had focus, and a blur on a reading textbox cancels
  // its read. The close button must not disturb the field it is closing.
  if (dismissable) {
    const closeButton = blessed.box({
      parent: box,
      top: -1,
      right: 0,
      width: 3,
      height: 1,
      tags: true,
      mouse: true,
      clickable: true,
      autoFocus: false,
      content: `{${accent}-fg}[x]{/}`,
      style: { hover: { bg: "red", fg: "white" } },
    });
    closeButton.on("click", dismiss);
  }

  // Outside-click dismissal, armed on a full press AND release over the scrim.
  //
  // A plain "click" would fire for the very click that OPENED this modal: that
  // press landed on a button below, before the scrim existed, but the release
  // arrives after — and blessed reports the release as a click on whatever is
  // now on top. Requiring both halves means an opening click can never dismiss,
  // with no timer and nothing to tune.
  if (dismissable && !opts.hardened) {
    let pressed = false;
    scrim.on("mousedown", () => {
      pressed = true;
    });
    scrim.on("mouseup", () => {
      if (!pressed) return;
      pressed = false;
      dismiss();
    });
  }

  // Kept for the hardened modal, which stays up and takes its focus back rather
  // than being dismissed. Only refocus when focus has actually moved away:
  // blessed's `screen.focused = el` always focusPush()es, so calling el.focus()
  // on the already-focused input emits a blur on itself, which re-triggers the
  // keypress-listener race and double-counts keystrokes.
  const guardFocus = (el: any) => {
    if (dismissable && !opts.hardened) return;
    scrim.on("click", () => {
      if (screen.focused !== el) {
        el.focus();
        screen.render();
      }
    });
  };

  return { box, scrim, guardFocus, close };
};
