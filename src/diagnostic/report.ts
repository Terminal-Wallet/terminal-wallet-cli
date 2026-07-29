/**
 * Diagnostic entry — the wallet's non-UI face.
 *
 * Two modes, because they answer different questions and have different
 * audiences:
 *
 *   selftest  Bring up everything that does NOT need a wallet: remote config,
 *             the RAILGUN engine, the artifact store, RPC providers. Never
 *             prompts, so it is safe to run unattended. This is the CI gate.
 *
 *   status    A full boot. Prompts for the password once, then reports what the
 *             wallet actually sees: addresses, balances, merkletree heights,
 *             broadcaster reachability. This is the thing to run when something
 *             looks wrong.
 *
 * Both exist permanently. `status` stays the fastest way to answer "is it the
 * wallet or is it the network" without reading a rendered screen, and `selftest`
 * stays the only boot check that needs no human.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { setInputProvider } from "../core/input";
import { headlessInputProvider } from "./headless-input";
import configDefaults from "../config/config-defaults";
import { overrideMainConfig } from "../config/config-overrides";
import { updateApiKey } from "../railgun/transaction/zeroX/0x-swap";
import {
  initRailgunEngine,
  loadEngineProvidersForNetwork,
  getTreeHeight,
  isEngineRunning,
} from "../railgun/engine/engine";
import { initializeWalletSystems } from "../railgun/wallet/wallet-init";
import {
  getCurrentWalletName,
  getCurrentRailgunAddress,
  getCurrentWalletPublicAddress,
} from "../railgun/wallet/wallet-util";
import {
  getPrivateERC20BalancesForChain,
  getPublicERC20BalancesForChain,
} from "../railgun/balance/balance-util";
import { isWakuConnected, isWakuLoaded } from "../railgun/waku/connect-waku";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../../package.json");

type StepResult = { name: string; ok: boolean; detail?: string };

const results: StepResult[] = [];

const step = async (name: string, fn: () => Promise<string | void>) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? undefined });
    console.log(`  [ ok ] ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    const detail = (err as Error).message;
    results.push({ name, ok: false, detail });
    console.log(`  [FAIL] ${name} — ${detail}`);
  }
};

const line = (label: string, value: string) =>
  console.log(`  ${label.padEnd(20)} ${value}`);

/**
 * Everything that can be verified without a wallet, and therefore without a
 * password. Ordered as the real boot orders it, so a failure here localises the
 * same way a failed boot would.
 */
const runSelftest = async (network: NetworkName): Promise<void> => {
  console.log(`terminal-wallet v${version} — selftest (${network})`);

  await step("remote config", async () => {
    await overrideMainConfig(version);
    // Hand the fetched 0x key to the SDK exactly as the deck does, then report
    // whether one arrived. Presence only — never the value. A swap quote fails
    // with "no API key configured" when this is missing, and that is far easier
    // to read here than from inside a failed transaction.
    updateApiKey();
    const zeroX = configDefaults.apiKeys?.zeroXApi;
    return `resolved · 0x key ${zeroX ? "present" : "MISSING (swaps will fail)"}`;
  });

  await step("railgun engine", async () => {
    await initRailgunEngine();
    if (!isEngineRunning()) {
      throw new Error("engine reported not running after start");
    }
    return `db ${configDefaults.engine.databasePath}`;
  });

  await step("artifact store", async () => configDefaults.engine.artifactPath);

  await step("rpc providers", async () => {
    await loadEngineProvidersForNetwork(network);
    return network;
  });
};

/**
 * A full boot plus a state dump. Prompts once for the password — it cannot be
 * automated, and deliberately so: see the CI note in the module header.
 */
const runStatus = async (network: NetworkName): Promise<void> => {
  await runSelftest(network);

  console.log("");
  await step("wallet boot", async () => {
    await initializeWalletSystems();
    return getCurrentWalletName();
  });

  if (results.some((r) => !r.ok)) {
    return;
  }

  console.log("\nidentity");
  line("wallet", getCurrentWalletName());
  line("public", getCurrentWalletPublicAddress());
  line("private", getCurrentRailgunAddress());

  console.log("\nsync");
  for (const tree of ["utxo", "txid"] as const) {
    const height = await getTreeHeight(network, tree);
    line(
      tree,
      height
        ? `tree ${height.tree}, ${height.leaves} leaves`
        : "unavailable — not scanned yet",
    );
  }

  console.log("\nbalances");
  try {
    const priv = await getPrivateERC20BalancesForChain(network);
    const pub = await getPublicERC20BalancesForChain(network);
    line("private tokens", `${priv?.length ?? 0}`);
    line("public tokens", `${pub?.length ?? 0}`);
  } catch (err) {
    line("balances", `unavailable — ${(err as Error).message}`);
  }

  console.log("\nbroadcasters");
  line("waku client", isWakuLoaded() ? "loaded" : "not loaded");
  line("connection", isWakuConnected() ? "connected" : "disconnected");
};

export const runDiagnostic = async (argv: string[]): Promise<number> => {
  // This host's answer to the input seam. Registered before any boot step, so
  // core never reaches an unregistered provider.
  setInputProvider(headlessInputProvider);

  const network = configDefaults.engine.defaultChain;
  const full = !argv.includes("--selftest");

  if (full) {
    await runStatus(network);
  } else {
    await runSelftest(network);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  if (failed.length > 0) {
    console.log(`${failed.length}/${results.length} checks FAILED`);
    return 1;
  }
  console.log(`${results.length}/${results.length} checks passed`);
  return 0;
};
