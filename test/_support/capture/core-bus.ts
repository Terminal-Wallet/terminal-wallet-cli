/**
 * Capture events emitted on the GLOBAL core bus during `fn`. Needed for code
 * paths that emit via the default `emitCoreEvent` (e.g. send-private/public
 * default deps' notifyMined). Always unsubscribes in `finally` so a handler
 * never leaks across tests.
 */
import { CoreEvent, onCoreEvent } from "../../../src/core/events";

export const withCoreBus = async <T>(
  fn: () => Promise<T> | T,
): Promise<{ result: T; events: CoreEvent[] }> => {
  const events: CoreEvent[] = [];
  const unsubscribe = onCoreEvent((e) => events.push(e));
  try {
    const result = await fn();
    return { result, events };
  } finally {
    unsubscribe();
  }
};
