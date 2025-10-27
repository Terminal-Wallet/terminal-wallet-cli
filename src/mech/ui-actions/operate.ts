import assert from "assert";

import {
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";

import { executeViaMech } from "./execute";
import { depositIntoMech } from "./deposit";
import { MetaTransaction } from "../http";

export async function operateMech({
  unshieldNFTs = [],
  unshieldERC20s = [],
  calls = [],
  shieldNFTs = [],
  shieldERC20s = [],
}: {
  unshieldNFTs?: RailgunNFTAmount[];
  unshieldERC20s?: RailgunERC20Amount[];
  calls?: MetaTransaction[];
  shieldNFTs?: RailgunNFTAmount[];
  shieldERC20s?: RailgunERC20Amount[];
}) {
  const hasDeposit = unshieldERC20s.length > 0 || unshieldNFTs.length > 0;
  const hasWithdrawal = shieldNFTs.length > 0 || shieldERC20s.length > 0;
  const hasExecution = calls.length > 0;

  if (hasExecution || hasWithdrawal) {
    // execute
    await executeViaMech({
      unshieldNFTs,
      unshieldERC20s,
      calls,
      shieldNFTs,
      shieldERC20s,
    });
  } else {
    assert(hasDeposit);
    await depositIntoMech({
      shieldNFTs,
      shieldERC20s,
    });
  }
}
