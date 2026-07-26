/**
 * The in-memory password/key holder.
 *
 * IMPORTANT — this owns the RAILGUN engine key derivation:
 *
 *     raw password + keychain salt
 *       -> computePasswordHash(raw, 32, salt)   [scrypt N=131072 r=8 p=1]
 *       -> walletManager.hashedPassword
 *       -> loadWalletByID / createRailgunWallet / getWalletMnemonic
 *
 * That derivation is what the engine's stored seed is encrypted against. Change
 * any input to it — the salt, the parameters, the encoding — and every existing
 * wallet on disk stops opening. It does not change.
 *
 * The derivation previously lived inside the enquirer password prompt, so the
 * renderer both collected the secret and derived the key from it. It sits here
 * now and the host only supplies raw text through the input seam, so a second
 * host cannot derive it differently.
 */
import { isDefined } from "@railgun-community/shared-models";
import { getInputProvider } from "../../core/input";
import { computePasswordHash, hashString } from "../../platform/crypto";
import { walletManager } from "./wallet-manager";

/**
 * The derived engine key if the wallet is already unlocked, otherwise
 * undefined. Never prompts.
 *
 * For work that should happen quietly or not at all — a live quote preview
 * needs the key to derive the 7702 ephemeral taker address, but stopping to ask
 * for a password while someone types an amount is not acceptable.
 */
export const getCachedEncryptionKey = (): string | undefined =>
  walletManager.hashedPassword;

export const clearHashedPassword = () => {
  walletManager.hashedPassword = undefined;
};

const MIN_PASSWORD_LENGTH = 8;

/**
 * Return the derived engine key, prompting for the password if one is not
 * already held. Once a password has been seen, a later mismatch is rejected
 * here rather than handed to the engine as a wrong key.
 */
export const getSaltedPassword = async (
  overrideMessage?: string,
): Promise<string | undefined> => {
  if (walletManager.hashedPassword) {
    return walletManager.hashedPassword;
  }

  // Resolved before the try: a missing provider is a wiring error, not a user
  // error, and it must propagate rather than be caught and then re-thrown from
  // the catch block trying to report it.
  const input = getInputProvider();

  try {
    const raw = await input.promptPassword(
      overrideMessage ?? "Enter your password:",
    );
    if (!isDefined(raw) || raw.length < MIN_PASSWORD_LENGTH) {
      throw new Error("No password entered.");
    }

    walletManager.hashedPassword = await computePasswordHash(
      raw,
      32,
      walletManager.saltedPassword,
    );
    if (!isDefined(walletManager.hashedPassword)) {
      throw new Error("Password hashing failed.");
    }

    // First entry establishes the reference; later entries must match it, so a
    // typo is caught here instead of surfacing as an opaque engine error.
    const comparisonRef = hashString(walletManager.hashedPassword);
    if (!isDefined(walletManager.comparisonRefHash)) {
      walletManager.comparisonRefHash = comparisonRef;
    } else if (comparisonRef !== walletManager.comparisonRefHash) {
      clearHashedPassword();
      throw new Error("Password incorrect.");
    }

    return walletManager.hashedPassword;
  } catch (error) {
    input.notify((error as Error).message);
    walletManager.comparisonRefHash = undefined;
    walletManager.hashedPassword = undefined;
    return undefined;
  }
};

/**
 * Re-prompt and check against the password already held. Used when creating a
 * wallet, so a mistyped password cannot be baked into a seed that then will not
 * open.
 */
export const confirmPassword = async (): Promise<boolean> => {
  if (!isDefined(walletManager.comparisonRefHash)) {
    return false;
  }
  const raw = await getInputProvider().promptPassword("Confirm your password:");
  if (!isDefined(raw) || raw.length < MIN_PASSWORD_LENGTH) {
    return false;
  }
  const derived = await computePasswordHash(
    raw,
    32,
    walletManager.saltedPassword,
  );
  return hashString(derived) === walletManager.comparisonRefHash;
};
