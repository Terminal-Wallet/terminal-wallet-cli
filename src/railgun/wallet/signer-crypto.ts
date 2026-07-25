/**
 * Pure AES-256-GCM encrypt/decrypt for secrets at rest (external signer keys).
 *
 * The encryption key is derived with scrypt (memory-hard) from a caller-supplied
 * secret — in production the wallet's password hash, so the same password that
 * protects the seed protects these — plus a per-blob random salt. Authenticated
 * (GCM): a wrong key / tampered blob throws. No IO, no logging — unit-tested.
 *
 * Blob is versioned so the KDF can evolve. v1 = scrypt(N=2^15,r=8,p=1) + AES-256-GCM.
 */
import crypto from "node:crypto";

const ALGO = "aes-256-gcm";
const KDF = "scrypt" as const;
const VERSION = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
// scrypt cost. N=2^15 needs ~128*N*r ≈ 32MB, above the 32MB default maxmem, so
// raise maxmem explicitly to keep derivation deterministic across machines.
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface EncryptedBlob {
  v: number; // format version
  kdf: string; // key-derivation function ("scrypt")
  salt: string; // hex
  iv: string; // hex
  authTag: string; // hex
  ciphertext: string; // hex
}

const deriveKey = (secret: string, salt: Buffer): Buffer =>
  crypto.scryptSync(secret, salt, KEY_LEN, SCRYPT_PARAMS);

export const encryptSecret = (
  plaintext: string,
  secret: string,
): EncryptedBlob => {
  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(secret, salt), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: VERSION,
    kdf: KDF,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: cipher.getAuthTag().toString("hex"),
    ciphertext: ct.toString("hex"),
  };
};

export const decryptSecret = (blob: EncryptedBlob, secret: string): string => {
  // Validate the envelope before attempting anything with it. This wallet has
  // only ever written v1/scrypt blobs — an unversioned or differently-derived
  // one means corruption or a foreign file, and saying so beats failing later
  // as an opaque GCM authentication error that reads like a wrong password.
  if (blob.v !== VERSION) {
    throw new Error(
      `Unsupported encrypted-signer format (v${String(blob.v)}); expected v${VERSION}.`,
    );
  }
  if (blob.kdf !== KDF) {
    throw new Error(
      `Unsupported key derivation "${String(blob.kdf)}"; expected ${KDF}.`,
    );
  }

  const key = deriveKey(secret, Buffer.from(blob.salt, "hex"));
  const decipher = crypto.createDecipheriv(
    ALGO,
    key,
    Buffer.from(blob.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(blob.authTag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, "hex")),
    decipher.final(),
  ]).toString("utf8");
};
