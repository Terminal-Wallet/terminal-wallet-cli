/**
 * Renderer-agnostic transaction input collection — uses the input-provider seam
 * (select/input), so it works on any host that implements the seam
 * from one code path. The pure parsing (buildRecipient) is unit-tested.
 *
 * Every sub-prompt can be cancelled (Esc/empty); when that happens the collector
 * surfaces a clear "Cancelled" notice and returns undefined, so a backed-out
 * dialog never aborts silently.
 */
import {
  NetworkName,
  RailgunERC20AmountRecipient,
  isDefined,
} from "@railgun-community/shared-models";
import { formatUnits, parseUnits } from "ethers";
import { getInputProvider, InputChoice } from "../../core/input";
import { getSaltedPassword } from "../../railgun/wallet/wallet-password";
import {
  getPrivateERC20BalancesForChain,
  getPublicERC20BalancesForChain,
  getWrappedTokenBalance,
} from "../../railgun/balance/balance-util";
import { getERC20TokenInfosForChain } from "../../railgun/balance/token-util";
import { getWrappedTokenInfoForChain } from "../../railgun/network/network-util";
import {
  getCurrentWalletName,
  getDefaultFeeModePref,
  getWalletInfoForName,
} from "../../railgun/wallet/wallet-util";
import { FeeMode, buildRecipient } from "../spec";
import { parseFeePref } from "../fee";
import { listExternalSigners } from "../../railgun/wallet/external-signers";
import { RailgunDisplayBalance } from "../../models/balance-models";
import { Zer0XSwapSelection } from "../../models/0x-models";

/** Self-signed fee (public wallet pays gas). The only option without broadcasters. */
export const selfSignFee = (): FeeMode => ({
  kind: "self-signer",
  signer: getWalletInfoForName(getCurrentWalletName()),
});

/**
 * The user's persisted DEFAULT fee mode, applied to new private sends. Resolves
 * an "external:<label>" preference to that signer (falling back to self-sign if
 * it's gone); a broadcaster is never a default (it's chosen live per-tx).
 */
export const resolveDefaultFee = (): FeeMode => {
  const parsed = parseFeePref(
    getDefaultFeeModePref(),
    listExternalSigners().map((s) => s.label),
  );
  return parsed.kind === "external-signer"
    ? { kind: "external-signer", label: parsed.label }
    : selfSignFee();
};

/** Notify a clean cancellation and return undefined (a backed-out sub-dialog). */
const cancelled = (note = "Cancelled — no transaction started."): undefined => {
  getInputProvider().notify(note);
  return undefined;
};

/** Unlock the wallet; notify + return undefined if the user cancels / mistypes. */
export const requireEncryptionKey = async (): Promise<string | undefined> => {
  const key = await getSaltedPassword();
  if (!isDefined(key)) {
    getInputProvider().notify("Cancelled — password required to continue.");
    return undefined;
  }
  return key;
};

/** A dimmed format hint for an address prompt, inferred from its label. */
const addressHint = (label: string): string =>
  /0zk/i.test(label)
    ? "RAILGUN 0zk… private address"
    : "Ethereum 0x… public address";

/** A dimmed "you hold N SYM" hint for an amount prompt. */
const heldHint = (symbol: string, readable: string): string =>
  `you hold ${readable} ${symbol}`;

/** Pick a token from balances (symbol + right-aligned balance). Cancels cleanly. */
const pickToken = async (
  balances: RailgunDisplayBalance[],
  message = "Select token",
): Promise<RailgunDisplayBalance | undefined> => {
  const provider = getInputProvider();
  if (!balances.length) {
    provider.notify("No token balances available.");
    return undefined;
  }
  const address = await provider.select(
    message,
    balances.map((b) => ({
      label: b.symbol,
      value: b.tokenAddress,
      hint: formatUnits(b.amount, b.decimals),
    })),
  );
  if (!address) return cancelled();
  return balances.find((b) => b.tokenAddress === address);
};

/**
 * Collect an ERC20 send: pick a token (private or public balances), amount, and
 * recipient. `recipient` overrides the prompt (e.g. own railgun address for shield).
 */
export const collectErc20Send = async (
  chainName: NetworkName,
  opts: { private: boolean; recipientLabel: string; recipient?: string },
): Promise<RailgunERC20AmountRecipient | undefined> => {
  const provider = getInputProvider();
  const balances = opts.private
    ? await getPrivateERC20BalancesForChain(chainName)
    : await getPublicERC20BalancesForChain(chainName, true);
  const token = await pickToken(balances);
  if (!token) return undefined; // pickToken surfaced the reason

  const amountStr = await provider.input(`Amount of ${token.symbol} to send`, {
    hint: heldHint(token.symbol, formatUnits(token.amount, token.decimals)),
  });
  if (!amountStr) return cancelled();

  const recipientAddress =
    opts.recipient ??
    (await provider.input(opts.recipientLabel, {
      hint: addressHint(opts.recipientLabel),
    }));
  if (!recipientAddress) return cancelled();

  const recipient = buildRecipient(token, amountStr, recipientAddress);
  if (!recipient) provider.notify("Invalid amount or recipient — try again.");
  return recipient;
};

