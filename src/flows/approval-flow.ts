/**
 * ERC20 approval pre-step for shields — pure flow logic with everything injected
 * (which approvals are needed, gas prep, confirm, send) so it's unit-testable.
 * The shield pipeline runs only after this returns ok.
 */
export interface ApprovalItem<Tx> {
  symbol: string;
  populatedTransaction: Tx;
}

export interface PreparedApproval<Tx> {
  populatedTransaction: Tx;
  symbol: string;
  estimatedCost: string;
}

export interface ApprovalFlowDeps<Tx> {
  /** Which approvals are still needed (empty = already approved). */
  getNeeded: () => Promise<ApprovalItem<Tx>[]>;
  /** Estimate gas / finalize the approval tx for signing (keeps the token symbol). */
  prepare: (item: ApprovalItem<Tx>) => Promise<PreparedApproval<Tx>>;
  /** Ask the user to approve this spend. */
  confirm: (message: string) => Promise<boolean>;
  /** Sign + send the approval tx. */
  send: (tx: Tx) => Promise<{ hash: string }>;
}

export interface ApprovalResult {
  ok: boolean; // all required approvals completed
  sent: number; // approvals actually sent
  declined: boolean; // user declined one
}

export const runApprovals = async <Tx>(
  deps: ApprovalFlowDeps<Tx>,
): Promise<ApprovalResult> => {
  const needed = await deps.getNeeded();
  if (needed.length === 0) {
    return { ok: true, sent: 0, declined: false };
  }

  let sent = 0;
  for (const item of needed) {
    const prepared = await deps.prepare(item);
    const approved = await deps.confirm(
      `Approve ${prepared.symbol} (cost ${prepared.estimatedCost})?`,
    );
    if (!approved) {
      return { ok: false, sent, declined: true };
    }
    await deps.send(prepared.populatedTransaction);
    sent += 1;
  }
  return { ok: true, sent, declined: false };
};
