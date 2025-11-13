import {
  ensureHttpServer,
  MetaTransaction,
  onTransactionRequest,
} from "./http";

const PILOT_BASE_URL = "https://app.pilot.gnosisguild.org";

export type Balances = {
  native?: bigint;
} & {
  [address: `0x${string}`]: bigint;
};

// ethers toBeHex pads so that an even number of hex digits are returned
// We need a hex string with absolutely no padding!
const toHex = (value: bigint) => {
  return "0x" + value.toString(16);
};

const encodeBalanceSpoofRequests = (
  address: `0x${string}`,
  balances: Balances,
) => {
  return Object.entries(balances).map(([token, balance]) =>
    token === "native"
      ? {
          jsonrpc: "2.0",
          method: "pilot_addBalance",
          params: [[address], toHex(balance)],
        }
      : {
          jsonrpc: "2.0",
          method: "pilot_addErc20Balance",
          params: [token, [address], toHex(balance)],
        },
  );
};

const RAILGUN_FEE_BPS = 25n; // 0.25%

const subtractRailgunFee = (balances: Balances) =>
  Object.fromEntries(
    Object.entries(balances).map(([token, balance]) => [
      token,
      balance - (balance * RAILGUN_FEE_BPS) / 10000n,
    ]),
  );

export const launchPilot = async (
  mechAddress: `0x${string}`,
  balances: Balances,
  processTransactionRequest: (request: MetaTransaction[]) => void,
) => {
  const open = (await import("open")).default;

  onTransactionRequest(processTransactionRequest);
  const { port, secret } = await ensureHttpServer();
  const callbackAddress = `http://localhost:${port}?secret=${secret}`;

  const chainShortName = "matic";
  const label = "Terminal Mech";

  const launchUrl = new URL(
    `/offline/launch/${chainShortName}:${mechAddress.toLowerCase()}/${encodeURIComponent(
      label,
    )}`,
    PILOT_BASE_URL,
  );
  launchUrl.searchParams.set("callback", callbackAddress);
  launchUrl.searchParams.set(
    "setup",
    JSON.stringify(
      encodeBalanceSpoofRequests(mechAddress, subtractRailgunFee(balances)),
    ),
  );

  await open(launchUrl.toString());
};
