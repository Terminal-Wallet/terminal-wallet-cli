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

/**
 * Modal width in columns: `pct` of the screen, clamped to [MIN, max].
 *
 * The default cap keeps DIALOGS from stretching edge-to-edge on a wide
 * terminal. A data panel is a different thing — a list of accounts or a log
 * wants the room — and capping those at 72 silently truncated their footers,
 * which is how the ephemeral console's actions came to look absent.
 */
export const modalWidth = (
  screen: any,
  pct: number,
  max = MAX_MODAL_WIDTH,
): number => {
  const cols = (screen.width as number) || 80;
  return Math.max(MIN_MODAL_WIDTH, Math.min(Math.floor((cols * pct) / 100), max));
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
   * Override the dialog width cap. For panels whose content is a table or a
   * list, where the cap costs readability rather than buying it.
   */
  maxWidth?: number;
  /**
   * Only the explicit buttons get out — an outside click is ignored. For the
   * password prompt, where a stray click while confirming a spend is the most
   * expensive click in the app. The [x] still works; it is unambiguous.
   */
  hardened?: boolean;
}

interface OpenModal {
  dismiss: () => void;
  hardened: boolean;
}

/**
 * Blessed key names for a shifted letter.
 *
 * `key.full` is assembled as `(ctrl?"C-")+(meta?"M-")+(shift?"S-")+name`, and
 * `name` is lowercased first — so shift+S arrives as `S-s`, and a binding on
 * `"S"` can never fire. Every capital-letter binding in the app was dead.
 */
export const shifted = (letter: string): string[] => [
  letter,
  `S-${letter.toLowerCase()}`,
];

/** Innermost last. See the grab and the Escape handler in `createModal`. */
const stack: OpenModal[] = [];

/** For tests and teardown — the stack is process-wide, like `screen.grabKeys`. */
export const openModalCount = (): number => stack.length;

/**
 * Escape, bound once per screen rather than per modal.
 *
 * Binding it on the modal's own list only works while that list holds focus,
 * and anything underneath that takes focus back — a rail, a relayout — leaves
 * the dialog with no keyboard way out. [x] kept working because a click does
 * not need focus, which is exactly the shape of the bug reported: "only the
 * [x] closes it, Esc no longer does".
 *
 * A screen-level `key` handler is normally silent while a modal is up, since
 * modals set `screen.grabKeys`. `ignoreLocked` is blessed's exemption list for
 * precisely this: keys on it are emitted at screen level even under a grab.
 */
const installEscape = (screen: any): void => {
  if (screen.__modalEscapeInstalled) return;
  screen.__modalEscapeInstalled = true;
  if (!screen.ignoreLocked.includes("escape")) screen.ignoreLocked.push("escape");
  screen.key(["escape"], () => {
    const top = stack[stack.length - 1];
    if (!top || top.hardened) return;
    // A field mid-read owns Escape: it cancels the entry, not the dialog
    // around it. Dismissing here would throw away the form as well.
    if ((screen.focused as any)?._reading) return;
    top.dismiss();
  });
};

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
    width: modalWidth(screen, opts.widthPct, opts.maxWidth),
    height: opts.height,
    border: { type: "line" },
    label: ` ${opts.title} `,
    tags: true,
    shadow: true,
    padding: { left: 1, right: 1 },
    style: { border: { fg: accent }, label: { fg: accent } },
    // The chrome takes clicks so the scrim underneath does not: screen.js
    // breaks after the topmost clickable, so an unclickable box let a click on
    // the title reach the scrim and dismiss the modal.
    mouse: true,
    clickable: true,
    // CRITICAL, and the reason arrow keys died after clicking a modal's title.
    // blessed autofocuses any clickable element on click:
    //
    //   screen.on('element click', el => {
    //     if (el.clickable === true && el.options.autoFocus !== false) el.focus();
    //   })
    //
    // A plain box takes focus happily and has no key handlers, so focus landed
    // on the chrome and every arrow key went nowhere — with nothing on screen
    // to say why. It runs AFTER the element's own click listeners, so a caller
    // refocusing its list from `box.on("click")` was overridden a moment later
    // and the workaround looked like it worked.
    autoFocus: false,
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

  const dismissable = typeof opts.onDismiss === "function";
  const dismiss = () => opts.onDismiss?.();

  // Stacked rather than counted, because modals nest — a notify over a select,
  // a review over a menu — and Escape has to reach the innermost one. Releasing
  // the grab when an inner modal closes would also hand the deck's global keys
  // back while an outer one was still up, so `q` would quit from inside it.
  const entry: OpenModal = { dismiss, hardened: opts.hardened === true };
  stack.push(entry);
  screen.grabKeys = true;
  installEscape(screen);

  // Whatever had focus before this opened. Modals stack — a balances popup over
  // the account list, a review over a menu — and closing the inner one used to
  // leave focus nowhere, so the list underneath stopped taking arrow keys and
  // its own shortcuts did nothing. The screen still looked right, which is what
  // made it read as "the key did nothing" rather than "focus is gone".
  const focusBefore = screen.focused;

  let closed = false;
  const close = () => {
    if (closed) return; // a double close would pop a modal already gone
    closed = true;
    const at = stack.indexOf(entry);
    if (at >= 0) stack.splice(at, 1);
    if (stack.length === 0) screen.grabKeys = false;
    box.destroy();
    scrim.destroy();
    // Hand focus back, if the element is still around to take it. Destroying
    // the modal does not restore it: blessed's focus history holds the dead
    // element, so the caller is left with a screen it cannot drive.
    if (focusBefore && !focusBefore.detached && focusBefore !== box) {
      focusBefore.focus();
    }
    screen.render();
  };

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
    // THE OPENING CLICK IS STILL BEING DISPATCHED.
    //
    // A modal opened from a click — a deck card, a palette tile, a button —
    // runs inside that element's click handler. blessed emits 'element click'
    // AFTER the handler returns and autofocuses whatever was clicked, so the
    // card takes the keys back the instant the modal appears: it draws, it
    // looks focused, and the arrows go to the deck underneath. Modals opened
    // from a keypress were fine, which is what made it look like only some
    // dialogs were broken.
    //
    // Every such element now passes autoFocus:false. This re-assert is the
    // backstop for the next one that forgets, since the symptom is silent.
    setImmediate(() => {
      if (!box.detached && screen.focused !== el) {
        el.focus();
        screen.render();
      }
    });
    // Clicking the modal's own chrome — border, title, footer, empty space — is
    // not an answer to anything it asked. Whatever owns the keys keeps them, so
    // the arrows still work afterwards. This half applies to EVERY modal: a
    // dismissable one is dismissed by clicking OUTSIDE, never by clicking
    // itself.
    box.on("click", () => {
      if (screen.focused !== el) {
        el.focus();
        screen.render();
      }
    });
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
