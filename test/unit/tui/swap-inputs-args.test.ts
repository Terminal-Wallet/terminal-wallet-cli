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

test("the quote helper's last parameter is the encryption key", () => {
  const configs = read("tui/screens/tx-builder-configs.ts");
  const signature = configs.slice(configs.indexOf("export const buildSwapInputs"));
  const params = signature.slice(0, signature.indexOf(") => {"));
  assert.match(params, /encryptionKey\?: string/);
  assert.ok(
    !/privateDest/.test(params),
    "a destination address in the key slot is the bug this file exists for",
  );
});

test("it forwards that key to getZer0XSwapInputs, not an address", () => {
  const configs = read("tui/screens/tx-builder-configs.ts");
  const call = configs.slice(
    configs.indexOf("await getZer0XSwapInputs("),
    configs.indexOf("return { inputs, amount"),
  );
  assert.match(call, /isPublic,\s*\n\s*encryptionKey,/);
  assert.ok(!/s\.address|privateDest/.test(call), "still passing an address");
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
