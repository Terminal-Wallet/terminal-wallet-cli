import {
  Chain,
  PreTransactionPOIsPerTxidLeafPerList,
  BroadcasterConnectionStatus,
  SelectedBroadcaster,
  TXIDVersion,
} from "@railgun-community/shared-models";

export type BroadcasterOptions = {
  pubSubTopic?: string;
  additionalDirectPeers?: string[];
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
  ) => SelectedBroadcaster;
  findBroadcastersForToken: (
    chain: Chain,
    tokenAddress: string,
    useRelayAdapt: boolean,
  ) => SelectedBroadcaster[];
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
  ) => { send: () => Promise<string> };
};
