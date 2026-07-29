/**
 * The settlement verdict comes from the receipt, not from the watcher.
 *
 * This is the control for the whole reporting path. `waitOnTx` deliberately
 * swallows the rejection ethers throws for a reverted receipt — it has to,
 * because the same catch handles the yParity parse failure that a mined 7702
 * transaction produces. So the wait resolving is not evidence of anything, and
 * the wallet reported "Transaction mined" for reverted sends because that was
 * the only signal it had.
 *
 * The rule lives in a leaf module with no path to a provider, so these run
 * without standing up the network stack. The two source-text tests at the
 * bottom cover the wiring the leaf cannot see.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ReceiptReader,
  settlementFromReceipt,
} from "../../../src/railgun/transaction/public/settlement";

const HASH = "0x" + "ab".repeat(32);

const reader = (
  receipt: { status?: number | null; blockNumber?: number } | null,
): ReceiptReader => ({ getTransactionReceipt: async () => receipt });

test("a status-0 receipt is reverted", async () => {
  const settlement = await settlementFromReceipt(
    reader({ status: 0, blockNumber: 21_000_000 }),
    HASH,
  );
  assert.equal(settlement.kind, "reverted");
});

test("a status-1 receipt is mined and carries its block", async () => {
  const settlement = await settlementFromReceipt(
    reader({ status: 1, blockNumber: 21_000_001 }),
    HASH,
  );
  assert.equal(settlement.kind, "mined");
  assert.equal(
    settlement.kind === "mined" ? settlement.blockNumber : undefined,
    21_000_001,
  );
});

test("no receipt is unknown — not mined, and not reverted either", async () => {
  // A timed-out wait lands here. An RPC that will not answer is not evidence of
  // failure, so this stays distinct from both rather than collapsing into the
  // safe-looking one.
  const settlement = await settlementFromReceipt(reader(null), HASH);
  assert.equal(settlement.kind, "unknown");
});

test("a receipt read that throws is unknown, and says why", async () => {
  const settlement = await settlementFromReceipt(
    {
      getTransactionReceipt: async () => {
        throw new Error("could not coalesce error");
      },
    },
    HASH,
  );
  assert.equal(settlement.kind, "unknown");
  assert.match(settlement.kind === "unknown" ? settlement.reason : "", /coalesce/);
});

test("a receipt with no status is unknown rather than assumed successful", async () => {
  const settlement = await settlementFromReceipt(reader({ blockNumber: 1 }), HASH);
  assert.equal(settlement.kind, "unknown");
});

test("a missing provider is unknown, not an exception", async () => {
  const settlement = await settlementFromReceipt(undefined, HASH);
  assert.equal(settlement.kind, "unknown");
});

// --- wiring -----------------------------------------------------------------
// public-tx.ts cannot be imported here: it reaches the provider stack, and doing
// so costs minutes of wall-clock before a single assertion runs. Read the source
// instead, which is what the rest of the suite does for that module.

const source = (rel: string) =>
  fs.readFileSync(path.join(__dirname, "../../../src", rel), "utf8");

test("both waiters end by reading the receipt", () => {
  const text = source("railgun/transaction/public/public-tx.ts");
  const returns = text.match(/return settlementFromReceipt\(/g) ?? [];
  assert.equal(
    returns.length,
    2,
    "waitForTx and waitForRelayedTx must each end by classifying the receipt",
  );
});

test("neither send path reports mined without checking the settlement first", () => {
  for (const rel of ["flows/send-private.ts", "flows/send-public.ts"]) {
    const text = source(rel);
    assert.match(
      text,
      /settlement\.kind/,
      `${rel} reports an outcome without consulting the settlement`,
    );
    assert.doesNotMatch(
      text,
      /\.then\(\(\) =>\s*(deps\.)?notifyMined/,
      `${rel} still chains notifyMined off the watcher resolving`,
    );
  }
});
