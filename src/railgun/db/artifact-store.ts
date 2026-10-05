import { ArtifactStore } from "@railgun-community/wallet";
import { randomBytes } from "crypto";
import fs from "fs";
import nodePath from "path";

const createDownloadDirPath = (documentsDir: string, path: string) => {
  return `${documentsDir}/${path}`;
};

export const createArtifactStore = (documentsDir: string): ArtifactStore => {
  const getFile = async (path: string) => {
    return fs.promises.readFile(createDownloadDirPath(documentsDir, path));
  };

  const storeFile = async (
    dir: string,
    path: string,
    item: string | Uint8Array,
  ) => {
    const target = createDownloadDirPath(documentsDir, path);
    await fs.promises.mkdir(createDownloadDirPath(documentsDir, dir), {
      recursive: true,
    });
    await fs.promises.mkdir(nodePath.dirname(target), { recursive: true });

    const partial = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.partial`;
    try {
      await fs.promises.writeFile(partial, item);
      await fs.promises.rename(partial, target);
    } catch (err) {
      await fs.promises.rm(partial, { force: true });
      throw err;
    }
  };

  const fileExists = (path: string): Promise<boolean> => {
    return new Promise((resolve) => {
      fs.promises
        .access(createDownloadDirPath(documentsDir, path))
        .then(() => resolve(true))
        .catch(() => resolve(false));
    });
  };

  return new ArtifactStore(getFile, storeFile, fileExists);
};
