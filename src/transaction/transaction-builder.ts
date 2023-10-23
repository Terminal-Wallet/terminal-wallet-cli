/* eslint-disable no-unsafe-finally */
import "colors";

import {
  NETWORK_CONFIG,
  NetworkName,
  RailgunERC20AmountRecipient,
  SelectedRelayer,
  delay,
  isDefined,
} from "@railgun-community/shared-models";
import { readablePrecision } from "../util/util";
import { getFormattedAddress } from "../ui/address-ui";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "../ui/confirm-ui";
import {
  runFeeTokenSelector,
  tokenAmountSelectionPrompt,
  transferTokenAmountSelectionPrompt,
} from "../ui/token-ui";
import { TransactionResponse, formatUnits } from "ethers";
import {
  clearHashedPassword,
  getSaltedPassword,
} from "../wallet/wallet-password";
import {
  getCurrentEthersWallet,
  getEthersWalletForSigner,
} from "../wallet/public-utils";
import {
  getCurrentRailgunAddress,
  getCurrentWalletGasBalance,
  getCurrentWalletName,
  getCurrentWalletPublicAddress,
  getWalletInfoForName,
  getWalletNames,
} from "../wallet/wallet-util";
import {
  getPrivateTransactionGasEstimate,
  getProvedPrivateTransaction,
  getRelayerTranaction,
} from "./private/private-tx";
import {
  PrivateGasEstimate,
  RailgunTransaction,
} from "../models/transaction-models";
import configDefaults from "../config/config-defaults";
import {
  getProvedUnshieldERC20Transaction,
  getUnshieldERC20TransactionGasEstimate,
} from "./private/unshield-tx";
import {
  getProvedUnshieldBaseTokenTransaction,
  getUnshieldBaseTokenGasEstimate,
} from "./private-base/unshield-base-tx";
import {
  getTransactionURLForChain,
  getRailgunProxyAddressForChain,
  getWrappedTokenInfoForChain,
} from "../network/network-util";
import { getTokenInfo } from "../balance/token-util";
import {
  getPrivateERC20BalanceForChain,
  resetBalanceCachesForChain,
} from "../balance/balance-cache";
import {
  getProvedShieldERC20Transaction,
  getShieldERC20TransactionGasDetails,
} from "./private/shield-tx";
import {
  getProvedShieldBaseTokenTransaction,
  getShieldBaseTokenGasDetails,
} from "./private-base/shield-base-tx";
import {
  calculatePublicTransactionGasDetais,
  populateAndCalculateGasForERC20Transaction,
  waitForRelayedTx,
  waitForTx,
} from "./public/public-tx";
import { populateAndCalculateGasForBaseTokenTransaction } from "./public/public-base-tx";
import { runSwapTokenSelectionPrompt } from "../ui/zer0x-ui";
import {
  calculateGasForPublicSwapTransaction,
  getProvedZer0XSwapTransaction,
  getZer0XSwapInputs,
  getZer0XSwapTransactionGasEstimate,
} from "./zeroX/0x-swap";
import { getCurrentNetwork, rescanBalances } from "../engine/engine";
import { populatePublicERC20ApprovalTransactions } from "./approval-erc20";
import { Zer0XSwapSelectionInfo } from "../models/0x-models";
import {
  RailgunReadableAmount,
  RailgunSelectedAmount,
} from "../models/balance-models";
import {
  resetBalanceScan,
  resetMenuForScan,
  // resetPrivateCache,
} from "../wallet/private-wallet";
import { setStatusText } from "../ui/status-ui";
import { getWrappedTokenBalance } from "../balance/balance-util";
import { clearConsoleBuffer } from "../util/error-util";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, Input } = require("enquirer");

//UTILITY FUNCTIONS
export const getERC20AmountRecipients = (
  amountSelections: RailgunSelectedAmount[],
): RailgunERC20AmountRecipient[] => {
  const amountRecipients = amountSelections.map((info) => {
    const { tokenAddress, selectedAmount: amount, recipientAddress } = info;
    return {
      tokenAddress,
      amount,
      recipientAddress,
    };
  });

  // modify them again, consolidate recipients
  const consolidatedAmounts: RailgunERC20AmountRecipient[] = [];
  const recipientMap: MapType<MapType<RailgunERC20AmountRecipient>> = {};

  amountRecipients.forEach((info) => {
    const { tokenAddress, amount, recipientAddress } = info;

    if (!isDefined(recipientMap[tokenAddress])) {
      recipientMap[tokenAddress] = {};
    }

    if (!isDefined(recipientMap[tokenAddress][recipientAddress])) {
      recipientMap[tokenAddress][recipientAddress] = info;
    } else {
      recipientMap[tokenAddress][recipientAddress].amount += amount;
    }
  });

  for (const tokenAddress in recipientMap) {
    for (const recipientAddress in recipientMap[tokenAddress]) {
      consolidatedAmounts.push(recipientMap[tokenAddress][recipientAddress]);
    }
  }

  return consolidatedAmounts;
};

//TX FUNCTIONS

type SelectChoice = {
  name?: string;
  message?: string;
  role?: string;
  disabled?: boolean;
  hint?: string;
};

