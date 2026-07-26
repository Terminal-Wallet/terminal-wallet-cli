/**
 * Reproduce the base-token shield revert with throwaway keys.
 *
 *   npx tsx scripts/shield-base-repro.ts
 *
 * Touches no wallet and no database: a random ephemeral account, a public
 * test 0zk address, and a state-overridden `eth_call` against a public RPC.
 * Safe to run anywhere, including the checkout.
 *
 * It builds the same 7702 bundle the SDK builds, then isolates which call in
 * it reverts by simulating three variants:
 *   1. the bundle as shipped        (wrapBase + shield, shield value = amount)
 *   2. wrapBase alone               (does the wrap work at all?)
 *   3. shield value = 0             ("shield entire balance", which is what
 *                                    the relay-adapt shield helpers use)
 */
import {
  ByteUtils,
  RailgunEngine,
  RelayAdapt7702Helper,
  RelayAdapt7702ExecutionType,
  RelayAdapt__factory,
  ShieldNoteERC20,
  ABIRelayAdapt7702,
  ABIRelayAdapt7702_Legacy_PreExecuteNonce,
} from "@railgun-community/engine";
import { NETWORK_CONFIG, NetworkName } from "@railgun-community/shared-models";
import {
  Interface,
  HDNodeWallet,
  JsonRpcProvider,
  Wallet,
  concat,
  formatEther,
  keccak256,
  parseEther,
  toBeHex,
  zeroPadValue,
} from "ethers";

const RPC = process.env.REPRO_RPC ?? "https://ethereum-rpc.publicnode.com";
// A public test address that ships in this repo's fixtures — not anyone's wallet.
const ZK =
  "0zk1qyzgh9ctuxm6d06gmax39xutjgrawdsljtv80lqnjtqp3exxayuf0rv7j6fe3z53laetcl9u3cma0q9k4npgy8c8ga4h6mx83v09m8ewctsekw4a079dcl5sw4k";

const net = NETWORK_CONFIG[NetworkName.Ethereum];
const CHAIN_ID = BigInt(net.chain.id);
const AMOUNT = parseEther("0.001");

const line = (k: string, v: unknown) => console.log(`${k.padEnd(26)} ${String(v)}`);

const shieldRequestFor = async (value: bigint) => {
  const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(ZK);
  const note = new ShieldNoteERC20(
    masterPublicKey,
    ByteUtils.randomHex(16),
    value,
    net.baseToken.wrappedAddress,
  );
  return note.serialize(ByteUtils.hexToBytes(ByteUtils.randomHex(32)), viewingPublicKey);
};

/** The bundle the SDK builds, with the calls it should contain made selectable. */
const buildBundle = async (
  signer: HDNodeWallet,
  provider: JsonRpcProvider,
  opts: { wrap: boolean; shield: boolean; shieldValue: bigint; staleAuthNonce?: boolean },
) => {
  const eph = signer.address;
  const iface = RelayAdapt__factory.createInterface();
  const request = await shieldRequestFor(opts.shieldValue);

  const calls = [
    ...(opts.wrap
      ? [{ to: eph, data: iface.encodeFunctionData("wrapBase", [AMOUNT]), value: 0n }]
      : []),
    ...(opts.shield
      ? [{ to: eph, data: iface.encodeFunctionData("shield", [[request]]), value: 0n }]
      : []),
  ];
  const actionData = RelayAdapt7702Helper.getActionData(true, calls, 0n);

  const relayAdapt7702 = net.relayAdapt7702Contract as string;
  // A stale authorization nonce is silently skipped on chain: the delegation is
  // NOT applied and whatever code the account already carries runs instead.
  const authNonce =
    (await provider.getTransactionCount(eph, "latest")) + (opts.staleAuthNonce ? 7 : 0);
  const authorization = await RelayAdapt7702Helper.signEIP7702Authorization(
    signer,
    relayAdapt7702,
    CHAIN_ID,
    authNonce,
  );

  const executionType = net.relayAdapt7702SupportsExecuteNonce
    ? RelayAdapt7702ExecutionType.ExecuteWithNonce
    : RelayAdapt7702ExecutionType.LegacyPreExecuteNonce;
  const executionDetails = {
    executionType,
    executeNonce:
      executionType === RelayAdapt7702ExecutionType.ExecuteWithNonce ? 0n : undefined,
  };
  const signature = await RelayAdapt7702Helper.signExecutionAuthorization(
    signer,
    [],
    actionData,
    CHAIN_ID,
    executionDetails,
  );
  const abi =
    executionType === RelayAdapt7702ExecutionType.LegacyPreExecuteNonce
      ? ABIRelayAdapt7702_Legacy_PreExecuteNonce
      : ABIRelayAdapt7702;
  const data = RelayAdapt7702Helper.encodeExecute(
    new Interface(abi),
    [],
    actionData,
    signature,
    executionDetails,
  );
  return { to: eph, data, authorization };
};

