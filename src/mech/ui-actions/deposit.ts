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
  unshieldNFTs = [],
  unshieldERC20s = [],
}: {
  unshieldNFTs?: RailgunNFTAmount[];
  unshieldERC20s?: RailgunERC20Amount[];
}) {
  if (unshieldNFTs.length + unshieldERC20s.length === 0) {
    throw new Error("Nothing to deposit");
  }

  const entry = await findAvailableMech();
  if (!entry) {
    throw new Error("No suitable Mech address found");
  }

  const { mechAddress } = entry;

  const transaction = await populateUnshieldTransaction({
    unshieldNFTs: unshieldNFTs.map((entry) => ({
      ...entry,
      recipientAddress: mechAddress,
    })),
    unshieldERC20s: unshieldERC20s.map((entry) => ({
      ...entry,
      recipientAddress: mechAddress,
    })),
  });

  const result = await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    transaction,
  );
  console.log("Waiting for deposit...");
  await result?.wait();
}

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}
