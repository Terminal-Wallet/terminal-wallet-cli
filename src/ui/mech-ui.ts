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
            await launchPilotUI(mechAddress, balances);
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
        await launchPilotUI(mechAddress);
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

const launchPilotUI = async (
  mechAddress: `0x${string}`,
  balances: Balances = {},
) => {
  const transactionRequestPromise = new Promise<MetaTransaction[]>(
    (resolve) => {
      launchPilot(mechAddress, balances, (metaTransactions) => {
        resolve(metaTransactions);
      });
    },
  );

  const hasDeposits = Object.values(balances).some((amount) => amount > 0n);

  const pilotPrompt = new Select({
    header: "Waiting for transaction from Pilot...",
    message: "",
    choices: [
      ...(hasDeposits
        ? [
            {
              name: "deposit-only",
              message: "Skip Pilot and deposit tokens only",
            },
          ]
        : []),
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
        launchPilotUI(mechAddress, balances);
        return;
      }
      case "cancel":
      default: {
        return;
      }
    }
  } else {
    // received Pilot callback

    // cancel prompt
    pilotPrompt.cancel();

    const { native, ...erc20 } = balances;
    if (native) throw new Error("Native balance deposit not supported yet");

    console.log({
      unshieldERC20s: Object.entries(erc20).map(([tokenAddress, amount]) => ({
        tokenAddress,
        amount,
      })),
      calls: result,
    });

    await operateMech({
      unshieldERC20s: Object.entries(erc20).map(([tokenAddress, amount]) => ({
        tokenAddress,
        amount,
      })),
      calls: result,
    });
  }
};
