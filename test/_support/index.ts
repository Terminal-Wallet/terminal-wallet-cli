/**
 * Shared test support — deterministic fixtures, stub factories, and event
 * capture. Import from here for terse, consistent setup:
 *   import { TOKENS, collectEvents, makeRunDeps } from "../_support";
 *
 * This barrel grows with the code it supports; each entry is added in the same
 * commit as its subject, so it never re-exports something that does not exist.
 */

// capture
export * from "./capture/events";
export * from "./capture/core-bus";

// stubs
export * from "./stubs/tx-run-deps";
export * from "./stubs/send-private-deps";
export * from "./stubs/send-public-deps";
export * from "./stubs/cross-contract-pipeline";
export * from "./stubs/approval-deps";
export * from "./stubs/fake-provider";

// fixtures
export * from "./fixtures/tokens";
export * from "./fixtures/networks";
export * from "./fixtures/recipients";
export * from "./fixtures/broadcasters";
export * from "./fixtures/fees";
export * from "./fixtures/gas";
export * from "./fixtures/proved";
export * from "./fixtures/specs";
export * from "./fixtures/railgun-fees";
