/**
 * Drain a queue to empty, with at most one pass in flight.
 *
 * Work that arrives *while* a drain is running is still picked up, with nothing
 * polling for it.
 *
 * The loop takes the whole queue and clears it BEFORE awaiting, so arrivals
 * during that await accumulate in a fresh queue and the next round collects
 * them. A second call landing mid-drain returns immediately — the pass already
 * running will see its item. That is safe rather than lossy because JavaScript
 * is single-threaded: a re-entrant call can only interleave at an await, and
 * the only await here is the one the loop iterates after. The empty check and
 * the release of the in-flight flag are contiguous with no await between them,
 * so nothing can slip into the gap.
 *
 * Dependency-free and generic so the invariant can be asserted on its own,
 * rather than inferred from a balance pipeline that needs an engine to run.
 */

export interface DrainLoop {
  (): Promise<void>;
  /** Whether a pass is currently running. Exposed for assertions. */
  readonly running: boolean;
}

export const createDrainLoop = <T>(
  /** Take everything queued and clear the queue. Must be synchronous. */
  take: () => T[],
  apply: (batch: T[]) => Promise<void>,
): DrainLoop => {
  let running = false;

  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const batch = take();
        if (batch.length === 0) return;
        await apply(batch);
      }
    } finally {
      running = false;
    }
  };

  return Object.defineProperty(run, "running", {
    get: () => running,
  }) as DrainLoop;
};
