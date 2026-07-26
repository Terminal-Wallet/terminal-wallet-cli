/**
 * The single-page form screens: add a token, add a contact, manage signers.
 *
 * Each is a form card rather than a sequence of prompts — the whole thing is
 * visible, every field is editable in any order, and nothing is committed until
 * the card is submitted.
 */
import blessed from "blessed";
import { DeckContext } from "../context";
import { runFormCard } from "../widgets/form-card";
import { getState } from "../store";
import { getInputProvider } from "../../core/input";
import {
  addTokenFormSpec,
  addContactFormSpec,
  importSignerFormSpec,
} from "./utility-forms";
import {
  listExternalSigners,
  removeExternalSigner,
} from "../../railgun/wallet/external-signers";
import { NetworkName } from "@railgun-community/shared-models";

/**
 * Adding a token changes what the balance rail can show, so the balances are
 * re-read on success. The chain comes from the store rather than the engine:
 * the adapter keeps it current, and reading it here would reach past the
 * context into global state the screen is not supposed to know about.
 */
export const showAddToken = async (ctx: DeckContext): Promise<void> => {
  const network = getState().network as NetworkName;
  const result = await runFormCard(
    blessed,
    ctx.screen,
    addTokenFormSpec(network),
  );
  if (result?.ok) {
    await ctx.refreshBalances();
  }
};

/** Contacts are display-only, so nothing needs re-reading afterwards. */
export const showAddContact = async (ctx: DeckContext): Promise<void> => {
  await runFormCard(blessed, ctx.screen, addContactFormSpec());
};

/**
 * Signers are a list with removal, so this is a menu whose "+ Import" opens a
 * form card — the one place a menu is the honest shape rather than a card.
 */
export const showSigners = async (ctx: DeckContext): Promise<void> => {
  const signers = listExternalSigners();
  const picked = await getInputProvider().select(
    "External signers (pay public gas)",
    [
      ...signers.map((s) => ({
        label: s.label,
        value: `del:${s.label}`,
        hint: `${s.address.slice(0, 10)}… · remove`,
      })),
      {
        label: "+ Import external signer",
        value: "import",
        hint: "private key",
      },
    ],
  );
  if (!picked) {
    return;
  }

  if (picked === "import") {
    await runFormCard(blessed, ctx.screen, importSignerFormSpec());
    return;
  }

  if (picked.startsWith("del:")) {
    const label = picked.slice(4);
    // Removing a signer discards the only copy of that key this wallet holds,
    // so it confirms first.
    if (await getInputProvider().confirm(`Remove external signer "${label}"?`)) {
      removeExternalSigner(label);
      getInputProvider().notify(`Removed "${label}".`);
    }
  }
};
