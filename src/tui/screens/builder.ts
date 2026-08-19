/**
 * The transaction builder — the centre pane turned into an editable form.
 *
 * One page rather than a wizard: every field is a row, editable in any order,
 * with the clear-signing breakdown live underneath. Multi-token flows expose
 * each leg's token, amount and recipient as their own rows, so a three-token
 * unshield is edited directly instead of through nested sub-menus.
 *
 * Three gates stand between a filled form and a broadcast, and the order is
 * deliberate. Completeness first, because it is the cheapest check. Overspend
 * second — an amount that, plus a same-token broadcaster fee, exceeds the
 * balance is caught here rather than by a transaction that fails after proving.
 * Then the review, and only then a fresh password: a cached unlock is proof the
 * terminal was unlocked at some point, not consent to spend now.
 *
 * Those gates are re-evaluated in `trySend` rather than trusting the `ok` flag
 * the summary renders. The summary is a display; the send path does not depend
 * on it having been rendered, or on it being current.
 */
import blessed from "blessed";
import { formatUnits } from "ethers";
import { DeckContext } from "../context";
import { getState, setState, setStatusMessage } from "../store";
import { getInputProvider } from "../../core/input";
import { tag, short } from "../format/tags";
import { fmtAmount } from "../format/deck";
import { treeSynced } from "../format/dashboard";
import { createModal } from "../widgets/modal";
import { RailgunDisplayBalance } from "../../models/balance-models";
import { txBuilderConfigs, buildSwapInputs } from "./tx-builder-configs";
import { TxBuilderConfig } from "./tx-builder";
import {
  FieldKey,
  BuilderState,
  fieldDisplay,
  feeLabel,
  gasLabel,
  validate,
  requireReauthBeforeSend,
  preflight,
  resolveSeedToken,
  swapQuoteKey,
} from "./tx-builder-core";
import {
  Leg,
  LegsState,
  flowCaps,
  initLegs,
  setLegField,
  setSharedRecipient,
  validateLegs,
  addToken,
  removeLeg,
  canAddToken,
} from "../../flows/caps";
import {
  FeeReservation,
  TokenOverspend,
  overspentTokens,
  expectedBalance,
  feeReserved,
  gasReservationFor,
  maxAmount,
} from "../../flows/balance";
import {
  NATIVE_SENTINEL,
  NativeKind,
  isNativeChoice,
  nativeTokenLabel,
} from "../../flows/native-token";
import { recipientOptions } from "../../flows/recipient-options";
import { addressKindError } from "../form-core";
import { collectGasSelection } from "../../flows/collect/gas";
import {
  collectFeeMode,
  approxBroadcasterFee,
  resolveDefaultFeeAsync,
} from "../../flows/collect/fee";
import { getTokenPricesUSD } from "../../price/defillama";
import { parseUnits } from "ethers";
import {
  FxRisk,
  fxDebtForRatio,
  fxMaxOpenRatio,
  fxPositionRisk,
} from "../../railgun/transaction/fx/risk";
import { clampFraction, asPercent } from "../format/slider";
import { FxManagePlan, planFxManage, fxManageVerb } from "../../railgun/transaction/fx/manage";
import { fxRiskLines, fxRiskDeltaLines, fxPositionSummary, fxCloseLines } from "../format/fx-position";
import { debtTokenForFullClose } from "../../railgun/transaction/fx/full-close";
import { poolCollateralSymbol } from "../../railgun/transaction/fx/position-state";
import { DefiLeg, defiLegLines } from "../format/defi-legs";
import { getFxPool } from "@railgun-community/cookbook";
import { getProviderForChain } from "../../railgun/network/network-util";
import { balanceUSD, formatUSD } from "../../price/portfolio";
import { amountLines, protocolFeeLines, BuilderView } from "../format/builder-detail";
import { swapBuyLine, toSwapPreview, SwapQuotePreview } from "../format/swap";
import {
  getRailgunFeeBasisPoints,
  getCurrentNetwork,
} from "../../railgun/engine/engine";
import {
  getCurrentRailgunAddress,
  shouldShowSender,
  toggleShouldShowSender,
} from "../../railgun/wallet/wallet-util";
import {
  confirmPassword,
  getCachedEncryptionKey,
} from "../../railgun/wallet/wallet-password";
import { evmGasTypeForChain, priceField } from "../../railgun/gas/gas-selection";
import { EVMGasType } from "@railgun-community/shared-models";
import { FeeData } from "ethers";
import {
  setGasFeeSelection,
  clearGasFeeSelection,
} from "../../railgun/gas/gas-fee";
import { getFeeDetailsForChain } from "../../railgun/gas/gas-util";
import { createLogger } from "../../platform/logger";

const log = createLogger("builder");

export interface BuilderHost {
  ctx: DeckContext;
  /** The editable rows. */
  list: blessed.Widgets.ListElement;
  /** The live breakdown beneath them. */
  summary: blessed.Widgets.BoxElement;
  /** The centre pane, whose label names the active flow. */
  center: blessed.Widgets.BoxElement;
  /** Restore the deck when the builder closes. */
  onClose: () => void;
}

export interface Builder {
  open: (flowId: string, seed?: RailgunDisplayBalance) => Promise<void>;
  close: () => void;
  /** Re-draw rows and breakdown from current state. */
  render: () => void;
  /** Run the send gates — bound to `S` by the host. */
  send: () => void;
  isOpen: () => boolean;
}

const FIELD_LABELS: Record<FieldKey, string> = {
  token: "Token",
  buyToken: "Buy token",
  sellToken: "Sell to cover",
  vault: "Vault",
  pool: "Pool",
  position: "Position",
  account: "Account",
  amount: "Amount",
  collateralPct: "Collateral",
  debt: "Mint",
  debtRatio: "Loan",
  debtDelta: "Debt",
  address: "Recipient",
  memo: "Memo",
  gas: "Gas",
  fee: "Fee",
  showSender: "Sender",
};

/**
 * Wide enough for the longest label, plus a gap.
 *
 * A hardcoded 12 ran "Sell to cover" straight into its own value the moment a
 * 13-character label existed. Deriving it means the next long one cannot.
 */
const LABEL_W =
  Math.max(...Object.values(FIELD_LABELS).map((l) => l.length)) + 2;

/**
 * The whole reason, not just the outermost wrapper.
 *
 * The cookbook wraps every step failure as `<step> step is invalid.` and hangs
 * the actual cause off `error.cause` (steps/step.js). Reporting only the
 * message names which step gave up and says nothing about why — "0x V2
 * Exchange Swap step is invalid" is true of a bad quote, an unmatched input
 * filter and a zero amount alike.
 */
const describeCause = (error: unknown, depth = 4): string => {
  const parts: string[] = [];
  // A for-loop rather than a `let` at this indentation: builder-reset.test.ts
  // treats every two-space `let` in this file as a per-flow cache that must be
  // cleared when a card opens, and a local in a module-level helper is neither.
  for (
    let current: unknown = error;
    current instanceof Error && parts.length < depth;
    current = (current as { cause?: unknown }).cause
  ) {
    const message = current.message.trim();
    // The wrapper repeats verbatim at more than one level on nested recipes.
    if (message && !parts.includes(message)) parts.push(message);
  }
  return parts.length ? parts.join(" — ") : "could not build the batch";
};

/** Which native-token wording a flow should use when offering the base asset. */
const nativeKindFor = (flowId?: string): NativeKind =>
  flowId === "shield-public-balances"
    ? "shield"
    : flowId === "unshield-private-balances"
      ? "unshield"
      : "send";

