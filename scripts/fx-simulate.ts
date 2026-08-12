/**
 * Tier C — carry the f(x) write legs through a state-overridden `eth_call`.
 *
 *   npx tsx scripts/fx-simulate.ts
 *   FX_SIM_RPC=https://eth.drpc.org npx tsx scripts/fx-simulate.ts
 *
 * Spends nothing and signs nothing. `eth_call` does not check signatures, so a
 * close is simulated AS the real owner of a real position, against real state
 * at head — which is a stronger test than anything a throwaway account can
 * reach, because the position, its debt and its collateral are all genuine.
 *
 * What this establishes that tier A and B cannot:
 *
 *   - does `operate()` actually succeed for a SHORT, or only build?
 *   - what does each leg cost, so the gas floors stop being inferred?
 *
 * What it cannot establish: the RAILGUN unshield and shield legs. Those need a
 * real proof over real notes, which no state override can fake. The unshield
 * was measured at 1,121,136 in the mainnet trace (see the plan's TASKS.md); the
 * shield is the leg that ran out of gas there and has never completed.
 *
 * The calldata replayed here is the cookbook's own — it comes off
 * `FxMintCloseRecipe.getRecipeOutput().crossContractCalls`, not hand-rolled —
 * so a defect in how the recipe encodes `operate()` shows up as a revert.
 */
import {
  FX_ADDRESSES,
  FxMintCloseRecipe,
  KNOWN_POOLS,
  RecipeInput,
  computeFxClose,
  getFxPool,
  getFxPosition,
  getNextFxPositionId,
  resolvePool,
  setRailgunFees,
} from "@railgun-community/cookbook";
import { NetworkName, NFTTokenType } from "@railgun-community/shared-models";
import {
  Contract,
  JsonRpcProvider,
  concat,
  keccak256,
  toBeHex,
  zeroPadValue,
} from "ethers";

const RPC = process.env.FX_SIM_RPC ?? "https://rpc.mevblocker.io";

const ZK =
  "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k";

setRailgunFees(NetworkName.Ethereum, 25n, 25n);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];
const NFT_ABI = ["function ownerOf(uint256) view returns (address)"];

let failures = 0;
let checks = 0;
const ok = (label: string, condition: boolean, detail = ""): void => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
};

const fmt = (amount: bigint, decimals: bigint | number): string => {
  const d = BigInt(decimals);
  const base = 10n ** d;
  return `${amount / base}.${(amount % base).toString().padStart(Number(d), "0").slice(0, 6)}`;
};

/**
 * The base slots a token might keep `_balances` and `_allowances` at.
 *
 * A plain token puts them in the first handful. An upgradeable one puts them
 * well down: fxUSD is a proxy (ERC-1967 implementation
 * `0xf729422d…02a9b1`) whose balances sit at integer slot **151**, behind the
 * storage gaps its inheritance chain reserves. Hence the range rather than a
 * guess at a namespace — and an ERC-7201 namespaced base as a fallback, for a
 * token that does use one.
 */
const ERC7201_OZ_ERC20 =
  "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00";

const SCAN_DEPTH = 260;

/** f(x)'s "take all of it" sentinel for a leg of `operate()`. */
const INT256_MIN = -(2n ** 255n);

const candidateBases = (offset: number): string[] => [
  ...Array.from({ length: SCAN_DEPTH }, (_, i) =>
    zeroPadValue(toBeHex(i + offset), 32),
  ),
  toBeHex(BigInt(ERC7201_OZ_ERC20) + BigInt(offset), 32),
];

const mapSlot = (key: string, base: string): string =>
  keccak256(concat([zeroPadValue(key, 32), base]));

const nestedSlot = (outer: string, inner: string, base: string): string =>
  keccak256(concat([zeroPadValue(inner, 32), mapSlot(outer, base)]));

/** Public nodes drop connections mid-scan; a scan is dozens of calls. */
const withRetry = async <T>(fn: () => Promise<T>, attempts = 3): Promise<T> => {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  throw last;
};

/**
 * Find which storage slot a token keeps `balanceOf` in, by overriding a
 * candidate and asking the token what it now reports.
 *
 * Self-verifying on purpose: guessing a layout and proceeding would produce a
 * simulation that silently runs against the real balance, and a close that
 * "works" only because the owner happened to hold enough.
 */
