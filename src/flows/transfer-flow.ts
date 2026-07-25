/**
 * Pure assembly for a transfer spec — turns collected inputs into a TransferSpec.
 * Input collection (prompts) lives in the UI layer; this stays UI-free + testable.
 */
import {
  RailgunERC20AmountRecipient,
  SelectedBroadcaster,
  NetworkName,
} from "@railgun-community/shared-models";
import { RailgunTransaction } from "../models/transaction-models";
import { WalletCache } from "../models/wallet-models";
import { FeeMode, TransferSpec } from "./spec";

/** Broadcaster if one was selected, otherwise self-sign with the given wallet. */
export const toFeeMode = (
  broadcaster: SelectedBroadcaster | undefined,
  signer: WalletCache,
): FeeMode =>
  broadcaster
    ? { kind: "broadcaster", broadcaster }
    : { kind: "self-signer", signer };

export const buildTransferSpec = (args: {
  chainName: NetworkName;
  recipients: RailgunERC20AmountRecipient[];
  encryptionKey: string;
  fee: FeeMode;
  memo?: string;
}): TransferSpec => ({
  type: RailgunTransaction.Transfer,
  chainName: args.chainName,
  recipients: args.recipients,
  encryptionKey: args.encryptionKey,
  fee: args.fee,
  memo: args.memo,
});
