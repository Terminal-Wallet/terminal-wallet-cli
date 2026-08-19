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
import {
  BuilderState,
  VaultChoice,
  PoolChoice,
  PositionChoice,
  RecoveryChoice,
  FieldKey,
} from "./tx-builder-core";
import { listMorphoVaults } from "../../railgun/transaction/morpho/vault-registry";
import {
  MorphoVaultAction,
  getMorphoVaultInputs,
  isMorphoSupportedNetwork,
  isVaultGated,
} from "../../railgun/transaction/morpho/vault";
import { MorphoVaultAPI } from "@railgun-community/cookbook";
import { getProviderForChain } from "../../railgun/network/network-util";
import { getTokenInfo } from "../../railgun/balance/token-util";
import { runCrossContractTransaction } from "../../flows/deps/cross-contract";
import { DefiLeg, defiLegs } from "../format/defi-legs";
import { getCachedEncryptionKey } from "../../railgun/wallet/wallet-password";
import {
  RECOVERY_GAS_ESTIMATE_FLOOR,
  scanEphemeralAssets,
} from "../../railgun/wallet/ephemeral-recovery";
import {
  getCurrentEphemeralInfo,
  getEphemeralAddressForIndex,
} from "../../railgun/wallet/ephemeral-util";
import { tag as tagText } from "../format/tags";
import {
  FXMINT_GAS_FLOOR,
  getFxMintOpenInputs,
  isFxSupportedNetwork,
} from "../../railgun/transaction/fx/mint";
import { FX_ADDRESSES, KNOWN_POOLS, resolvePool } from "@railgun-community/cookbook";
import { getFxMintCloseInputs } from "../../railgun/transaction/fx/close";
import { getFxDustCloseInputs } from "../../railgun/transaction/fx/dust-close";
import {
  FxAdjustAction,
  getFxMintAdjustInputs,
} from "../../railgun/transaction/fx/adjust";
import {
  getPrivateNFTsForChain,
  getPrivateNFTBucketsForChain,
} from "../../railgun/balance/balance-cache";
import { describeNFTs } from "../../railgun/balance/nft-util";
import { fxPositionCollections } from "../../railgun/transaction/fx/position";
import { readFxPositionState } from "../../railgun/transaction/fx/position-state";
import { FxManagePlan, planFxManage } from "../../railgun/transaction/fx/manage";
import { mapLimited } from "../../util/concurrency";
import {
  LegsState, Leg, toRecipients } from "../../flows/caps";
import { isNativeChoice, makeNativeEntry } from "../../flows/native-token";
import { formatUnits, parseUnits } from "ethers";
import { getZer0XSwapInputs } from "../../railgun/transaction/zeroX/0x-swap";
import { runPrivateSwapTransaction, runPublicSwapTransaction } from "../../flows/deps/swap";
import { PrivateSwapSpec, PublicSwapSpec } from "../../flows/spec";
import {
  PRIVATE_GAS_UNITS,
  PUBLIC_GAS_UNITS,
  SHIELD_BASE_GAS_UNITS,
  RELAY_ADAPT_BASE_GAS_UNITS,
  PRIVATE_SWAP_GAS_UNITS,
} from "../../flows/gas-units";
import { getERC20TokenInfosForChain } from "../../railgun/balance/token-util";
import { runRecoveryTransaction } from "../../flows/deps/recovery";

/** Buy-token options for swaps: the chain's known ERC20s (as display balances). */
const loadBuyTokens = async (chainName: NetworkName): Promise<RailgunDisplayBalance[]> => {
  const infos = await getERC20TokenInfosForChain(chainName);
  return infos.map((t) => ({
    symbol: t.symbol, name: t.name, tokenAddress: t.tokenAddress, decimals: t.decimals, amount: 0n,
  }));
};

/**
 * The swap quote and its slippage default live in flows/swap-inputs.ts: calling
 * getZer0XSwapInputs directly takes its own 500bps default, so a second host
 * that re-derived this would quote 5% where the deck quotes 3.2%.
 */
import { buildSwapInputs, SWAP_SLIPPAGE_BPS } from "../../flows/swap-inputs";

export { buildSwapInputs, SWAP_SLIPPAGE_BPS };

/**
 * Vault rates move only with interest accrual and fees, so the quote and the
 * execution are near-identical. This is headroom against a same-block change,
 * not a real price tolerance — tight enough to be meaningful, loose enough that
 * a batch does not revert and cost the gas for nothing.
 */
const VAULT_SLIPPAGE_BPS = 100n;

