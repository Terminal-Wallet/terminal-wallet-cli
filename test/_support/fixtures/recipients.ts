/** ERC20 amount-recipient fixtures (typed against the real SDK shape). */
import { RailgunERC20AmountRecipient } from "@railgun-community/shared-models";
import { TOKENS, oneUnit } from "./tokens";

/** A single ERC20 amount + recipient; defaults to 1 WETH to a 0zk address. */
export const erc20Recipient = (
  over: Partial<RailgunERC20AmountRecipient> = {},
): RailgunERC20AmountRecipient => ({
  tokenAddress: TOKENS.WETH.address,
  amount: oneUnit(TOKENS.WETH.decimals),
  recipientAddress: "0zk1recipientaddressfixture",
  ...over,
});

/** A 0x (public) recipient address fixture. */
export const publicRecipient = "0x1111111111111111111111111111111111111111";
/** A 0zk (private) recipient address fixture. */
export const privateRecipient = "0zk1recipientaddressfixture";
