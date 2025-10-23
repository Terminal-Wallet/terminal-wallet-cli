import { Interface, toBeHex, zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";

import { mechStatus } from "./status";
import {
  mechAddress,
  nftAddress,
  nftTokenId,
  populateMechDeployment,
  populateMint,
  relayAdaptAddress,
} from "../deployments";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";

import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { MetaTransaction } from "../http";
import { populateCrossTransaction } from "../populate/populateCrossTransaction";

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}

export async function execFromMech(calls: MetaTransaction[]) {
  const { isMechDeployed, isNFTMinted, isNFTSpendable } = await mechStatus();

  if (isNFTMinted && !isNFTSpendable) {
    console.log("Gotta wait");
    return;
  }

  const myNFTOut = {
    nftAddress: nftAddress(),
    nftTokenType: NFTTokenType.ERC721,
    tokenSubID: zeroPadValue(toBeHex(nftTokenId()), 32),
    amount: BigInt(1),
  };

  const myNFTIn = {
    ...myNFTOut,
    recipientAddress: getCurrentRailgunAddress(),
  };

  const deployMetaTx: MetaTransaction = {
    value: 0,
    ...(populateMechDeployment() as { to: string; data: string }),
    operation: 0,
  };

  const mintMetaTx: MetaTransaction = {
    value: 0,
    ...(populateMint(relayAdaptAddress()) as { to: string; data: string }),
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
    .map((t) => encodeThroughMech(t as MetaTransaction));

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

function encodeThroughMech({ to, value, data, operation }: MetaTransaction) {
  const iface = new Interface([
    "function execute(address to, uint256 value, bytes calldata data, uint8 operation) public payable returns (bytes memory returnData)",
  ]);
  return {
    to: mechAddress(),
    data: iface.encodeFunctionData("execute", [
      to,
      BigInt(value),
      data,
      operation,
    ]),
  };
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
