/**
 * A position, said in one line, and a move said as a step.
 *
 * Figures below are the real mainnet ones read from the wstETH-Long pool:
 * #4241 sits at a 49.15% debt ratio, #4242 at 80.85%, against a rebalance
 * threshold of 88% and a liquidation threshold of 95%.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUnits } from "ethers";
import {
  fxCloseLines,
  fxPositionDetailLines,
  fxPositionSummary,
  fxRiskDeltaLines,
} from "../../../src/tui/format/fx-position";
import { FxPositionState } from "../../../src/railgun/transaction/fx/position-state";
import { fxPositionRisk } from "../../../src/railgun/transaction/fx/risk";

const strip = (s: string) => s.replace(/\{[^}]*\}/g, "");
const fmt = (amount: bigint, decimals: number) =>
  Number(formatUnits(amount, decimals)).toFixed(4);

const state = (over: Partial<FxPositionState> = {}): FxPositionState => ({
  collateralAmount: 1606749600862549820n,
  collateralDecimals: 18,
  debtAmount: 1880030086474238325175n,
  debtRatio: 491524405228125399n,
  rebalanceDebtRatio: 880000000000000000n,
  liquidationDebtRatio: 950000000000000000n,
  borrowFeeRatio: 5000000n,
  repayFeeRatio: 2000000n,
  ...over,
});

test("a healthy position states both sides and calls itself safe", () => {
  const line = strip(fxPositionSummary(state(), "wstETH", fmt));
  assert.match(line, /1\.6067 wstETH/);
  assert.match(line, /1880\.0301 fxUSD/);
  assert.match(line, /49\.2%/);
  assert.match(line, /safe/);
});

test("a position close to the threshold says so before it crosses", () => {
  // #4242 at 80.85% against a rebalance at 88%. Reporting it as plain "safe"
  // is true and useless: the point of the screen is to catch it before it is
  // not.
  const line = strip(fxPositionSummary(state({ debtRatio: 808535649149876513n }), "wstETH", fmt));
  assert.match(line, /80\.9%/);
  assert.match(line, /near rebal/);
});

test("a warned position is never also called safe", () => {
  // It rendered "82.2% safe ▲" once the tail was clipped: the word reassuring,
  // the marker meaningless without the phrase it belonged to, on a position
  // eight points off being rebalanced.
  for (const ratio of [808535649149876513n, 900000000000000000n, 960000000000000000n]) {
    const line = strip(fxPositionSummary(state({ debtRatio: ratio }), "wstETH", fmt));
    assert.ok(!/safe/.test(line), `"${line}" says safe and warns at once`);
    assert.match(line, /▲/);
  }
});

test("the risk comes before the holdings, so clipping cannot eat the warning", () => {
  // Any list can be narrower than a line. Ordering is the only defence that
  // survives a width nobody measured.
  const line = strip(fxPositionSummary(state({ debtRatio: 808535649149876513n }), "wstETH", fmt));
  assert.ok(
    line.indexOf("▲") < line.indexOf("wstETH"),
    `holdings precede the warning: "${line}"`,
  );
  assert.match(line, /^80\.9%/, "the line does not open with the ratio");
});

test("past the threshold it is not called safe", () => {
  const line = strip(fxPositionSummary(state({ debtRatio: 900000000000000000n }), "wstETH", fmt));
  assert.match(line, /rebalancing/);
  assert.ok(!/safe/.test(line));
});

test("a position that could not be read is not rendered as an empty one", () => {
  // The dangerous default: zeroes read as a healthy position with no debt,
  // which invites borrowing against collateral that may not be there.
  const line = strip(fxPositionSummary(undefined, "wstETH", fmt));
  assert.match(line, /unavailable|could not read/i);
  assert.ok(!/safe/.test(line));
  assert.ok(!/0\.0000/.test(line), "an unreadable position must not show figures");
});

const risk = (collateral: bigint, debt: bigint) =>
  fxPositionRisk({
    collateralAmount: collateral,
    collateralDecimals: 18,
    collateralPriceUsd: 4000,
    debtAmount: debt,
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  });

test("a move is shown as a step, not just its destination", () => {
  const before = risk(1000000000000000000n, 2000000000000000000000n);
  const after = risk(1000000000000000000n, 2400000000000000000000n);
  const lines = fxRiskDeltaLines({
    before,
    risk: after,
    collateralSymbol: "wstETH",
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  }).map(strip);
  const step = lines.find((l) => l.includes("→"));
  assert.ok(step, "no before → after line");
  assert.match(step as string, /50\.0%.*→.*60\.0%/);
});

test("opening a new position has no 'was', so none is invented", () => {
  const lines = fxRiskDeltaLines({
    risk: risk(1000000000000000000n, 2000000000000000000000n),
    collateralSymbol: "wstETH",
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  }).map(strip);
  assert.ok(!lines.some((l) => l.startsWith("was")));
});

test("a slider that has not moved yet shows no step", () => {
  // Otherwise every card opens claiming "49.2% → 49.2%", which reads as a
  // change and trains the eye to ignore the line that matters.
  const same = risk(1000000000000000000n, 2000000000000000000000n);
  const lines = fxRiskDeltaLines({
    before: same,
    risk: same,
    collateralSymbol: "wstETH",
    rebalanceDebtRatio: 880000000000000000n,
    liquidationDebtRatio: 950000000000000000n,
  }).map(strip);
  assert.ok(!lines.some((l) => l.startsWith("was")));
});

// --- closing --------------------------------------------------------------

/**
 * Fee-free by default, so the existing cases still read as written. The
 * fee-aware threshold gets its own tests below — it is the thing that decides
 * full vs partial, and it was wrong.
 */
