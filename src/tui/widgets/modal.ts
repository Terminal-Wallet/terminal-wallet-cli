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

export const createModal = (
  blessed: any,
  screen: any,
  opts: {
    title: string;
    widthPct: number;
    height: number;
    accent?: string;
    footer?: string;
  },
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

  screen.grabKeys = true;

  // Clicking the backdrop must NOT dismiss or defocus — re-focus the modal's
  // interactive element so it keeps the keyboard. Only refocus when focus has
  // actually moved away: blessed's `screen.focused = el` always focusPush()es,
  // so calling el.focus() on the already-focused input emits a blur on itself,
  // which re-triggers the keypress-listener race and double-counts keystrokes.
  const guardFocus = (el: any) => {
    scrim.on("click", () => {
      if (screen.focused !== el) {
        el.focus();
        screen.render();
      }
    });
  };

  const close = () => {
    screen.grabKeys = false;
    box.destroy();
    scrim.destroy();
    screen.render();
  };

  return { box, scrim, guardFocus, close };
};
