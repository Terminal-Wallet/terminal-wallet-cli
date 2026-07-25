import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecipient } from "../../../src/flows/spec";

const token = { tokenAddress: "0xToken", decimals: 6 };

test("buildRecipient parses the amount with the token decimals", () => {
  const r = buildRecipient(token, "1.5", "0xRecipient");
  assert.deepEqual(r, {
    tokenAddress: "0xToken",
    amount: 1_500000n,
    recipientAddress: "0xRecipient",
  });
});

test("buildRecipient trims the recipient address", () => {
  const r = buildRecipient(token, "1", "  0xR  ");
  assert.equal(r?.recipientAddress, "0xR");
});

test("buildRecipient rejects empty recipient, zero, and bad amounts", () => {
  assert.equal(buildRecipient(token, "1", "   "), undefined);
  assert.equal(buildRecipient(token, "0", "0xR"), undefined);
  assert.equal(buildRecipient(token, "abc", "0xR"), undefined);
});
