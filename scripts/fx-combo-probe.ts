/**
 * Build every fx and Morpho-vault combo meal against the live 0x API.
 *
 *   npx tsx scripts/fx-combo-probe.ts
 *
 * Spends nothing and signs nothing, but unlike the other two probes this one
 * genuinely leaves the machine: a combo's swap leg quotes against 0x at build
 * time, so a combo cannot be constructed offline at all. That is exactly why
 * they were the last unverified part of the surface.
 *
 * The 0x key is NOT a secret this repo holds. `config-defaults.ts` ships it
 * empty and the wallet fills it at boot from the on-chain remote config —
 * contract `0x5e98…fbC94` on mainnet, whose `getConfig()` returns the JSON that
 * `applyRemoteConfigOverrides` copies into `configDefaults.apiKeys`. This
 * script does the same fetch rather than asking anyone to paste a key.
 */
import {
  FxMintBorrowMore_ZeroXSwap_ComboMeal,
  FxMintClose_ZeroXSwap_ComboMeal,
  FxMintTopupAndBorrow_ZeroXSwap_ComboMeal,
  MorphoVaultRedeem_ZeroXSwap_ComboMeal,
  MorphoVaultV1DepositRecipe,
  RecipeERC20Info,
  RecipeInput,
  ZeroXConfig,
  ZeroXSwap_FxMintClose_ComboMeal,
  ZeroXSwap_FxMintOpen_ComboMeal,
  ZeroXSwap_FxMintRepay_ComboMeal,
  ZeroXSwap_FxMintTopupAndBorrow_ComboMeal,
  ZeroXSwap_FxMintTopup_ComboMeal,
  ZeroXSwap_MorphoVaultDeposit_ComboMeal,
  getFxPool,
  getFxPosition,
  getNextFxPositionId,
  makeEphemeralExecutor,
  fxDebtRepaySpend,
  resolvePool,
  setRailgunFees,
} from "@railgun-community/cookbook";
import { NetworkName, NFTTokenType } from "@railgun-community/shared-models";
import { Contract, JsonRpcProvider } from "ethers";

const RPC = process.env.FX_PROBE_RPC ?? "https://rpc.mevblocker.io";
const CONFIG_RPC =
  process.env.REMOTE_CONFIG_RPC ?? "https://ethereum-rpc.publicnode.com";
const REMOTE_CONFIG = "0x5e982525d50046A813DBf55Ae72a3E00e99fbC94";

const ZK =
  "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k";
const EXECUTOR = makeEphemeralExecutor(
  "0x1234567890AbcdEF1234567890aBcdef12345678",
  "combo probe",
);

const USDC = { tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6n };
const WETH = { tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18n };
const SLIPPAGE = 320;

setRailgunFees(NetworkName.Ethereum, 25n, 25n);

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail = ""): void => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

/** The 0x key, from the same on-chain config the wallet reads at boot. */
const loadZeroXKey = async (): Promise<string | undefined> => {
  const provider = new JsonRpcProvider(CONFIG_RPC);
  const contract = new Contract(
    REMOTE_CONFIG,
    ["function getConfig() public view returns (string memory str)"],
    provider,
  );
  try {
    const raw: string = await contract.getConfig();
    const key = (JSON.parse(raw) as { apiKeys?: Record<string, string> })
      .apiKeys?.zeroXApi;
    return key || undefined;
  } catch {
    return undefined;
  }
};

const erc20 = (
  token: { tokenAddress: string; decimals: bigint },
  amount: bigint,
) => ({ ...token, amount });

const nft = (nftAddress: string, positionId: bigint) => ({
  nftAddress,
  tokenSubID: `0x${positionId.toString(16)}`,
  nftTokenType: NFTTokenType.ERC721,
  amount: 1n,
  recipient: ZK,
});

