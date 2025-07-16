import { startHttpServer } from "./http";

const PILOT_BASE_URL = "http://localhost:3040"; // "https://app.pilot.gnosisguild.org";

export const launchPilot = async () => {
  const open = (await import("open")).default;

  console.log("Starting Pilot callback server...");
  const port = await startHttpServer();
  const callbackAddress = `http://localhost:${port}`;

  const prefixedAddress = "matic:0x1234567890123456789012345678901234567890";
  const label = "Terminal Mech";

  const launchUrl = new URL(
    `/offline/launch/${prefixedAddress}/${encodeURIComponent(label)}`,
    PILOT_BASE_URL,
  );
  launchUrl.searchParams.set("callback", callbackAddress);

  await open(launchUrl.toString());
};
