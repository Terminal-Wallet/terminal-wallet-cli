/**
 * The engine key derivation.
 *
 * This is the one thing on the branch that can strand a wallet: the RAILGUN
 * engine's stored seed is encrypted against `computePasswordHash(raw, 32,
 * salt)`, so if the inputs to that call ever change, every wallet on disk stops
 * opening. Moving the derivation out of the prompt layer and behind the input
 * seam must not have moved the derivation itself.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setInputProvider, WalletInputProvider } from "../../../../src/core/input";
import { computePasswordHash } from "../../../../src/platform/crypto";
import { walletManager } from "../../../../src/railgun/wallet/wallet-manager";
import {
  getSaltedPassword,
  clearHashedPassword,
  confirmPassword,
} from "../../../../src/railgun/wallet/wallet-password";

const SALT = "0xdeadbeef";
const FIXTURE_PW = "correct-horse-battery"; // pragma: allowlist secret
const OTHER_PW = "a-different-value"; // pragma: allowlist secret

const provider = (
  answers: Array<string | undefined>,
): WalletInputProvider & { notified: string[] } => {
  const notified: string[] = [];
  return {
    notified,
    promptPassword: async () => answers.shift(),
    promptNewWallet: async () => undefined,
    confirm: async () => false,
    notify: (m: string) => notified.push(m),
    select: async () => undefined,
    multiSelect: async () => undefined,
    input: async () => undefined,
  };
};

beforeEach(() => {
  clearHashedPassword();
  walletManager.comparisonRefHash = undefined;
  walletManager.saltedPassword = SALT;
});

test("derives exactly computePasswordHash(raw, 32, keychainSalt)", async () => {
  setInputProvider(provider([FIXTURE_PW]));
  const derived = await getSaltedPassword();
  const expected = await computePasswordHash(FIXTURE_PW, 32, SALT);
  assert.equal(
    derived,
    expected,
    "the engine key derivation changed — every existing wallet would stop opening",
  );
});

test("the keychain salt is part of the derivation", async () => {
  setInputProvider(provider([FIXTURE_PW]));
  const withSalt = await getSaltedPassword();

  clearHashedPassword();
  walletManager.comparisonRefHash = undefined;
  walletManager.saltedPassword = "0xfeedface";
  setInputProvider(provider([FIXTURE_PW]));
  const otherSalt = await getSaltedPassword();

  assert.notEqual(withSalt, otherSalt, "salt must affect the derived key");
});

test("the derived key is cached, so the user is asked once", async () => {
  setInputProvider(provider([FIXTURE_PW])); // a single answer available
  const first = await getSaltedPassword();
  const second = await getSaltedPassword();
  assert.ok(first, "should have derived a key");
  assert.equal(first, second);
});

test("a wrong password on re-entry is rejected, not handed to the engine", async () => {
  setInputProvider(provider([FIXTURE_PW]));
  await getSaltedPassword();

  clearHashedPassword(); // key dropped, reference hash retained
  const p = provider([OTHER_PW]);
  setInputProvider(p);

  const result = await getSaltedPassword();
  assert.equal(result, undefined, "a mismatch must not return a key");
  assert.ok(
    p.notified.some((m) => m.toLowerCase().includes("incorrect")),
    `expected the user to be told; got ${JSON.stringify(p.notified)}`,
  );
});

test("a cancelled prompt yields no key and leaves no partial state", async () => {
  setInputProvider(provider([undefined]));
  const result = await getSaltedPassword();
  assert.equal(result, undefined);
  assert.equal(walletManager.hashedPassword, undefined);
  assert.equal(walletManager.comparisonRefHash, undefined);
});

test("a too-short entry is refused before any derivation", async () => {
  setInputProvider(provider(["abc"]));
  assert.equal(await getSaltedPassword(), undefined);
});

test("confirmPassword accepts a matching re-entry and rejects a typo", async () => {
  setInputProvider(provider([FIXTURE_PW]));
  await getSaltedPassword();

  setInputProvider(provider([FIXTURE_PW]));
  assert.equal(await confirmPassword(), true);

  setInputProvider(provider([OTHER_PW]));
  assert.equal(
    await confirmPassword(),
    false,
    "a mistyped confirmation must not be accepted — it would be baked into a seed that cannot be opened",
  );
});
