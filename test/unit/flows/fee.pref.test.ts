import { test } from "node:test";
import assert from "node:assert/strict";
import { feePrefValue, parseFeePref } from "../../../src/flows/fee";
import { FeeMode } from "../../../src/flows/spec";

test("feePrefValue serializes self/external and collapses broadcaster to self", () => {
  assert.equal(
    feePrefValue({ kind: "external-signer", label: "gas-1" }),
    "external:gas-1",
  );
  assert.equal(
    feePrefValue({ kind: "self-signer", signer: {} as any }),
    "self-signer",
  );
  // A broadcaster is per-tx, never a stored default → treated as self.
  const broadcaster = { kind: "broadcaster", broadcaster: {} as any } as FeeMode;
  assert.equal(feePrefValue(broadcaster), "self-signer");
});

test("parseFeePref resolves a known external label", () => {
  assert.deepEqual(parseFeePref("external:gas-1", ["gas-1", "gas-2"]), {
    kind: "external-signer",
    label: "gas-1",
  });
});

test("parseFeePref falls back to self when the label is gone or pref is blank", () => {
  assert.deepEqual(parseFeePref("external:removed", ["gas-1"]), { kind: "self-signer" });
  assert.deepEqual(parseFeePref(undefined, []), { kind: "self-signer" });
  assert.deepEqual(parseFeePref("self-signer", []), { kind: "self-signer" });
});

test("feePrefValue and parseFeePref round-trip for external signers", () => {
  const pref = feePrefValue({ kind: "external-signer", label: "ledger" });
  assert.deepEqual(parseFeePref(pref, ["ledger"]), {
    kind: "external-signer",
    label: "ledger",
  });
});
