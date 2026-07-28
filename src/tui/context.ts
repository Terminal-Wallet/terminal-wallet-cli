/**
 * The handle a screen gets from the deck.
 *
 * Screens need four things from their host: somewhere to mount, a way to ask for
 * a redraw, and a way to say "this changed, go and re-read it". Previously they
 * simply closed over the deck's module scope and called its internals directly,
 * which is why none of them could be moved out of a single 1,900-line file, and
 * why none could be opened in a test.
 *
 * Deliberately small. Everything a screen needs to READ it reads from the store,
 * which the adapter keeps current from the core bus; this is only the things a
 * screen needs to CAUSE. Adding to it should feel like a decision, not a
 * convenience — a wide context is the same coupling with extra steps.
 */
import type blessed from "blessed";

export interface DeckContext {
  /** Where screens mount. */
  screen: blessed.Widgets.Screen;

  /** Redraw from current state. Safe to call from anywhere, cheap if nothing changed. */
  render: () => void;

  /**
   * Re-announce wallet, network and broadcaster identity on the core bus.
   * Call after anything that changes which wallet or chain is active.
   */
  refreshIdentity: () => void;

  /**
   * Hand over to a transaction flow, by builder-config id.
   *
   * Here because a screen that has found something to act on should not build
   * its own review-and-send: the builder owns the gates — completeness,
   * overspend, a review that IS the confirmation, and a fresh password — and a
   * screen driving its own modals over its own list gets the focus and the
   * escape key wrong. The caller closes itself first; whatever runs next owns
   * the centre pane.
   */
  openFlow: (flowId: string) => void;

  /**
   * Re-read balances and prices and publish them. Call after a send, a scan, or
   * a chain switch — anything that can have moved funds.
   */
  refreshBalances: () => Promise<void>;

  /**
   * Re-read gas, block height and merkletree heights. These have no event to
   * ride on, so the deck polls them; a screen that has just caused a rescan can
   * ask for a fresh read rather than waiting for the next tick.
   */
  refreshChainStats: () => Promise<void>;

  /**
   * Re-read the activity feed.
   *
   * On the context rather than called directly because resolving the current
   * wallet and chain means reaching for engine globals that throw before boot —
   * which is precisely the coupling this interface exists to remove. The deck
   * knows what is active; a screen only knows it made something stale.
   */
  refreshHistory: () => Promise<void>;
}

/**
 * A screen: given the deck handle, present itself and resolve when dismissed.
 *
 * Screens do not return values. A screen that produces something does it by
 * causing — running a transaction, writing the keychain — and the result comes
 * back through the store like any other state change, so nothing has to thread
 * a return value back up through the deck.
 */
export type Screen = (ctx: DeckContext) => Promise<void>;
