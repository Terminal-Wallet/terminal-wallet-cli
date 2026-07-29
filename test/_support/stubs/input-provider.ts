/**
 * An input provider for tests that answers only what a test means to answer.
 *
 * The seam's contract lets a provider return `undefined`, and every consumer in
 * this codebase reads that as "the user cancelled" — a different outcome, not a
 * failure. A stub built that way turns a prompt the test forgot about into a
 * quietly different code path, and the assertion that fails afterwards points
 * somewhere else entirely.
 *
 * So this one throws for anything it was not set up to answer. `notify` is the
 * exception: it is a one-way channel some refusals have and nowhere else to go,
 * so it is captured instead.
 */
import { InputChoice, WalletInputProvider } from "../../../src/core/input";
import { TMPWalletInfo } from "../../../src/models/wallet-models";

export interface StubInputOptions {
  /** Collects everything `notify` would have shown a user. */
  notices: string[];
  /** What a yes/no confirmation answers. Unset means the test expects none. */
  confirmAll?: boolean;
}

const unanswered = (what: string): never => {
  throw new Error(`the stub input provider was asked to ${what}`);
};

export const createStubInputProvider = (
  opts: StubInputOptions,
): WalletInputProvider => ({
  async promptPassword(): Promise<string | undefined> {
    return unanswered("prompt for a password");
  },
  async promptNewWallet(): Promise<TMPWalletInfo | undefined> {
    return unanswered("collect new wallet details");
  },
  async confirm(message: string): Promise<boolean> {
    if (opts.confirmAll === undefined) return unanswered(`confirm "${message}"`);
    return opts.confirmAll;
  },
  notify(message: string): void {
    opts.notices.push(message);
  },
  async select(message: string, _choices: InputChoice[]): Promise<string | undefined> {
    return unanswered(`select for "${message}"`);
  },
  async multiSelect(message: string): Promise<string[] | undefined> {
    return unanswered(`multi-select for "${message}"`);
  },
  async input(message: string): Promise<string | undefined> {
    return unanswered(`take input for "${message}"`);
  },
});
