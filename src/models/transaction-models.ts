import {
  RailgunERC20AmountRecipient,
  TransactionGasDetails,
  FeeTokenDetails,
} from "@railgun-community/shared-models";
import { ERC20Token } from "./token-models";

export type PrivateGasEstimate = {
  symbol: string;
  estimatedGasDetails: TransactionGasDetails;
  estimatedCost: number;
  broadcasterFeeERC20Recipient: Optional<RailgunERC20AmountRecipient>;
  overallBatchMinGasPrice: Optional<bigint>;
};

export type PrivateGasDetails = {
  originalGasDetails: TransactionGasDetails;
  sendWithPublicWallet: boolean;
  feeTokenDetails: FeeTokenDetails | undefined;
  feeTokenInfo: ERC20Token;
  overallBatchMinGasPrice: Optional<bigint>;
};

export enum RailgunTransaction {
  Unshield = "UNSHIELD",
  Transfer = "PRIVATE TRANSFER",
  Shield = "SHIELD",
  UnshieldBase = "UNSHIELD BASE",
  ShieldBase = "SHIELD BASE",
  PublicTransfer = "PUBLIC TRANSFER",
  PublicBaseTransfer = "PUBLIC BASE TRANSFER",
  Public0XSwap = "PUBLIC ZER0X SWAP",
  Private0XSwap = "PRIVATE ZER0X SWAP",
}