const getDisplayTransactions = async (
  erc20Amounts?: RailgunSelectedAmount[] | Zer0XSwapSelectionInfo,
  selectedRelayer?: SelectedRelayer,
  privateGasEstimate?: PrivateGasEstimate,
) => {
  const chainName = getCurrentNetwork();

  const display = [];
  if (!erc20Amounts) {
    return "";
  }

  display.push("=============== TRANSACTION REVIEW ===============".grey);

  if (isDefined((erc20Amounts as Zer0XSwapSelectionInfo).selections)) {
    const { selections, zer0XInputs } = erc20Amounts as Zer0XSwapSelectionInfo;
    const { readableSwapPrices } = zer0XInputs;

    const {
      sellTokenAddress,
      buyTokenAddress,
      symbol: sellTokenSymbol,
      buySymbol: buyTokenSymbol,
    } = selections;

    const {
      price,
      guaranteedPrice,
      sellFee,
      sellAmount,
      buyAmount,
      buyMinimum,
      buyFee,
    } = readableSwapPrices;

    const isPublicSend = sellFee === "0.0";
    const swapType = isPublicSend ? "Public" : "Private";
    const railgunAddress = isPublicSend
      ? getCurrentWalletPublicAddress()
      : getCurrentRailgunAddress();
    const fRailgunAddress = getFormattedAddress(railgunAddress);
    const walletName = getCurrentWalletName();
    const sellHeader = `[${walletName.cyan}] - ${fRailgunAddress.green} ${swapType} Swap`;

    const padLength =
      sellTokenSymbol.length > buyTokenSymbol.length
        ? sellTokenSymbol.length
        : buyTokenSymbol.length;

    const sellInfo = `Selling [${
      sellTokenSymbol.padStart(padLength, " ").cyan
    }] ${sellAmount.yellow}`;
    const buyInfo =
      `Buying  [${buyTokenSymbol.padStart(padLength, " ").cyan}] ${
        buyAmount.yellow
      }\nMin. Recieved: ${buyMinimum.cyan} [${buyTokenSymbol}] ` +
      `(1 [${sellTokenSymbol}] = ${price} [${buyTokenSymbol}])`.grey;
    const feeInfo = `(${sellFee.grey}) [${sellTokenSymbol.grey}] Unshield Fee\n(${buyFee.grey}) [${buyTokenSymbol.grey}] Shield Fee`;
    display.push(sellHeader);
    display.push(sellInfo);
    display.push(buyInfo);
    if (!isPublicSend) {
      display.push(feeInfo);
    }

    display.push(``.padEnd(50, "=*=").grey);
  } else {
    if (isDefined(erc20Amounts)) {
      for (const bal of erc20Amounts as RailgunSelectedAmount[]) {
        const formattedAmount = parseFloat(
          formatUnits(bal.selectedAmount, bal.decimals) ?? "0",
        )
          .toFixed(8)
          .toString().yellow;
        display.push(
          `${formattedAmount} | [${bal.symbol.cyan}] [TO]: ${
            getFormattedAddress(bal.recipientAddress).green
          }`,
        );
      }
    }
    display.push(``.padEnd(50, "=*=").grey);
  }
  if (isDefined(privateGasEstimate)) {
    const formattedRelayerAddress = selectedRelayer
      ? getFormattedAddress(selectedRelayer.railgunAddress)
      : "";

    const selectedRelayerInfo = selectedRelayer
      ? `Selected Relayer:  ${formattedRelayerAddress.cyan}`
      : "";

    display.push(
      `Network Fee: ${
        privateGasEstimate.estimatedCost.toFixed(8).toString().yellow
      } [${privateGasEstimate.symbol.cyan}] ${selectedRelayerInfo}`.green,
    );
    display.push(``.padEnd(50, "=*=").grey);
  }
  return display.join("\n") + "\n";
};

const getSelfSignerWalletPrompt = async () => {
  const walletNames = getWalletNames().map((i) => {
    return { name: i, message: i };
  });

  const signerSelection = new Select({
    message: "Select Self Signing Wallet",
    choices: walletNames,
  });
  const result = await signerSelection.run().catch(confirmPromptCatch);

  if (!result) {
    return;
  }

  return getWalletInfoForName(result);
};

const bgWatchRelayedTx = async (chainName: NetworkName, txHash: string) => {
  await waitForRelayedTx(chainName, txHash);
  const blockScanURL = getTransactionURLForChain(chainName, txHash);
  setStatusText(`Transaction Mined: ${blockScanURL} `.yellow);
};

const bgWatchSelfSignedTx = async (
  chainName: NetworkName,
  txResult: TransactionResponse,
) => {
  const { hash } = txResult;
  await waitForTx(txResult);
  const blockScanURL = getTransactionURLForChain(chainName, hash);
  setStatusText(`Transaction Mined: ${blockScanURL} `.yellow);
};

const txScanReset = () => {
  resetBalanceScan();
  // resetPrivateCache();
};

const sendRelayedTransaction = async (
  transactionType: RailgunTransaction,
  provedTransaction: any,
  relayerSelection: any,
  chainName: NetworkName,
) => {
  const useRelayAdapt =
    transactionType === RailgunTransaction.UnshieldBase ||
    transactionType === RailgunTransaction.Private0XSwap;
  const finalTransaction = await getRelayerTranaction(
    {
      ...provedTransaction,
      feesID: relayerSelection.tokenFee.feesID,
      selectedRelayerAddress: relayerSelection.railgunAddress,
    },
    chainName,
    useRelayAdapt,
  );

  console.log(
    "Submitting Relayed Transaction... Responses may take up to (1) one minute."
      .yellow,
  );
  const sendResult = await finalTransaction.send();
  const blockScanURL = getTransactionURLForChain(chainName, sendResult);
  setStatusText(`Waiting on TX to be Mined : ${blockScanURL} `.yellow);

  bgWatchRelayedTx(chainName, sendResult);
  txScanReset();

  return sendResult;
};

