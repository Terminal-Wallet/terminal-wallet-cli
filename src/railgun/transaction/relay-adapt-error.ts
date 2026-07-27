/**
 * Whether a relay-adapt batch actually did what it said.
 *
 * A relay-adapt transaction succeeding is not the same as the work inside it
 * succeeding. The SDK builds the action data with `requireSuccess = false` on
 * both the estimate and the proof path
 * (`@railgun-community/wallet/dist/services/transactions/tx-cross-contract-calls-7702.js`,
 * the two `createActionData` calls), so a batch whose inner calls revert still
 * mines: the RAILGUN unshield has already run, and whatever it produced is
 * sitting at the ephemeral account rather than coming back shielded.
 *
 * The receipt says so, in a `CallError` log the relay-adapt contract emits. The
 * wallet did not read it, so a swap that bought nothing, a vault deposit that
 * deposited nothing and a mint that minted nothing all reported "mined" and
 * looked exactly like a success.
 */
import { NetworkName, TXIDVersion } from "@railgun-community/shared-models";
import { RelayAdaptVersionedSmartContracts } from "@railgun-community/engine";
import { getProviderForChain } from "../network/network-util";
import { createLogger } from "../../platform/logger";

const log = createLogger("relay-adapt");

/** The receipt log shape the engine's decoder wants — topics and data only. */
type ReceiptLog = { topics: string[]; data: string };

/**
 * The failure a mined relay-adapt batch is carrying, if it is carrying one.
 *
 * Returns undefined when the batch did what it said, and also when the receipt
 * cannot be read — an RPC that will not answer is not evidence of success, but
 * it is not evidence of failure either, and reporting a failure that did not
 * happen would send the user looking for funds that are where they should be.
 */
export const getRelayAdaptFailure = async (
  chainName: NetworkName,
  txHash: string,
): Promise<string | undefined> => {
  try {
    const provider = getProviderForChain(chainName);
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return undefined;
    return RelayAdaptVersionedSmartContracts.getRelayAdaptCallError(
      TXIDVersion.V2_PoseidonMerkle,
      receipt.logs as unknown as ReceiptLog[],
      true,
    );
  } catch (err) {
    log.debug(`could not read the receipt for ${txHash}`, err);
    return undefined;
  }
};
