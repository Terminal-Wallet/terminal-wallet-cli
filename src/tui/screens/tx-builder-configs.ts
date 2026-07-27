/**
 * Per-transaction-type configs for the live builder (ui-blessed/tx-builder.ts).
 * Each config declares its editable fields + token/address sources and a submit
 * that builds the spec and runs the TESTED pipeline (estimate → [prove] → send),
 * applying the gas chosen on the page. This is the blessed front-end for the 7
 * ERC20/base flows; swaps keep their staged flow (they need a live 0x quote).
 */
import { NetworkName, NETWORK_CONFIG } from "@railgun-community/shared-models";
import { RailgunDisplayBalance } from "../../models/balance-models";
import {
  getPrivateERC20BalancesForChain,
  getPublicERC20BalancesForChain,
  getWrappedTokenBalance,
} from "../../railgun/balance/balance-util";
import { getCurrentRailgunAddress } from "../../railgun/wallet/wallet-util";
import {
  getRailgunProxyAddressForChain,
  getWrappedTokenInfoForChain,
} from "../../railgun/network/network-util";
import { RailgunTransaction } from "../../models/transaction-models";
import {
  UnshieldSpec,
  ShieldSpec,
  UnshieldBaseSpec,
  ShieldBaseSpec,
  PublicTransferSpec,
  PublicBaseSpec,
  buildRecipient,
} from "../../flows/spec";
import { buildTransferSpec } from "../../flows/transfer-flow";
import { runTransferTransaction } from "../../flows/deps/transfer";
import {
  runUnshieldTransaction,
  runUnshieldBaseTransaction,
} from "../../flows/deps/unshield";
import {
  runShieldTransaction,
  runShieldBaseTransaction,
} from "../../flows/deps/shield";
import {
  runPublicTransferTransaction,
  runPublicBaseTransaction,
} from "../../flows/deps/public";
import {
  resolveDefaultFee,
  requireEncryptionKey,
} from "../../flows/collect/tx-input";
import {
  applyGasDetailsConfirm,
  applyGasPublicConfirm,
  runErc20Approvals,
} from "./tx-flow-helpers";
import { RunResult, SendOutcome } from "../../flows/run";
import { TxBuilderConfig } from "./tx-builder";
import { BuilderState, VaultChoice, PoolChoice } from "./tx-builder-core";
import {
  MORPHO_VAULTS,
  MorphoVaultAction,
  getMorphoVaultInputs,
  isMorphoSupportedNetwork,
} from "../../railgun/transaction/morpho/vault";
import { MorphoVaultAPI } from "@railgun-community/cookbook";
import { getProviderForChain } from "../../railgun/network/network-util";
import { getTokenInfo } from "../../railgun/balance/token-util";
import { runCrossContractTransaction } from "../../flows/deps/cross-contract";
import {
  FXMINT_GAS_FLOOR,
  getFxMintOpenInputs,
  isFxSupportedNetwork,
} from "../../railgun/transaction/fx/mint";
import { KNOWN_POOLS } from "@railgun-community/cookbook";
import {
  LegsState, Leg, toRecipients } from "../../flows/caps";
import { isNativeChoice, makeNativeEntry } from "../../flows/native-token";
import { parseUnits } from "ethers";
import { getZer0XSwapInputs } from "../../railgun/transaction/zeroX/0x-swap";
import { runPrivateSwapTransaction, runPublicSwapTransaction } from "../../flows/deps/swap";
import { PrivateSwapSpec, PublicSwapSpec } from "../../flows/spec";
import { getERC20TokenInfosForChain } from "../../railgun/balance/token-util";

const SWAP_SLIPPAGE_BPS = 320;

/** Buy-token options for swaps: the chain's known ERC20s (as display balances). */
const loadBuyTokens = async (chainName: NetworkName): Promise<RailgunDisplayBalance[]> => {
  const infos = await getERC20TokenInfosForChain(chainName);
  return infos.map((t) => ({
    symbol: t.symbol, name: t.name, tokenAddress: t.tokenAddress, decimals: t.decimals, amount: 0n,
  }));
};

/**
 * Quote a swap.
 *
 * The last argument is the wallet ENCRYPTION KEY, and only a private swap needs
 * it: the 7702 relay-adapt executes from an ephemeral account derived from it,
 * and the quote has to name that account as taker. Passing anything else here
 * derives the wrong account and fails to decrypt the wallet record.
 */
