import { toBeHex, zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";
import {
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";

import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { populateCrossTransaction } from "../railgun-primitives";
import { encodeMechExecute, encodeTranfer, encodeTranferFrom } from "../encode";
import { findAvailableMech } from "../status";

import deployments from "../deployments";

export async function withdrawFromMech({
  withdrawNFTs,
  withdrawERC20s,
}: {
  withdrawNFTs: RailgunNFTAmount[];
  withdrawERC20s: RailgunERC20Amount[];
}) {
  const hit = await findAvailableMech();
  if (!hit) {
    console.log("No available Mechs found");
    return;
  }

  const relayAdapt = deployments.relayAdapt();
  const { mechAddress, tokenAddress, tokenId } = hit;

  const neuralLinkOut = {
    nftAddress: tokenAddress,
    nftTokenType: NFTTokenType.ERC721,
    tokenSubID: zeroPadValue(toBeHex(tokenId), 32),
    amount: BigInt(1),
  };

  const neuralLinkIn = {
    ...neuralLinkOut,
    recipientAddress: getCurrentRailgunAddress(),
  };

  const calls = [
    // from mech -> adapt
    ...withdrawNFTs.map((e) => ({
      to: e.nftAddress,
      data: encodeTranferFrom(
        mechAddress,
        relayAdapt.address,
        BigInt(e.tokenSubID),
      ),
    })),
    // from mech -> adapt
    ...withdrawERC20s.map((e) => ({
      to: e.tokenAddress,
      data: encodeTranfer(relayAdapt.address, e.amount),
    })),
  ].map((tx) => ({ to: mechAddress, data: encodeMechExecute(tx) }));

  const transaction = await populateCrossTransaction({
    unshieldNFTs: [neuralLinkOut],
    unshieldERC20s: [],
    crossContractCalls: calls,
    shieldNFTs: [
      neuralLinkIn,
      ...withdrawNFTs.map((e) => ({
        ...e,
        recipientAddress: getCurrentRailgunAddress(),
      })),
    ],
    shieldERC20s: withdrawERC20s.map((e) => ({
      ...e,
      recipientAddress: getCurrentRailgunAddress(),
    })),
  });

  await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    transaction,
  );
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
