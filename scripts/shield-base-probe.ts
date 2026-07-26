/**
 * Probe for the base-token shield: builds the real 7702 bundle and estimates it.
 *
 *   npx tsx scripts/shield-base-probe.ts <AMOUNT>      e.g. … 0.001
 *
 * Nothing is broadcast — it stops at the gas estimate. It prints the ephemeral
 * account, the transaction shape, and the wallet's ability to cover value + gas,
 * then the raw provider rejection if the estimate fails.
 *
 * The SDK's sanitizeError has a final fallback that returns a new Error WITHOUT
 * the cause, so an underlying revert never escapes it. The provider is hooked
 * here to read the reason where it still exists.
 *
 * MUST NOT be run from the repo checkout: opening the engine takes a LevelDB
 * lock on the same .railgun.db a running wallet is using, and a killed run
 * corrupts it. Copy the state to a scratch directory and run there — the guard
 * below refuses otherwise and prints the commands.
 */
import { existsSync, readFileSync } from "fs";
import { formatEther, formatUnits, parseUnits } from "ethers";
import { overrideMainConfig } from "../src/config/config-overrides";
import { initializeWalletSystems } from "../src/railgun/wallet/wallet-init";
import { getCurrentNetwork } from "../src/railgun/engine/engine";
import { getSaltedPassword } from "../src/railgun/wallet/wallet-password";
import {
  getCurrentRailgunAddress,
  getCurrentWalletGasBalance,
  getCurrentWalletPublicAddress,
} from "../src/railgun/wallet/wallet-util";
import {
  getWrappedTokenInfoForChain,
  getProviderForChain,
} from "../src/railgun/network/network-util";
import {
  getShieldBaseTokenGasDetails,
  getProvedShieldBaseTokenTransaction,
} from "../src/railgun/transaction/private-base/shield-base-tx";
import { getCurrentEphemeralInfo } from "../src/railgun/wallet/ephemeral-util";
import { headlessInputProvider } from "../src/diagnostic/headless-input";
import { setInputProvider } from "../src/core/input";
import { errDetail } from "../src/platform/errors";

const line = (k: string, v: unknown) => console.log(`${k.padEnd(28)} ${String(v)}`);

/** Refuse to open the engine against the checkout's live database. */
const assertNotInCheckout = () => {
  const pkg = `${process.cwd()}/package.json`;
  if (!existsSync(pkg)) return;
  try {
    if (JSON.parse(readFileSync(pkg, "utf8")).name !== "terminal-wallet-cli") return;
  } catch {
    return;
  }
  console.log(
    [
      "Refusing to run in the repo checkout — this opens .railgun.db, which a",
      "running wallet may hold. Copy the state somewhere scratch and run there:",
      "",
      "  mkdir -p /tmp/tw-probe && cp -r .railgun.db .zKeyChains .artifacts-2.5 /tmp/tw-probe/",
      "  (cd /tmp/tw-probe && npx tsx <repo>/scripts/shield-base-probe.ts 0.001)",
      "",
      "Close the wallet before copying, so the snapshot is not mid-write.",
    ].join("\n"),
  );
  process.exit(2);
};