export const buildSwapInputs = async (
  chainName: NetworkName,
  sell: RailgunDisplayBalance,
  buy: RailgunDisplayBalance,
  amountStr: string,
  isPublic: boolean,
  encryptionKey?: string,
) => {
  const amount = parseUnits(amountStr, sell.decimals);
  const wrapped = getWrappedTokenInfoForChain(chainName);
  const inputs = await getZer0XSwapInputs(
    chainName,
    { tokenAddress: sell.tokenAddress, isBaseToken: wrapped.symbol === sell.symbol },
    { tokenAddress: buy.tokenAddress, isBaseToken: wrapped.symbol === buy.symbol },
    amount,
    SWAP_SLIPPAGE_BPS,
    isPublic,
    encryptionKey,
  );
  return { inputs, amount, sellIsBase: wrapped.symbol === sell.symbol };
};

/**
 * Vault rates move only with interest accrual and fees, so the quote and the
 * execution are near-identical. This is headroom against a same-block change,
 * not a real price tolerance — tight enough to be meaningful, loose enough that
 * a batch does not revert and cost the gas for nothing.
 */
const VAULT_SLIPPAGE_BPS = 100n;

/** Deposit floor 2.9M, redeem 2.8M — the recipes' own declared minimums. */
const VAULT_DEPOSIT_GAS_UNITS = 2_900_000n;
const VAULT_REDEEM_GAS_UNITS = 2_800_000n;

/**
 * The vaults on offer, each paired with the balance its action would spend: the
 * vault's asset for a deposit, its shares for a redemption. A vault the wallet
 * holds nothing for is still listed, showing zero, so the option is
 * discoverable rather than silently absent.
 */
const loadVaultChoices = async (
  chainName: NetworkName,
  action: MorphoVaultAction,
): Promise<VaultChoice[]> => {
  if (!isMorphoSupportedNetwork(chainName)) return [];
  const balances = await getPrivateERC20BalancesForChain(chainName);
  const provider = getProviderForChain(chainName);
  const choices: VaultChoice[] = [];
  for (const vault of MORPHO_VAULTS) {
    const data = await MorphoVaultAPI.getVaultData(
      vault.vaultAddress,
      provider,
    ).catch(() => undefined);
    if (!data) continue;
    const spendAddress =
      action === "deposit" ? data.assetAddress : vault.vaultAddress;
    const held = balances.find(
      (b) => b.tokenAddress.toLowerCase() === spendAddress.toLowerCase(),
    );
    if (held) {
      choices.push({ vault, token: held });
      continue;
    }
    const info = await getTokenInfo(chainName, spendAddress).catch(() => undefined);
    if (!info) continue;
    choices.push({
      vault,
      token: {
        symbol: info.symbol,
        name: info.name,
        tokenAddress: spendAddress,
        decimals: info.decimals,
        amount: 0n,
      },
    });
  }
  return choices;
};

type SubmitResult = { ok: boolean; error?: string };

/**
 * The build as a LegsState, for the fee gate. Multi-token flows have real legs;
 * a single-token flow is one synthetic leg so both measure the same way.
 */
const legsView = (s: BuilderState): LegsState | undefined => {
  if (s.legs) return s.legs;
  if (s.token && s.amount) {
    return { legs: [{ id: "__single", token: s.token, amount: s.amount }], seq: 1 };
  }
  return undefined;
};

const toResult = (r: RunResult<SendOutcome>): SubmitResult =>
  r.ok ? { ok: true } : { ok: false, error: r.error };

/** Consolidated recipients from the multi-leg state (empty if none complete). */
const legRecipients = (s: BuilderState) => (s.legs ? toRecipients(s.legs) : []);

/** Shared submit for both vault directions — only the action and label differ. */
const submitVault = async (
  chainName: NetworkName,
  action: MorphoVaultAction,
  type: RailgunTransaction,
  s: BuilderState,
): Promise<SubmitResult> => {
  if (!s.vault || !s.amount) return { ok: false, error: "incomplete" };
  const encryptionKey = await requireEncryptionKey();
  if (!encryptionKey) return { ok: false, error: "cancelled" };
  const amount = parseUnits(s.amount, s.vault.token.decimals);
  const inputs = await getMorphoVaultInputs(
    chainName,
    action,
    s.vault.vault,
    amount,
    VAULT_SLIPPAGE_BPS,
    encryptionKey,
  );
  return toResult(
    await runCrossContractTransaction(
      {
        type,
        chainName,
        inputs,
        encryptionKey,
        fee: s.fee ?? resolveDefaultFee(),
      },
      applyGasDetailsConfirm(s.gas, legsView(s)),
    ),
  );
};

