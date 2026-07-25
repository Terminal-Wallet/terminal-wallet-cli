import * as crypto from "crypto";
import * as fs from "fs";
import path = require("path");
import { RailWalletFile } from "../models/wallet-models";
import { randomBytes, scryptSync, toUtf8Bytes } from "ethers";

export const hashString = (input: string) => {
  return crypto.createHash("sha256").update(`${input}`).digest("hex");
};

export const saltedHashString = (input: string, salt: string) => {
  return hashString(`${salt}:${input}`);
};

export const generateSecretKeyFromString = (input: string): Buffer => {
  const keyLength = 32; // 32 bytes = 256 bits for AES-256
  const hash = crypto.createHash("sha256");
  hash.update(input, "utf8");
  const hashedData = hash.digest();
  const key = hashedData.slice(0, keyLength);
  return key;
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
export const computePasswordIV = async (passwordHash: string) => {
  const ivHash = await computePasswordHash(passwordHash, 16);
  return ivHash;
};

// not currently used
// Encryption function
export const encryptObject = (
  object: object,
  secretKey: string,
  iv: Buffer,
): string => {
  const jsonString = JSON.stringify(object);
  const cipher = crypto.createCipheriv("aes-256-cbc", secretKey, iv);
  let encryptedData = cipher.update(jsonString, "utf8", "hex");
  encryptedData += cipher.final("hex");
  return encryptedData;
};

// not currently used
// Decryption function
export const decryptObject = (
  encryptedData: string,
  secretKey: Buffer,
  iv: Buffer,
): RailWalletFile => {
  const decipher = crypto.createDecipheriv("aes-256-cbc", secretKey, iv);
  let decryptedData = decipher.update(encryptedData, "hex", "utf8");
  decryptedData += decipher.final("utf8");
  return JSON.parse(decryptedData);
};

// not currently used
// Function to read an encrypted file and return the decrypted object
export const decryptReadFile = (
  filePath: string,
  secretKey: Buffer,
  // iv: Buffer,
): Promise<RailWalletFile> => {
  return new Promise((resolve, reject) => {
    fs.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        reject(err);
        return;
      }

      try {
        const rawData = JSON.parse(data);
        const iv = Buffer.from(rawData.iv, "hex");
        const decryptedObject = decryptObject(
          rawData.encryptedData,
          secretKey,
          iv,
        ) as RailWalletFile;

        resolve({ ...decryptedObject, iv });
      } catch (error) {
        reject(error);
      }
    });
  });
};

// not currently used
export const getIV = (length = 16): string => {
  const iv = randomBytes(length);
  return Buffer.from(iv).toString("hex");
};

// not currently used
export const encryptWriteFile = (
  fileName: string,
  keyChainName: string,
  object: object,
  secretKey: string,
  iv: Buffer,
): Promise<void> => {
  return new Promise((resolve, reject) => {
    try {
      const encryptedData = encryptObject(object, secretKey, iv);

      const rawData = JSON.stringify(
        {
          name: keyChainName,
          iv: iv.toString("hex"),
          encryptedData,
        },
        null,
        2,
      );
      const filePath = path.join(
        process.cwd(),
        ".wallets",
        `${fileName}.railgun`,
      );
      fs.writeFile(filePath, rawData, "utf8", (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });
};
// not currently used
export const getRailgunFiles = (): Promise<string[]> => {
  const folderPath = ".wallets";

  return new Promise((resolve, reject) => {
    fs.access(folderPath, (err) => {
      if (err) {
        // Folder doesn't exist, create it
        fs.mkdir(folderPath, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve([]);
          }
        });
      } else {
        // Folder exists, read its contents
        fs.readdir(folderPath, (error, files) => {
          if (error) {
            reject(error);
          } else {
            const railgunFiles = files.filter((fileName) =>
              fileName.endsWith(".railgun"),
            );
            resolve(railgunFiles);
          }
        });
      }
    });
  });
};
