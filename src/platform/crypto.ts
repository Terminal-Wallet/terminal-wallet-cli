/**
 * Cryptographic primitives.
 *
 * `computePasswordHash` is the RAILGUN engine key derivation — the wallet's
 * stored seed is encrypted against it, so its parameters are load-bearing and
 * do not change. See wallet-password.ts.
 */
import * as crypto from "crypto";
import { randomBytes, scryptSync, toUtf8Bytes } from "ethers";

export const hashString = (input: string) => {
  return crypto.createHash("sha256").update(`${input}`).digest("hex");
};

export const saltedHashString = (input: string, salt: string) => {
  return hashString(`${salt}:${input}`);
};


export const computePasswordHash = async (
  password: string,
  keyLength?: number,
  passwordSalt?: string,
): Promise<string> => {
  const passwordBytes = toUtf8Bytes(password, "NFKC");
  const salt = passwordSalt ?? passwordBytes;
  const keyLen = keyLength ?? 32;
  const hash = scryptSync(passwordBytes, salt, 131072, 8, 1, keyLen);
  return hash.slice(2);
};





// not currently used
export const getIV = (length = 16): string => {
  const iv = randomBytes(length);
  return Buffer.from(iv).toString("hex");
};

