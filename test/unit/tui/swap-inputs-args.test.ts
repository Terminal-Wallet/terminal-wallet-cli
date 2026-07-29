/**
 * The swap quote's encryption-key argument.
 *
 * `getZer0XSwapInputs` takes the wallet encryption key as its seventh
 * parameter; a private swap derives the 7702 ephemeral taker account from it.
 * The builder was passing a 0zk destination address into that slot instead.
 * Both are strings, so nothing failed to compile — the ephemeral derivation
 * simply tried to decrypt the wallet record with an address as its key, and
 * every private swap died with "Unable to decrypt ciphertext."
 *
 * A type checker cannot catch a string handed to a string. These read the
 * source so the argument order stays pinned, and assert the property that made
 * the old value obviously wrong: the recipient is forced, so a destination
 * address had nowhere legitimate to go.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf-8");

// The helper now lives in flows/, so a second host shares its slippage default
// rather than inheriting getZer0XSwapInputs' own 500bps one. The property being
// pinned is unchanged.
const SWAP_INPUTS = "flows/swap-inputs.ts";

test("the quote helper takes the encryption key, not an address", () => {
  const source = read(SWAP_INPUTS);
  const signature = source.slice(source.indexOf("export const buildSwapInputs"));
  const params = signature.slice(0, signature.indexOf(") => {"));
  assert.match(params, /encryptionKey\?: string/);
  assert.ok(
    !/privateDest/.test(params),
    "a destination address in the key slot is the bug this file exists for",
  );
});

test("it forwards that key to getZer0XSwapInputs, not an address", () => {
  const source = read(SWAP_INPUTS);
  const call = source.slice(
    source.indexOf("await getZer0XSwapInputs("),
    source.indexOf("return { inputs, amount"),
  );
  assert.match(call, /isPublic,\s*\n\s*encryptionKey,/);
  assert.ok(!/s\.address|privateDest/.test(call), "still passing an address");
});

test("slippage is a shared default, not re-derived per caller", () => {
  // getZer0XSwapInputs defaults to 500bps. A host that called it directly would
  // quote 5% slippage where the deck quotes 3.2%, for the same trade.
  const source = read(SWAP_INPUTS);
  assert.match(source, /export const SWAP_SLIPPAGE_BPS = 320;/);
  assert.match(
    source,
    /slippageBps: number = SWAP_SLIPPAGE_BPS/,
    "the default should be overridable but shared",
  );
});

test("the private swap offers no destination field", () => {
  // The recipe hardcodes getCurrentRailgunAddress() as recipient, so an
  // editable destination is a control that does nothing.
  const configs = read("tui/screens/tx-builder-configs.ts");
  const flow = configs.slice(
    configs.indexOf('"private-swap": (chainName)'),
    configs.indexOf('"public-swap": (chainName)'),
  );
  assert.ok(flow.length > 0, "private-swap config not found");
  const fields = flow.slice(flow.indexOf("fields:"), flow.indexOf("]", flow.indexOf("fields:")));
  assert.ok(!fields.includes('"address"'), "offers a destination it cannot honour");
});

test("the recipe really does force the wallet's own address", () => {
  // The premise of the test above. If this ever stops being true, the field
  // should come back rather than the assertion being deleted.
  const swap = read("railgun/transaction/zeroX/0x-swap.ts");
  assert.match(swap, /const privateSwapRecipient = getCurrentRailgunAddress\(\)/);
});

test("the preview uses the cached key rather than prompting", () => {
  // Asking for a password while someone types an amount is not acceptable;
  // a locked wallet should simply show no preview.
  const builder = read("tui/screens/builder.ts");
  const preview = builder.slice(
    builder.indexOf("const computeSwapPreview"),
    builder.indexOf("const computeFeePreview"),
  );
  assert.match(preview, /getCachedEncryptionKey\(\)/);
  assert.ok(
    !/requireEncryptionKey|getSaltedPassword|promptPassword/.test(preview),
    "the preview prompts for a password",
  );
});
