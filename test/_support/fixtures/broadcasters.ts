/**
 * Broadcaster fixtures. The real SelectedBroadcaster carries SDK-internal fee
 * detail; tests only assert on railgunAddress + tokenFee.feesID, so we build the
 * fields that matter and widen to the SDK type.
 */
import { SelectedBroadcaster } from "@railgun-community/shared-models";
import { TOKENS } from "./tokens";

export const selectedBroadcaster = (
  over: Partial<SelectedBroadcaster> = {},
): SelectedBroadcaster =>
  ({
    railgunAddress: "0zkBroadcaster",
    tokenAddress: TOKENS.WETH.address,
    tokenFee: {
      feesID: "fee-123",
      feePerUnitGas: "1",
      expiration: 9_999_999_999,
      feesID_pretty: "fee-123",
    },
    ...over,
  }) as unknown as SelectedBroadcaster;
