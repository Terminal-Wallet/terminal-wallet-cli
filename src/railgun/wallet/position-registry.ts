/**
 * Which reserved slot holds which position.
 *
 * A convenience, deliberately not an authority. The accounts derive
 * deterministically from the seed, so losing this file costs a rediscovery
 * scan rather than the positions themselves — and everything here is written
 * so that a lost or stale registry degrades into "scan the chain", never into
 * "allocate a slot that is already holding collateral".
 *
 * That last point is the whole reason allocation takes a confirmation callback.
 * Absence from the registry is not evidence a slot is free: the file may
 * predate a position, may have been deleted by the destruct flow, or may belong
 * to a wallet restored on another machine. Allocating on absence alone would
 * hand a new position the account of an open one, and Morpho would read the two
 * as a single position carrying both sets of collateral and debt.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { PositionAccountRecord } from "../../models/wallet-models";
import { walletManager } from "./wallet-manager";
import { saveKeychainFile } from "./wallet-cache";
import { getCurrentRailgunID } from "./wallet-util";
import { getTokenInfo } from "../balance/token-util";
import configDefaults from "../../config/config-defaults";
import {
  MAX_POSITION_SLOTS,
  PositionSlotsExhausted,
  nextFreeSlot,
  positionAccountAddress,
} from "./position-account";
import { createLogger } from "../../platform/logger";

const log = createLogger("position-registry");

/** Every position this wallet has a slot recorded for. */
export const listPositionAccounts = (
  railgunWalletID: string = getCurrentRailgunID(),
): PositionAccountRecord[] =>
  walletManager.keyChain?.positionAccounts?.[railgunWalletID] ?? [];

const persist = (
  railgunWalletID: string,
  records: PositionAccountRecord[],
): void => {
  const { keyChain } = walletManager;
  if (!keyChain) return;
  keyChain.positionAccounts ??= {};
  keyChain.positionAccounts[railgunWalletID] = records;
  saveKeychainFile(keyChain, configDefaults.engine.keyChainPath);
};

/**
 * Teach the wallet about a market's two tokens.
 *
 * The recovery scanner enumerates a curated token list, so a token it has never
 * heard of is invisible to it. Registering both at allocation means residue
 * left at a position account by a partly-failed batch shows up forever after,
 * with no dependence on a log query still being in range.
 */
const rememberMarketTokens = async (
  chainName: NetworkName,
  loanToken: string,
  collateralToken: string,
): Promise<void> => {
  for (const token of [loanToken, collateralToken]) {
    // getTokenInfo writes what it reads into the persisted token database.
    await getTokenInfo(chainName, token).catch((err) =>
      log.debug(`could not register ${token} for recovery scanning`, err),
    );
  }
};

export interface AllocateArgs {
  chainName: NetworkName;
  encryptionKey: string;
  marketId: string;
  loanToken: string;
  collateralToken: string;
  /**
   * Positive evidence that an account has never held a position.
   *
   * Called with the slot's derived address; must return true only when the
   * chain says it is unused. An RPC failure must surface as `false` or a
   * throw — never as "probably fine" — because a wrongly-freed slot is
   * collateral handed to a stranger's bookkeeping.
   */
  confirmUnused: (address: string, slot: number) => Promise<boolean>;
  railgunWalletID?: string;
  /**
   * How a slot's address is derived. Defaults to the wallet's own derivation;
   * injected so the allocation rules can be exercised without an engine, since
   * they are the part that decides whether collateral is safe.
   */
  deriveAddress?: (slot: number) => Promise<string>;
}

/**
 * Reserve a slot for a new position.
 *
 * Walks upward from the lowest gap, confirming each candidate against the chain
 * before taking it, so a registry that has lost entries recovers rather than
 * collides.
 */
export const allocatePositionAccount = async ({
  chainName,
  encryptionKey,
  marketId,
  loanToken,
  collateralToken,
  confirmUnused,
  railgunWalletID = getCurrentRailgunID(),
  deriveAddress = (slot) => positionAccountAddress(chainName, encryptionKey, slot),
}: AllocateArgs): Promise<PositionAccountRecord & { address: string }> => {
  const records = listPositionAccounts(railgunWalletID);
  const taken = new Set(records.map((r) => r.slot));

  for (let slot = nextFreeSlot([...taken]); slot < MAX_POSITION_SLOTS; slot++) {
    if (taken.has(slot)) continue;
    const address = await deriveAddress(slot);
    if (!(await confirmUnused(address, slot))) {
      // In use despite not being recorded — the registry was incomplete. Note
      // it so the next allocation skips it too, and keep looking.
      log.debug(`slot ${slot} (${address}) is already in use; skipping`);
      taken.add(slot);
      continue;
    }
    await rememberMarketTokens(chainName, loanToken, collateralToken);
    const record: PositionAccountRecord = {
      slot,
      marketId,
      loanToken,
      collateralToken,
      openedAt: Date.now(),
    };
    persist(railgunWalletID, [...records, record]);
    log.debug(`position ${marketId} allocated slot ${slot} (${address})`);
    return { ...record, address };
  }
  throw new PositionSlotsExhausted();
};

/**
 * Forget a slot once its position is closed.
 *
 * Only ever called after the chain says the position is empty. Forgetting one
 * that still holds collateral would make the slot look free, and the next
 * allocation would confirm-and-reject it — recoverable, but it would read as a
 * phantom slot leak, so the ordering matters.
 */
export const releasePositionAccount = (
  slot: number,
  railgunWalletID: string = getCurrentRailgunID(),
): void => {
  const records = listPositionAccounts(railgunWalletID);
  const remaining = records.filter((r) => r.slot !== slot);
  if (remaining.length === records.length) return;
  persist(railgunWalletID, remaining);
  log.debug(`slot ${slot} released`);
};

/**
 * Record a position the registry did not know about.
 *
 * What rediscovery writes back after finding a slot occupied on chain. Replaces
 * any existing record for that slot rather than duplicating it.
 */
export const recordPositionAccount = (
  record: PositionAccountRecord,
  railgunWalletID: string = getCurrentRailgunID(),
): void => {
  const records = listPositionAccounts(railgunWalletID).filter(
    (r) => r.slot !== record.slot,
  );
  persist(railgunWalletID, [...records, record].sort((a, b) => a.slot - b.slot));
};