/**
 * The recipes declare 2.9M for a deposit and 2.8M for a redeem, and a combo
 * meal 2.9M — but the first real fx mint proved 2.9M is not enough for a batch
 * whose tail is a shield: it reached the shield with 97k left and the shield
 * reverted, stranding everything at the ephemeral account.
 *
 * A vault combo has the same shape (swap, protocol call, shield) and less work
 * before the shield, so this is inferred from that measurement rather than
 * measured directly — hence lower than the fx floor, and still well above what
 * the recipes ask for. Revise when a vault batch has actually been run.
 */
const VAULT_DEPOSIT_GAS_UNITS = 3_500_000n;
const VAULT_REDEEM_GAS_UNITS = 3_500_000n;

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
  for (const vault of await listMorphoVaults(chainName)) {
    // The registry already carries the asset, so listing costs no RPC. Reading
    // it per vault made opening the picker one round trip per row, which with
    // twenty vaults was a visible stall. The build path still reads the vault
    // itself, so nothing is trusted from the API when funds move.
    const assetAddress =
      vault.assetAddress ??
      (await MorphoVaultAPI.getVaultData(vault.vaultAddress, provider)
        .then((d) => d.assetAddress)
        .catch(() => undefined));
    if (!assetAddress) continue;
    // A gated V2 vault refuses this wallet outright — the executor is a fresh
    // account that has never been allowlisted — and the batch would mine
    // having done nothing. Better absent than offered and broken.
    if (await isVaultGated(vault, provider).catch(() => false)) continue;
    const spendAddress = action === "deposit" ? assetAddress : vault.vaultAddress;
    const held = balances.find(
      (b) => b.tokenAddress.toLowerCase() === spendAddress.toLowerCase(),
    );
    if (held) {
      choices.push({ vault, token: held, yield: vault.netApy });
      continue;
    }
    const info = await getTokenInfo(chainName, spendAddress).catch(() => undefined);
    if (!info) continue;
    choices.push({
      vault,
      yield: vault.netApy,
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
 * Resolve a token address to a ticker for the batch breakdown.
 *
 * The private balances are what the wallet already knows about; anything else
 * — a swap's intermediate, a vault's share token on first use — falls back to
 * a short address rather than being dropped from the display.
 */
const symbolResolver = async (
  chainName: NetworkName,
): Promise<(tokenAddress: string) => string | undefined> => {
  let balances: RailgunDisplayBalance[] = [];
  try {
    balances = await getPrivateERC20BalancesForChain(chainName);
  } catch {
    // A ticker is a nicety; a missing one degrades to a short address.
  }
  const bySymbol = new Map<string, string>(
    balances.map((b) => [b.tokenAddress.toLowerCase(), b.symbol]),
  );
  for (const pool of KNOWN_POOLS) {
    // The name is "<exposure asset>-<side>", and that asset is the collateral
    // on a long but the debt on a short — a short deposits fxUSD to borrow it.
    // Reading `collateralToken` for every pool would relabel fxUSD as "stETH"
    // and then "WBTC".
    const exposureToken =
      pool.side === "short" ? pool.debtToken : pool.collateralToken;
    bySymbol.set(exposureToken.toLowerCase(), pool.name.split("-")[0]);
  }
  // Last, so it wins: fxUSD is one token whatever pool is being looked at.
  bySymbol.set(FX_ADDRESSES.fxUSD.toLowerCase(), "fxUSD");
  return (address: string) => bySymbol.get(address.toLowerCase());
};

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
  // A deposit is denominated in what it is paid with; a redemption is always
  // denominated in shares, and the chosen token is what it comes back AS.
  const denomination = action === "deposit" ? s.token ?? s.vault.token : s.vault.token;
  const counterpart =
    action === "deposit"
      ? s.token && {
          tokenAddress: s.token.tokenAddress,
          decimals: s.token.decimals,
          amount: 0n,
        }
      : s.buyToken && {
          tokenAddress: s.buyToken.tokenAddress,
          decimals: s.buyToken.decimals,
          amount: 0n,
        };
  const amount = parseUnits(s.amount, denomination.decimals);
  const inputs = await getMorphoVaultInputs(
    chainName,
    action,
    s.vault.vault,
    amount,
    VAULT_SLIPPAGE_BPS,
    encryptionKey,
    counterpart,
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

// The nominal gas units these flows reserve live in flows/gas-units.ts, so a
// second host holds back the same amount and computes the same `max`.
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
    // Longs only, for now. The cookbook serves both sides off one descriptor
    // and the write paths follow it, but the risk panel does not: it reads the
    // debt as 18-decimal dollars and reports "the collateral price at which you
    // are liquidated". On a short the debt is the volatile asset and the
    // collateral is the stable one, so that is the wrong axis, not a wrong
    // label. Offering shorts before it is generalised would put a confidently
    // wrong liquidation price in front of someone sizing a position.
    if (pool.side !== "long") continue;
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

/**
 * The fx positions the wallet actually holds, from the shielded NFT set.
 *
 * An f(x) pool is the ERC-721 collection and the token id is the position id,
 * so a shielded NFT from a known pool IS a position and nothing else has to be
 * read to list them.
 */
const loadPositionChoices = async (
  chainName: NetworkName,
): Promise<PositionChoice[]> => {
  if (!isFxSupportedNetwork(chainName)) return [];
  const collections = fxPositionCollections();
  const held = describeNFTs(
    getPrivateNFTsForChain(chainName),
    collections,
    getPrivateNFTBucketsForChain(chainName),
  ).flatMap(
    (nft) => {
      if (nft.kind !== "fx-position") return [];
      const pool = KNOWN_POOLS.find(
        (p) => p.address.toLowerCase() === nft.nftAddress.toLowerCase(),
      );
      if (!pool) return [];
      return [{ nft, pool, positionId: BigInt(nft.tokenSubID) }];
    },
  );
  // Read each one's live state so the picker can offer a choice someone can
  // actually make. Bounded, though a wallet holding enough positions for this
  // to matter is unlikely — the cost is two contract reads apiece.
  return mapLimited(held, 4, async (choice) => ({
    ...choice,
    state: await readFxPositionState(chainName, choice.pool.name, choice.positionId),
  }));
};

/**
 * Building the batch is how it is described — there is no cheaper source of
 * truth for what a chained recipe does. Each of these does exactly what its
 * submit does, minus the send.
 */
const previewVaultLegs = async (
  chainName: NetworkName,
  action: MorphoVaultAction,
  s: BuilderState,
): Promise<DefiLeg[]> => {
  const encryptionKey = getCachedEncryptionKey();
  if (!encryptionKey || !s.vault || !s.amount) return [];
  const denomination = action === "deposit" ? (s.token ?? s.vault.token) : s.vault.token;
  const counterpart =
    action === "deposit"
      ? s.token && { tokenAddress: s.token.tokenAddress, decimals: s.token.decimals, amount: 0n }
      : s.buyToken && {
          tokenAddress: s.buyToken.tokenAddress,
          decimals: s.buyToken.decimals,
          amount: 0n,
        };
  const build = await getMorphoVaultInputs(
    chainName,
    action,
    s.vault.vault,
    parseUnits(s.amount, denomination.decimals),
    VAULT_SLIPPAGE_BPS,
    encryptionKey,
    counterpart,
  );
  return defiLegs({ stepOutputs: build.steps } as never, await symbolResolver(chainName));
};

const previewFxOpenLegs = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<DefiLeg[]> => {
  const encryptionKey = getCachedEncryptionKey();
  if (!encryptionKey || !s.pool || !s.amount || !s.debt) return [];
  const payWith = s.token ?? s.pool.token;
  const build = await getFxMintOpenInputs(
    chainName,
    s.pool.pool.name,
    parseUnits(s.amount, payWith.decimals),
    parseUnits(s.debt, 18),
    encryptionKey,
    { tokenAddress: payWith.tokenAddress, decimals: payWith.decimals },
  );
  return defiLegs({ stepOutputs: build.steps } as never, await symbolResolver(chainName));
};

/**
 * The whole shielded balance of the debt token goes toward the debt here.
 *
 * A dust close exists to finish a position off, so holding some of the debt
 * token back would only make the swap larger than it needs to be.
 */
const shieldedDebtTokenFor = async (
  chainName: NetworkName,
  debtToken: string,
): Promise<bigint> => {
  const balances = await getPrivateERC20BalancesForChain(chainName);
  const held = balances.find(
    (b) => b.tokenAddress.toLowerCase() === debtToken.toLowerCase(),
  );
  return held?.amount ?? 0n;
};

const dustCloseArgs = async (
  chainName: NetworkName,
  s: BuilderState,
  encryptionKey: string,
  // Which balance funds the shortfall. The dedicated card puts it in `token`;
  // the ordinary close puts it in `sellToken`, because there `token` is pinned
  // to fxUSD. Same batch either way.
  sell = s.token,
) => {
  if (!s.position || !sell) return undefined;
  const pool = resolvePool(s.position.pool.name);
  return [
    chainName,
    s.position.pool.name,
    s.position.positionId,
    await shieldedDebtTokenFor(chainName, pool.debtToken),
    { tokenAddress: sell.tokenAddress, decimals: sell.decimals },
    sell.amount,
    encryptionKey,
  ] as const;
};

const previewFxCloseLegs = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<DefiLeg[]> => {
  const encryptionKey = getCachedEncryptionKey();
  if (!encryptionKey || !s.position || !s.amount) return [];
  // Preview what will actually be sent: with a sell token the batch gains a
  // swap leg ahead of the repay, and showing the plain close would understate
  // it by the very leg the user chose.
  if (s.sellToken) {
    const args = await dustCloseArgs(chainName, s, encryptionKey, s.sellToken);
    if (!args) return [];
    const combo = await getFxDustCloseInputs(...args);
    return defiLegs(
      { stepOutputs: combo.steps } as never,
      await symbolResolver(chainName),
    );
  }
  const build = await getFxMintCloseInputs(
    chainName,
    s.position.pool.name,
    s.position.positionId,
    parseUnits(s.amount, 18),
    encryptionKey,
    s.buyToken && {
      tokenAddress: s.buyToken.tokenAddress,
      decimals: s.buyToken.decimals,
    },
  );
  return defiLegs({ stepOutputs: build.steps } as never, await symbolResolver(chainName));
};



const previewFxDustCloseLegs = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<DefiLeg[]> => {
  const encryptionKey = getCachedEncryptionKey();
  if (!encryptionKey) return [];
  const args = await dustCloseArgs(chainName, s, encryptionKey);
  if (!args) return [];
  const build = await getFxDustCloseInputs(...args);
  return defiLegs({ stepOutputs: build.steps } as never, await symbolResolver(chainName));
};

const submitFxDustClose = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<SubmitResult> => {
  if (!s.position || !s.token) return { ok: false, error: "incomplete" };
  const encryptionKey = await requireEncryptionKey();
  if (!encryptionKey) return { ok: false, error: "cancelled" };
  const args = await dustCloseArgs(chainName, s, encryptionKey);
  if (!args) return { ok: false, error: "incomplete" };
  const inputs = await getFxDustCloseInputs(...args);
  return toResult(
    await runCrossContractTransaction(
      {
        // The same kind of transaction as an ordinary close — relay-adapt,
        // proved, 7702 — so it reuses the type rather than inventing one the
        // capability matrix would have to learn about.
        type: RailgunTransaction.FxMintClose,
        chainName,
        inputs,
        encryptionKey,
        fee: s.fee ?? resolveDefaultFee(),
      },
      applyGasDetailsConfirm(s.gas, legsView(s)),
    ),
  );
};

/** The four adjust actions, as builder cards. Same shape, different deltas. */
const ADJUST_CARDS: {
  id: string;
  action: FxAdjustAction;
  type: RailgunTransaction;
  title: string;
  verb: string;
  /** Rows beyond the position, in display order. */
  fields: FieldKey[];
}[] = [
  {
    id: "fx-mint-topup",
    action: "topup",
    type: RailgunTransaction.FxMintTopup,
    title: "Add collateral to an f(x) position — Privately",
    verb: "Top up",
    fields: ["token", "amount"],
  },
  {
    id: "fx-mint-topup-borrow",
    action: "topup-and-borrow",
    type: RailgunTransaction.FxMintTopupBorrow,
    title: "Add collateral and borrow more — Privately",
    verb: "Top up",
    fields: ["token", "amount", "debt"],
  },
  {
    id: "fx-mint-borrow-more",
    action: "borrow-more",
    type: RailgunTransaction.FxMintBorrowMore,
    // Borrowing against collateral already posted spends nothing up front, so
    // there is no token or amount row at all.
    title: "Borrow more against an f(x) position — Privately",
    verb: "Borrow",
    fields: ["debt"],
  },
  {
    id: "fx-mint-repay",
    action: "repay",
    type: RailgunTransaction.FxMintRepay,
    // Always fxUSD: the debt is denominated in it and no shipped combo swaps
    // into it, which is the same asymmetry the close card has.
    title: "Repay an f(x) position's debt — Privately",
    verb: "Repay",
    fields: ["amount"],
  },
];

const adjustAmounts = (action: FxAdjustAction, s: BuilderState) => {
  const spendDecimals =
    action === "repay" ? 18 : (s.token?.decimals ?? s.position?.pool.collateralDecimals ?? 18);
  return {
    amount: s.amount ? parseUnits(s.amount, Number(spendDecimals)) : 0n,
    debtChange: s.debt ? parseUnits(s.debt, 18) : 0n,
  };
};

const buildAdjust = (
  chainName: NetworkName,
  action: FxAdjustAction,
  s: BuilderState,
) => {
  const { position } = s;
  if (!position) throw new Error("incomplete");
  const { amount, debtChange } = adjustAmounts(action, s);
  return (encryptionKey: string) =>
    getFxMintAdjustInputs(
      chainName,
      action,
      position.pool.name,
      position.positionId,
      amount,
      debtChange,
      encryptionKey,
      action === "repay" || !s.token
        ? undefined
        : { tokenAddress: s.token.tokenAddress, decimals: s.token.decimals },
    );
};

const previewAdjustLegs = async (
  chainName: NetworkName,
  action: FxAdjustAction,
  s: BuilderState,
): Promise<DefiLeg[]> => {
  const encryptionKey = getCachedEncryptionKey();
  if (!encryptionKey || !s.position) return [];
  const build = await buildAdjust(chainName, action, s)(encryptionKey);
  return defiLegs({ stepOutputs: build.steps } as never, await symbolResolver(chainName));
};

/**
 * The recipe a manage card's sliders resolve to, recomputed at submit.
 *
 * Not carried over from the preview: the preview is a display, and the send
 * path must not depend on it having been rendered or being current — the same
 * rule the send gates follow.
 */
const managePlanFor = (s: BuilderState): FxManagePlan | undefined => {
  const held = s.position?.state;
  if (!held) return undefined;
  const collateralDelta =
    s.amount && s.token ? parseUnits(s.amount, s.token.decimals) : 0n;
  const debtDelta = s.debt ? parseUnits(s.debt, 18) : 0n;
  const signed = (s.debtDeltaFrac ?? 0) < 0 ? -debtDelta : debtDelta;
  return planFxManage({ collateralDelta, debtDelta: signed });
};

const TYPE_FOR_ACTION: Record<FxAdjustAction, RailgunTransaction> = {
  topup: RailgunTransaction.FxMintTopup,
  "topup-and-borrow": RailgunTransaction.FxMintTopupBorrow,
  "borrow-more": RailgunTransaction.FxMintBorrowMore,
  repay: RailgunTransaction.FxMintRepay,
};

const submitAdjust = async (
  chainName: NetworkName,
  action: FxAdjustAction,
  type: RailgunTransaction,
  s: BuilderState,
): Promise<SubmitResult> => {
  if (!s.position) return { ok: false, error: "incomplete" };
  const encryptionKey = await requireEncryptionKey();
  if (!encryptionKey) return { ok: false, error: "cancelled" };
  const inputs = await buildAdjust(chainName, action, s)(encryptionKey);
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

const previewManageLegs = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<DefiLeg[]> => {
  const plan = managePlanFor(s);
  if (!plan?.ok) return [];
  return previewAdjustLegs(chainName, plan.action, s);
};

const submitManage = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<SubmitResult> => {
  const plan = managePlanFor(s);
  // Refused rather than approximated. The four recipes do not span every pair
  // of deltas, and running the nearest one would move collateral the user
  // never agreed to move.
  if (!plan) return { ok: false, error: "select a position first" };
  if (!plan.ok) return { ok: false, error: plan.reason };
  return submitAdjust(chainName, plan.action, TYPE_FOR_ACTION[plan.action], s);
};

const submitFxMintClose = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<SubmitResult> => {
  if (!s.position || !s.amount) return { ok: false, error: "incomplete" };
  const encryptionKey = await requireEncryptionKey();
  if (!encryptionKey) return { ok: false, error: "cancelled" };
  // Short of the debt token, and a token picked to cover it: the difference is
  // bought inside THIS batch rather than in a second transaction. The swap
  // output feeds the repay directly — nothing is re-shielded on the way
  // through — so it costs one proof and one broadcaster fee, not two.
  let inputs;
  if (s.sellToken) {
    const args = await dustCloseArgs(chainName, s, encryptionKey, s.sellToken);
    if (!args) return { ok: false, error: "incomplete" };
    inputs = await getFxDustCloseInputs(...args);
  } else {
    // The amount is the fxUSD put toward the debt; how much of it can actually
    // be repaid after both fees is the recipe's arithmetic, not the form's.
    const shieldedFxUSD = parseUnits(s.amount, 18);
    inputs = await getFxMintCloseInputs(
      chainName,
      s.position.pool.name,
      s.position.positionId,
      shieldedFxUSD,
      encryptionKey,
    );
  }
  return toResult(
    await runCrossContractTransaction(
      {
        type: RailgunTransaction.FxMintClose,
        chainName,
        inputs,
        encryptionKey,
        fee: s.fee ?? resolveDefaultFee(),
      },
      applyGasDetailsConfirm(s.gas, legsView(s)),
    ),
  );
};

const submitFxMintOpen = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<SubmitResult> => {
  if (!s.pool || !s.amount || !s.debt) return { ok: false, error: "incomplete" };
  const encryptionKey = await requireEncryptionKey();
  if (!encryptionKey) return { ok: false, error: "cancelled" };
  // The amount is in whatever is being spent — the collateral itself, or the
  // token being swapped into it.
  const payWith = s.token ?? s.pool.token;
  const collateral = parseUnits(s.amount, payWith.decimals);
  // fxUSD is an 18-decimal token; the debt is denominated in it, not in the
  // pool's collateral.
  const targetDebt = parseUnits(s.debt, 18);
  const inputs = await getFxMintOpenInputs(
    chainName,
    s.pool.pool.name,
    collateral,
    targetDebt,
    encryptionKey,
    { tokenAddress: payWith.tokenAddress, decimals: payWith.decimals },
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

/** How far back to look for a stranded account. */
const RECOVERY_SCAN_DEPTH = 8;

/**
 * The ephemeral accounts currently holding stranded value.
 *
 * Scans the recent indices rather than asking for one: an account only ends up
 * holding anything because a batch failed partway, and the user has no reason
 * to know which index that was.
 *
 * The indices are scanned CONCURRENTLY. Run one after another this was nine
 * scans of a dozen-odd RPC round trips each — well over a hundred calls in
 * series — behind a field that gives no sign it is working, so opening the
 * account picker looked like the screen had locked up.
 */
const loadRecoveryChoices = async (
  chainName: NetworkName,
): Promise<RecoveryChoice[]> => {
  const encryptionKey = getCachedEncryptionKey();
  if (!encryptionKey) return [];
  const { index: current } = await getCurrentEphemeralInfo(chainName, encryptionKey);
  // Backwards from the current index: a stranded account is one the wallet has
  // already ratcheted past, and the recent ones are where a failure lands.
  const indices: number[] = [];
  for (let index = current; index >= Math.max(0, current - RECOVERY_SCAN_DEPTH); index--) {
    indices.push(index);
  }
  const scanned = await Promise.all(
    indices.map(async (index): Promise<RecoveryChoice | undefined> => {
      const address = await getEphemeralAddressForIndex(chainName, encryptionKey, index);
      const scan = await scanEphemeralAssets(chainName, address).catch(() => undefined);
      if (!scan) return undefined;
      const parts = [
        ...(scan.nativeWei > 0n ? [`${formatUnits(scan.nativeWei, 18)} ETH`] : []),
        ...scan.erc20s.map((t) => `${formatUnits(t.balance, t.decimals)} ${t.symbol}`),
        ...scan.nfts.map((n) => n.label),
      ];
      if (!parts.length) {
        // Found nothing — but "found nothing" and "could not look" are not the
        // same answer, and dropping the second from the list is what turns a
        // throttled RPC into a stranded account the user never sees offered.
        if (scan.unreadable === 0) return undefined;
        return {
          index,
          address,
          summary: `${scan.unreadable} balance(s) unreadable — not confirmed empty`,
          scan,
        };
      }
      return { index, address, summary: parts.join(", "), scan };
    }),
  );
  return scanned.filter((c): c is RecoveryChoice => c !== undefined);
};

/**
 * Recovery moves whatever it finds, so the breakdown has to be built from the
 * scan rather than from a token and an amount.
 */
const recoveryLines = async (s: BuilderState): Promise<string[]> => {
  if (!s.account) return [];
  const { scan, index, address } = s.account;
  const lines = [
    `${tagText("recover", "gray")}  from ephemeral [${index}]`,
    `${tagText("account", "gray")}  ${address}`,
  ];
  if (scan.nativeWei > 0n) lines.push(`  ${formatUnits(scan.nativeWei, 18)} ETH  ${tagText("wrap → shield", "gray")}`);
  for (const t of scan.erc20s) {
    lines.push(`  ${formatUnits(t.balance, t.decimals)} ${t.symbol}  ${tagText("shield", "gray")}`);
  }
  for (const n of scan.nfts) lines.push(`  ${n.label}  ${tagText("position → shield", "gray")}`);
  if (scan.nativeWei === 0n && !scan.erc20s.length && !scan.nfts.length) {
    lines.push(`  ${tagText("nothing found to move", "gray")}`);
  }
  if (scan.unreadable > 0) {
    lines.push(
      tagText(
        `! ${scan.unreadable} balance(s) could not be read — rescan before trusting this list`,
        "red",
      ),
    );
  }
  if (scan.method === "tokenlist") {
    lines.push(tagText("! curated-list scan only — an arbitrary token may be missed", "yellow"));
  }
  return lines;
};

const submitRecovery = async (
  chainName: NetworkName,
  s: BuilderState,
): Promise<SubmitResult> => {
  if (!s.account) return { ok: false, error: "incomplete" };
  const { scan: picked } = s.account;
  if (picked.nativeWei === 0n && !picked.erc20s.length && !picked.nfts.length) {
    // Only reachable for an account listed because its scan was incomplete.
    return {
      ok: false,
      error: "nothing found at this account to recover — rescan and try again",
    };
  }
  const encryptionKey = await requireEncryptionKey();
  if (!encryptionKey) return { ok: false, error: "cancelled" };
  const { scan, index } = s.account;
  if (!s.fee) return { ok: false, error: "no fee mode selected" };
  // Through the shared runner, whose deps point `send` at the non-ratcheting
  // recovery submit. Building the batch here and submitting it directly is what
  // left the progress bar stuck at 100% with the failure hidden behind it —
  // `runTransaction` is the only thing that emits the terminating `tx:result`.
  const result = await runRecoveryTransaction({
    chainName,
    encryptionKey,
    targetIndex: index,
    selection: {
      erc20s: scan.erc20s,
      nativeWei: scan.nativeWei > 0n ? scan.nativeWei : undefined,
      nfts: scan.nfts,
    },
    fee: s.fee,
    gas: s.gas,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
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
    // The vault names the asset it wants; the token row is what you PAY with.
    // Anything other than the asset folds a 0x swap into the same batch.
    fields: ["vault", "token", "amount", "fee", "gas"],
    loadVaults: () => loadVaultChoices(chainName, "deposit"),
    loadTokens: () => getPrivateERC20BalancesForChain(chainName),
    previewLegs: (s) => previewVaultLegs(chainName, "deposit", s),
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
    // The pool names the collateral it wants; the token row is what you PAY
    // with. Anything other than the collateral folds a 0x swap in front.
    // Sliders rather than typed amounts: a position is found by moving one
    // and watching the debt ratio, not by knowing the numbers in advance.
    fields: ["pool", "token", "collateralPct", "debtRatio", "fee", "gas"],
    loadPools: () => loadPoolChoices(chainName),
    loadTokens: () => getPrivateERC20BalancesForChain(chainName),
    previewLegs: (s) => previewFxOpenLegs(chainName, s),
    ...gasInfo(chainName),
    gasUnitsHint: FXMINT_GAS_FLOOR,
    relayAdapt: true,
    submit: (s: BuilderState) => submitFxMintOpen(chainName, s),
  }),

  /**
   * One card for the four adjust recipes.
   *
   * They were four cards, which asks the wrong question first: nobody decides
   * to perform a "top-up-and-borrow", they decide they want more collateral in
   * or less debt owed, and the verb is a consequence. Two sliders express
   * every pair the recipes support, and `planFxManage` names the one that
   * runs — so the choice of recipe stops being a thing the user has to know
   * before they can start.
   */
  "fx-mint-manage": (chainName) => ({
    title: "Manage an f(x) position — Privately",
    chainName,
    verb: "Manage",
    fields: ["position", "token", "collateralPct", "debtDelta", "fee", "gas"],
    loadPositions: () => loadPositionChoices(chainName),
    loadTokens: () => getPrivateERC20BalancesForChain(chainName),
    previewLegs: (s) => previewManageLegs(chainName, s),
    ...gasInfo(chainName),
    gasUnitsHint: FXMINT_GAS_FLOOR,
    relayAdapt: true,
    submit: (s: BuilderState) => submitManage(chainName, s),
  }),

  "ephemeral-recovery": (chainName) => ({
    title: "Recover stranded funds — back into RAILGUN",
    chainName,
    verb: "Recover",
    // No token or amount: a recovery moves whatever the failed batch left.
    fields: ["account", "fee", "gas"],
    loadAccounts: () => loadRecoveryChoices(chainName),
    previewLines: recoveryLines,
    ...gasInfo(chainName),
    gasUnitsHint: RECOVERY_GAS_ESTIMATE_FLOOR,
    relayAdapt: true,
    submit: (s: BuilderState) => submitRecovery(chainName, s),
  }),

  "fx-mint-close": (chainName) => ({
    title: "Close an f(x) position — Privately",
    chainName,
    verb: "Close",
    // The amount is fxUSD put toward the debt: enough covers it and the
    // position is emptied, less makes it a partial close. The NFT survives
    // either way — f(x) does not burn positions.
    // The buy token is what the released collateral comes back AS; naming the
    // collateral itself means no swap. The debt is always repaid in fxUSD —
    // the cookbook's close combo swaps on the way out only.
    fields: ["position", "amount", "sellToken", "buyToken", "fee", "gas"],
    // Both are optional, for different reasons. The buy token CONVERTS the
    // released collateral; leaving it unset means the collateral comes back as
    // itself, which is what most closes want, and requiring it blocked a close
    // that was otherwise ready to send. The sell token only matters when the
    // shielded fxUSD does not cover the close — which the round trip makes
    // common — and it is asked for at that point rather than up front.
    optionalFields: ["buyToken", "sellToken"],
    amountIsPositionDebt: true,
    loadPositions: () => loadPositionChoices(chainName),
    loadBuyTokens: () => loadBuyTokens(chainName),
    // The pools' debt tokens are excluded: they repay directly and need no
    // swap. The pool's own collateral is deliberately NOT filtered — which
    // token that is depends on the position, and this runs before one is
    // chosen; the build rejects that pairing by name instead.
    loadSellTokens: async () => {
      const balances = await getPrivateERC20BalancesForChain(chainName);
      const debtTokens = new Set(
        KNOWN_POOLS.map((p) => p.debtToken.toLowerCase()),
      );
      return balances.filter(
        (b) => b.amount > 0n && !debtTokens.has(b.tokenAddress.toLowerCase()),
      );
    },
    previewLegs: (s) => previewFxCloseLegs(chainName, s),
    // Only fxUSD repays an f(x) debt, so there is nothing to pick.
    fixedToken: async () => {
      const balances = await getPrivateERC20BalancesForChain(chainName);
      return balances.find(
        (b) =>
          b.tokenAddress.toLowerCase() === FX_ADDRESSES.fxUSD.toLowerCase(),
      );
    },
    ...gasInfo(chainName),
    gasUnitsHint: FXMINT_GAS_FLOOR,
    relayAdapt: true,
    submit: (s: BuilderState) => submitFxMintClose(chainName, s),
  }),

  "fx-mint-dust-close": (chainName) => ({
    title: "Close an f(x) position outright — Privately",
    chainName,
    verb: "Close fully",
    // No amount field: the whole shielded balance of the debt token goes in,
    // and the shortfall is raised by selling the chosen token. The amount to
    // sell is computed, since deriving it means combining two fee ratios with
    // a swap rate — which is the thing this card exists to remove.
    fields: ["position", "token", "fee", "gas"],
    loadPositions: () => loadPositionChoices(chainName),
    // Private balances with something in them, minus the pool debt tokens —
    // those repay directly and need no swap at all.
    //
    // The pool's own COLLATERAL is not filtered here, deliberately. Which token
    // that is depends on the position, and this runs before one is chosen; a
    // blanket filter would hide WBTC while closing a wstETH pool. The build
    // rejects that pairing with a message naming the pool instead.
    loadTokens: async () => {
      const balances = await getPrivateERC20BalancesForChain(chainName);
      const debtTokens = new Set(
        KNOWN_POOLS.map((p) => p.debtToken.toLowerCase()),
      );
      return balances.filter(
        (b) => b.amount > 0n && !debtTokens.has(b.tokenAddress.toLowerCase()),
      );
    },
    previewLegs: (s) => previewFxDustCloseLegs(chainName, s),
    ...gasInfo(chainName),
    gasUnitsHint: FXMINT_GAS_FLOOR,
    relayAdapt: true,
    submit: (s: BuilderState) => submitFxDustClose(chainName, s),
  }),

  "morpho-vault-redeem": (chainName) => ({
    title: "Redeem from a Morpho vault — Privately",
    chainName,
    verb: "Redeem",
    // The amount is in shares; the buy token is what to come back AS, and
    // anything other than the vault's asset folds a 0x swap in behind it.
    fields: ["vault", "amount", "buyToken", "fee", "gas"],
    loadVaults: () => loadVaultChoices(chainName, "redeem"),
    loadBuyTokens: () => loadBuyTokens(chainName),
    previewLegs: (s) => previewVaultLegs(chainName, "redeem", s),
    ...gasInfo(chainName),
    gasUnitsHint: VAULT_REDEEM_GAS_UNITS,
    relayAdapt: true,
    submit: (s: BuilderState) =>
      submitVault(chainName, "redeem", RailgunTransaction.MorphoVaultRedeem, s),
  }),
};