const main = async () => {
  assertNotInCheckout();

  const [amountStr] = process.argv.slice(2);
  if (!amountStr) {
    console.log("usage: shield-base-probe <AMOUNT>   (in the chain's base token)");
    process.exit(2);
  }

  setInputProvider(headlessInputProvider);
  await overrideMainConfig("probe");
  await initializeWalletSystems();

  const chainName = getCurrentNetwork();
  const encryptionKey = await getSaltedPassword();
  if (!encryptionKey) throw new Error("no encryption key");

  const wrapped = getWrappedTokenInfoForChain(chainName);
  const { decimals } = wrapped;
  const amount = parseUnits(amountStr, decimals);
  const recipient = {
    tokenAddress: wrapped.wrappedAddress,
    amount,
    recipientAddress: getCurrentRailgunAddress(),
  };

  const { index, address } = await getCurrentEphemeralInfo(chainName, encryptionKey);
  const from = getCurrentWalletPublicAddress();
  const balance = await getCurrentWalletGasBalance();

  console.log("\n--- environment ---");
  line("chain", chainName);
  line("base symbol", wrapped.symbol);
  line("wrapped address", wrapped.wrappedAddress);
  line("from (public wallet)", from);
  line("public balance", `${formatEther(balance)} ${wrapped.symbol}`);
  line("ephemeral index", index);
  line("ephemeral address", address);
  line("shield amount", `${formatUnits(amount, decimals)} ${wrapped.symbol}`);

  // A base-token shield sends `amount` as tx.value AND pays gas from the same
  // account, so the wallet needs value + gas. Committing the whole balance is
  // the common way this fails, and it fails at broadcast rather than estimate:
  // estimateGas does not charge for gas, so it passes and the node refuses.
  if (amount > balance) {
    console.log(`\n!! amount exceeds the balance by ${formatEther(amount - balance)}`);
  } else {
    line("left for gas", `${formatEther(balance - amount)} ${wrapped.symbol}`);
  }

  const provider = getProviderForChain(chainName) as unknown as {
    estimateGas: (tx: unknown) => Promise<bigint>;
  };
  const realEstimateGas = provider.estimateGas.bind(provider);
  provider.estimateGas = async (tx: unknown) => {
    const t = tx as Record<string, unknown>;
    try {
      return await realEstimateGas(tx);
    } catch (e) {
      console.log("\n>>> RAW provider.estimateGas failure");
      line("  tx.type", t.type);
      line("  tx.to", t.to);
      line("  tx.from", t.from);
      line("  tx.value", t.value);
      line("  tx.data bytes", String(t.data ?? "").length);
      line(
        "  authorizationList",
        Array.isArray(t.authorizationList) ? t.authorizationList.length : t.authorizationList,
      );
      console.log("  error: " + errDetail(e, 6));
      const anyErr = e as { info?: unknown; data?: unknown; shortMessage?: unknown };
      if (anyErr.shortMessage) line("  shortMessage", anyErr.shortMessage);
      if (anyErr.data) line("  revert data", anyErr.data);
      if (anyErr.info) console.log("  info: " + JSON.stringify(anyErr.info).slice(0, 600));
      throw e;
    }
  };

  console.log("\n--- gas estimate ---");
  let gas;
  try {
    gas = await getShieldBaseTokenGasDetails(chainName, recipient, encryptionKey);
    const details = gas.estimatedGasDetails as {
      evmGasType: number;
      gasEstimate: bigint;
      maxFeePerGas?: bigint;
      gasPrice?: bigint;
    };
    line("evmGasType", details.evmGasType);
    line("gasEstimate", details.gasEstimate);
    line("price per gas", formatUnits(details.maxFeePerGas ?? details.gasPrice ?? 0n, "gwei") + " gwei");
    line("estimatedCost", `${gas.estimatedCost} ${gas.symbol}`);
    console.log("ESTIMATE OK");
  } catch (err) {
    console.log("ESTIMATE FAILED");
    console.log(errDetail(err, 5));
    console.log("\n--- stack ---");
    console.log((err as Error).stack);
    process.exit(1);
  }

  // Populate too: the estimate can pass while the populated transaction is
  // rejected, and this is where the gas details meet the type-4 bundle.
  console.log("\n--- populate (not broadcast) ---");
  try {
    const tx = await getProvedShieldBaseTokenTransaction(
      chainName,
      recipient,
      gas,
      encryptionKey,
    );
    const t = tx as unknown as Record<string, unknown>;
    line("type", t.type);
    line("to", t.to);
    line("from", t.from);
    line("value", t.value);
    line("gasLimit", t.gasLimit);
    line("maxFeePerGas", t.maxFeePerGas);
    line("maxPriorityFeePerGas", t.maxPriorityFeePerGas);
    line("gasPrice (should be unset)", t.gasPrice);
    line(
      "authorizationList",
      Array.isArray(t.authorizationList) ? t.authorizationList.length : t.authorizationList,
    );

    const price = BigInt((t.maxFeePerGas ?? t.gasPrice ?? 0n) as bigint);
    const cost = price * BigInt((t.gasLimit ?? 0n) as bigint);
    const needed = cost + BigInt((t.value ?? 0n) as bigint);
    line("value + max gas", `${formatEther(needed)} ${wrapped.symbol}`);
    console.log(
      needed > balance
        ? `\n!! NOT AFFORDABLE — short by ${formatEther(needed - balance)} ${wrapped.symbol}.` +
            "\n   estimateGas does not charge for gas, so this passes the estimate and" +
            "\n   is refused at broadcast."
        : "\nAFFORDABLE — value + max gas fits the balance.",
    );
    console.log("\nPOPULATE OK");
  } catch (err) {
    console.log("POPULATE FAILED");
    console.log(errDetail(err, 5));
    console.log("\n--- stack ---");
    console.log((err as Error).stack);
    process.exit(1);
  }
  process.exit(0);
};

main().catch((err) => {
  console.log("PROBE FAILED:", errDetail(err, 5));
  process.exit(1);
});
