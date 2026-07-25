/**
 * Proves the harness itself works: the runner resolves TypeScript, the shared
 * fixture barrel imports, and assertions fail when they should. Without this,
 * `npm test` passes vacuously on an empty suite and the gate means nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOKENS, NETWORKS, privateGasEstimate } from "../_support";

test("fixture barrel resolves", () => {
  assert.ok(Object.keys(TOKENS).length > 0, "TOKENS should not be empty");
  assert.ok(Object.keys(NETWORKS).length > 0, "NETWORKS should not be empty");
});

test("fixture factories apply overrides", () => {
  const estimate = privateGasEstimate({ estimatedCost: 1.25 });
  assert.equal(estimate.estimatedCost, 1.25);
  assert.equal(estimate.symbol, "ETH", "unspecified fields keep their default");
});

test("assertions actually fail", () => {
  assert.throws(() => assert.equal(1, 2));
});