const input = (
  erc20Amounts: ReturnType<typeof erc20>[],
  nfts: ReturnType<typeof nft>[] = [],
): RecipeInput => ({
  networkName: NetworkName.Ethereum,
  railgunAddress: ZK,
  erc20Amounts,
  nfts,
});

/** A combo builds only if its 0x quote comes back, so a throw is the result. */
const build = async (
  label: string,
  run: () => Promise<{ crossContractCalls: unknown[]; minGasLimit: bigint }>,
): Promise<void> => {
  try {
    const output = await run();
    ok(
      label,
      output.crossContractCalls.length > 0,
      `${output.crossContractCalls.length} calls, floor ${output.minGasLimit}`,
    );
  } catch (err) {
    ok(label, false, (err instanceof Error ? err.message : String(err)).slice(0, 140));
  }
};

const main = async (): Promise<void> => {
  const key = await loadZeroXKey();
  ok(
    "0x API key resolves from the on-chain remote config",
    Boolean(key),
    key ? `${key.length} chars` : "absent — every combo below will fail",
  );
  if (!key) {
    console.log("\nWithout a key the 0x fetch throws MissingHeadersError.");
    process.exitCode = 1;
    return;
  }
  ZeroXConfig.API_KEY = key;

  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const POOL = "wstETH-Long" as const;
  const pool = resolvePool(POOL);
  const poolState = await getFxPool(POOL, provider);

  // A real live position, so the adjust and close combos are quoted against
  // amounts the pool would actually accept.
  const nextId = await getNextFxPositionId(POOL, provider);
  let positionId = 0n;
  let debt = 0n;
  for (let back = 1n; back <= 25n && nextId - back > 0n; back += 1n) {
    const candidate = await getFxPosition(nextId - back, POOL, provider);
    if (candidate.collateralAmount > 0n && candidate.debt > 0n) {
      positionId = nextId - back;
      debt = candidate.debt;
      break;
    }
  }
  ok("a live position to quote against", positionId > 0n, `#${positionId}`);
  if (positionId === 0n) {
    process.exitCode = 1;
    return;
  }

  const collateral = 10n ** pool.collateralDecimals / 100n;
  const debtSlice = debt / 10n;
  // The repay and close recipes check this exactly: the approval must cover the
  // principal PLUS the pool's repay fee. -fx.3 refuses a mismatch in the
  // constructor rather than reverting on chain, which caught this probe passing
  // the bare principal.
  const approveForRepay = fxDebtRepaySpend(debtSlice, poolState.repayFeeRatio);
  // A swap-in combo has to buy enough of the debt token to cover the approval,
  // so the sell side is sized from the repay rather than picked. fxUSD is a
  // dollar and USDC is 6dp, hence the 1e12 scale, plus headroom for slippage.
  const usdcForRepay = ((approveForRepay / 10n ** 12n) * 13n) / 10n;
  const positionNFT = nft(pool.address, positionId);

  console.log("\n=== f(x) — pay with anything (swap in) ===");
  await build("open  <- USDC", () =>
    new ZeroXSwap_FxMintOpen_ComboMeal({
      pool: POOL,
      targetDebt: debtSlice,
      predictedPositionId: nextId,
      borrowFeeRatio: poolState.borrowFeeRatio,
      sellERC20Info: USDC as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(input([erc20(USDC, 100_000_000n)])),
  );
  await build("topup <- USDC", () =>
    new ZeroXSwap_FxMintTopup_ComboMeal({
      pool: POOL,
      positionId,
      sellERC20Info: USDC as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(input([erc20(USDC, 100_000_000n)], [positionNFT])),
  );
  await build("topup+borrow <- USDC", () =>
    new ZeroXSwap_FxMintTopupAndBorrow_ComboMeal({
      pool: POOL,
      positionId,
      additionalDebt: debtSlice,
      borrowFeeRatio: poolState.borrowFeeRatio,
      sellERC20Info: USDC as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(input([erc20(USDC, 100_000_000n)], [positionNFT])),
  );
  await build("repay <- USDC  (NEW in -fx.3)", () =>
    new ZeroXSwap_FxMintRepay_ComboMeal({
      pool: POOL,
      positionId,
      repayAmount: debtSlice,
      approveAmount: approveForRepay,
      repayFeeRatio: poolState.repayFeeRatio,
      sellERC20Info: USDC as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(input([erc20(USDC, usdcForRepay)], [positionNFT])),
  );
  await build("close <- USDC  (NEW in -fx.3)", () =>
    new ZeroXSwap_FxMintClose_ComboMeal({
      pool: POOL,
      positionId,
      repayAmount: debtSlice,
      withdrawColl: collateral,
      approveAmount: approveForRepay,
      withdrawFeeRatio: poolState.withdrawFeeRatio,
      partialClose: true,
      sellERC20Info: USDC as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(input([erc20(USDC, usdcForRepay)], [positionNFT])),
  );

  console.log("\n=== f(x) — come back as anything (swap out) ===");
  await build("close -> WETH", () =>
    new FxMintClose_ZeroXSwap_ComboMeal({
      pool: POOL,
      positionId,
      repayAmount: debtSlice,
      withdrawColl: collateral,
      approveAmount: approveForRepay,
      withdrawFeeRatio: poolState.withdrawFeeRatio,
      partialClose: true,
      buyERC20Info: WETH as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(
      input([erc20({ tokenAddress: pool.debtToken, decimals: pool.debtDecimals }, debtSlice * 2n)], [positionNFT]),
    ),
  );
  await build("borrow more -> WETH  (NEW in -fx.3)", () =>
    new FxMintBorrowMore_ZeroXSwap_ComboMeal({
      pool: POOL,
      positionId,
      additionalDebt: debtSlice,
      borrowFeeRatio: poolState.borrowFeeRatio,
      buyERC20Info: WETH as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(input([], [positionNFT])),
  );
  await build("topup+borrow -> WETH  (NEW in -fx.3)", () =>
    new FxMintTopupAndBorrow_ZeroXSwap_ComboMeal({
      pool: POOL,
      positionId,
      additionalDebt: debtSlice,
      borrowFeeRatio: poolState.borrowFeeRatio,
      buyERC20Info: WETH as RecipeERC20Info,
      swapSlippageBasisPoints: SLIPPAGE,
      recipient: EXECUTOR,
    }).getComboMealOutput(
      input([erc20({ tokenAddress: pool.collateralToken, decimals: pool.collateralDecimals }, collateral)], [positionNFT]),
    ),
  );

  console.log("\n=== Morpho vaults ===");
  const VAULT = "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB"; // Steakhouse USDC, V1
  await build("vault deposit <- WETH", () =>
    new ZeroXSwap_MorphoVaultDeposit_ComboMeal(
      WETH as RecipeERC20Info,
      USDC as RecipeERC20Info,
      SLIPPAGE,
      VAULT,
      100n,
      EXECUTOR,
      provider,
      "V1",
    ).getComboMealOutput(input([erc20(WETH, 10n ** 16n)])),
  );
  await build("vault redeem -> WETH", () =>
    new MorphoVaultRedeem_ZeroXSwap_ComboMeal(
      VAULT,
      100n,
      USDC as RecipeERC20Info,
      WETH as RecipeERC20Info,
      SLIPPAGE,
      EXECUTOR,
      provider,
      "V1",
    ).getComboMealOutput(
      input([erc20({ tokenAddress: VAULT, decimals: 18n }, 10n ** 18n)]),
    ),
  );
  // Bare, for contrast: no swap leg, so no 0x dependency at all.
  await build("vault deposit (bare, no swap)", () =>
    new MorphoVaultV1DepositRecipe(VAULT, 100n, EXECUTOR, provider).getRecipeOutput(
      input([erc20(USDC, 100_000_000n)]),
    ),
  );

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
};

void main();
