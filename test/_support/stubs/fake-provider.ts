/**
 * A read-only ethers runner backed by canned return data.
 *
 * The Morpho recipes read the chain while they build — a vault reports its
 * asset, both decimals, and a preview rate before any calldata exists. Nothing
 * in the suite could answer those reads, so recipe construction could not be
 * tested at all. ethers accepts any object with `call` as a ContractRunner, so
 * a selector-keyed lookup is the whole fake: no fork, no RPC, no nock.
 *
 * Keys are `to:selector` (lowercased) with a bare `selector` as the fallback,
 * so a call that several contracts answer — `decimals()` — can be pinned per
 * address where it matters and shared where it does not.
 */
import { AbiCoder, Provider, TransactionRequest, ZeroAddress } from "ethers";

const coder = AbiCoder.defaultAbiCoder();

/**
 * Selectors the vault path reads.
 *
 * The four `*Gate` reads arrived with cookbook `-fx.3`, which folded the V2
 * gate check into the recipe itself. A gated V2 vault refuses this wallet's
 * fresh ephemeral executor outright, so the recipe now asks before building —
 * which means a fake that does not answer them cannot build a vault recipe at
 * all.
 */
export const SELECTOR = {
  asset: "0x38d52e0f",
  decimals: "0x313ce567",
  previewDeposit: "0xef8b30f7",
  previewRedeem: "0x4cdad506",
  receiveSharesGate: "0x7e729ac4",
  sendSharesGate: "0x93ab2ab7",
  receiveAssetsGate: "0x54cde13e",
  sendAssetsGate: "0x8eede801",
} as const;

/**
 * Canned answers for the four gate reads: every gate unset.
 *
 * The zero address is what an ungated vault reports, and it is the only shape
 * these tests want — a gated vault is a separate case with its own assertions,
 * not a default the rest of the suite should be built on.
 */
export const UNGATED_VAULT: Record<string, string> = {
  [SELECTOR.receiveSharesGate]: coder.encode(["address"], [ZeroAddress]),
  [SELECTOR.sendSharesGate]: coder.encode(["address"], [ZeroAddress]),
  [SELECTOR.receiveAssetsGate]: coder.encode(["address"], [ZeroAddress]),
  [SELECTOR.sendAssetsGate]: coder.encode(["address"], [ZeroAddress]),
};

export const encode = (types: string[], values: unknown[]): string =>
  coder.encode(types, values);

export interface FakeProviderCall {
  to?: string;
  selector: string;
  data: string;
}

export interface FakeProvider {
  provider: Provider;
  /** Every call made, in order — assert on what a recipe actually read. */
  calls: FakeProviderCall[];
}

/**
 * `returns` maps `"0xaddr:0xselector"` or `"0xselector"` to ABI-encoded data.
 * An unmapped call throws rather than returning zeroes, so a test that forgets
 * a read fails loudly instead of asserting against a silent default.
 */
export const makeFakeProvider = (
  returns: Record<string, string>,
): FakeProvider => {
  const lookup: Record<string, string> = {};
  for (const [key, value] of Object.entries(returns)) {
    lookup[key.toLowerCase()] = value;
  }
  const calls: FakeProviderCall[] = [];

  const call = async (tx: TransactionRequest): Promise<string> => {
    const data = String(tx.data ?? "");
    const selector = data.slice(0, 10).toLowerCase();
    const to = tx.to ? String(tx.to).toLowerCase() : undefined;
    calls.push({ to, selector, data });
    const hit = (to && lookup[`${to}:${selector}`]) ?? lookup[selector];
    if (hit === undefined) {
      throw new Error(
        `fake provider: no canned return for ${to ?? "?"}:${selector}`,
      );
    }
    return hit;
  };

  return { provider: { call } as unknown as Provider, calls };
};
