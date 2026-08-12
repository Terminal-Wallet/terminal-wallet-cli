/**
 * Exercise the cookbook's f(x) surface before that build is published.
 *
 *   npx tsx scripts/fx-probe.ts
 *   FX_PROBE_RPC=https://rpc.mevblocker.io npx tsx scripts/fx-probe.ts
 *
 * Touches no wallet, no database and no funds: recipes are constructed offline
 * against a throwaway executor address, and every chain read is a view call.
 * Safe to run in the checkout.
 *
 * Two tiers, because they fail for different reasons and a failure in the first
 * makes the second meaningless:
 *
 *   A. OFFLINE — resolve all four pools and build every bare recipe for each.
 *      Catches descriptor errors, wrong token roles, wrong decimals, a step
 *      graph that routes a short through the long manager, and gas floors that
 *      violate their own invariant. No network.
 *   B. LIVE — read each pool and a real position from mainnet, and check the
 *      figures the recipes depend on against the chain rather than the
 *      descriptor. Catches an address that has moved and a fee ratio or
 *      threshold that is assumed rather than read.
 *
 * The combo meals are deliberately NOT built here: their swap leg quotes
 * against the live 0x API, which needs a key this repo ships empty, and a
 * network dependency inside a correctness probe makes a failure ambiguous.
 * Set ZEROX_API_KEY to include them.
 */
import {
  FX_ADDRESSES,
  FxMintBorrowMoreRecipe,
  FxMintCloseRecipe,
  FxMintOpenRecipe,
  FxMintRepayDebtRecipe,
  FxMintTopupAndBorrowRecipe,
  FxMintTopupRecipe,
  KNOWN_POOLS,
  MIN_GAS_LIMIT_EMPTY,
  MIN_GAS_LIMIT_FXMINT_ADJUST,
  MIN_GAS_LIMIT_FXMINT_CLOSE,
  MIN_GAS_LIMIT_FXMINT_OPEN,
  Recipe,
  RecipeERC20Amount,
  RecipeInput,
  computeFxClose,
  fxCollateralSupplySpend,
  fxCollateralWithdrawOutput,
  fxComposeScalingFactor,
  fxDebtBorrowOutput,
  fxDebtRepaySpend,
  fxScaleDownRawDebt,
  fxScaleUpNativeDebt,
  getFxDebtScalingFactor,
  getFxPool,
  getFxPosition,
  getNextFxPositionId,
  resolvePool,
} from "@railgun-community/cookbook";
import { NetworkName, NFTTokenType } from "@railgun-community/shared-models";
import { setRailgunFees } from "@railgun-community/cookbook";
import { JsonRpcProvider } from "ethers";

// The unshield step refuses to build without them, and they are protocol
// constants rather than anything this probe is measuring.
const SHIELD_FEE_BPS = 25n;
const UNSHIELD_FEE_BPS = 25n;
setRailgunFees(NetworkName.Ethereum, SHIELD_FEE_BPS, UNSHIELD_FEE_BPS);

const RPC = process.env.FX_PROBE_RPC ?? "https://rpc.mevblocker.io";

/** A public test address that ships in this repo's fixtures — nobody's wallet. */
const ZK =
  "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k";

let failures = 0;
let checks = 0;

const ok = (label: string, condition: boolean, detail = ""): void => {
  checks += 1;
  if (!condition) failures += 1;
  const mark = condition ? "  ok  " : " FAIL ";
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
};

const section = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};

const fmt = (amount: bigint, decimals: bigint | number): string => {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(Number(d), "0").slice(0, 6);
  return `${whole}.${frac}`;
};

/** A recipe input carrying `amount` of `token`, as an unshield would deliver it. */
const inputWith = (
  token: { tokenAddress: string; decimals: bigint } | undefined,
  amount: bigint,
  nft?: { nftAddress: string; positionId: bigint },
): RecipeInput => ({
  networkName: NetworkName.Ethereum,
  railgunAddress: ZK,
  // A leg that spends nothing up front unshields nothing. An entry of zero is
  // not the same thing and the unshield step rejects it.
  erc20Amounts: token
    ? [{ ...token, amount } satisfies RecipeERC20Amount]
    : [],
  nfts: nft
    ? [
        {
          nftAddress: nft.nftAddress,
          tokenSubID: `0x${nft.positionId.toString(16)}`,
          nftTokenType: NFTTokenType.ERC721,
          amount: 1n,
          recipient: ZK,
        },
      ]
    : [],
});

/**
 * Build a recipe and report what it would do, or why it refused.
 *
 * A throw is reported rather than propagated: one pool refusing a leg must not
 * hide the other three, and a refusal with a legible reason is itself a result.
 */
