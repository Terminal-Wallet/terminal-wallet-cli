/**
 * Bars for values that are chosen by feel rather than typed.
 *
 * A position is set by two decisions — how much to put up, and how hard to lever
 * it — and neither is a number anyone knows in advance. They are found by moving
 * one and watching what happens to the other. A text field cannot show that; a
 * bar with the consequence next to it can.
 *
 * Pure string building, no blessed: the caller colours it. That keeps the
 * geometry testable, which matters here for the same reason it matters for the
 * palette — a bar that renders one cell too wide is only visible on screen.
 */

/**
 * Clamp to 0..1.
 *
 * NaN is "not known yet" and reads as empty. Infinity is NOT — the risk maths
 * returns it for a debt ratio with no collateral behind it, and an empty bar
 * there would read as the safest possible position rather than the worst.
 */
export const clampFraction = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  if (value >= 1) return 1;
  return value <= 0 ? 0 : value;
};

/**
 * A filled bar, exactly `width` cells wide.
 *
 * Rounds the fill rather than flooring it, so a bar at 99% does not read as
 * full and one at 1% still shows something happened.
 */
export const sliderBar = (fraction: number, width: number): string => {
  if (width <= 0) return "";
  const filled = Math.round(clampFraction(fraction) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
};

/**
 * A bar filled outward from the centre, for a value that can go either way.
 *
 * "No change" is the middle, not an empty bar: a signed control whose zero
 * looks identical to an unset one gives the user no way to tell that they have
 * deliberately chosen to leave something alone. The centre cell is always
 * drawn, so the axis is visible even at zero.
 */
export const centredBar = (fraction: number, width: number): string => {
  if (width <= 0) return "";
  const mid = Math.floor(width / 2);
  const f = Math.max(-1, Math.min(1, isFinite(fraction) ? fraction : 0));
  const cells = new Array<string>(width).fill("░");
  const span = Math.round(Math.abs(f) * mid);
  for (let i = 1; i <= span; i++) {
    const at = f < 0 ? mid - i : mid + i;
    if (at >= 0 && at < width) cells[at] = "█";
  }
  cells[mid] = "│";
  return cells.join("");
};

export interface ZoneMark {
  /** Where the mark sits, as a fraction of the bar. */
  at: number;
  /** The single character drawn there. */
  glyph: string;
}

/**
 * A bar with thresholds marked on it.
 *
 * The marks overwrite the bar rather than shifting it, so the scale stays
 * honest — a mark is a position on the axis, not an extra cell. Marks outside
 * the bar are dropped rather than clamped onto the end, where they would claim
 * a threshold sits at the edge when it does not.
 */
export const markedBar = (
  fraction: number,
  width: number,
  marks: ZoneMark[],
): string => {
  const cells = sliderBar(fraction, width).split("");
  for (const { at, glyph } of marks) {
    if (!isFinite(at) || at < 0 || at >= 1) continue;
    const index = Math.min(width - 1, Math.floor(at * width));
    if (index >= 0 && index < cells.length) cells[index] = glyph;
  }
  return cells.join("");
};

/** A percentage as a person reads it — whole numbers, no trailing noise. */
export const asPercent = (fraction: number, decimals = 0): string =>
  `${(clampFraction(fraction) * 100).toFixed(decimals)}%`;

/**
 * A leverage multiple. Infinity is a real result here — debt at or above the
 * collateral's value — and printing "Infinityx" helps nobody.
 */
export const asLeverage = (multiple: number): string =>
  !isFinite(multiple) ? "—" : `${multiple.toFixed(1)}x`;

/** A USD price, sized to the magnitude rather than always two decimals. */
export const asUsdPrice = (value: number): string => {
  if (!isFinite(value) || value <= 0) return "—";
  if (value >= 100) return `$${Math.round(value).toLocaleString("en-US")}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(3)}`;
};
