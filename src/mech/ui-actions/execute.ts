import { toBeHex, zeroPadValue } from "ethers";
import {
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";
import { NFTTokenType } from "@railgun-community/wallet";

import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";

import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { encodeMechExecute, encodeTranfer, encodeTranferFrom } from "../encode";
import { findAvailableMech } from "../status";
import { MetaTransaction } from "../http";
import { populateCrossTransaction } from "../railgun-primitives";

import deployments, { mechDeploymentTx } from "../deployments";

export async function executeViaMech({
  unshieldNFTs = [],
  unshieldERC20s = [],
  calls,
  shieldNFTs = [],
  shieldERC20s = [],
}: {
  unshieldNFTs?: RailgunNFTAmount[];
  unshieldERC20s?: RailgunERC20Amount[];
  calls: MetaTransaction[];
  shieldNFTs?: RailgunNFTAmount[];
  shieldERC20s?: RailgunERC20Amount[];
}) {
  if (!calls.length) {
    console.log("No calls provided");
    return;
  }

  const entry = await findAvailableMech();
  if (!entry) {
    console.log("No NFT/Mech is Ready for execution");
    return;
  }

  const { address: relayAdaptAddress } = deployments.relayAdapt();
  const { mechAddress, tokenAddress, tokenId, isMechDeployed } = entry;

  const viaMech = (t: { to: string; data: string }) => ({
    to: mechAddress,
    data: encodeMechExecute(t),
  });
  const toOur0zk = <T>(t: T): T & { recipientAddress: string } => ({
    ...t,
    recipientAddress: getCurrentRailgunAddress(),
  });

  const myNFTOut = {
    nftAddress: tokenAddress,
    nftTokenType: NFTTokenType.ERC721,
    tokenSubID: zeroPadValue(toBeHex(tokenId), 32),
    amount: BigInt(1),
  };

  const myNFTIn = {
    ...myNFTOut,
    recipientAddress: getCurrentRailgunAddress(),
  };

  const deployment = isMechDeployed ? [] : [mechDeploymentTx(tokenId)];
  const execution = calls.map(viaMech);
  const withdrawal = [
    ...shieldNFTs.map((e) => ({
      to: e.nftAddress,
      data: encodeTranferFrom(
        mechAddress,
        relayAdaptAddress,
        BigInt(e.tokenSubID),
      ),
    })),
    ...shieldERC20s.map((e) => ({
      to: e.tokenAddress,
      data: encodeTranfer(relayAdaptAddress, e.amount),
    })),
  ].map(viaMech);

  const transaction = await populateCrossTransaction({
    unshieldNFTs: [myNFTOut, ...unshieldNFTs],
    unshieldERC20s,
    crossContractCalls: [...deployment, ...execution, ...withdrawal],
    shieldNFTs: [...shieldNFTs.map(toOur0zk), myNFTIn],
    shieldERC20s: shieldERC20s.map(toOur0zk),
  });

  const result = await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    transaction,
  );
  console.log("Waiting for execution...");
  await result?.wait();
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
