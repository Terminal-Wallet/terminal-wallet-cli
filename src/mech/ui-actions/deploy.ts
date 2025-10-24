import { toBeHex, zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";

import { mechStatus } from "./status";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { getCurrentEthersWallet } from "../../wallet/public-utils";
import { populateShieldTransaction } from "../railgun-primitives";
import deployments, { mechDeploymentTx } from "../deployments";
import { encodeApprove, encodeMint } from "../encode";

export async function deployMech() {
  const { isMechDeployed, isNFTMinted, isNFTShielded, isNFTSpendable } =
    await mechStatus();

  const mech = deployments.mech();
  const railgunSmartWallet = deployments.railgunSmartWallet();

  if (!isNFTMinted) {
    console.log("Minting NFT");
    const mintTx = {
      to: mech.tokenAddress,
      data: encodeMint(getCurrentEthersWallet().address, mech.tokenId),
    };
    await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      mintTx,
    );

    console.log("Waiting 5 secs for mint");
    await sleep(5000);

    console.log("Approving NFT");
    const approveTx = {
      to: mech.tokenAddress,
      data: encodeApprove(railgunSmartWallet.address, mech.tokenId),
    };
    await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      approveTx,
    );

    console.log("Waiting 5 secs for approve");
    await sleep(5000);
  } else {
    console.log("NFT already minted");
  }

  if (!isNFTShielded) {
    console.log("Shielding NFT");

    await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      await populateShieldTransaction({
        nftIn: [
          {
            nftAddress: mech.tokenAddress,
            nftTokenType: NFTTokenType.ERC721,
            tokenSubID: zeroPadValue(toBeHex(mech.tokenId), 32),
            amount: BigInt(1),
            recipientAddress: getCurrentRailgunAddress(),
          },
        ],
        erc20In: [],
      }),
    );
  } else {
    console.log("NFT already shielded");
  }

  if (!isMechDeployed) {
    console.log("Deploying Mech");
    await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      mechDeploymentTx(),
    );
  } else {
    console.log("Mech already deployed");
  }
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
