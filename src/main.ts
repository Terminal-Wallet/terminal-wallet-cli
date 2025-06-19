import { runMainMenu, walletBalancePoller } from "./ui/main-ui";
import {
  clearConsoleBuffer,
  printLogo,
  processSafeExit,
  setConsoleTitle,
} from "./util/error-util";
import { initializeWalletSystems } from "./wallet/wallet-init";
import { latestBalancePoller } from "./wallet/scan-callbacks";
import { overrideMainConfig, versionCheck } from "./config/config-overrides";
import { updateApiKey } from "./transaction/zeroX/0x-swap";
const { version } = require("../package.json");

const main = async () => {
  await overrideMainConfig(version);
  setConsoleTitle();
  printLogo();
  versionCheck(version);
  updateApiKey()
  await initializeWalletSystems().catch(async (err) => {
    await processSafeExit();
  });
  walletBalancePoller();
  runMainMenu();
  latestBalancePoller(10 * 1000);
};

clearConsoleBuffer();
main();
