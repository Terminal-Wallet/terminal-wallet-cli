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
import { AbiCoder, Provider, TransactionRequest } from "ethers";

const coder = AbiCoder.defaultAbiCoder();

/** Selectors the vault path reads. */
export const SELECTOR = {
  asset: "0x38d52e0f",
  decimals: "0x313ce567",
  previewDeposit: "0xef8b30f7",
  previewRedeem: "0x4cdad506",
} as const;

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
