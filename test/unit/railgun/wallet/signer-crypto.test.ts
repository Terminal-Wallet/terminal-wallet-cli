/**
 * Encryption for imported signing keys.
 *
 * These keys pay gas from an address the user controls outside this wallet, so
 * a leaked one is a direct loss with no recovery path — unlike the RAILGUN
 * seed, which is reconstructable from the mnemonic. That makes the derivation
 * cost here load-bearing rather than a formality.
 *
 * The branch this design came from derived its key with a single unsalted
 * SHA-256 round, which is offline-brute-forceable at commodity rates and, being
 * unsalted, shares that work across every user. That version was never
 * committed here, so there are no legacy blobs and no migration — the format is
 * versioned from birth and anything else is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptSecret,
  decryptSecret,
  EncryptedBlob,
} from "../../../../src/railgun/wallet/signer-crypto";

const SECRET = "a-derived-wallet-key"; // pragma: allowlist secret
const PLAINTEXT =
  "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

test("round-trips", () => {
  const blob = encryptSecret(PLAINTEXT, SECRET);
  assert.equal(decryptSecret(blob, SECRET), PLAINTEXT);
});

test("the ciphertext does not contain the plaintext", () => {
  const blob = encryptSecret(PLAINTEXT, SECRET);
  assert.ok(!JSON.stringify(blob).includes(PLAINTEXT));
});

test("a wrong password is rejected, not silently wrong", () => {
  const blob = encryptSecret(PLAINTEXT, SECRET);
  assert.throws(() => decryptSecret(blob, "not-the-password"));
});

test("tampering with the ciphertext is detected", () => {
  // GCM authenticates: a flipped byte must fail rather than decrypt to garbage
  // that then gets loaded as a signing key.
  const blob = encryptSecret(PLAINTEXT, SECRET);
  const flipped = blob.ciphertext.startsWith("a") ? "b" : "a";
  const tampered = { ...blob, ciphertext: flipped + blob.ciphertext.slice(1) };
  assert.throws(() => decryptSecret(tampered, SECRET));
});

test("tampering with the auth tag is detected", () => {
  const blob = encryptSecret(PLAINTEXT, SECRET);
  const flipped = blob.authTag.startsWith("a") ? "b" : "a";
  assert.throws(() =>
    decryptSecret({ ...blob, authTag: flipped + blob.authTag.slice(1) }, SECRET),
  );
});

test("each encryption uses a fresh salt and IV", () => {
  // Reusing either across blobs would let two secrets be compared, and reusing
  // an IV under one key breaks GCM outright.
  const a = encryptSecret(PLAINTEXT, SECRET);
  const b = encryptSecret(PLAINTEXT, SECRET);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
});

test("the salt participates — the same password yields a different key", () => {
  const a = encryptSecret(PLAINTEXT, SECRET);
  const wrongSalt: EncryptedBlob = { ...a, salt: encryptSecret("x", "y").salt };
  assert.throws(() => decryptSecret(wrongSalt, SECRET));
});

test("an unversioned or foreign blob is refused explicitly", () => {
  const blob = encryptSecret(PLAINTEXT, SECRET);
  assert.throws(
    () => decryptSecret({ ...blob, v: 0 }, SECRET),
    /Unsupported encrypted-signer format/,
  );
  assert.throws(
    () => decryptSecret({ ...blob, kdf: "sha256" }, SECRET),
    /Unsupported key derivation/,
  );
});

test("the KDF is memory-hard and its cost is not quietly lowered", () => {
  // A regression here would not fail any other test — it would just make every
  // stored key cheaper to attack, silently. Timing is the only observable
  // signal, so assert the derivation is not free.
  const started = process.hrtime.bigint();
  encryptSecret(PLAINTEXT, SECRET);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(
    elapsedMs > 5,
    `derivation took ${elapsedMs.toFixed(1)}ms — too fast for a memory-hard KDF; ` +
      "check the scrypt cost parameters were not reduced",
  );
});
