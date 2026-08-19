/**
 * Input seam — the INPUT half of the seam, counterpart to the event bus.
 *
 * Core flows need to ASK: for a password, for new-wallet details, for a yes/no.
 * Rather than importing a prompt library, core asks through this injected
 * provider and each host registers its own implementation — the headless
 * diagnostic, the terminal UI, a fake in tests.
 *
 * Passwords are collected RAW here and hashed by core. The renderer never sees
 * a key-derivation function, and the derivation cannot drift between hosts.
 *
 * On the one import below: `core/` takes no BEHAVIOUR from the rest of src/,
 * which is what the boundary guard enforces. Shared type declarations are a
 * different thing — `models/` is a leaf with no runtime surface, so importing a
 * shape from it creates no coupling and no cycle. Duplicating the declaration
 * here to satisfy the letter of the rule would just create two shapes that can
 * drift apart.
 */
import { TMPWalletInfo } from "../models/wallet-models";

export interface InputChoice {
  label: string;
  value: string;
  /** Optional secondary detail shown dimmed/right-aligned (e.g. a balance). */
  hint?: string;
}

/** One endpoint as the editor sees it. `probe` is filled in asynchronously. */
export interface RpcRowInput {
  url: string;
  enabled: boolean;
  isDefault: boolean;
  probe?: { ok: true; blockNumber: bigint; latencyMs: number } | { ok: false; reason: string };
}

/** What the editor decided about one endpoint. */
export interface RpcEndpointEdit {
  url: string;
  action: "enable" | "disable" | "remove";
}

export interface WalletInputProvider {
  /** Prompt for a RAW password string. Core does the hashing — UI only collects text. */
  promptPassword(message: string): Promise<string | undefined>;
  /** Collect new/imported wallet details (mnemonic, name, derivation index). */
  promptNewWallet(): Promise<TMPWalletInfo | undefined>;
  /**
   * Edit this chain's RPC endpoints on one screen, with each one's live head
   * block. Resolves the edits to apply, or undefined if cancelled — an empty
   * array means "reviewed, changed nothing", which is not the same answer.
   *
   * `onProbe` is handed the rows to check and a repaint callback; the caller
   * owns the probing so this seam stays free of network concerns.
   */
  promptRpcEndpoints(
    title: string,
    rows: RpcRowInput[],
    onProbe: (rows: RpcRowInput[], paint: () => void) => void,
  ): Promise<RpcEndpointEdit[] | undefined>;
  /** Yes/no confirmation. */
  confirm(message: string): Promise<boolean>;
  /** Non-blocking notice (e.g. "Generating wallet…"). */
  notify(message: string): void;
  /** Pick one of a list of choices; returns the chosen value (undefined = cancel). */
  select(message: string, choices: InputChoice[]): Promise<string | undefined>;
  /**
   * Pick any number of choices. Returns the chosen values, or undefined if the
   * user cancelled — which is distinct from an empty array, i.e. "none of
   * these". `initial` pre-selects.
   */
  multiSelect(
    message: string,
    choices: InputChoice[],
    opts?: { initial?: string[] },
  ): Promise<string[] | undefined>;
  /**
   * Free-text input; `password` masks it (undefined = cancel). `hint` shows a
   * dimmed format hint. `countWords` adds a live word count — for a masked seed
   * phrase, the only signal that a paste arrived whole. Opt-in, because under a
   * password prompt the same counter would be noise at best.
   */
  input(
    message: string,
    opts?: { password?: boolean; hint?: string; countWords?: boolean },
  ): Promise<string | undefined>;
}

let provider: WalletInputProvider | undefined;

export const setInputProvider = (p: WalletInputProvider): void => {
  provider = p;
};

export const getInputProvider = (): WalletInputProvider => {
  if (!provider) {
    throw new Error(
      "No WalletInputProvider registered. Call setInputProvider() during UI boot.",
    );
  }
  return provider;
};
