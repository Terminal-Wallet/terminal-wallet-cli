import { Interface, toBeHex, TransactionReceipt, zeroPadValue } from "ethers";
import { NFTTokenType } from "@railgun-community/shared-models";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { populateShieldTransaction } from "../railgun-primitives";

import { encodeApprove, encodeMint } from "../encode";

import deployments from "../deployments";
import { status } from "../status";

export async function mint() {
  const { railgunSmartWallet, railgunNeuralLink } = deployments;

  const entries = await status();

  if (entries.some((e) => !e.isNFTBlocked)) {
    console.log(`NFT already Minted and Shielded`);
    return;
  }

  console.log("Minting NFT");
  const mintTx = {
    to: railgunNeuralLink,
    data: encodeMint(),
  };
  const result = await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    mintTx,
  );

  console.log("Waiting for Mint transaction...");
  const receipt = await result?.wait(1);
  if (!receipt) {
    console.log("Failed");
    return;
  }
  const tokenId = tokenIdFromLog(receipt);

  {
    console.log("Approving NFT transfer");
    const approveTx = {
      to: railgunNeuralLink,
      data: encodeApprove(railgunSmartWallet().address, tokenId),
    };
    const result = await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      approveTx,
    );
    console.log("Waiting for Approve transaction...");
    await result?.wait();
  }

  {
    console.log("Shielding NFT");
    const result = await sendSelfSignedTransaction(
      selfSignerInfo(),
      getCurrentNetwork(),
      await populateShieldTransaction({
        nftIn: [
          {
            nftAddress: railgunNeuralLink,
            nftTokenType: NFTTokenType.ERC721,
            tokenSubID: zeroPadValue(toBeHex(tokenId), 32),
            amount: BigInt(1),
            recipientAddress: getCurrentRailgunAddress(),
          },
        ],
        erc20In: [],
      }),
    );
    console.log("Waiting for Shield transaction...");
    await result?.wait();
  }
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}

// Example: tx is a TransactionResponse
function tokenIdFromLog(receipt: TransactionReceipt) {
  const iface = new Interface([
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  ]);

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "Transfer") {
        return BigInt(parsed.args.tokenId); // BigInt
      }
    } catch (e) {
      // log not matching this iface, ignore
    }
  }

  throw new Error("No Transfer event found in transaction");
}
