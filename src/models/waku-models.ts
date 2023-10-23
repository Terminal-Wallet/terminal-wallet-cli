import {
  Chain,
  PreTransactionPOIsPerTxidLeafPerList,
  RelayerConnectionStatus,
  SelectedRelayer,
  TXIDVersion,
} from "@railgun-community/shared-models";

export type RelayerOptions = {
  pubSubTopic?: string;
  additionalDirectPeers?: string[];
  peerDiscoveryTimeout?: number;
};
export type RelayerConnectionStatusCallback = (
  chain: Chain,
  status: RelayerConnectionStatus,
) => void;

export type RelayerDebugger = {
  log: (msg: string) => void;
  error: (error: Error) => void;
};

export type WakuRelayerClient = {
  start: (
    chain: Chain,
    relayerOptions: RelayerOptions,
    statusCallback: RelayerConnectionStatusCallback,
    relayerDebugger?: RelayerDebugger,
  ) => void;
  setChain: (chain: Chain) => void;
  stop: () => void;
  findBestRelayer: (
    chain: Chain,
    tokenAddress: string,
    useRelayAdapt: boolean,
  ) => SelectedRelayer;
  setAddressFilters(
    allowlist: Optional<string[]>,
    blocklist: Optional<string[]>,
  ): void;
  tryReconnect(): Promise<void>;
};
export type WakuRelayerTransaction = {
  create: (
    txidVersionForInputs: TXIDVersion,
    to: string,
    data: string,
    relayerRailgunAddress: string,
    relayerFeesID: string,
    chain: Chain,
    nullifiers: string[],
    overallBatchMinGasPrice: bigint,
    useRelayAdapt: boolean,
    preTransactionPOIsPerTxidLeafPerList: PreTransactionPOIsPerTxidLeafPerList,
  ) => { send: () => Promise<string> };
};
