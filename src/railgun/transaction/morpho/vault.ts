/**
 * Morpho ERC-4626 vault deposits and redemptions, as private 7702 relay-adapt
 * batches.
 *
 * Both directions are a plain token round trip — asset in, shares out, or the
 * reverse — so they reduce to the generic CrossContractInputs the cross-contract
 * rail already runs. Nothing here is vault-specific past building the recipe.
 */
import { NetworkName, RailgunERC20Recipient } from "@railgun-community/shared-models";
import { Contract, ZeroAddress } from "ethers";
import {
  MorphoVaultAPI,
  MorphoVaultV1DepositRecipe,
  MorphoVaultV2DepositRecipe,
  MorphoVaultV1RedeemRecipe,
  MorphoVaultV2RedeemRecipe,
  MorphoVaultRedeem_ZeroXSwap_ComboMeal,
  ZeroXSwap_MorphoVaultDeposit_ComboMeal,
  RecipeERC20Amount,
  RecipeERC20Info,
  RecipeInput,
  RecipeOutput,
  makeEphemeralExecutor,
} from "@railgun-community/cookbook";
import { CrossContractInputs } from "../cross-contract";
import { getCurrentRailgunAddress } from "../../wallet/wallet-util";
import {
  getCurrentEphemeralInfo,
  syncEphemeralIndexOnce,
} from "../../wallet/ephemeral-util";
import { getProviderForChain } from "../../network/network-util";
import { createLogger } from "../../../platform/logger";

const log = createLogger("morpho-vault");

/** Deposit spends the vault's asset; redeem spends the vault's shares. */
export type MorphoVaultAction = "deposit" | "redeem";

/** Which MetaMorpho generation the vault is — they have different quote paths. */
export type MorphoVaultGeneration = "V1" | "V2";

export interface MorphoVaultRef {
  name: string;
  vaultAddress: string;
  generation: MorphoVaultGeneration;
}

/**
 * How wide the swap leg of a combo may slip.
 *
 * Only the swap needs this — the vault leg has its own, much tighter tolerance,
 * because an ERC-4626 rate barely moves. Matches the standalone private swap.
 */
export const VAULT_SWAP_SLIPPAGE_BPS = 320;

/**
 * The vaults offered in the builder.
 *
 * Curated rather than enumerated. Morpho lists hundreds and several carry live
 * `deposit_disabled` or bad-debt warnings, so an automatic list would offer
 * things a deposit or a redemption could fail on. These were each verified on
 * mainnet — name, asset, decimals, that `previewDeposit` answers, and which
 * generation they are — rather than taken from a document.
 *
 * The generation is not cosmetic: it picks the recipe subclass. V1 answers
 * `MORPHO()`, V2 answers `receiveAssetsGate()`, and every entry below was
 * classified by asking the contract.
 *
 * Deliberately not offered: DAI and wstETH. The only vaults for either are
 * around $1M of liquidity, which is not enough to be sure a redemption comes
 * back out.
 */
export const MORPHO_VAULTS: readonly MorphoVaultRef[] = [
  {
    name: "Steakhouse USDC",
    vaultAddress: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB",
    generation: "V1",
  },
  {
    name: "Steakhouse Prime USDC",
    vaultAddress: "0xbeef088055857739C12CD3765F20b7679Def0f51",
    generation: "V2",
  },
  {
    name: "Steakhouse USDT",
    vaultAddress: "0xbEef047a543E45807105E51A8BBEFCc5950fcfBa",
    generation: "V1",
  },
  {
    name: "Steakhouse Prime USDT",
    vaultAddress: "0xbeef003C68896c7D2c3c60d363e8d71a49Ab2bf9",
    generation: "V2",
  },
  {
    name: "Steakhouse ETH",
    vaultAddress: "0xBEEf050ecd6a16c4e7bfFbB52Ebba7846C4b8cD4",
    generation: "V1",
  },
  {
    name: "Vault Bridge WETH",
    vaultAddress: "0x31A5684983EeE865d943A696AAC155363bA024f9",
    generation: "V1",
  },
  {
    name: "Vault Bridge WBTC",
    vaultAddress: "0x812B2C6Ab3f4471c0E43D4BB61098a9211017427",
    generation: "V1",
  },
];

/**
 * Whether a V2 vault would refuse this wallet outright.
 *
 * Morpho Vaults V2 lets a curator attach a gate contract that only allows
 * allowlisted addresses to deposit or redeem. This wallet executes every batch
 * as a FRESH ephemeral account that has never been allowlisted anywhere, so a
 * gated vault does not merely inconvenience it — every deposit and every
 * redemption reverts, permanently, and the batch mines while doing nothing
 * (relay-adapt does not require success).
 *
 * None of the vaults above have a gate today. This is checked anyway, because
 * a curator can add one after the fact and the failure is otherwise silent.
 */
