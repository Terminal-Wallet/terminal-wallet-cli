import {
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";
import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import deployments from "../deployments";

import { populateUnshieldTransaction } from "../railgun-primitives";
import { findAvailableMech } from "../status";

export async function depositIntoMech({
  /*
   * Assets to unshield FROM Railgun (these will be available in contract calls)
   */
  depositNFTs,
  depositERC20s,
}: {
  depositNFTs: RailgunNFTAmount[];
  depositERC20s: RailgunERC20Amount[];
}) {
  const entry = await findAvailableMech();
  if (!entry) {
    throw new Error("No available Mech found");
  }

  const { mechAddress } = entry;

  const transaction = await populateUnshieldTransaction({
    unshieldNFTs: depositNFTs.map((entry) => ({
      ...entry,
      recipientAddress: mechAddress,
    })),
    unshieldERC20s: depositERC20s.map((entry) => ({
      ...entry,
      recipientAddress: mechAddress,
    })),
  });

  await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    transaction,
  );
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
