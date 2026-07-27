/**
 * Opening a flow must forget the previous one.
 *
 * The builder caches things it derives from the form — the swap quote, the
 * batch breakdown, the pool's risk thresholds, the fee preview. They live in
 * the builder's closure, not in `state`, so resetting `state` does not clear
 * them. Miss one and the next action opens describing the previous action's
 * batch until an edit happens to recompute it, which is worse than showing
 * nothing: it is a confident description of the wrong transaction.
 *
 * A source guard because the caches are closure-local by design — there is no
 * seam to assert against, and inventing one would be a worse trade than
 * checking that the reset block mentions each of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const builder = readFileSync(
  join(resolve(process.cwd(), "src"), "tui/screens/builder.ts"),
  "utf-8",
);

/** The reset block at the top of openBuilder. */
const resetBlock = (): string => {
  const at = builder.indexOf("const openBuilder = async");
  assert.ok(at > 0, "openBuilder not found");
  const body = builder.slice(at);
  const end = body.indexOf("prices = {}");
  assert.ok(end > 0, "the reset block has moved");
  return body.slice(0, end);
};

for (const cache of [
  "swapPreview",
  "legsPreview",
  "fxThresholds",
  "feePreview",
  "feeReservation",
  "loadedBalances",
]) {
  test(`opening a flow clears ${cache}`, () => {
    assert.match(
      resetBlock(),
      new RegExp(`${cache}\\s*=`),
      `${cache} survives into the next flow`,
    );
  });
}

test("every closure cache the builder derives is in that list", () => {
  // If a new `let x: ... | undefined` appears in the builder's closure and is
  // not reset above, this is the thing that notices.
  const declared = [
    ...builder.matchAll(/^ {2}let (\w+)(?::|\s*=)/gm),
  ].map((m) => m[1]);
  const derived = declared.filter(
    (name) => !["cfg", "state", "rows", "prices"].includes(name),
  );
  const block = resetBlock();
  for (const name of derived) {
    assert.match(
      block,
      new RegExp(`${name}\\s*=`),
      `${name} is derived per-flow but is not reset when a flow opens`,
    );
  }
});