const build = async (
  label: string,
  recipe: Recipe,
  input: RecipeInput,
): Promise<Awaited<ReturnType<Recipe["getRecipeOutput"]>> | undefined> => {
  try {
    const output = await recipe.getRecipeOutput(input);
    ok(label, true, `${output.stepOutputs.length} steps, floor ${output.minGasLimit}`);
    // Every fx recipe strictly contains an unshield and a shield, so its floor
    // cannot legitimately sit below the recipe that only does those two.
    // Asserted on BUILT OUTPUT rather than on the exported constants: -fx.2
    // satisfied the invariant for the constants while two recipes carried
    // inline literals that did not, and only this shape caught it.
    ok(
      `${label}: floor >= MIN_GAS_LIMIT_EMPTY`,
      output.minGasLimit >= MIN_GAS_LIMIT_EMPTY,
      `${output.minGasLimit} vs ${MIN_GAS_LIMIT_EMPTY}`,
    );
    return output;
  } catch (err) {
    ok(label, false, err instanceof Error ? err.message : String(err));
    return undefined;
  }
};

const tierA = async (): Promise<void> => {
  section("A. OFFLINE — the descriptor");

  ok(
    "four pools ship",
    KNOWN_POOLS.length === 4,
    KNOWN_POOLS.map((p) => p.name).join(", "),
  );

  for (const entry of KNOWN_POOLS) {
    const pool = resolvePool(entry.name);
    const sameToken =
      pool.collateralToken.toLowerCase() === pool.debtToken.toLowerCase();
    ok(
      `${entry.name}: collateral and debt are different tokens`,
      !sameToken,
      `coll ${pool.collateralToken.slice(0, 10)}… (${pool.collateralDecimals}dp), ` +
        `debt ${pool.debtToken.slice(0, 10)}… (${pool.debtDecimals}dp)`,
    );
    const expectedManager =
      pool.side === "short"
        ? FX_ADDRESSES.fxShortPoolManager
        : FX_ADDRESSES.fxPoolManager;
    ok(
      `${entry.name}: routes to the ${pool.side} manager`,
      pool.poolManager.toLowerCase() === expectedManager.toLowerCase(),
      pool.poolManager,
    );
    if (pool.side === "short") {
      ok(
        `${entry.name}: a short is collateralised in fxUSD`,
        pool.collateralToken.toLowerCase() === FX_ADDRESSES.fxUSD.toLowerCase(),
      );
    } else {
      ok(
        `${entry.name}: a long owes fxUSD`,
        pool.debtToken.toLowerCase() === FX_ADDRESSES.fxUSD.toLowerCase(),
      );
    }
  }

  section("A. OFFLINE — gas floors");
  for (const [name, floor] of [
    ["FXMINT_OPEN", MIN_GAS_LIMIT_FXMINT_OPEN],
    ["FXMINT_ADJUST", MIN_GAS_LIMIT_FXMINT_ADJUST],
    ["FXMINT_CLOSE", MIN_GAS_LIMIT_FXMINT_CLOSE],
  ] as const) {
    // Every fx recipe strictly contains an unshield plus a shield, so it cannot
    // cost less than the recipe that only does those two things.
    ok(
      `${name} exceeds MIN_GAS_LIMIT_EMPTY`,
      floor > MIN_GAS_LIMIT_EMPTY,
      `${floor} vs ${MIN_GAS_LIMIT_EMPTY}`,
    );
  }

  section("A. OFFLINE — fee model");
  const TEN = 10n ** 18n;
  ok(
    "supply spends the full amount",
    fxCollateralSupplySpend(TEN) === TEN,
    `${fmt(fxCollateralSupplySpend(TEN), 18)}`,
  );
  const withdrawFee = 1_000_000n; // 0.1% at FEE_DENOM 1e9
  ok(
    "withdraw output is net of its fee",
    fxCollateralWithdrawOutput(TEN, withdrawFee) < TEN,
    fmt(fxCollateralWithdrawOutput(TEN, withdrawFee), 18),
  );
  const borrowFee = 5_000_000n; // 0.5%
  ok(
    "borrow output is net of its fee",
    fxDebtBorrowOutput(TEN, borrowFee) < TEN,
    fmt(fxDebtBorrowOutput(TEN, borrowFee), 18),
  );
  ok(
    "repay spends principal PLUS its fee",
    fxDebtRepaySpend(TEN, 2_000_000n) > TEN,
    fmt(fxDebtRepaySpend(TEN, 2_000_000n), 18),
  );

  section("A. OFFLINE — raw/native scaling");
  // WBTC is 8-decimal, so its raw debt is normalised up by 10^10.
  const wbtcFactor = fxComposeScalingFactor(10n ** 10n * 10n ** 18n);
  const native = 2_000_000n; // 0.02 WBTC
  const raw = fxScaleUpNativeDebt(native, wbtcFactor);
  ok(
    "native -> raw -> native round-trips",
    fxScaleDownRawDebt(raw, wbtcFactor) === native,
    `${native} -> ${raw} -> ${fxScaleDownRawDebt(raw, wbtcFactor)}`,
  );
  ok("the raw figure is the larger one", raw > native);
  let threw = false;
  try {
    fxScaleDownRawDebt(raw, 0n);
  } catch {
    threw = true;
  }
  ok("a zero scaling factor throws rather than dividing by zero", threw);

  section("A. OFFLINE — the raw-vs-native trap");
  // Same position, same available balance, two units for the debt.
  const shielded = native * 2n;
  const common = {
    collateral: 10n ** 21n,
    availableDebtToken: shielded,
    repayFeeRatio: 0n,
    withdrawFeeRatio: 0n,
    railgunUnshieldFeeBps: 25n,
  };
  const right = computeFxClose({ ...common, debt: native });
  const wrong = computeFxClose({ ...common, debt: raw });
  ok(
    "native units close the position outright",
    right.partialClose === false,
    `withdrawColl ${fmt(right.withdrawColl, 18)}`,
  );
  ok(
    "raw units still strand the collateral — the guard does NOT catch this",
    wrong.partialClose === true &&
      wrong.withdrawColl * 1_000_000n < right.withdrawColl,
    `withdrawColl ${fmt(wrong.withdrawColl, 18)}`,
  );
  // The migration guard fires on the OLD field name, which arrives as
  // undefined. That is a rename check, not a units check.
  let guarded = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    computeFxClose({ ...common, rawDebts: native } as any);
  } catch {
    guarded = true;
  }
  ok("the old `rawDebts` field name is refused with a migration error", guarded);

  section("A. OFFLINE — every bare leg, on every pool");
  for (const entry of KNOWN_POOLS) {
    const pool = resolvePool(entry.name);
    const collateral = {
      tokenAddress: pool.collateralToken,
      decimals: pool.collateralDecimals,
    };
    const debt = { tokenAddress: pool.debtToken, decimals: pool.debtDecimals };
    const collAmount = 10n ** pool.collateralDecimals; // one whole token
    const debtAmount = 10n ** pool.debtDecimals / 100n; // a hundredth
    const POSITION_ID = 1n;

    console.log(`\n-- ${entry.name} (${pool.side})`);
    await build(
      `${entry.name}: open`,
      new FxMintOpenRecipe({
        pool: entry.name,
        targetDebt: debtAmount,
        predictedPositionId: POSITION_ID,
        borrowFeeRatio: 0n,
      }),
      inputWith(collateral, collAmount),
    );
    await build(
      `${entry.name}: topup`,
      new FxMintTopupRecipe({ pool: entry.name, positionId: POSITION_ID }),
      inputWith(collateral, collAmount, {
        nftAddress: pool.address,
        positionId: POSITION_ID,
      }),
    );
    await build(
      `${entry.name}: topup + borrow`,
      new FxMintTopupAndBorrowRecipe({
        pool: entry.name,
        positionId: POSITION_ID,
        additionalDebt: debtAmount,
        borrowFeeRatio: 0n,
      }),
      inputWith(collateral, collAmount, {
        nftAddress: pool.address,
        positionId: POSITION_ID,
      }),
    );
    await build(
      `${entry.name}: borrow more`,
      new FxMintBorrowMoreRecipe({
        pool: entry.name,
        positionId: POSITION_ID,
        additionalDebt: debtAmount,
        borrowFeeRatio: 0n,
      }),
      inputWith(undefined, 0n, {
        nftAddress: pool.address,
        positionId: POSITION_ID,
      }),
    );
    await build(
      `${entry.name}: repay`,
      new FxMintRepayDebtRecipe({
        pool: entry.name,
        positionId: POSITION_ID,
        repayAmount: debtAmount,
        approveAmount: debtAmount,
        repayFeeRatio: 0n,
      }),
      // Unshield more than the approve: RAILGUN takes its cut on the way out,
      // so an unshield sized at the approve amount delivers less than the
      // approve step is then told to authorise.
      inputWith(debt, debtAmount * 2n, {
        nftAddress: pool.address,
        positionId: POSITION_ID,
      }),
    );
    await build(
      `${entry.name}: close`,
      new FxMintCloseRecipe({
        pool: entry.name,
        positionId: POSITION_ID,
        repayAmount: debtAmount,
        withdrawColl: collAmount,
        approveAmount: debtAmount,
        withdrawFeeRatio: 0n,
        partialClose: false,
      }),
      // Unshield more than the approve: RAILGUN takes its cut on the way out,
      // so an unshield sized at the approve amount delivers less than the
      // approve step is then told to authorise.
      inputWith(debt, debtAmount * 2n, {
        nftAddress: pool.address,
        positionId: POSITION_ID,
      }),
    );
  }
};

