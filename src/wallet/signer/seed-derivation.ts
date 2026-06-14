import { keccak256, Mnemonic } from "ethers";
import { SignerId } from "../../models/wallet-models";
import { getSignerBackend } from "./registry";

// Fixed forever — changing this breaks recovery for existing external-signer wallets.
const RAILGUN_SEED_MESSAGE = "Terminal Wallet :: Railgun seed derivation :: v1";

export type ExternalSignerWalletSeed = {
  mnemonic: string;
  publicAddress: string;
};

export const deriveRailgunSeedFromExternalSigner = async (
  signerId: SignerId,
  derivationIndex: number,
): Promise<ExternalSignerWalletSeed> => {
  const backend = await getSignerBackend(signerId);
  const publicAddress = await backend.getAddress(derivationIndex);
  const signature = await backend.signMessage(
    derivationIndex,
    RAILGUN_SEED_MESSAGE,
  );
  const entropy = keccak256(signature);
  const mnemonic = Mnemonic.fromEntropy(entropy).phrase;

  return { mnemonic, publicAddress };
};
