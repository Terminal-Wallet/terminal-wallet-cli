import {
  NetworkName,
  RailgunERC20AmountRecipient,
  TransactionGasDetails,
} from "@railgun-community/shared-models";
import {
  Contract,
  ContractTransaction,
  TransactionResponse,
  formatUnits,
  JsonRpcProvider
} from "ethers";
import { ERC20_ABI } from "../../../abi";
import { promiseTimeout, throwError } from "../../../util/util";
import {
  calculatePublicGasFee,
  getPublicGasDetails,
  getPublicGasEstimate,
} from "../../gas/gas-util";
import {
  getProviderForChain,
  getWrappedTokenInfoForChain,
} from "../../network/network-util";
import { getCurrentWalletPublicAddress } from "../../wallet/wallet-util";
import { PrivateGasEstimate } from "../../../models/transaction-models";
import { createLogger } from "../../../platform/logger";
import {
  ReceiptReader,
  TxSettlement,
  settlementFromReceipt,
} from "./settlement";

export type { TxSettlement } from "./settlement";

const log = createLogger("public-tx");

export const populatePublicERC20Transaction = async (
  erc20AmountRecipient: RailgunERC20AmountRecipient,
) => {
  const { tokenAddress, recipientAddress, amount } = erc20AmountRecipient;
  const contract = new Contract(tokenAddress, ERC20_ABI);
  const transaction: ContractTransaction = await contract.transfer
    .populateTransaction(recipientAddress, amount)
    .catch(throwError);
  return transaction;
};

export type PublicTransactionDetails = {
  privateGasEstimate: PrivateGasEstimate;
  populatedTransaction: ContractTransaction;
};

// need to make sure transaction.from has been set.
export const calculatePublicTransactionGasDetais = async (
  chainName: NetworkName,
  transaction: ContractTransaction,
): Promise<PublicTransactionDetails> => {
  if (!transaction.from) {
    throw new Error("Missing Sender for gas Estimate.");
  }
  const gasEstimate = await getPublicGasEstimate(chainName, transaction);
  const gasDetails = await getPublicGasDetails(chainName, gasEstimate);
  const finalTransaction = { ...transaction, ...gasDetails };
  const gasCostEstimate = await calculatePublicGasFee(finalTransaction);
  const { symbol, decimals } = getWrappedTokenInfoForChain(chainName);
  const formattedCost = parseFloat(formatUnits(gasCostEstimate, decimals));
  return {
    privateGasEstimate: {
      symbol,
      overallBatchMinGasPrice: 0n,
      estimatedGasDetails: gasDetails as TransactionGasDetails,
      estimatedCost: formattedCost,
      broadcasterFeeERC20Recipient: undefined,
    },
    populatedTransaction: finalTransaction,
  };
};

export const populateAndCalculateGasForERC20Transaction = async (
  chainName: NetworkName,
  erc20AmountRecipient: RailgunERC20AmountRecipient,
): Promise<PublicTransactionDetails> => {
  const transaction = await populatePublicERC20Transaction(
    erc20AmountRecipient,
  );
  const fromAddress = getCurrentWalletPublicAddress();
  transaction.from = fromAddress;

  const { privateGasEstimate, populatedTransaction } =
    await calculatePublicTransactionGasDetais(chainName, transaction);

  return { privateGasEstimate, populatedTransaction };
};

/**
 * Whether ethers refused to MODEL a transaction, rather than the chain
 * refusing the transaction.
 *
 * An EIP-7702 (type 0x4) send comes back from some RPCs with the outer
 * signature zeroed — `r`/`s`/`v` all `0x0` — while `yParity` is set, and
 * ethers 6.14 validates the two against each other and throws "yParity
 * mismatch (argument=\"signature\")". Nothing is wrong with the transaction:
 * it is mined, it succeeds, and the authorization inside it carries the real
 * signature. What fails is parsing the description of it.
 *
 * A receipt has no signature fields, so it parses — and a receipt is what
 * "wait" actually means.
 */
const isUnmodellable = (err: unknown): boolean => {
  const { code, message } = (err ?? {}) as { code?: string; message?: string };
  const text = message ?? "";
  // Both, not either. INVALID_ARGUMENT is ethers' code for any bad argument —
  // a malformed hash reaches this same catch — and "signature" appears in
  // messages that are about a real signature. Swallowing those would turn an
  // immediate, accurate error into a three-minute poll for a transaction that
  // does not exist. `yParity` alone is specific enough to stand by itself.
  return (
    (code === "INVALID_ARGUMENT" && /signature|yParity/i.test(text)) ||
    /yParity/i.test(text)
  );
};

export const waitOnTx = async (
  txResponse: TransactionResponse,
  txTimeout: number,
) => {
  await promiseTimeout(
    txResponse.wait().catch(async (err) => {
      if (!isUnmodellable(err)) {
        log.info(err);
        return;
      }
      // Fall through to the receipt rather than giving up on the wait: this is
      // a parse failure, and the caller still wants to know when it lands.
      log.debug("ethers cannot model this response; waiting on the receipt", err);
      await txResponse.provider
        ?.waitForTransaction(txResponse.hash, 1, txTimeout)
        .catch((pollErr) => log.info(pollErr));
    }),
    txTimeout,
  );
};

export const waitForTx = async (
  txResponse: TransactionResponse,
  txTimeout = 3 * 60 * 1000,
): Promise<TxSettlement> => {
  try {
    await waitOnTx(txResponse, txTimeout);
  } catch (err: Error | any) {
    log.error(`Transaction ${txResponse.hash} error: ${err.message}`);
  }
  return settlementFromReceipt(
    txResponse.provider as unknown as ReceiptReader,
    txResponse.hash,
  );
};

export const waitForRelayedTx = async (
  chainName: NetworkName,
  txHash: string,
  txTimeout = 3 * 60 * 1000,
): Promise<TxSettlement> => {
  const provider = getProviderForChain(chainName) as unknown as JsonRpcProvider;
  try {
    let txResponse: TransactionResponse | null = null;
    try {
      txResponse = await provider.getTransaction(txHash);
    } catch (err: unknown) {
      // See isUnmodellable. This used to report a mined 7702 transaction as
      // "Transaction <hash> error: yParity mismatch" and then return WITHOUT
      // waiting for anything — so the alarming line was the lesser half of it.
      if (!isUnmodellable(err)) throw err;
      log.debug("ethers cannot model this transaction; waiting on the receipt", err);
    }

    if (txResponse !== null) {
      await waitOnTx(txResponse, txTimeout);
    } else {
      await promiseTimeout(
        provider.waitForTransaction(txHash, 1, txTimeout),
        txTimeout,
      );
    }
  } catch (err: Error | any) {
    log.error(`Transaction ${txHash} error: ${err.message}`);
  }
  return settlementFromReceipt(
    provider as unknown as ReceiptReader,
    txHash,
  );
};
