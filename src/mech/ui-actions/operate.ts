import assert from "assert";

import {
  RailgunERC20Amount,
  RailgunNFTAmount,
} from "@railgun-community/shared-models";

import { executeViaMech } from "./execute";
import { depositIntoMech } from "./deposit";
import { MetaTransaction } from "../http";

/**
 * Unified mech operation handler that coordinates withdrawals executions and deposits
 *
 * Inputs:
 * - unshieldERC20s/unshieldNFTs: tokens to withdraw from Railgun into the mech
 * - calls: arbitrary transactions to execute via the mech
 * - shieldERC20s/shieldNFTs: tokens to deposit back into Railgun from the mech
 *
 * Routing logic:
 * - If there are calls to execute OR tokens to deposit back (shield): routes to executeViaMech:
 *   - Deposits: unshield and then transfers from relay to mech
 *   - Executions: wrapped as execution calls from mech
 *   - Withdrawals: encoded as transfers from mech to relay and then shield
 *
 * - If there are ONLY tokens to withdraw (unshield): routes to depositIntoMech which performs
 *   a simple unshield transaction directly to the mech address.
 *
 * Supports lazy deployment - the mech will be deployed automatically if needed.
 */

export async function operateMechDontUse({
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
  // const hasDeposit = unshieldERC20s.length > 0 || unshieldNFTs.length > 0;
  // const hasWithdrawal = shieldNFTs.length > 0 || shieldERC20s.length > 0;
  // const hasExecution = calls.length > 0;
  // if (hasExecution || hasWithdrawal) {
  //   // execute
  //   await executeViaMech({
  //     unshieldNFTs,
  //     unshieldERC20s,
  //     calls,
  //     shieldNFTs,
  //     shieldERC20s,
  //   });
  // } else {
  //   assert(hasDeposit);
  //   await depositIntoMech({
  //     shieldNFTs,
  //     shieldERC20s,
  //   });
  // }
}
