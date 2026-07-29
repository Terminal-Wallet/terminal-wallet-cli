/**
 * What the chain says happened, read from the receipt.
 *
 * The wait helpers in `public-tx.ts` cannot answer this and never could.
 * `wait()` rejects on a reverted receipt (ethers throws CALL_EXCEPTION for
 * `status === 0`), `promiseTimeout` rejects on expiry, and both rejections are
 * caught and turned into a normal return — deliberately, because the same catch
 * absorbs the yParity parse failure a mined 7702 transaction produces. So "the
 * wait finished" says nothing about whether the transaction did what it was
 * sent to do, and every caller that reported "mined" off that return was
 * reporting only that the watcher had stopped watching.
 *
 * `unknown` is deliberately distinct from both outcomes: an RPC that will not
 * serve a receipt is not evidence of failure, and an outcome that cannot be
 * read must not be reported as either one.
 *
 * A leaf on purpose — it imports nothing that reaches a provider, so the rule
 * it encodes stays testable without standing up the network stack.
 */
import { errMessage } from "../../../platform/errors";

export type TxSettlement =
  | { kind: "mined"; blockNumber?: number }
  | { kind: "reverted"; blockNumber?: number }
  | { kind: "unknown"; reason: string };

/** The slice of a provider this needs — narrow so a test can supply one. */
export type ReceiptReader = {
  getTransactionReceipt: (hash: string) => Promise<{
    status?: number | null;
    blockNumber?: number;
  } | null>;
};

export const settlementFromReceipt = async (
  provider: ReceiptReader | undefined | null,
  txHash: string,
): Promise<TxSettlement> => {
  if (!provider) {
    return { kind: "unknown", reason: "no provider to read the receipt from" };
  }
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return { kind: "unknown", reason: "no receipt available" };
    }
    if (receipt.status === 1) {
      return { kind: "mined", blockNumber: receipt.blockNumber };
    }
    if (receipt.status === 0) {
      return { kind: "reverted", blockNumber: receipt.blockNumber };
    }
    // Pre-Byzantium receipts carry no status. Nothing this wallet talks to is
    // that old, so an absent status means the receipt is not the shape we think
    // it is — which is a reason to say "unknown", not to assume success.
    return { kind: "unknown", reason: "receipt carries no status field" };
  } catch (err) {
    return { kind: "unknown", reason: errMessage(err) };
  }
};
