/**
 * Pure logic for the live transaction-builder page (no rendering). The blessed
 * panel (ui-blessed/tx-builder.ts) owns the widgets; this owns the state shape,
 * field display, validation, and the live one-line summary — all unit-tested.
 */
import { EVMGasType } from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { GasChoice } from "../../flows/collect/gas";
import { FeeMode } from "../../flows/spec";
import { RailgunDisplayBalance } from "../../models/balance-models";
import { LegsState, FlowCaps, validateLegs } from "../../flows/caps";
import { TokenOverspend } from "../../flows/balance";
import { fmtAmount } from "../format/deck";

export type FieldKey = "token" | "buyToken" | "amount" | "address" | "memo" | "gas" | "fee" | "showSender";

export interface BuilderState {
  token?: RailgunDisplayBalance; // for swaps: the SELL token
  buyToken?: RailgunDisplayBalance; // swaps: the BUY token
  amount?: string;
  address?: string;
  memo?: string;
  gas: GasChoice; // undefined / "keep" = auto estimate
  fee?: FeeMode; // private-spend fee mode; undefined = self-send default
  showSender?: boolean; // reveal sender 0zk to the recipient (private transfers)
  legs?: LegsState; // multi-token/multi-recipient flows (token/amount/recipient live here)
  /**
   * Swaps: the 0x quote the preview was built from, carried through to submit.
   *
   * Without this the builder quotes once to show you a rate and submit quotes
   * again to spend against — two different quotes, and the second one decides
   * whether the send happens at all. Reused when it still matches the inputs on
   * screen; re-fetched when they have moved.
   */
  swapQuote?: { inputs: unknown; forKey: string };
}

/** Identifies the inputs a swap quote was fetched for. */
export const swapQuoteKey = (s: BuilderState): string =>
  [s.token?.tokenAddress, s.buyToken?.tokenAddress, s.amount, s.address]
    .map((part) => part ?? "")
    .join("|");

const short = (a?: string): string =>
  a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a ?? "";

/** Human label for the chosen gas (auto, or the custom/preset gwei). */
export const gasLabel = (g: GasChoice): string => {
  if (!g || g === "keep") return "Auto (recommended)";
  return g.evmGasType === EVMGasType.Type2
    ? `${formatUnits(g.maxFeePerGas, "gwei")} gwei`
    : `${formatUnits(g.gasPrice, "gwei")} gwei`;
};

/** Human label for the chosen fee mode (pure — keeps core free of UI/SDK deps). */
export const feeLabel = (fee: FeeMode | undefined): string => {
  if (!fee) return "Self-send (default)";
  switch (fee.kind) {
    case "self-signer":
      return "Self-send (public wallet)";
    case "external-signer":
      return `External signer (${fee.label})`;
    case "broadcaster":
      return `Broadcaster ${short(fee.broadcaster.railgunAddress)}`;
  }
};

/** The current value shown for a field row (placeholder when unset). */
export const fieldDisplay = (key: FieldKey, s: BuilderState): string => {
  switch (key) {
    case "token":
      return s.token
        ? `${s.token.symbol}  (have ${formatUnits(s.token.amount, s.token.decimals)})`
        : "‹select token›";
    case "buyToken":
      return s.buyToken ? s.buyToken.symbol : "‹select token›";
    case "amount":
      return s.amount ? s.amount : "‹enter amount›";
    case "address":
      return s.address ? short(s.address) : "‹enter recipient›";
    case "memo":
      return s.memo ? s.memo : "‹none›";
    case "gas":
      return gasLabel(s.gas);
    case "fee":
      return feeLabel(s.fee);
    case "showSender":
      return s.showSender ? "shown to recipient" : "hidden (private)";
  }
};

export interface ValidationResult {
  ok: boolean;
  missing: string[];
}

/** Which required fields are still unset/invalid. */
export const validate = (
  fields: FieldKey[],
  s: BuilderState,
): ValidationResult => {
  const missing: string[] = [];
  if (fields.includes("token") && !s.token) missing.push("token");
  if (fields.includes("buyToken") && !s.buyToken) missing.push("buy token");
  if (fields.includes("amount")) {
    const n = Number(s.amount);
    if (!s.amount || !isFinite(n) || n <= 0) missing.push("a valid amount");
  }
  if (fields.includes("address") && !s.address?.trim()) missing.push("recipient");
  return { ok: missing.length === 0, missing };
};

/**
 * Whether to demand a FRESH password re-auth before this send. A real broadcast
 * always re-challenges (the cached unlock is NOT sufficient — the user explicitly
 * confirms each spend); a simulation/dry-run never broadcasts, so it does not
 * prompt. Pure + tested so the rule isn't buried in the modal.
 */
export const requireReauthBeforeSend = (opts: { isSimulation: boolean }): boolean =>
  !opts.isSimulation;

export type Preflight =
  | { ok: true }
  | { ok: false; reason: "legs" | "fields" | "overspend"; message: string };

export interface PreflightInput {
  fields: FieldKey[];
  state: BuilderState;
  /** Multi-token flows only; validated against `caps`. */
  legs?: LegsState;
  caps?: FlowCaps;
  /** Tokens whose committed amount plus same-token fee exceeds the balance. */
  overspend: TokenOverspend[];
}

/**
 * Everything that must hold before a build may be reviewed and broadcast.
 *
 * Pure and ordered on purpose. The builder renders an `ok` flag alongside the
 * breakdown, but a rendered flag is a display artefact — it can be stale, and it
 * exists only if something drew it. The send path calls this instead, so the
 * decision to spend is made from state rather than from what is on screen.
 *
 * The order is cheapest-first and most-specific-last: unfinished legs name what
 * to finish, missing fields name themselves, and only a complete build is worth
 * measuring against the balance.
 */
export const preflight = ({
  fields,
  state,
  legs,
  caps,
  overspend,
}: PreflightInput): Preflight => {
  if (legs && caps) {
    const result = validateLegs(legs, caps);
    if (!result.ok) {
      return {
        ok: false,
        reason: "legs",
        message:
          result.violations[0] ?? `Incomplete — finish ${result.missing.length} leg(s).`,
      };
    }
  }

  const fieldResult = validate(fields, state);
  if (!fieldResult.ok) {
    return {
      ok: false,
      reason: "fields",
      message: `Incomplete — need: ${fieldResult.missing.join(", ")}.`,
    };
  }

  if (overspend.length) {
    const [first] = overspend;
    return {
      ok: false,
      reason: "overspend",
      message:
        `Overspends ${first.token.symbol} by ` +
        `${fmtAmount(formatUnits(first.overBy, first.token.decimals), 6)} — reduce the amount or fee.`,
    };
  }

  return { ok: true };
};

/** Live one-line summary of the transaction being built. */
export const summarize = (
  cfg: { verb: string; fixedAddress?: string },
  s: BuilderState,
): string => {
  const sym = s.token?.symbol ?? "token";
  const amt = s.amount ?? "—";
  const to = s.address ?? cfg.fixedAddress;
  return `${cfg.verb} ${amt} ${sym} → ${to ? short(to) : "—"}`;
};
