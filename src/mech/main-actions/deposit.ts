import { mechAddress, relayAdaptAddress } from "../deployments";
import {
  getCurrentRailgunAddress,
  getCurrentRailgunID,
} from "../../wallet/wallet-util";

import { sendSelfSignedTransaction } from "../../transaction/transaction-builder";
import { getCurrentNetwork } from "../../engine/engine";

import { populateUnshieldTransaction } from "../populate/populateUnshieldTransaction";
import {
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";
import { encodeTranfer, encodeTranferFrom } from "../encode";

function selfSignerInfo() {
  return {
    railgunWalletID: getCurrentRailgunID(),
    railgunWalletAddress: getCurrentRailgunAddress(),
    derivationIndex: 0,
  };
}

export async function depositIntoMech({
  // Assets to unshield FROM Railgun (these will be available in contract calls)
  depositNFTs,
  depositERC20s,
}: {
  depositNFTs: RailgunNFTAmount[];
  depositERC20s: RailgunERC20Amount[];
}) {
  // TODO: I think we can here just call RailgunDirectly and just transfer it to Mech. We don't need the RelayAdapt?

  const calls = [
    ...depositNFTs.map((e) => ({
      to: e.nftAddress,
      data: encodeTranferFrom(
        relayAdaptAddress(),
        mechAddress(),
        BigInt(e.tokenSubID),
      ),
    })),
    ...depositERC20s.map((e) => ({
      to: e.tokenAddress,
      data: encodeTranfer(mechAddress(), e.amount),
    })),
  ];

  const transaction = await populateUnshieldTransaction({
    unshieldNFTs: [...depositNFTs],
    unshieldERC20s: depositERC20s,
    crossContractCalls: calls,
    shieldNFTs: [],
    shieldERC20s: [],
  });

  await sendSelfSignedTransaction(
    selfSignerInfo(),
    getCurrentNetwork(),
    transaction,
  );
}
