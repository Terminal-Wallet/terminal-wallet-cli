/**
 * Gas-estimate fixtures. PrivateGasEstimate nests SDK gas detail that tests do
 * not assert on; we set the asserted fields and stub the rest.
 */
import { PrivateGasEstimate } from "../../../src/models/transaction-models";

export const privateGasEstimate = (
  over: Partial<PrivateGasEstimate> = {},
): PrivateGasEstimate => ({
  symbol: "ETH",
  estimatedGasDetails: {} as PrivateGasEstimate["estimatedGasDetails"],
  estimatedCost: 0.01,
  broadcasterFeeERC20Recipient: undefined,
  overallBatchMinGasPrice: undefined,
  ...over,
});
