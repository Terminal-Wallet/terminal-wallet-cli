import {
  AbstractSigner,
  Provider,
  TransactionRequest,
  TypedDataDomain,
  TypedDataField,
  toBeHex,
} from "ethers";
import {
  ExternalEVMTransaction,
  ExternalSignerBackend,
} from "./types";

export class ExternalSigner extends AbstractSigner {
  readonly derivationIndex: number;
  private readonly _address: string;
  private readonly backend: ExternalSignerBackend;

  constructor(
    backend: ExternalSignerBackend,
    address: string,
    derivationIndex: number,
    provider?: Provider | null,
  ) {
    super(provider ?? null);
    this.backend = backend;
    this._address = address;
    this.derivationIndex = derivationIndex;
  }

  get address(): string {
    return this._address;
  }

  async getAddress(): Promise<string> {
    return this._address;
  }

  connect(provider: Provider | null): ExternalSigner {
    return new ExternalSigner(
      this.backend,
      this._address,
      this.derivationIndex,
      provider,
    );
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    if (typeof message !== "string") {
      throw new Error("ExternalSigner.signMessage only supports string messages.");
    }
    return this.backend.signMessage(this.derivationIndex, message);
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const populated = await this.populateTransaction(tx);
    return this.signPopulated(populated);
  }

  async sendTransaction(tx: TransactionRequest) {
    if (!this.provider) {
      throw new Error("ExternalSigner is not connected to a provider.");
    }
    const populated = await this.populateTransaction(tx);
    const serializedTx = await this.signPopulated(populated);
    return this.provider.broadcastTransaction(serializedTx);
  }

  async signTypedData(
    _domain: TypedDataDomain,
    _types: Record<string, TypedDataField[]>,
    _value: Record<string, any>,
  ): Promise<string> {
    throw new Error("ExternalSigner does not support signTypedData.");
  }

  private async signPopulated(pop: TransactionRequest): Promise<string> {
    const isEip1559 =
      pop.maxFeePerGas != null || pop.maxPriorityFeePerGas != null;

    const base = {
      to: pop.to ? String(pop.to) : "0x",
      value: toBeHex(pop.value ?? 0n),
      data: (pop.data as string | undefined) ?? "0x",
      nonce: toBeHex(pop.nonce ?? 0),
      gasLimit: toBeHex(pop.gasLimit ?? 0n),
      chainId: Number(pop.chainId),
    };

    const externalTx: ExternalEVMTransaction = isEip1559
      ? {
          ...base,
          maxFeePerGas: toBeHex(pop.maxFeePerGas ?? 0n),
          maxPriorityFeePerGas: toBeHex(pop.maxPriorityFeePerGas ?? 0n),
        }
      : { ...base, gasPrice: toBeHex(pop.gasPrice ?? 0n) };

    return this.backend.signTransaction(this.derivationIndex, externalTx);
  }
}