const close = (
  repay: bigint,
  over: Partial<FxPositionState> = {},
  railgunUnshieldFeeBps = 0n,
) =>
  fxCloseLines({
    // Fee-free unless a case asks otherwise: these assert the WORDING, and the
    // fixture's 0.2% repay fee would otherwise make every one of them partial.
    state: state({ repayFeeRatio: 0n, ...over }),
    repayAmount: repay,
    collateralSymbol: "wstETH",
    railgunUnshieldFeeBps,
    format: fmt,
  }).map(strip);

test("repaying the whole debt clears it, and says the position is kept", () => {
  // NOT "burnt". Measured on mainnet (tx 0x73d732bc...): f(x)'s own full-close
  // sentinel zeroed the position and ownerOf still returned the RAILGUN proxy.
  // The pool empties a position; it never destroys the NFT.
  const lines = close(1880030086474238325175n);
  assert.ok(lines.some((l) => /clears the debt/.test(l)));
  assert.ok(
    !lines.some((l) => /burnt|burned|destroy/i.test(l)),
    "still claims the position is destroyed",
  );
  assert.ok(lines.some((l) => /kept, empty/.test(l)));
  assert.ok(lines.some((l) => /1\.6067 wstETH/.test(l)), "does not say what comes back");
});

test("CONTROL: the whole debt is NOT enough once the fees are counted", () => {
  // The bug that left dust behind. Both fees come off before the repay lands,
  // so an amount equal to the debt funds a PARTIAL close — and the card used to
  // preview it as a full one, which is the screen the user checks before
  // committing.
  const debt = 1880030086474238325175n;
  const lines = close(debt, { repayFeeRatio: 1_000_000n }, 25n);
  assert.ok(
    !lines.some((l) => /closes the position fully/.test(l)),
    "the whole debt still previews as a full close once fees exist",
  );
  assert.ok(lines.some((l) => /PARTIAL/.test(l)));
  assert.ok(
    lines.some((l) => /Set Amount to .+ to close it outright/.test(l)),
    "does not say what would actually close it",
  );
});

