/**
 * Stub factory for ApprovalFlowDeps<Tx> with a call recorder, so the approval
 * loop (needed → prepare → confirm → send) is assertable. Generalized from the
 * inline `deps(overrides)` helper in approval-flow.test.ts.
 */
import {
  ApprovalFlowDeps,
  ApprovalItem,
} from "../../../src/flows/approval-flow";

export type StubApprovalTx = { to: string; symbol: string };

export interface ApprovalCalls<Tx> {
  prepared: ApprovalItem<Tx>[];
  confirmed: string[];
  sent: Tx[];
}

const defaultItems: ApprovalItem<StubApprovalTx>[] = [
  { symbol: "WETH", populatedTransaction: { to: "0xweth", symbol: "WETH" } },
];

export const makeApprovalDeps = <Tx = StubApprovalTx>(
  over: Partial<ApprovalFlowDeps<Tx>> = {},
): { deps: ApprovalFlowDeps<Tx>; calls: ApprovalCalls<Tx> } => {
  const calls: ApprovalCalls<Tx> = { prepared: [], confirmed: [], sent: [] };
  const deps: ApprovalFlowDeps<Tx> = {
    getNeeded: async () =>
      defaultItems as unknown as ApprovalItem<Tx>[],
    prepare: async (item) => {
      calls.prepared.push(item);
      return {
        populatedTransaction: item.populatedTransaction,
        symbol: item.symbol,
        estimatedCost: "0.01",
      };
    },
    confirm: async (message) => {
      calls.confirmed.push(message);
      return true;
    },
    send: async (tx) => {
      calls.sent.push(tx);
      return { hash: "0xapprovalHash" };
    },
    ...over,
  };
  return { deps, calls };
};
