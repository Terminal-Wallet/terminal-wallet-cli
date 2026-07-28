/**
 * Proof-of-Innocence maintenance.
 *
 * Each of these starts long-running engine work and returns immediately —
 * generating or refreshing POIs walks history and can take minutes. Progress and
 * completion arrive as scan and balance events, so the screen reports that the
 * work started and gets out of the way rather than holding a modal open on a
 * spinner the engine never talks to.
 *
 * Needs no deck context: it asks through the input seam and reports through the
 * store, so it is drivable from any host including a test.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { getInputProvider } from "../../core/input";
import { setState, setStatusMessage } from "../store";
import {
  generateWalletPOIs,
  refreshReceivedPOIs,
  refreshSpentPOIs,
} from "../../railgun/wallet/wallet-tools";

const ACTIONS = {
  generate: { label: "Generate Wallet POIs", hint: "create proofs", run: generateWalletPOIs },
  received: { label: "Refresh Received POIs", hint: "incoming", run: refreshReceivedPOIs },
  spent: { label: "Refresh Spent POIs", hint: "outgoing", run: refreshSpentPOIs },
} as const;

type ActionId = keyof typeof ACTIONS;

export const runPOITools = async (network: NetworkName): Promise<void> => {
  const chosen = await getInputProvider().select(
    "◆ POI Tools",
    Object.entries(ACTIONS).map(([value, a]) => ({
      value,
      label: a.label,
      hint: a.hint,
    })),
  );
  if (!chosen || !(chosen in ACTIONS)) {
    return;
  }

  const action = ACTIONS[chosen as ActionId];
  setStatusMessage(`POI: ${chosen} started…`);

  // Deliberately not awaited — see the note above. Both outcomes report through
  // the store so a failure is visible rather than silently never finishing.
  void action
    .run(network)
    .then(() => setStatusMessage(`POI: ${chosen} complete.`))
    .catch((err: Error) =>
      setStatusMessage(`POI ${chosen} failed: ${err.message}`),
    );
};
