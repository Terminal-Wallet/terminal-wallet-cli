/**
 * Generic Relay-Adapt cross-contract calls — the rail that 0x swaps AND every
 * cookbook recipe (LP add/remove, Beefy deposit/withdraw, combo meals) ride.
 *
 * A "recipe" produces CrossContractInputs (unshield amounts + shield addresses,
 * the same pair again for NFTs, the contract calls, and a min gas limit). This
 * module turns any such inputs into a gas estimate and a proved transaction —
 * so wiring a new cookbook recipe is just: build its RecipeOutput →
 * CrossContractInputs → run.
 */
import {
  EVMGasType,
  NetworkName,
  RailgunERC20Recipient,
  RailgunNFTAmount,
  RailgunNFTAmountRecipient,
  RailgunPopulateTransactionResponse,
  SelectedBroadcaster,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import {
  gasEstimateForUnprovenCrossContractCalls7702,
  generateCrossContractCallsProof7702,
  populateProvedCrossContractCalls,
} from "@railgun-community/wallet";
import {
  RecipeERC20Amount,
  RecipeNFTRecipient,
} from "@railgun-community/cookbook";
import { ContractTransaction } from "ethers";
import { emitCoreEvent } from "../../core/events";
import { createLogger } from "../../platform/logger";

const log = createLogger("cross-contract");
import { getCurrentRailgunID } from "../wallet/wallet-util";
import { syncEphemeralIndexOnce } from "../wallet/ephemeral-util";
import { getCurrentNetwork } from "../engine/engine";
import {
  PrivateGasDetails,
  PrivateGasEstimate,
} from "../../models/transaction-models";
import { getTransactionGasDetails } from "./private/private-tx";
import { getOutputGasEstimate } from "./private/unshield-tx";

/**
 * The `minGasLimit` that results in no on-chain gas floor at all.
 *
 * The SDK does not pass this value to the contract directly. Every relay-adapt
 * contract — V2, V3 and the 7702 one — computes
 * `minGasLimitForContract = minGasLimit - 150000n` and bakes THAT into the
 * action data as `require(gasleft() > minGasLimitForContract)`. So the offset
 * is what "no floor" costs: 150_000n in gives exactly 0 out.
 *
 * Both neighbouring values are wrong. A literal `0n` yields -150_000n, which is
 * not encodable as the contract's unsigned parameter. `undefined` makes the SDK
 * substitute its own multi-million default, which forces the transaction to
 * CARRY that much gas and reverts the estimate on the floor check.
 *
 * With the floor at zero the estimate reflects real execution, and the
 * submitted limit is `calculateGasLimit(estimate)` — estimate x1.2 — which
 * `setGasDetailsForTransaction` writes over whatever populate had set.
 *
 * A clean estimate is NOT a prediction that the batch will do what it says.
 * The SDK builds the action data with `requireSuccess = false` on both the
 * estimate and the proof path
 * (`@railgun-community/wallet/dist/services/transactions/tx-cross-contract-calls-7702.js`),
 * so a batch whose inner calls revert still mines: the unshield has run, and
 * whatever it produced sits at the ephemeral account instead of coming back
 * shielded. The engine reports this as a `CallError` in the receipt logs, via
 * `RelayAdaptVersionedSmartContracts.getRelayAdaptCallError` — which nothing
 * here calls yet, so today that failure is silent on every cross-contract flow.
 */
export const NO_CROSS_CONTRACT_GAS_FLOOR = 150_000n;

/**
 * The output every recipe (0x swap, LP, Beefy, combo) reduces to.
 *
 * Every cross-contract batch is a 7702 relay-adapt: type-4 gas details, the
 * SDK's 7702 estimate and proof, no min-gas-price commitment.
 */
export interface CrossContractInputs {
  relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[];
  relayAdaptShieldERC20Addresses: RailgunERC20Recipient[];
  /**
   * NFTs the batch spends and produces — a protocol position that has to cross
   * the seam and come back, such as an f(x) fxMint position.
   *
   * Optional because most recipes move only tokens, and because the cookbook's
   * step validator passes an empty input NFT list without complaint: it checks
   * only that every INPUT NFT reappears in the outputs, so omitting a required
   * NFT is caught on-chain rather than at build time.
   */
  relayAdaptUnshieldNFTAmounts?: RailgunNFTAmount[];
  relayAdaptShieldNFTRecipients?: RailgunNFTAmountRecipient[];
  crossContractCalls: ContractTransaction[];
  /**
   * Always NO_CROSS_CONTRACT_GAS_FLOOR. Required rather than optional because
   * undefined is not "no floor" — the SDK substitutes its own default.
   */
  minGasLimit: bigint;
}

/**
 * The cookbook's NFT recipient shape, in the SDK's.
 *
 * They differ by one field name — the cookbook says `recipient`, the SDK says
 * `recipientAddress` — and the rest is identical, so passing one where the
 * other is expected is a type error rather than a silent misroute. This mirrors
 * the ERC-20 rename the swap path already does.
 */
export const toShieldNFTRecipients = (
  nftRecipients: RecipeNFTRecipient[],
): RailgunNFTAmountRecipient[] =>
  nftRecipients.map(({ recipient, ...nft }) => ({
    ...nft,
    recipientAddress: recipient,
  }));

export const getCrossContractGasEstimate = async (
  chainName: NetworkName,
  inputs: CrossContractInputs,
  encryptionKey: string,
  broadcasterSelection?: SelectedBroadcaster,
): Promise<PrivateGasEstimate | undefined> => {
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  // A recipe binds its calldata to an executor address when it is built. Realign
  // the ephemeral index before the SDK derives the address for this estimate, or
  // the batch is quoted for one account and executed as another.
  await syncEphemeralIndexOnce(chainName, encryptionKey);

  const gasDetailsResult = await getTransactionGasDetails(
    chainName,
    broadcasterSelection,
    true,
  );
  if (!gasDetailsResult) return undefined;

  const {
    originalGasDetails,
    feeTokenDetails,
    feeTokenInfo,
    sendWithPublicWallet,
    overallBatchMinGasPrice,
  } = gasDetailsResult as PrivateGasDetails;

  const {
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    relayAdaptUnshieldNFTAmounts = [],
    relayAdaptShieldNFTRecipients = [],
    crossContractCalls,
    minGasLimit,
  } = inputs;

  log.debug(
    `cross-contract estimate: unshield=${relayAdaptUnshieldERC20Amounts.length} ` +
      `shield=${relayAdaptShieldERC20Addresses.length} calls=${crossContractCalls.length} ` +
      `minGasLimit=${minGasLimit} evmGasType=${originalGasDetails.evmGasType} ` +
      `sendWithPublicWallet=${sendWithPublicWallet} feeToken=${feeTokenDetails ? "yes" : "none"}`,
  );
  crossContractCalls.forEach((c, i) =>
    log.debug(`  call[${i}] to=${c.to ?? "MISSING"} data=${c.data ? `${c.data.length}b` : "MISSING"} value=${c.value ?? 0n}`),
  );

  const { gasEstimate } = await gasEstimateForUnprovenCrossContractCalls7702(
    txIDVersion,
    chainName,
    railgunWalletID,
    encryptionKey,
    relayAdaptUnshieldERC20Amounts,
    relayAdaptUnshieldNFTAmounts,
    relayAdaptShieldERC20Addresses,
    relayAdaptShieldNFTRecipients,
    crossContractCalls,
    originalGasDetails,
    feeTokenDetails,
    sendWithPublicWallet,
    minGasLimit,
  );
  return getOutputGasEstimate(
    originalGasDetails,
    gasEstimate,
    feeTokenInfo,
    feeTokenDetails,
    broadcasterSelection,
    overallBatchMinGasPrice,
  );
};

export const getProvedCrossContractTransaction = async (
  encryptionKey: string,
  inputs: CrossContractInputs,
  privateGasEstimate: PrivateGasEstimate,
): Promise<RailgunPopulateTransactionResponse | undefined> => {
  const chainName = getCurrentNetwork();
  const railgunWalletID = getCurrentRailgunID();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;

  const progressCallback = (progress: number, progressStats: string) => {
    emitCoreEvent({
      type: "tx:progress",
      phase: "prove",
      pct: progress,
      message: isDefined(progressStats)
        ? `Transaction Proof Generation [${progressStats}]`
        : "Transaction Proof Generation",
    });
  };

  const {
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    relayAdaptUnshieldNFTAmounts = [],
    relayAdaptShieldNFTRecipients = [],
    crossContractCalls,
    minGasLimit,
  } = inputs;

  const { broadcasterFeeERC20Recipient, estimatedGasDetails } = privateGasEstimate;
  // Relay-adapt commits no overall-batch-min-gas-price: pricing is governed by
  // the type-4 maxFeePerGas, and a non-zero commitment reverts as "Gas price
  // too low" whenever the effective price falls below it.
  const overallBatchMinGasPrice = 0n;
  const sendWithPublicWallet =
    typeof broadcasterFeeERC20Recipient !== "undefined" ? false : true;

  try {
    await generateCrossContractCallsProof7702(
      txIDVersion,
      chainName,
      railgunWalletID,
      encryptionKey,
      relayAdaptUnshieldERC20Amounts,
      relayAdaptUnshieldNFTAmounts,
      relayAdaptShieldERC20Addresses,
      relayAdaptShieldNFTRecipients,
      crossContractCalls,
      broadcasterFeeERC20Recipient,
      sendWithPublicWallet,
      overallBatchMinGasPrice,
      minGasLimit,
      progressCallback,
    ).finally(() => {
      emitCoreEvent({ type: "tx:progress", phase: "prove", pct: 100, message: "Proof complete" });
    });

    const { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList } =
      await populateProvedCrossContractCalls(
        txIDVersion,
        chainName,
        railgunWalletID,
        relayAdaptUnshieldERC20Amounts,
        relayAdaptUnshieldNFTAmounts,
        relayAdaptShieldERC20Addresses,
        relayAdaptShieldNFTRecipients,
        crossContractCalls,
        broadcasterFeeERC20Recipient,
        sendWithPublicWallet,
        overallBatchMinGasPrice,
        estimatedGasDetails,
      );
    // Relay-adapt executes from an ephemeral account under EIP-7702; the
    // populated transaction has to carry the type so ethers and the broadcaster
    // send it as one, authorization list included.
    transaction.type = EVMGasType.Type4;
    return { transaction, nullifiers, preTransactionPOIsPerTxidLeafPerList };
  } catch (err) {
    log.error("proved cross-contract tx failed", err);
    return undefined;
  }
};