export const createBuilder = (host: BuilderHost): Builder => {
  const { ctx, list, summary, center } = host;

  let cfg: TxBuilderConfig | undefined;
  let state: BuilderState = { gas: undefined };
  /** Rows are keys: a FieldKey, "__send"/"__cancel"/"__addleg", or "__lt|la|lr|lx:<legId>". */
  let rows: string[] = [];
  /** token→USD, fetched once per open, for the breakdown's USD figures. */
  let prices: Record<string, number> = {};
  let feePreview: { text: string; usd?: number } | undefined;
  let feeReservation: FeeReservation | undefined;
  /**
   * The balances this flow loaded, kept so a FEE token can be weighed against
   * what the wallet actually holds of it. Without them the fee is only ever
   * checked against the tokens being sent.
   */
  let loadedBalances: RailgunDisplayBalance[] = [];
  let swapPreview: SwapQuotePreview | undefined;
  /** The steps the current build would run, and what they were built for. */
  let legsPreview: { legs: DefiLeg[]; forKey: string } | undefined;
  /**
   * Why the batch could not be previewed.
   *
   * An empty batch block and a preview that threw looked identical, and both
   * looked like "nothing to show" — so a 0x quote failure rendered as a blank
   * space and left no trace in the log either.
   */
  let legsPreviewError: string | undefined;
  /** Breakdown lines a flow contributes itself, when it has no token/amount. */
  let extraLines: string[] = [];
  /**
   * The chosen pool's risk thresholds, read from the chain when it is picked.
   * They are governance parameters — the long pools rebalance at 0.88 and the
   * short pools at 0.90 — so they are never assumed.
   */
  let fxThresholds:
    | { rebalanceDebtRatio: bigint; liquidationDebtRatio: bigint }
    | undefined;
  /** Whether a field edit is already in flight; see `editField`. */
  let editing = false;

  const caps = () => flowCaps(cfg?.flowId ?? "");
  const findLeg = (id: string): Leg | undefined =>
    state.legs?.legs.find((l) => l.id === id);

  // The sender-privacy toggle only matters when sending to an external 0zk —
  // a self-send or a public recipient reveals a sender to nobody new.
  const ownZkLower = (): string | undefined => {
    try {
      return getCurrentRailgunAddress().toLowerCase();
    } catch {
      return undefined; // pre-boot, or no wallet loaded
    }
  };

  const isExternalZk = (address?: string): boolean => {
    const a = address?.trim().toLowerCase();
    return !!a && a.startsWith("0zk") && a !== ownZkLower();
  };

  const sendsToExternalZk = (): boolean => {
    if (!cfg) return false;
    if (cfg.multiLeg && state.legs) {
      return state.legs.legs.some((l) => isExternalZk(l.recipient));
    }
    return isExternalZk(state.address);
  };

  /** Multi-leg flows use their real legs; single-token flows get a one-leg view. */
  const legsForValidation = (): LegsState | undefined => {
    if (cfg?.multiLeg && state.legs) return state.legs;
    // A close funded by a swap does not spend `amount` of the debt token — the
    // combo unshields the WHOLE held balance of it and buys the rest with the
    // sell token, so nothing can be overspent. Validating against `amount`
    // would report the shortfall the swap exists to cover and refuse a build
    // that is correct.
    if (cfg?.amountIsPositionDebt && state.sellToken && state.token) {
      return {
        legs: [
          {
            id: "__debt",
            token: state.token,
            amount: formatUnits(state.token.amount, state.token.decimals),
          },
        ],
        seq: 1,
      };
    }
    if (state.token && state.amount) {
      return {
        legs: [{ id: "__single", token: state.token, amount: state.amount }],
        seq: 1,
      };
    }
    return undefined;
  };

  const currentOverspend = (): TokenOverspend[] => {
    const legs = legsForValidation();
    return legs ? overspentTokens(legs, feeReservation) : [];
  };

  /** The collateral the position would put up, from the slider's position. */
  const collateralAmount = (): bigint => {
    if (!state.token || state.collateralPct === undefined) return 0n;
    const pct = BigInt(Math.round(clampFraction(state.collateralPct) * 10_000));
    return (state.token.amount * pct) / 10_000n;
  };

  const collateralPriceUsd = (): number =>
    state.token ? (prices[state.token.tokenAddress.toLowerCase()] ?? 0) : 0;

  /**
   * The price of the COLLATERAL, which for a position is the pool's token
   * rather than whatever is in the token row.
   *
   * On the manage and close cards the token row is what you PAY with — fxUSD
   * when repaying — so pricing risk off it valued the debt as if it were the
   * collateral and reported a position that does not exist.
   */
  const positionCollateralPriceUsd = (): number => {
    const address = state.position?.pool.collateralToken.toLowerCase();
    if (address) return prices[address] ?? 0;
    return collateralPriceUsd();
  };

  /**
   * What the two manage sliders currently amount to, as a recipe.
   *
   * The deltas are resolved here rather than at submit so the card can show
   * the resulting risk, name the verb, and refuse an unsupported pair while
   * the sliders are still moving — instead of at the end, after a review.
   */
  const managePlan = (): FxManagePlan | undefined => {
    const held = state.position?.state;
    if (!held) return undefined;
    const collateralDelta = state.collateralPct ? collateralAmount() : 0n;
    const frac = state.debtDeltaFrac ?? 0;
    let debtDelta = 0n;
    if (frac < 0) {
      // Repay: the fraction is of the debt actually owed, so -1 is exactly it
      // and cannot overshoot into repaying more than exists.
      debtDelta = -(held.debtAmount * BigInt(Math.round(-frac * 10000))) / 10000n;
    } else if (frac > 0) {
      const ceiling = fxDebtForRatio(
        held.collateralAmount + collateralDelta,
        held.collateralDecimals,
        positionCollateralPriceUsd(),
        fxMaxOpenRatio(held.rebalanceDebtRatio),
      );
      const headroom = ceiling > held.debtAmount ? ceiling - held.debtAmount : 0n;
      debtDelta = (headroom * BigInt(Math.round(frac * 10000))) / 10000n;
    }
    return planFxManage({ collateralDelta, debtDelta });
  };

  /** Where the selected position stands before this card touches it. */
  const fxRiskBefore = (): FxRisk | undefined => {
    const held = state.position?.state;
    if (!held) return undefined;
    return fxPositionRisk({
      collateralAmount: held.collateralAmount,
      collateralDecimals: held.collateralDecimals,
      collateralPriceUsd: positionCollateralPriceUsd(),
      debtAmount: held.debtAmount,
      rebalanceDebtRatio: held.rebalanceDebtRatio,
      liquidationDebtRatio: held.liquidationDebtRatio,
    });
  };

  /**
   * The live risk of what is currently on screen.
   *
   * Two shapes. OPENING a position is collateral and debt that do not exist
   * yet, so the row values are the whole position. ADJUSTING one starts from
   * what is already there and applies the card's deltas — the resulting
   * position is the only thing worth showing, and it cannot be derived from
   * the rows alone.
   */
  const fxRisk = (): FxRisk | undefined => {
    const held = state.position?.state;
    if (held) {
      const plan = managePlan();
      const addCollateral = plan?.ok ? plan.collateralDelta : 0n;
      const debtDelta = plan?.ok
        ? plan.action === "repay"
          ? -plan.debtDelta
          : plan.debtDelta
        : 0n;
      const debtAfter = held.debtAmount + debtDelta;
      return fxPositionRisk({
        collateralAmount: held.collateralAmount + addCollateral,
        collateralDecimals: held.collateralDecimals,
        collateralPriceUsd: positionCollateralPriceUsd(),
        debtAmount: debtAfter > 0n ? debtAfter : 0n,
        rebalanceDebtRatio: held.rebalanceDebtRatio,
        liquidationDebtRatio: held.liquidationDebtRatio,
      });
    }
    if (!fxThresholds || !state.token) return undefined;
    const debt = state.debt ? parseUnits(state.debt, 18) : 0n;
    return fxPositionRisk({
      collateralAmount: collateralAmount(),
      collateralDecimals: state.token.decimals,
      collateralPriceUsd: collateralPriceUsd(),
      debtAmount: debt,
      ...fxThresholds,
    });
  };

  /**
   * Why this build cannot be sent, when the reason is not a token balance.
   *
   * Borrowing against a position spends nothing you hold, so every ordinary
   * gate passes it — but debt the collateral does not cover is the same
   * mistake as an overspend and has to be refused the same way. The ceiling is
   * the one the opening slider uses, so a position cannot be adjusted into a
   * state the builder would refuse to create.
   */
  const fxBlocker = (): string | undefined => {
    const held = state.position?.state;
    if (!held) return undefined;
    // On a close the amount is not a preference — it is the debt grossed up
    // through both fees, so there is nothing to "reduce", and the generic
    // overspend advice ("reduce the amount") builds the dust position the
    // prefill was written to prevent.
    //
    // Nor is being short unusual: mint, shield in at 25bps, then repay at the
    // pool fee and unshield out at another 25bps, and the fxUSD a position
    // minted never covers its own close. The difference is bought in the same
    // batch, so all this needs is which token to sell.
    if (cfg?.amountIsPositionDebt && !state.sellToken) {
      const [short] = currentOverspend();
      if (short) {
        const amount = fmtAmount(
          formatUnits(short.overBy, short.token.decimals),
          6,
        );
        return (
          `Short ${amount} ${short.token.symbol} — pick a token under "Sell to ` +
          `cover" and the difference is bought in this batch.`
        );
      }
    }
    const plan = managePlan();
    if (plan && !plan.ok) {
      // "nothing to change" is the untouched state, not an error to shout
      // about — the completeness gate already refuses an empty build.
      return plan.reason === "nothing to change" ? undefined : plan.reason;
    }
    if (!plan?.ok || plan.action === "repay") return undefined;
    const after = fxRisk();
    if (!after) return undefined;
    const ceiling = fxMaxOpenRatio(held.rebalanceDebtRatio);
    if (after.debtRatio <= ceiling) return undefined;
    const symbol = poolCollateralSymbol(state.position?.pool.name ?? "");
    return (
      `The collateral does not cover this much debt — it would leave the ` +
      `position at ${asPercent(after.debtRatio, 1)}, over the ${asPercent(ceiling, 1)} ` +
      `ceiling. Borrow less, or add more ${symbol}.`
    );
  };

  /**
   * Move a slider and write through to the amount it stands for.
   *
   * The sliders are an input method: `amount` and `debt` remain the only things
   * the overspend gate, the fee reservation and submit ever read, so nothing
   * downstream has to know a slider exists.
   */
  const nudge = (key: FieldKey, delta: number) => {
    if (!cfg) return;
    if (key === "collateralPct") {
      const next = clampFraction((state.collateralPct ?? 0) + delta);
      state.collateralPct = next;
      if (state.token) {
        state.amount = formatUnits(collateralAmount(), state.token.decimals);
      }
      // The debt was sized against the old collateral, so re-derive it.
      if (state.debtRatio !== undefined) nudge("debtRatio", 0);
      // Same on a manage card: more collateral raises the borrow ceiling, so
      // the same slider position means a different amount.
      if (state.debtDeltaFrac !== undefined) nudge("debtDelta", 0);
      return;
    }
    if (key === "debtDelta") {
      // Symmetric around zero, and the write-through resolves it to `debt` —
      // the only field submit reads — so nothing downstream knows the slider
      // is signed.
      const next = Math.max(-1, Math.min(1, (state.debtDeltaFrac ?? 0) + delta));
      state.debtDeltaFrac = next;
      const plan = managePlan();
      state.debt =
        plan?.ok && plan.debtDelta > 0n ? formatUnits(plan.debtDelta, 18) : undefined;
      return;
    }
    if (key === "debtRatio") {
      const ceiling = fxThresholds
        ? fxMaxOpenRatio(fxThresholds.rebalanceDebtRatio)
        : 0.5;
      const next = Math.min(ceiling, clampFraction((state.debtRatio ?? 0) + delta));
      state.debtRatio = next;
      const debt = fxDebtForRatio(
        collateralAmount(),
        state.token?.decimals ?? 18,
        collateralPriceUsd(),
        next,
      );
      state.debt = debt > 0n ? formatUnits(debt, 18) : undefined;
    }
  };

  /**
   * Ask the flow what its batch would do, once there is a complete build to
   * ask about.
   *
   * Keyed on the inputs so moving a slider does not re-quote on every keypress
   * — for a combo this reaches 0x, which is rate-limited and slow.
   */
  const computeExtraLines = async () => {
    if (!cfg?.previewLines) {
      extraLines = [];
      return;
    }
    try {
      extraLines = validate(cfg.fields, state, cfg.optionalFields).ok ? await cfg.previewLines(state) : [];
    } catch {
      extraLines = [];
    }
  };

  const computeLegsPreview = async () => {
    if (!cfg?.previewLegs) return;
    if (!validate(cfg.fields, state, cfg.optionalFields).ok) {
      // An incomplete form has no batch to fail at, so any earlier reason is
      // now about state that no longer exists.
      legsPreview = undefined;
      legsPreviewError = undefined;
      return;
    }
    const forKey = [
      state.vault?.vault.vaultAddress,
      state.pool?.pool.address,
      state.position?.nft.tokenSubID,
      state.token?.tokenAddress,
      state.buyToken?.tokenAddress,
      // Funding a close by selling something changes the whole batch, so it has
      // to invalidate the cached preview like every other input does.
      state.sellToken?.tokenAddress,
      state.amount,
      state.debt,
    ].join("|");
    if (legsPreview?.forKey === forKey) return;
    try {
      legsPreview = { legs: await cfg.previewLegs(state), forKey };
      legsPreviewError = undefined;
    } catch (error) {
      // Not fatal — the form is still editable and submit re-runs the real
      // thing. But swallowing it outright meant a failed 0x quote showed as an
      // empty space and wrote nothing to the log, so there was no way to find
      // out what went wrong short of sending.
      legsPreview = undefined;
      legsPreviewError = describeCause(error);
      log.warn(`${cfg.flowId ?? "builder"} preview failed`, error);
    }
  };

  // --- rows ------------------------------------------------------------------

  const buildRows = () => {
    if (!cfg) return;
    // The sender row only exists when the toggle would mean something.
    const fields = cfg.fields.filter(
      (f) => f !== "showSender" || sendsToExternalZk(),
    );
    if (cfg.multiLeg && state.legs) {
      const legRows: string[] = [];
      const removable = state.legs.legs.length > 1;
      state.legs.legs.forEach((leg, index) => {
        if (index > 0) legRows.push(`__legsep:${leg.id}`);
        legRows.push(`__lt:${leg.id}`, `__la:${leg.id}`, `__lr:${leg.id}`);
        if (removable) legRows.push(`__lx:${leg.id}`);
      });
      const addRow = canAddToken(state.legs, caps()) ? ["__addleg"] : [];
      rows = [...legRows, ...addRow, ...fields, "__send", "__cancel"];
    } else {
      rows = [...fields, "__send", "__cancel"];
    }
  };

  const rowDisplay = (row: string): string => {
    if (row === "__send") return tag("▸ Build & Send  (S)", "green");
    if (row === "__cancel") return tag("✕ Cancel  (Esc)", "gray");
    if (row === "__addleg") return tag("+ Add token", "yellow");
    if (row.startsWith("__legsep:")) return tag("─".repeat(28), "gray");
    if (row.startsWith("__lt:")) {
      const leg = findLeg(row.slice(5));
      const label = leg?.token
        ? `${leg.token.symbol}  (have ${fmtAmount(
            formatUnits(leg.token.amount, leg.token.decimals),
            5,
          )})`
        : "‹select token›";
      return tag(`▸ ${label}`, leg?.token ? "white" : "yellow");
    }
    if (row.startsWith("__la:")) {
      const leg = findLeg(row.slice(5));
      return `   ${tag("amount", "gray")}   ${tag(leg?.amount ?? "‹enter amount›", "cyan")}`;
    }
    if (row.startsWith("__lr:")) {
      const leg = findLeg(row.slice(5));
      return `   ${tag("to", "gray")}       ${tag(
        leg?.recipient ? short(leg.recipient) : "‹recipient›",
        "cyan",
      )}`;
    }
    if (row.startsWith("__lx:")) return tag("   ✕ remove", "gray");
    const key = row as FieldKey;
    // The sell row is the one field whose necessity depends on the balance, and
    // fieldDisplay is pure — it cannot see the shortfall. Left to itself it
    // read "none — not needed" directly above a panel saying the close is short
    // and to pick something here.
    if (key === "sellToken" && !state.sellToken) {
      const [short] = currentOverspend();
      if (short) {
        return `${FIELD_LABELS[key].padEnd(LABEL_W)}${tag("‹pick a token›", "yellow")}`;
      }
    }
    return `${FIELD_LABELS[key].padEnd(LABEL_W)}${tag(fieldDisplay(key, state), "cyan")}`;
  };

  // --- breakdown -------------------------------------------------------------

  /** The build, as the pure formatters want it. */
  const view = (): BuilderView => {
    const legs =
      cfg?.multiLeg && state.legs
        ? state.legs.legs
            .filter((l) => l.token && l.amount)
            .map((l) => ({
              token: l.token as RailgunDisplayBalance,
              amount: l.amount as string,
              recipient: l.recipient,
            }))
        : state.token && state.amount
          ? [{ token: state.token, amount: state.amount, recipient: state.address }]
          : [];
    return {
      verb: cfg?.verb ?? "",
      flowId: cfg?.flowId,
      legs,
      buyToken: state.buyToken,
      prices,
      feeBasisPoints: cfg ? getRailgunFeeBasisPoints(cfg.chainName) : undefined,
      broadcasterFee: feePreview,
    };
  };

  /**
   * The full breakdown, plus whether the build is currently sendable.
   *
   * `ok` drives the heading only. The send path re-runs the same checks itself,
   * so a stale or unrendered summary can never widen what is allowed.
   */
  const detail = (): {
    lines: string[];
    ok: boolean;
    note: string;
    overspend: boolean;
  } => {
    if (!cfg) return { lines: [], ok: false, note: "", overspend: false };
    const v = view();
    const amounts = amountLines(v);
    const lines = [...amounts.lines];
    let total = amounts.usd;
    let { haveUsd } = amounts;

    if (state.buyToken && !cfg.multiLeg) {
      lines.push(
        `${tag("buy", "gray")}    ${swapBuyLine(state.buyToken.symbol, swapPreview, (s) => fmtAmount(s, 6))}`,
      );
    }

    if (extraLines.length) {
      lines.push("");
      lines.push(...extraLines);
    }

    if (legsPreviewError) {
      lines.push("");
      lines.push(tag(`▲ cannot build this batch — ${legsPreviewError}`, "yellow"));
    }
    if (legsPreview?.legs.length) {
      lines.push("");
      lines.push(tag("this batch", "gray"));
      lines.push(...defiLegLines(legsPreview.legs, tag));
    }

    // What the position would actually be, next to the controls that set it.
    //
    // Held positions get the same block. It used to be gated on `state.pool`,
    // which only the OPEN card sets — so every card that adjusts an existing
    // position showed no risk at all, which is the one screen where the
    // consequence is the entire decision.
    const risk = fxRisk();
    const held = state.position?.state;
    // Closing is not an adjustment — the resulting position is either gone or
    // smaller in both legs, so a debt-ratio meter is the wrong answer. What it
    // owes, what comes back, and whether this finishes it are the questions.
    if (held && cfg.amountIsPositionDebt) {
      lines.push("");
      lines.push(
        ...fxCloseLines({
          state: held,
          repayAmount: state.amount ? parseUnits(state.amount, 18) : 0n,
          collateralSymbol: poolCollateralSymbol(state.position?.pool.name ?? ""),
          receiveSymbol: state.buyToken?.symbol,
          // Unknown fees read as zero here, which would previews a full close
          // for an amount that only funds a partial. Fall back to RAILGUN's
          // standing 25bps rather than to nothing.
          railgunUnshieldFeeBps:
            getRailgunFeeBasisPoints(cfg.chainName)?.unshield ?? 25n,
          format: (a, d) => fmtAmount(formatUnits(a, d), 6),
        }),
      );
    } else if (risk && held) {
      lines.push("");
      lines.push(
        ...fxRiskDeltaLines({
          before: fxRiskBefore(),
          risk,
          collateralSymbol: poolCollateralSymbol(state.position?.pool.name ?? ""),
          rebalanceDebtRatio: held.rebalanceDebtRatio,
          liquidationDebtRatio: held.liquidationDebtRatio,
        }),
      );
      // Why this cannot be sent — an unsupported pair of deltas, or debt the
      // collateral does not cover. Said here, beside the sliders that produced
      // it, rather than at submit after a review has been read and accepted.
      const blocked = fxBlocker();
      if (blocked && (state.collateralPct || state.debtDeltaFrac)) {
        lines.push(tag(`▲ ${blocked}`, "yellow"));
      }
    } else if (risk && state.pool && fxThresholds) {
      lines.push("");
      // The same view the manage card uses, with no `before` — a position
      // being opened has nothing to have moved from. Sharing it means opening
      // and adjusting read identically, rather than being two dialects of the
      // same three numbers.
      lines.push(
        ...fxRiskDeltaLines({
          risk,
          collateralSymbol: state.pool.token.symbol,
          ...fxThresholds,
        }),
      );
    }

    lines.push("");
    lines.push(`${tag("Fee", "gray")}    ${feeLabel(state.fee)}`);
    if (state.fee?.kind === "broadcaster" && feePreview) {
      lines.push(`   ${tag(`~${feePreview.text}`, "gray")}`);
      if (feePreview.usd !== undefined) {
        total += feePreview.usd;
        haveUsd = true;
      }
    }
    lines.push(`${tag("Gas", "gray")}    ${gasLabel(state.gas)}`);
    if (cfg.fields.includes("showSender") && sendsToExternalZk()) {
      lines.push(
        `${tag("Sender", "gray")} ${state.showSender ? "shown to recipient" : "hidden (private)"}`,
      );
    }

    const protocol = protocolFeeLines(v);
    if (protocol.lines.length) {
      lines.push(tag("RAILGUN protocol fee", "yellow"));
      lines.push(...protocol.lines);
      total += protocol.usd;
      if (protocol.usd > 0) haveUsd = true;
    }

    if (haveUsd) {
      const inclFees = state.fee?.kind === "broadcaster" || protocol.usd > 0;
      lines.push(
        `${tag("Total", "gray")}  ~${formatUSD(total)}${inclFees ? tag(" (incl. fees)", "gray") : ""}`,
      );
    }

    // Advisory only: spending against a partially-synced tree risks a failed
    // proof, but the balances it would spend are real. Warn, do not block.
    const s = getState();
    const synced =
      treeSynced({ leaves: s.utxoLeaves, progress: s.utxoProgress, ready: s.utxoReady }) &&
      treeSynced({ leaves: s.txidLeaves, progress: s.txidProgress, ready: s.txidReady });
    if (cfg.fields.includes("fee") && !synced) {
      lines.unshift(
        tag("▲ not fully synced — proof may fail; rescan if it does", "yellow"),
      );
    }

    const over = currentOverspend();
    const overText = (o: TokenOverspend) =>
      `overspends ${o.token.symbol} by ${fmtAmount(formatUnits(o.overBy, o.token.decimals), 6)}`;
    // At the top, so it is visible without scrolling the panel.
    if (over.length) {
      // A close that cannot be afforded is a dead end unless the screen names
      // the way out: submit refuses, and the only remedy the user can reach
      // from here is the other card. Said beside the overspend rather than
      // held back until Build & Send.
      const remedy = cfg.amountIsPositionDebt ? fxBlocker() : undefined;
      lines.unshift(
        ...over.map((o) => tag(`▲ ${overText(o)}`, "red")),
        ...(remedy ? [tag(remedy, "yellow")] : []),
        "",
      );
    }

    let ok: boolean;
    let note = "";
    if (cfg.multiLeg && state.legs) {
      const legValidation = validateLegs(state.legs, caps());
      const fieldValidation = validate(cfg.fields, state, cfg.optionalFields);
      ok = legValidation.ok && fieldValidation.ok;
      note =
        legValidation.violations[0] ??
        (legValidation.ok ? "" : `complete ${legValidation.missing.length} leg(s)`);
    } else {
      const fieldValidation = validate(cfg.fields, state, cfg.optionalFields);
      ({ ok } = fieldValidation);
      note = ok ? "" : `need: ${fieldValidation.missing.join(", ")}`;
    }

    // An overspend blocks regardless of field completeness, and takes the note.
    const overspend = over.length > 0;
    if (overspend) {
      ok = false;
      note = overText(over[0]);
    }
    return { lines, ok, note, overspend };
  };

  const renderBuilder = () => {
    if (!cfg) return;
    center.setLabel(` ${cfg.title} `);
    list.setItems(rows.map(rowDisplay));
    const { lines, ok, note, overspend } = detail();
    const head = overspend
      ? tag(`${cfg.verb} · ▲ ${note}`, "red")
      : ok
        ? tag(`${cfg.verb} · ready`, "green")
        : tag(`${cfg.verb}${note ? ` · ${note}` : ""}`, "yellow");
    summary.setContent(
      [
        head,
        ...lines,
        tag("↑/↓ row · Enter edit · S review+send · Esc home", "gray"),
      ].join("\n"),
    );
  };

  // --- previews --------------------------------------------------------------

  /**
   * Re-quote the swap output. Discrete — once per field edit, not per keystroke
   * — and error-guarded, so an unreachable quote degrades to the placeholder
   * rather than blanking the panel.
   */
  const computeSwapPreview = async () => {
    swapPreview = undefined;
    if (!cfg || cfg.verb !== "Swap") return;
    if (!state.token || !state.buyToken || !state.amount) return;
    try {
      const isPublic = !cfg.fields.includes("fee");
      // The cached key, never a prompt: a private swap's quote needs it to
      // derive the 7702 taker address, but stopping to ask for a password while
      // someone is typing an amount is not acceptable. Locked wallet, no
      // preview — which is what the placeholder is for.
      const { inputs } = await buildSwapInputs(
        cfg.chainName,
        state.token,
        state.buyToken,
        state.amount,
        isPublic,
        getCachedEncryptionKey(),
      );
      if (inputs?.readableSwapPrices) {
        swapPreview = toSwapPreview(inputs.readableSwapPrices);
      }
      // Kept so the send proves against the quote that was reviewed, rather
      // than a second one fetched after the user has already approved.
      if (inputs?.quote) {
        state.swapQuote = { inputs, forKey: swapQuoteKey(state), at: Date.now() };
      }
    } catch {
      swapPreview = undefined;
      state.swapQuote = undefined;
    }
  };

  /** The per-gas price this build is priced at, including a chosen tier. */
  const currentGasPrice = async (): Promise<bigint | undefined> => {
    if (!cfg) return undefined;
    try {
      const fee = await getFeeDetailsForChain(cfg.chainName);
      return fee?.maxFeePerGas ?? fee?.gasPrice ?? undefined;
    } catch {
      return undefined; // no fee oracle: leave the amount unrestricted
    }
  };

  /**
   * What the overspend model holds back: a broadcaster fee, or — for a flow
   * whose gas comes out of the balance it spends — that gas. The two never
   * apply to the same flow, since a base-token send has no fee field.
   */
  const computeFeePreview = async () => {
    feePreview = undefined;
    feeReservation = undefined;
    if (!cfg) return;
    if (cfg.gasFromBalance) {
      feeReservation = gasReservationFor(
        // The native leg is marked with the sentinel; a fixed-token base flow
        // carries the wrapped address the gas balance is reported under.
        cfg.multiLeg ? NATIVE_SENTINEL : state.token?.tokenAddress,
        cfg.gasUnitsHint,
        await currentGasPrice(),
      );
      return;
    }
    if (state.fee?.kind !== "broadcaster") return;
    const { broadcaster } = state.fee;
    const approx = await approxBroadcasterFee(
      broadcaster,
      cfg.chainName,
      cfg.gasUnitsHint,
      cfg.relayAdapt ?? false,
    );
    if (!approx) return;
    // Reserve the estimated fee against the same-token balance so the overspend
    // check accounts for it. The exact fee is recomputed at send; this is the
    // selection-time estimate, which is why it is allowed to be approximate.
    feeReservation = {
      tokenAddress: broadcaster.tokenAddress,
      amount: approx.amount,
      // Only when we know it. A fee token missing from this list is not
      // evidence of a zero balance — the broadcaster's fee-token list is built
      // from its own query — and inventing one would refuse a send that is
      // fine. Absent simply means the check this enables does not run.
      token: loadedBalances.find((b) =>
        b.tokenAddress.toLowerCase() === broadcaster.tokenAddress.toLowerCase(),
      ),
    };
    const usd = balanceUSD(
      {
        tokenAddress: broadcaster.tokenAddress,
        amount: approx.amount,
        decimals: approx.decimals,
      },
      prices,
    );
    feePreview = {
      text: `${fmtAmount(formatUnits(approx.amount, approx.decimals), 6)} ${approx.symbol}${
        usd !== undefined ? `  (${formatUSD(usd)})` : ""
      }`,
      usd,
    };
  };

  // --- open / close ----------------------------------------------------------

  const openBuilder = async (flowId: string, seed?: RailgunDisplayBalance) => {
    const make = txBuilderConfigs[flowId];
    if (!make) return;
    cfg = make(getCurrentNetwork());
    state = { gas: undefined };
    swapPreview = undefined;
    // Everything derived from the LAST flow has to go, or the new one opens
    // showing the previous action's batch and risk until an edit happens to
    // recompute them — which reads as a description of what you are about to do.
    legsPreview = undefined;
    legsPreviewError = undefined;
    extraLines = [];
    fxThresholds = undefined;
    feePreview = undefined;
    feeReservation = undefined;
    loadedBalances = [];
    // Not derived state but a latch, and it belongs here for the same reason:
    // closing a flow while a field edit is still awaiting leaves it set, and
    // the next flow would open with every field refusing to edit.
    editing = false;

    // Best-effort: USD figures are an aid, and a price outage must not stop a
    // send. Unknown tokens simply show no USD.
    prices = {};
    try {
      if (cfg.loadTokens) {
        const tokens = await cfg.loadTokens();
        loadedBalances = tokens;
        seed = resolveSeedToken(seed, tokens);
        prices = await getTokenPricesUSD(
          cfg.chainName,
          tokens.map((t) => t.tokenAddress).filter((a) => a !== "native"),
        );
      }
    } catch {
      prices = {};
    }

    if (cfg.fields.includes("fee")) {
      state.fee = await resolveDefaultFeeAsync(cfg.chainName, cfg.relayAdapt ?? false);
      await computeFeePreview();
    }
    // The sender toggle mirrors the persisted global setting, which is what gets
    // read at proof time; editing the row writes back to it.
    if (cfg.fields.includes("showSender")) state.showSender = shouldShowSender();
    if (cfg.defaultAddress) state.address = cfg.defaultAddress;

    if (cfg.multiLeg) {
      let legs = initLegs();
      const flow = caps();
      if (seed) legs = setLegField(legs, legs.legs[0].id, "token", seed);
      if (flow.recipientDefaultOwn) {
        try {
          legs = setSharedRecipient(legs, getCurrentRailgunAddress());
        } catch {
          /* pre-boot: leave the recipient for the user */
        }
      }
      state.legs = legs;
    } else {
      // Sync or async depending on the flow, and allowed to fail: a base-token
      // lookup that throws leaves the field empty rather than the builder shut.
      const { fixedToken } = cfg;
      if (fixedToken) {
        try {
          state.token = await fixedToken();
        } catch {
          state.token = undefined;
        }
      }
      if (cfg.fixedAddress) state.address = cfg.fixedAddress;
      if (seed && cfg.fields.includes("token")) state.token = seed;
    }

    // Needs the token, so it runs after the leg/fixed-token resolution above.
    if (cfg.gasFromBalance) await computeFeePreview();

    buildRows();
    list.show();
    summary.show();
    list.focus();
    ctx.render();
  };

  const closeBuilder = () => {
    // The override is per build. Left set, it would price the next one.
    clearGasFeeSelection();
    cfg = undefined;
    list.hide();
    summary.hide();
    host.onClose();
  };

  // --- editing ---------------------------------------------------------------

  /**
   * Suggestions first (your own wallets, the active one highlighted), then
   * contacts, then manual entry — which is checked for a kind mismatch before it
   * can become a stuck or wrong recipient.
   */
  const pickRecipient = async (kind: "0x" | "0zk"): Promise<string | undefined> => {
    const provider = getInputProvider();
    const options = recipientOptions(kind);
    const choice = await provider.select(`Recipient (${kind})`, [
      ...options.map((o) => ({
        label:
          o.kind === "this-wallet"
            ? tag(o.label, "green")
            : o.kind === "your-wallet"
              ? tag(o.label, "cyan")
              : o.label,
        value: o.address,
        hint:
          o.kind === "contact" ? short(o.address) : `suggested · ${short(o.address)}`,
      })),
      { label: "Enter address manually…", value: "__manual", hint: kind },
    ]);
    if (!choice) return undefined;
    if (choice === "__manual") {
      const entered = await provider.input(`Recipient ${kind} address`, {
        hint: kind === "0zk" ? "RAILGUN 0zk… address" : "Ethereum 0x… address",
      });
      if (entered === undefined) return undefined;
      const err = addressKindError(kind, entered);
      if (err) {
        provider.notify(err);
        return undefined;
      }
      return entered.trim();
    }
    return choice;
  };

  /** Each leg field is edited in place, so a mutation only needs a re-draw. */
  const refreshLegs = () => {
    buildRows();
    list.focus();
    ctx.render();
  };

  const editLegToken = async (id: string) => {
    if (!cfg?.loadTokens || !state.legs) return;
    const provider = getInputProvider();
    const balances = await cfg.loadTokens();
    if (!balances.length) return provider.notify("No token balances available.");
    const kind = nativeKindFor(cfg.flowId);
    const address = await provider.select(
      "Select token",
      balances.map((b) => ({
        label: isNativeChoice(b) ? `${b.symbol} (native)` : b.symbol,
        value: b.tokenAddress,
        hint: isNativeChoice(b)
          ? nativeTokenLabel(kind)
          : formatUnits(b.amount, b.decimals),
      })),
    );
    const token = balances.find((b) => b.tokenAddress === address);
    if (token) {
      state.legs = setLegField(state.legs, id, "token", token);
      refreshLegs();
    }
  };

  /**
   * Says why the spendable figure is short of the balance, when it is because
   * gas was held back. Without it a base-token "max" reads as a wrong number.
   */
  /**
   * What a fee is holding back from THIS token, so a spendable figure that has
   * been reduced says why it was.
   *
   * It used to speak only for flows whose GAS comes out of the balance, which
   * left the commonest case silent: a broadcaster fee in the same token you
   * are sending. On a swap — 2.6M gas of cross-contract — that fee can be the
   * whole balance, and the amount field said "spendable 0" and nothing else.
   * It also names the way out, because there is one and it is not obvious:
   * the fee can be paid in a different token.
   *
   * Denominated in the TOKEN's decimals, not the chain's gas decimals: a
   * reservation is held against the token it is reserved from.
   */
  const reservedNote = (token: RailgunDisplayBalance): string => {
    const held = feeReserved(feeReservation, token.tokenAddress);
    if (held <= 0n) return "";
    const amount = fmtAmount(formatUnits(held, token.decimals), 6);
    return cfg?.gasFromBalance
      ? ` (${amount} held for gas)`
      : ` (${amount} held for the fee — pay it in another token to free this)`;
  };

  const editLegAmount = async (id: string) => {
    if (!state.legs) return;
    const leg = findLeg(id);
    // The hint is this leg's headroom: balance, minus the other legs, minus a
    // same-token fee — so "max" and the number shown agree.
    let hint: { hint: string } | undefined;
    if (leg?.token) {
      const expected = expectedBalance(leg.token, state.legs, {
        editingLegId: id,
        fee: feeReservation,
      });
      hint = {
        hint: `spendable ${fmtAmount(
          formatUnits(expected > 0n ? expected : 0n, leg.token.decimals),
          6,
        )} ${leg.token.symbol}${reservedNote(leg.token)} · type "max"`,
      };
    }
    let amount = await getInputProvider().input(
      `Amount${leg?.token ? ` of ${leg.token.symbol}` : ""}`,
      hint,
    );
    if (amount && leg?.token && /^(max|all)$/i.test(amount.trim())) {
      amount = maxAmount(leg.token, state.legs, {
        editingLegId: id,
        fee: feeReservation,
      });
    }
    if (amount) {
      state.legs = setLegField(state.legs, id, "amount", amount);
      refreshLegs();
    }
  };

  const editLegRecipient = async (id: string) => {
    if (!state.legs) return;
    const flow = caps();
    const address = await pickRecipient(flow.recipientKind);
    if (address) {
      // Single-recipient flows (unshield) share one recipient across every leg:
      // that is the privacy guarantee, not a convenience.
      state.legs =
        flow.maxRecipients === 1
          ? setSharedRecipient(state.legs, address)
          : setLegField(state.legs, id, "recipient", address);
      refreshLegs();
    }
  };

  const removeLegRow = (id: string) => {
    if (!state.legs) return;
    state.legs = removeLeg(state.legs, id);
    refreshLegs();
  };

  const addLeg = () => {
    if (!state.legs) return;
    const flow = caps();
    state.legs = addToken(state.legs, flow);
    if (flow.maxRecipients === 1) {
      const shared = state.legs.legs.map((l) => l.recipient).find((r) => r?.trim());
      if (shared) state.legs = setSharedRecipient(state.legs, shared);
    }
    refreshLegs();
  };

  const runFieldEdit = async (key: FieldKey) => {
    if (!cfg) return;
    const provider = getInputProvider();
    if (key === "token" && cfg.loadTokens) {
      const balances = await cfg.loadTokens();
      if (!balances.length) provider.notify("No token balances available.");
      else {
        const address = await provider.select(
          "Select token",
          balances.map((b) => ({
            label: b.symbol,
            value: b.tokenAddress,
            hint: formatUnits(b.amount, b.decimals),
          })),
        );
        if (address) state.token = balances.find((b) => b.tokenAddress === address);
      }
    } else if (key === "sellToken" && cfg.loadSellTokens) {
      const choices = await cfg.loadSellTokens();
      if (!choices.length) provider.notify("No tokens available to sell.");
      else {
        const address = await provider.select(
          "Sell to cover the shortfall",
          choices.map((b) => ({ label: b.symbol, value: b.tokenAddress, hint: b.name })),
        );
        if (address) state.sellToken = choices.find((b) => b.tokenAddress === address);
      }
    } else if (key === "buyToken" && cfg.loadBuyTokens) {
      const tokens = await cfg.loadBuyTokens();
      const sell = state.token?.tokenAddress;
      const choices = tokens.filter((b) => b.tokenAddress !== sell);
      if (!choices.length) provider.notify("No tokens available to swap into.");
      else {
        const address = await provider.select(
          "Swap into",
          choices.map((b) => ({ label: b.symbol, value: b.tokenAddress, hint: b.name })),
        );
        if (address) state.buyToken = choices.find((b) => b.tokenAddress === address);
      }
    } else if (key === "vault" && cfg.loadVaults) {
      const choices = await cfg.loadVaults();
      if (!choices.length) provider.notify("No vaults available on this network.");
      else {
        const picked = await provider.select(
          "Select vault",
          choices.map((c) => ({
            label: c.vault.name,
            value: c.vault.vaultAddress,
            // What it pays comes first: for two vaults on the same asset it is
            // the only thing that distinguishes them.
            hint:
              (c.yield !== undefined ? `${(c.yield * 100).toFixed(2)}% · ` : "") +
              `${fmtAmount(formatUnits(c.token.amount, c.token.decimals), 6)} ${c.token.symbol}`,
          })),
        );
        const choice = choices.find((c) => c.vault.vaultAddress === picked);
        if (choice) {
          // The vault decides the token, so picking one also settles what the
          // amount field, the overspend check and the fee reservation measure.
          state.vault = choice;
          state.token = choice.token;
          state.amount = undefined;
        }
      }
    } else if (key === "pool" && cfg.loadPools) {
      const choices = await cfg.loadPools();
      if (!choices.length) provider.notify("No f(x) pools available on this network.");
      else {
        const picked = await provider.select(
          "Select pool",
          choices.map((c) => ({
            label: c.pool.name,
            value: c.pool.address,
            hint: `${formatUnits(c.token.amount, c.token.decimals)} ${c.token.symbol}`,
          })),
        );
        const choice = choices.find((c) => c.pool.address === picked);
        if (choice) {
          // The pool decides the collateral, so picking one also settles what
          // the amount field and the overspend check measure.
          state.pool = choice;
          state.token = choice.token;
          state.amount = undefined;
          state.collateralPct = undefined;
          state.debt = undefined;
          state.debtRatio = undefined;
          // Its rebalance and liquidation ratios are what the risk meter is
          // drawn against; without them the sliders have no scale, so this is
          // read rather than defaulted.
          fxThresholds = await getFxPool(
            choice.pool.name,
            getProviderForChain(cfg.chainName),
          )
            .then((pool) => ({
              rebalanceDebtRatio: pool.rebalanceDebtRatio,
              liquidationDebtRatio: pool.liquidationDebtRatio,
            }))
            .catch(() => undefined);
          if (!fxThresholds) {
            provider.notify(
              "Could not read the pool's risk thresholds — the position meter is unavailable.",
            );
          }
        }
      }
    } else if (key === "position" && cfg.loadPositions) {
      const choices = await cfg.loadPositions();
      if (!choices.length) {
        // Positions come from the shielded NFT set, so an unscanned wallet has
        // none yet — worth saying, since "none" and "not scanned" look alike.
        provider.notify("No positions held on this network.");
      } else {
        const picked = await provider.select(
          "Select position",
          // The pool name was the hint, which every row shares and so tells
          // you nothing. What distinguishes two positions is their state.
          choices.map((c) => ({
            label: c.nft.label,
            value: c.nft.tokenSubID,
            // Budgeted against the modal it renders in: 82% of the screen,
            // less borders and padding, less the label column every row shares.
            hint: fxPositionSummary(
              c.state,
              poolCollateralSymbol(c.pool.name),
              (a, d) => fmtAmount(formatUnits(a, d), 4),
              Math.max(
                18,
                Math.min(110, Math.floor(((ctx.screen.width as number) || 80) * 0.82)) -
                  6 -
                  Math.max(...choices.map((x) => x.nft.label.length)),
              ),
            ),
          })),
        );
        const choice = choices.find((c) => c.nft.tokenSubID === picked);
        if (choice) {
          state.position = choice;
          // Closing fully is what "close" means, so offer it. The debt is not
          // shown anywhere the user could have copied it from, which made the
          // commonest action the one requiring a lookup.
          if (cfg.amountIsPositionDebt && choice.state) {
            // The amount needed to close OUTRIGHT, not the bare debt. Both fees
            // come off before the repay lands, so prefilling the debt itself
            // guaranteed a partial close on the commonest action — which is how
            // a position ends up as dust nobody meant to leave.
            state.amount = formatUnits(
              debtTokenForFullClose({
                debt: choice.state.debtAmount,
                repayFeeRatio: choice.state.repayFeeRatio,
                railgunUnshieldFeeBps:
                  getRailgunFeeBasisPoints(cfg.chainName)?.unshield ?? 25n,
              }),
              18,
            );
          }
          // Its pool decides the collateral and the risk thresholds, exactly as
          // picking a pool does when opening.
          fxThresholds = await getFxPool(
            choice.pool.name,
            getProviderForChain(cfg.chainName),
          )
            .then((pool) => ({
              rebalanceDebtRatio: pool.rebalanceDebtRatio,
              liquidationDebtRatio: pool.liquidationDebtRatio,
            }))
            .catch(() => undefined);
        }
      }
    } else if (key === "account" && cfg.loadAccounts) {
      const choices = await cfg.loadAccounts();
      if (!choices.length) {
        provider.notify("Nothing stranded on any recent ephemeral account.");
      } else {
        const picked = await provider.select(
          "Recover from",
          choices.map((c) => ({
            label: `[${c.index}] ${short(c.address)}`,
            value: String(c.index),
            hint: c.summary,
          })),
        );
        const choice = choices.find((c) => String(c.index) === picked);
        if (choice) state.account = choice;
      }
    } else if (key === "debt") {
      const debt = await provider.input("Amount of fxUSD to mint", {
        hint: "the debt this position will owe, before the pool's borrow fee",
      });
      if (debt) state.debt = debt;
    } else if (key === "amount") {
      const single: LegsState = { legs: [{ id: "__single", token: state.token }], seq: 1 };
      let hint: { hint: string } | undefined;
      if (state.token) {
        const expected = expectedBalance(state.token, single, {
          editingLegId: "__single",
          fee: feeReservation,
        });
        hint = {
          hint: `spendable ${fmtAmount(
            formatUnits(expected > 0n ? expected : 0n, state.token.decimals),
            6,
          )} ${state.token.symbol}${reservedNote(state.token)} · type "max"`,
        };
      }
      let amount = await provider.input(
        `Amount${state.token ? ` of ${state.token.symbol}` : ""}`,
        hint,
      );
      if (amount && state.token && /^(max|all)$/i.test(amount.trim())) {
        amount = maxAmount(state.token, single, {
          editingLegId: "__single",
          fee: feeReservation,
        });
      }
      if (amount) state.amount = amount;
    } else if (key === "address") {
      const kind = /0zk/i.test(cfg.addressLabel ?? "") ? "0zk" : "0x";
      const address = await pickRecipient(kind);
      if (address) state.address = address;
    } else if (key === "memo") {
      const memo = await provider.input("Memo (optional)");
      if (memo !== undefined) state.memo = memo;
    } else if (key === "gas") {
      // A relay-adapt flow is submitted as type 4, which is 1559-priced
      // whatever the chain's default is. Offering legacy presets on a legacy
      // chain would give it a gasPrice it cannot carry.
      const gas = await collectGasSelection(
        cfg.chainName,
        cfg.relayAdapt ? EVMGasType.Type4 : evmGasTypeForChain(cfg.chainName),
        cfg.gasUnitsHint,
        cfg.gasSymbol,
        cfg.gasDecimals,
      );
      if (gas !== undefined) {
        state.gas = gas;
        // Also install it as the per-build override that getFeeDetailsForChain
        // reads, so the gas estimate and the broadcaster fee quote — which
        // scales with the gas price — are both priced from the chosen speed
        // rather than from raw network estimates.
        if (gas !== "keep") {
          const price = priceField(gas);
          setGasFeeSelection(cfg.chainName, {
            gasPrice: price,
            maxFeePerGas: price,
            maxPriorityFeePerGas:
              gas.evmGasType === EVMGasType.Type2 ? gas.maxPriorityFeePerGas : 0n,
          } as FeeData);
        }
        // A faster tier costs more gas, and for these flows that gas comes out
        // of the amount being sent — so what is spendable just changed.
        if (cfg.gasFromBalance) await computeFeePreview();
      }
    } else if (key === "fee") {
      const fee = await collectFeeMode(
        cfg.chainName,
        cfg.relayAdapt ?? false,
        cfg.gasUnitsHint,
      );
      if (fee !== undefined) {
        state.fee = fee;
        await computeFeePreview();
      }
    } else if (key === "showSender") {
      toggleShouldShowSender();
      state.showSender = shouldShowSender();
    }

    // Anything that moves the quote invalidates the cached buy amount.
    if (
      cfg.verb === "Swap" &&
      (key === "token" || key === "buyToken" || key === "amount" || key === "address")
    ) {
      await computeSwapPreview();
    }
    await computeLegsPreview();
    await computeExtraLines();
    buildRows();
    list.focus();
    ctx.render();
  };

  /**
   * What a field says while its options are being fetched.
   *
   * Only the ones that go to the network. The rest open a prompt immediately
   * and would just flicker a message nobody can read.
   */
  const loadingNote = (key: FieldKey): string | undefined => {
    switch (key) {
      case "token":
        return "Reading balances…";
      case "buyToken":
        return "Loading swap targets…";
      case "vault":
        return "Reading Morpho vaults…";
      case "pool":
        return "Reading f(x) pools…";
      case "position":
        return "Reading positions…";
      case "account":
        return "Scanning recent ephemeral accounts…";
      default:
        return undefined;
    }
  };

  /**
   * One field edit at a time, and never in silence.
   *
   * The row handler fires this and forgets it. Some loaders are slow — the
   * recovery picker scans every recent ephemeral account before it can offer a
   * list — and with no guard a second Enter starts a second scan alongside the
   * first, while with no status the pane simply sits there. Both together are
   * why opening a field read as the screen having locked up.
   */
  const editField = async (key: FieldKey) => {
    if (editing) return;
    editing = true;
    const note = loadingNote(key);
    if (note !== undefined) {
      setStatusMessage(note);
      ctx.render();
    }
    try {
      await runFieldEdit(key);
    } finally {
      editing = false;
    }
  };

  // --- send ------------------------------------------------------------------

  /** The same breakdown the panel shows, as a modal that must be accepted. */
  const showReviewModal = (): Promise<boolean> =>
    new Promise((resolve) => {
      let done: (confirmed: boolean) => void = () => undefined;
      const { lines } = detail();
      const { box, guardFocus, close } = createModal(blessed, ctx.screen, {
        title: `Review · ${cfg?.verb ?? "Transaction"}`,
        widthPct: 78,
        height: Math.min((ctx.screen.height as number) - 4, lines.length + 6),
        accent: "cyan",
        footer: "Enter / y confirm · Esc / n cancel",
        onDismiss: () => done(false),
      });
      blessed.box({
        parent: box,
        top: 0,
        left: 1,
        right: 1,
        bottom: 2,
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        keys: true,
        mouse: true,
        scrollbar: { ch: " ", style: { bg: "green" } },
        content: lines.join("\n"),
      });
      const confirm = blessed.box({
        parent: box,
        bottom: 1,
        left: 1,
        width: 13,
        height: 1,
        tags: true,
        mouse: true,
        clickable: true,
        autoFocus: false, // a button triggers; it must never hold the keys
        content: "{center}[ Confirm ]{/}",
        style: { bg: "green", fg: "black", hover: { bg: "white" } },
      });
      const cancel = blessed.box({
        parent: box,
        bottom: 1,
        left: 15,
        width: 12,
        height: 1,
        tags: true,
        mouse: true,
        clickable: true,
        autoFocus: false, // a button triggers; it must never hold the keys
        content: "{center}[ Cancel ]{/}",
        style: { bg: "red", fg: "white", hover: { bg: "white", fg: "black" } },
      });
      done = (confirmed: boolean) => {
        close();
        resolve(confirmed);
      };
      confirm.on("click", () => done(true));
      cancel.on("click", () => done(false));
      box.key(["enter", "y"], () => done(true));
      box.key(["escape", "n", "q"], () => done(false));
      guardFocus(box);
      box.focus();
      ctx.screen.render();
    });

  const trySend = async () => {
    if (!cfg) return;

    // Completeness, then overspend — decided from state, not from whatever the
    // summary last rendered.
    const gate = preflight({
      fields: cfg.fields,
      optionalFields: cfg.optionalFields,
      state,
      legs: cfg.multiLeg ? state.legs : undefined,
      caps: cfg.multiLeg ? caps() : undefined,
      overspend: currentOverspend(),
      blocker: fxBlocker(),
    });
    if (!gate.ok) return getInputProvider().notify(gate.message);

    // Then review, then a fresh password. Every send from this branch is a real
    // broadcast, so re-auth is unconditional: an unlocked terminal is not
    // consent to spend.
    const confirmed = await showReviewModal();
    if (!confirmed) {
      list.focus();
      ctx.screen.render();
      return;
    }
    if (requireReauthBeforeSend({ isSimulation: false })) {
      const authorised = await confirmPassword().catch(() => false);
      if (!authorised) {
        setStatusMessage("Send cancelled — password did not match.");
        list.focus();
        ctx.screen.render();
        return;
      }
    }

    // Captured before closing: closing clears them, and the submit is async.
    const active = cfg;
    const submitted = state;
    closeBuilder();
    setStatusMessage(`${active.verb}…`);
    const result = await active
      .submit(submitted)
      .catch((err: Error) => ({ ok: false, error: err.message }));
    if (!result.ok && result.error && !["simulated", "cancelled"].includes(result.error)) {
      setStatusMessage(`Failed: ${result.error}`);
    } else if (result.ok) {
      setStatusMessage(`${active.verb} sent.`);
      void ctx.refreshBalances();
      void ctx.refreshHistory();
    }
  };

  /**
   * Sliders adjust in place rather than opening a prompt.
   *
   * Enter still opens the typed editor, because "40%" and "exactly 1.5 wstETH"
   * are both things people mean. Coarse by default, fine with shift, so a
   * position can be dialled in without arrowing forty times.
   */
  const sliderKey = (delta: number) => () => {
    const row = rows[(list as unknown as { selected: number }).selected];
    if (row !== "collateralPct" && row !== "debtRatio" && row !== "debtDelta") return;
    nudge(row, delta);
    buildRows();
    void computeFeePreview();
    // The batch changes with the amounts, so the breakdown has to follow.
    void computeLegsPreview().then(() => {
      buildRows();
      ctx.render();
    });
    ctx.render();
  };
  list.key(["right"], sliderKey(0.05));
  list.key(["left"], sliderKey(-0.05));
  list.key(["S-right"], sliderKey(0.01));
  list.key(["S-left"], sliderKey(-0.01));

  list.on("select", (_item: unknown, index: number) => {
    const row = rows[index];
    if (row === undefined) return;
    if (row === "__send") void trySend();
    else if (row === "__cancel") closeBuilder();
    else if (row === "__addleg") addLeg();
    else if (row.startsWith("__legsep:")) return; // a separator, not a control
    else if (row.startsWith("__lt:")) void editLegToken(row.slice(5));
    else if (row.startsWith("__la:")) void editLegAmount(row.slice(5));
    else if (row.startsWith("__lr:")) void editLegRecipient(row.slice(5));
    else if (row.startsWith("__lx:")) removeLegRow(row.slice(5));
    else void editField(row as FieldKey);
  });

  return {
    open: openBuilder,
    close: closeBuilder,
    render: renderBuilder,
    send: () => void trySend(),
    isOpen: () => cfg !== undefined,
  };
};
