/**
 * Asking an endpoint whether it is there, and saying so honestly.
 *
 * The failure this guards is the one this codebase keeps rediscovering: a read
 * that fails soft and renders as a number, so a dead endpoint reads as a
 * healthy one and nobody looks again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBlockNumberResponse } from "../../../src/railgun/network/rpc-probe";
import {
  RpcRow,
  leadBlock,
  rpcStatusLabel,
  rpcSummaryLine,
  shortenUrl,
} from "../../../src/tui/format/rpc-status";

test("a hex quantity is the block height", () => {
  const r = parseBlockNumberResponse({ jsonrpc: "2.0", id: 1, result: "0x1892d4b" });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.blockNumber, 25767243n);
});

test("a JSON-RPC error is a failure, carrying its reason", () => {
  const r = parseBlockNumberResponse({
    jsonrpc: "2.0",
    id: 1,
    error: { code: 429, message: "rate limit exceeded" },
  });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /rate limit/);
});

test("an error sent with HTTP 200 is still an error", () => {
  // Several providers answer 200 with an error body; trusting the status code
  // would report them as working.
  const r = parseBlockNumberResponse({ error: "upstream unavailable" });
  assert.equal(r.ok, false);
});

test("a non-hex result is refused rather than coerced", () => {
  for (const result of ["", "latest", "12345", "0x", null, 25n]) {
    const r = parseBlockNumberResponse({ result });
    assert.equal(r.ok, false, `accepted ${String(result)}`);
  }
});

test("HTML from a proxy is not JSON-RPC", () => {
  assert.equal(parseBlockNumberResponse("<html>502</html>").ok, false);
  assert.equal(parseBlockNumberResponse(null).ok, false);
});

test("CONTROL: block 0 is reported as a fault, not as a height", () => {
  // The whole point. A stub, an unsynced node or a method that is not
  // implemented can answer 0; rendering "block 0" next to real heights is the
  // error-to-zero read that makes a broken endpoint look merely quiet.
  const r = parseBlockNumberResponse({ result: "0x0" });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /block 0/);
});

// --- how it reads on the row ------------------------------------------------

const row = (over: Partial<RpcRow> = {}): RpcRow => ({
  url: "https://eth.example.com/v2/abcdef",
  enabled: true,
  isDefault: true,
  ...over,
});

const ok = (blockNumber: bigint, latencyMs = 40) =>
  ({ ok: true as const, blockNumber, latencyMs });

test("an unprobed row says it is still checking, not that it failed", () => {
  assert.equal(rpcStatusLabel(row()), "checking…");
});

test("a healthy row shows its height and latency", () => {
  const label = rpcStatusLabel(row({ probe: ok(25767755n) }), 25767755n);
  assert.match(label, /25,767,755/);
  assert.match(label, /40ms/);
});

test("a straggler is reported by how far back it is", () => {
  // The failure that looks most like success: it answers, the number is
  // plausible, and everything reading through it gets stale state.
  const label = rpcStatusLabel(row({ probe: ok(25767555n) }), 25767755n);
  assert.match(label, /200 behind/);
});

test("one block of drift is propagation, not a fault", () => {
  const label = rpcStatusLabel(row({ probe: ok(25767754n) }), 25767755n);
  assert.ok(!/behind/.test(label), `called ordinary drift a fault: ${label}`);
});

test("a failed probe shows the reason, never a number", () => {
  const label = rpcStatusLabel(row({ probe: { ok: false, reason: "timed out after 5s" } }));
  assert.equal(label, "timed out after 5s");
  assert.ok(!/\d{3,}/.test(label), "a failure rendered something height-shaped");
});

test("the summary counts what answers, not what is configured", () => {
  const rows = [
    row({ url: "a", probe: ok(10n) }),
    row({ url: "b", probe: { ok: false, reason: "unreachable" } }),
    row({ url: "c", enabled: false }),
  ];
  assert.equal(rpcSummaryLine(rows), "1 of 2 enabled endpoints answering");
});

test("the summary says so when nothing answers", () => {
  const rows = [row({ url: "a", probe: { ok: false, reason: "unreachable" } })];
  assert.match(rpcSummaryLine(rows), /NONE/);
});

test("the summary says so when nothing is enabled", () => {
  assert.match(rpcSummaryLine([row({ enabled: false })]), /cannot reach/);
});

test("a disabled endpoint is not counted as a failure while probes are out", () => {
  const rows = [row({ url: "a" }), row({ url: "b", enabled: false })];
  assert.match(rpcSummaryLine(rows), /1 still checking/);
});

test("the lead is the furthest ahead that answered, ignoring failures", () => {
  const rows = [
    row({ url: "a", probe: ok(10n) }),
    row({ url: "b", probe: { ok: false, reason: "x" } }),
    row({ url: "c", probe: ok(99n) }),
  ];
  assert.equal(leadBlock(rows), 99n);
  assert.equal(leadBlock([row({ probe: { ok: false, reason: "x" } })]), undefined);
});

test("a long URL keeps its tail, so two keys are still distinguishable", () => {
  const a = shortenUrl("https://eth-mainnet.example.com/v2/AAAAAAAAAAAAAAAAAAAAAAAA1111");
  const b = shortenUrl("https://eth-mainnet.example.com/v2/AAAAAAAAAAAAAAAAAAAAAAAA2222");
  assert.notEqual(a, b, "two endpoints collapsed to the same label");
});

test("a short URL is left alone", () => {
  assert.equal(shortenUrl("https://rpc.example.com"), "https://rpc.example.com");
});
