import { ContractTransaction, toBeHex, zeroPadValue } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";

import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";

import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { MetaTransaction } from "../http";
import { encodeMechExecute } from "../encode";
import { populateCrossTransaction } from "../railgun-primitives";

import { findAvailableMech } from "../status";

export async function executeViaMech(calls: MetaTransaction[]) {
  const entry = await findAvailableMech();
  if (!entry) {
    console.log("No available Mech for found");
    return;
  }

  const { mechAddress, tokenAddress, tokenId } = entry;

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

  const finalCalls = calls.map((t) => ({
    to: mechAddress,
    data: encodeMechExecute(t),
  }));

  const transaction = await populateCrossTransaction({
    unshieldNFTs: [myNFTOut],
    unshieldERC20s: [],
    crossContractCalls: finalCalls,
    shieldNFTs: [myNFTIn],
    shieldERC20s: [],
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