/** Complete legs split into native (wrap/unwrap) and ERC20. */
const splitNative = (s: BuilderState): { native: Leg[]; erc20: Leg[] } => {
  const legs = (s.legs?.legs ?? []).filter((l) => l.token && l.amount && l.recipient);
  return {
    native: legs.filter((l) => isNativeChoice(l.token)),
    erc20: legs.filter((l) => !isNativeChoice(l.token)),
  };
};

/** Token picker entries: a native (ETH) entry + the ERC20 list. */
const withNativeEntry = (chainName: NetworkName, erc20: RailgunDisplayBalance[], nativeAmount: bigint) => {
  const { symbol, decimals } = NETWORK_CONFIG[chainName].baseToken;
  return [makeNativeEntry(symbol, decimals, nativeAmount), ...erc20];
};

/** Build the base-flow recipient for a native leg (uses the chain's wrapped token). */
const baseRecipient = (chainName: NetworkName, leg: Leg) => {
  const { wrappedAddress } = getWrappedTokenInfoForChain(chainName);
  const { decimals } = NETWORK_CONFIG[chainName].baseToken;
  return buildRecipient({ tokenAddress: wrappedAddress, decimals }, leg.amount ?? "", leg.recipient ?? "");
};

/** Guard: a native choice is a single base op (no mixing / no multi-native in v1). */
const nativeGuard = (native: Leg[], erc20: Leg[]): SubmitResult | undefined => {
  if (native.length && erc20.length)
    return { ok: false, error: "Do native ETH and ERC20s as separate transactions." };
  if (native.length > 1)
    return { ok: false, error: "One ETH recipient per transaction (do others separately)." };
  return undefined;
};

/** A wrapped base-token balance as a RailgunDisplayBalance (for the fixed token). */
const wrappedToken = async (
  chainName: NetworkName,
  useGasBalance: boolean,
): Promise<RailgunDisplayBalance> => {
  const w = await getWrappedTokenBalance(chainName, useGasBalance);
  return {
    name: w.name,
    symbol: w.symbol,
    amount: w.amount,
    decimals: w.decimals,
    tokenAddress: w.tokenAddress,
  };
};

/** Common gas display info for a chain (base token symbol + decimals). */
const gasInfo = (chainName: NetworkName) => {
  const { symbol, decimals } = getWrappedTokenInfoForChain(chainName);
  return { gasSymbol: symbol, gasDecimals: decimals };
};

// These drive the broadcaster-fee preview AND the amount the overspend check
// holds back, so an optimistic figure lets a build through that the real fee
// cannot cover. Where a figure is a bound rather than a measurement it says so:
// over-reserving costs the user some headroom, under-reserving costs a failed
// send after a proof.
const PRIVATE_GAS_UNITS = 250000n;
const PUBLIC_GAS_UNITS = 65000n;
/** Base-token shield: a 7702 relay-adapt bundle (wrap + shield), not a transfer.
 *  Upper bound — delegation + execute + wrapBase + a shield commitment. */
const SHIELD_BASE_GAS_UNITS = 450_000n;
/** Relay-adapt unshield-to-base: unshield + unwrap. Upper bound, not measured. */
const RELAY_ADAPT_BASE_GAS_UNITS = 1_700_000n;
/** Private 0x swap: above the 2,520,949 measured by scripts/swap-estimate-probe. */
const PRIVATE_SWAP_GAS_UNITS = 2_600_000n;
function baseSym(chainName: NetworkName): string {
  return NETWORK_CONFIG[chainName].baseToken.symbol;
}


/**
 * The f(x) pools on offer, each paired with the collateral balance it takes. A
 * pool the wallet holds no collateral for is still listed, showing zero, so the
 * option is discoverable rather than silently absent.
 */
