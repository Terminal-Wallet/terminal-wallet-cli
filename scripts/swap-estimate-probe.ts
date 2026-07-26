/**
 * Differential probe for the private-swap gas estimate.
 *
 * Run it in the working checkout and in this one, then diff the two outputs.
 * The source of both trees is equivalent, so whatever differs here is the
 * actual cause — and it will be data, not code.
 *
 *   npx tsx scripts/swap-estimate-probe.ts <SELL_SYMBOL> <BUY_SYMBOL> <AMOUNT>
 *
 * e.g.  npx tsx scripts/swap-estimate-probe.ts WETH DAI 0.001
 *
 * It boots the wallet exactly as the app does (so it prompts for the password
 * once), builds the swap inputs, and calls the estimate. Nothing is broadcast
 * and no state is written — it stops at the estimate.
 *
 * Print only. Amounts and addresses are already visible in the builder; the
 * encryption key is never logged.
 */
import { formatUnits } from "ethers";
import { overrideMainConfig } from "../src/config/config-overrides";
import { initializeWalletSystems } from "../src/railgun/wallet/wallet-init";
import { getCurrentNetwork } from "../src/railgun/engine/engine";
import { getPrivateERC20BalancesForChain } from "../src/railgun/balance/balance-util";
import { getSaltedPassword } from "../src/railgun/wallet/wallet-password";
import { getWrappedTokenInfoForChain } from "../src/railgun/network/network-util";
import {
  getZer0XSwapInputs,
  getZer0XSwapTransactionGasEstimate,
} from "../src/railgun/transaction/zeroX/0x-swap";
import { getCurrentEphemeralInfo } from "../src/railgun/wallet/ephemeral-util";
import { updateApiKey } from "../src/railgun/transaction/zeroX/0x-swap";
import { headlessInputProvider } from "../src/diagnostic/headless-input";
import { setInputProvider } from "../src/core/input";
import { errDetail } from "../src/platform/errors";

const line = (k: string, v: unknown) => console.log(`${k.padEnd(28)} ${String(v)}`);

const main = async () => {
  const [sellSymbol, buySymbol, amountStr] = process.argv.slice(2);
  if (!sellSymbol || !buySymbol || !amountStr) {
    console.log("usage: swap-estimate-probe <SELL> <BUY> <AMOUNT>");
    process.exit(2);
  }

  setInputProvider(headlessInputProvider);
  await overrideMainConfig("probe");
  updateApiKey();
  await initializeWalletSystems();

  const chainName = getCurrentNetwork();
  const encryptionKey = await getSaltedPassword();
  if (!encryptionKey) throw new Error("no encryption key");

  const balances = await getPrivateERC20BalancesForChain(chainName);
  const sell = balances.find((b) => b.symbol === sellSymbol);
  if (!sell) {
    console.log(`sell token ${sellSymbol} not in spendable balances:`);
    for (const b of balances) console.log(`  ${b.symbol}`);
    process.exit(1);
  }
  const buy = balances.find((b) => b.symbol === buySymbol) ?? {
    tokenAddress: buySymbol,
    symbol: buySymbol,
    decimals: 18,
  };

  const wrapped = getWrappedTokenInfoForChain(chainName);
  const { index, address } = await getCurrentEphemeralInfo(chainName, encryptionKey);

  console.log("\n--- environment ---");
  line("chain", chainName);
  line("wrapped symbol", wrapped.symbol);
  line("ephemeral index", index);
  line("ephemeral address", address);

  console.log("\n--- quote inputs ---");
  line("sell", `${sell.symbol} ${sell.tokenAddress}`);
  line("sell isBaseToken", wrapped.symbol === sell.symbol);
  line("buy", `${buy.symbol} ${buy.tokenAddress}`);
  line("buy isBaseToken", wrapped.symbol === buy.symbol);
  line("amount", amountStr);

  const amount = BigInt(Math.round(Number(amountStr) * 10 ** sell.decimals));
  const inputs = await getZer0XSwapInputs(
    chainName,
    { tokenAddress: sell.tokenAddress, isBaseToken: wrapped.symbol === sell.symbol },
    { tokenAddress: buy.tokenAddress, isBaseToken: wrapped.symbol === buy.symbol },
    amount,
    320,
    false,
    encryptionKey,
  );

  console.log("\n--- recipe output ---");
  line("quote present", Boolean(inputs?.quote));
  line("minGasLimit", inputs?.minGasLimit);
  line("unshield amounts", inputs?.relayAdaptUnshieldERC20Amounts?.length);
  for (const u of inputs?.relayAdaptUnshieldERC20Amounts ?? []) {
    line("  unshield", `${u.tokenAddress} ${u.amount}`);
  }
  line("shield recipients", inputs?.relayAdaptShieldERC20Addresses?.length);
  line("cross-contract calls", inputs?.crossContractCalls?.length);
  (inputs?.crossContractCalls ?? []).forEach((c, i) =>
    line(`  call[${i}]`, `to=${c.to} data=${String(c.data).length}b value=${c.value ?? 0n}`),
  );
  if (inputs?.quote) {
    line("quote spender", inputs.quote.spender);
    line("quote buy amount", inputs.quote.buyERC20Amount?.amount);
    line("quote min buy", inputs.quote.minimumBuyAmount);
  }

  console.log("\n--- gas estimate (self-send, no broadcaster) ---");
  try {
    const gas = await getZer0XSwapTransactionGasEstimate(
      chainName,
      inputs,
      encryptionKey,
      undefined,
    );
    line("evmGasType", gas?.estimatedGasDetails?.evmGasType);
    line("gasEstimate", gas?.estimatedGasDetails?.gasEstimate);
    line("estimatedCost", `${gas?.estimatedCost} ${gas?.symbol}`);
    console.log("\nESTIMATE OK");
  } catch (err) {
    console.log("\nESTIMATE FAILED");
    console.log(errDetail(err, 5));
    console.log("\n--- stack ---");
    console.log((err as Error).stack);
  }
  process.exit(0);
};

main().catch((err) => {
  console.log("PROBE FAILED:", errDetail(err, 5));
  process.exit(1);
});
