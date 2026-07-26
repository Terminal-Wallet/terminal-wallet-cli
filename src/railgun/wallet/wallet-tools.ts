/**
 * Maintenance/recovery tools that the original enquirer UI exposed under
 * "Wallet Tools" and "POI Tools": a full balance rescan, a TXID merkletree
 * reset, and the Private Proof-of-Innocence (POI) refresh/generate actions.
 *
 * Thin wrappers over the RAILGUN SDK so the UI shell never imports the engine
 * directly and the signatures stay typechecked (this module is NOT in the
 * tsc-excluded ui-blessed tree). Each runs against the CURRENT wallet/chain.
 */
import { NetworkName, TXIDVersion } from "@railgun-community/shared-models";
import {
  fullResetTXIDMerkletreesV2,
  generatePOIsForWallet,
  refreshReceivePOIsForWallet,
  refreshSpentPOIsForWallet,
  rescanFullUTXOMerkletreesAndWallets,
} from "@railgun-community/wallet";
import { getChainForName } from "../network/network-util";
import { getCurrentRailgunID } from "./wallet-util";

/** Re-scan all UTXO merkletrees and rebuild this wallet's balances from scratch. */
export const fullBalanceRescan = async (chainName: NetworkName): Promise<void> => {
  const chain = getChainForName(chainName);
  await rescanFullUTXOMerkletreesAndWallets(chain, [getCurrentRailgunID()]);
};

/** Reset and rebuild the V2 TXID merkletrees for this chain. */
export const fullTxidRescan = async (chainName: NetworkName): Promise<void> => {
  await fullResetTXIDMerkletreesV2(chainName);
};

/**
 * Hard resync of BOTH merkletrees for this chain — recovery for a wedged sync.
 *
 * Just the full UTXO rescan: the engine's fullRescanUTXOMerkletreesAndWallets
 * clears the UTXO leaves AND the cold-sync checkpoint (lastSyncedBlock, so the
 * cold sync restarts from the deployment block, not a stale checkpoint), rebuilds
 * this wallet's balances, and — for V2 — resets the TXID merkletree at the end.
 *
 * Do NOT reset the TXID tree first: fullResetTXIDMerkletreesV2 throws "Must get
 * UTXO history first" until the UTXO history has synced, so a TXID-first order
 * fails exactly when you most need the recovery (UTXO not yet synced).
 */
export const fullRescanAll = async (chainName: NetworkName): Promise<void> => {
  await rescanFullUTXOMerkletreesAndWallets(getChainForName(chainName), [
    getCurrentRailgunID(),
  ]);
};

/** Generate POI proofs for the current wallet. */
export const generateWalletPOIs = async (chainName: NetworkName): Promise<void> => {
  await generatePOIsForWallet(chainName, getCurrentRailgunID());
};

/** Refresh the received-POI list for the current wallet. */
export const refreshReceivedPOIs = async (chainName: NetworkName): Promise<void> => {
  await refreshReceivePOIsForWallet(
    TXIDVersion.V2_PoseidonMerkle,
    chainName,
    getCurrentRailgunID(),
  );
};

/** Refresh the spent-POI list for the current wallet. */
export const refreshSpentPOIs = async (chainName: NetworkName): Promise<void> => {
  await refreshSpentPOIsForWallet(
    TXIDVersion.V2_PoseidonMerkle,
    chainName,
    getCurrentRailgunID(),
  );
};