test("grossed up through both fees, it does close fully", () => {
  const debt = 1880030086474238325175n;
  // debt x (1 + repayFee) / (1 - unshieldFee), rounded up — the same figure the
  // build sizes against.
  const throughRepay = (debt * 1_001_000_000n + 999_999_999n) / 1_000_000_000n;
  const required = (throughRepay * 10_000n + 9_974n) / 9_975n;
  const lines = close(required, { repayFeeRatio: 1_000_000n }, 25n);
  assert.ok(lines.some((l) => /clears the debt/.test(l)));
});

test("a partial close is not the quietest thing on the screen", () => {
  // It leaves a live position accruing interest that can be liquidated. It was
  // gray, below a yellow "closes fully" — the safe outcome shouting and the
  // surprising one whispering.
  const raw = fxCloseLines({
    state: state({ repayFeeRatio: 0n }),
    repayAmount: 940015043237119162587n,
    collateralSymbol: "wstETH",
    railgunUnshieldFeeBps: 0n,
    format: fmt,
  });
  assert.ok(
    raw.some((l) => l.includes("red") && /PARTIAL/.test(l)),
    "the partial warning is not coloured as a warning",
  );
});

test("a partial close says how much is still owed", () => {
  // The distinction the card never made: 940 fxUSD against a 1880 debt leaves
  // a live position, which is a categorically different outcome to closing.
  const lines = close(940015043237119162587n);
  assert.ok(lines.some((l) => /PARTIAL/.test(l)));
  assert.ok(lines.some((l) => /940\.0150 fxUSD owed/.test(l)));
  assert.ok(!lines.some((l) => /closes the position fully/.test(l)));
});

test("collateral comes back in proportion to the debt cleared", () => {
  const lines = close(940015043237119162587n);
  // Half the debt, half the collateral.
  assert.ok(lines.some((l) => /0\.8034 wstETH/.test(l)), lines.join(" | "));
});

test("repaying more than is owed says the excess is not used", () => {
  // A number larger than the debt reads as if it will all be spent.
  const lines = close(3000000000000000000000n);
  assert.ok(lines.some((l) => /is not used/.test(l)));
  assert.ok(lines.some((l) => /clears the debt/.test(l)));
});

test("the amount that makes a close full is not called unused", () => {
  // 1880.030086 grossed up through a 25bps unshield. This is what the card
  // prefills, so measuring the advisory against the bare debt fired it on EVERY
  // default close: "the rest is not used" printed under "clears the debt",
  // telling the user to lower the amount into the partial the prefill exists to
  // prevent. The gross-up is not surplus — it is the fee that makes it full.
  const lines = close(1884741941327557218221n, {}, 25n);
  assert.ok(lines.some((l) => /clears the debt/.test(l)));
  assert.ok(
    !lines.some((l) => /is not used/.test(l)),
    "calls the fee gross-up unused on a close that needs it",
  );
});

test("CONTROL: an overshoot past the fee-inclusive requirement is still called out", () => {
  // The advisory must still exist, or the test above passes by deleting it.
  const lines = close(3000000000000000000000n, {}, 25n);
  assert.ok(lines.some((l) => /is not used/.test(l)));
  assert.ok(lines.some((l) => /1884\.7419 fxUSD is needed/.test(l)));
});

test("a swap out is named, so the collateral is not reported as arriving unchanged", () => {
  const lines = fxCloseLines({
    state: state(),
    repayAmount: 1880030086474238325175n,
    collateralSymbol: "wstETH",
    receiveSymbol: "USDC",
    railgunUnshieldFeeBps: 0n,
    format: fmt,
  }).map(strip);
  assert.ok(lines.some((l) => /wstETH → USDC/.test(l)));
});

// --- fitting a narrow rail ------------------------------------------------

const near = () => state({ debtRatio: 808535649149876513n });

