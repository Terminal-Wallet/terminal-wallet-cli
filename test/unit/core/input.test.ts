import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setInputProvider,
  getInputProvider,
  WalletInputProvider,
} from "../../../src/core/input";

const stubProvider = (
  over: Partial<WalletInputProvider> = {},
): WalletInputProvider => ({
  promptPassword: async () => undefined,
  promptNewWallet: async () => undefined,
  confirm: async () => false,
  notify: () => undefined,
  select: async () => undefined,
  multiSelect: async () => undefined,
  input: async () => undefined,
  ...over,
});

test("a registered provider is what core gets back", () => {
  const provider = stubProvider({ promptPassword: async () => "secret" });
  setInputProvider(provider);
  assert.equal(getInputProvider(), provider);
});

test("registering again replaces the provider", () => {
  // Hosts swap at runtime — the diagnostic registers one, the UI another.
  const first = stubProvider();
  const second = stubProvider();
  setInputProvider(first);
  setInputProvider(second);
  assert.equal(getInputProvider(), second);
});

test("core reaches the host through the seam", async () => {
  const asked: string[] = [];
  setInputProvider(
    stubProvider({
      promptPassword: async (message) => {
        asked.push(message);
        return "raw-password";
      },
    }),
  );
  const answer = await getInputProvider().promptPassword("Enter your password:");
  assert.equal(answer, "raw-password");
  assert.deepEqual(asked, ["Enter your password:"]);
});

test("the seam returns the RAW password, never a derived key", async () => {
  // The contract that matters: hosts collect text, core derives the engine key.
  // If a host ever hashed on its way out, two hosts could derive differently
  // and one of them would not open the wallet.
  const raw = "correct horse battery staple";
  setInputProvider(stubProvider({ promptPassword: async () => raw }));
  const answer = await getInputProvider().promptPassword("pw");
  assert.equal(answer, raw, "the seam must not transform the password");
});
