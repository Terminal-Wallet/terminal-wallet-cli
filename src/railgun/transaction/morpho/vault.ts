/**
 * Morpho ERC-4626 vault deposits and redemptions, as private 7702 relay-adapt
 * batches.
 *
 * Both directions are a plain token round trip — asset in, shares out, or the
 * reverse — so they reduce to the generic CrossContractInputs the cross-contract
 * rail already runs. Nothing here is vault-specific past building the recipe.
 */
import { NetworkName, RailgunERC20Recipient } from "@railgun-community/shared-models";
import {
  MorphoVaultAPI,
  MorphoVaultV1DepositRecipe,
  MorphoVaultV2DepositRecipe,
  MorphoVaultV1RedeemRecipe,
  MorphoVaultV2RedeemRecipe,
  RecipeERC20Amount,
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
 * The vaults offered in the builder.
 *
 * The cookbook ships these addresses but does not re-export its registry from
 * the package root, and a curated list is what the picker wants anyway — every
 * other parameter (asset, both decimals) is read from the vault itself.
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
];

/** Morpho is deployed on Ethereum only; every recipe rejects other networks. */
export const isMorphoSupportedNetwork = (chainName: NetworkName): boolean =>
  chainName === NetworkName.Ethereum;

/** A token amount as the review card wants to show it. */
export interface MorphoVaultLeg {
  tokenAddress: string;
  decimals: number;
  amount: bigint;
}

export interface MorphoVaultBuild extends CrossContractInputs {
  action: MorphoVaultAction;
  vault: MorphoVaultRef;
  /** What leaves the private balance. */
  spend: MorphoVaultLeg;
  /**
   * What the batch expects back, and the floor it will still accept. The
   * recipes quote at build time and clamp to `minimum` on execution, so the
   * reviewed figure and the committed figure are not the same number.
   */
  receive: MorphoVaultLeg & { minimum: bigint };
}

const buildRecipe = (
  action: MorphoVaultAction,
  vault: MorphoVaultRef,
  slippageBasisPoints: bigint,
  executor: ReturnType<typeof makeEphemeralExecutor>,
  provider: ReturnType<typeof getProviderForChain>,
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
 * Build a vault deposit or redemption.
 *
 * `amount` is denominated in whatever the action spends: the vault's asset for
 * a deposit, its shares for a redemption.
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

  const spend: MorphoVaultLeg =
    action === "deposit"
      ? { tokenAddress: assetAddress, decimals: Number(assetDecimals), amount }
      : { tokenAddress: vault.vaultAddress, decimals: Number(shareDecimals), amount };
  const receiveTokenAddress =
    action === "deposit" ? vault.vaultAddress : assetAddress;

  const relayAdaptUnshieldERC20Amounts: RecipeERC20Amount[] = [
    { tokenAddress: spend.tokenAddress, decimals: BigInt(spend.decimals), amount },
  ];

  const recipe = buildRecipe(action, vault, slippageBasisPoints, executor, provider);
  const recipeInput: RecipeInput = {
    networkName: chainName,
    railgunAddress,
    erc20Amounts: relayAdaptUnshieldERC20Amounts,
    nfts: [],
  };
  const recipeOutput = await recipe.getRecipeOutput(recipeInput);

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
    spend,
    receive: receivedLeg(recipeOutput, receiveTokenAddress),
    relayAdaptUnshieldERC20Amounts,
    relayAdaptShieldERC20Addresses,
    crossContractCalls: recipeOutput.crossContractCalls,
    minGasLimit: recipeOutput.minGasLimit,
  };
};
