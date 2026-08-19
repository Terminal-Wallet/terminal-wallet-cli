/**
 * Operator secrets must not reach the shipped binary, and must not reach a log.
 *
 * ship.mjs bundles dist/main.js with esbuild `bundle: true`, so any module
 * reachable by import is inlined into the distributed artifact. A key written
 * into a source file would therefore ship to every user. These lock the two
 * properties that keep that from happening by accident: the value is resolved
 * at run time, and the printable form never contains it.
 *
 * The fixture below is deliberately NOT key-shaped. A realistic-looking key in
 * a committed test is the thing a secret scanner exists to catch, and teaching
 * people to add scanner exemptions to tests is how real ones get committed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ENV = "TWALLET_REMOTE_CONFIG_SIGNER_KEY";
const SENTINEL = "not-a-real-key-file-value";
const SENTINEL_ENV = "not-a-real-key-env-value";

/** Load a fresh module instance, with cwd pointed at a scratch dir. */
const withSecretsModule = async (
  fn: (mod: typeof import("../../../src/config/secrets")) => Promise<void> | void,
  fileContents?: string,
) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twallet-secrets-"));
  const cwd = process.cwd();
  const hadEnv = process.env[ENV];
  try {
    if (fileContents !== undefined) {
      fs.writeFileSync(path.join(dir, "twallet.secrets.json"), fileContents, {
        mode: 0o600,
      });
    }
    process.chdir(dir);
    const mod = await import("../../../src/config/secrets.js");
    mod.resetSecretsCache();
    await fn(mod);
    mod.resetSecretsCache();
  } finally {
    process.chdir(cwd);
    if (hadEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = hadEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("an absent secrets file is not an error", async () => {
  // Almost nobody running this wallet publishes a remote config.
  await withSecretsModule((mod) => {
    delete process.env[ENV];
    mod.resetSecretsCache();
    assert.equal(mod.remoteConfigSignerKey(), undefined);
    assert.equal(mod.hasRemoteConfigSignerKey(), false);
  });
});

test("a malformed secrets file is not an error either", async () => {
  await withSecretsModule((mod) => {
    delete process.env[ENV];
    mod.resetSecretsCache();
    assert.equal(mod.remoteConfigSignerKey(), undefined);
  }, "{ not json");
});

test("the key is read from the file", async () => {
  await withSecretsModule((mod) => {
    delete process.env[ENV];
    mod.resetSecretsCache();
    assert.equal(mod.remoteConfigSignerKey(), SENTINEL);
  }, JSON.stringify({ remoteConfigSignerKey: SENTINEL }));
});

test("the environment beats the file", async () => {
  // So a one-off run never needs the key on disk.
  await withSecretsModule((mod) => {
    process.env[ENV] = SENTINEL_ENV;
    mod.resetSecretsCache();
    assert.equal(mod.remoteConfigSignerKey(), SENTINEL_ENV);
  }, JSON.stringify({ remoteConfigSignerKey: SENTINEL }));
});

test("an empty value counts as absent, not as a key", async () => {
  // A blank env var would otherwise shadow a real key in the file with "".
  await withSecretsModule((mod) => {
    process.env[ENV] = "   ";
    mod.resetSecretsCache();
    assert.equal(mod.remoteConfigSignerKey(), SENTINEL);
  }, JSON.stringify({ remoteConfigSignerKey: SENTINEL }));
});

test("CONTROL: the printable description never contains the key", async () => {
  // A diagnostic that echoed the key would put it in the log file the user
  // then sends to someone.
  await withSecretsModule((mod) => {
    process.env[ENV] = SENTINEL_ENV;
    mod.resetSecretsCache();
    const described = mod.describeSecrets();
    assert.ok(!described.includes(SENTINEL_ENV), `key leaked: ${described}`);
    assert.match(described, /configured/);
  });
});

test("CONTROL: no key literal is committed in the secrets module", () => {
  // The module reads a key; it must never hold one.
  const source = readFileSync(
    resolve(process.cwd(), "src/config/secrets.ts"),
    "utf-8",
  );
  assert.ok(
    !/0x[0-9a-fA-F]{40,}/.test(source),
    "a key-shaped literal is present in the secrets module",
  );
});

test("CONTROL: the secrets file is gitignored", () => {
  // The whole design depends on this file never being committed.
  const ignored = readFileSync(resolve(process.cwd(), ".gitignore"), "utf-8");
  assert.match(ignored, /^twallet\.secrets\.json$/m);
});
