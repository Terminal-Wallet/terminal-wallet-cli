import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecipientOptions } from "../../../src/flows/recipient-options";

const wallets = [
  { name: "main", railgunWalletAddress: "0zkMAIN", publicAddress: "0xMAIN" },
  { name: "alt", railgunWalletAddress: "0zkALT" }, // no public address
];
const contacts = [
  { name: "alice", publicAddress: "0xALICE", privateAddress: "0zkALICE" },
  { name: "bob", publicAddress: "0xBOB" }, // no 0zk
];

test("0zk options: own wallets (tagged) first, then contacts with a 0zk", () => {
  const opts = buildRecipientOptions(wallets, contacts, "0zk");
  assert.deepEqual(opts, [
    { label: "main (your wallet)", address: "0zkMAIN", kind: "your-wallet" },
    { label: "alt (your wallet)", address: "0zkALT", kind: "your-wallet" },
    { label: "alice", address: "0zkALICE", kind: "contact" },
  ]);
});

test("the active wallet is tagged '(this wallet)' and marked distinctly", () => {
  const opts = buildRecipientOptions(wallets, contacts, "0zk", "main");
  assert.equal(opts[0].label, "main (this wallet)");
  assert.equal(opts[0].kind, "this-wallet");
  assert.equal(opts[1].kind, "your-wallet");
});

test("0x options skip wallets/contacts lacking a public address", () => {
  const opts = buildRecipientOptions(wallets, contacts, "0x");
  assert.deepEqual(opts.map((o) => o.label), [
    "main (your wallet)",
    "alice",
    "bob",
  ]);
});

test("addresses are de-duplicated case-insensitively", () => {
  const opts = buildRecipientOptions(
    [{ name: "w", publicAddress: "0xAbC" }],
    [{ name: "dup", publicAddress: "0xabc" }],
    "0x",
  );
  assert.equal(opts.length, 1);
  assert.equal(opts[0].label, "w (your wallet)");
});
