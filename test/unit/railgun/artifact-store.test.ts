/**
 * Where the SDK keeps the proving circuits.
 *
 * A circuit release moves POI artifacts into a folder named for its IPFS hash
 * (artifacts-v2.1/<hash>/POI_3x3/…), so the first proof after an upgrade writes
 * into directories that do not exist yet. And the SDK only checks an artifact's
 * hash when downloading it: once the store says a file exists it is trusted, so
 * a half-written file is never fetched again and every proof on it fails.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createArtifactStore } from "../../../src/railgun/db/artifact-store";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "tw-artifacts-"));

const POI_DIR = "artifacts-v2.1/QmZ2MyM6TKxffkv6stuo2hFwmUfs3q4xgMYN164Sje8new/POI_3x3";

test("a new circuit release folder is created on first download", async () => {
  const root = tmp();
  const store = createArtifactStore(root);
  const bytes = new Uint8Array([1, 2, 3, 4]);

  await store.store(POI_DIR, `${POI_DIR}/wasm`, bytes);

  assert.equal(await store.exists(`${POI_DIR}/wasm`), true);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root, POI_DIR, "wasm"))), bytes);
});

test("a previous release on disk does not stand in for the new one", async () => {
  const root = tmp();
  const store = createArtifactStore(root);
  const OLD_DIR = "artifacts-v2.1/poi-nov-2-23/POI_3x3";
  const files = ["wasm", "zkey", "vkey.json", "dat"];
  for (const f of files) {
    await store.store(OLD_DIR, `${OLD_DIR}/${f}`, new Uint8Array([0]));
  }

  for (const f of files) {
    assert.equal(
      await store.exists(`${POI_DIR}/${f}`),
      false,
      `the old release's ${f} was reported as the new one, so it would never be downloaded`,
    );
  }

  await store.store(POI_DIR, `${POI_DIR}/zkey`, new Uint8Array([7]));

  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root, POI_DIR, "zkey"))), new Uint8Array([7]));
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root, OLD_DIR, "zkey"))), new Uint8Array([0]));
});

test("the file's own parent is created even when the SDK names another dir", async () => {
  // The SDK passes `dir` separately from the file path. If the two ever drift
  // apart, the write must still land rather than fail with ENOENT.
  const root = tmp();
  const store = createArtifactStore(root);

  await store.store("artifacts-v2.1", `${POI_DIR}/vkey.json`, "{}");

  assert.equal(fs.readFileSync(path.join(root, POI_DIR, "vkey.json"), "utf-8"), "{}");
});

test("a write cut short leaves nothing the SDK would trust", async (t) => {
  const root = tmp();
  const store = createArtifactStore(root);
  const realWrite = fs.promises.writeFile;
  t.mock.method(
    fs.promises,
    "writeFile",
    async (file: fs.PathLike, data: Uint8Array) => {
      await realWrite(file, data.subarray(0, 2));
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    },
  );

  await assert.rejects(
    store.store(POI_DIR, `${POI_DIR}/zkey`, new Uint8Array([9, 9, 9, 9])),
    /no space left/,
  );

  assert.equal(
    await store.exists(`${POI_DIR}/zkey`),
    false,
    "a truncated zkey is sitting at the final path and would never be re-downloaded",
  );
  assert.deepEqual(fs.readdirSync(path.join(root, POI_DIR)), [], "the partial file was left behind");
});

test("storing again replaces the previous file", async () => {
  const root = tmp();
  const store = createArtifactStore(root);

  await store.store(POI_DIR, `${POI_DIR}/dat`, new Uint8Array([1]));
  await store.store(POI_DIR, `${POI_DIR}/dat`, new Uint8Array([2, 2]));

  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(root, POI_DIR, "dat"))), new Uint8Array([2, 2]));
  assert.deepEqual(fs.readdirSync(path.join(root, POI_DIR)), ["dat"]);
});