test("a narrow rail drops segments rather than chopping one in half", () => {
  // A hard slice cuts mid-number — "0.015" for 0.0155 — and a truncated figure
  // still reads as a figure. Dropping says less; slicing says something false.
  const line = strip(fxPositionSummary(near(), "wstETH", fmt, 37));
  assert.ok(line.length <= 37, `"${line}" is ${line.length}, over 37`);
  assert.ok(!line.endsWith("·"), "left a dangling separator");
  for (const piece of line.split(" · ")) {
    assert.ok(piece.trim().length > 0, "emitted an empty segment");
  }
});

test("the risk survives any width the caller can offer", () => {
  // It is the first segment and never dropped, so a rail too narrow for
  // anything else still says the thing worth knowing.
  for (const width of [18, 24, 37, 60, 200]) {
    const line = strip(fxPositionSummary(near(), "wstETH", fmt, width));
    assert.match(line, /80\.9% ▲ near rebal/, `lost the risk at width ${width}`);
  }
});

test("no width means everything", () => {
  const line = strip(fxPositionSummary(near(), "wstETH", fmt));
  assert.match(line, /wstETH/);
  assert.match(line, /fxUSD/);
});

test("debt outranks collateral when only one fits", () => {
  // Debt is what moves the ratio and what a repay acts on; collateral is
  // visible from the pool name in the label beside it.
  const line = strip(fxPositionSummary(near(), "wstETH", fmt, 37));
  assert.match(line, /fxUSD/);
  assert.ok(!/wstETH/.test(line), "kept collateral over debt in a tight line");
});

test("the detail view states both thresholds, not just the ratio", () => {
  const lines = fxPositionDetailLines("wstETH-Long #4242", near(), "wstETH", fmt).map(strip);
  const all = lines.join("\n");
  assert.match(all, /collateral/);
  assert.match(all, /debt/);
  assert.match(all, /rebalance 88%/);
  assert.match(all, /liquidation 95%/);
});

test("a position that could not be read says so in the detail view too", () => {
  const all = fxPositionDetailLines("wstETH-Long #4242", undefined, "wstETH", fmt)
    .map(strip)
    .join("\n");
  assert.match(all, /could not be read/);
  assert.ok(!/0\.0000/.test(all), "showed figures for a position it could not read");
});

// --- emptied, which is how every close ends ---------------------------------------------------

/**
 * f(x) never burns a position NFT. Both close paths — explicit amounts and the
 * pool's own full-close sentinel — zero the legs and leave the NFT held, which
 * tx 0x73d732bc... proved on mainnet. So every closed position ends up here,
 * and the pool reports it identically to one that never existed.
 */
const EMPTY = state({
  collateralAmount: 0n,
  debtAmount: 0n,
  debtRatio: 0n,
});

test("an emptied position says so, rather than reading as unreadable", () => {
  const line = strip(fxPositionSummary(EMPTY, "wstETH", fmt));
  assert.match(line, /emptied/);
  assert.doesNotMatch(line, /could not read/);
});

test("CONTROL: an emptied position must not render as a healthy one", () => {
  // Zero debt at zero collateral is 0.0% — the most reassuring row on the
  // screen, for something with nothing in it.
  const line = strip(fxPositionSummary(EMPTY, "wstETH", fmt));
  assert.doesNotMatch(line, /safe/);
  assert.doesNotMatch(line, /0\.0%/);
});

test("the detail panel explains that nothing is owed and nothing is at risk", () => {
  const lines = fxPositionDetailLines("wstETH-Long #1981", EMPTY, "wstETH", fmt).map(strip);
  assert.ok(lines.some((l) => /empty/i.test(l)));
  assert.ok(
    lines.some((l) => /always survives a close/.test(l)),
    "does not explain why it still exists",
  );
  assert.ok(!lines.some((l) => /could not be read/.test(l)));
});

test("a position that truly cannot be read still says so", () => {
  // The distinction the whole change rests on: undefined is unreadable, zeroes
  // are empty, and they are not the same answer.
  assert.match(strip(fxPositionSummary(undefined, "wstETH", fmt)), /could not read/);
});
