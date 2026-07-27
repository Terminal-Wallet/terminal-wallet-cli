/**
 * Waiting on a transaction ethers refuses to model.
 *
 * An EIP-7702 (type 0x4) send comes back from some RPCs with the outer
 * signature zeroed and `yParity` set. ethers 6.14 validates the two against
 * each other and throws `yParity mismatch` while PARSING — the transaction
 * itself is mined and successful, and the authorization inside it carries the
 * real signature.
 *
 * The old behaviour reported that as "Transaction <hash> error: …" and then
 * returned without waiting for anything, so a relayed private send was never
 * actually watched. These assert the recovery, not the parse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/** The rule, extracted so it can be asserted without a chain. */
const isUnmodellable = (err: unknown): boolean => {
  const { code, message } = (err ?? {}) as { code?: string; message?: string };
  const text = message ?? "";
  return (
    (code === "INVALID_ARGUMENT" && /signature|yParity/i.test(text)) ||
    /yParity/i.test(text)
  );
};

test("a parse failure is told apart from a rejected transaction", () => {
  // The real one, as reported: ethers 6.14.3 on a mined 7702 swap.
  const parse = Object.assign(new Error('yParity mismatch (argument="signature", value={…})'), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(isUnmodellable(parse), true);

  // A chain-level failure must NOT be swallowed as a parse problem — that
  // would turn a reverted transaction into a silent wait.
  const reverted = Object.assign(new Error("execution reverted: insufficient balance"), {
    code: "CALL_EXCEPTION",
  });
  assert.equal(isUnmodellable(reverted), false);
  assert.equal(isUnmodellable(new Error("network timeout")), false);
  assert.equal(isUnmodellable(undefined), false);

  // INVALID_ARGUMENT is ethers' code for ANY bad argument, and this same catch
  // sees a malformed hash. Treating the code alone as "cannot model it" turns
  // an immediate, accurate error into a three-minute poll for a transaction
  // that was never submitted.
  const badHash = Object.assign(new Error('invalid hash (argument="hash", value="0xzz")'), {
    code: "INVALID_ARGUMENT",
  });
  assert.equal(isUnmodellable(badHash), false, "a malformed request was mistaken for a 7702 response");
});

test("the wallet keeps the rule and the recovery together", async () => {
  // Guards the guard: if the predicate or the receipt fallback is edited away,
  // the symptom returns as an error line on a transaction that succeeded.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    "src/railgun/transaction/public/public-tx.ts",
    "utf-8",
  );
  assert.match(source, /isUnmodellable/, "the parse-failure rule is gone");
  assert.match(
    source,
    /waitForTransaction\(txHash, 1, txTimeout\)/,
    "a transaction ethers cannot parse is no longer waited on by receipt",
  );
});
