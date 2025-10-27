import { toBeHex } from "ethers";
import { launchPilot, promptTokenBalances } from "../mech";
import {
  withdrawFromMech,
  depositIntoMech,
  executeViaMech,
  deployMech,
} from "../mech/ui-actions";
import { mint } from "../mech/ui-actions/mint";
import { status } from "../mech/status";
import {
  confirmPrompt,
  confirmPromptCatch,
  confirmPromptCatchRetry,
} from "./confirm-ui";
import { NetworkName } from "@railgun-community/shared-models";
import { ProgressBar } from "./progressBar-ui";
import { Balances } from "../mech/pilot";
import { MetaTransaction } from "../mech/http";

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
      ? "Mech is subject to a 1h cooldown for POI between executions"
      : "Mech is subject to a 1h cooldown for POI after setup";

    const headerLines = [
      `Mech address: ${mechAddress}`,
      isNFTSpendable ? "✅ Ready for execution" : "⏳ Waiting for POI...",
      isNFTSpendable ? "" : `\n${cooldownMessage}`,
    ].join("\n");

    const optionsWhenReady = [
      { name: "deposit", message: "Move funds into Mech" },
      { name: "withdraw", message: "Re-shield funds from Mech" },
      { name: "launch-pilot", message: "Connect to web3 with Mech" },
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
        const balances = await promptTokenBalances(networkName);

        const nextStepPrompt = new Select({
          header: "Do you want to want to do anything with these funds?",
          message: isNFTSpendable ? "Select an action" : "",
          choices: [
            { name: "execute-immediately", message: "Only move funds" },
            {
              name: "launch-pilot",
              message: "Launch Pilot to connect to web3",
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

            await depositIntoMech({
              depositNFTs: [],
              depositERC20s: Object.entries(erc20).map(
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
  const { resolve, promise: transactionRequestPromise } =
    Promise.withResolvers<MetaTransaction[]>();
  launchPilot(balances, (metaTransactions) => {
    resolve(metaTransactions);
  });

  const pilotPrompt = new Select({
    header: "Waiting for transaction to be submitted from Pilot...",
    message: "",
    choices: [
      { name: "deposit-only", message: "Proceed with moving funds only" },
      { name: "open-pilot", message: "Re-open Pilot" },
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

        await depositIntoMech({
          depositNFTs: [],
          depositERC20s: Object.entries(erc20).map(
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
    // TODO bundle with deposit of `balances` into Mech
    await executeViaMech(result);
  }
};

export const runTestMechMenu = async () => {
  const mechMenuPrompt = new Select({
    header: " ",
    message: "select",
    choices: [
      { name: "status", message: "Show Status" },
      { name: "mint", message: "Mint NFT" },
      { name: "deploy", message: "Deploy Mech" },
      { name: "deposit", message: "Deposit" },
      { name: "exec", message: "Execute" },
      { name: "withdraw", message: "Withdraw" },
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
  } else if (mechChoice === "mint") {
    await mint();
  } else if (mechChoice === "deploy") {
    await deployMech();
  } else if (mechChoice === "exec") {
    //const iface = new ethers.Interface(["function deposit() payable"]);
    //const data = iface.encodeFunctionData("deposit");
    // WRAP ONE POL
    const tx = {
      to: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", // wPOL contract
      data: "0xd0e30db0", // deposit()
      value: toBeHex(BigInt(10 ** 17), 32),
      operation: 0 as any,
    };

    await executeViaMech([tx]);
  } else if (mechChoice === "deposit") {
    await depositIntoMech({
      depositNFTs: [],
      depositERC20s: [
        {
          tokenAddress: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
          amount: BigInt(10 ** 16),
        },
      ],
    });
    await confirmPromptCatchRetry("");
  } else if (mechChoice === "withdraw") {
    // await withdrawFromMech({
    //   withdrawNFTs: [],
    //   withdrawERC20s: [
    //     {
    //       tokenAddress: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    //       amount: BigInt(5 * 10 ** 13),
    //     },
    //   ],
    // });
    await confirmPromptCatchRetry("");
  }
};