const findBalanceSlot = async (
  provider: JsonRpcProvider,
  token: string,
  holder: string,
): Promise<string | undefined> => {
  const probe = 12345n;
  const iface = new Contract(token, ERC20_ABI, provider).interface;
  const data = iface.encodeFunctionData("balanceOf", [holder]);
  for (const base of candidateBases(0)) {
    const overrides = {
      [token]: { stateDiff: { [mapSlot(holder, base)]: toBeHex(probe, 32) } },
    };
    try {
      const raw: string = await withRetry(() =>
        provider.send("eth_call", [{ to: token, data }, "latest", overrides]),
      );
      if (BigInt(raw) === probe) return base;
    } catch {
      // A token that reverts on this slot is simply not laid out that way.
    }
  }
  return undefined;
};

const findAllowanceSlot = async (
  provider: JsonRpcProvider,
  token: string,
  owner: string,
  spender: string,
): Promise<string | undefined> => {
  const probe = 54321n;
  const iface = new Contract(token, ERC20_ABI, provider).interface;
  const data = iface.encodeFunctionData("allowance", [owner, spender]);
  for (const base of candidateBases(0)) {
    const overrides = {
      [token]: {
        stateDiff: { [nestedSlot(owner, spender, base)]: toBeHex(probe, 32) },
      },
    };
    try {
      const raw: string = await withRetry(() =>
        provider.send("eth_call", [{ to: token, data }, "latest", overrides]),
      );
      if (BigInt(raw) === probe) return base;
    } catch {
      // Same.
    }
  }
  return undefined;
};

type Call = { to: string; data: string; value?: bigint };

const call = async (
  provider: JsonRpcProvider,
  from: string,
  tx: Call,
  overrides: Record<string, unknown>,
): Promise<{ ok: boolean; gas?: bigint; error?: string }> => {
  const payload = {
    from,
    to: tx.to,
    data: tx.data,
    value: `0x${(tx.value ?? 0n).toString(16)}`,
  };
  try {
    await provider.send("eth_call", [payload, "latest", overrides]);
  } catch (err) {
    const e = err as {
      shortMessage?: string;
      message?: string;
      info?: { error?: { message?: string } };
    };
    return {
      ok: false,
      error: e.info?.error?.message ?? e.shortMessage ?? e.message ?? String(err),
    };
  }
  // Gas is a bonus: not every node accepts overrides on eth_estimateGas, and a
  // node that refuses must not turn a successful call into a failure.
  try {
    const raw: string = await provider.send("eth_estimateGas", [
      payload,
      "latest",
      overrides,
    ]);
    return { ok: true, gas: BigInt(raw) };
  } catch {
    return { ok: true };
  }
};

/** The most recent position with collateral behind it, and who owns it. */
const livePosition = async (
  provider: JsonRpcProvider,
  name: (typeof KNOWN_POOLS)[number]["name"],
  poolAddress: string,
) => {
  const nextId = await withRetry(() => getNextFxPositionId(name, provider));
  const nft = new Contract(poolAddress, NFT_ABI, provider);
  for (let back = 1n; back <= 25n && nextId - back > 0n; back += 1n) {
    const id = nextId - back;
    const position = await withRetry(() => getFxPosition(id, name, provider));
    if (position.collateralAmount === 0n || position.debt === 0n) continue;
    try {
      const owner: string = await withRetry(() => nft.ownerOf(id));
      const code = await withRetry(() => provider.getCode(owner));
      // A contract owner cannot be impersonated usefully: the calls would run
      // against its code rather than as a plain account.
      if (code === "0x") return { position, owner };
    } catch {
      // Burnt between the read and the ownerOf. Try the next one down.
    }
  }
  return undefined;
};

