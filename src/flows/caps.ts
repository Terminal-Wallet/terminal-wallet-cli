/**
 * The transaction flow capability matrix, and the multi-leg builder model.
 *
 * A "leg" is one (token, amount, recipient). A send/shield/unshield builds a
 * list of them.
 *
 * `flowCaps` is the matrix as DATA, and it is policy rather than presentation —
 * which is why it lives here and not in the renderer. The unshield rule in
 * particular is a PRIVACY GUARANTEE, not a UI convenience: it must hold no
 * matter what is drawing the screen, and a renderer that forgot to honour it
 * would silently deanonymise the user.
 *
 * Pure and side-effect free: no SDK, no renderer, no IO.
 */
import { RailgunERC20AmountRecipient } from "@railgun-community/shared-models";
import { RailgunDisplayBalance } from "../models/balance-models";
import {
  buildRecipient,
  isEphemeral7702,
  useRelayAdapt,
  FeeMode,
} from "./spec";
import { RailgunTransaction } from "../models/transaction-models";

/** Which address family a flow's recipient must belong to. */
export type AddressKind = "0x" | "0zk";

export interface Leg {
  id: string;
  token?: RailgunDisplayBalance;
  amount?: string;
  recipient?: string;
}

export interface LegsState {
  legs: Leg[];
  seq: number; // monotonic id source (kept in state → deterministic + testable)
}

export interface FlowCaps {
  multiToken: boolean;
  maxRecipients: number; // max DISTINCT recipient addresses (Infinity = unbounded)
  recipientKind: AddressKind; // which address kind the recipient must be
  recipientDefaultOwn?: boolean; // shield: default recipient = your own 0zk
}

/** The TX FLOW MATRIX as data. */
export const flowCaps = (flowId: string): FlowCaps => {
  switch (flowId) {
    case "private-transfer":
      return { multiToken: true, maxRecipients: Infinity, recipientKind: "0zk" };
    case "public-transfer":
      return { multiToken: true, maxRecipients: Infinity, recipientKind: "0x" };
    case "shield-public-balances":
      // Shield to ANY 0zk address; default = your own. Not pinned.
      return {
        multiToken: true,
        maxRecipients: Infinity,
        recipientKind: "0zk",
        recipientDefaultOwn: true,
      };
    case "unshield-private-balances":
      // PRIVACY: unshielding to multiple distinct PUBLIC recipients in one tx
      // co-locates them on-chain (all funded from one shielded note set),
      // linking those addresses. Restrict to a single public recipient per
      // unshield. This is a guarantee, not a limitation.
      return { multiToken: true, maxRecipients: 1, recipientKind: "0x" };
    default:
      return { multiToken: false, maxRecipients: 1, recipientKind: "0x" };
  }
};

/** The current set of distinct non-blank recipient addresses (case-insensitive). */
export const distinctRecipients = (state: LegsState): string[] => {
  const seen = new Set<string>();
  for (const l of state.legs) {
    const r = l.recipient?.trim();
    if (r) seen.add(r.toLowerCase());
  }
  return [...seen];
};

/** Distinct token addresses (lowercased) currently chosen across legs. */
const distinctTokens = (state: LegsState): string[] => {
  const seen = new Set<string>();
  for (const l of state.legs) {
    if (l.token) seen.add(l.token.tokenAddress.toLowerCase());
  }
  return [...seen];
};

/** Fresh single-leg state. */
export const initLegs = (): LegsState => ({ legs: [{ id: "leg-0" }], seq: 1 });

const withLeg = (state: LegsState, leg: Leg): LegsState => ({
  legs: [...state.legs, leg],
  seq: state.seq + 1,
});

/** Whether another token group may be added (multiToken flows only). */
export const canAddToken = (state: LegsState, caps: FlowCaps): boolean =>
  caps.multiToken || state.legs.every((l) => !l.token);

/** Whether another distinct-recipient leg may be added. */
export const canAddRecipient = (state: LegsState, caps: FlowCaps): boolean =>
  caps.maxRecipients === Infinity ||
  distinctRecipients(state).length < caps.maxRecipients;

/** Append an empty token leg (no-op-guarded by canAddToken at the call site). */
export const addToken = (state: LegsState, caps: FlowCaps): LegsState =>
  canAddToken(state, caps) ? withLeg(state, { id: `leg-${state.seq}` }) : state;

/** Append a leg that reuses an existing leg's token, for another recipient. */
export const addRecipient = (
  state: LegsState,
  caps: FlowCaps,
  sourceLegId: string,
): LegsState => {
  if (!canAddRecipient(state, caps)) return state;
  const src = state.legs.find((l) => l.id === sourceLegId);
  return withLeg(state, { id: `leg-${state.seq}`, token: src?.token });
};

export const removeLeg = (state: LegsState, id: string): LegsState => {
  const legs = state.legs.filter((l) => l.id !== id);
  return { legs: legs.length ? legs : [{ id: `leg-${state.seq}` }], seq: state.seq + 1 };
};

export const setLegField = (
  state: LegsState,
  id: string,
  field: "token" | "amount" | "recipient",
  value: RailgunDisplayBalance | string,
): LegsState => ({
  ...state,
  legs: state.legs.map((l) => (l.id === id ? { ...l, [field]: value } : l)),
});

/** Write one recipient to EVERY leg (the single-recipient flows, e.g. unshield). */
export const setSharedRecipient = (state: LegsState, recipient: string): LegsState => ({
  ...state,
  legs: state.legs.map((l) => ({ ...l, recipient })),
});

