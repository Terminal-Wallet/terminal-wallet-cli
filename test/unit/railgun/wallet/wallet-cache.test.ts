/**
 * Keychain IO — the failure modes that used to be unrecoverable.
 *
 * Two of these describe real bugs rather than hypotheticals. One damaged file in
 * the keychain directory made the wallet refuse to start, with nothing naming
 * the file responsible; and the write path was a plain writeFileSync, so an
 * interrupted save is what produced such a file in the first place.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import path from "path";
import os from "os";
import {
  saveKeychainFile,
  getRailgunKeychains,
} from "../../../../src/railgun/wallet/wallet-cache";
import { KeychainFile } from "../../../../src/models/wallet-models";

const DIR = ".test-keychains";
let cwd: string;
let tmp: string;

const keychain = (name: string): KeychainFile =>
  ({ name, salt: `0xsalt-${name}` }) as KeychainFile;

const abs = () => path.join(process.cwd(), DIR);

beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kc-"));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("round-trips a keychain", async () => {
  saveKeychainFile(keychain("alpha"), DIR);
  const loaded = await getRailgunKeychains(DIR);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].name, "alpha");
  assert.equal(loaded[0].salt, "0xsalt-alpha");
});

test("creates the directory rather than failing when it is absent", async () => {
  assert.deepEqual(await getRailgunKeychains(DIR), []);
  assert.ok(fs.existsSync(abs()));
});

test("ONE corrupt file does not stop the others loading", async () => {
  // The bug: a single unparseable file threw inside the read loop and took the
  // whole boot with it, so a damaged keychain meant the wallet would not start.
  saveKeychainFile(keychain("alpha"), DIR);
  saveKeychainFile(keychain("beta"), DIR);
  fs.writeFileSync(path.join(abs(), "broken.zKey"), "{ not json");

  const loaded = await getRailgunKeychains(DIR);
  assert.deepEqual(
    loaded.map((k) => k.name).sort(),
    ["alpha", "beta"],
    "a corrupt neighbour must not take the good keychains with it",
  );
});

test("a truncated file — what an interrupted write leaves — is skipped", async () => {
  saveKeychainFile(keychain("alpha"), DIR);
  const full = fs.readFileSync(path.join(abs(), "alpha.zKey"), "utf-8");
  fs.writeFileSync(
    path.join(abs(), "half.zKey"),
    full.slice(0, Math.floor(full.length / 2)),
  );
  const loaded = await getRailgunKeychains(DIR);
  assert.deepEqual(loaded.map((k) => k.name), ["alpha"]);
});

test("an empty file is skipped", async () => {
  saveKeychainFile(keychain("alpha"), DIR);
  fs.writeFileSync(path.join(abs(), "empty.zKey"), "");
  assert.equal((await getRailgunKeychains(DIR)).length, 1);
});

test("valid JSON that is not a keychain is skipped", async () => {
  // Parses fine but has no name, so it could not be written back to the right
  // path — loading it would mean silently saving somewhere unexpected later.
  saveKeychainFile(keychain("alpha"), DIR);
  fs.writeFileSync(path.join(abs(), "notakeychain.zKey"), '{"hello":"world"}');
  assert.equal((await getRailgunKeychains(DIR)).length, 1);
});

test("files without the extension are ignored", async () => {
  saveKeychainFile(keychain("alpha"), DIR);
  fs.writeFileSync(path.join(abs(), "notes.txt"), "scratch");
  assert.equal((await getRailgunKeychains(DIR)).length, 1);
});

test("a save leaves no temp file behind", async () => {
  saveKeychainFile(keychain("alpha"), DIR);
  const stray = fs.readdirSync(abs()).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(stray, [], `temp files left behind: ${stray.join()}`);
});

test("overwriting is atomic — a reader never sees a partial file", async () => {
  // The write goes to a temp path and is renamed, so at no point does the real
  // path hold half a document. Approximated here by checking the target is
  // always parseable across repeated overwrites of differing size.
  saveKeychainFile(keychain("alpha"), DIR);
  const target = path.join(abs(), "alpha.zKey");
  for (let i = 0; i < 20; i++) {
    const kc = keychain("alpha");
    (kc as unknown as { pad: string }).pad = "x".repeat(i * 500);
    saveKeychainFile(kc, DIR);
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(target, "utf-8")));
  }
});

test("keychains load in a stable order", async () => {
  // Boot falls back to the first entry when nothing is selected, so the
  // ordering must not depend on directory iteration order.
  for (const n of ["delta", "alpha", "charlie", "bravo"]) {
    saveKeychainFile(keychain(n), DIR);
  }
  const a = (await getRailgunKeychains(DIR)).map((k) => k.name);
  const b = (await getRailgunKeychains(DIR)).map((k) => k.name);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["alpha", "bravo", "charlie", "delta"]);
});
