import { SignerId } from "../../models/wallet-models";

export type ExternalEVMTransaction = {
  to: string;
  value: string;
  data?: string;
  chainId: number;
  nonce: string;
  gasLimit: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
};

export type ExternalSignerBackend = {
  id: SignerId;
  label: string;
  derivationPath: (derivationIndex: number) => string;
  getAddress: (derivationIndex: number) => Promise<string>;
  signMessage: (derivationIndex: number, message: string) => Promise<string>;
  signTransaction: (
    derivationIndex: number,
    transaction: ExternalEVMTransaction,
  ) => Promise<string>;
  dispose: () => Promise<void>;
};
