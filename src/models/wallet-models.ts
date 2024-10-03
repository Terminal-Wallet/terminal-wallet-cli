import { NetworkName } from "@railgun-community/shared-models";
import { BalanceCacheMap } from "./balance-models";
import { TokenDatabaseMap } from "./token-models";

export type RailWallet = {
  id: string;
  name: string;
  index: number;
  mnemonic: string;
  network: NetworkName;
  railgunAddress: string;
  privateERC20BalanceCache: BalanceCacheMap;
  publicERC20BalanceCache: BalanceCacheMap;
  tokenDatabase: TokenDatabaseMap;
};

export type RailWalletFile = {
  iv: Buffer;
  hashedPassword: { type: string; data: any[] };
  wallets: RailWallet[];
};

export type TMPWalletInfo = {
  mnemonic: string;
  walletName: string;
  derivationIndex: number;
};

export type WalletCache = {
  railgunWalletID: string;
  railgunWalletAddress: string;
  derivationIndex: number;
  publicAddress?: string;
};

export type KnownAddressKey = {
  name: string;
  publicAddress?: string;
  privateAddress?: string;
};


export type CustomProviderMap = NumMapType<NumMapType<MapType<boolean>>>;

export type KeychainFile = {
  name: string;
  salt: string;
  wallets?: MapType<WalletCache>;
  knownAddresses?: KnownAddressKey[];
  currentNetwork?: NetworkName;
  selectedWallet?: string;
  cachedTokenInfo?: TokenDatabaseMap;
  displayPrivate?: boolean;
  responsiveMenu?: boolean;
  customProviders?: CustomProviderMap;
  showSenderAddress?: boolean;
};

export type EncryptedCacheFile = {
  name: string;
  iv: string;
  encryptedData: string;
};
