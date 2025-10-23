import { toBeHex, zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";
import {
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";

import {
  mechAddress,
  nftAddress,
  nftTokenId,
  relayAdaptAddress,
} from "../deployments";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";

import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { populateCrossTransaction } from "../populate/populateCrossTransaction";

import { encodeThroughMech, encodeTranfer, encodeTranferFrom } from "../encode";

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}

export async function withdrawFromMech({
  withdrawNFTs,
  withdrawERC20s,
}: {
  withdrawNFTs: RailgunNFTAmount[];
  withdrawERC20s: RailgunERC20Amount[];
}) {
  const neuralLinkOut = {
    nftAddress: nftAddress(),
    nftTokenType: NFTTokenType.ERC721,
    tokenSubID: zeroPadValue(toBeHex(nftTokenId()), 32),
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
        mechAddress(),
        relayAdaptAddress(),
        BigInt(e.tokenSubID),
      ),
    })),
    // from mech -> adapt
    ...withdrawERC20s.map((e) => ({
      to: e.tokenAddress,
      data: encodeTranfer(relayAdaptAddress(), e.amount),
    })),
  ].map((tx) => ({ to: mechAddress(), data: encodeThroughMech(tx) }));

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

// function encodeDoSomething() {
//   const abi = [
//     "function transfer(address to, uint256 amount)",
//     "function doSomething(uint256 v)",
//   ];

//   // Create an Interface
//   const iface = new Interface(abi);

//   // Encode the function data
//   const data = iface.encodeFunctionData("doSomething", [919289128918298]);
//   return { to: "0x47C2a8aA719877d26a09B79419cBF65ddE833A58", data };
// }