const simulatePool = async (
  provider: JsonRpcProvider,
  entry: (typeof KNOWN_POOLS)[number],
): Promise<void> => {
  console.log(`\n=== ${entry.name} (${entry.side}) ===`);
  const pool = resolvePool(entry.name);

  const live = await livePosition(provider, entry.name, pool.address);
  if (!live) {
    ok(`${entry.name}: a live EOA-owned position to simulate against`, false, "none in the last 25 ids");
    return;
  }
  const { position, owner } = live;
  ok(
    `${entry.name}: simulating against a real position`,
    true,
    `#${position.positionId} owned by ${owner.slice(0, 10)}…, ` +
      `coll ${fmt(position.collateralAmount, position.collateralDecimals)}, ` +
      `debt ${fmt(position.debt, position.debtDecimals)}`,
  );

  const poolState = await withRetry(() => getFxPool(entry.name, provider));

  // A full close, sized exactly as the wallet sizes it — including passing the
  // NATIVE debt into the field the cookbook names `rawDebts`.
  const shielded = (position.debt * 12n) / 10n; // 20% headroom over the debt
  const amounts = computeFxClose({
    collateral: position.collateralAmount,
    debt: position.debt,
    availableDebtToken: shielded,
    repayFeeRatio: poolState.repayFeeRatio,
    withdrawFeeRatio: poolState.withdrawFeeRatio,
    railgunUnshieldFeeBps: 25n,
  });
  ok(
    `${entry.name}: the close sizes to a full close`,
    amounts.partialClose === false && amounts.repayAmount > 0n,
    `repay ${fmt(amounts.repayAmount, position.debtDecimals)}, ` +
      `withdraw ${fmt(amounts.withdrawColl, position.collateralDecimals)}`,
  );

  const recipeOutput = await new FxMintCloseRecipe({
    pool: entry.name,
    positionId: position.positionId,
    repayAmount: amounts.repayAmount,
    withdrawColl: amounts.withdrawColl,
    approveAmount: amounts.approveAmount,
    withdrawFeeRatio: poolState.withdrawFeeRatio,
    partialClose: amounts.partialClose,
  }).getRecipeOutput({
    networkName: NetworkName.Ethereum,
    railgunAddress: ZK,
    erc20Amounts: [
      {
        tokenAddress: pool.debtToken,
        decimals: pool.debtDecimals,
        amount: shielded,
      },
    ],
    nfts: [
      {
        nftAddress: pool.address,
        tokenSubID: `0x${position.positionId.toString(16)}`,
        nftTokenType: NFTTokenType.ERC721,
        amount: 1n,
        recipient: ZK,
      },
    ],
  } satisfies RecipeInput);

  const calls = recipeOutput.crossContractCalls as Call[];
  ok(`${entry.name}: the recipe produced calls to replay`, calls.length > 0, `${calls.length} calls`);

  // Give the owner the debt token the unshield would have delivered, and the
  // ETH to pay for the call. Everything else is real state.
  const balanceSlot = await findBalanceSlot(provider, pool.debtToken, owner);
  ok(
    `${entry.name}: located the debt token's balance slot`,
    balanceSlot !== undefined,
    balanceSlot === undefined
      ? "no candidate base answered"
      : `base ${balanceSlot.slice(0, 12)}…`,
  );
  if (balanceSlot === undefined) return;

  const overrides: Record<string, unknown> = {
    [owner]: { balance: toBeHex(10n ** 19n) },
    [pool.debtToken]: {
      stateDiff: { [mapSlot(owner, balanceSlot)]: toBeHex(shielded, 32) },
    },
  };

  // The allowance slot is needed BEFORE the control, because the control has to
  // force the allowance to zero rather than assume it is already zero. These
  // are real accounts that have really used the pool, so several of them carry
  // a residual approval — relying on its absence made the control pass for the
  // wrong reason on the long pools, where the call was reverting for an
  // unrelated defect instead.
  const allowanceSlot = await findAllowanceSlot(
    provider,
    pool.debtToken,
    owner,
    pool.poolManager,
  );
  ok(
    `${entry.name}: located the debt token's allowance slot`,
    allowanceSlot !== undefined,
    allowanceSlot === undefined
      ? "no candidate base answered"
      : `base ${allowanceSlot.slice(0, 12)}…`,
  );
  if (allowanceSlot === undefined) return;
  const allowanceKey = nestedSlot(owner, pool.poolManager, allowanceSlot);

  const operateCall = calls.find(
    (c) => c.to.toLowerCase() === pool.poolManager.toLowerCase(),
  );
  ok(`${entry.name}: the recipe targets the ${entry.side} manager`, Boolean(operateCall));
  if (!operateCall) return;

  // The control: with nothing to pay the debt with, `operate()` MUST revert.
  // A node that reports this as fine is not honouring the overrides, and its
  // verdict on everything else is worthless.
  //
  // The control zeroes the BALANCE, not the allowance. An earlier version
  // zeroed the allowance and was invalid on the long pools: fxUSD privileges
  // the PoolManager to burn, so a long close needs no approval at all and the
  // call succeeded with the allowance at zero. Shorts owe an ordinary ERC20 and
  // do need one. Balance is the condition both sides share.
  const stateDiff = (overrides[pool.debtToken] as {
    stateDiff: Record<string, string>;
  }).stateDiff;
  const balanceKey = mapSlot(owner, balanceSlot);
  stateDiff[balanceKey] = toBeHex(0n, 32);
  stateDiff[allowanceKey] = toBeHex(0n, 32);
  const control = await call(provider, owner, operateCall, overrides);
  ok(
    `${entry.name}: CONTROL — operate with no debt token reverts`,
    !control.ok,
    control.ok ? "it did NOT revert; this simulation proves nothing" : "reverted as required",
  );
  if (control.ok) return;

  stateDiff[balanceKey] = toBeHex(shielded, 32);

  // Now the allowance the approve leg would have set.
  stateDiff[allowanceKey] = toBeHex(amounts.approveAmount, 32);

  let total = 0n;
  for (const [index, tx] of calls.entries()) {
    const label =
      tx.to.toLowerCase() === pool.poolManager.toLowerCase()
        ? "operate"
        : tx.to.toLowerCase() === pool.debtToken.toLowerCase()
          ? "approve (debt token)"
          : tx.to.toLowerCase() === pool.collateralToken.toLowerCase()
            ? "approve (collateral)"
            : `call -> ${tx.to.slice(0, 10)}…`;
    const result = await call(provider, owner, tx, overrides);
    if (result.gas) total += result.gas;
    ok(
      `${entry.name}: leg ${index + 1} ${label}`,
      result.ok,
      result.ok
        ? result.gas
          ? `${result.gas} gas`
          : "no revert (node declined to estimate)"
        : (result.error ?? "").slice(0, 140),
    );
  }
  if (total > 0n) {
    console.log(
      `       inner legs total ${total} gas; + 1,121,136 measured unshield ` +
        `= ${total + 1_121_136n} before the shield`,
    );
  }

  // A full close asks the pool to take ALL the collateral. Passing a computed
  // figure only works where raw and native collateral coincide, which is true
  // of a short (fxUSD, identity scaling) and false of a long (wstETH is
  // rate-scaled, so the pool's conversion back to raw cannot land exactly on
  // the position's rawColls and it refuses to leave the dust). `int256.min`
  // means "all of it" and sidesteps the conversion entirely.
  const operateIface = new Contract(
    pool.poolManager,
    ["function operate(address,uint256,int256,int256) returns (uint256)"],
    provider,
  ).interface;
  const sentinelData = operateIface.encodeFunctionData("operate", [
    pool.address,
    position.positionId,
    INT256_MIN,
    -amounts.repayAmount,
  ]);
  const sentinel = await call(
    provider,
    owner,
    { to: pool.poolManager, data: sentinelData },
    overrides,
  );
  ok(
    `${entry.name}: a full close via the int256.min sentinel`,
    sentinel.ok,
    sentinel.ok
      ? sentinel.gas
        ? `${sentinel.gas} gas`
        : "no revert"
      : (sentinel.error ?? "").slice(0, 120),
  );
};

const main = async (): Promise<void> => {
  console.log(`f(x) write-leg simulation against ${RPC}`);
  console.log("no keys, no funds — eth_call as the real position owner\n");
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });

  for (const entry of KNOWN_POOLS) {
    try {
      await simulatePool(provider, entry);
    } catch (err) {
      ok(
        `${entry.name}: simulation`,
        false,
        err instanceof Error ? err.message.slice(0, 160) : String(err),
      );
    }
  }

  console.log(
    `\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks`,
  );
  console.log(`fxUSD ${FX_ADDRESSES.fxUSD}`);
  process.exitCode = failures === 0 ? 0 : 1;
};

void main();
