/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Live transaction-builder page (blessed). Instead of a forced wizard of modal
 * prompts, the whole transaction is ONE persistent page: every field (token,
 * amount, recipient, memo, gas) is visible and editable in any order, a live
 * summary updates as you go, and "Build & Send" runs the tested pipeline — the
 * only staged step is the proof/broadcast progress on the dashboard.
 *
 * Field editors reuse the input-provider modals + the gas selector, popped over
 * the builder which stays underneath (webapp-like). Pure state/validation logic
 * lives in ui/tx-builder-core.ts.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { formatUnits } from "ethers";
import { getInputProvider } from "../../core/input";
import { setState, setStatusMessage } from "../store";
import { collectGasSelection } from "../../flows/collect/gas";
import { collectFeeMode, resolveDefaultFeeAsync } from "../../flows/collect/fee";
import { evmGasTypeForChain } from "../../railgun/gas/gas-selection";
import { RailgunDisplayBalance } from "../../models/balance-models";
import { createModal, shifted } from "../widgets/modal";
import { DefiLeg } from "../format/defi-legs";
import {
  FieldKey,
  BuilderState,
  VaultChoice,
  PoolChoice,
  PositionChoice,
  RecoveryChoice,
  fieldDisplay,
  validate,
  summarize,
} from "./tx-builder-core";

export interface TxBuilderConfig {
  title: string;
  chainName: NetworkName;
  verb: string; // "Send" | "Shield" | "Unshield" …
  fields: FieldKey[]; // editable rows, in display order
  /**
   * Rows that are editable but not required. Offering a choice is not the same
   * as demanding one — the f(x) close takes a buy token to convert the released
   * collateral, and leaving it unset simply means no conversion.
   */
  optionalFields?: FieldKey[];
  // Sync or async: some balance accessors read a cache and return directly.
  // The caller awaits either way.
  loadTokens?: () =>
    | RailgunDisplayBalance[]
    | Promise<RailgunDisplayBalance[]>; // for a token field
  fixedToken?: () =>
    | RailgunDisplayBalance
    | undefined
    | Promise<RailgunDisplayBalance | undefined>; // base flows
  fixedAddress?: string; // shield flows (recipient is our own railgun address)
  addressLabel?: string;
  gasSymbol: string;
  gasDecimals: number;
  gasUnitsHint: bigint; // nominal gas units for the cost preview in the selector
  relayAdapt?: boolean; // for the fee field's broadcaster lookup (private flows)
  /**
   * This flow's gas comes out of the same balance it spends: the public native
   * token. The amount must therefore leave room for gas, or the wallet holds
   * less than value + gas and the node rejects the send.
   */
  gasFromBalance?: boolean;
  multiLeg?: boolean; // token/amount/recipient come from a multi-leg model (deck only)
  flowId?: string; // identifies the flow for the capability matrix (builder-legs.flowCaps)
  loadBuyTokens?: () =>
    | RailgunDisplayBalance[]
    | Promise<RailgunDisplayBalance[]>; // swaps: buy-token options
  /** fx close: what may be sold to cover a shortfall in the debt token. */
  loadSellTokens?: () =>
    | RailgunDisplayBalance[]
    | Promise<RailgunDisplayBalance[]>;
  /**
   * Vault flows: the vaults on offer, each already paired with the balance this
   * action would spend. Resolving the pair needs the vault's own asset/share
   * metadata, so it happens here rather than in the picker.
   */
  loadVaults?: () => Promise<VaultChoice[]>;
  /**
   * fx flows: the pools on offer, each paired with the collateral balance it
   * takes. Same shape as loadVaults and for the same reason.
   */
  loadPools?: () => Promise<PoolChoice[]>;
  /**
   * fx flows acting on an existing position: the ones the wallet actually
   * holds, read from the shielded NFT set.
   */
  loadPositions?: () => Promise<PositionChoice[]>;
  /** Recovery: the ephemeral accounts currently holding stranded value. */
  loadAccounts?: () => Promise<RecoveryChoice[]>;
  /**
   * Extra breakdown lines a flow contributes.
   *
   * The standard breakdown is built from a token and an amount; a flow shaped
   * differently — recovery moves whatever it finds — has nothing to put there
   * and would otherwise be reviewed against a blank panel.
   */
  previewLines?: (state: BuilderState) => Promise<string[]>;
  /**
   * The amount row means "fxUSD put toward THIS position's debt".
   *
   * Set by the close card. Picking a position then prefills the row with the
   * whole debt, because closing fully is what "close" means and leaving the
   * field blank made the commonest action the one you had to look a number up
   * for — the debt is not shown anywhere you could have copied it from.
   */
  amountIsPositionDebt?: boolean;
  /**
   * The steps this build would run, for the clear-signing breakdown.
   *
   * A combo meal is several recipes chained, so one signature can be a swap,
   * two approvals, a protocol call and a shield. This builds the recipe to ask
   * it what it would do — the same work submit does, so it is only run when the
   * form is complete and re-run only when the inputs move.
   */
  previewLegs?: (state: BuilderState) => Promise<DefiLeg[]>;
  defaultAddress?: string; // seeds (editable) the address field, e.g. swap 0zk destination
  submit: (state: BuilderState) => Promise<{ ok: boolean; error?: string }>;
}

