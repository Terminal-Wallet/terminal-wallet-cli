/**
 * Who owns the keyboard and the mouse, when several things are on screen.
 *
 * The deck's chrome stays visible behind whatever is over it, and every bit of
 * it is clickable, so "what is on top" has to decide what an input means. Both
 * rules below are here because breaking them cost a user a half-built
 * transaction they could not get back to.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deckClickVerdict, escapeReachesDeck } from "../../../src/tui/nav";

test("a click on the deck means different things depending on what is over it", () => {
  // Clicking a stat card with the transaction card open opened a second screen
  // on top of a half-built transaction, and the card underneath could no
  // longer be closed: the new screen owned the mode, so Escape went to it.
  assert.equal(deckClickVerdict("home", 0), "act");

  // Work that cannot be recreated by clicking again is worth refusing FOR —
  // and saying so, since a silent no-op reads as a missed click.
  assert.equal(deckClickVerdict("build", 0), "refuse");

  // The palette is a chooser. Clicking something else is the choice, not a
  // mistake, so it gets out of the way rather than swallowing the click.
  assert.equal(deckClickVerdict("palette", 0), "closeThenAct");

  // A dialog's scrim has already eaten the click; anything arriving here under
  // one is a stray.
  assert.equal(deckClickVerdict("home", 1), "ignore");
  assert.equal(deckClickVerdict("build", 2), "ignore");
});

test("Escape belongs to the innermost thing that is open", () => {
  // modal.ts exempts Escape from the key grab so a dialog is always
  // dismissable even after focus moves underneath it; that exemption is
  // screen-wide, so the deck hears it too. The Escape that closed the card's
  // token picker was also closing the card behind it.
  assert.equal(escapeReachesDeck(0), true);
  assert.equal(escapeReachesDeck(1), false, "Escape closed the card under a dialog");
  assert.equal(escapeReachesDeck(2), false);
});
