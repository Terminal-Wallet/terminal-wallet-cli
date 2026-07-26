/**
 * Deck geometry.
 *
 * The layout is where a terminal UI goes wrong quietly: it does not crash, it
 * just squeezes the pane you are typing an amount into down to nothing. The
 * rule being asserted here is that the centre is protected — a rail is only
 * given room inline if what remains is still wide enough to compose in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeLayout,
  tierFor,
  defaultRails,
  LEFT_W,
  RIGHT_W,
  MIN_CENTER,
  MIN_W,
  MIN_H,
} from "../../../src/tui/layout";

const at = (width: number, height = 40, wantLeft = true, wantRight = true) =>
  computeLayout({ width, height, wantLeft, wantRight });

test("tiers switch exactly at the width that fits them", () => {
  assert.equal(tierFor(LEFT_W + RIGHT_W + MIN_CENTER), "wide");
  assert.equal(tierFor(LEFT_W + RIGHT_W + MIN_CENTER - 1), "medium");
  assert.equal(tierFor(LEFT_W + MIN_CENTER), "medium");
  assert.equal(tierFor(LEFT_W + MIN_CENTER - 1), "narrow");
});

test("a wide terminal gets both rails inline", () => {
  const l = at(200);
  assert.equal(l.centerLeft, LEFT_W);
  assert.equal(l.centerRight, RIGHT_W);
  assert.equal(l.leftOverlay, false);
  assert.equal(l.rightOverlay, false);
});

test("the centre never drops below its minimum, whatever is asked for", () => {
  // Every width from unusable to generous: if the centre is inline at all, it
  // has at least MIN_CENTER. This is the invariant the tiers exist to keep.
  for (let w = MIN_W; w <= 220; w++) {
    const l = at(w);
    if (l.tooSmall) continue;
    const centre = w - l.centerLeft - l.centerRight;
    assert.ok(
      centre >= MIN_CENTER,
      `width ${w}: centre was ${centre}, below the ${MIN_CENTER} minimum`,
    );
  }
});

test("a rail that will not fit becomes an overlay rather than shrinking the centre", () => {
  // One column too narrow for both rails inline. The left is considered first,
  // so it is the one that peeks — and only reachable by explicitly asking for
  // both, since the tier defaults never request more than fits.
  const l = at(LEFT_W + RIGHT_W + MIN_CENTER - 1);
  assert.equal(l.leftOverlay, true);
  assert.equal(l.centerLeft, 0);
  assert.equal(l.centerRight, RIGHT_W);
});

test("the tier defaults never need an overlay", () => {
  // An overlay is a response to the user asking for more than fits. Arriving at
  // one without asking would mean the defaults themselves are wrong.
  for (let w = MIN_W; w <= 220; w++) {
    const { left, right } = defaultRails(w);
    const l = computeLayout({ width: w, height: 40, wantLeft: left, wantRight: right });
    if (l.tooSmall) continue;
    assert.equal(l.leftOverlay, false, `width ${w} overlaid the left rail by default`);
    assert.equal(l.rightOverlay, false, `width ${w} overlaid the right rail by default`);
  }
});

test("asking for nothing gives the centre the whole width", () => {
  const l = at(200, 40, false, false);
  assert.equal(l.centerLeft, 0);
  assert.equal(l.centerRight, 0);
});

test("an unusably small terminal reports itself rather than laying out", () => {
  assert.equal(at(MIN_W - 1).tooSmall, true);
  assert.equal(at(200, MIN_H - 1).tooSmall, true);
  assert.equal(at(MIN_W, MIN_H).tooSmall, false);
});

test("cards drop one at a time as the terminal narrows", () => {
  // Fewer, readable cards beats four unreadable ones.
  assert.equal(at(120).statusCards, 4);
  assert.equal(at(90).statusCards, 3);
  assert.equal(at(70).statusCards, 2);
  assert.equal(at(56).statusCards, 1);
});

test("the card count never increases as the terminal shrinks", () => {
  let previous = Infinity;
  for (let w = 220; w >= MIN_W; w--) {
    const l = at(w);
    if (l.tooSmall) continue;
    assert.ok(
      l.statusCards <= previous,
      `width ${w}: card count went up from ${previous} to ${l.statusCards}`,
    );
    previous = l.statusCards;
  }
});

test("defaults follow the tier", () => {
  assert.deepEqual(defaultRails(200), { left: true, right: true });
  assert.deepEqual(defaultRails(LEFT_W + MIN_CENTER), { left: true, right: false });
  assert.deepEqual(defaultRails(MIN_W), { left: false, right: false });
});
