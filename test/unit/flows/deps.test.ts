/**
 * The deps adapters — the seam between the tested pipeline and the untested SDK
 * impls it drives.
 *
 * Neither the branch this came from nor master had a single test here, which is
 * the worst place for a gap: the pipeline is verified with stubs, the impls are
 * verified by running the wallet, and the wiring between them was verified by
 * nobody. An adapter that transposes two arguments, drops the memo, or lets an
 * undefined estimate through typechecks perfectly and fails at spend time.
 *
 * Every assertion here is about the WIRING: which values reach which call, in
 * what order, and what happens when an impl resolves undefined.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkName } from "@railgun-community/shared-models";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import { createTransferDeps } from "../../../src/flows/deps/transfer";
import {
  createUnshieldDeps,
  createUnshieldBaseDeps,
} from "../../../src/flows/deps/unshield";
import {
  createShieldDeps,
  createShieldBaseDeps,
} from "../../../src/flows/deps/shield";
import {
  createPublicTransferDeps,
  createPublicBaseDeps,
} from "../../../src/flows/deps/public";
import { privateGasEstimate, erc20Recipient, publicRecipient } from "../../_support";

const CHAIN = NetworkName.Ethereum;
const KEY = "0xderivedkey"; // pragma: allowlist secret
const GAS = privateGasEstimate();
const PROVED = { transaction: { to: "0xabc" } } as never;
const recipients = [erc20Recipient()];

const record = () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const spy =
    (name: string, result: unknown) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      return Promise.resolve(result);
    };
  return { calls, spy };
};

// --- transfer -------------------------------------------------------------

test("transfer: estimate receives chain, recipients, key, broadcaster, memo in order", async () => {
  const { calls, spy } = record();
  const deps = createTransferDeps({
    estimate: spy("estimate", GAS) as never,
    prove: spy("prove", PROVED) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  await deps.estimateGas({
    type: RailgunTransaction.Transfer,
    chainName: CHAIN,
    recipients,
    encryptionKey: KEY,
    memo: "note",
    fee: { kind: "self-signer", signer: {} as never },
  });
  assert.deepEqual(calls[0].args, [CHAIN, recipients, KEY, undefined, "note"]);
});

test("transfer: a broadcaster fee mode forwards the broadcaster; self-signer does not", async () => {
  const { calls, spy } = record();
  const broadcaster = { railgunAddress: "0zk1" } as never;
  const deps = createTransferDeps({
    estimate: spy("estimate", GAS) as never,
    prove: spy("prove", PROVED) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  await deps.estimateGas({
    type: RailgunTransaction.Transfer,
    chainName: CHAIN,
    recipients,
    encryptionKey: KEY,
    fee: { kind: "broadcaster", broadcaster },
  });
  assert.equal(calls[0].args[3], broadcaster);
  // A missing memo must reach the SDK as "", not undefined.
  assert.equal(calls[0].args[4], "");
});

test("transfer: an undefined estimate throws rather than flowing into prove", async () => {
  const { spy } = record();
  const deps = createTransferDeps({
    estimate: spy("estimate", undefined) as never,
    prove: spy("prove", PROVED) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  await assert.rejects(
    () =>
      deps.estimateGas({
        type: RailgunTransaction.Transfer,
        chainName: CHAIN,
        recipients,
        encryptionKey: KEY,
        fee: { kind: "self-signer", signer: {} as never },
      }),
    /Failed to estimate gas/,
  );
});

test("transfer: an undefined proof throws rather than being broadcast", async () => {
  const { spy } = record();
  const deps = createTransferDeps({
    estimate: spy("estimate", GAS) as never,
    prove: spy("prove", undefined) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  await assert.rejects(
    () =>
      deps.prove!(
        {
          type: RailgunTransaction.Transfer,
          chainName: CHAIN,
          recipients,
          encryptionKey: KEY,
          fee: { kind: "self-signer", signer: {} as never },
        },
        GAS,
        () => undefined,
      ),
    /Failed to generate transfer proof/,
  );
});

// --- unshield -------------------------------------------------------------

test("unshield: estimate and prove both receive the encryption key", async () => {
  const { calls, spy } = record();
  const deps = createUnshieldDeps({
    estimate: spy("estimate", GAS) as never,
    prove: spy("prove", PROVED) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  const spec = {
    type: RailgunTransaction.Unshield as const,
    chainName: CHAIN,
    recipients,
    encryptionKey: KEY,
    fee: { kind: "self-signer" as const, signer: {} as never },
  };
  await deps.estimateGas(spec);
  await deps.prove!(spec, GAS, () => undefined);
  assert.equal(calls[0].args[2], KEY);
  assert.equal(calls[1].args[0], KEY);
});

test("unshield-base: relay-adapt path forwards the single recipient, not an array", async () => {
  const { calls, spy } = record();
  const recipient = erc20Recipient();
  const deps = createUnshieldBaseDeps({
    estimate: spy("estimate", GAS) as never,
    prove: spy("prove", PROVED) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  await deps.estimateGas({
    type: RailgunTransaction.UnshieldBase,
    chainName: CHAIN,
    recipient,
    encryptionKey: KEY,
    fee: { kind: "self-signer", signer: {} as never },
  });
  assert.equal(calls[0].args[1], recipient);
  assert.ok(!Array.isArray(calls[0].args[1]));
});

// --- shield ---------------------------------------------------------------

test("shield: no encryption key is passed — an ERC20 shield is signed, not proved", async () => {
  const { calls, spy } = record();
  const deps = createShieldDeps({
    estimate: spy("estimate", GAS) as never,
    prove: spy("prove", {} as never) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  await deps.estimateGas({
    type: RailgunTransaction.Shield,
    chainName: CHAIN,
    recipients,
  });
  assert.deepEqual(calls[0].args, [CHAIN, recipients]);
});

test("shield-base: the encryption key reaches BOTH estimate and prove", async () => {
  // 7702: the base-token shield runs through Relay-Adapt as a type-4 bundle and
  // derives its ephemeral account from this key. If only one of the two calls
  // gets it, the estimate and the proof resolve different ephemeral addresses
  // and the bundle's authorization does not match the account that executes it.
  const { calls, spy } = record();
  const recipient = erc20Recipient();
  const deps = createShieldBaseDeps({
    estimate: spy("estimate", GAS) as never,
    prove: spy("prove", {} as never) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  const spec = {
    type: RailgunTransaction.ShieldBase as const,
    chainName: CHAIN,
    recipient,
    encryptionKey: KEY,
  };
  await deps.estimateGas(spec);
  await deps.prove!(spec, GAS, () => undefined);

  assert.equal(calls[0].args[2], KEY, "estimate did not receive the key");
  assert.equal(calls[1].args[3], KEY, "prove did not receive the key");
});

// --- public ---------------------------------------------------------------

test("public transfer: has no prove step, and sends the populated transaction", async () => {
  const { calls, spy } = record();
  const populated = { to: publicRecipient, data: "0x" };
  const deps = createPublicTransferDeps({
    estimate: spy("estimate", { populatedTransaction: populated }) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  assert.equal(deps.prove, undefined, "a public transfer needs no proof");
  const spec = {
    type: RailgunTransaction.PublicTransfer as const,
    chainName: CHAIN,
    recipient: erc20Recipient(),
  };
  const prepared = await deps.estimateGas(spec);
  await deps.send(spec, prepared);
  // The populated tx must be unwrapped before sending — passing the wrapper
  // would submit an object the signer cannot interpret.
  assert.equal(calls[1].args[0], populated);
  assert.equal(calls[1].args[1], CHAIN);
});

test("public base transfer: same shape, base-token impl", async () => {
  const { calls, spy } = record();
  const deps = createPublicBaseDeps({
    estimate: spy("estimate", { populatedTransaction: { to: "0x" } }) as never,
    send: spy("send", { hash: "0x1" }) as never,
  });
  assert.equal(deps.prove, undefined);
  await deps.estimateGas({
    type: RailgunTransaction.PublicBaseTransfer,
    chainName: CHAIN,
    recipient: erc20Recipient(),
  });
  assert.equal(calls[0].args[0], CHAIN);
});
