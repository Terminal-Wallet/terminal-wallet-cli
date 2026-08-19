/**
 * Creating or importing a wallet.
 *
 * The prompts are injected, so the flow — seed generation, import validation,
 * assembly, cancellation at any step — is testable without a renderer and is
 * identical whichever host collects the answers.
 */
import { HDNodeWallet, Mnemonic } from "ethers";
import { TMPWalletInfo } from "../models/wallet-models";

export interface NewWalletPrompts {
  /** Choose to generate a new wallet or import a seed (undefined = cancel). */
  selectMode: () => Promise<"new" | "import" | undefined>;
  /** Wallet name (undefined/empty = cancel). */
  askName: () => Promise<string | undefined>;
  /** Seed phrase, only used for the import path (undefined = cancel). */
  askMnemonic: () => Promise<string | undefined>;
}

/**
 * Pure assembly of wallet info from already-collected values (the single-card
 * flow gathers mode/name/mnemonic at once). New → generate a fresh seed; import
 * → validate the supplied seed. Returns undefined on a missing name or an
 * invalid import seed. Shared by the sequential and single-card flows.
 */
export const buildWalletInfo = (input: {
  mode: "new" | "import";
  walletName: string;
  mnemonic?: string;
}): TMPWalletInfo | undefined => {
  const walletName = input.walletName?.trim();
  if (!walletName) return undefined;

  let mnemonic: string | undefined;
  if (input.mode === "new") {
    // A seed supplied against "new" is a contradiction, and generating over it
    // is the expensive way to resolve it: the user believes they imported and
    // holds a fresh empty wallet instead, with a masked field showing nothing
    // that contradicts them. The two are one card apart and Mode defaults to
    // "new", so the mistake is a keystroke wide. Refuse and let the caller say
    // which of the two they meant.
    if (input.mnemonic?.trim()) return undefined;
    mnemonic = HDNodeWallet.createRandom().mnemonic?.phrase ?? undefined;
  } else {
    const m = input.mnemonic?.trim();
    if (!m || !Mnemonic.isValidMnemonic(m)) return undefined;
    mnemonic = m;
  }
  if (!mnemonic) return undefined;

  return { mnemonic, walletName, derivationIndex: 0 };
};

export const runNewWalletFlow = async (
  prompts: NewWalletPrompts,
): Promise<TMPWalletInfo | undefined> => {
  const mode = await prompts.selectMode();
  if (!mode) return undefined;

  const walletName = await prompts.askName();
  if (!walletName) return undefined;

  let mnemonic: string | undefined;
  if (mode === "import") {
    mnemonic = await prompts.askMnemonic();
    if (mnemonic === undefined) return undefined; // cancelled
  }

  return buildWalletInfo({ mode, walletName, mnemonic });
};
