import { RailgunTransaction } from "../models/transaction-models";
import { getPrivateDisplayBalances } from "../balance/balance-util";
import { getCurrentNetwork } from "../engine/engine";
import {
  getChainForName,
  getWrappedTokenInfoForChain,
} from "../network/network-util";
import {
  resetMenuForScan,
  runFreshWalletPrompt,
  switchRailgunNetwork,
  switchRailgunWallet,
} from "../wallet/private-wallet";

import { getCurrentWalletMnemonicAndIndex } from "../wallet/public-utils";
import {
  shouldDisplayPrivateBalances,
  getCurrentRailgunAddress,
  getCurrentRailgunID,
  getCurrentWalletName,
  getCurrentWalletPublicAddress,
  getWalletNames,
  togglePrivateBalances,
  isMenuResponsive,
  toggleResponsiveMenu,
} from "../wallet/wallet-util";
import { runTransactionBuilder } from "../transaction/transaction-builder";

import { runAddKnownAddress } from "./known-address-ui";
import {
  RAILGUN_HEADER,
  clearConsoleBuffer,
  processDestroyExit,
  processSafeExit,
} from "../util/error-util";
import { runAddTokenPrompt } from "./token-ui";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
  confirmPromptExit,
} from "./confirm-ui";
import {
  NetworkName,
  TXIDVersion,
  isDefined,
} from "@railgun-community/shared-models";
import {
  refreshRailgunBalances,
  rescanFullUTXOMerkletreesAndWallets,
} from "@railgun-community/wallet";
import {
  clearHashedPassword,
  getSaltedPassword,
} from "../wallet/wallet-password";
import { isWakuConnected, resetWakuClient } from "../waku/connect-waku";
import { getScanProgressString } from "../wallet/wallet-manager";
import "colors";
import { getStatusText, setStatusText } from "./status-ui";
import { runRPCEditorPrompt } from "./provider-ui";
const { version } = require("../../package.json");

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select } = require("enquirer");

