import { toBeHex } from "ethers";
import { startHttpServer } from "./http";

const PILOT_BASE_URL = "http://localhost:3040"; // "https://app.pilot.gnosisguild.org";

export type Balances = {
  native?: bigint;
} & {
  [address: `0x${string}`]: bigint;
};

const encodeBalanceSpoofRequests = (
  address: `0x${string}`,
  balances: Balances,
) => {
  return Object.entries(balances).map(([token, balance]) =>
    token === "native"
      ? {
          method: "pilot_addBalance",
          params: [[address], toBeHex(balance)],
        }
      : {
          method: "pilot_addErc20Balance",
          params: [token, [address], toBeHex(balance)],
        },
  );
};

export const launchPilot = async (balances: Balances) => {
  const open = (await import("open")).default;

  console.log("Starting Pilot callback server...");
  const port = await startHttpServer();
  const callbackAddress = `http://localhost:${port}`;

  const address = "0x1234567890123456789012345678901234567890";
  const chainShortName = "matic";
  const label = "Terminal Mech";

  const launchUrl = new URL(
    `/offline/launch/${chainShortName}:${address}/${encodeURIComponent(label)}`,
    PILOT_BASE_URL,
  );
  launchUrl.searchParams.set("callback", callbackAddress);
  launchUrl.searchParams.set(
    "setup",
    JSON.stringify(encodeBalanceSpoofRequests(address, balances)),
  );

  await open(launchUrl.toString());
};
