import { getWalletMnemonic } from "@railgun-community/wallet";
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { WalletCache } from "../../models/wallet-models";
import {
  getEthersWallet,
  getFirstPollingProviderForChain,
} from "../../network/network-util";
import { getSaltedPassword } from "../wallet-password";
import { walletManager } from "../wallet-manager";
import { getSignerId } from "../wallet-util";
import { ExternalSigner } from "./external-signer";
import { TerminalSigner } from "./terminal-signer";
import { getSignerBackend } from "./registry";

export const createSignerForWallet = async (
  wallet: WalletCache,
  chainName: NetworkName,
): Promise<TerminalSigner> => {
  const signerId = getSignerId(wallet);
  if (signerId) {
    const backend = await getSignerBackend(signerId);
    const publicAddress =
      wallet.publicAddress ??
      (await backend.getAddress(wallet.derivationIndex));
    const provider = getFirstPollingProviderForChain(chainName);
    return new ExternalSigner(
      backend,
      publicAddress,
      wallet.derivationIndex,
      provider,
    );
  }

  walletManager.hashedPassword = await getSaltedPassword();
  if (!isDefined(walletManager.hashedPassword)) {
    throw new Error("Hashed Password Timed Out");
  }

  const walletMnemonic = await getWalletMnemonic(
    walletManager.hashedPassword,
    wallet.railgunWalletID,
  );
  return getEthersWallet(walletMnemonic, wallet.derivationIndex, chainName);
};