const stripColors = (input: string): string => {
  return input.replace(/\x1B[[(?);]{0,2}(;?\d)*./g, "");
};

let lastMenuSelection: string | undefined = undefined;

export const runWalletSelectionPrompt = async (): Promise<boolean> => {
  const walletNames = getWalletNames().map((name) => {
    return {
      name,
      message:
        getCurrentWalletName() === name ? `${name} ${"(Active)".dim}` : name,
    };
  });
  const switchOptionPrompt = new Select({
    header: ` `,
    message: "Switching Wallet",
    format: " ",
    default: " ",
    choices: walletNames,
    multiple: false,
  });
  const switchOption = await switchOptionPrompt.run().catch(confirmPromptCatch);
  if (switchOption) {
    try {
      const switchResult = await switchRailgunWallet(switchOption);
      if (!isDefined(switchResult)) {
        return false;
      }
      if (isDefined(switchResult) && switchResult === true) {
        return true;
      }
    } catch (error) {
      console.log("Failed during switch...");
    }
  }

  const retry = await confirmPrompt(`Try Selection Again?`, {
    initial: false,
  });
  if (retry) {
    return runWalletSelectionPrompt();
  }
  return false;
};

const runNetworkSelectionPrompt = async () => {
  const selectNetworkPrompt = new Select({
    header: " ",
    message: "Network Selection",
    choices: [
      { name: NetworkName.Ethereum, message: `${"Ethereum".green} Network` },
      { name: NetworkName.BNBChain, message: `${"Binance".green} Network` },
      { name: NetworkName.Polygon, message: `${"Polygon".green} Network` },
      { name: NetworkName.Arbitrum, message: `${"Arbitrum".green} Network` },
      {
        name: NetworkName.EthereumGoerli,
        message: `${"Ethereum Görli".green} Testnet`,
      },
      {
        name: NetworkName.ArbitrumGoerli,
        message: `${"Arbitrum Görli".green} Testnet`,
      },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });
  const selectedNetwork = await selectNetworkPrompt
    .run()
    .catch(confirmPromptCatch);
  if (selectedNetwork) {
    if (selectedNetwork !== "exit-menu") {
      await switchRailgunNetwork(selectedNetwork);
    }
  }
};

const runWalletToolsPrompt = async (chainName: NetworkName) => {
  const generateOptionPrompt = new Select({
    header: " ",
    message: "Wallet Tools",
    choices: [
      { name: "add-wallet", message: "Add Wallet" },
      {
        name: "show-mnemonic",
        message: "Show Current Mnemonic & Index",
      },
      { name: "full-balance-rescan", message: "Full Balance Rescan" },
      {
        name: "destruct-wallet",
        message: "WIPE ALL DATA... DANGER!!! DANGER!!!",
        hint: "This Will Destroy your terminal wallet cache and railgun wallet database.",
      },
      { name: "exit-menu", message: "Go Back".grey },
    ],
    multiple: false,
  });
  const generateOption = await generateOptionPrompt
    .run()
    .catch(confirmPromptCatch);
  if (generateOption) {
    switch (generateOption) {
      case "add-wallet": {
        const newWalletInfo = await runFreshWalletPrompt(chainName);
        if (newWalletInfo) {
          console.log(newWalletInfo);
          await confirmPromptCatchRetry("");
        }
        break;
      }
      case "show-mnemonic": {
        const walletInfo = await getCurrentWalletMnemonicAndIndex();
        if (isDefined(walletInfo)) {
          console.log(walletInfo);
          await confirmPromptCatchRetry("");
        }
        break;
      }
      case "full-balance-rescan": {
        const chain = getChainForName(chainName);
        resetMenuForScan();
        rescanFullUTXOMerkletreesAndWallets(chain);
        break;
      }
      case "destruct-wallet": {
        const confirmDestroy1 = await confirmPrompt(
          "Are you sure you wish to DESTROY your wallet DATA?",
        );
        if (confirmDestroy1) {
          const confirmDestroy2 = await confirmPrompt(
            "You're Okay with this?",
            { hint: " | Theres NO recovering after this..." },
          );
          if (confirmDestroy2) {
            const confirmPassword = await getSaltedPassword();
            if (isDefined(confirmPassword)) {
              setStatusText(
                "SELF DESTRUCT ENABLED... scheduled in 3..2...1....",
                3000,
              );
              setTimeout(() => {
                processDestroyExit();
              }, 4000);
            }
          }
        }
        break;
      }
      default: {
        break;
      }
    }
  }
};

const getMainPrompt = (networkName: NetworkName, baseSymbol: string) => {
  return new Select({
    logoHeader: RAILGUN_HEADER,
    header: async () => {
      const relayerStatus = `Relayers: ${
        isWakuConnected()
          ? "Available".dim.green.bold
          : "Disconnected".dim.yellow.bold
      }`.grey;

      const walletName = getCurrentWalletName();
      const currentRailgunAddress = getCurrentRailgunAddress();
      const currentPublicAddress = getCurrentWalletPublicAddress();

      const { rows } = process.stdout;

      const walletInfoString = `${"Wallet".grey}: ${walletName}
[Private] ${currentRailgunAddress.grey}
[Public ] ${currentPublicAddress.grey}
      `;

      const statusString = getStatusText();
      const scanString = getScanProgressString();
      const balanceScanned =
        scanString === "" ? statusString : `${scanString}${statusString}`;
      const balanceBlock = await getPrivateDisplayBalances(networkName).then(
        (v) => {
          return v;
        },
      );

      return [
        "",
        walletInfoString,
        relayerStatus,
        balanceBlock,
        `${
          !isMenuResponsive()
            ? "Auto Refresh Disabled, Refresh on Movement Enabled.\n".yellow.dim
            : ""
        }${balanceScanned}`,
      ].join("\n");
    },
    format() {
      return " ";
    },
    right() {
      if (this.index > 10) {
        this.index = this.choices.length - 1;
      } else {
        this.index += 12;
      }
      if (this.isDisabled()) {
        return this.down();
      }
      return this.index;
    },
    left() {
      if (this.index > 11) {
        this.index -= 12;
      } else {
        if (this.index < 11) {
          this.index += 12;
        } else {
          this.index = this.choices.length - 1;
        }
      }
      if (this.isDisabled()) {
        return this.down();
      }
      return this.index;
    },
    async render() {
      const { submitted, size } = this.state;

      let prompt = "";
      const header = await this.header();
      const prefix = await this.prefix();
      const separator = await this.separator();
      const message = await this.message();

      if (this.options.promptLine !== false) {
        prompt = [prefix, message, separator, ""].join(" ");
        this.state.prompt = prompt;
      }

      const output = await this.format();
      const help = (await this.error()) || (await this.hint());
      const body = await this.renderChoices();
      const footer = await this.footer();

      if (output) prompt += output;
      if (help && !prompt.includes(help)) prompt += " " + help;

      if (
        submitted &&
        !output &&
        !body.trim() &&
        this.multiple &&
        this.emptyError != null
      ) {
        prompt += this.styles.danger(this.emptyError);
      }

      this.clear(size);
      this.write(
        [this.logoHeader, prompt, "", header, body, footer]
          .filter(Boolean)
          .join("\n"),
      );
      this.write(this.margin[2]);
      this.restore();
    },
    async renderChoices() {
      if (this.state.submitted) return " ";

      const choices = this.visible.map(
        async (ch: any, i: number) => await this.renderChoice(ch, i),
      );
      const visible = await Promise.all(choices);

      const privActions = visible.slice(0, 4);
      const pubActions = visible.slice(4, 9);
      const swapActions = visible.slice(9, 12);
      const utilActions = visible.slice(12, 18);
      const extraUtilAction = visible.slice(18, 23);
      const exitAction = visible.slice(23);

      const txstuff = [...privActions, " ", ...pubActions, " ", ...swapActions];
      const utilstuff = [
        ...utilActions,
        " ",
        ...extraUtilAction,
        " ",
        ...exitAction,
      ];

      const columns = txstuff.map((item) => {
        const txItem = utilstuff.shift();
        if (isDefined(txItem)) {
          const itemLength = stripColors(item).length;
          const itemBuff = item.length - itemLength;

          const newLine = `${item.padEnd(35 + itemBuff, " ")}${txItem}`;
          return newLine;
        }
        return item;
      });

      const cleanup = [
        ...columns,
        ...utilstuff.map((us) => {
          return us.padStart(35 + us.length, " ");
        }),
      ];

      return cleanup.join("\n");
    },
    async keypress(input: any, key = input ?? {}) {
      const now = Date.now();
      const elapsed = now - this.lastKeypress;
      this.lastKeypress = now;
      const isEnterKey = key.name === "return" || key.name === "enter";
      const isESCKey = key.name === "escape";
      this.state.prevKeypress = key;

      const isLeft = key.name == "left";
      const isRight = key.name == "right";
      const isUp = key.name == "up";
      const isDown = key.name == "down";
      if (isLeft) {
        this.left();
      }
      if (isRight) {
        this.right();
      }

      if (isUp) {
        this.up();
      }

      if (isDown) {
        this.down();
      }

      if (isEnterKey) {
        this.submit();
      }
      return this.render();
    },
    prefix: process.platform === "win32" ? " [*]" : "🛡️ ",
    message: `Now arriving at Terminal Wallet ${("v" + version).grey}... ${
      "(Featuring RAILGUN Privacy)".grey
    }`,
    separator: " ",
    initial: lastMenuSelection ?? "private-transfer",
    choices: [
      {
        message: ` >> ${"Private Actions".grey.bold} <<`,
        role: "separator",
      },

      {
        name: "private-transfer",
        message: `Send ${"ERC20s".cyan.bold} Privately`,
      },
      {
        name: "unshield-private-balances",
        message: `Unshield ${"ERC20s".cyan.bold}`,
      },

      {
        name: "base-unshield",
        message: `Unshield [${baseSymbol.cyan.bold}]`,
      },
      {
        message: ` >> ${"Public Actions".grey.bold} <<`,
        role: "separator",
      },
      {
        name: "shield-public-balances",
        message: `Shield ${"ERC20s".cyan.bold}`,
      },
      {
        name: "base-shield",
        message: `Shield [${baseSymbol.cyan.bold}]`,
      },
      {
        name: "public-transfer",
        message: `Send ${"ERC20s".cyan.bold} Publicly`,
      },
      {
        name: "public-base-transfer",
        message: `Send [${baseSymbol.cyan.bold}]`,
      },
      {
        message: ` >> ${"0X SWAP Tools".grey.bold} <<`,
        role: "separator",
      },
      {
        name: "private-swap",
        message: `${"Privately"} ${"SWAP"} ${"ERC20".cyan.bold} ${"Tokens"}`,
      },
      {
        name: "public-swap",
        message: `${"Publicly"} ${"SWAP"} ${"ERC20".cyan.bold} ${"Tokens"}`,
      },
      {
        message: ` >> ${"Utilities".grey.bold} <<`,
        role: "separator",
      },
      { name: "wallet-tools", message: "Wallet Tools" },
      { name: "switch-wallet", message: "Switch Wallet" },
      { name: "network", message: "Switch Network" },
      { name: "add-token", message: "Add New ERC20 Token" },
      {
        name: "edit-contact-addresses",
        message: "Add / Edit Contact Addresses",
      },
      { name: "refresh-balances", message: "Refresh Balances" },
      {
        name: "toggle-balance",
        message: `Toggle ${
          shouldDisplayPrivateBalances() ? "Public" : "Private"
        } Balances`.yellow.dim,
      },
      { name: "reset-relayers", message: "Reset Relayer Connection" },
      { name: "edit-rpc", message: "Edit RPC Providers" },
      {
        name: "toggle-responsive",
        message: `${isMenuResponsive() ? "Disable" : "Enable"} Responsive Menu`,
        hint: isMenuResponsive() ? "(experiencing flicker?)" : "",
      },
      {
        name: "exit",
        message: `Exit${process.platform === "win32" ? "?" : " 💫"}`.grey,
      },
    ],
    multiple: false,
  });
};

const BufferManager = {
  lastClearTime: 0,
  clear() {
    const nowTime = Date.now();
    const timeDifference = nowTime - this.lastClearTime;
    if (timeDifference > 1 * 250) {
      if (process.stdout.rows < 50) {
        this.lastClearTime = nowTime;
        clearConsoleBuffer();
      }
    }
  },
};

export const runMainMenu = async () => {
  clearHashedPassword();
  const networkName = getCurrentNetwork();
  clearConsoleBuffer();

  const { symbol: baseSymbol } = getWrappedTokenInfoForChain(networkName);
  const mainPrompt = getMainPrompt(networkName, baseSymbol);

  const bufferMgr = BufferManager;

  if (isMenuResponsive()) {
    mainPrompt.once("close", () => clearTimeout(mainPrompt.state.timeout));
    const pulse = (interval: number) => {
      mainPrompt.state.timeout = setTimeout(async () => {
        bufferMgr.clear();
        mainPrompt.render();
        pulse(interval);
      }, interval);
    };
    mainPrompt.on("run", () => {
      pulse(250);
    });
  }

  mainPrompt.on("submit", () => {
    clearConsoleBuffer();
  });

  const menuSelection = await mainPrompt.run().catch(async (err: any) => {
    const confirm = await confirmPromptExit(`Do you wish to EXIT?`, {
      initial: true,
    });
    if (!isDefined(confirm) || confirm) {
      clearConsoleBuffer();
      await processSafeExit();
    }
    return false;
  });

  if (isDefined(menuSelection)) {
    switch (menuSelection) {
      case "toggle-balance":
      case "reset-relayers":
      case "toggle-responsive":
      case "refresh-balances":
        lastMenuSelection = menuSelection;
        break;
      default:
        lastMenuSelection = undefined;
        break;
    }
  }

  switch (menuSelection) {
    case "public-swap": {
      const public_swap_test = await runTransactionBuilder(
        networkName,
        RailgunTransaction.Public0XSwap,
      );
      break;
    }
    case "private-swap": {
      {
        const private_swap_test = await runTransactionBuilder(
          networkName,
          RailgunTransaction.Private0XSwap,
        );
        break;
      }
    }
    case "private-transfer": {
      const transfer_test = await runTransactionBuilder(
        networkName,
        RailgunTransaction.Transfer,
      );
      break;
    }
    case "unshield-private-balances": {
      console.log("Unshielding PRIVATE Balances");
      const unshield_test = await runTransactionBuilder(
        networkName,
        RailgunTransaction.Unshield,
      );
      break;
    }
    case "public-base-transfer": {
      const public_base_tx_test = await runTransactionBuilder(
        networkName,
        RailgunTransaction.PublicBaseTransfer,
      );
      break;
    }
    case "public-transfer": {
      const public_tx_test = await runTransactionBuilder(
        networkName,
        RailgunTransaction.PublicTransfer,
      );
      break;
    }
    case "shield-public-balances": {
      const shield_test = await runTransactionBuilder(
        networkName,
        RailgunTransaction.Shield,
      );
      break;
    }
    case "base-unshield": {
      const unshield_base = await runTransactionBuilder(
        networkName,
        RailgunTransaction.UnshieldBase,
      );
      break;
    }
    case "base-shield": {
      const shield_base = await runTransactionBuilder(
        networkName,
        RailgunTransaction.ShieldBase,
      );
      break;
    }
    case "settings": {
      const settingsPrompt = new Select({
        header: " ",
        message: "Settings Panel",
        choices: [{ name: "exit", message: "Go Back".grey }],
        multiple: false,
      });
      const settingsSelection = await settingsPrompt
        .run()
        .catch(confirmPromptCatch);
      switch (settingsSelection) {
        case "exit":
          break;
        default:
          break;
      }
      break;
    }
    case "switch-wallet": {
      await runWalletSelectionPrompt();
      break;
    }
    case "network": {
      await runNetworkSelectionPrompt();
      break;
    }
    case "wallet-tools": {
      await runWalletToolsPrompt(networkName);
      break;
    }
    case "refresh-balances": {
      const chain = getChainForName(networkName);
      const railgunWalletID = getCurrentRailgunID();
      const txIDVersion = TXIDVersion.V2_PoseidonMerkle;
      const fullRescan = true;
      resetMenuForScan();
      setStatusText(
        "Starting Balance Refresh. This may take some time... ".yellow,
      );
      refreshRailgunBalances(txIDVersion, chain, railgunWalletID, fullRescan);
      break;
    }
    case "rpc-tools": {
      console.log("Opening RPC Manager");
      break;
    }
    case "edit-contact-addresses": {
      await runAddKnownAddress();
      break;
    }
    case "add-token": {
      await runAddTokenPrompt(networkName);
      break;
    }
    case "toggle-balance": {
      togglePrivateBalances();
      break;
    }
    case "reset-relayers": {
      resetWakuClient();
      break;
    }
    case "edit-rpc": {
      await runRPCEditorPrompt(networkName);
      break;
    }
    case "toggle-responsive": {
      toggleResponsiveMenu();
      break;
    }
    case "exit": {
      clearConsoleBuffer();
      await processSafeExit();
      return;
    }
    default: {
      break;
    }
  }
  clearConsoleBuffer();
  runMainMenu();
};