const sendSelfSignedTransaction = async (
  selfSignerInfo: any,
  chainName: NetworkName,
  provedTransaction: any,
) => {
  const ethersWallet = await getEthersWalletForSigner(
    selfSignerInfo,
    chainName,
  );
  const { transaction: innerTransaction } = provedTransaction;
  if (isDefined(innerTransaction)) {
    const txResult = await ethersWallet.sendTransaction(innerTransaction);

    const blockScanURL = getTransactionURLForChain(chainName, txResult.hash);
    setStatusText(`Waiting on TX to be Mined : ${blockScanURL} `.yellow);

    bgWatchSelfSignedTx(chainName, txResult);
    txScanReset();
    return txResult;
  } else {
    if (isDefined(provedTransaction)) {
      const txResult = await ethersWallet.sendTransaction(provedTransaction);
      const blockScanURL = getTransactionURLForChain(chainName, txResult.hash);
      setStatusText(`Waiting on TX to be Mined : ${blockScanURL} `.yellow);

      bgWatchSelfSignedTx(chainName, txResult);
      txScanReset();
      return txResult;
    }
  }
};

export const runTransactionBuilder = async (
  chainName: NetworkName,
  transactionType: RailgunTransaction,
  resultObj?: any,
): Promise<any> => {
  const {
    confirmAmountsDisabled,
    selections,
    swapSelections,
    selectFeesDisabled,
    incomingHeader,
    encryptionKey,
    relayerSelection,
    privateGasEstimate,
    generateProofDisabled,
    sendTransactionDisabled,
    provedTransaction,
    selfSignerInfo,
  } = resultObj ?? {
    confirmAmountsDisabled: undefined,
    selectFeesDisabled: undefined,
    selections: undefined,
    swapSelections: undefined,
    incomingHeader: undefined,
    encryptionKey: undefined,
    relayerSelection: undefined,
    privateGasEstimate: undefined,
    generateProofDisabled: undefined,
    sendTransactionDisabled: undefined,
    provedTransaction: undefined,
    selfSignerInfo: undefined,
  };
  if (!isDefined(resultObj)) {
    clearConsoleBuffer();
  }
  const choices: SelectChoice[] = [];

  if (confirmAmountsDisabled === false) {
    choices.push({
      name: "confirm-amounts",
      message: "Confirm Transaction Amounts".yellow,
      disabled: confirmAmountsDisabled ?? true,
    });
  }

  const isShieldProof =
    transactionType === RailgunTransaction.Shield ||
    transactionType === RailgunTransaction.ShieldBase;

  if (generateProofDisabled === false) {
    choices.push({
      name: "generate-proof",
      message: isShieldProof
        ? "Sign Shield Transaction".yellow
        : "Generate Proof".yellow,
      disabled: generateProofDisabled ?? true,
    });
  }

  const hasRelayerInfo =
    isDefined(relayerSelection) || isDefined(selfSignerInfo);

  if (selectFeesDisabled === false) {
    choices.push({
      name: "select-fee",
      message: hasRelayerInfo
        ? `Edit Relayer FeeToken / Self Signer | (Refresh Gas Estimate)`
        : `Select Relayer FeeToken / Self Signer`.yellow,
      disabled: selectFeesDisabled ?? true,
    });
  }

  const isSwapTransaction =
    transactionType === RailgunTransaction.Private0XSwap ||
    transactionType === RailgunTransaction.Public0XSwap;

  const isUnShieldTransaction =
    transactionType === RailgunTransaction.ShieldBase ||
    transactionType === RailgunTransaction.UnshieldBase;

  const hasSelectionInfo = isDefined(selections) || isDefined(swapSelections);
  const selectOption = hasSelectionInfo ? "Edit" : "Select";
  const regularSelectText = isUnShieldTransaction
    ? `${selectOption} Amount & Recipient`
    : `${selectOption} Token(s) / Amount / Recipient(s)`;

  choices.push({
    name: "select-edit",
    message: isSwapTransaction
      ? hasSelectionInfo
        ? "Edit SWAP Details"
        : "Select SWAP Details".yellow
      : hasSelectionInfo
      ? regularSelectText
      : regularSelectText.yellow,
  });

  if (sendTransactionDisabled === false) {
    choices.push({
      message: ``.padEnd(50, "=*=").grey,
      role: "separator",
    });
    choices.push({
      name: "send-transaction",
      message: "Send Transaction".yellow,
      disabled: sendTransactionDisabled ?? true,
    });
  }

  choices.push({
    name: "exit-menu",
    message: "Cancel Transaction".grey,
  });

  console.log("");

  const prompt = new Select({
    message: `Send ${transactionType} Transaction`,
    choices: choices,
    header: incomingHeader ?? " ",
    format() {
      return "";
    },
  });
  const result = await prompt.run().catch(confirmPromptCatch);

  if (!result) {
    return;
  }

  let header = await getDisplayTransactions(
    selections,
    relayerSelection,
    privateGasEstimate,
  );

  switch (result) {
    case "select-edit": {
      clearHashedPassword();

      const selectionFound =
        transactionType === RailgunTransaction.Private0XSwap ||
        transactionType === RailgunTransaction.Public0XSwap
          ? !isDefined(swapSelections)
          : !isDefined(selections);

      if (selectionFound) {
        let selection;
        let swapSelection;
        let populatedApprovalTransactions;
        try {
          switch (transactionType) {
            case RailgunTransaction.Transfer: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
              );
              selection = _selection;
              break;
            }
            case RailgunTransaction.Unshield: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
                false,
                true,
                true,
                true,
              );
              selection = _selection;
              break;
            }
            case RailgunTransaction.Shield: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
                true,
                false,
                false,
                true,
              );
              selection = _selection;

              const tokensToApprove = selection.amountSelections.map(
                ({
                  tokenAddress,
                  recipientAddress,
                  selectedAmount: amount,
                }) => {
                  return { tokenAddress, amount, recipientAddress };
                },
              );

              if (isDefined(tokensToApprove)) {
                const spender = getRailgunProxyAddressForChain(chainName);
                populatedApprovalTransactions =
                  await populatePublicERC20ApprovalTransactions(
                    chainName,
                    tokensToApprove,
                    getCurrentWalletPublicAddress(),
                    spender,
                  );

                if (populatedApprovalTransactions.length > 0) {
                  let approvalsLeft = populatedApprovalTransactions.length;
                  for (const approvalTransaction of populatedApprovalTransactions) {
                    const ethersWallet = getCurrentEthersWallet();
                    const {
                      privateGasEstimate: gasEstimate,
                      populatedTransaction,
                    } = await calculatePublicTransactionGasDetais(
                      chainName,
                      approvalTransaction.populatedTransaction,
                    );

                    const sendPublicTransaction = await confirmPrompt(
                      `CONFIRM | APPROVE ${spender.cyan} for [${
                        approvalTransaction.symbol.cyan
                      }]? It will cost: ${
                        gasEstimate.estimatedCost.toString().green
                      } [${gasEstimate.symbol.cyan}]`,
                    );
                    if (sendPublicTransaction) {
                      const txResult = await ethersWallet.sendTransaction(
                        populatedTransaction,
                      );
                      await bgWatchSelfSignedTx(chainName, txResult);
                      approvalsLeft -= 1;
                    }
                  }
                  if (approvalsLeft !== 0) {
                    console.log("APPROVALS NOT COMPLETED".yellow);
                    selection = undefined;
                    break;
                  }
                  console.log("APPROVALS COMPLETED".green);
                }
              }

              break;
            }
            case RailgunTransaction.UnshieldBase: {
              // run token Amount Selection for WETH.
              const wrappedReadableAmount: RailgunReadableAmount =
                await getWrappedTokenBalance(chainName);
              const amountSelection = await tokenAmountSelectionPrompt(
                [wrappedReadableAmount],
                true,
                true,
                true,
              );
              selection = { amountSelections: amountSelection };
              break;
            }
            case RailgunTransaction.ShieldBase: {
              const wrappedReadableAmount: RailgunReadableAmount =
                await getWrappedTokenBalance(chainName, true);
              const amountSelection = await tokenAmountSelectionPrompt(
                [wrappedReadableAmount],
                false,
                true,
                true,
              );
              selection = { amountSelections: amountSelection };
              break;
            }
            case RailgunTransaction.PublicTransfer: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
                true,
                true,
                true,
              );
              selection = _selection;
              break;
            }
            case RailgunTransaction.PublicBaseTransfer: {
              const wrappedReadableAmount: RailgunReadableAmount =
                await getWrappedTokenBalance(chainName, true);
              const amountSelection = await tokenAmountSelectionPrompt(
                [wrappedReadableAmount],
                true,
                true,
              );
              selection = { amountSelections: amountSelection };
              break;
            }
            case RailgunTransaction.Public0XSwap:
            case RailgunTransaction.Private0XSwap: {
              const _swapSelections = await runSwapTokenSelectionPrompt(
                chainName,
                transactionType === RailgunTransaction.Public0XSwap,
              );

              if (isDefined(_swapSelections)) {
                const {
                  sellTokenAddress,
                  buyTokenAddress,
                  amount,
                  symbol,
                  buySymbol,
                } = _swapSelections;

                const wrappedInfo = getWrappedTokenInfoForChain(chainName);

                const sellTokenInput = {
                  tokenAddress: sellTokenAddress,
                  isBaseToken: wrappedInfo.symbol === symbol,
                };

                const buyTokenInput = {
                  tokenAddress: buyTokenAddress,
                  isBaseToken: wrappedInfo.symbol === buySymbol,
                };

                const zer0XInputs = await getZer0XSwapInputs(
                  chainName,
                  sellTokenInput,
                  buyTokenInput,
                  amount,
                  0.032,
                  transactionType === RailgunTransaction.Public0XSwap,
                );
                if (!isDefined(zer0XInputs) || !isDefined(zer0XInputs.quote)) {
                  break;
                }
                if (
                  transactionType === RailgunTransaction.Public0XSwap &&
                  !sellTokenInput.isBaseToken
                ) {
                  populatedApprovalTransactions =
                    await populatePublicERC20ApprovalTransactions(
                      chainName,
                      [
                        {
                          tokenAddress: sellTokenInput.tokenAddress,
                          amount,
                          recipientAddress: "",
                        },
                      ],
                      getCurrentWalletPublicAddress(),
                      zer0XInputs.quote.spender,
                    );
                  if (populatedApprovalTransactions.length > 0) {
                    let approvalsLeft = populatedApprovalTransactions.length;
                    for (const approvalTransaction of populatedApprovalTransactions) {
                      const ethersWallet = getCurrentEthersWallet();
                      const {
                        privateGasEstimate: gasEstimate,
                        populatedTransaction,
                      } = await calculatePublicTransactionGasDetais(
                        chainName,
                        approvalTransaction.populatedTransaction,
                      );
                      const sendPublicTransaction = await confirmPrompt(
                        `CONFIRM | APPROVE ${
                          zer0XInputs.quote?.spender?.cyan
                        } for [${symbol.cyan}]? It will cost: ${
                          gasEstimate.estimatedCost.toString().green
                        } [${gasEstimate.symbol.cyan}]`,
                      );
                      if (sendPublicTransaction) {
                        const txResult = await ethersWallet.sendTransaction(
                          populatedTransaction,
                        );
                        await bgWatchSelfSignedTx(chainName, txResult);
                        approvalsLeft -= 1;
                      }
                    }
                    if (approvalsLeft !== 0) {
                      console.log("APPROVALS NOT COMPLETED".yellow);
                      break;
                    }
                    console.log("APPROVALS COMPLETED".green);
                  }
                }
                swapSelection = {
                  selections: _swapSelections,
                  zer0XInputs,
                };
              }
              break;
            }
          }
        } catch (err) {
          const error = err as Error;
          console.log("ERROR Selecting", error.message);
        } finally {
          if (
            transactionType === RailgunTransaction.Private0XSwap ||
            transactionType === RailgunTransaction.Public0XSwap
          ) {
            header = "";
            if (isDefined(swapSelection)) {
              header = (await getDisplayTransactions(swapSelection)) ?? "";
            }
            return runTransactionBuilder(chainName, transactionType, {
              swapSelections: swapSelection,
              confirmAmountsDisabled: swapSelection ? false : true,
              selectFeesDisabled: true,
              incomingHeader: header,
            });
          }

          let foundSelections;
          if (isDefined(selection)) {
            const { amountSelections } = selection;

            if (amountSelections.length > 0) {
              foundSelections = amountSelections;
            }
          }

          header = "";
          if (isDefined(foundSelections)) {
            header = await getDisplayTransactions(foundSelections);
          }

          return runTransactionBuilder(chainName, transactionType, {
            selections: foundSelections,
            confirmAmountsDisabled: foundSelections ? false : true,
            selectFeesDisabled: true,
            incomingHeader: header,
          });
        }
      } else {
        let selection;
        let swapSelection;
        let populatedApprovalTransactions;

        try {
          switch (transactionType) {
            case RailgunTransaction.Transfer: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
              );
              selection = _selection;
              break;
            }
            case RailgunTransaction.Unshield: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
                false,
                true,
                true,
                true,
              );
              selection = _selection;
              break;
            }
            case RailgunTransaction.Shield: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
                true,
                false,
                false,
                true,
              );
              selection = _selection;

              const tokensToApprove = selection.amountSelections.map(
                ({
                  tokenAddress,
                  recipientAddress,
                  selectedAmount: amount,
                }) => {
                  return { tokenAddress, amount, recipientAddress };
                },
              );

              if (isDefined(tokensToApprove)) {
                const spender = getRailgunProxyAddressForChain(chainName);
                populatedApprovalTransactions =
                  await populatePublicERC20ApprovalTransactions(
                    chainName,
                    tokensToApprove,
                    getCurrentWalletPublicAddress(),
                    spender,
                  );
                if (populatedApprovalTransactions.length > 0) {
                  let approvalsLeft = populatedApprovalTransactions.length;
                  for (const approvalTransaction of populatedApprovalTransactions) {
                    const ethersWallet = getCurrentEthersWallet();
                    const {
                      privateGasEstimate: gasEstimate,
                      populatedTransaction,
                    } = await calculatePublicTransactionGasDetais(
                      chainName,
                      approvalTransaction.populatedTransaction,
                    );
                    const sendPublicTransaction = await confirmPrompt(
                      `CONFIRM | APPROVE ${spender.cyan} for [${
                        approvalTransaction.symbol.cyan
                      }]? It will cost: ${
                        gasEstimate.estimatedCost.toString().green
                      } [${gasEstimate.symbol.cyan}]`,
                    );
                    if (sendPublicTransaction) {
                      const txResult = await ethersWallet.sendTransaction(
                        populatedTransaction,
                      );
                      await bgWatchSelfSignedTx(chainName, txResult);
                      approvalsLeft -= 1;
                    }
                  }
                  if (approvalsLeft !== 0) {
                    console.log("APPROVALS NOT COMPLETED".yellow);
                    selection = undefined;
                    break;
                  }
                  console.log("APPROVALS COMPLETED".green);
                }
              }

              break;
            }
            case RailgunTransaction.UnshieldBase: {
              // run token Amount Selection for WETH.
              const wrappedReadableAmount: RailgunReadableAmount =
                await getWrappedTokenBalance(chainName);
              const amountSelection = await tokenAmountSelectionPrompt(
                [wrappedReadableAmount],
                true,
                true,
                true,
              );
              selection = { amountSelections: amountSelection };
              break;
            }
            case RailgunTransaction.ShieldBase: {
              const wrappedReadableAmount: RailgunReadableAmount =
                await getWrappedTokenBalance(chainName, true);
              const amountSelection = await tokenAmountSelectionPrompt(
                [wrappedReadableAmount],
                false,
                true,
                true,
              );
              selection = { amountSelections: amountSelection };
              break;
            }
            case RailgunTransaction.PublicTransfer: {
              const _selection = await transferTokenAmountSelectionPrompt(
                chainName,
                true,
                true,
                true,
              );
              selection = _selection;
              break;
            }
            case RailgunTransaction.PublicBaseTransfer: {
              const wrappedReadableAmount: RailgunReadableAmount =
                await getWrappedTokenBalance(chainName, true);
              const amountSelection = await tokenAmountSelectionPrompt(
                [wrappedReadableAmount],
                true,
                true,
              );
              selection = { amountSelections: amountSelection };
              break;
            }
            case RailgunTransaction.Public0XSwap:
            case RailgunTransaction.Private0XSwap: {
              const _swapSelections = await runSwapTokenSelectionPrompt(
                chainName,
                transactionType === RailgunTransaction.Public0XSwap,
              );

              if (isDefined(_swapSelections)) {
                const wrappedInfo = getWrappedTokenInfoForChain(chainName);

                const {
                  sellTokenAddress,
                  buyTokenAddress,
                  amount,
                  symbol,
                  buySymbol,
                } = _swapSelections;

                const sellTokenInput = {
                  tokenAddress: sellTokenAddress,
                  isBaseToken: wrappedInfo.symbol === symbol,
                };

                const buyTokenInput = {
                  tokenAddress: buyTokenAddress,
                  isBaseToken: wrappedInfo.symbol === buySymbol,
                };

                const zer0XInputs = await getZer0XSwapInputs(
                  chainName,
                  sellTokenInput,
                  buyTokenInput,
                  amount,
                  0.032,
                  transactionType === RailgunTransaction.Public0XSwap,
                );
                if (!isDefined(zer0XInputs) || !isDefined(zer0XInputs.quote)) {
                  break;
                }
                if (
                  transactionType === RailgunTransaction.Public0XSwap &&
                  !sellTokenInput.isBaseToken
                ) {
                  populatedApprovalTransactions =
                    await populatePublicERC20ApprovalTransactions(
                      chainName,
                      [
                        {
                          tokenAddress: sellTokenInput.tokenAddress,
                          amount,
                          recipientAddress: "",
                        },
                      ],
                      getCurrentWalletPublicAddress(),
                      zer0XInputs.quote.spender,
                    );
                  if (populatedApprovalTransactions.length > 0) {
                    let approvalsLeft = populatedApprovalTransactions.length;
                    for (const approvalTransaction of populatedApprovalTransactions) {
                      const ethersWallet = getCurrentEthersWallet();
                      const {
                        privateGasEstimate: gasEstimate,
                        populatedTransaction,
                      } = await calculatePublicTransactionGasDetais(
                        chainName,
                        approvalTransaction.populatedTransaction,
                      );
                      const sendPublicTransaction = await confirmPrompt(
                        `CONFIRM | APPROVE ${
                          zer0XInputs.quote?.spender?.cyan
                        } for [${symbol.cyan}]? It will cost: ${
                          gasEstimate.estimatedCost.toString().green
                        } [${gasEstimate.symbol.cyan}]`,
                      );
                      if (sendPublicTransaction) {
                        const txResult = await ethersWallet.sendTransaction(
                          populatedTransaction,
                        );
                        await bgWatchSelfSignedTx(chainName, txResult);
                        approvalsLeft -= 1;
                      }
                    }
                    if (approvalsLeft !== 0) {
                      console.log("APPROVALS NOT COMPLETED".yellow);
                      break;
                    }
                    console.log("APPROVALS COMPLETED".green);
                  }
                }
                swapSelection = {
                  selections: _swapSelections,
                  zer0XInputs,
                };
              }
              break;
            }
          }
        } catch (err) {
          const error = err as Error;
          console.log("We had an error", error.message);
        } finally {
          if (
            transactionType === RailgunTransaction.Private0XSwap ||
            transactionType === RailgunTransaction.Public0XSwap
          ) {
            header = "";
            if (isDefined(swapSelection)) {
              header = (await getDisplayTransactions(swapSelection)) ?? "";
            }
            const newSwapSelection = swapSelection ?? swapSelections;
            return runTransactionBuilder(chainName, transactionType, {
              swapSelections: swapSelection ?? swapSelections,
              confirmAmountsDisabled: newSwapSelection ? false : true,
              selectFeesDisabled: true,
              incomingHeader: header !== "" ? header : incomingHeader,
            });
          }
          let foundSelections;
          if (isDefined(selection)) {
            const { amountSelections } = selection;
            if (amountSelections.length > 0) {
              foundSelections = amountSelections;
            }
          }
          const finalSelections = foundSelections ?? selections;
          header = "";
          if (isDefined(foundSelections)) {
            header = await getDisplayTransactions(finalSelections);
          }

          return runTransactionBuilder(chainName, transactionType, {
            selections: finalSelections,
            confirmAmountsDisabled: finalSelections ? false : true,
            selectFeesDisabled: true,
            encryptionKey,
            incomingHeader: header !== "" ? header : incomingHeader,
          });
        }
      }
    }
    case "confirm-amounts": {
      const password = await getSaltedPassword();

      if (!isDefined(password)) {
        const nonConfirmedObj = {
          selections,
          swapSelections,
          confirmAmountsDisabled: false,
          selectFeesDisabled: true,
          incomingHeader: header !== "" ? header : incomingHeader,
        };

        return runTransactionBuilder(
          chainName,
          transactionType,
          nonConfirmedObj,
        );
      }
      let newRefObj = resultObj;
      try {
        switch (transactionType) {
          case RailgunTransaction.Transfer:
          case RailgunTransaction.Unshield:
          case RailgunTransaction.UnshieldBase: {
            newRefObj = {
              selections,
              confirmAmountsDisabled: true,
              selectFeesDisabled: false,
              encryptionKey: password,
              incomingHeader: header !== "" ? header : incomingHeader,
            };
            break;
          }
          case RailgunTransaction.Shield: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            const gasEstimate = await getShieldERC20TransactionGasDetails(
              chainName,
              erc20AmountRecipients,
            );
            header = await getDisplayTransactions(
              selections,
              relayerSelection,
              gasEstimate,
            );
            newRefObj = {
              selections,
              confirmAmountsDisabled: gasEstimate ? true : false,
              selectFeesDisabled: true,
              privateGasEstimate: gasEstimate,
              generateProofDisabled: gasEstimate ? false : true,
              encryptionKey: password,
              incomingHeader: header !== "" ? header : incomingHeader,
              selfSignerInfo: getWalletInfoForName(getCurrentWalletName()),
            };
            break;
          }
          case RailgunTransaction.ShieldBase: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            const gasEstimate = await getShieldBaseTokenGasDetails(
              chainName,
              erc20AmountRecipients[0],
            );
            header = await getDisplayTransactions(
              selections,
              relayerSelection,
              gasEstimate,
            );
            newRefObj = {
              selections,
              confirmAmountsDisabled: gasEstimate ? true : false,
              selectFeesDisabled: true,
              privateGasEstimate: gasEstimate,
              generateProofDisabled: gasEstimate ? false : true,
              encryptionKey: password,
              incomingHeader: header !== "" ? header : incomingHeader,
              selfSignerInfo: getWalletInfoForName(getCurrentWalletName()),
            };
            break;
          }
          case RailgunTransaction.PublicTransfer: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);

            const { privateGasEstimate: gasEstimate, populatedTransaction } =
              await populateAndCalculateGasForERC20Transaction(
                chainName,
                erc20AmountRecipients[0],
              );

            header = await getDisplayTransactions(
              selections,
              relayerSelection,
              gasEstimate,
            );
            newRefObj = {
              selections,
              confirmAmountsDisabled: gasEstimate ? true : false,
              selectFeesDisabled: true,
              privateGasEstimate: gasEstimate,
              generateProofDisabled: true,
              sendTransactionDisabled: populatedTransaction ? false : true,
              provedTransaction: populatedTransaction,
              encryptionKey: password,
              incomingHeader: header !== "" ? header : incomingHeader,
              selfSignerInfo: getWalletInfoForName(getCurrentWalletName()),
            };
            break;
          }
          case RailgunTransaction.PublicBaseTransfer: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            const { privateGasEstimate: gasEstimate, populatedTransaction } =
              await populateAndCalculateGasForBaseTokenTransaction(
                chainName,
                erc20AmountRecipients[0],
              );
            header = await getDisplayTransactions(
              selections,
              relayerSelection,
              gasEstimate,
            );
            newRefObj = {
              selections,
              confirmAmountsDisabled: gasEstimate ? true : false,
              selectFeesDisabled: true,
              privateGasEstimate: gasEstimate,
              generateProofDisabled: true,
              sendTransactionDisabled: populatedTransaction ? false : true,
              provedTransaction: populatedTransaction,
              encryptionKey: password,
              incomingHeader: header !== "" ? header : incomingHeader,
              selfSignerInfo: getWalletInfoForName(getCurrentWalletName()),
            };
            break;
          }
          case RailgunTransaction.Private0XSwap: {
            newRefObj = {
              selections,
              swapSelections,
              confirmAmountsDisabled: true,
              selectFeesDisabled: false,
              encryptionKey: password,
              incomingHeader: header !== "" ? header : incomingHeader,
            };
            break;
          }
          case RailgunTransaction.Public0XSwap: {
            const { privateGasEstimate: gasEstimate, populatedTransaction } =
              await calculateGasForPublicSwapTransaction(
                chainName,
                swapSelections.zer0XInputs.quote.crossContractCall,
              );
            header = await getDisplayTransactions(
              swapSelections,
              relayerSelection,
              gasEstimate,
            );
            newRefObj = {
              selections,
              swapSelections,
              confirmAmountsDisabled: gasEstimate ? true : false,
              selectFeesDisabled: true,
              privateGasEstimate: gasEstimate,
              generateProofDisabled: true,
              sendTransactionDisabled: populatedTransaction ? false : true,
              provedTransaction: populatedTransaction,
              encryptionKey: password,
              incomingHeader: header !== "" ? header : incomingHeader,
              selfSignerInfo: getWalletInfoForName(getCurrentWalletName()),
            };
            break;
          }
        }
      } catch (err) {
        const error = err as Error;
        console.log("We had an error", error.message);
      } finally {
        return runTransactionBuilder(chainName, transactionType, newRefObj);
      }
    }
    case "select-fee": {
      let _relayerSelection;
      let _bestRelayer;
      let _selfSignerInfo;
      let _privateGasEstimate;
      try {
        let amountRecipients: RailgunERC20AmountRecipient[] = [];

        if (isDefined(selections)) {
          amountRecipients = getERC20AmountRecipients(selections);
        }
        if (isDefined(swapSelections)) {
          const { sellTokenAddress, amount, symbol } =
            swapSelections.selections;
          amountRecipients = [
            {
              tokenAddress: sellTokenAddress,
              amount,
              recipientAddress: "",
            },
          ];
        }

        _relayerSelection = await runFeeTokenSelector(
          chainName,
          amountRecipients,
          relayerSelection,
        ).catch((err) => {
          console.log(err.message);
          if (err.message === "Going back to previous menu.") {
            console.log("going back found");
            return {
              bestRelayer: relayerSelection,
            };
          } else {
            console.log(err.message);
            throw new Error(err.message);
          }
        });
        _bestRelayer = _relayerSelection?.bestRelayer;
        if (!_bestRelayer) {
          _selfSignerInfo = await getSelfSignerWalletPrompt();
        }

        // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
        switch (transactionType) {
          case RailgunTransaction.Transfer: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            _privateGasEstimate = await getPrivateTransactionGasEstimate(
              chainName,
              erc20AmountRecipients,
              encryptionKey,
              _bestRelayer,
            );
            break;
          }
          case RailgunTransaction.Unshield: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            _privateGasEstimate = await getUnshieldERC20TransactionGasEstimate(
              chainName,
              erc20AmountRecipients,
              encryptionKey,
              _bestRelayer,
            );
            break;
          }
          case RailgunTransaction.UnshieldBase: {
            // run token Amount Selection for WETH.
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            // eslint-disable-next-line prefer-destructuring
            const wrappedERC20Amount = erc20AmountRecipients[0];

            _privateGasEstimate = await getUnshieldBaseTokenGasEstimate(
              chainName,
              wrappedERC20Amount,
              encryptionKey,
              _bestRelayer,
            );
            break;
          }
          case RailgunTransaction.Private0XSwap: {
            _privateGasEstimate = await getZer0XSwapTransactionGasEstimate(
              chainName,
              swapSelections.zer0XInputs,
              encryptionKey,
              _bestRelayer,
            );
            break;
          }
        }
      } catch (err) {
        const error = err as Error;
        console.log(error.message);
      } finally {
        if (isDefined(swapSelections)) {
          header =
            (await getDisplayTransactions(
              swapSelections,
              _bestRelayer,
              _privateGasEstimate,
            )) ?? "";
        } else {
          header = await getDisplayTransactions(
            selections,
            _bestRelayer,
            _privateGasEstimate,
          );
        }
        if (_bestRelayer) {
          return runTransactionBuilder(chainName, transactionType, {
            selections,
            swapSelections,
            confirmAmountsDisabled: true,
            selectFeesDisabled: false,
            encryptionKey,
            incomingHeader: header !== "" ? header : incomingHeader,
            relayerSelection: _bestRelayer,
            privateGasEstimate: _privateGasEstimate,
            generateProofDisabled: _privateGasEstimate ? false : true,
          });
        } else {
          const newPrivateGasEstimate =
            _privateGasEstimate ?? privateGasEstimate;
          const newSelfSignerInfo = _selfSignerInfo ?? selfSignerInfo;
          return runTransactionBuilder(chainName, transactionType, {
            selections,
            swapSelections,
            confirmAmountsDisabled: true,
            selectFeesDisabled: false,
            encryptionKey,
            incomingHeader: header !== "" ? header : incomingHeader,
            privateGasEstimate: newPrivateGasEstimate,
            generateProofDisabled: newPrivateGasEstimate ? false : true,
            selfSignerInfo: newSelfSignerInfo,
          });
        }
      }
    }
    case "generate-proof": {
      let _provedTransaction;

      try {
        // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
        switch (transactionType) {
          case RailgunTransaction.Transfer: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            _provedTransaction = await getProvedPrivateTransaction(
              encryptionKey,
              erc20AmountRecipients,
              privateGasEstimate,
            );
            break;
          }
          case RailgunTransaction.Unshield: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            _provedTransaction = await getProvedUnshieldERC20Transaction(
              encryptionKey,
              erc20AmountRecipients,
              privateGasEstimate,
            );
            break;
          }
          case RailgunTransaction.Shield: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            _provedTransaction = await getProvedShieldERC20Transaction(
              chainName,
              erc20AmountRecipients,
              privateGasEstimate,
            );
            break;
          }
          case RailgunTransaction.UnshieldBase: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            _provedTransaction = await getProvedUnshieldBaseTokenTransaction(
              encryptionKey,
              erc20AmountRecipients[0],
              privateGasEstimate,
            );
            break;
          }
          case RailgunTransaction.ShieldBase: {
            const erc20AmountRecipients = getERC20AmountRecipients(selections);
            _provedTransaction = await getProvedShieldBaseTokenTransaction(
              chainName,
              erc20AmountRecipients[0],
              privateGasEstimate,
            );
            break;
          }
          case RailgunTransaction.Private0XSwap: {
            //
            _provedTransaction = await getProvedZer0XSwapTransaction(
              encryptionKey,
              swapSelections.zer0XInputs,
              privateGasEstimate,
            );
            break;
          }
        }
      } catch (err) {
        const error = err as Error;
        console.log("We had an error", error.message);
      } finally {
        const transactionTypeMet =
          transactionType === RailgunTransaction.ShieldBase ||
          transactionType === RailgunTransaction.Shield;

        const setConfirmAmountsDisabled = transactionTypeMet
          ? true
          : _provedTransaction
          ? true
          : false;
        const setSelectFeesDisabled = transactionTypeMet ? true : false;
        header = "";
        if (isDefined(swapSelections)) {
          header =
            (await getDisplayTransactions(
              swapSelections,
              relayerSelection,
              privateGasEstimate,
            )) ?? "";
        } else {
          header = await getDisplayTransactions(
            selections,
            relayerSelection,
            privateGasEstimate,
          );
        }
        return runTransactionBuilder(chainName, transactionType, {
          selections,
          swapSelections,
          confirmAmountsDisabled: setConfirmAmountsDisabled,
          selectFeesDisabled: setSelectFeesDisabled,
          generateProofDisabled: _provedTransaction ? true : false,
          sendTransactionDisabled: _provedTransaction ? false : true,
          encryptionKey,
          incomingHeader: header !== "" ? header : incomingHeader,
          relayerSelection,
          privateGasEstimate,
          provedTransaction: _provedTransaction,
          selfSignerInfo,
        });
      }

      break;
    }
    case "send-transaction": {
      if (provedTransaction) {
        try {
          if (relayerSelection) {
            // RELAYED TRANSACTIONS
            // RELAY ADAPT USED FOR:
            // unshield-base
            // swaps
            // cookbook stuff

            return await sendRelayedTransaction(
              transactionType,
              provedTransaction,
              relayerSelection,
              chainName,
            );
          } else {
            // SELF SIGNED TRANSACTIONS
            return await sendSelfSignedTransaction(
              selfSignerInfo,
              chainName,
              provedTransaction,
            );
          }
        } catch (error) {
          console.log((error as Error).message);

          await confirmPromptCatchRetry("");

          return runTransactionBuilder(chainName, transactionType, {
            selections,
            swapSelections,
            confirmAmountsDisabled: true,
            selectFeesDisabled,
            generateProofDisabled: false,
            sendTransactionDisabled: true,
            encryptionKey,
            incomingHeader,
            relayerSelection,
            privateGasEstimate,
            selfSignerInfo,
            // provedTransaction,
          });
        }
      }
      break;
    }
    case "exit-menu": {
      break;
    }
  }
  return undefined;
};

