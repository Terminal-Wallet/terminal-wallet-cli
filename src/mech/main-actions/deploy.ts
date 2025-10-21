import { zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";

import { mechStatus } from "./status";
import { mechAddress, mechDeploymentTx, nftAddress } from "../deployments";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";
import { populateShieldTransaction } from "../populate/populateShieldTransaction";

export async function deployMech() {
  const { isMechDeployed, isNFTShielded } = await mechStatus();
  if (!isNFTShielded) {
    console.log(`Minting and shielding into RailgunSW`);
    await shield();
  } else {
    console.log("NFT already shielded in RailgunSW");
  }

  if (!isMechDeployed) {
    console.log(`Deploying Mech`);
    await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      mechDeploymentTx(),
    );
  } else {
    console.log(`Mech already deployed`);
  }
}

async function shield() {
  const nftIn = [
    {
      nftAddress: nftAddress(),
      nftTokenType: NFTTokenType.ERC721,
      tokenSubID: zeroPadValue(mechAddress(), 32),
      amount: BigInt(1),
      recipientAddress: getCurrentRailgunAddress(),
    },
  ];

  await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    await populateShieldTransaction({ nftIn, erc20In: [] }),
  );
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