export interface TokenGroup {
  key: string;
  token?: RailgunDisplayBalance;
  legs: Leg[];
}

/** Group legs by token (for the per-token rendering). Untokened legs group alone. */
export const groupByToken = (state: LegsState): TokenGroup[] => {
  const groups: TokenGroup[] = [];
  for (const leg of state.legs) {
    const key = leg.token ? leg.token.tokenAddress.toLowerCase() : `__unset_${leg.id}`;
    const g = groups.find((x) => x.key === key);
    if (g) g.legs.push(leg);
    else groups.push({ key, token: leg.token, legs: [leg] });
  }
  return groups;
};

export interface LegsValidation {
  ok: boolean;
  missing: string[]; // leg ids missing a field
  violations: string[]; // matrix violations
}

export const validateLegs = (
  state: LegsState,
  caps: FlowCaps,
): LegsValidation => {
  const missing: string[] = [];
  for (const l of state.legs) {
    const { token, amount, recipient } = l;
    if (!token || !amount?.trim() || !recipient?.trim()) {
      missing.push(l.id);
    } else if (!buildRecipient(token, amount, recipient)) {
      missing.push(l.id);
    }
  }
  const violations: string[] = [];
  if (distinctRecipients(state).length > caps.maxRecipients) {
    violations.push(
      caps.maxRecipients === 1
        ? "This flow allows only ONE recipient (privacy)."
        : `Too many recipients (max ${caps.maxRecipients}).`,
    );
  }
  if (!caps.multiToken && distinctTokens(state).length > 1) {
    violations.push("This flow allows only one token.");
  }
  return { ok: missing.length === 0 && violations.length === 0, missing, violations };
};

/** Consolidated RailgunERC20AmountRecipient[] for the spec (token+recipient dupes summed). */
export const toRecipients = (state: LegsState): RailgunERC20AmountRecipient[] => {
  const map = new Map<string, RailgunERC20AmountRecipient>();
  for (const l of state.legs) {
    if (!l.token || !l.amount || !l.recipient) continue;
    const r = buildRecipient(l.token, l.amount, l.recipient);
    if (!r) continue;
    const key = `${r.tokenAddress.toLowerCase()}|${r.recipientAddress.toLowerCase()}`;
    const ex = map.get(key);
    if (ex) ex.amount += r.amount;
    else map.set(key, { ...r });
  }
  return [...map.values()];
};

/** One-line summary of the legs (e.g. "2 tokens · 3 recipients"). */
export const summarizeLegs = (state: LegsState): string => {
  const tokens = distinctTokens(state).length;
  const recips = distinctRecipients(state).length;
  if (!tokens) return "no tokens yet";
  return `${tokens} token${tokens > 1 ? "s" : ""} · ${recips} recipient${recips === 1 ? "" : "s"}`;
};

// --- fee/execution policy -------------------------------------------------

/**
 * Whether a broadcaster must advertise EIP-7702 support to carry this flow.
 *
 * A relay-adapt flow produces a type-4 bundle with a signed authorization
 * tuple. A broadcaster without 7702 support drops the authorization and submits
 * a legacy request, so the bundle can never be mined — and the user only finds
 * out after paying for a proof. Offering such a broadcaster at all is the bug.
 *
 * This is the crossing of the two axes: 7702 execution AND a broadcaster in the
 * path. ShieldBase is 7702 but self-signed, so no broadcaster is involved and
 * this is false for it.
 */
export const requires7702Broadcaster = (type: RailgunTransaction): boolean =>
  isEphemeral7702(type) && useRelayAdapt(type);

/** Which fee modes a flow can actually offer. */
export const allowedFeeKinds = (
  type: RailgunTransaction,
): Array<FeeMode["kind"]> => {
  switch (type) {
    case RailgunTransaction.Transfer:
    case RailgunTransaction.Unshield:
    case RailgunTransaction.UnshieldBase:
    case RailgunTransaction.Private0XSwap:
    case RailgunTransaction.MorphoVaultDeposit:
    case RailgunTransaction.MorphoVaultRedeem:
    case RailgunTransaction.FxMintOpen:
    case RailgunTransaction.FxMintClose:
    case RailgunTransaction.FxMintTopup:
    case RailgunTransaction.FxMintTopupBorrow:
    case RailgunTransaction.FxMintBorrowMore:
    case RailgunTransaction.FxMintRepay:
      // A private spend can be relayed or paid for from a public wallet.
      return ["broadcaster", "self-signer", "external-signer"];
    default:
      // Shields and public transactions are signed by the wallet that holds the
      // funds; there is nothing for a broadcaster to relay.
      return ["self-signer", "external-signer"];
  }
};

/** Whether a flow produces a zero-knowledge proof before it can be sent. */
export const requiresProof = (type: RailgunTransaction): boolean =>
  type === RailgunTransaction.Transfer ||
  type === RailgunTransaction.Unshield ||
  type === RailgunTransaction.UnshieldBase ||
  type === RailgunTransaction.Private0XSwap ||
  type === RailgunTransaction.MorphoVaultDeposit ||
  type === RailgunTransaction.MorphoVaultRedeem ||
  type === RailgunTransaction.FxMintOpen ||
  type === RailgunTransaction.FxMintClose ||
  type === RailgunTransaction.FxMintTopup ||
  type === RailgunTransaction.FxMintTopupBorrow ||
  type === RailgunTransaction.FxMintBorrowMore ||
  type === RailgunTransaction.FxMintRepay;
