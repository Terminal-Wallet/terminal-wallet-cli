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
import { populateCrossTransaction } from "../populate/populateCrossTransaction";

import deployments from "../deployments";

import { encodeMechExecute, encodeTranfer, encodeTranferFrom } from "../encode";

export async function withdrawFromMech({
  withdrawNFTs,
  withdrawERC20s,
}: {
  withdrawNFTs: RailgunNFTAmount[];
  withdrawERC20s: RailgunERC20Amount[];
}) {
  const mech = deployments.mech();
  const relayAdapt = deployments.relayAdapt();

  const neuralLinkOut = {
    nftAddress: mech.tokenAddress,
    nftTokenType: NFTTokenType.ERC721,
    tokenSubID: zeroPadValue(toBeHex(mech.tokenId), 32),
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
        mech.address,
        relayAdapt.address,
        BigInt(e.tokenSubID),
      ),
    })),
    // from mech -> adapt
    ...withdrawERC20s.map((e) => ({
      to: e.tokenAddress,
      data: encodeTranfer(relayAdapt.address, e.amount),
    })),
  ].map((tx) => ({ to: mech.address, data: encodeMechExecute(tx) }));

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
