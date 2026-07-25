/**
 * External gas-paying signers — imported private keys that can pay public gas
 * (public-send + self-broadcasting a private tx). They can NEVER sign RAILGUN
 * private spends (those use the railgun wallet).
 *
 * SECURITY:
 * - the raw private key is AES-256-GCM encrypted with a key derived from the
 *   wallet password hash (same secret that protects the seed) + a per-record IV;
 * - only the derived public address is stored in the clear;
 * - the key is decrypted transiently to build an ethers Wallet and is never
 *   logged, never returned to callers, and never written in plaintext.
 */
import { Wallet } from "ethers";
import { NetworkName } from "@railgun-community/shared-models";
import { ExternalSignerRecord } from "../../models/wallet-models";
import { walletManager } from "./wallet-manager";
import { getSaltedPassword } from "./wallet-password";
import { saveKeychainFile } from "./wallet-cache";
import { getProviderForChain } from "../network/network-util";
import { encryptSecret, decryptSecret } from "./signer-crypto";
import configDefaults from "../../config/config-defaults";

const persist = () =>
  saveKeychainFile(walletManager.keyChain, configDefaults.engine.keyChainPath);

/** Public list of imported signers (label + address only — never the key). */
export const listExternalSigners = (): { label: string; address: string }[] =>
  (walletManager.keyChain.externalSigners ?? []).map((s) => ({
    label: s.label,
    address: s.address,
  }));

export const hasExternalSigners = (): boolean =>
  (walletManager.keyChain.externalSigners?.length ?? 0) > 0;

/**
 * Import a private key under a label. Validates the key (derives the address),
 * encrypts it, and persists. Returns the public address, or undefined on a bad
 * key / missing password. The raw key is not retained.
 */
export const addExternalSigner = async (
  label: string,
  privateKey: string,
): Promise<{ address: string } | undefined> => {
  const trimmed = privateKey.trim();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  let address: string;
  try {
    ({ address } = new Wallet(normalized)); // validates format, derives address
  } catch {
    return undefined; // invalid key — caller shows an error (never the key)
  }
  const hashedPassword = await getSaltedPassword();
  if (!hashedPassword) return undefined;

  const record: ExternalSignerRecord = {
    label: label.trim(),
    address,
    // Nested rather than spread flat, so it is unambiguous which fields are the
    // sealed envelope and which are the metadata kept in the clear.
    encrypted: encryptSecret(normalized, hashedPassword),
  };
  const list = (walletManager.keyChain.externalSigners ?? []).filter(
    (s) => s.label !== record.label,
  );
  list.push(record);
  walletManager.keyChain.externalSigners = list;
  persist();
  return { address };
};

export const removeExternalSigner = (label: string): void => {
  walletManager.keyChain.externalSigners = (
    walletManager.keyChain.externalSigners ?? []
  ).filter((s) => s.label !== label);
  persist();
};

/** Decrypt a signer to an ethers Wallet connected to the chain (transient). */
export const getExternalSignerWallet = async (
  label: string,
  chainName: NetworkName,
): Promise<Wallet> => {
  const rec = (walletManager.keyChain.externalSigners ?? []).find(
    (s) => s.label === label,
  );
  if (!rec) throw new Error(`External signer "${label}" not found.`);
  const hashedPassword = await getSaltedPassword();
  if (!hashedPassword) throw new Error("Password required to use the signer.");
  const privateKey = decryptSecret(rec.encrypted, hashedPassword);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wallet = new Wallet(privateKey, getProviderForChain(chainName) as any);
  // Defense-in-depth: GCM already authenticates the blob, but verify the
  // decrypted key derives the stored address before we ever sign with it.
  if (wallet.address.toLowerCase() !== rec.address.toLowerCase()) {
    throw new Error(`Signer "${label}" failed integrity check.`);
  }
  return wallet;
};
