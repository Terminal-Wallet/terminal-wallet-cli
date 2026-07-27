/**
 * The bars are exact-width or they corrupt the row they sit in.
 *
 * Same failure mode as the palette cards: a bar one cell too wide pushes the
 * figure beside it off the end, and nothing fails — it just looks wrong, on
 * screen, later.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asLeverage,
  asPercent,
  asUsdPrice,
  clampFraction,
  markedBar,
  sliderBar,
} from "../../../src/tui/format/slider";

test("a bar is always exactly the width it was asked for", () => {
  for (const width of [1, 8, 20, 37]) {
    for (const fraction of [-1, 0, 0.001, 0.5, 0.999, 1, 2, NaN, Infinity]) {
      assert.equal(
        [...sliderBar(fraction, width)].length,
        width,
        `fraction ${fraction} at width ${width}`,
      );
    }
  }
});

test("a zero-width bar is empty rather than a crash", () => {
  assert.equal(sliderBar(0.5, 0), "");
  assert.equal(markedBar(0.5, 0, [{ at: 0.5, glyph: "|" }]), "");
});

test("empty and full read as empty and full", () => {
  assert.equal(sliderBar(0, 4), "░░░░");
  assert.equal(sliderBar(1, 4), "████");
});

test("a nearly-full bar does not read as full, and a trace still shows", () => {
  // Rounding, not flooring: 99% flooring to 3/4 would look the same as 75%.
  assert.equal(sliderBar(0.99, 4), "████");
  assert.ok(sliderBar(0.2, 4).startsWith("█"), "a small value should still show");
});

test("out-of-range and non-finite fractions clamp instead of throwing", () => {
  assert.equal(clampFraction(-5), 0);
  assert.equal(clampFraction(NaN), 0, 'unknown reads as empty');
  // An infinite debt ratio is the WORST case, not the safest — an empty bar
  // there would read as a position with no risk at all.
  assert.equal(clampFraction(Infinity), 1);
  assert.equal(sliderBar(Infinity, 4), '████');
  assert.equal(clampFraction(0.25), 0.25);
});

test("marks overwrite the bar rather than widening it", () => {
  const width = 10;
  const bar = markedBar(0.5, width, [
    { at: 0.8, glyph: "|" },
    { at: 0.9, glyph: "!" },
  ]);
  assert.equal([...bar].length, width, "a mark must not add a cell");
  assert.equal(bar[8], "|");
  assert.equal(bar[9], "!");
});

test("a mark outside the bar is dropped, not pinned to the end", () => {
  // Pinning would claim a threshold sits at the edge of the scale when it is
  // actually off it.
  const bar = markedBar(0.5, 10, [
    { at: 1.4, glyph: "|" },
    { at: -0.2, glyph: "!" },
    { at: NaN, glyph: "?" },
  ]);
  assert.equal(bar, sliderBar(0.5, 10));
});

test("percentages and leverage read the way the design reference shows them", () => {
  assert.equal(asPercent(0.64), "64%");
  assert.equal(asPercent(0.4, 1), "40.0%");
  assert.equal(asLeverage(1 / (1 - 0.4)), "1.7x");
});

test("infinite leverage prints as a dash, not as Infinity", () => {
  assert.equal(asLeverage(Infinity), "—");
  assert.equal(asLeverage(NaN), "—");
});

test("prices are sized to their magnitude", () => {
  assert.equal(asUsdPrice(1943.29), "$1,943");
  assert.equal(asUsdPrice(12.5), "$12.50");
  assert.equal(asUsdPrice(0.0421), "$0.0421");
  assert.equal(asUsdPrice(0), "—");
  assert.equal(asUsdPrice(Infinity), "—");
});
