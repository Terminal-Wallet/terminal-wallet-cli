import path from "path";
import { decryptObject } from "../util/crypto";
import { KeychainFile, EncryptedCacheFile } from "../models/wallet-models";
import * as fs from "fs";

export const saveKeychainFile = (
  cacheFile: KeychainFile,
  basePath = ".zKeyChains",
  extension = ".zKey",
) => {
  const jsonFileData = JSON.stringify(cacheFile, null, 4);
  const filePath = path.join(
    process.cwd(),
    basePath,
    `${cacheFile.name}${extension}`,
  );
  fs.writeFileSync(filePath, jsonFileData, "utf-8");
};

// not currently used
export const decryptCacheFile = async (
  password: string,
  cacheFile: EncryptedCacheFile,
) => {
  const { iv, encryptedData } = cacheFile;

  const passwordBuf = Buffer.from(password, "hex");
  const ivBuf = Buffer.from(iv, "hex");
  const decrypted = decryptObject(encryptedData, passwordBuf, ivBuf);

  return decrypted;
};

export const getRailgunKeychains = (
  basePath = ".zKeyChains",
  extension = ".zKey",
): Promise<KeychainFile[]> => {
  const folderPath = basePath;

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
              fileName.endsWith(extension),
            );
            const foundCaches = [];
            for (const file of railgunFiles) {
              const fpath = path.join(process.cwd(), folderPath, file);
              const fileData = JSON.parse(
                fs.readFileSync(fpath, "utf-8"),
              ) as KeychainFile;
              foundCaches.push(fileData);
            }
            resolve(foundCaches);
          }
        });
      }
    });
  });
};
