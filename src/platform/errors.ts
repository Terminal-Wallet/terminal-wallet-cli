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
