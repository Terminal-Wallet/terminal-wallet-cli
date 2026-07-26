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
import { getState, setState } from "../store";
import { getInputProvider } from "../../core/input";
import { tag, short } from "../format/tags";
import { fmtAmount } from "../format/deck";
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
  maxAmount,
} from "../../flows/balance";
import {
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
import { evmGasTypeForChain } from "../../railgun/gas/gas-selection";

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
  amount: "Amount",
  address: "Recipient",
  memo: "Memo",
  gas: "Gas",
  fee: "Fee",
  showSender: "Sender",
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
  let swapPreview: SwapQuotePreview | undefined;

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
    if (row === "__send") return tag("▶ Build & Send  (S)", "green");
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
    return `${FIELD_LABELS[key].padEnd(12)}${tag(fieldDisplay(key, state), "cyan")}`;
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
    if (cfg.fields.includes("fee") && !(s.utxoReady && s.txidReady)) {
      lines.unshift(
        tag("⚠ not fully synced — proof may fail; rescan if it does", "yellow"),
      );
    }

    const over = currentOverspend();
    const overText = (o: TokenOverspend) =>
      `overspends ${o.token.symbol} by ${fmtAmount(formatUnits(o.overBy, o.token.decimals), 6)}`;
    // At the top, so it is visible without scrolling the panel.
    if (over.length) {
      lines.unshift(...over.map((o) => tag(`⚠ ${overText(o)}`, "red")), "");
    }

    let ok: boolean;
    let note = "";
    if (cfg.multiLeg && state.legs) {
      const legValidation = validateLegs(state.legs, caps());
      const fieldValidation = validate(cfg.fields, state);
      ok = legValidation.ok && fieldValidation.ok;
      note =
        legValidation.violations[0] ??
        (legValidation.ok ? "" : `complete ${legValidation.missing.length} leg(s)`);
    } else {
      const fieldValidation = validate(cfg.fields, state);
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
      ? tag(`${cfg.verb} · ⚠ ${note}`, "red")
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

  const computeFeePreview = async () => {
    feePreview = undefined;
    feeReservation = undefined;
    if (!cfg || state.fee?.kind !== "broadcaster") return;
    const { broadcaster } = state.fee;
    const approx = await approxBroadcasterFee(
      broadcaster,
      cfg.chainName,
      cfg.gasUnitsHint,
    );
    if (!approx) return;
    // Reserve the estimated fee against the same-token balance so the overspend
    // check accounts for it. The exact fee is recomputed at send; this is the
    // selection-time estimate, which is why it is allowed to be approximate.
    feeReservation = {
      tokenAddress: broadcaster.tokenAddress,
      amount: approx.amount,
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
    feePreview = undefined;
    feeReservation = undefined;

    // Best-effort: USD figures are an aid, and a price outage must not stop a
    // send. Unknown tokens simply show no USD.
    prices = {};
    try {
      if (cfg.loadTokens) {
        const tokens = await cfg.loadTokens();
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

    buildRows();
    list.show();
    summary.show();
    list.focus();
    ctx.render();
  };

  const closeBuilder = () => {
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
        )} ${leg.token.symbol} · type "max"`,
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

  const editField = async (key: FieldKey) => {
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
          )} ${state.token.symbol} · type "max"`,
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
      const gas = await collectGasSelection(
        cfg.chainName,
        evmGasTypeForChain(cfg.chainName),
        cfg.gasUnitsHint,
        cfg.gasSymbol,
        cfg.gasDecimals,
      );
      if (gas !== undefined) state.gas = gas;
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
    buildRows();
    list.focus();
    ctx.render();
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
      state,
      legs: cfg.multiLeg ? state.legs : undefined,
      caps: cfg.multiLeg ? caps() : undefined,
      overspend: currentOverspend(),
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
        setState({ status: "Send cancelled — password did not match." });
        list.focus();
        ctx.screen.render();
        return;
      }
    }

    // Captured before closing: closing clears them, and the submit is async.
    const active = cfg;
    const submitted = state;
    closeBuilder();
    setState({ status: `${active.verb}…` });
    const result = await active
      .submit(submitted)
      .catch((err: Error) => ({ ok: false, error: err.message }));
    if (!result.ok && result.error && !["simulated", "cancelled"].includes(result.error)) {
      setState({ status: `Failed: ${result.error}` });
    } else if (result.ok) {
      setState({ status: `${active.verb} sent.` });
      void ctx.refreshBalances();
      void ctx.refreshHistory();
    }
  };

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