const hex = (v: bigint | number) => "0x" + BigInt(v).toString(16);

/** Error(string) selector 0x08c379a0 — the shape SafeERC20's require produces. */
const decodeRevertString = (data: string): string | undefined => {
  if (!data.startsWith("0x08c379a0")) return undefined;
  try {
    return new Interface(["function e(string)"]).decodeFunctionData("e", data)[0] as string;
  } catch {
    return undefined;
  }
};

/**
 * The RPC wants the authorization tuple flat and hex-encoded, not ethers'
 * object. r and s are uint256 there, so the 32-byte zero-padded form ethers
 * carries is rejected outright when the value happens to start with a zero
 * byte — which is why this only failed on some runs.
 */
interface RpcAuth {
  address: string;
  nonce: bigint | number;
  chainId: bigint | number;
  signature: { r: string; s: string; yParity: number };
}

const rpcAuthorization = (auth: RpcAuth) => ({
  chainId: hex(auth.chainId),
  address: auth.address,
  nonce: hex(auth.nonce),
  yParity: hex(auth.signature.yParity),
  r: hex(BigInt(auth.signature.r)),
  s: hex(BigInt(auth.signature.s)),
});

/** WETH9 storage: balanceOf is slot 3, allowance is slot 4. */
const wethBalanceSlot = (owner: string) =>
  keccak256(concat([zeroPadValue(owner, 32), zeroPadValue("0x03", 32)]));
const wethAllowanceSlot = (owner: string, spender: string) =>
  keccak256(
    concat([
      zeroPadValue(spender, 32),
      keccak256(concat([zeroPadValue(owner, 32), zeroPadValue("0x04", 32)])),
    ]),
  );

const simulate = async (
  provider: JsonRpcProvider,
  from: string,
  bundle: { to: string; data: string; authorization: RpcAuth },
  ephemeralState?: { weth?: bigint; allowanceToRailgun?: bigint; delegateTo?: string },
): Promise<string> => {
  const tx = {
    from,
    to: bundle.to,
    data: bundle.data,
    value: "0x" + AMOUNT.toString(16),
    type: "0x4",
    authorizationList: [rpcAuthorization(bundle.authorization)],
  };
  // State override funds `from` so the simulation is about the bundle, not
  // about whether some address happens to hold ETH.
  const overrides: Record<string, unknown> = {
    [from]: { balance: "0x" + parseEther("10").toString(16) },
  };
  if (ephemeralState) {
    const stateDiff: Record<string, string> = {};
    if (ephemeralState.weth !== undefined) {
      stateDiff[wethBalanceSlot(bundle.to)] = toBeHex(ephemeralState.weth, 32);
    }
    if (ephemeralState.allowanceToRailgun !== undefined) {
      stateDiff[wethAllowanceSlot(bundle.to, net.proxyContract)] = toBeHex(
        ephemeralState.allowanceToRailgun,
        32,
      );
    }
    if (Object.keys(stateDiff).length) {
      overrides[net.baseToken.wrappedAddress] = { stateDiff };
    }
    if (ephemeralState.delegateTo) {
      // EIP-7702 delegation designator: 0xef0100 || address.
      overrides[bundle.to] = {
        code: "0xef0100" + ephemeralState.delegateTo.slice(2).toLowerCase(),
      };
    }
  }
  try {
    await provider.send("eth_call", [tx, "latest", overrides]);
    return "OK (no revert)";
  } catch (err) {
    const e = err as {
      shortMessage?: string;
      message?: string;
      data?: string;
      info?: { error?: { message?: string; data?: string } };
    };
    const data = e.data ?? e.info?.error?.data;
    const decoded = data && data.length > 138 ? decodeRevertString(data) : undefined;
    const text = e.info?.error?.message ?? e.shortMessage ?? e.message ?? String(err);
    return decoded ? `${text}  ::  "${decoded}"` : text;
  }
};

