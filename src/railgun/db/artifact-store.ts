import { ArtifactStore } from "@railgun-community/wallet";
import fs from "fs";

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
    await fs.promises.mkdir(createDownloadDirPath(documentsDir, dir), {
      recursive: true,
    });
    await fs.promises.writeFile(
      createDownloadDirPath(documentsDir, path),
      item,
    );
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
