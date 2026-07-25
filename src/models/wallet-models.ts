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

/** AES-256-GCM envelope. Versioned so the derivation can change later. */
export type EncryptedSignerBlob = {
  v: number;
  kdf: string;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
};

/**
 * An imported signing key, stored encrypted under the wallet password.
 *
 * The address is kept in the clear so a signer can be listed and chosen without
 * unlocking anything; only the key itself is sealed.
 */
export type ExternalSignerRecord = {
  label: string;
  address: string;
  encrypted: EncryptedSignerBlob;
};


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
  /**
   * Broadcaster addresses the user has pinned or rejected. Persisted so a
   * broadcaster that behaved badly stays out of the way across restarts.
   */
  broadcasterFavorites?: string[];
  broadcasterBlocklist?: string[];
  /** Imported private keys that can pay gas, encrypted at rest. */
  externalSigners?: ExternalSignerRecord[];
};


export type EncryptedCacheFile = {
  name: string;
  iv: string;
  encryptedData: string;
};
