/**
 * Error helpers. Deliberately dependency-free so anything — including the
 * lifecycle module that installs the global handlers — can use them without a
 * cycle.
 */

/**
 * Best-effort message for a thrown value. `catch` gives you `unknown`, and the
 * thing thrown is regularly not an Error: SDK internals reject with strings and
 * with plain objects carrying a `message`. Reaching for `.message` on those
 * yields "undefined" in a log line, which is how a real failure gets reported as
 * nothing at all.
 */
export const errMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (err !== null && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

/**
 * An error's message plus the chain of causes behind it.
 *
 * The RAILGUN engine reports failures as `new Error("Unable to decrypt
 * ciphertext.", { cause })`, where every fact worth having is in the cause. A
 * bare `.message` therefore says only that something did not decrypt — not
 * which record, or why — which is a diagnosis nobody can act on.
 *
 * Depth-limited because causes can be cyclic, and each link is truncated so one
 * enormous RPC body cannot bury the message it is attached to.
 */
export const errDetail = (err: unknown, depth = 3): string => {
  const head = errMessage(err);
  if (depth <= 0 || !(err instanceof Error) || err.cause === undefined) {
    return head;
  }
  const cause = errDetail(err.cause, depth - 1);
  if (!cause || cause === head) return head;
  const trimmed = cause.length > 300 ? `${cause.slice(0, 300)}…` : cause;
  return `${head} ← ${trimmed}`;
};

/**
 * Run `work`, or reject with `${label} timed out after ${ms}ms`. Used to bound
 * shutdown so a hung teardown cannot wedge the exit path, but general enough to
 * bound anything that talks to the network or a native module.
 *
 * The timer is always cleared, including on the success path — an uncleared
 * timer keeps the event loop alive and the process never exits.
 */
export const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
