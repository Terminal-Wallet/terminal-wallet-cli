import { stopEngine } from "../engine/engine";
import { rimrafSync } from "rimraf";
import path from "path";
import configDefaults from "../config/config-defaults";
import { stopWakuClient } from "../waku/connect-waku";
import { disposeExternalSigners } from "../wallet/signer/registry";

export const RAILGUN_HEADER = `
 ███████████ ██████████ ███████████   ██████   ██████ █████ ██████   █████   █████████   █████      
░█░░░███░░░█░░███░░░░░█░░███░░░░░███ ░░██████ ██████ ░░███ ░░██████ ░░███   ███░░░░░███ ░░███       
░   ░███  ░  ░███  █ ░  ░███    ░███  ░███░█████░███  ░███  ░███░███ ░███  ░███    ░███  ░███       
    ░███     ░██████    ░██████████   ░███░░███ ░███  ░███  ░███░░███░███  ░███████████  ░███       
    ░███     ░███░░█    ░███░░░░░███  ░███ ░░░  ░███  ░███  ░███ ░░██████  ░███░░░░░███  ░███       
    ░███     ░███ ░   █ ░███    ░███  ░███      ░███  ░███  ░███  ░░█████  ░███    ░███  ░███      █
    █████    ██████████ █████   █████ █████     █████ █████ █████  ░░█████ █████   █████ ███████████
   ░░░░░    ░░░░░░░░░░ ░░░░░   ░░░░░ ░░░░░     ░░░░░ ░░░░░ ░░░░░    ░░░░░ ░░░░░   ░░░░░ ░░░░░░░░░░░ 
`;

export const clearConsoleBuffer = async () => {
  process.stdout.write("\u{033}[2J\u001b[H\u001b[2J\u001b[3J");
};

const killEngineAndWaku = async () => {
  await stopWakuClient();
  await stopEngine();
};

export const processDestroyExit = async () => {
  console.log("Deleting Database And Keychains");
  await killEngineAndWaku();
  await disposeExternalSigners();

  const { databasePath, artifactPath, keyChainPath } = configDefaults.engine;

  const fullDBPath = path.join(process.cwd(), databasePath);
  const fullArtifactPath = path.join(process.cwd(), artifactPath);
  const fullKeyChainPath = path.join(process.cwd(), keyChainPath);

  rimrafSync(fullDBPath);
  rimrafSync(fullArtifactPath);
  rimrafSync(fullKeyChainPath);

  clearConsoleBuffer();
  console.log("Goodbye. :(");
};

export const processSafeExit = async () => {
  console.log("Shutting Down Modules");
  clearConsoleBuffer();
  await killEngineAndWaku();
  await disposeExternalSigners();
  console.clear();
  process.exit(0);
};

process.on("SIGINT", async () => {
  console.clear();
  await processSafeExit();
});
process.on("unhandledRejection", async (err: Error | string) => {
  const error = err as Error;
  if (error.message.indexOf("could not coalesce") !== -1) {
    return;
  }
  // console.log("unhandledRejection", err);
});
process.on("uncaughtException", (err: Error | string) => {
  const error = err as Error;
  if (error.message.indexOf("already held by process") !== -1) {
    return;
  }
  // console.log("uncaughtException", err);
});

export const setConsoleTitle = (
  titleMessage = "🛡️ TERMINAL WALLET - CLI for 0x and 0zk addresses",
) => {
  if (process.platform == "win32") {
    process.title = titleMessage;
  } else {
    process.stdout.write("\x1b]2;" + titleMessage + "\x1b\x5c");
  }
};

export const printLogo = () => {
  console.log(RAILGUN_HEADER);
};

export const resizeWindow = (width: number, heigth: number) => {
  process.stdout.write(`\u{033}[8;${heigth};${width}t`);
};
