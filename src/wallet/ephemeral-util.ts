import { NetworkName } from "@railgun-community/shared-models";
import {
  EphemeralKeyManager,
  fullWalletForID,
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
