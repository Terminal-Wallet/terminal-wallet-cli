/**
 * Shared test support — deterministic fixtures, and later the stub factories,
 * event/console capture, and fakes. Import from here for terse, consistent
 * setup:
 *   import { TOKENS, transferRecipient } from "../_support";
 *
 * This barrel grows with the code it supports. Capture and fakes arrive with
 * the core seam; stubs and spec fixtures arrive with the flow layer. Each is
 * added here in the same commit as its subject, so the barrel never re-exports
 * something that does not exist yet.
 */

// fixtures
export * from "./fixtures/tokens";
export * from "./fixtures/networks";
export * from "./fixtures/recipients";
export * from "./fixtures/broadcasters";
export * from "./fixtures/gas";
export * from "./fixtures/proved";