/** Collect a wrapped base-token send (single token). */
export const collectBaseSend = async (
  chainName: NetworkName,
  opts: { useGasBalance: boolean; recipientLabel: string; recipient?: string },
): Promise<RailgunERC20AmountRecipient | undefined> => {
  const provider = getInputProvider();
  const wrapped = await getWrappedTokenBalance(chainName, opts.useGasBalance);

  const amountStr = await provider.input(`Amount of ${wrapped.symbol} to send`, {
    hint: heldHint(wrapped.symbol, wrapped.amountReadable),
  });
  if (!amountStr) return cancelled();

  const recipientAddress =
    opts.recipient ??
    (await provider.input(opts.recipientLabel, {
      hint: addressHint(opts.recipientLabel),
    }));
  if (!recipientAddress) return cancelled();

  const recipient = buildRecipient(
    { tokenAddress: wrapped.tokenAddress, decimals: wrapped.decimals },
    amountStr,
    recipientAddress,
  );
  if (!recipient) provider.notify("Invalid amount or recipient — try again.");
  return recipient;
};

/** Pure: build a recipient from a token + entered amount + address (undefined if invalid). */

/** Collect token → amount → recipient for a public transfer via the input-provider. */
export const collectPublicTransferInput = async (
  chainName: NetworkName,
): Promise<RailgunERC20AmountRecipient | undefined> => {
  const provider = getInputProvider();
  const balances = await getPublicERC20BalancesForChain(chainName, true);
  const token = await pickToken(balances, "Select token to send");
  if (!token) return undefined;

  const amountStr = await provider.input(`Amount of ${token.symbol} to send`, {
    hint: heldHint(token.symbol, formatUnits(token.amount, token.decimals)),
  });
  if (!amountStr) return cancelled();

  const recipientAddress = await provider.input(
    "Recipient public (0x) address",
    { hint: addressHint("0x") },
  );
  if (!recipientAddress) return cancelled();

  const recipient = buildRecipient(token, amountStr, recipientAddress);
  if (!recipient) provider.notify("Invalid amount or recipient — try again.");
  return recipient;
};

/**
 * Collect a 0x swap selection (sell token → amount → buy token) through the
 * seam, so it runs natively in blessed AND legacy. Sell from private balances
 * (private swap) or public balances + base token (public swap); buy from the
 * chain's known token list (+ base for public). The 0x quote is fetched by the
 * caller from this selection.
 */
export const collectSwapSelection = async (
  chainName: NetworkName,
  isPublic: boolean,
): Promise<Zer0XSwapSelection | undefined> => {
  const provider = getInputProvider();
  const wrapped = getWrappedTokenInfoForChain(chainName);

  // --- Sell token: balances (public swaps can also sell the base/gas token). ---
  const sellBalances = isPublic
    ? await getPublicERC20BalancesForChain(chainName, true)
    : await getPrivateERC20BalancesForChain(chainName);
  let sellOptions = sellBalances;
  if (isPublic) {
    const base = await getWrappedTokenBalance(chainName, true);
    sellOptions = [
      {
        name: base.name,
        symbol: base.symbol,
        amount: base.amount,
        decimals: base.decimals,
        tokenAddress: base.tokenAddress,
      },
      ...sellBalances,
    ];
  }
  const sellToken = await pickToken(sellOptions, "Sell which token?");
  if (!sellToken) return undefined;

  const amountStr = await provider.input(`Amount of ${sellToken.symbol} to swap`, {
    hint: heldHint(sellToken.symbol, formatUnits(sellToken.amount, sellToken.decimals)),
  });
  if (!amountStr) return cancelled();
  let amount: bigint;
  try {
    amount = parseUnits(amountStr, sellToken.decimals);
  } catch {
    provider.notify("Invalid amount — try again.");
    return undefined;
  }
  if (amount <= 0n) {
    provider.notify("Invalid amount — try again.");
    return undefined;
  }

  // --- Buy token: chain's known tokens (+ base for public), minus the sell token. ---
  const tokenInfos = (await getERC20TokenInfosForChain(chainName)).filter(
    (t) => t.symbol !== sellToken.symbol,
  );
  const buyChoices: InputChoice[] = tokenInfos.map((t) => ({
    label: t.symbol,
    value: t.tokenAddress,
    hint: t.name,
  }));
  if (isPublic && wrapped.symbol !== sellToken.symbol) {
    buyChoices.unshift({
      label: wrapped.symbol,
      value: wrapped.wrappedAddress,
      hint: wrapped.shortPublicName,
    });
  }
  if (!buyChoices.length) {
    provider.notify("No tokens available to swap into.");
    return undefined;
  }
  const buyAddress = await provider.select("Swap into", buyChoices);
  if (!buyAddress) return cancelled();

  // Base buy resolves to the wrapped symbol (matches the builder); else the token list.
  const buySymbol =
    tokenInfos.find((t) => t.tokenAddress === buyAddress)?.symbol ??
    wrapped.symbol;

  return {
    amount,
    symbol: sellToken.symbol,
    buySymbol,
    sellTokenAddress: sellToken.tokenAddress,
    buyTokenAddress: buyAddress,
  };
};
