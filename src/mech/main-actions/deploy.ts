import { zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";

import { mechStatus } from "./status";
import {
  mechAddress,
  nftAddress,
  populateMechDeployment,
} from "../deployments";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";
import { populateShieldTransaction } from "../populate/populateShieldTransaction";
import { deployMastercopy } from "@gnosis-guild/zodiac-core";
import { getEthersWalletForSigner } from "../../wallet/public-utils";

export async function deployMech() {
  const { isMechDeployed, isNFTMinted, isNFTShielded, isNFTSpendable } =
    await mechStatus();

  // for now we can comment this
  // if (!isNFTMinted) {
  //   console.log("Minting NFT");
  //   await sendSelfSignedTransaction(
  //     selfSignerInfo(),
  //     getCurrentNetwork(),
  //     await populateMint(),
  //   );
  // } else {
  //   console.log("NFT already minted");
  // }

  if (!isNFTShielded) {
    console.log("Shielding NFT");
    await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      await populateShieldNFT(),
    );
  } else {
    console.log("NFT already shielded");
  }

  if (!isMechDeployed) {
    console.log("Deploying Mech");
    await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      await populateMechDeployment(),
    );
  } else {
    console.log("Mech already deployed");
  }
}

async function populateShieldNFT() {
  const nftIn = [
    {
      nftAddress: nftAddress(),
      nftTokenType: NFTTokenType.ERC721,
      tokenSubID: zeroPadValue(mechAddress(), 32),
      amount: BigInt(1),
      recipientAddress: getCurrentRailgunAddress(),
    },
  ];

  return populateShieldTransaction({ nftIn, erc20In: [] });
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
