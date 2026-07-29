/**
 * Is this address the kind of address it is supposed to be, and is it real.
 *
 * Lives here rather than in the renderer because it is not a rendering concern:
 * it is the last check standing between a typo and an irreversible send, and
 * every host needs it. A headless caller has no review screen to read the
 * address off, so it needs it more than the deck does.
 *
 * Both checks are the SDK's own, not shapes matched locally:
 *
 *   0zk  `validateRailgunAddress` decodes the bech32m payload and verifies its
 *        checksum. The previous rule here was `/^0zk[0-9a-z]+$/i` with
 *        `length >= 20`, which accepts a 20-character fragment of a real
 *        127-character address — exactly what a truncated paste looks like.
 *   0x   `validateEthAddress` is `getAddress()`, so a mixed-case address whose
 *        EIP-55 checksum does not match is refused. All-lowercase and
 *        all-uppercase carry no checksum and are still accepted, because
 *        rejecting those would refuse addresses that are perfectly valid and
 *        routinely pasted.
 *
 * Verified against the real encoder: a round-tripped address passes, one flipped
 * character fails, and a truncation fails.
 */
import {
  validateEthAddress,
  validateRailgunAddress,
} from "@railgun-community/wallet";

export type AddressKind = "0x" | "0zk";

/**
 * An error string, or undefined when the address is usable. Message-returning
 * rather than throwing because both callers want to show it next to a field.
 */
export const addressKindError = (
  kind: AddressKind,
  raw: string,
): string | undefined => {
  const address = raw.trim();
  if (!address) {
    return kind === "0zk"
      ? "Not a RAILGUN 0zk address."
      : "Not a valid 0x… address.";
  }
  if (kind === "0zk") {
    if (address.toLowerCase().startsWith("0x")) {
      // Naming the confusion is the point: the two are not interchangeable and
      // sending to the wrong kind is not recoverable.
      return "That is a public 0x address; this field needs a private 0zk one.";
    }
    return validateRailgunAddress(address)
      ? undefined
      : "Not a RAILGUN 0zk address.";
  }
  if (address.toLowerCase().startsWith("0zk")) {
    return "That is a private 0zk address; this field needs a public 0x one.";
  }
  return validateEthAddress(address)
    ? undefined
    : "Not a valid 0x… address.";
};
