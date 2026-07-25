/**
 * Proved-transaction fixture (RailgunPopulateTransactionResponse). The real type
 * carries SDK proof metadata; tests assert on `.transaction`, so we set that and
 * widen to the SDK type.
 */
import { RailgunPopulateTransactionResponse } from "@railgun-community/shared-models";

export const provedTransaction = (
  over: Partial<RailgunPopulateTransactionResponse> = {},
): RailgunPopulateTransactionResponse =>
  ({
    transaction: { to: "0xto", data: "0xdata" },
    nullifiers: [],
    ...over,
  }) as RailgunPopulateTransactionResponse;
