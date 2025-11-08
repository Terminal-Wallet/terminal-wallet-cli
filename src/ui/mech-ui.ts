import { Interface } from "ethers";
import { launchPilot, promptTokenBalances } from "../mech";
import { mint } from "../mech/ui-actions";
import { status } from "../mech/status";
import { confirmPromptCatch, confirmPromptCatchRetry } from "./confirm-ui";
import { NetworkName } from "@railgun-community/shared-models";
import { Balances } from "../mech/pilot";
import { MetaTransaction } from "../mech/http";
import {
  operateMech,
  depositIntoMech,
  executeViaMech,
} from "../mech/ui-actions";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Select, Confirm } = require("enquirer");

export const runMechMenu = async (networkName: NetworkName) => {
  const instance = (await status()).at(0);
  // In the future we might allow deploying multiple mechs, but for now we assume only a single mech NFT in the balance

  if (!instance) {
    const deployPrompt = new Select({
      header: [
        "Mech is a smart account that can be used as a temporary base for your assets to privately interact with all of web3.",
      ],
      message: "Deploy a Mech for your Railgun account?",
      choices: [
        { name: "mint-nft", message: "Deploy Mech" },
        {
          name: "back",
          message: "Return to main menu".grey,
        },
      ],
      multiple: false,
    });
    const choice = await deployPrompt.run().catch(confirmPromptCatch);

    if (choice === "mint-nft") {
      await mint();
      console.log("minted nft");
      runMechMenu(networkName);
    }

    return;
  }

  // MECH ALREADY MINTED
  const { mechAddress, isMechDeployed, isNFTSpendable } = instance;

  {
    const cooldownMessage = isMechDeployed
      ? "1-hour cooldown period between transactions (required for proof of innocence)"
      : "1-hour cooldown period after setup (required for proof of innocence)";

    const headerLines = [
      `Mech address: ${mechAddress}`,
      isNFTSpendable ? "✅ Ready for execution" : "⏳ Waiting for POI...",
      isNFTSpendable ? "" : `\n${cooldownMessage}`,
    ].join("\n");

    const optionsWhenReady = [
      { name: "deposit", message: "Move tokens into Mech" },
      { name: "withdraw", message: "Re-shield tokens from Mech" },
      { name: "launch-pilot", message: "Launch Pilot (connect to dApps)" },
    ];

    const mechPrompt = new Select({
      header: headerLines,
      message: isNFTSpendable ? "Select an action" : "",
      choices: [
        ...(isNFTSpendable ? optionsWhenReady : []),
        {
          name: "back-main-menu",
          message: "Return to main menu".grey,
        },
      ],
      multiple: false,
    });

    const choice = await mechPrompt.run().catch(confirmPromptCatch);

    switch (choice) {
      case "deposit": {
        const balances = await promptTokenBalances(networkName, mechAddress);

        const nextStepPrompt = new Select({
          header: "What would you like to do with these tokens?",
          message: isNFTSpendable ? "Select an action" : "",
          choices: [
            { name: "execute-immediately", message: "Deposit tokens only" },
            {
              name: "launch-pilot",
              message: "Open Pilot to interact with dApps",
            },
            {
              name: "cancel",
              message: "Cancel".grey,
            },
          ],
          multiple: false,
        });

        const nextStepChoice = await nextStepPrompt
          .run()
          .catch(confirmPromptCatch);

        switch (nextStepChoice) {
          case "execute-immediately": {
            const { native, ...erc20 } = balances;
            if (native)
              throw new Error("Native balance deposit not supported yet");

            await operateMech({
              unshieldERC20s: Object.entries(erc20).map(
                ([tokenAddress, amount]) => ({
                  tokenAddress,
                  amount,
                }),
              ),
            });
            break;
          }
          case "launch-pilot": {
            await launchPilotUI(balances);
            break;
          }
          case "cancel":
          default: {
            return;
          }
        }
        break;
      }
      case "withdraw": {
        // TODO render token balance prompt for Mech token balances (skip in first demo version)
        throw new Error("Withdraw flow not implemented yet.");
        break;
      }
      case "launch-pilot": {
        await launchPilotUI({});
        break;
      }
      case "back-main-menu":
      default: {
        return;
      }
    }
  }

  runMechMenu(networkName);
};

