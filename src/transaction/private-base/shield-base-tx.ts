import {
  NetworkName,
  RailgunERC20Amount,
  RailgunERC20AmountRecipient,
  TXIDVersion,
  TransactionGasDetails,
} from "@railgun-community/shared-models";
import {
  getShieldPrivateKeySignatureMessage,
  gasEstimateForShieldBaseToken,
  populateShieldBaseToken,
  getCurrentEphemeralWallet,
  EphemeralAccount,
} from "@railgun-community/wallet";
import { Wallet, formatUnits, keccak256 } from "ethers";
import { getWrappedTokenInfoForChain } from "../../network/network-util";
import {
  calculateEstimatedGasCost,
  getPublicGasDetails,
} from "../../gas/gas-util";
import { PrivateGasEstimate } from "../../models/transaction-models";
import { getCurrentShieldPrivateKey } from "../../wallet/public-utils";
import { getCurrentRailgunID } from "../../wallet/wallet-util";
import { syncEphemeralIndexOnce } from "../../wallet/ephemeral-util";

// Base-token shielding now runs through the EIP-7702 relay-adapt path (the legacy
// relay-adapt is being sunset). The wallet SDK only takes the 7702 branch when it is
// handed an EphemeralAccount signer, so derive the wallet's current ephemeral account
// and pass it to both the gas estimate and the populate call.
const getShieldEphemeralAccount = async (
  chainName: NetworkName,
  encryptionKey: string,
): Promise<EphemeralAccount> => {
  // Realign the index with history once per session before deriving, so an imported
  // wallet never reuses a spent ephemeral. The gas estimate and the proof both call this
  // within one operation; the sync is guarded and the index only advances on a successful
  // submission, so both calls resolve to the same (current) ephemeral address.
  await syncEphemeralIndexOnce(chainName, encryptionKey);
  const ephemeralWallet = await getCurrentEphemeralWallet(
    getCurrentRailgunID(),
    encryptionKey,
    chainName,
  );
  return new EphemeralAccount(ephemeralWallet);
};

export const getShieldBaseTokenGasDetails = async (
  chainName: NetworkName,
  wrappedERC20Amount: RailgunERC20AmountRecipient,
  encryptionKey: string,
): Promise<PrivateGasEstimate> => {
  const { shieldPrivateKey, fromWalletAddress } =
    await getCurrentShieldPrivateKey();

  const wrappedInfo = getWrappedTokenInfoForChain(chainName);
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const ephemeralAccount = await getShieldEphemeralAccount(
    chainName,
    encryptionKey,
  );

  const { gasEstimate } = await gasEstimateForShieldBaseToken(
    txIDVersion,
    chainName,
    wrappedERC20Amount.recipientAddress,
    shieldPrivateKey,
    wrappedERC20Amount,
    fromWalletAddress,
    ephemeralAccount,
  );
  const gasDetails = (await getPublicGasDetails(
    chainName,
    gasEstimate,
    true,
  )) as TransactionGasDetails;

  const _estimatedCost = calculateEstimatedGasCost(gasDetails);
  const formattedCost = parseFloat(
    formatUnits(_estimatedCost, wrappedInfo.decimals),
  );

  return {
    symbol: wrappedInfo.symbol,
    overallBatchMinGasPrice: 0n,
    estimatedGasDetails: gasDetails,
    estimatedCost: formattedCost,
    broadcasterFeeERC20Recipient: undefined,
  };
};

export const getProvedShieldBaseTokenTransaction = async (
  chainName: NetworkName,
  wrappedERC20Amount: RailgunERC20AmountRecipient,
  privateGasEstimate: PrivateGasEstimate,
  encryptionKey: string,
) => {
  const { shieldPrivateKey, fromWalletAddress } =
    await getCurrentShieldPrivateKey();
  const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
  const ephemeralAccount = await getShieldEphemeralAccount(
    chainName,
    encryptionKey,
  );

  const { transaction } = await populateShieldBaseToken(
    txIDVersion,
    chainName,
    wrappedERC20Amount.recipientAddress,
    shieldPrivateKey,
    wrappedERC20Amount,
    privateGasEstimate.estimatedGasDetails,
    ephemeralAccount,
  );

  // Public wallet to shield from.
  transaction.from = fromWalletAddress;
  return transaction;
};
