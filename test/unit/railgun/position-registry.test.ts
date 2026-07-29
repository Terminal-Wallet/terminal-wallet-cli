/**
 * The slot registry, which is only interesting when it is wrong.
 *
 * It is a convenience, not an authority — the accounts derive from the seed, so
 * losing it costs a rediscovery scan rather than the positions. Everything here
 * tests that a lost or stale registry degrades into "look again", never into
 * "hand a new position the account of an open one".
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NetworkName } from "@railgun-community/shared-models";
import {
  allocatePositionAccount,
  listPositionAccounts,
  recordPositionAccount,
  releasePositionAccount,
} from "../../../src/railgun/wallet/position-registry";
import { PositionSlotsExhausted } from "../../../src/railgun/wallet/position-account";
import { walletManager } from "../../../src/railgun/wallet/wallet-manager";

const WALLET = "registry-test-wallet";

/**
 * Run in a scratch directory.
 *
 * `saveKeychainFile` resolves its path against the cwd, so every registry write
 * these tests provoke used to land in the working checkout's own `.zKeyChains`
 * — one `registry-test-<n>.zKey` per invocation, 590 of them by the time it was
 * noticed. They parse as valid keychains, so boot stopped opening the single
 * keychain and started asking which of six hundred to use.
 *
 * The keychain still gets written; it is written somewhere disposable.
 */
let cwd: string;
let tmp: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "registry-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * An in-memory keychain. The real one writes a file on every change, which is
 * the behaviour under test only insofar as it must not throw.
 */
const withKeychain = async (run: () => Promise<void>) => {
  const previous = walletManager.keyChain;
  walletManager.keyChain = {
    name: `registry-test-${Math.trunc(process.hrtime()[1])}`,
    salt: "0x",
    positionAccounts: {},
  } as never;
  try {
    await run();
  } finally {
    walletManager.keyChain = previous;
  }
};

const args = (over: Record<string, unknown> = {}) => ({
  chainName: NetworkName.Ethereum,
  encryptionKey: "0".repeat(64),
  marketId: "0xmarket",
  loanToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  collateralToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  confirmUnused: async () => true,
  railgunWalletID: WALLET,
  // The real one needs a live engine; the rules under test do not.
  deriveAddress: async (slot: number) =>
    `0x${String(slot).padStart(40, "e")}`,
  ...over,
});

test("a fresh wallet has no position accounts", async () => {
  await withKeychain(async () => {
    assert.deepEqual(listPositionAccounts(WALLET), []);
  });
});

test("an occupied slot is skipped even when the registry has no record of it", async () => {
  // The case that matters: a registry lost or predating the position. Taking
  // the slot would give a new position the account of an open one, and Morpho
  // would read the two as one position with both sets of collateral and debt.
  await withKeychain(async () => {
    const seen: number[] = [];
    const record = await allocatePositionAccount(
      args({
        confirmUnused: async (_address: string, slot: number) => {
          seen.push(slot);
          return slot >= 2; // slots 0 and 1 are in use on chain
        },
      }),
    );
    assert.deepEqual(seen, [0, 1, 2], "should have walked up past the used slots");
    assert.equal(record.slot, 2);
  });
});

test("a slot that cannot be confirmed is never taken", async () => {
  // An RPC failure must not read as "probably free".
  await withKeychain(async () => {
    await assert.rejects(
      allocatePositionAccount(args({ confirmUnused: async () => false })),
      PositionSlotsExhausted,
    );
    assert.deepEqual(listPositionAccounts(WALLET), [], "nothing should be recorded");
  });
});

test("allocation records the market so a later scan knows what it is looking at", async () => {
  await withKeychain(async () => {
    const record = await allocatePositionAccount(args());
    const stored = listPositionAccounts(WALLET);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].slot, record.slot);
    assert.equal(stored[0].marketId, "0xmarket");
    assert.equal(stored[0].loanToken, args().loanToken);
    assert.equal(stored[0].collateralToken, args().collateralToken);
    assert.ok(stored[0].openedAt > 0);
    assert.ok(record.address.startsWith("0x"), "the caller gets the address too");
  });
});

test("two positions take different slots", async () => {
  await withKeychain(async () => {
    const first = await allocatePositionAccount(args());
    const second = await allocatePositionAccount(args({ marketId: "0xother" }));
    assert.notEqual(first.slot, second.slot);
    assert.equal(listPositionAccounts(WALLET).length, 2);
  });
});

test("releasing frees the slot for reuse", async () => {
  await withKeychain(async () => {
    const first = await allocatePositionAccount(args());
    releasePositionAccount(first.slot, WALLET);
    assert.deepEqual(listPositionAccounts(WALLET), []);
    const reused = await allocatePositionAccount(args({ marketId: "0xnew" }));
    assert.equal(reused.slot, first.slot, "the freed slot should come back");
  });
});

test("releasing a slot that is not held is a no-op, not a corruption", async () => {
  await withKeychain(async () => {
    await allocatePositionAccount(args());
    releasePositionAccount(61, WALLET);
    assert.equal(listPositionAccounts(WALLET).length, 1);
  });
});

test("rediscovery can write back a slot the registry never knew about", async () => {
  await withKeychain(async () => {
    recordPositionAccount(
      { slot: 5, marketId: "0xfound", loanToken: "0xa", collateralToken: "0xb", openedAt: 1 },
      WALLET,
    );
    assert.deepEqual(listPositionAccounts(WALLET).map((r) => r.slot), [5]);
    // Writing the same slot again replaces rather than duplicates it.
    recordPositionAccount(
      { slot: 5, marketId: "0xupdated", loanToken: "0xa", collateralToken: "0xb", openedAt: 2 },
      WALLET,
    );
    const stored = listPositionAccounts(WALLET);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].marketId, "0xupdated");
  });
});

test("records are kept per RAILGUN wallet, because the same slot is a different account", async () => {
  // The ephemeral derivation path embeds the wallet's own index, so sharing a
  // record across wallets would point at the wrong address.
  await withKeychain(async () => {
    await allocatePositionAccount(args());
    assert.equal(listPositionAccounts(WALLET).length, 1);
    assert.deepEqual(listPositionAccounts("a-different-wallet"), []);
  });
});
