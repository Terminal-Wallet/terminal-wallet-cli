/**
 * Event capture for flow tests. `emit` is handed to runTransaction (which takes
 * an injectable emit) so the emitted CoreEvent sequence can be asserted without
 * touching the global bus. Generalized from the inline `collect()` helper.
 */
import { CoreEvent, TxPhase } from "../../../src/core/events";

type OfType<T extends CoreEvent["type"]> = Extract<CoreEvent, { type: T }>;

export interface EventCapture {
  /** Pass this as runTransaction's `emit`. */
  emit: (event: CoreEvent) => void;
  /** All captured events, in order. */
  events: CoreEvent[];
  /** tx:progress phases in emission order. */
  phases: () => TxPhase[];
  /** All events of a given type, narrowed. */
  byType: <T extends CoreEvent["type"]>(type: T) => OfType<T>[];
  /** The terminal tx:result, if any. */
  result: () => OfType<"tx:result"> | undefined;
  /** status:message texts in order. */
  messages: () => string[];
  /** Clear captured events (e.g. between sub-cases). */
  reset: () => void;
}

export const collectEvents = (): EventCapture => {
  const events: CoreEvent[] = [];
  return {
    emit: (event) => {
      events.push(event);
    },
    events,
    phases: () =>
      events
        .filter((e): e is OfType<"tx:progress"> => e.type === "tx:progress")
        .map((e) => e.phase),
    byType: (type) => events.filter((e) => e.type === type) as OfType<typeof type>[],
    result: () =>
      events.find((e): e is OfType<"tx:result"> => e.type === "tx:result"),
    messages: () =>
      events
        .filter((e): e is OfType<"status:message"> => e.type === "status:message")
        .map((e) => e.text),
    reset: () => {
      events.length = 0;
    },
  };
};
