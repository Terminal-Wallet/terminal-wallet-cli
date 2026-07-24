import { NetworkName } from "@railgun-community/shared-models";
import {
  EphemeralKeyManager,
  fullWalletForID,
  getCurrentEphemeralAddress,
  ratchetEphemeralAddress,
} from "@railgun-community/wallet";
import { ContractTransaction } from "ethers";
import { getChainForName } from "../network/network-util";
import { getCurrentRailgunID } from "./wallet-util";

// EIP-7702 relay-adapt bundles (private swap, base-token shield/unshield) execute via a
// per-wallet *ephemeral* EOA that the relay-adapt code is delegated onto. Each relay-adapt
// call MUST use a fresh, never-funded ephemeral address: the relay-adapt wrap/shield steps
// operate on whatever balance sits at that address, so reusing one that holds residual
// ETH/WETH could sweep more than the user intended. We therefore use the wallet's *current*
// ephemeral index for an operation (so the gas estimate, proof and submission all agree),
// then ratchet to the next index once that operation has actually been broadcast.

// Guards a one-time, per-session history sync per (wallet, chain).
const syncedEphemeralIndex = new Set<string>();

const isType4 = (transaction?: ContractTransaction): boolean =>
  transaction?.type === 4;

/**
 * Realign the current ephemeral index with on-chain history before the first
 * relay-adapt call of a session. Protects imported/restored wallets whose local index
 * counter was reset to 0 while indices were already spent on-chain. Best-effort and
 * idempotent (only ever raises the index), so a failure never blocks the transaction.
 */
export const syncEphemeralIndexOnce = async (
  chainName: NetworkName,
  encryptionKey: string,
): Promise<void> => {
  const railgunWalletID = getCurrentRailgunID();
  const chain = getChainForName(chainName);
  const key = `${railgunWalletID}:${chain.type}:${chain.id}`;
  if (syncedEphemeralIndex.has(key)) {
    return;
  }
  try {
    const keyManager = new EphemeralKeyManager(
      fullWalletForID(railgunWalletID),
      encryptionKey,
    );
    await keyManager.scanHistoryForEphemeralIndex(chain);
    syncedEphemeralIndex.add(key);
  } catch (err) {
    console.log(
      `Ephemeral index sync skipped: ${(err as Error).message}`.grey,
    );
  }
};

/**
 * Advance the ephemeral index after a relay-adapt (type-4) bundle has been submitted, so
 * the next relay-adapt call derives a fresh ephemeral address. No-op for non-7702 txs.
 * Best-effort: the transaction already succeeded, so a ratchet failure only warns (the
 * next session's history sync will correct the index).
 */
export const ratchetEphemeralIfRelayAdapt = async (
  chainName: NetworkName,
  submittedTransaction?: ContractTransaction,
): Promise<void> => {
  if (!isType4(submittedTransaction)) {
    return;
  }
  try {
    await ratchetEphemeralAddress(getCurrentRailgunID(), chainName);
  } catch (err) {
    console.log(
      `WARNING: failed to ratchet ephemeral address (${
        (err as Error).message
      }). It will be re-synced from history on next load.`.yellow,
    );
  }
};

// --- 7702 ephemeral index management (day-to-day admin ops) ---
// All helpers below are local: they read/derive/persist the wallet's ephemeral index and
// derive addresses from the wallet's own keys. None query an ephemeral address against an
// RPC, so they carry no address-correlation metadata leak.

const ephemeralChainId = (chainName: NetworkName): bigint =>
  BigInt(getChainForName(chainName).id);

export const getEphemeralIndex = async (
  chainName: NetworkName,
): Promise<number> => {
  const wallet = fullWalletForID(getCurrentRailgunID());
  return wallet.getEphemeralKeyIndex(ephemeralChainId(chainName));
};

export const getCurrentEphemeralInfo = async (
  chainName: NetworkName,
  encryptionKey: string,
): Promise<{ index: number; address: string }> => {
  const index = await getEphemeralIndex(chainName);
  const address = await getCurrentEphemeralAddress(
    getCurrentRailgunID(),
    encryptionKey,
    chainName,
  );
  return { index, address };
};

