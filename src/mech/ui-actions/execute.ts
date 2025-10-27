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

import { MetaTransaction } from "../http";
import { encodeMechExecute, encodeTranfer, encodeTranferFrom } from "../encode";
import { populateCrossTransaction } from "../railgun-primitives";

import deployments, { mechDeploymentTx } from "../deployments";
import { findAvailableMech } from "../status";

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

  const _0zkAddress = getCurrentRailgunAddress();
  const { mechAddress, tokenAddress, tokenId, isMechDeployed } = entry;

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

  const callsFromMech = [
    ...calls,
    ...encodeTransferToRelayAdapt({ mechAddress, shieldNFTs, shieldERC20s }),
  ].map((t) => ({
    to: mechAddress,
    data: encodeMechExecute(t),
  }));

  const transaction = await populateCrossTransaction({
    unshieldNFTs: [myNFTOut, ...unshieldNFTs],
    unshieldERC20s,
    crossContractCalls: isMechDeployed
      ? callsFromMech
      : [mechDeploymentTx(tokenId), ...callsFromMech],
    shieldNFTs: [
      ...shieldNFTs.map((e) => ({
        ...e,
        recipientAddress: _0zkAddress,
      })),
      myNFTIn,
    ],
    shieldERC20s: shieldERC20s.map((e) => ({
      ...e,
      recipientAddress: _0zkAddress,
    })),
  });

  const result = await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    transaction,
  );
  console.log("Waiting for execution...");
  await result?.wait();
}

/*
 * These move the withdraw assets into RelayAdpt
 *
 */
function encodeTransferToRelayAdapt({
  mechAddress,
  shieldNFTs = [],
  shieldERC20s = [],
}: {
  mechAddress: string;
  shieldNFTs?: RailgunNFTAmount[];
  shieldERC20s?: RailgunERC20Amount[];
}) {
  const { relayAdapt } = deployments;

  return [
    ...shieldNFTs.map((e) => ({
      to: e.nftAddress,
      data: encodeTranferFrom(
        mechAddress,
        relayAdapt().address,
        BigInt(e.tokenSubID),
      ),
    })),
    ...shieldERC20s.map((e) => ({
      to: e.tokenAddress,
      data: encodeTranfer(relayAdapt().address, e.amount),
    })),
  ];
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