const launchPilotUI = async (balances: Balances) => {
  const transactionRequestPromise = new Promise<MetaTransaction[]>(
    (resolve) => {
      launchPilot(balances, (metaTransactions) => {
        resolve(metaTransactions);
      });
    },
  );

  const pilotPrompt = new Select({
    header: "Waiting for transaction from Pilot...",
    message: "",
    choices: [
      { name: "deposit-only", message: "Skip Pilot and deposit tokens only" },
      { name: "open-pilot", message: "Open Pilot again" },
      {
        name: "cancel",
        message: "Cancel".grey,
      },
    ],
    multiple: false,
  });

  const choicePromise: Promise<string> = pilotPrompt
    .run()
    .catch(confirmPromptCatch);

  const result = await Promise.race([choicePromise, transactionRequestPromise]);

  if (typeof result === "string") {
    switch (result) {
      case "deposit-only": {
        const { native, ...erc20 } = balances;
        if (native) throw new Error("Native balance deposit not supported yet");

        await operateMech({
          unshieldERC20s: Object.entries(erc20).map(
            ([tokenAddress, amount]) => ({
              tokenAddress,
              amount,
            }),
          ),
        });
        return;
      }
      case "open-pilot": {
        launchPilotUI(balances);
        return;
      }
      case "cancel":
      default: {
        return;
      }
    }
  } else {
    const { native, ...erc20 } = balances;
    if (native) throw new Error("Native balance deposit not supported yet");

    await operateMech({
      unshieldERC20s: Object.entries(erc20).map(([tokenAddress, amount]) => ({
        tokenAddress,
        amount,
      })),
      calls: result,
    });
  }
};

export const runTestMechMenu = async () => {
  const mechMenuPrompt = new Select({
    header: " ",
    message: "select",
    choices: [
      { name: "status", message: "Show Status" },
      { name: "exec", message: "Execute" },
      { name: "back", message: "Back".grey },
    ],
    multiple: false,
  });

  const mechChoice = await mechMenuPrompt.run().catch(confirmPromptCatch);

  if (mechChoice === "status") {
    const entries = await status();
    for (const entry of entries) {
      console.log("-----");
      console.log(` Mech address:   ${entry.mechAddress}`);
      console.log(` NFT address:    ${entry.tokenAddress}`);
      console.log(` TokenId:        ${entry.tokenId}`);
      console.log(` isDeployed:     ${entry.isMechDeployed}`);
      console.log(` isNFTShielded:  ${entry.isNFTShielded}`);
      console.log(` isNFTSpendable: ${entry.isNFTSpendable}`);
      console.log(` isNFTBlocked:   ${entry.isNFTBlocked}`);
    }
    if (entries.length === 0) {
      console.log("No NFT minted or Shielded");
    }

    // Just show status and return to main menu

    await confirmPromptCatchRetry("");

    return;
  } else if (mechChoice === "exec") {
    await justDeposit();
    // await justWithdraw();
    // await justExecute();
    // await executeAndWithdraw();
  }
};

const WPOL = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";

async function justDeposit() {
  // requires 0.01 WPOL to be shielded in Railgun
  await depositIntoMech({
    unshieldERC20s: [
      {
        tokenAddress: WPOL,
        amount: BigInt(10 ** 16),
      },
    ],
  });
}

async function justWithdraw() {
  // REQUIRES 0.001 WPOL in the mech
  // shield WPOL from mech to Railgun
  await executeViaMech({
    shieldERC20s: [
      {
        tokenAddress: WPOL,
        amount: BigInt(10 ** 15),
      },
    ],
  });
}

async function justExecute() {
  // REQUIRES 0.01 POL
  // wraps POL into WPOL
  const tx = {
    to: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // wPOL contract
    data: "0xd0e30db0",
    operation: 0 as any,
    value: BigInt(10 ** 16),
  };

  await executeViaMech({
    calls: [tx],
  });
}

async function executeAndWithdraw() {
  const iface = new Interface([
    "function deposit() payable",
    "function withdraw(uint256 wad)",
  ]);

  // Requires WPOL 0.003 to be sitting in the Mech:
  // Unwraps WPOL into POL 0.001
  // sends 0.001 POL to some EOA
  // shield 0.001 WPOL back to Railgun

  const amount = BigInt(10 ** 15);

  const unwrapTx = {
    to: WPOL,
    data: iface.encodeFunctionData("withdraw", [amount]),
    value: 0,
    operation: 0 as any,
  };

  const sendNative = {
    to: "0x63EDeE5c8E332335630FB1A46607668CCFB2F4eE",
    data: "0x",
    value: amount,
    operation: 0 as any,
  };

  await executeViaMech({
    calls: [unwrapTx, sendNative],
    shieldERC20s: [{ tokenAddress: WPOL, amount: amount }],
  });
}