const loadPoolChoices = async (
  chainName: NetworkName,
): Promise<PoolChoice[]> => {
  if (!isFxSupportedNetwork(chainName)) return [];
  const balances = await getPrivateERC20BalancesForChain(chainName);
  const choices: PoolChoice[] = [];
  for (const pool of KNOWN_POOLS) {
    const held = balances.find(
      (b) => b.tokenAddress.toLowerCase() === pool.collateralToken.toLowerCase(),
    );
    if (held) {
      choices.push({ pool, token: held });
      continue;
    }
    const info = await getTokenInfo(chainName, pool.collateralToken).catch(
      () => undefined,
    );
    if (!info) continue;
    choices.push({
      pool,
      token: {
        symbol: info.symbol,
        name: info.name,
        tokenAddress: pool.collateralToken,
        decimals: info.decimals,
        amount: 0n,
      },
    });
  }
  return choices;
};

const submitFxMintOpen = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<SubmitResult> => {
  if (!s.pool || !s.amount || !s.debt) return { ok: false, error: "incomplete" };
  const encryptionKey = await requireEncryptionKey();
  if (!encryptionKey) return { ok: false, error: "cancelled" };
  const collateral = parseUnits(s.amount, s.pool.token.decimals);
  // fxUSD is an 18-decimal token; the debt is denominated in it, not in the
  // pool's collateral.
  const targetDebt = parseUnits(s.debt, 18);
  const inputs = await getFxMintOpenInputs(
    chainName,
    s.pool.pool.name,
    collateral,
    targetDebt,
    encryptionKey,
  );
  return toResult(
    await runCrossContractTransaction(
      {
        type: RailgunTransaction.FxMintOpen,
        chainName,
        inputs,
        encryptionKey,
        fee: s.fee ?? resolveDefaultFee(),
      },
      applyGasDetailsConfirm(s.gas, legsView(s)),
    ),
  );
};

export const txBuilderConfigs: Record<
  string,
  (chainName: NetworkName) => TxBuilderConfig
