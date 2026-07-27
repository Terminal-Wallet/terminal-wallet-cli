import { NetworkName } from "@railgun-community/shared-models";
import { BalanceCacheMap } from "./balance-models";
import { TokenDatabaseMap } from "./token-models";



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


export type PositionAccountRecord = {
  slot: number;
  marketId: string;
  loanToken: string;
  collateralToken: string;
  openedAt: number;
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
  /**
   * Legacy: throttled the old prompt loop's redraw pulse. Nothing reads it —
   * the terminal UI redraws on state change — but it is kept on the type so an
   * existing keychain round-trips unchanged instead of silently losing a field.
   */
  responsiveMenu?: boolean;
  customProviders?: CustomProviderMap;
  /**
   * Which reserved-band slot holds which address-bound position, per RAILGUN
   * wallet. A convenience: the accounts derive deterministically from the seed,
   * so losing this costs a rediscovery scan, not the positions.
   *
   * Keyed by railgunWalletID because the ephemeral derivation path embeds the
   * wallet's own index — the same slot is a different account under a different
   * wallet, and a shared record would point at the wrong one.
   */
  positionAccounts?: MapType<PositionAccountRecord[]>;
  showSenderAddress?: boolean;
  /**
   * Broadcaster addresses the user has pinned or rejected. Persisted so a
   * broadcaster that behaved badly stays out of the way across restarts.
   */
  broadcasterFavorites?: string[];
  broadcasterBlocklist?: string[];
  /**
   * Preferred way to pay for a new private send: "broadcaster", "self-signer",
   * or "external:<label>". Only the signer choice is meaningfully persistable —
   * a broadcaster is picked live per transaction.
   */
  defaultFeeMode?: string;
  /** Imported private keys that can pay gas, encrypted at rest. */
  externalSigners?: ExternalSignerRecord[];
};


