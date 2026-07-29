/**
 * Quote a swap.
 *
 * The last argument is the wallet ENCRYPTION KEY, and only a private swap needs
 * it: the 7702 relay-adapt executes from an ephemeral account derived from it,
 * and the quote has to name that account as taker. Passing anything else here
 * derives the wrong account and fails to decrypt the wallet record — which is
 * not a type error, because a 0zk address is also a string, and is how every
 * private swap once died with "Unable to decrypt ciphertext."
 *
 * In `flows/` because the slippage default is the real payload. Calling
 * `getZer0XSwapInputs` directly gets its own default of 500 bps, so a second
 * host that re-derived this instead of sharing it would quietly quote 5%
 * slippage where the deck quotes 3.2%.
 */
import { parseUnits } from "ethers";
import { NetworkName } from "@railgun-community/shared-models";
import { getZer0XSwapInputs } from "../railgun/transaction/zeroX/0x-swap";
import { getWrappedTokenInfoForChain } from "../railgun/network/network-util";
import { RailgunDisplayBalance } from "../models/balance-models";

/**
 * The tolerance a swap is quoted at, in basis points.
 *
 * Shared rather than defaulted per call site: two hosts quoting the same swap
 * at different tolerances would show different minimums for the same trade.
 */
export const SWAP_SLIPPAGE_BPS = 320;

export const buildSwapInputs = async (
  chainName: NetworkName,
  sell: RailgunDisplayBalance,
  buy: RailgunDisplayBalance,
  amountStr: string,
  isPublic: boolean,
  encryptionKey?: string,
  slippageBps: number = SWAP_SLIPPAGE_BPS,
) => {
  const amount = parseUnits(amountStr, sell.decimals);
  const wrapped = getWrappedTokenInfoForChain(chainName);
  const inputs = await getZer0XSwapInputs(
    chainName,
    { tokenAddress: sell.tokenAddress, isBaseToken: wrapped.symbol === sell.symbol },
    { tokenAddress: buy.tokenAddress, isBaseToken: wrapped.symbol === buy.symbol },
    amount,
    slippageBps,
    isPublic,
    encryptionKey,
  );
  return { inputs, amount, sellIsBase: wrapped.symbol === sell.symbol };
};
