/**
 * Naming a shielded NFT.
 *
 * A collection address and a hex token id identify an NFT but describe nothing.
 * The ones this wallet holds are protocol positions — an f(x) pool IS the
 * collection, and the token id IS the position id — so "wstETH-Long #4242" is
 * both the true name and the one the holder would use.
 *
 * Pure: the recognised collections are passed in rather than read, so this can
 * be tested without a chain and extended when a second protocol lands.
 */
import { RailgunNFTAmount } from "@railgun-community/shared-models";
import { RailgunDisplayNFT } from "../../models/balance-models";
import { bestAvailability } from "./nft-availability";

/** A collection the wallet can name, and what a token in it means. */
export interface KnownCollection {
  address: string;
  name: string;
  kind: RailgunDisplayNFT["kind"];
}

const shortAddress = (address: string): string =>
  address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;

/** The token id as a decimal, which is how every protocol UI refers to it. */
export const nftTokenId = (tokenSubID: string): string => {
  try {
    return BigInt(tokenSubID).toString();
  } catch {
    // A malformed id is still worth showing — it is what the wallet holds.
    return tokenSubID;
  }
};

/**
 * The cache key an NFT is stored under. Mirrors `nftKey` in balance-cache,
 * duplicated rather than imported so this module stays free of the cache.
 */
export const describeNFTKey = (nft: RailgunNFTAmount): string =>
  `${nft.nftAddress.toLowerCase()}:${nftTokenId(nft.tokenSubID)}`;

export const describeNFT = (
  nft: RailgunNFTAmount,
  known: readonly KnownCollection[],
  buckets?: Readonly<Record<string, readonly string[]>>,
): RailgunDisplayNFT => {
  const match = known.find(
    (c) => c.address.toLowerCase() === nft.nftAddress.toLowerCase(),
  );
  const id = nftTokenId(nft.tokenSubID);
  return {
    nftAddress: nft.nftAddress,
    tokenSubID: nft.tokenSubID,
    amount: nft.amount,
    label: match ? `${match.name} #${id}` : `${shortAddress(nft.nftAddress)} #${id}`,
    kind: match?.kind,
    // Left undefined when no bucket map is supplied, so a caller that does not
    // know cannot be mistaken for one reporting "spendable".
    ...(buckets
      ? { availability: bestAvailability(buckets[describeNFTKey(nft)] ?? []) }
      : {}),
  };
};

export const describeNFTs = (
  nfts: readonly RailgunNFTAmount[],
  known: readonly KnownCollection[],
  buckets?: Readonly<Record<string, readonly string[]>>,
): RailgunDisplayNFT[] => nfts.map((nft) => describeNFT(nft, known, buckets));
