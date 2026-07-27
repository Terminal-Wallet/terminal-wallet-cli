/**
 * Never let the screen end up with nothing focused.
 *
 * blessed's Element constructor calls Node before it sets `this.position`, and
 * Node.insert does `if (!screen.focused) screen.focused = element`. That setter
 * runs Screen._focus, which — ONLY when the new element has a scrollable
 * ancestor — reads `element.rtop`, and so `element.position.top`, which does
 * not exist yet. The element is mid-construction.
 *
 * So creating a child of a scrollable box while nothing is focused throws
 * `Cannot read properties of undefined (reading 'top')` from inside blessed,
 * with a stack that names none of our code.
 *
 * Focus empties on its own: shrinking the terminal hides the rails, and
 * `rewindFocus` pops through the history skipping anything not visible. Hide
 * everything that was focused and the history runs out.
 *
 * The guard is to keep something visible focused. It cannot be fixed at the
 * append site, because by then the element is already half-built.
 */
import type blessed from "blessed";

type FocusableScreen = blessed.Widgets.Screen & {
  focused?: blessed.Widgets.BlessedElement;
};

/**
 * Focus `fallback` if nothing is focused.
 *
 * `fallback` must be fully constructed and visible — an element that is itself
 * mid-construction, or hidden, would leave the history empty again.
 */
export const ensureFocus = (
  screen: blessed.Widgets.Screen,
  fallback: blessed.Widgets.BlessedElement | undefined,
): void => {
  if (!fallback) return;
  if ((screen as FocusableScreen).focused) return;
  try {
    fallback.focus();
  } catch {
    // A fallback that cannot take focus is not worth crashing over; the caller
    // is about to draw either way.
  }
};
