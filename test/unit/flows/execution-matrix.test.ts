/**
 * The transaction matrix, as a contract rather than a table in a document.
 *
 * Seventeen transaction types, four execution shapes. The properties below decide
 * whether a flow needs a proof, whether it runs as an EIP-7702 bundle, whether
 * a broadcaster must advertise 7702 support to carry it, and which fee modes it
 * can offer. They used to be re-derived by hand at each branch of a 1600-line
 * builder, where nothing stopped two branches from disagreeing.
 *
 * The subtle one is ShieldBase. It executes as a 7702 bundle — it wraps and
 * shields through Relay-Adapt from an ephemeral account — but it is signed from
 * the public wallet, so no broadcaster is involved. Any attempt to collapse
 * "is 7702" and "needs a 7702 broadcaster" into one predicate gets this wrong,
 * and gets it wrong silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import {
  executionMode,
  isEphemeral7702,
  useRelayAdapt,
} from "../../../src/flows/spec";
import {
  requires7702Broadcaster,
  allowedFeeKinds,
  requiresProof,
} from "../../../src/flows/caps";

interface Row {
  type: RailgunTransaction;
  proof: boolean;
  relayAdapt: boolean;
  ephemeral7702: boolean;
  needs7702Broadcaster: boolean;
  broadcastable: boolean;
}

const MATRIX: Row[] = [
  { type: RailgunTransaction.Transfer,
    proof: true,  relayAdapt: false, ephemeral7702: false, needs7702Broadcaster: false, broadcastable: true },
  { type: RailgunTransaction.Unshield,
    proof: true,  relayAdapt: false, ephemeral7702: false, needs7702Broadcaster: false, broadcastable: true },
  { type: RailgunTransaction.UnshieldBase,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.Shield,
    proof: false, relayAdapt: false, ephemeral7702: false, needs7702Broadcaster: false, broadcastable: false },
  { type: RailgunTransaction.ShieldBase,
    proof: false, relayAdapt: false, ephemeral7702: true,  needs7702Broadcaster: false, broadcastable: false },
  { type: RailgunTransaction.PublicTransfer,
    proof: false, relayAdapt: false, ephemeral7702: false, needs7702Broadcaster: false, broadcastable: false },
  { type: RailgunTransaction.PublicBaseTransfer,
    proof: false, relayAdapt: false, ephemeral7702: false, needs7702Broadcaster: false, broadcastable: false },
  { type: RailgunTransaction.Private0XSwap,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.Public0XSwap,
    proof: false, relayAdapt: false, ephemeral7702: false, needs7702Broadcaster: false, broadcastable: false },
  { type: RailgunTransaction.MorphoVaultDeposit,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.MorphoVaultRedeem,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.FxMintOpen,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.FxMintClose,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.FxMintTopup,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.FxMintTopupBorrow,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.FxMintBorrowMore,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
  { type: RailgunTransaction.FxMintRepay,
    proof: true,  relayAdapt: true,  ephemeral7702: true,  needs7702Broadcaster: true,  broadcastable: true },
];

test("every transaction type is covered — a new one cannot slip in untested", () => {
  const declared = Object.values(RailgunTransaction).sort();
  const covered = MATRIX.map((r) => r.type).sort();
  assert.deepEqual(covered, declared);
});

for (const row of MATRIX) {
  test(`${row.type}: matches the matrix`, () => {
    assert.equal(requiresProof(row.type), row.proof, "proof");
    assert.equal(useRelayAdapt(row.type), row.relayAdapt, "relay-adapt");
    assert.equal(isEphemeral7702(row.type), row.ephemeral7702, "7702 execution");
    assert.equal(
      requires7702Broadcaster(row.type),
      row.needs7702Broadcaster,
      "7702-capable broadcaster required",
    );
    assert.equal(
      allowedFeeKinds(row.type).includes("broadcaster"),
      row.broadcastable,
      "broadcaster is an allowed fee mode",
    );
    assert.equal(
      executionMode(row.type).kind,
      row.ephemeral7702 ? "ephemeral-7702" : "direct",
      "execution mode",
    );
  });
}

test("execution mode and fee mode are independent axes", () => {
  // If these were one axis, every 7702 flow would need a broadcaster and every
  // broadcastable flow would be 7702. Both halves are false, which is the whole
  // reason they are modelled separately.
  const sevenSevenZeroTwo = MATRIX.filter((r) => r.ephemeral7702);
  const broadcastable = MATRIX.filter((r) => r.broadcastable);

  assert.ok(
    sevenSevenZeroTwo.some((r) => !r.broadcastable),
    "expected a 7702 flow that cannot use a broadcaster (ShieldBase)",
  );
  assert.ok(
    broadcastable.some((r) => !r.ephemeral7702),
    "expected a broadcastable flow that is not 7702 (Transfer)",
  );
});

test("a 7702 broadcaster is demanded exactly when 7702 meets relay-adapt", () => {
  for (const row of MATRIX) {
    assert.equal(
      requires7702Broadcaster(row.type),
      isEphemeral7702(row.type) && useRelayAdapt(row.type),
      `${row.type} disagrees with the derivation`,
    );
  }
});

test("every relay-adapt flow is a 7702 flow", () => {
  // The converse does not hold — ShieldBase is 7702 without relay-adapt — but
  // a relay-adapt bundle that was not type-4 would be submitted without an
  // authorization tuple and could never be mined.
  for (const row of MATRIX.filter((r) => r.relayAdapt)) {
    assert.ok(isEphemeral7702(row.type), `${row.type} relays without 7702`);
  }
});

test("every flow offers at least one way to pay for itself", () => {
  for (const row of MATRIX) {
    assert.ok(
      allowedFeeKinds(row.type).length > 0,
      `${row.type} has no fee mode`,
    );
  }
});
