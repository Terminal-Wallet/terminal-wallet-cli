/**
 * Transaction orchestration core (the rebuild of transaction-builder's pipeline).
 *
 * One generic runner drives every transaction type through estimate → prove →
 * send, emitting tx:progress/tx:result on the core bus. Each tx type supplies
 * `deps` that wrap its existing impl (gas estimate / proof / broadcast-or-sign),
 * so the pipeline is decoupled from both the SDK and the UI and is verifiable
 * with stubs. Input collection (which token/amount/recipient/fee) produces the
 * `spec` and lives in the UI layer — it is NOT this module's concern.
 */
import { CoreEvent, emitCoreEvent } from "../core/events";
import { errDetail } from "../platform/errors";
import { takeLastRevert } from "../railgun/network/revert-capture";
import { createLogger } from "../platform/logger";

const log = createLogger("tx");

/** Progress callback handed to `prove` (0..100, optional note). */
export type TxProgress = (pct: number, note?: string) => void;

export interface SendOutcome {
  hash?: string;
  url?: string;
}

export interface TransactionRunDeps<Spec, Gas, Proved, Result extends SendOutcome> {
  estimateGas: (spec: Spec) => Promise<Gas>;
  /**
   * Review gate run AFTER the estimate and BEFORE prove/send. Return false to
   * abort (nothing is proved or broadcast). UI-supplied; omit to skip.
   */
  confirm?: (spec: Spec, gas: Gas) => Promise<boolean>;
  /**
   * Proof generation. Optional: public/ethers transactions have no proof step —
   * omit it and `send` receives the estimate result (so set Proved = Gas).
   */
  prove?: (spec: Spec, gas: Gas, onProgress: TxProgress) => Promise<Proved>;
  send: (spec: Spec, prepared: Proved) => Promise<Result>;
}

export type RunResult<Result> =
  | { ok: true; result: Result }
  | { ok: false; error: string };

/**
 * Run a transaction through the pipeline. `emit` is injectable (defaults to the
 * core bus) so tests can capture the emitted events.
 */
export const runTransaction = async <
  Spec,
  Gas,
  Proved,
  Result extends SendOutcome,
>(
  spec: Spec,
  deps: TransactionRunDeps<Spec, Gas, Proved, Result>,
  emit: (event: CoreEvent) => void = emitCoreEvent,
  opts: { simulate?: boolean } = {},
): Promise<RunResult<Result>> => {
  const simulate = opts.simulate ?? false;
  try {
    emit({ type: "tx:progress", phase: "estimate", message: "Estimating gas…" });

    // --- Simulation: walk the flow up to the funds boundary, then halt. ------
    // Private-spend estimates hit the SDK with notes that don't exist under
    // demo balances, so tolerate an estimate failure and still surface the
    // boundary. Public/shield estimates succeed and get a real confirm.
    if (simulate) {
      let simGas: Gas | undefined;
      try {
        simGas = await deps.estimateGas(spec);
      } catch (e) {
        emit({
          type: "log",
          level: "info",
          text: `[simulate] estimate unavailable (needs real notes): ${(e as Error).message}`,
        });
      }
      if (simGas !== undefined && deps.confirm && !(await deps.confirm(spec, simGas))) {
        emit({ type: "status:message", text: "Transaction cancelled." });
        return { ok: false, error: "cancelled" };
      }
      const boundary = deps.prove ? "proof generation" : "broadcast";
      const phase = deps.prove ? "prove" : "send";
      emit({
        type: "tx:progress",
        phase,
        message: `SIMULATION — halting before ${boundary} (no real funds)`,
      });
      emit({ type: "tx:result", ok: false, error: `simulated (halted before ${boundary})` });
      return { ok: false, error: "simulated" };
    }

    const gas = await deps.estimateGas(spec);

    if (deps.confirm && !(await deps.confirm(spec, gas))) {
      emit({ type: "status:message", text: "Transaction cancelled." });
      return { ok: false, error: "cancelled" };
    }

    let prepared: Proved;
    if (deps.prove) {
      emit({ type: "tx:progress", phase: "prove", pct: 0, message: "Generating proof…" });
      prepared = await deps.prove(spec, gas, (pct, note) =>
        emit({
          type: "tx:progress",
          phase: "prove",
          pct,
          message: note ?? "Generating proof…",
        }),
      );
    } else {
      // No proof step (public/ethers tx): the estimate result IS the prepared tx.
      prepared = gas as unknown as Proved;
    }

    emit({ type: "tx:progress", phase: "send", message: "Submitting transaction…" });
    const result = await deps.send(spec, prepared);

    emit({ type: "tx:result", ok: true, hash: result.hash, url: result.url });
    return { ok: true, result };
  } catch (e) {
    // The cause chain, not just the message. The engine reports failures as
    // Error("Unable to decrypt ciphertext.", { cause }) and everything that
    // identifies WHICH record and why is in the cause — dropping it leaves a
    // message nobody can act on.
    // The SDK drops the chain's revert reason for relay-adapt failures; recover
    // it from the provider so the message names what actually happened.
    const revert = takeLastRevert();
    const error = revert ? `${errDetail(e)} ← ${revert}` : errDetail(e);
    emit({ type: "tx:progress", phase: "failed", message: error });
    emit({ type: "tx:result", ok: false, error });
    // Full object to the log pane, so the stack survives even though the
    // status line only has room for the chain.
    log.error("transaction failed", e);
    return { ok: false, error };
  }
};
