import { test } from "node:test";
import assert from "node:assert/strict";
import { runTransaction } from "../../../src/flows/run";
import {
  collectEvents,
  makeRunDeps,
  throwingEstimate,
  throwingSend,
} from "../../_support";

// Pin simulation OFF so these tests don't depend on the ambient twallet.config;
// the simulation cases below opt in explicitly via { simulate: true }.

test("happy path emits estimate → prove → send → result(ok) and returns the result", async () => {
  const { emit, events, phases, result } = collectEvents();
  const out = await runTransaction({ token: "ETH" }, makeRunDeps(), emit);

  assert.deepEqual(out, {
    ok: true,
    result: { hash: "0xhash", url: "https://scan/0xhash" },
  });
  assert.deepEqual(phases(), ["estimate", "prove", "prove", "prove", "send"]);

  const r = result();
  assert.equal(r?.ok, true);
  assert.equal(r?.hash, "0xhash");
  void events;
});

test("prove progress is forwarded with pct + note", async () => {
  const { emit, byType } = collectEvents();
  await runTransaction({ token: "ETH" }, makeRunDeps(), emit);
  const proveEvents = byType("tx:progress").filter((e) => e.phase === "prove");
  assert.ok(proveEvents.some((e) => e.pct === 50 && e.message === "halfway"));
  assert.ok(proveEvents.some((e) => e.pct === 100));
});

test("a failure in estimate emits failed + result(ok:false) and never proves/sends", async () => {
  const { emit, byType, result } = collectEvents();
  let proved = false;
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps({
      estimateGas: throwingEstimate("gas blew up"),
      prove: async (_s, _g, onProgress) => {
        proved = true;
        onProgress(100);
        return { proof: "0xproof" };
      },
    }),
    emit,
  );

  assert.deepEqual(out, { ok: false, error: "gas blew up" });
  assert.equal(proved, false, "must not prove after estimate fails");
  const failed = byType("tx:progress").find((e) => e.phase === "failed");
  assert.equal(failed?.message, "gas blew up");
  assert.equal(result()?.ok, false);
  assert.equal(result()?.error, "gas blew up");
});

test("confirm gate: returning false aborts before prove/send", async () => {
  const { emit, events, phases } = collectEvents();
  let proved = false;
  let sent = false;
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps({
      confirm: async () => false,
      prove: async (_s, _g, onProgress) => {
        proved = true;
        onProgress(100);
        return { proof: "0xproof" };
      },
      send: async () => {
        sent = true;
        return { hash: "0xhash", url: "u" };
      },
    }),
    emit,
  );
  assert.deepEqual(out, { ok: false, error: "cancelled" });
  assert.equal(proved, false);
  assert.equal(sent, false);
  assert.ok(
    events.some((e) => e.type === "status:message"),
    "a cancel status is emitted",
  );
  assert.ok(!phases().includes("prove"), "no prove phase after cancel");
});

test("confirm gate: returning true proceeds normally", async () => {
  const { emit } = collectEvents();
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps({ confirm: async () => true }),
    emit,
  );
  assert.equal(out.ok, true);
});

test("with no prove dep, the prove phase is skipped and send gets the estimate", async () => {
  const { emit, phases } = collectEvents();
  let sent: unknown;
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps<{ token: string }, { populated: string; fee: number }>({
      estimateGas: async () => ({ populated: "0xtx", fee: 1 }),
      prove: undefined,
      send: async (_spec, prepared) => {
        sent = prepared;
        return { hash: "0xpub", url: "u" };
      },
    }),
    emit,
  );
  assert.deepEqual(out, { ok: true, result: { hash: "0xpub", url: "u" } });
  assert.deepEqual(
    sent,
    { populated: "0xtx", fee: 1 },
    "send receives the estimate as prepared",
  );
  assert.deepEqual(phases(), ["estimate", "send"], "no prove phase emitted");
});

test("simulate: halts before prove (proof tx) — estimate runs, never proves/sends", async () => {
  const { emit, result } = collectEvents();
  let proved = false;
  let sent = false;
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps({
      prove: async (_s, _g, onProgress) => {
        proved = true;
        onProgress(100);
        return { proof: "0xproof" };
      },
      send: async () => {
        sent = true;
        return { hash: "x", url: "u" };
      },
    }),
    emit,
    { simulate: true },
  );
  assert.deepEqual(out, { ok: false, error: "simulated" });
  assert.equal(proved, false, "simulation must not generate a proof");
  assert.equal(sent, false, "simulation must not broadcast");
  assert.equal(result()?.ok, false);
  assert.match(String(result()?.error), /halted before proof generation/);
});

test("simulate: tolerates an estimate that needs real notes and still halts", async () => {
  const { emit, events, result } = collectEvents();
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps({ estimateGas: throwingEstimate("no spendable notes") }),
    emit,
    { simulate: true },
  );
  assert.deepEqual(out, { ok: false, error: "simulated" });
  assert.ok(
    events.some(
      (e) => e.type === "log" && /needs real notes/.test(e.text),
    ),
    "estimate failure is logged in simulation",
  );
  assert.equal(result()?.ok, false);
});

test("simulate: public tx (no prove) halts before broadcast", async () => {
  const { emit, result } = collectEvents();
  let sent = false;
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps<{ token: string }, { populated: string; fee: number }>({
      estimateGas: async () => ({ populated: "0xtx", fee: 1 }),
      prove: undefined,
      send: async () => {
        sent = true;
        return { hash: "x", url: "u" };
      },
    }),
    emit,
    { simulate: true },
  );
  assert.deepEqual(out, { ok: false, error: "simulated" });
  assert.equal(sent, false);
  assert.match(String(result()?.error), /halted before broadcast/);
});

test("a failure in send is reported as a failed result", async () => {
  const { emit, phases } = collectEvents();
  const out = await runTransaction(
    { token: "ETH" },
    makeRunDeps({ send: throwingSend("broadcaster rejected") }),
    emit,
  );
  assert.equal(out.ok, false);
  assert.equal((out as { ok: false; error: string }).error, "broadcaster rejected");
  assert.ok(phases().includes("send"));
  assert.ok(phases().includes("failed"));
});
