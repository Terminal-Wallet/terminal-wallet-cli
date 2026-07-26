/**
 * One definition of "synced".
 *
 * There were two. The sync card called a tree done when it had leaves and was
 * not mid-scan; the builder's proof warning required the `ready` latch. The
 * engine emits a progress-0 callback after a scan completes, and 0 satisfies
 * neither "scanning" nor the latch's `< 0 || >= 100` — so the card showed ✓
 * while the transaction window said "not fully synced — proof may fail".
 *
 * Both now call this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { treeSynced } from "../../../src/tui/format/dashboard";

test("the ready latch alone is enough", () => {
  assert.equal(treeSynced({ leaves: 0, progress: 0, ready: true }), true);
});

test("a built tree at rest is synced even without the latch", () => {
  // The post-complete progress-0 callback. This is the case that made the two
  // definitions disagree.
  assert.equal(treeSynced({ leaves: 56_672, progress: 0, ready: false }), true);
});

test("a tree mid-scan is not synced", () => {
  assert.equal(treeSynced({ leaves: 100, progress: 42, ready: false }), false);
});

test("100% is not mid-scan", () => {
  assert.equal(treeSynced({ leaves: 100, progress: 100, ready: false }), true);
});

test("the idle sentinel is not mid-scan", () => {
  // -1 is "nothing running", which the feeders use between scans.
  assert.equal(treeSynced({ leaves: 100, progress: -1, ready: false }), true);
});

test("an empty tree is not synced, whatever the progress", () => {
  // Nothing scanned yet — the card shows "…" rather than a false ✓.
  assert.equal(treeSynced({ leaves: 0, progress: 0, ready: false }), false);
  assert.equal(treeSynced({ leaves: 0, progress: -1, ready: false }), false);
  assert.equal(treeSynced({ leaves: -1, progress: 100, ready: false }), false);
});

test("mid-scan cannot override an established latch", () => {
  // A re-scan of an already-synced tree should not retract the fact that its
  // notes are spendable.
  assert.equal(treeSynced({ leaves: 100, progress: 42, ready: true }), true);
});