export const isVaultGated = async (
  vault: MorphoVaultRef,
  provider: ReturnType<typeof getProviderForChain>,
): Promise<boolean> => {
  if (vault.generation !== "V2") return false;
  const contract = new Contract(
    vault.vaultAddress,
    [
      "function receiveAssetsGate() view returns (address)",
      "function sendAssetsGate() view returns (address)",
    ],
    provider,
  );
  const gates = await Promise.all([
    contract.receiveAssetsGate().catch(() => ZeroAddress),
    contract.sendAssetsGate().catch(() => ZeroAddress),
  ]);
  return gates.some((gate: string) => gate !== ZeroAddress);
};

/** Morpho is deployed on Ethereum only; every recipe rejects other networks. */
export const isMorphoSupportedNetwork = (chainName: NetworkName): boolean =>
  chainName === NetworkName.Ethereum;

/**
 * Whether a swap leg is needed to reach `target`.
 *
 * Naming the token the action already deals in is not a trade, and the
 * cookbook's 0x leg would be asked to swap a token for itself. Separated out
 * because the combo cannot be built offline — its swap leg quotes against the
 * live 0x API — so this decision is the part that can be tested.
 */
export const needsSwapLeg = (
  counterpartAddress: string | undefined,
  targetAddress: string,
): boolean =>
  Boolean(
    counterpartAddress &&
      counterpartAddress.toLowerCase() !== targetAddress.toLowerCase(),
  );

/** A token amount as the review card wants to show it. */
export interface MorphoVaultLeg {
  tokenAddress: string;
  decimals: number;
  amount: bigint;
}

export interface MorphoVaultBuild extends CrossContractInputs {
  /**
   * What the batch would do, step by step, as the recipe reported it. Returned
   * rather than formatted here: the renderer decides how to show it, and the
   * transaction layer must not import the renderer.
   */
  steps: RecipeOutput["stepOutputs"];
  action: MorphoVaultAction;
  vault: MorphoVaultRef;
  /** Whether a 0x swap was folded into the same batch. */
  swapped: boolean;
  /** What leaves the private balance. */
  spend: MorphoVaultLeg;
  /**
   * What the batch expects back, and the floor it will still accept. The
   * recipes quote at build time and clamp to `minimum` on execution, so the
   * reviewed figure and the committed figure are not the same number.
   */
  receive: MorphoVaultLeg & { minimum: bigint };
}

type Executor = ReturnType<typeof makeEphemeralExecutor>;
type Provider = ReturnType<typeof getProviderForChain>;

const bareRecipe = (
  action: MorphoVaultAction,
  vault: MorphoVaultRef,
  slippageBasisPoints: bigint,
  executor: Executor,
  provider: Provider,
) => {
  const { vaultAddress, generation } = vault;
  if (action === "deposit") {
    return generation === "V2"
      ? new MorphoVaultV2DepositRecipe(vaultAddress, slippageBasisPoints, executor, provider)
      : new MorphoVaultV1DepositRecipe(vaultAddress, slippageBasisPoints, executor, provider);
  }
  return generation === "V2"
    ? new MorphoVaultV2RedeemRecipe(vaultAddress, slippageBasisPoints, executor, provider)
    : new MorphoVaultV1RedeemRecipe(vaultAddress, slippageBasisPoints, executor, provider);
};

/**
 * The same action with a 0x swap fused onto the side that needs one.
 *
 * A deposit swaps first, so the batch can be paid for with whatever is already
 * shielded rather than only the vault's own asset. A redemption swaps last, so
 * the proceeds come back as the token that was asked for. Either way it is one
 * batch, one proof and one fee — running the swap separately would be two of
 * each, and would leave the intermediate token shielded in between.
 */
const comboRecipe = (
  action: MorphoVaultAction,
  vault: MorphoVaultRef,
  slippageBasisPoints: bigint,
  executor: Executor,
  provider: Provider,
  asset: RecipeERC20Info,
  counterpart: RecipeERC20Info,
) => {
  const { vaultAddress, generation } = vault;
  return action === "deposit"
    ? new ZeroXSwap_MorphoVaultDeposit_ComboMeal(
        counterpart,
        asset,
        VAULT_SWAP_SLIPPAGE_BPS,
        vaultAddress,
        slippageBasisPoints,
        executor,
        provider,
        generation,
      )
    : new MorphoVaultRedeem_ZeroXSwap_ComboMeal(
        vaultAddress,
        slippageBasisPoints,
        asset,
        counterpart,
        VAULT_SWAP_SLIPPAGE_BPS,
        executor,
        provider,
        generation,
      );
};

/**
 * The token the batch hands back, read off the recipe's own output rather than
 * re-quoting. Deposit returns vault shares (the vault address is the share
 * token); redeem returns the vault's asset.
 */