// Derive the ephemeral address for a SPECIFIC index without touching the persisted current
// index (recovery inspection/targeting). Read-only: derives locally from the wallet keys.
export const getEphemeralAddressForIndex = async (
  chainName: NetworkName,
  encryptionKey: string,
  index: number,
): Promise<string> => {
  const keyManager = new EphemeralKeyManager(
    fullWalletForID(getCurrentRailgunID()),
    encryptionKey,
  );
  const account = await keyManager.getAccount(ephemeralChainId(chainName), index);
  return account.address;
};


// Realign the index against the wallet's on-chain history (unshield recipients only — a
// shield leaves no trace here, so the per-broadcast ratchet remains the authority for those).
// Returns the before/after index so the caller can report what changed.
export const syncEphemeralIndexFromHistory = async (
  chainName: NetworkName,
  encryptionKey: string,
): Promise<{ before: number; after: number }> => {
  const before = await getEphemeralIndex(chainName);
  const keyManager = new EphemeralKeyManager(
    fullWalletForID(getCurrentRailgunID()),
    encryptionKey,
  );
  await keyManager.scanHistoryForEphemeralIndex(getChainForName(chainName));
  const after = await getEphemeralIndex(chainName);
  return { before, after };
};

// Advance to the next ephemeral index (ratchet +1), skipping the current one.
export const advanceEphemeralIndex = async (
  chainName: NetworkName,
): Promise<{ before: number; after: number }> => {
  const before = await getEphemeralIndex(chainName);
  await ratchetEphemeralAddress(getCurrentRailgunID(), chainName);
  const after = await getEphemeralIndex(chainName);
  return { before, after };
};

// Pin the ephemeral index to a specific value (recovery / targeting). Setting it below the
// current value can reuse a spent ephemeral — the caller must confirm that case.
export const setEphemeralIndex = async (
  chainName: NetworkName,
  index: number,
): Promise<void> => {
  const wallet = fullWalletForID(getCurrentRailgunID());
  await wallet.setEphemeralKeyIndex(ephemeralChainId(chainName), index);
};

export type EphemeralHistoryEntry = {
  index: number;
  address: string;
  usedForUnshield: boolean;
};

// A window of the wallet's ephemeral accounts up to and including the current index, each
// derived locally and flagged if it appears as an unshield recipient in the wallet's local
// transaction history (relay-adapt unshield/swap). Shields leave no unshield trace, so a
// below-current index without a match is simply "used" (ratcheted past). Purely local —
// history is read from the decrypted local DB, addresses are derived from wallet keys.
export const getEphemeralHistory = async (
  chainName: NetworkName,
  encryptionKey: string,
  limit = 25,
): Promise<{
  currentIndex: number;
  earlierOmitted: number;
  entries: EphemeralHistoryEntry[];
}> => {
  const railgunWalletID = getCurrentRailgunID();
  const chain = getChainForName(chainName);
  const chainId = BigInt(chain.id);
  const wallet = fullWalletForID(railgunWalletID);
  const currentIndex = await wallet.getEphemeralKeyIndex(chainId);
  const keyManager = new EphemeralKeyManager(wallet, encryptionKey);

  const unshieldRecipients = new Set<string>();
  try {
    const history = await wallet.getTransactionHistory(chain, undefined);
    for (const entry of history) {
      for (const unshield of entry.unshieldTokenAmounts) {
        unshieldRecipients.add(unshield.recipientAddress.toLowerCase());
      }
    }
  } catch {
    // History not yet available for this chain — flags default to false.
  }

  const start = Math.max(0, currentIndex - limit + 1);
  const entries: EphemeralHistoryEntry[] = [];
  for (let i = start; i <= currentIndex; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const account = await keyManager.getAccount(chainId, i);
    entries.push({
      index: i,
      address: account.address,
      usedForUnshield: unshieldRecipients.has(account.address.toLowerCase()),
    });
  }
  return { currentIndex, earlierOmitted: start, entries };
};
