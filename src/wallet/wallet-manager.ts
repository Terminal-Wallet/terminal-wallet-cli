import { ProgressBar } from "../ui/progressBar-ui";
import { KeychainFile, WalletCache } from "../models/wallet-models";
import { Wallet } from "ethers";
import { RailgunReadableAmount } from "../models/balance-models";
import {
  POIProofProgressEvent,
  RailgunBalancesEvent,
} from "@railgun-community/shared-models";
import Web3 from "web3";

export type WalletManager = {
  poiProgressEvent: POIProofProgressEvent;
  progressBar: ProgressBar;
  web3: Web3;
  balanceScanProgress: number;
  merkelScanComplete: boolean;
  railgunWalletAddress: string;
  railgunWalletID: string;
  latestPrivateBalanceEvents: Optional<RailgunBalancesEvent[]>;
  // privateBalanceCache: RailgunReadableAmount[];
  keyChain: KeychainFile;
  activeWalletName: string;
  currentActiveWallet: WalletCache;
  currentEthersWallet: Wallet;
  comparisonRefHash: Optional<string | undefined>;
  menuLoaded: boolean;
  saltedPassword: string;
  hashedPassword: Optional<string | undefined>;
  menuCallback: () => Promise<void>;
  displayPrivate: boolean;
  responsiveMenu: boolean;
  showSenderAddress: boolean;
};
export const walletManager: WalletManager = {
  merkelScanComplete: false,
  balanceScanComplete: false,
  // privateBalanceCache: [],
  menuLoaded: false,
  displayPrivate: true,
  responsiveMenu: true,
  showSenderAddress: true,
} as any;

export const getScanProgressString = () => {
  if (
    walletManager.balanceScanProgress > 0 &&
    walletManager.balanceScanProgress !== 100
  ) {
    return `Balance Scan Progress  |  [${walletManager.balanceScanProgress.toFixed(
      2,
    )}%]\n`;
  }
  return "";
};
