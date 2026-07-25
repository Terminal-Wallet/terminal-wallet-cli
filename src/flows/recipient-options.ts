/**
 * Seed recipient fields with known addresses: the user's own wallets and any
 * contacts that have an address of the right kind (0x for public destinations,
 * 0zk for private/shield destinations), plus a manual-entry escape hatch in the
 * UI layer. The pure builder is unit-tested; a thin gather pulls live data.
 */
import {
  getWalletNames,
  getWalletInfoForName,
  getCurrentWalletName,
} from "../railgun/wallet/wallet-util";
import { getKnownAddresses } from "../railgun/wallet/address-book";

// Owned by the capability matrix: which address family a flow requires is a
// property of the flow, and duplicating the type here would let the two drift.
export type { AddressKind } from "./caps";
import type { AddressKind } from "./caps";

export interface RecipientCandidate {
  label: string;
  address: string;
  kind: "this-wallet" | "your-wallet" | "contact"; // for highlighting / grouping
}

export interface WalletEntry {
  name: string;
  railgunWalletAddress?: string; // 0zk
  publicAddress?: string; // 0x
}

export interface ContactEntry {
  name: string;
  publicAddress?: string; // 0x
  privateAddress?: string; // 0zk
}

/**
 * Pure: your wallets first as suggestions (the active one tagged "(this wallet)",
 * others "(your wallet)"), then contacts; de-duped by address, kind-filtered.
 */
export const buildRecipientOptions = (
  wallets: WalletEntry[],
  contacts: ContactEntry[],
  kind: AddressKind,
  currentWalletName?: string,
): RecipientCandidate[] => {
  const out: RecipientCandidate[] = [];
  const seen = new Set<string>();
  const add = (
    label: string,
    address: string | undefined,
    rcKind: RecipientCandidate["kind"],
  ) => {
    if (!address) return;
    const key = address.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, address, kind: rcKind });
  };
  for (const w of wallets) {
    const isCurrent = w.name === currentWalletName;
    add(
      `${w.name} ${isCurrent ? "(this wallet)" : "(your wallet)"}`,
      kind === "0zk" ? w.railgunWalletAddress : w.publicAddress,
      isCurrent ? "this-wallet" : "your-wallet",
    );
  }
  for (const c of contacts) {
    add(c.name, kind === "0zk" ? c.privateAddress : c.publicAddress, "contact");
  }
  return out;
};

/** Live recipient candidates for a kind, gathered from wallets + the address book. */
export const recipientOptions = (kind: AddressKind): RecipientCandidate[] => {
  const wallets: WalletEntry[] = getWalletNames().map((name) => {
    const w = getWalletInfoForName(name);
    return {
      name,
      railgunWalletAddress: w?.railgunWalletAddress,
      publicAddress: w?.publicAddress,
    };
  });
  const known = getKnownAddresses();
  const contacts: ContactEntry[] = Object.keys(known).map((name) => ({
    name,
    publicAddress: known[name].publicAddress,
    privateAddress: known[name].privateAddress,
  }));
  return buildRecipientOptions(wallets, contacts, kind, getCurrentWalletName());
};
