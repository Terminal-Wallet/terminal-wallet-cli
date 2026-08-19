/**
 * Renders the f(x) close panel for a given Amount, without running the wallet.
 *
 * The panel is the only thing standing between a user and a partial close, and
 * it is pure formatting — `fxCloseLines` has one caller (the builder's detail
 * pane) and the build path sizes independently through `fullCloseRequirement`.
 * So it can be exercised here in full: no engine, no RPC, no database, and
 * nothing that could touch the shared `.railgun.db`.
 *
 *   node --import tsx scripts/fx-close-preview.ts            # the three cases
 *   node --import tsx scripts/fx-close-preview.ts 1885.5     # any Amount
 *
 * Figures are the real mainnet wstETH-Long numbers for position #4241.
 */
import { formatUnits } from "ethers";
import { fxCloseLines } from "../src/tui/format/fx-position";
import { debtTokenForFullClose } from "../src/railgun/transaction/fx/full-close";
import { FxPositionState } from "../src/railgun/transaction/fx/position-state";

/** The panel emits blessed tags; strip them so the text is readable here. */
const strip = (s: string) => s.replace(/\{[^}]*\}/g, "");
const fmt = (amount: bigint, decimals: number) =>
  Number(formatUnits(amount, decimals)).toFixed(6);

const POSITION: FxPositionState = {
  collateralAmount: 1606749600862549820n,
  collateralDecimals: 18,
  debtAmount: 1880030086474238325175n,
  debtRatio: 491524405228125399n,
  rebalanceDebtRatio: 880000000000000000n,
  liquidationDebtRatio: 950000000000000000n,
  borrowFeeRatio: 5000000n,
  repayFeeRatio: 2000000n,
};
const UNSHIELD_BPS = 25n;

const required = debtTokenForFullClose({
  debt: POSITION.debtAmount,
  repayFeeRatio: POSITION.repayFeeRatio,
  railgunUnshieldFeeBps: UNSHIELD_BPS,
});

const render = (label: string, repayAmount: bigint) => {
  console.log(`\n${label}`);
  console.log(`  Amount ${formatUnits(repayAmount, 18)}`);
  for (const line of fxCloseLines({
    state: POSITION,
    repayAmount,
    collateralSymbol: "wstETH",
    railgunUnshieldFeeBps: UNSHIELD_BPS,
    format: fmt,
  })) {
    console.log(`    ${strip(line)}`);
  }
};

const [amountArg] = process.argv.slice(2);

console.log(`debt            ${formatUnits(POSITION.debtAmount, 18)} fxUSD`);
console.log(`repay fee       ${Number(POSITION.repayFeeRatio) / 1e7}%`);
console.log(`unshield fee    ${UNSHIELD_BPS} bps`);
console.log(`requiredForFull ${formatUnits(required, 18)} fxUSD  <- what the card prefills`);

if (amountArg) {
  render("custom", BigInt(Math.round(Number(amountArg) * 1e6)) * 10n ** 12n);
} else {
  render("A. as the card prefills it — must NOT say anything is unused", required);
  render("B. lowered to the bare debt — must warn, in red", POSITION.debtAmount);
  render("C. a genuine overshoot — must say what is actually needed", 3000000000000000000000n);
}
