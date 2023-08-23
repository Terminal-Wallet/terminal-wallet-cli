import { runMainMenu } from "./ui/main-ui";
import {
  clearConsoleBuffer,
  printLogo,
  processSafeExit,
  setConsoleTitle,
} from "./util/error-util";
import { initializeWalletSystems } from "./wallet/wallet-init";
import { latestBalancePoller } from "./wallet/scan-callbacks";
const { version } = require("../package.json");

const main = async () => {
  setConsoleTitle();
  printLogo();
  console.log(("v" + version).grey);

  await initializeWalletSystems().catch(async (err) => {
    await processSafeExit();
  });
  runMainMenu();
  latestBalancePoller(10 * 1000);
};

clearConsoleBuffer();
main();
