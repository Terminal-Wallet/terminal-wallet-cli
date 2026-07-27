/**
 * Pure formatters for the dense "command deck" UX — sparklines, % deltas, the
 * gas ticker, and the rolling price-series buffer. No blessed, no IO; the deck
 * entry injects a `tag` colour-wrapper where colour is wanted. Unit-tested.
 */
import { formatUnits } from "ethers";
import { NetworkName } from "@railgun-community/shared-models";
import { CustomGasEstimate } from "../../models/gas-models";

/** Block-explorer base URL per network (undefined = no explorer). */
export const explorerBase = (network: NetworkName): string | undefined => {
  switch (network) {
    case NetworkName.Ethereum:
      return "https://etherscan.io";
    case NetworkName.EthereumSepolia:
      return "https://sepolia.etherscan.io";
    case NetworkName.Polygon:
      return "https://polygonscan.com";
    case NetworkName.Arbitrum:
      return "https://arbiscan.io";
    case NetworkName.BNBChain:
      return "https://bscscan.com";
    default:
      return undefined;
  }
};

/** Explorer tx URL (undefined on unsupported chains). */
export const explorerTxUrl = (
  network: NetworkName,
  txid: string,
): string | undefined => {
  const base = explorerBase(network);
  return base ? `${base}/tx/${txid}` : undefined;
};

const BARS = "▁▂▃▄▅▆▇█";

/** Render a numeric series as a unicode sparkline (last `width` points). */
export const sparkline = (values: number[], width = 8): string => {
  const v = values.slice(-width);
  if (!v.length) return "";
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  return v
    .map((x) => {
      const i = Math.floor(((x - min) / span) * (BARS.length - 1));
      return BARS[Math.max(0, Math.min(BARS.length - 1, i))];
    })
    .join("");
};

/** Percentage change from the first to the last sample (0 if <2 points). */
export const pctDelta = (values: number[]): number => {
  if (values.length < 2) return 0;
  const [first] = values;
  const last = values[values.length - 1];
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
};

/** "+2.1%" / "-0.8%" / "0.0%". */
export const formatDelta = (pct: number): string =>
  `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;

/** Colour name for a delta (for the injected tagger). */
export const deltaColor = (pct: number): string =>
  pct > 0 ? "green" : pct < 0 ? "red" : "gray";

/** Append to a capped rolling series (oldest dropped). Pure. */
export const pushSeries = (arr: number[], v: number, cap = 32): number[] => {
  const next = arr.length >= cap ? arr.slice(arr.length - cap + 1) : arr.slice();
  next.push(v);
  return next;
};

/**
 * Compact a formatUnits() amount string for a narrow column: thousands-group the
 * integer part and cap to `maxFrac` decimals (trailing zeros stripped). Tiny
 * non-zero amounts collapse to "<0.000001" instead of bleeding 18 digits.
 */
export const fmtAmount = (raw: string, maxFrac = 6): string => {
  const neg = raw.startsWith("-");
  const [intRaw, fracRaw = ""] = (neg ? raw.slice(1) : raw).split(".");
  const intGrouped = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fracRaw.slice(0, maxFrac).replace(/0+$/, "");
  let out = frac ? `${intGrouped}.${frac}` : intGrouped;
  if (out === "0" && /[1-9]/.test(fracRaw)) out = `<0.${"0".repeat(maxFrac - 1)}1`;
  return neg ? `-${out}` : out;
};

/**
 * Gas ticker "18 / 24 / 39 gwei" from the fee matrix (maxFee per speed). Values
 * ≥1 gwei round to an integer; sub-gwei values keep up to 3 decimals with a
 * 0.001 gwei floor so tiny-but-nonzero fees never display as a misleading "0".
 */
/**
 * The three tiers as they actually differ.
 *
 * Never rounded to whole gwei. Below about 20 gwei the whole spread between
 * slow and fast is often under a gwei, so rounding printed "14 / 14 / 14" for
 * three prices that are not the same — a ticker saying nothing while looking
 * like it was working. Two decimals is where a tier difference stops being
 * visible in a fee, and a fixed width keeps the header from jittering as it
 * updates; the one decimal above 100 is to bound the line.
 */
export const gasTicker = (est: CustomGasEstimate): string => {
  const g = (priority: bigint) => {
    const gwei = Number(formatUnits(priority + est.baseFeePerGas, "gwei"));
    if (gwei <= 0) return "0";
    if (gwei >= 100) return gwei.toFixed(1);
    if (gwei >= 1) return gwei.toFixed(2);
    // Sub-gwei: keep the precision that is the whole figure down here.
    return Math.max(0.001, Number(gwei.toFixed(3))).toString();
  };
  return `${g(est.slow)} / ${g(est.average)} / ${g(est.fast)} gwei`;
};

/**
 * A dense balance row: "WETH  1.5      $4,800   +2.1% ▁▂▃▅▇". `tag` colours the
 * delta + sparkline; pass a passthrough in tests.
 */
export const balanceRow = (
  b: { symbol: string; amount: string; usd?: string },
  series: number[],
  tag: (s: string, c: string) => string,
): string => {
  const spark = series.length ? tag(sparkline(series), "cyan") : "";
  const d = pctDelta(series);
  const delta =
    series.length >= 2 ? tag(formatDelta(d).padStart(6), deltaColor(d)) : "      ";
  const usd = (b.usd ?? "").padStart(9);
  return `${b.symbol.padEnd(6)}${b.amount.padStart(12)}  ${usd}  ${delta} ${spark}`;
};