type Row = FieldKey | "__send" | "__cancel";

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

export const runTxBuilder = async (
  blessed: any,
  screen: any,
  cfg: TxBuilderConfig,
): Promise<void> => {
  const provider = getInputProvider();
  const state: BuilderState = { gas: undefined };
  if (cfg.fields.includes("fee")) state.fee = await resolveDefaultFeeAsync(cfg.chainName, cfg.relayAdapt ?? false);
  if (cfg.fixedToken) {
    // The loader may be sync or async, and a failure here just means the field
    // starts empty rather than the builder refusing to open.
    try {
      state.token = await cfg.fixedToken();
    } catch {
      state.token = undefined;
    }
  }
  if (cfg.fixedAddress) state.address = cfg.fixedAddress;

  const rows: Row[] = [...cfg.fields, "__send", "__cancel"];

  return new Promise<void>((resolve) => {
    let close: () => void = () => undefined;
    const { box, guardFocus, close: closeChrome } = createModal(blessed, screen, {
      title: cfg.title,
      widthPct: 70,
      height: rows.length + 7,
      accent: "cyan",
      onDismiss: () => close(),
    });
    const list = blessed.list({
      parent: box,
      top: 0,
      left: 0,
      right: 0,
      height: rows.length,
      tags: true,
      keys: true,
      mouse: true,
      vi: true,
      style: { selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
    });
    const summary = blessed.text({
      parent: box,
      bottom: 2,
      left: 1,
      right: 1,
      tags: true,
    });
    blessed.text({
      parent: box,
      bottom: 0,
      left: 1,
      right: 1,
      tags: true,
      content: "{gray-fg}↑/↓ field · Enter edit · S send · Esc cancel{/}",
    });

    const rowLabel = (r: Row): string => {
      if (r === "__send") return "{green-fg}▸ Build & Send{/}";
      if (r === "__cancel") return "{gray-fg}✕ Cancel{/}";
      const label = r === "address" ? cfg.addressLabel ?? "Recipient" : FIELD_LABELS[r];
      return `${label.padEnd(13)}{cyan-fg}${fieldDisplay(r, state)}{/}`;
    };

    const refresh = () => {
      list.setItems(rows.map(rowLabel));
      const v = validate(cfg.fields, state, cfg.optionalFields);
      const line = summarize({ verb: cfg.verb, fixedAddress: cfg.fixedAddress }, state);
      summary.setContent(
        v.ok
          ? `{green-fg}${line}{/}`
          : `{yellow-fg}${line}{/}  {gray-fg}(need: ${v.missing.join(", ")}){/}`,
      );
      screen.render();
    };

    // Keep grabKeys ours between edits so the dashboard menu keys don't fire;
    // sub-modals manage their own grabKeys and we re-assert on return.
    const reclaim = () => {
      screen.grabKeys = true;
      list.focus();
      refresh();
    };

    close = () => {
      closeChrome();
      resolve();
    };
    guardFocus(list);

    const editToken = async () => {
      if (!cfg.loadTokens) return;
      const balances = await cfg.loadTokens();
      if (!balances.length) {
        provider.notify("No token balances available.");
        return;
      }
      const addr = await provider.select(
        "Select token",
        balances.map((b) => ({
          label: b.symbol,
          value: b.tokenAddress,
          hint: formatUnits(b.amount, b.decimals),
        })),
      );
      if (addr) state.token = balances.find((b) => b.tokenAddress === addr);
    };

    const editVault = async () => {
      if (!cfg.loadVaults) return;
      const choices = await cfg.loadVaults();
      if (!choices.length) {
        provider.notify("No vaults available on this network.");
        return;
      }
      const picked = await provider.select(
        "Select vault",
        choices.map((c) => ({
          label: c.vault.name,
          value: c.vault.vaultAddress,
          hint: `${formatUnits(c.token.amount, c.token.decimals)} ${c.token.symbol}`,
        })),
      );
      const choice = choices.find((c) => c.vault.vaultAddress === picked);
      if (choice) {
        // The vault decides the token, so picking one also settles what the
        // amount field measures against.
        state.vault = choice;
        state.token = choice.token;
        state.amount = undefined;
      }
    };

    const editPool = async () => {
      if (!cfg.loadPools) return;
      const choices = await cfg.loadPools();
      if (!choices.length) {
        provider.notify("No f(x) pools available on this network.");
        return;
      }
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
        // The pool decides the collateral, so picking one also settles what the
        // amount field measures against.
        state.pool = choice;
        state.token = choice.token;
        state.amount = undefined;
      }
    };

    const edit = async (key: FieldKey) => {
      switch (key) {
        case "token":
          await editToken();
          break;
        case "vault":
          await editVault();
          break;
        case "pool":
          await editPool();
          break;
        case "account": {
          const accounts = (await cfg.loadAccounts?.()) ?? [];
          if (!accounts.length) {
            provider.notify("Nothing stranded on any recent ephemeral account.");
            break;
          }
          const chosen = await provider.select(
            "Recover from",
            accounts.map((a) => ({
              label: `[${a.index}]`,
              value: String(a.index),
              hint: a.summary,
            })),
          );
          const account = accounts.find((a) => String(a.index) === chosen);
          if (account) state.account = account;
          break;
        }
        case "position": {
          const choices = (await cfg.loadPositions?.()) ?? [];
          if (!choices.length) {
            provider.notify("No positions held.");
            break;
          }
          const picked = await provider.select(
            "Select position",
            choices.map((c) => ({ label: c.nft.label, value: c.nft.tokenSubID })),
          );
          const choice = choices.find((c) => c.nft.tokenSubID === picked);
          if (choice) state.position = choice;
          break;
        }
        case "debt":
        case "debtRatio": {
          // This renderer has no slider, so the loan is typed here.
          const d = await provider.input("Amount of fxUSD to mint");
          if (d) state.debt = d;
          break;
        }
        case "debtDelta": {
          // Signed, and this renderer has no centred slider — so the direction
          // is asked for rather than inferred from a typed minus sign, which
          // is too easy to omit on a field that can repay a position's debt.
          const direction = await provider.select("Debt", [
            { label: "Borrow more fxUSD", value: "borrow" },
            { label: "Repay fxUSD", value: "repay" },
          ]);
          if (!direction) break;
          const d = await provider.input(
            direction === "repay" ? "fxUSD to repay" : "fxUSD to borrow",
          );
          if (!d) break;
          state.debt = d;
          state.debtDeltaFrac = direction === "repay" ? -1 : 1;
          break;
        }
        case "collateralPct": {
          const c = await provider.input(
            `Collateral${state.token ? ` in ${state.token.symbol}` : ""}`,
          );
          if (c) state.amount = c;
          break;
        }
        case "amount": {
          const a = await provider.input(
            `Amount${state.token ? ` of ${state.token.symbol}` : ""}`,
            state.token
              ? { hint: `have ${formatUnits(state.token.amount, state.token.decimals)}` }
              : undefined,
          );
          if (a) state.amount = a;
          break;
        }
        case "address": {
          const a = await provider.input(cfg.addressLabel ?? "Recipient address", {
            hint: /0zk/i.test(cfg.addressLabel ?? "")
              ? "RAILGUN 0zk… address"
              : "Ethereum 0x… address",
          });
          if (a) state.address = a;
          break;
        }
        case "memo": {
          const m = await provider.input("Memo (optional)");
          if (m !== undefined) state.memo = m;
          break;
        }
        case "gas": {
          const g = await collectGasSelection(
            cfg.chainName,
            evmGasTypeForChain(cfg.chainName),
            cfg.gasUnitsHint,
            cfg.gasSymbol,
            cfg.gasDecimals,
          );
          if (g !== undefined) state.gas = g;
          break;
        }
        // Neither is edited through this list: the buy token is chosen inside
        // the swap flow, and the sender toggle is flipped in place rather than
        // opening an editor. Named explicitly so adding a field cannot slip
        // through unhandled.
        case "buyToken":
        case "sellToken":
        case "showSender":
          break;
        case "fee": {
          const fee = await collectFeeMode(
            cfg.chainName,
            cfg.relayAdapt ?? false,
            cfg.gasUnitsHint,
          );
          if (fee !== undefined) state.fee = fee;
          break;
        }
      }
      reclaim();
    };

    const trySend = async () => {
      const v = validate(cfg.fields, state, cfg.optionalFields);
      if (!v.ok) {
        provider.notify(`Incomplete — need: ${v.missing.join(", ")}.`);
        return;
      }
      // Close the builder; proving/broadcast progress shows on the dashboard.
      closeChrome();
      setStatusMessage(`${cfg.verb}…`);
      const res = await cfg
        .submit(state)
        .catch((e: Error) => ({ ok: false, error: e.message }));
      if (
        !res.ok &&
        res.error &&
        !["simulated", "cancelled"].includes(res.error)
      ) {
        setStatusMessage(`Failed: ${res.error}`);
      }
      resolve();
    };

    list.on("select", (_item: any, idx: number) => {
      const r = rows[idx];
      if (r === "__send") void trySend();
      else if (r === "__cancel") close();
      else void edit(r as FieldKey);
    });
    list.key(["escape"], close);
    list.key(["s", ...shifted("S")], () => void trySend());

    screen.grabKeys = true;
    refresh();
    list.focus();
    screen.render();
  });
};
