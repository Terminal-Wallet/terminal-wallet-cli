/**
 * Fan-out with a ceiling.
 *
 * The wallet's scans are made of many small, independent RPC reads. Run in
 * series they are slow enough that the screen looks hung; run all at once they
 * get rate-limited, and a throttled read comes back as a failure — which
 * several call sites historically rendered as "nothing here". So the useful
 * shape is neither loop nor `Promise.all`, but a bounded pool.
 */

/**
 * Apply `fn` to every item with at most `limit` calls in flight.
 *
 * Results come back in INPUT order, not completion order — callers zip them
 * against the input list, so a pool that returned them as they finished would
 * silently pair each result with the wrong item.
 *
 * A rejection propagates, as `Promise.all` does. Callers that would rather
 * record a failure than lose the whole batch catch inside `fn`.
 */
export const mapLimited = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i], i);
    }
  };
  // `limit` workers, or fewer when there is less work than that — spawning
  // idle workers is harmless but makes the in-flight count harder to reason
  // about, and this bound is the whole point of the function.
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
};
