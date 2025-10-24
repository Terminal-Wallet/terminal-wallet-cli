import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { status } from "../status";

import { mechDeploymentTx } from "../deployments";

export async function deployMech() {
  const entries = await status();

  const hit = entries.find(
    (e) => e.isNFTShielded && !e.isNFTBlocked && !e.isMechDeployed,
  );
  if (!hit) {
    console.log(`No suitable NFT to use for Mech Deploy`);
    return;
  }

  const { tokenId } = hit;

  console.log("Deploying Mech");
  const result = await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    mechDeploymentTx(tokenId),
  );
  console.log("Waiting for Mech deployment...");
  await result?.wait();
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
