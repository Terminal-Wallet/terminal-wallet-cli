import { Interface, toBeHex } from "ethers";

import { NFTTokenType } from "@railgun-community/wallet";

import { mechStatus } from "./status";
import { mechAddress, nftAddress, nftTokenId } from "../deployments";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";

import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";
import { populateUnshieldTransaction } from "../populate/populateUnshieldTransaction";
import { MetaTransaction } from "../http";

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}

export async function execFromMech(transactions: MetaTransaction[]) {
  const { isMechDeployed, isNFTShielded, isNFTSpendable } = await mechStatus();

  if (!isMechDeployed) {
    throw new Error("Designated Mech is not deployed");
  }

  if (!isNFTShielded) {
    throw new Error("NFT is not shielded???");
  }

  if (!isNFTSpendable) {
    throw new Error("NFT is not spendable???");
  }

  const transaction = await populateUnshieldTransaction({
    nftOut: [
      {
        nftAddress: nftAddress(),
        nftTokenType: NFTTokenType.ERC721,
        tokenSubID: toBeHex(nftTokenId(), 32),
        amount: BigInt(1),
      },
    ],
    erc20Out: [],
    transactions: transactions.map((tx) => encodeThroughMech(tx)),
    nftIn: [
      {
        nftAddress: nftAddress(),
        nftTokenType: NFTTokenType.ERC721,
        tokenSubID: toBeHex(nftTokenId(), 32),
        amount: BigInt(1),
        recipientAddress: getCurrentRailgunAddress(),
      },
    ],
    erc20In: [],
  });

  await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    transaction,
  );
}

async function encodeThroughMech({
  to,
  value,
  data,
  operation,
}: MetaTransaction) {
  // Mech iface
  const iface = new Interface([
    "function execute(address to, uint256 value, bytes calldata data, uint8 operation) public payable returns (bytes memory returnData)",
  ]);
  return {
    to: mechAddress(),
    data: iface.encodeFunctionData("execute", [to, value, data, operation]),
  };
}