> = {
  "private-transfer": (chainName) => ({
    title: "Send ERC20 — Privately",
    chainName,
    verb: "Send",
    fields: ["memo", "fee", "showSender", "gas"],
    multiLeg: true,
    flowId: "private-transfer",
    addressLabel: "Recipient private (0zk) address",
    // Spend flow: list only Spendable-bucket funds so overspend validation
    // matches what can actually be sent (POI/shield-pending balances can't).
    loadTokens: () => getPrivateERC20BalancesForChain(chainName),
    ...gasInfo(chainName),
    gasUnitsHint: PRIVATE_GAS_UNITS,
    relayAdapt: false,
    submit: async (s: BuilderState) => {
      const encryptionKey = await requireEncryptionKey();
      if (!encryptionKey) return { ok: false, error: "cancelled" };
      const recipients = legRecipients(s);
      if (!recipients.length) return { ok: false, error: "incomplete" };
      const spec = buildTransferSpec({
        chainName,
        recipients,
        encryptionKey,
        fee: s.fee ?? resolveDefaultFee(),
        memo: s.memo || undefined,
      });
      return toResult(await runTransferTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))));
    },
  }),

  "unshield-private-balances": (chainName) => ({
    title: "Unshield ERC20 → public",
    chainName,
    verb: "Unshield",
    fields: ["fee", "gas"],
    multiLeg: true,
    flowId: "unshield-private-balances",
    addressLabel: "Recipient public (0x) address",
    // Spend flow: Spendable-bucket only (see private-transfer); the native entry
    // already uses the Spendable wrapped balance.
    loadTokens: async () =>
      withNativeEntry(
        chainName,
        await getPrivateERC20BalancesForChain(chainName),
        (await getWrappedTokenBalance(chainName, false)).amount, // shielded wrapped balance
      ),
    ...gasInfo(chainName),
    gasUnitsHint: PRIVATE_GAS_UNITS,
    relayAdapt: false,
    submit: async (s: BuilderState) => {
      const encryptionKey = await requireEncryptionKey();
      if (!encryptionKey) return { ok: false, error: "cancelled" };
      const { native, erc20 } = splitNative(s);
      if (!native.length && !erc20.length) return { ok: false, error: "incomplete" };
      const guard = nativeGuard(native, erc20);
      if (guard) return guard;
      const fee = s.fee ?? resolveDefaultFee();
      if (native.length === 1) {
        const recipient = baseRecipient(chainName, native[0]); // unshield + unwrap to ETH
        if (!recipient) return { ok: false, error: "invalid amount or recipient" };
        const spec: UnshieldBaseSpec = {
          type: RailgunTransaction.UnshieldBase, chainName, recipient, encryptionKey, fee,
        };
        return toResult(await runUnshieldBaseTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))));
      }
      const recipients = toRecipients({ legs: erc20, seq: 0 });
      const spec: UnshieldSpec = {
        type: RailgunTransaction.Unshield,
        chainName,
        recipients, // single public recipient enforced by the legs matrix
        encryptionKey,
        fee,
      };
      return toResult(await runUnshieldTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))));
    },
  }),

  "shield-public-balances": (chainName) => ({
    title: "Shield ERC20 → private",
    chainName,
    verb: "Shield",
    fields: ["gas"],
    multiLeg: true,
    flowId: "shield-public-balances", // recipient defaults to own 0zk, editable to any 0zk
    addressLabel: "Recipient private (0zk) address",
    loadTokens: async () =>
      withNativeEntry(
        chainName,
        await getPublicERC20BalancesForChain(chainName, false),
        (await getWrappedTokenBalance(chainName, true)).amount, // native (gas) balance
      ),
    ...gasInfo(chainName),
    // The native leg is the expensive one and the only one gas is reserved
    // against, so the hint is sized for it.
    gasUnitsHint: SHIELD_BASE_GAS_UNITS,
    gasFromBalance: true,
    submit: async (s: BuilderState) => {
      const { native, erc20 } = splitNative(s);
      if (!native.length && !erc20.length) return { ok: false, error: "incomplete" };
      const guard = nativeGuard(native, erc20);
      if (guard) return guard;
      if (native.length === 1) {
        const recipient = baseRecipient(chainName, native[0]); // wrap ETH + shield
        if (!recipient) return { ok: false, error: "invalid amount or recipient" };
        // Self-signed, but still a 7702 bundle: the ephemeral account that
        // executes the wrap+shield is derived from the encryption key.
        const encryptionKey = await requireEncryptionKey();
        if (!encryptionKey) return { ok: false, error: "cancelled" };
        const spec: ShieldBaseSpec = {
          type: RailgunTransaction.ShieldBase,
          chainName,
          recipient,
          encryptionKey,
        };
        return toResult(await runShieldBaseTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))));
      }
      const recipients = toRecipients({ legs: erc20, seq: 0 });
      const spender = getRailgunProxyAddressForChain(chainName);
      if (!(await runErc20Approvals(chainName, recipients, spender)))
        return { ok: false, error: "approvals not completed" };
      const spec: ShieldSpec = { type: RailgunTransaction.Shield, chainName, recipients };
      return toResult(await runShieldTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))));
    },
  }),

  "public-transfer": (chainName) => ({
    title: "Send ERC20 — Publicly",
    chainName,
    verb: "Send",
    fields: ["gas"],
    multiLeg: true,
    flowId: "public-transfer",
    addressLabel: "Recipient public (0x) address",
    loadTokens: async () =>
      withNativeEntry(
        chainName,
        await getPublicERC20BalancesForChain(chainName, false),
        (await getWrappedTokenBalance(chainName, true)).amount, // native (gas) balance
      ),
    ...gasInfo(chainName),
    gasUnitsHint: PUBLIC_GAS_UNITS,
    gasFromBalance: true,
    submit: async (s: BuilderState) => {
      const { native, erc20 } = splitNative(s);
      if (!native.length && !erc20.length) return { ok: false, error: "incomplete" };
      const guard = nativeGuard(native, erc20);
      if (guard) return guard;
      if (native.length === 1) {
        const recipient = baseRecipient(chainName, native[0]); // native ETH send
        if (!recipient) return { ok: false, error: "invalid amount or recipient" };
        const spec: PublicBaseSpec = { type: RailgunTransaction.PublicBaseTransfer, chainName, recipient };
        return toResult(await runPublicBaseTransaction(spec, applyGasPublicConfirm(s.gas)));
      }
      // Public multi-recipient = N sequential (NON-atomic) transfers.
      let sent = 0;
      for (const recipient of toRecipients({ legs: erc20, seq: 0 })) {
        const spec: PublicTransferSpec = {
          type: RailgunTransaction.PublicTransfer,
          chainName,
          recipient,
        };
        const r = await runPublicTransferTransaction(spec, applyGasPublicConfirm(s.gas));
        if (!r.ok) {
          return { ok: false, error: sent ? `sent ${sent}, then failed: ${r.error}` : r.error };
        }
        sent++;
      }
      return { ok: true };
    },
  }),

  "base-unshield": (chainName) => ({
    title: `Unshield ${baseSym(chainName)} → public`,
    chainName,
    verb: "Unshield",
    fields: ["amount", "address", "fee", "gas"],
    addressLabel: "Recipient public (0x) address",
    fixedToken: () => wrappedToken(chainName, false),
    ...gasInfo(chainName),
    gasUnitsHint: RELAY_ADAPT_BASE_GAS_UNITS,
    relayAdapt: true,
    submit: async (s: BuilderState) => {
      const encryptionKey = await requireEncryptionKey();
      if (!encryptionKey) return { ok: false, error: "cancelled" };
      if (!s.token || !s.amount || !s.address) return { ok: false, error: "incomplete" };
      const recipient = buildRecipient(s.token, s.amount, s.address);
      if (!recipient) return { ok: false, error: "invalid amount or recipient" };
      const spec: UnshieldBaseSpec = {
        type: RailgunTransaction.UnshieldBase,
        chainName,
        recipient,
        encryptionKey,
        fee: s.fee ?? resolveDefaultFee(),
      };
      return toResult(
        await runUnshieldBaseTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))),
      );
    },
  }),

  "base-shield": (chainName) => ({
    title: `Shield ${baseSym(chainName)} → private`,
    chainName,
    verb: "Shield",
    fields: ["amount", "gas"],
    fixedToken: () => wrappedToken(chainName, true),
    fixedAddress: getCurrentRailgunAddress(),
    ...gasInfo(chainName),
    gasUnitsHint: SHIELD_BASE_GAS_UNITS,
    gasFromBalance: true,
    submit: async (s: BuilderState) => {
      if (!s.token || !s.amount || !s.address) return { ok: false, error: "incomplete" };
      const recipient = buildRecipient(s.token, s.amount, s.address);
      if (!recipient) return { ok: false, error: "invalid amount" };
      // Self-signed, but still a 7702 bundle — see above.
      const encryptionKey = await requireEncryptionKey();
      if (!encryptionKey) return { ok: false, error: "cancelled" };
      const spec: ShieldBaseSpec = {
        type: RailgunTransaction.ShieldBase,
        chainName,
        recipient,
        encryptionKey,
      };
      return toResult(
        await runShieldBaseTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))),
      );
    },
  }),

  "public-base-transfer": (chainName) => ({
    title: `Send ${baseSym(chainName)} — Publicly`,
    chainName,
    verb: "Send",
    fields: ["amount", "address", "gas"],
    addressLabel: "Recipient public (0x) address",
    fixedToken: () => wrappedToken(chainName, true),
    ...gasInfo(chainName),
    gasUnitsHint: PUBLIC_GAS_UNITS,
    gasFromBalance: true,
    submit: async (s: BuilderState) => {
      if (!s.token || !s.amount || !s.address) return { ok: false, error: "incomplete" };
      const recipient = buildRecipient(s.token, s.amount, s.address);
      if (!recipient) return { ok: false, error: "invalid amount or recipient" };
      const spec: PublicBaseSpec = {
        type: RailgunTransaction.PublicBaseTransfer,
        chainName,
        recipient,
      };
      return toResult(
        await runPublicBaseTransaction(spec, applyGasPublicConfirm(s.gas)),
      );
    },
  }),

  "private-swap": (chainName) => ({
    title: "Swap ERC20 — Privately (0x)",
    chainName,
    verb: "Swap",
    // No destination field: the relay-adapt recipe forces the wallet's own 0zk
    // address as the recipient, so there is nothing for one to set.
    fields: ["token", "buyToken", "amount", "fee", "showSender", "gas"],
    // Spend flow: Spendable-bucket only (see private-transfer).
    loadTokens: () => getPrivateERC20BalancesForChain(chainName),
    loadBuyTokens: () => loadBuyTokens(chainName),
    ...gasInfo(chainName),
    gasUnitsHint: PRIVATE_SWAP_GAS_UNITS,
    relayAdapt: true,
    submit: async (s: BuilderState) => {
      if (!s.token || !s.buyToken || !s.amount) return { ok: false, error: "incomplete" };
      const encryptionKey = await requireEncryptionKey();
      if (!encryptionKey) return { ok: false, error: "cancelled" };
      // Quoted fresh at submit, as the reference does. The preview's quote is
      // for display; the recipe and its cross-contract calls are bound to the
      // ephemeral taker derived at quote time, so spending against a carried
      // one is a deviation this path has not earned.
      const { token: sell, buyToken: buy, amount: amountStr } = s;
      const { inputs } = await buildSwapInputs(
        chainName,
        sell,
        buy,
        amountStr,
        false,
        encryptionKey,
      );
      if (!inputs?.quote) return { ok: false, error: "no swap quote for that pair" };
      const spec: PrivateSwapSpec = {
        type: RailgunTransaction.Private0XSwap,
        chainName,
        inputs,
        encryptionKey,
        fee: s.fee ?? resolveDefaultFee(),
      };
      return toResult(await runPrivateSwapTransaction(spec, applyGasDetailsConfirm(s.gas, legsView(s))));
    },
  }),

  "public-swap": (chainName) => ({
    title: "Swap ERC20 — Publicly (0x)",
    chainName,
    verb: "Swap",
    fields: ["token", "buyToken", "amount", "gas"],
    loadTokens: () => getPublicERC20BalancesForChain(chainName, true),
    loadBuyTokens: () => loadBuyTokens(chainName),
    ...gasInfo(chainName),
    gasUnitsHint: PUBLIC_GAS_UNITS,
    submit: async (s: BuilderState) => {
      if (!s.token || !s.buyToken || !s.amount) return { ok: false, error: "incomplete" };
      const { token: sell, buyToken: buy, amount: amountStr } = s;
      const { inputs, amount, sellIsBase } = await buildSwapInputs(
        chainName,
        sell,
        buy,
        amountStr,
        true,
      );
      if (!inputs?.quote) return { ok: false, error: "no swap quote for that pair" };
      if (!sellIsBase) {
        const approved = await runErc20Approvals(
          chainName,
          [{ tokenAddress: s.token.tokenAddress, amount, recipientAddress: "" }],
          inputs.quote.spender,
        );
        if (!approved) return { ok: false, error: "approvals not completed" };
      }
      const spec: PublicSwapSpec = {
        type: RailgunTransaction.Public0XSwap,
        chainName,
        swapTransaction: inputs.quote.crossContractCall,
      };
      return toResult(await runPublicSwapTransaction(spec, applyGasPublicConfirm(s.gas)));
    },
  }),

  "morpho-vault-deposit": (chainName) => ({
    title: "Deposit into a Morpho vault — Privately",
    chainName,
    verb: "Deposit",
    // No token row: the vault is what decides which asset this spends.
    fields: ["vault", "amount", "fee", "gas"],
    loadVaults: () => loadVaultChoices(chainName, "deposit"),
    ...gasInfo(chainName),
    gasUnitsHint: VAULT_DEPOSIT_GAS_UNITS,
    relayAdapt: true,
    submit: (s: BuilderState) =>
      submitVault(chainName, "deposit", RailgunTransaction.MorphoVaultDeposit, s),
  }),

  "fx-mint-open": (chainName) => ({
    title: "Mint fxUSD against collateral — Privately",
    chainName,
    verb: "Mint",
    // No token row: the pool decides which collateral this takes.
    fields: ["pool", "amount", "debt", "fee", "gas"],
    loadPools: () => loadPoolChoices(chainName),
    ...gasInfo(chainName),
    gasUnitsHint: FXMINT_GAS_FLOOR,
    relayAdapt: true,
    submit: (s: BuilderState) => submitFxMintOpen(chainName, s),
  }),

  "morpho-vault-redeem": (chainName) => ({
    title: "Redeem from a Morpho vault — Privately",
    chainName,
    verb: "Redeem",
    fields: ["vault", "amount", "fee", "gas"],
    loadVaults: () => loadVaultChoices(chainName, "redeem"),
    ...gasInfo(chainName),
    gasUnitsHint: VAULT_REDEEM_GAS_UNITS,
    relayAdapt: true,
    submit: (s: BuilderState) =>
      submitVault(chainName, "redeem", RailgunTransaction.MorphoVaultRedeem, s),
  }),
};

