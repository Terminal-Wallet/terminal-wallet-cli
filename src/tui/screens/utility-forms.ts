/**
 * Single-card form specs for the groupable utility flows (Add Token, Contacts,
 * Signer import). Pure spec factories over src/ui/form-core.ts — they reuse the
 * SAME core functions the progressive flows in utility-flows.ts call, so only
 * the collection UX changes (one card instead of a prompt sequence).
 *
 * Renderer-agnostic: a shell (src/ui-blessed/form-card.ts) renders the FormSpec.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { FormSpec } from "../form-core";
import { getTokenInfo } from "../../railgun/balance/token-util";
import { updatePublicBalancesForChain } from "../../railgun/balance/balance-cache";
import {
  updateKnownAddress,
  updateKnownAddresses,
} from "../../railgun/wallet/address-book";
import { addExternalSigner } from "../../railgun/wallet/external-signers";

/** Add an ERC20 token by address (validated via on-chain read). */
export const addTokenFormSpec = (chainName: NetworkName): FormSpec => ({
  title: "Add ERC20 Token",
  submitLabel: "Add token",
  fields: [
    {
      key: "address",
      label: "Token address",
      type: "address",
      addressKind: "0x",
      required: true,
      hint: "0x… ERC20 contract",
    },
  ],
  submit: async (v) => {
    const addr = String(v.address).trim();
    const info = await getTokenInfo(chainName, addr);
    await updatePublicBalancesForChain(chainName, true);
    return { ok: true, message: `Added ${info.symbol} — ${info.name}.` };
  },
});

/** Save a contact: nickname + at least one of a 0x / 0zk address. */
export const addContactFormSpec = (): FormSpec => ({
  title: "Add Contact",
  submitLabel: "Save contact",
  fields: [
    { key: "name", label: "Name", type: "text", required: true, hint: "nickname" },
    { key: "pub", label: "Public 0x", type: "address", addressKind: "0x", hint: "blank to skip" },
    { key: "priv", label: "Private 0zk", type: "address", addressKind: "0zk", hint: "blank to skip" },
  ],
  validate: (v) =>
    !v.pub && !v.priv ? "Enter at least one address (0x or 0zk)." : undefined,
  summarize: (v) =>
    v.name ? `${String(v.name)}${v.pub ? " · 0x" : ""}${v.priv ? " · 0zk" : ""}` : "—",
  submit: async (v) => {
    const name = String(v.name).trim();
    updateKnownAddress(
      name,
      v.pub ? String(v.pub).trim() : undefined,
      v.priv ? String(v.priv).trim() : undefined,
    );
    await updateKnownAddresses();
    return { ok: true, message: `Saved contact “${name}”.` };
  },
});

/** Import an external gas-paying signer (label + private key, encrypted at rest). */
export const importSignerFormSpec = (): FormSpec => ({
  title: "Import External Signer",
  submitLabel: "Import signer",
  fields: [
    { key: "label", label: "Label", type: "text", required: true, hint: "e.g. gas-1" },
    {
      key: "key",
      label: "Private key",
      type: "password",
      secret: true,
      required: true,
      hint: "0x… — encrypted with your wallet password",
    },
  ],
  submit: async (v) => {
    const label = String(v.label).trim();
    const res = await addExternalSigner(label, String(v.key));
    return res
      ? { ok: true, message: `Imported “${label}” → ${res.address.slice(0, 10)}…` }
      : { ok: false, error: "Invalid private key (or password) — not imported." };
  },
});
