/** FeeMode fixtures for the three fee-payment paths. */
import { FeeMode } from "../../../src/flows/spec";
import { WalletCache } from "../../../src/models/wallet-models";
import { selectedBroadcaster } from "./broadcasters";

export const selfSignerFee = (
  signer: WalletCache = {} as WalletCache,
): FeeMode => ({ kind: "self-signer", signer });

export const broadcasterFee = (
  broadcaster = selectedBroadcaster(),
): FeeMode => ({ kind: "broadcaster", broadcaster });

export const externalSignerFee = (label = "ext-key"): FeeMode => ({
  kind: "external-signer",
  label,
});