export const receivedLeg = (
  recipeOutput: RecipeOutput,
  receiveTokenAddress: string,
): MorphoVaultLeg & { minimum: bigint } => {
  const match = recipeOutput.erc20AmountRecipients.find(
    (r) => r.tokenAddress.toLowerCase() === receiveTokenAddress.toLowerCase(),
  );
  if (!match) {
    throw new Error(
      `The vault recipe produced no ${receiveTokenAddress} output to shield.`,
    );
  }
  return {
    tokenAddress: match.tokenAddress,
    decimals: Number(match.decimals),
    amount: match.amount,
    minimum: match.minBalance ?? match.amount,
  };
};

/**
 * Build a vault deposit or redemption, swapping in the same batch if it needs to.
 *
 * `amount` is denominated in whatever the action spends: for a deposit that is
 * `counterpart` if one is given and the vault's asset otherwise; for a
 * redemption it is always the vault's shares.
 *
 * `counterpart` is the other side of the trade — what a deposit is paid WITH,
 * or what a redemption should come back AS. Naming the vault's own asset is the
 * same as omitting it: there is nothing to swap, so no swap leg is built.
 *
 * The encryption key is required and is not prompted for here: the 7702
 * relay-adapt executes as an ephemeral EOA derived from it, that EOA is the
 * ERC-4626 `receiver` baked into the calldata, and a transaction primitive that
 * stops to ask the user for a password is hidden control flow.
 */
export const getMorphoVaultInputs = async (
  chainName: NetworkName,
  action: MorphoVaultAction,
  vault: MorphoVaultRef,
  amount: bigint,
  slippageBasisPoints: bigint,
  encryptionKey: string,
  counterpart?: MorphoVaultLeg,
): Promise<MorphoVaultBuild> => {
  if (!isMorphoSupportedNetwork(chainName)) {
    throw new Error(`Morpho vaults are Ethereum-only; this wallet is on ${chainName}.`);
  }

  const provider = getProviderForChain(chainName);
  const railgunAddress = getCurrentRailgunAddress();

  // The relay-adapt executes as this account, so it is what the vault must pay
  // out to. Realign the index first so the address the calldata is built
  // against is the one the estimate and proof derive.
  await syncEphemeralIndexOnce(chainName, encryptionKey);
  const { address: ephemeralAddress, index: ephemeralIndex } =
    await getCurrentEphemeralInfo(chainName, encryptionKey);
  const executor = makeEphemeralExecutor(ephemeralAddress, "morpho vault");
  log.debug(`${action} bound to ephemeral [${ephemeralIndex}] ${ephemeralAddress}`);

  const { assetAddress, assetDecimals, shareDecimals } =
    await MorphoVaultAPI.getVaultData(vault.vaultAddress, provider);

  const asset: RecipeERC20Info = {
    tokenAddress: assetAddress,
    decimals: assetDecimals,
  };
  const swapLeg = needsSwapLeg(counterpart?.tokenAddress, assetAddress)
    ? counterpart
    : undefined;

  const shares: MorphoVaultLeg = {
    tokenAddress: vault.vaultAddress,
    decimals: Number(shareDecimals),
    amount,
  };
  const assetLeg: MorphoVaultLeg = {
    tokenAddress: assetAddress,
    decimals: Number(assetDecimals),
    amount,
  };
  // A deposit spends what it is paid with; a redemption always spends shares.
  const spend: MorphoVaultLeg =
    action === "deposit" ? { ...(swapLeg ?? assetLeg), amount } : shares;
  const receiveTokenAddress =
    action === "deposit"
      ? vault.vaultAddress
      : (swapLeg?.tokenAddress ?? assetAddress);

  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = [
    { tokenAddress: spend.tokenAddress, decimals: BigInt(spend.decimals), amount },
  ];

  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    nfts: [],
  };
  const recipeOutput = swapLeg
    ? await comboRecipe(
        action,
        vault,
        slippageBasisPoints,
        executor,
        provider,
        asset,
        { tokenAddress: swapLeg.tokenAddress, decimals: BigInt(swapLeg.decimals) },
      ).getComboMealOutput(recipeInput)
    : await bareRecipe(
        action,
        vault,
        slippageBasisPoints,
        executor,
        provider,
      ).getRecipeOutput(recipeInput);

  // Everything the batch ends holding comes back to this wallet, matching how
  // the swap path shields its outputs.
  const relayAdaptShieldERC20Addresses: RailgunERC20Recipient[] =
    recipeOutput.erc20AmountRecipients.map(({ tokenAddress }) => ({
      tokenAddress,
      recipientAddress: railgunAddress,
    }));

  return {
    action,
    vault,
    swapped: Boolean(swapLeg),
    spend,
    receive: receivedLeg(recipeOutput, receiveTokenAddress),
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    steps: recipeOutput.stepOutputs,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit: recipeOutput.minGasLimit,
  };
};
