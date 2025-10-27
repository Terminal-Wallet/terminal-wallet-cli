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

import { populateUnshieldTransaction } from "../railgun-primitives";
import { findAvailableMech } from "../status";

export async function depositIntoMech({
  /*
   * Assets to unshield FROM Railgun (these will be available in contract calls)
   */
  shieldNFTs,
  shieldERC20s,
}: {
  shieldNFTs: RailgunNFTAmount[];
  shieldERC20s: RailgunERC20Amount[];
}) {
  const entry = await findAvailableMech();
  if (!entry) {
    throw new Error("No suitable Mech address found");
  }

  const { mechAddress } = entry;

  const transaction = await populateUnshieldTransaction({
    unshieldNFTs: shieldNFTs.map((entry) => ({
      ...entry,
      recipientAddress: mechAddress,
    })),
    unshieldERC20s: shieldERC20s.map((entry) => ({
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
