/**
 * Divert the logger into the deck's log pane.
 *
 * A full-screen terminal UI and a logger that writes to stdout cannot share a
 * terminal. The SDK's provider health checks are chatty — a single failed RPC
 * can log an entire HTML error body — and every byte of it lands on top of
 * whatever blessed had drawn, which blessed never finds out about. The screen
 * is left corrupt with no way to repair it short of a redraw the app has no
 * reason to trigger.
 *
 * So the deck takes the stream: every line becomes a core `log` event, which
 * the adapter folds into the store, which the log pane renders. Teardown gives
 * it back, because a crash report after the screen is gone belongs on the
 * terminal.
 */
import { setLogSink } from "../platform/logger";
import { emitCoreEvent } from "../core/events";

/** Install before anything that can log — provider loading starts early. */
export const installDeckLogSink = (): void => {
  setLogSink(({ level, namespace, text }) => {
    emitCoreEvent({
      type: "log",
      // The pane has no separate debug tier; debug lines are already filtered
      // by the logger's own threshold before they reach here.
      level: level === "debug" ? "info" : level,
      // The pane joins entries with a newline, so an embedded one would read as
      // several unrelated events. Collapsed to keep one record on one line.
      text: `${namespace} ${text}`.replace(/\s+/g, " ").trim(),
    });
  });
};

export const releaseDeckLogSink = (): void => setLogSink(undefined);