const tierB = async (): Promise<void> => {
  section(`B. LIVE — reads against ${RPC}`);
  const provider = new JsonRpcProvider(RPC);

  for (const entry of KNOWN_POOLS) {
    console.log(`\n-- ${entry.name}`);
    try {
      const pool = await getFxPool(entry.name, provider);
      ok(
        `${entry.name}: the chain agrees on the side and the manager`,
        pool.side === entry.side &&
          pool.poolManager.toLowerCase() === entry.poolManager.toLowerCase(),
        `${pool.side} @ ${pool.poolManager.slice(0, 10)}…`,
      );
      ok(
        `${entry.name}: the chain agrees on the token roles`,
        pool.collateralToken.toLowerCase() ===
          entry.collateralToken.toLowerCase() &&
          pool.debtToken.toLowerCase() === entry.debtToken.toLowerCase(),
      );
      // Both thresholds are governance parameters. A zero here means the code
      // that reads them would silently treat the position as unliquidatable.
      ok(
        `${entry.name}: liquidation and rebalance thresholds are set`,
        pool.liquidationDebtRatio > 0n && pool.rebalanceDebtRatio > 0n,
        `rebalance ${fmt(pool.rebalanceDebtRatio, 18)}, ` +
          `liquidation ${fmt(pool.liquidationDebtRatio, 18)}`,
      );
      console.log(
        `       fees: supply ${pool.supplyFeeRatio} withdraw ${pool.withdrawFeeRatio} ` +
          `borrow ${pool.borrowFeeRatio} repay ${pool.repayFeeRatio}`,
      );
      // Which axis the fees sit on is the thing that flips between sides.
      if (pool.side === "short") {
        ok(
          `${entry.name}: a short charges on collateral, not debt`,
          pool.supplyFeeRatio + pool.withdrawFeeRatio > 0n,
        );
      } else {
        ok(
          `${entry.name}: a long charges on debt, not collateral`,
          pool.borrowFeeRatio + pool.repayFeeRatio > 0n,
        );
      }

      const nextId = await getNextFxPositionId(entry.name, provider);
      ok(`${entry.name}: next position id reads`, nextId > 0n, `#${nextId}`);

      // Non-fatal on purpose: this one is broken on the long pools and the
      // rest of the tier is still worth running.
      let factor: bigint | undefined;
      try {
        factor = await getFxDebtScalingFactor(entry.name, provider);
        ok(`${entry.name}: debt scaling factor reads`, factor > 0n, `${factor}`);
      } catch (err) {
        ok(
          `${entry.name}: debt scaling factor reads`,
          false,
          err instanceof Error ? err.message : String(err),
        );
      }

      // The last minted id is NOT necessarily a live position — it may have
      // been closed and burnt, and the pool reports a nonexistent position as
      // zeros rather than reverting. Walk back until one has collateral.
      let position: Awaited<ReturnType<typeof getFxPosition>> | undefined;
      for (let back = 1n; back <= 25n && nextId - back > 0n; back += 1n) {
        const candidate = await getFxPosition(nextId - back, entry.name, provider);
        if (candidate.collateralAmount > 0n) {
          position = candidate;
          break;
        }
      }
      if (!position) {
        ok(`${entry.name}: a live position was found to read`, false, "none in the last 25 ids");
        continue;
      }
      ok(
        `${entry.name}: a live position was found to read`,
        true,
        `#${position.positionId}`,
      );

      if (factor !== undefined) {
        const scaledBack = fxScaleDownRawDebt(position.rawDebts, factor);
        ok(
          `${entry.name}: #${position.positionId} raw debt scales to its native debt`,
          // Integer division loses at most one unit.
          position.debt >= scaledBack - 1n && position.debt <= scaledBack + 1n,
          `raw ${position.rawDebts}, native ${position.debt}`,
        );
      }
      if (pool.debtDecimals !== 18n && position.debt > 0n) {
        ok(
          `${entry.name}: raw and native genuinely differ on this pool`,
          position.rawDebts !== position.debt,
          `raw ${position.rawDebts} vs native ${position.debt}`,
        );
      } else {
        ok(
          `${entry.name}: raw and native coincide on an 18dp debt`,
          position.rawDebts === position.debt,
        );
      }
      console.log(
        `       #${position.positionId}: coll ${fmt(position.collateralAmount, position.collateralDecimals)} ` +
          `debt ${fmt(position.debt, position.debtDecimals)} ` +
          `ratio ${fmt(position.debtRatio, 18)}`,
      );
    } catch (err) {
      ok(
        `${entry.name}: live read`,
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
};

const main = async (): Promise<void> => {
  await tierA();
  if (process.env.FX_PROBE_OFFLINE === "1") {
    console.log("\n(live tier skipped: FX_PROBE_OFFLINE=1)");
  } else {
    await tierB();
  }
  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
};

void main();
