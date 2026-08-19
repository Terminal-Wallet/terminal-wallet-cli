/**
 * Wallet creation and import, and the mask that lets a paste be checked.
 *
 * Both halves guard the same accident: a seed goes in, nothing on screen
 * disagrees, and the wallet that comes out is not the one the user meant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Mnemonic } from "ethers";
import { buildWalletInfo } from "../../../src/flows/new-wallet";
import { maskSecret } from "../../../src/tui/form-core";

// A real BIP39 phrase, so the import path validates rather than short-circuits.
const SEED =
  "test test test test test test test test test test test junk";

test("a new wallet gets a fresh, valid seed", () => {
  const info = buildWalletInfo({ mode: "new", walletName: "w" });
  assert.ok(info, "no wallet built");
  assert.ok(Mnemonic.isValidMnemonic(info.mnemonic));
  assert.equal(info.walletName, "w");
});

test("two new wallets do not share a seed", () => {
  const a = buildWalletInfo({ mode: "new", walletName: "a" });
  const b = buildWalletInfo({ mode: "new", walletName: "b" });
  assert.notEqual(a?.mnemonic, b?.mnemonic);
});

test("a seed handed to the new path is refused, not generated over", () => {
  // Mode defaults to "new" and the seed field is on the same card, so pasting
  // without switching Mode is one keystroke away. Generating regardless hands
  // back a fresh empty wallet while the user believes they imported — and the
  // masked field shows nothing that contradicts them.
  const info = buildWalletInfo({ mode: "new", walletName: "w", mnemonic: SEED });
  assert.equal(info, undefined);
});

test("CONTROL: a seed of only whitespace is not treated as a supplied seed", () => {
  // Otherwise the guard above would block the ordinary new-wallet path for
  // anyone who focused the field and left it.
  const info = buildWalletInfo({ mode: "new", walletName: "w", mnemonic: "   " });
  assert.ok(info, "blank field blocked a legitimate new wallet");
  assert.ok(Mnemonic.isValidMnemonic(info.mnemonic));
});

test("an import keeps the seed it was given", () => {
  const info = buildWalletInfo({ mode: "import", walletName: "w", mnemonic: SEED });
  assert.equal(info?.mnemonic, SEED);
});

test("an import without a seed, or with a bad one, builds nothing", () => {
  assert.equal(buildWalletInfo({ mode: "import", walletName: "w" }), undefined);
  assert.equal(
    buildWalletInfo({ mode: "import", walletName: "w", mnemonic: "not a seed" }),
    undefined,
  );
});

test("no name, no wallet, either way", () => {
  assert.equal(buildWalletInfo({ mode: "new", walletName: "  " }), undefined);
  assert.equal(
    buildWalletInfo({ mode: "import", walletName: "", mnemonic: SEED }),
    undefined,
  );
});

// --- the mask ---------------------------------------------------------------

test("a pasted phrase reports its word count", () => {
  // The whole point: a truncated paste and a whole one render identically
  // behind a fixed mask, and the cost of noticing later is the wallet.
  assert.match(maskSecret(SEED), /^12 words/);
  assert.match(maskSecret(`${SEED} abandon`), /^13 words/);
});

test("the mask never echoes the secret", () => {
  const masked = maskSecret(SEED);
  for (const word of SEED.split(" ")) {
    assert.ok(!masked.includes(word), `mask leaked "${word}"`);
  }
});

test("word lengths are not disclosed", () => {
  // Uniform groups: BIP39 words run 3-8 characters, and their lengths would
  // narrow the candidates for anyone reading over a shoulder.
  const groups = maskSecret("abandon zoo ability zebra")
    .split("·")[1]
    .trim()
    .split(" ")
    .filter((g) => g.startsWith("•"));
  assert.equal(new Set(groups).size, 1, "group widths vary with word length");
});

test("a single-token secret stays a plain mask", () => {
  // A private key or a password has no word structure to report, and a count
  // of 1 would only be noise.
  assert.equal(maskSecret("hunter2"), "••••••");
  assert.equal(maskSecret("0xdeadbeef"), "••••••");
});

test("odd whitespace does not inflate the count", () => {
  // A phrase pasted out of a wrapped document arrives with newlines and runs
  // of spaces; counting those as words would report 24 for a 12-word seed.
  assert.match(maskSecret("  alpha \n beta \t gamma  "), /^3 words/);
});
