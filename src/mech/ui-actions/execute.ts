import { toBeHex, zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";

import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";

import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { MetaTransaction } from "../http";
import { encodeMechExecute, encodeMint } from "../encode";
import { populateCrossTransaction } from "../railgun-primitives";
import { mechStatus } from "./status";

import deployments, { mechDeploymentTx } from "../deployments";

export async function executeViaMech(calls: MetaTransaction[]) {
  const mech = deployments.mech();
  const relayAdapt = deployments.relayAdapt();

  const { isMechDeployed, isNFTMinted, isNFTSpendable } = await mechStatus();

  if (isNFTMinted && !isNFTSpendable) {
    console.log("Gotta wait");
    return;
  }

  const myNFTOut = {
    nftAddress: mech.tokenAddress,
    nftTokenType: NFTTokenType.ERC721,
    tokenSubID: zeroPadValue(toBeHex(mech.tokenId), 32),
    amount: BigInt(1),
  };

  const myNFTIn = {
    ...myNFTOut,
    recipientAddress: getCurrentRailgunAddress(),
  };

  const deployMetaTx: MetaTransaction = {
    value: 0,
    ...mechDeploymentTx(),
    operation: 0,
  };

  const mintMetaTx: MetaTransaction = {
    to: mech.tokenAddress,
    value: 0,
    data: encodeMint(relayAdapt.address, mech.tokenId),
    operation: 0,
  };

  /*
   * Lazy mech deployment and Lazy nft minting
   */
  const finalCalls = [
    isMechDeployed ? null : deployMetaTx,
    isNFTMinted ? null : mintMetaTx,
    ...calls,
  ]
    .filter((t) => !!t)
    .map((t) => ({
      to: mech.address,
      data: encodeMechExecute(t!),
    }));

  const transaction = await populateCrossTransaction({
    unshieldNFTs: isNFTMinted ? [myNFTOut] : [],
    unshieldERC20s: [],
    crossContractCalls: finalCalls,
    shieldNFTs: [myNFTIn],
    shieldERC20s: [],
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
