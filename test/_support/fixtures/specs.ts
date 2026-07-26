/** Transaction spec fixtures, assembled from the smaller fixtures. */
import { NetworkName } from "@railgun-community/shared-models";
import { RailgunTransaction } from "../../../src/models/transaction-models";
import {
  TransferSpec,
  UnshieldSpec,
  ShieldSpec,
} from "../../../src/flows/spec";
import { CrossContractSpec } from "../../../src/flows/deps/cross-contract";
import { CrossContractInputs } from "../../../src/railgun/transaction/cross-contract";
import { NO_CROSS_CONTRACT_GAS_FLOOR } from "../../../src/railgun/transaction/cross-contract";
import { erc20Recipient } from "./recipients";
import { selfSignerFee } from "./fees";

export const transferSpec = (over: Partial<TransferSpec> = {}): TransferSpec => ({
  type: RailgunTransaction.Transfer,
  chainName: NetworkName.Ethereum,
  recipients: [erc20Recipient()],
  encryptionKey: "ek",
  fee: selfSignerFee(),
  ...over,
});

export const unshieldSpec = (over: Partial<UnshieldSpec> = {}): UnshieldSpec => ({
  type: RailgunTransaction.Unshield,
  chainName: NetworkName.Ethereum,
  recipients: [erc20Recipient()],
  encryptionKey: "ek",
  fee: selfSignerFee(),
  ...over,
});

export const shieldSpec = (over: Partial<ShieldSpec> = {}): ShieldSpec => ({
  type: RailgunTransaction.Shield,
  chainName: NetworkName.Ethereum,
  recipients: [erc20Recipient()],
  ...over,
});

export const crossContractInputs = (
  over: Partial<CrossContractInputs> = {},
): CrossContractInputs => ({
  relayAdaptUnshieldERC20Amounts: [],
  relayAdaptShieldERC20Addresses: [],
  crossContractCalls: [],
  minGasLimit: NO_CROSS_CONTRACT_GAS_FLOOR,
  ...over,
});

export const crossContractSpec = (
  over: Partial<CrossContractSpec> = {},
): CrossContractSpec => ({
  type: RailgunTransaction.Private0XSwap,
  chainName: NetworkName.Ethereum,
  inputs: crossContractInputs(),
  encryptionKey: "ek",
  fee: selfSignerFee(),
  ...over,
});