const main = async () => {
  const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const signer = Wallet.createRandom().connect(provider);
  const from = Wallet.createRandom().address;

  console.log("--- setup ---");
  line("rpc", RPC);
  line("relayAdapt7702", net.relayAdapt7702Contract);
  line("supportsExecuteNonce", net.relayAdapt7702SupportsExecuteNonce);
  line("wrapped (WETH)", net.baseToken.wrappedAddress);
  line("ephemeral (throwaway)", signer.address);
  line("from (throwaway)", from);
  line("amount", `${formatEther(AMOUNT)} ETH`);

  type Case = {
    wrap: boolean;
    shield: boolean;
    shieldValue: bigint;
    staleAuthNonce?: boolean;
    state?: { weth?: bigint; allowanceToRailgun?: bigint; delegateTo?: string };
  };
  const cases: [string, Case][] = [
    ["1. as shipped (wrap + shield, value = amount)", { wrap: true, shield: true, shieldValue: AMOUNT }],
    ["2. wrapBase alone", { wrap: true, shield: false, shieldValue: AMOUNT }],
    ["3. wrap + shield, value = 0 (entire balance)", { wrap: true, shield: true, shieldValue: 0n }],
    ["4. shield alone, value = amount (no wrap)", { wrap: false, shield: true, shieldValue: AMOUNT }],
    // A reused ephemeral is not a blank one. These are the two states a prior
    // shield at the same index can leave behind.
    [
      "5. reused: leftover WETH allowance to RAILGUN",
      { wrap: true, shield: true, shieldValue: AMOUNT, state: { allowanceToRailgun: AMOUNT } },
    ],
    [
      "6. reused: leftover WETH balance at the ephemeral",
      { wrap: true, shield: true, shieldValue: AMOUNT, state: { weth: parseEther("0.5") } },
    ],
    // The user's hypothesis: an ephemeral left delegated to the OLD relay-adapt,
    // whose delegation is not replaced because the authorization is skipped.
    [
      "7. reused: still delegated to the LEGACY relay-adapt, auth skipped",
      {
        wrap: true,
        shield: true,
        shieldValue: AMOUNT,
        staleAuthNonce: true,
        state: { delegateTo: net.relayAdaptContract },
      },
    ],
    [
      "8. reused: delegated to the 7702 adapter, auth skipped",
      {
        wrap: true,
        shield: true,
        shieldValue: AMOUNT,
        staleAuthNonce: true,
        state: { delegateTo: net.relayAdapt7702Contract as string },
      },
    ],
  ];

  // Case 4 must revert — it shields without wrapping, so there is nothing to
  // shield. An RPC that reports it OK is not honouring the override or the
  // authorization list, and its verdict on the other cases means nothing.
  console.log("\n--- simulations ---");
  const results: string[] = [];
  for (const [label, opts] of cases) {
    const bundle = await buildBundle(signer, provider, opts);
    const result = await simulate(provider, from, bundle, opts.state);
    results.push(result);
    console.log(`${label}\n    -> ${result}\n`);
  }
  if (results[3] === "OK (no revert)") {
    console.log(
      "!! CONTROL FAILED — this RPC reported the impossible case as OK, so it is\n" +
        "   not simulating the bundle. Re-run with REPRO_RPC set to another node.",
    );
    process.exit(1);
  }
  console.log("control held: the impossible case reverted, so the others are meaningful.");
};

main().catch((err) => {
  console.log("REPRO FAILED:", (err as Error).message);
  console.log((err as Error).stack);
  process.exit(1);
});
