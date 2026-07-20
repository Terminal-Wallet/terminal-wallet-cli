import {
  Chain,
  PreTransactionPOIsPerTxidLeafPerList,
  BroadcasterConnectionStatus,
  SelectedBroadcaster,
  TXIDVersion,
} from "@railgun-community/shared-models";
import type { AuthorizationLike, BigNumberish } from "ethers";

export type BroadcasterOptions = {
  pubSubTopic?: string;
  additionalDirectPeers?: string[];
  trustedFeeSigner: string | string [];
  peerDiscoveryTimeout?: number;
};
export type BroadcasterConnectionStatusCallback = (
  chain: Chain,
  status: BroadcasterConnectionStatus,
) => void;

export type BroadcasterDebugger = {
  log: (msg: string) => void;
  error: (error: Error) => void;
};

export type WakuBroadcasterClient = {
  start: (
    chain: Chain,
    broadcasterOptions: BroadcasterOptions,
    statusCallback: BroadcasterConnectionStatusCallback,
    broadcasterDebugger?: BroadcasterDebugger,
  ) => void;
  setChain: (chain: Chain) => void;
  stop: () => void;
  findBestBroadcaster: (
    chain: Chain,
    tokenAddress: string,
    useRelayAdapt: boolean,
    use7702Only?: boolean,
  ) => SelectedBroadcaster;
  findBroadcastersForToken: (
    chain: Chain,
    tokenAddress: string,
    useRelayAdapt: boolean,
    use7702Only?: boolean,
  ) => SelectedBroadcaster[] | undefined;
  findAllBroadcastersForChain: (
    chain: Chain,
    useRelayAdapt: boolean,
    use7702Only?: boolean,
  ) => SelectedBroadcaster[] | undefined;
  setAddressFilters(
    allowlist: Optional<string[]>,
    blocklist: Optional<string[]>,
  ): void;
  tryReconnect(): Promise<void>;
};
export type WakuBroadcasterTransaction = {
  create: (
    txidVersionForInputs: TXIDVersion,
    to: string,
    data: string,
    broadcasterRailgunAddress: string,
    broadcasterFeesID: string,
    chain: Chain,
    nullifiers: string[],
    overallBatchMinGasPrice: bigint,
    useRelayAdapt: boolean,
    preTransactionPOIsPerTxidLeafPerList: PreTransactionPOIsPerTxidLeafPerList,
    authorization?: AuthorizationLike,
    type4FeeOverrides?: {
      gasLimit?: BigNumberish;
      maxFeePerGas: BigNumberish;
      maxPriorityFeePerGas: BigNumberish;
    },
  ) => { send: () => Promise<string> };
};
