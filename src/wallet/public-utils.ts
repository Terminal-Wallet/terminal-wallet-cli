import {
  getShieldPrivateKeySignatureMessage,
  getWalletMnemonic,
} from "@railgun-community/wallet";
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { WalletCache } from "../models/wallet-models";
import { keccak256 } from "ethers";
import { getEthersWallet } from "../network/network-util";
import { walletManager } from "./wallet-manager";
import { getSaltedPassword } from "./wallet-password";

export const getCurrentEthersWallet = () => {
  if (walletManager.currentEthersWallet) {
    return walletManager.currentEthersWallet;
  }
  throw new Error("No Ethers Wallet Loaded.");
};

export const getEthersWalletForSigner = async (
  selfSignerInfo: WalletCache,
  chainName: NetworkName,
) => {
  walletManager.hashedPassword = await getSaltedPassword();
  if (!isDefined(walletManager.hashedPassword)) {
    throw new Error("Hashed Password Timed Out");
  }

  const walletMnemonic = await getWalletMnemonic(
    walletManager.hashedPassword,
    selfSignerInfo.railgunWalletID,
  );
  const ethersWallet = getEthersWallet(
    walletMnemonic,
    selfSignerInfo.derivationIndex,
    chainName,
  );
  return ethersWallet;
};

export const getCurrentShieldPrivateKey = async () => {
  const ethersWallet = getCurrentEthersWallet();
  const shieldSignatureMessage = getShieldPrivateKeySignatureMessage();
  const shieldPrivateKey = keccak256(
    await ethersWallet.signMessage(shieldSignatureMessage),
  );
  return { shieldPrivateKey, fromWalletAddress: ethersWallet.address };
};

export const getCurrentWalletMnemonicAndIndex = async () => {
  walletManager.hashedPassword = await getSaltedPassword();
  if (!isDefined(walletManager.hashedPassword)) {
    return undefined;
    throw new Error("Hashed Password Timed Out");
  }
  const { railgunWalletID, derivationIndex } =
    walletManager.currentActiveWallet;
  const walletMnemonic = await getWalletMnemonic(
    walletManager.hashedPassword,
    railgunWalletID,
  );
  return { walletMnemonic, derivationIndex };
};
