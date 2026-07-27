/**
 * The deck's responsive layout.
 *
 * Three tiers by width: both rails, the portfolio rail only, or neither. The
 * rule that drives all of it is that the centre pane is protected — a rail goes
 * inline only if what remains is still wide enough to compose a transaction in.
 * Below that it becomes an overlay you peek at, because a builder squeezed into
 * twenty columns is worse than one you have to toggle a panel away from.
 *
 * Pure geometry: it takes the terminal size and what the user has asked to see,
 * and returns where everything goes. No widgets, so the awkward cases — the
 * boundaries between tiers, the overlay fallback — can be asserted directly.
 */

export type Tier = "wide" | "medium" | "narrow";

export const LEFT_W = 44;
// Wider than it was by a few columns: the rail carries only activity now, and
// a transaction row was losing its amount to the ellipsis.
export const RIGHT_W = 33;
/** The builder and home pane must always have at least this much. */
export const MIN_CENTER = 46;
export const MIN_W = 50;
/** title + identity + cards + work area + footer */
export const MIN_H = 18;
export const CARD_H = 5;
export const CARD_TOP = 2;
/** The work area starts below the title, identity bar and cards. */
export const TOP = CARD_TOP + CARD_H;

export const tierFor = (width: number): Tier =>
  width >= LEFT_W + RIGHT_W + MIN_CENTER
    ? "wide"
    : width >= LEFT_W + MIN_CENTER
      ? "medium"
      : "narrow";

export interface LayoutRequest {
  width: number;
  height: number;
  /** Whether the user currently wants each rail shown. */
  wantLeft: boolean;
  wantRight: boolean;
}

export interface Layout {
  /** Terminal is unusably small; show the resize notice instead. */
  tooSmall: boolean;
  tier: Tier;
  /** Left inset of the centre pane — 0 when the rail is hidden or overlaid. */
  centerLeft: number;
  /** Right inset of the centre pane. */
  centerRight: number;
  /** A rail that did not fit inline and is drawn over the centre instead. */
  leftOverlay: boolean;
  rightOverlay: boolean;
  /** How many status cards fit, excluding the utilities card which always shows. */
  statusCards: number;
}

export const computeLayout = ({
  width,
  height,
  wantLeft,
  wantRight,
}: LayoutRequest): Layout => {
  const tier = tierFor(width);

  if (width < MIN_W || height < MIN_H) {
    return {
      tooSmall: true,
      tier,
      centerLeft: 0,
      centerRight: 0,
      leftOverlay: false,
      rightOverlay: false,
      statusCards: 0,
    };
  }

  // Cards drop one at a time as the terminal narrows rather than shrinking to
  // illegibility. Utilities is always kept, so it is never the one that goes.
  const statusCards = width >= 104 ? 4 : width >= 80 ? 3 : width >= 58 ? 2 : 1;

  let centerLeft = 0;
  let centerRight = 0;
  let leftOverlay = false;
  let rightOverlay = false;

  if (wantLeft) {
    if (width - LEFT_W - (wantRight ? RIGHT_W : 0) >= MIN_CENTER) {
      centerLeft = LEFT_W;
    } else {
      leftOverlay = true;
    }
  }
  if (wantRight) {
    if (width - centerLeft - RIGHT_W >= MIN_CENTER) {
      centerRight = RIGHT_W;
    } else {
      rightOverlay = true;
    }
  }

  return {
    tooSmall: false,
    tier,
    centerLeft,
    centerRight,
    leftOverlay,
    rightOverlay,
    statusCards,
  };
};

/** What the rails should default to at a given width. */
export const defaultRails = (width: number): { left: boolean; right: boolean } => {
  const tier = tierFor(width);
  return { left: tier !== "narrow", right: tier === "wide" };
};
