/**
 * Error causes.
 *
 * The RAILGUN engine reports failures as `new Error("Unable to decrypt
 * ciphertext.", { cause })`, and everything that identifies which record failed
 * and why is in the cause. Reporting only `.message` left a status line saying
 * something did not decrypt, with no way to tell whether that was a wrong key,
 * a missing record, or damaged data — which is a diagnosis nobody can act on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { errDetail, errMessage } from "../../../src/platform/errors";

test("a plain error reads as its message", () => {
  assert.equal(errDetail(new Error("boom")), "boom");
});

test("a cause is appended", () => {
  const err = new Error("Unable to decrypt ciphertext.", {
    cause: new Error("Unsupported state or unable to authenticate data"),
  });
  assert.match(errDetail(err), /Unable to decrypt ciphertext\./);
  assert.match(errDetail(err), /unable to authenticate data/);
});

test("nested causes are followed, to a limit", () => {
  // Six deep; the default follows three hops from the head.
  const deep = new Error("a", {
    cause: new Error("b", {
      cause: new Error("c", {
        cause: new Error("d", {
          cause: new Error("e", { cause: new Error("f") }),
        }),
      }),
    }),
  });
  const detail = errDetail(deep);
  assert.match(detail, /a.*b.*c.*d/s, "should follow the near causes");
  // Bounded: causes can be cyclic, and an unbounded walk would hang.
  assert.ok(!detail.includes("e"), "walked past the depth limit");
});

test("a self-referencing cause terminates", () => {
  const err = new Error("loop") as Error & { cause?: unknown };
  err.cause = err;
  assert.match(errDetail(err), /loop/);
});

test("an enormous cause is truncated, not dropped", () => {
  // A failed RPC attaches an entire HTML body. It must not bury the message it
  // is attached to, and it must not vanish either.
  const err = new Error("request failed", { cause: new Error("x".repeat(5000)) });
  const detail = errDetail(err);
  assert.match(detail, /^request failed ←/);
  assert.ok(detail.length < 500, `not truncated: ${detail.length} chars`);
  assert.match(detail, /…$/);
});

test("a duplicate cause is not repeated", () => {
  const err = new Error("same", { cause: new Error("same") });
  assert.equal(errDetail(err), "same");
});

test("non-Error values still report", () => {
  assert.equal(errDetail("a string"), "a string");
  assert.equal(errDetail({ message: "objecty" }), "objecty");
  assert.equal(errMessage(new Error("plain")), "plain");
});
