/**
 * Logs must reach the pane, not the screen.
 *
 * The deck drew fine and then dissolved: the SDK's provider health checks write
 * multi-kilobyte error bodies through the logger, the logger wrote to stdout,
 * and blessed had no idea its output had been painted over. The log pane sat
 * empty the whole time — nothing had ever connected the logger to it.
 *
 * This walks the real path end to end (logger → sink → core event → adapter →
 * store) rather than stubbing the middle, because every one of those links
 * existed individually and the defect was that they were never joined up.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "../../../src/platform/logger";
import { installDeckLogSink, releaseDeckLogSink } from "../../../src/tui/log-sink";
import { attachCoreAdapter } from "../../../src/tui/adapter";
import { getState, setState } from "../../../src/tui/store";

let written: string[] = [];
let restore: Array<() => void> = [];

beforeEach(() => {
  written = [];
  restore = [];
  for (const stream of [process.stdout, process.stderr] as const) {
    const original = stream.write.bind(stream);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (stream as any).write = (chunk: any) => {
      written.push(String(chunk));
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    restore.push(() => ((stream as any).write = original));
  }
  setState({ logs: [] });
  attachCoreAdapter();
  installDeckLogSink();
});

afterEach(() => {
  releaseDeckLogSink();
  for (const undo of restore) undo();
});

const terminal = () => written.join("");

test("an engine warning lands in the pane and never on the terminal", () => {
  createLogger("engine").warn("provider health check", "403 Forbidden");
  const { logs } = getState();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /provider health check/);
  assert.match(logs[0], /403 Forbidden/);
  assert.equal(terminal(), "", "the screen was written to");
});

test("a multi-line record stays one entry", () => {
  // A failed RPC logs an HTML body. The pane joins entries with a newline, so
  // an unflattened record would read as dozens of unrelated events.
  createLogger("engine").error("boom", "<html>\n  <body>\n    nope\n  </body>\n</html>");
  const { logs } = getState();
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes("\n"), "the record carried a newline into the pane");
  assert.match(logs[0], /<html> <body> nope/);
});

test("the level survives into the pane's marker", () => {
  createLogger("engine").error("fatal thing");
  assert.match(getState().logs[0], /^✖/);
  setState({ logs: [] });
  createLogger("engine").warn("iffy thing");
  assert.match(getState().logs[0], /^▲/);
});

test("releasing the sink puts logging back on the terminal", () => {
  releaseDeckLogSink();
  createLogger("engine").warn("after teardown");
  assert.equal(getState().logs.length, 0, "the pane took a line it should not have");
  assert.match(terminal(), /after teardown/);
});

test("a secret is redacted before it reaches the pane", () => {
  // The pane is a display surface and its contents are scrollable and
  // copyable — a leak here is a leak.
  const mnemonic =
    "legal winner thank year wave sausage worth useful legal winner thank yellow";
  createLogger("engine").info(`seed ${mnemonic}`);
  assert.ok(!getState().logs[0].includes(mnemonic));
  assert.match(getState().logs[0], /REDACTED/);
});
