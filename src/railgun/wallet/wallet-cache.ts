/**
 * Keychain file IO.
 *
 * The keychain holds no spending key — the seed is encrypted inside the engine
 * database and recoverable from the mnemonic — but it does hold the wallet
 * index, the salt the engine key is derived against, and the address book.
 * Losing it does not lose funds; it does lose the ability to open the wallet
 * without re-importing, so the write path has to be crash-safe and the read
 * path has to survive a damaged file.
 */
import path from "path";
import * as fs from "fs";
import { KeychainFile } from "../../models/wallet-models";
import { createLogger } from "../../platform/logger";

const log = createLogger("keychain");

const keychainDir = (basePath: string) => path.join(process.cwd(), basePath);

/**
 * Write a file atomically: a reader sees either the previous contents or the
 * complete new ones, never a partial write.
 *
 * The fsync is the part that is easy to omit and the reason to write this by
 * hand. Rename is atomic within a filesystem, but without flushing first the
 * rename can be durable while the data behind it is not — so a crash at the
 * wrong moment leaves a file that exists, has the right name, and is empty or
 * truncated. Which is exactly the corrupt keychain the read path below now has
 * to tolerate.
 */
const atomicWrite = (filePath: string, data: string) => {
  const tmp = `${filePath}.tmp`;
  const handle = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(handle, data, "utf-8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tmp, filePath);
};

export const saveKeychainFile = (
  cacheFile: KeychainFile,
  basePath = ".zKeyChains",
  extension = ".zKey",
) => {
  const dir = keychainDir(basePath);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${cacheFile.name}${extension}`);
  atomicWrite(filePath, JSON.stringify(cacheFile, null, 4));
};

/**
 * Load every keychain in the directory.
 *
 * Each file is parsed in isolation. This used to be one loop with no guard, so
 * a single unreadable or truncated file threw and took the whole boot with it —
 * the wallet could not start, and the file that broke it was not named. A
 * damaged keychain now costs you that keychain and says which one, rather than
 * costing you the application.
 *
 * Results are sorted, because boot falls back to the first entry when nothing
 * is selected and that should not depend on directory iteration order.
 */
export const getRailgunKeychains = async (
  basePath = ".zKeyChains",
  extension = ".zKey",
): Promise<KeychainFile[]> => {
  const dir = keychainDir(basePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const entries = await fs.promises.readdir(dir);
  const found: KeychainFile[] = [];

  for (const name of entries.filter((f) => f.endsWith(extension)).sort()) {
    const filePath = path.join(dir, name);
    try {
      const parsed = JSON.parse(
        await fs.promises.readFile(filePath, "utf-8"),
      ) as KeychainFile;
      // A file that parses but carries no name cannot be written back to the
      // right path, so treat it as damaged rather than loading it and saving it
      // somewhere unexpected later.
      if (!parsed || typeof parsed.name !== "string" || !parsed.name) {
        log.warn(`ignoring ${name}: not a keychain (no name field)`);
        continue;
      }
      found.push(parsed);
    } catch (err) {
      log.warn(`ignoring ${name}: unreadable or corrupt`, err);
    }
  }

  return found;
};
