import {
  getShieldPrivateKeySignatureMessage,
  getWalletMnemonic,
} from "@railgun-community/wallet";
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { keccak256 } from "ethers";
import { walletManager } from "./wallet-manager";
import { getSaltedPassword } from "./wallet-password";
import { usesExternalSigner, getSignerId } from "./wallet-util";
import { createSignerForWallet } from "./signer/factory";
import { getSignerBackend } from "./signer/registry";

export const getCurrentEthersWallet = () => {
  if (walletManager.currentEthersWallet) {
    return walletManager.currentEthersWallet;
  }
  throw new Error("No Ethers Wallet Loaded.");
};

export const getEthersWalletForSigner = async (
  selfSignerInfo: Parameters<typeof createSignerForWallet>[0],
  chainName: NetworkName,
) => createSignerForWallet(selfSignerInfo, chainName);

export const getCurrentShieldPrivateKey = async () => {
  const ethersWallet = getCurrentEthersWallet();
  const fromWalletAddress = ethersWallet.address;
  const isExternal = usesExternalSigner(walletManager.currentActiveWallet);

  // External signers sign on-device every call, so the derived shield key is
  // cached for the session after the first confirmation.
  if (isExternal && isDefined(walletManager.cachedShieldPrivateKey)) {
    return {
      shieldPrivateKey: walletManager.cachedShieldPrivateKey,
      fromWalletAddress,
    };
  }

  if (isExternal) {
    const signerId = getSignerId(walletManager.currentActiveWallet);
    const backend = signerId ? await getSignerBackend(signerId) : undefined;
    console.log(
      `Confirm on your ${backend?.label ?? "hardware wallet"} to unlock private shield operations for this session.`
        .yellow,
    );
  }

  const shieldSignatureMessage = getShieldPrivateKeySignatureMessage();
  const shieldPrivateKey = keccak256(
    await ethersWallet.signMessage(shieldSignatureMessage),
  );

  if (isExternal) {
    walletManager.cachedShieldPrivateKey = shieldPrivateKey;
  }

  return { shieldPrivateKey, fromWalletAddress };
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
