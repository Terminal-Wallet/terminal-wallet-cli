import {
  getCustomProviderEnabledStatus,
  getProviderPromptOptions,
  isDefaultProvider,
  setCustomProviderStatus,
  removeCustomProvider,
  loadProviderList,
} from "../engine/engine";
import { confirmPromptCatch, confirmPromptCatchRetry } from "./confirm-ui";
import {
  NETWORK_CONFIG,
  NetworkName,
  isDefined,
  promiseTimeout,
} from "@railgun-community/shared-models";
import { setStatusText } from "./status-ui";
import { getProviderForURL } from "../network/network-util";
const { Select, Input } = require("enquirer");

export const addProviderPrompt = async (
  chainName: NetworkName,
): Promise<boolean | undefined> => {
  const { publicName } = NETWORK_CONFIG[chainName];
  const prompt = new Input({
    header: " ",
    message: `Please enter a RPC Provider URL for ${publicName}`,
  });

  const resultURL = await prompt.run().catch(confirmPromptCatch);

  if (resultURL) {
    const provider = getProviderForURL(resultURL);
    try {
      const currentBlock = await provider.getBlock("latest");
      if (isDefined(currentBlock)) {
        setCustomProviderStatus(chainName, resultURL, true);
        return true;
      } else {
        throw new Error("Invalid RPC URL Endpoint");
      }
    } catch (error) {
      setStatusText("Invalid RPC URL".yellow);
    } finally {
      provider.destroy();
    }
  }
  return undefined;
};

export const runProviderEditorPrompt = async (
  chainName: NetworkName,
  rpcProviderURL: string,
): Promise<boolean | undefined> => {
  const enabledStatus = getCustomProviderEnabledStatus(
    chainName,
    rpcProviderURL,
  );

  const defaultProvider = isDefaultProvider(chainName, rpcProviderURL);

  const options = [];

  if (enabledStatus === true) {
    options.push({ name: "disable", message: `Disable` });
  } else {
    options.push({ name: "enable", message: `Enable` });
  }

  if (!defaultProvider) {
    options.push({ name: "remove", message: "Remove RPC" });
  }
  options.push({ name: "exit", message: "Go Back" });

  const editRPCSelection = new Select({
    header: ` `,
    message: `Modifying RPC:  ${rpcProviderURL}`,
    format: " ",
    default: " ",
    choices: options,
    multiple: false,
  });
  const rpcOption = await editRPCSelection.run().catch(() => {
    return undefined;
  });

  if (rpcOption) {
    if (rpcOption === "exit") {
      return undefined;
    }

    const action =
      rpcOption === "enable"
        ? true
        : rpcOption === "disable"
        ? false
        : undefined;

    if (isDefined(action)) {
      setCustomProviderStatus(chainName, rpcProviderURL, action);
    } else {
      removeCustomProvider(chainName, rpcProviderURL);
    }
    loadProviderList(chainName);
  }
  return rpcOption;
};

export const runRPCEditorPrompt = async (
  chainName: NetworkName,
): Promise<void> => {
  const rpcSelections = getProviderPromptOptions(chainName);
  const editRPCPrompt = new Select({
    header: ` `,
    message: "Add/Edit RPC Providers",
    format: " ",
    default: " ",
    choices: [
      ...rpcSelections,
      { name: "add-rpc", message: "Add Custom RPC" },
      { name: "exit", message: "Go Back" },
    ],
    multiple: false,
  });

  const rpcOption = await editRPCPrompt.run().catch(confirmPromptCatch);
  if (rpcOption) {
    try {
      if (rpcOption === "exit") {
        return;
      }
      if (rpcOption === "add-rpc") {
        const resultProvider = await addProviderPrompt(chainName);
        if (isDefined(resultProvider)) {
          return;
        }
      } else {
        const editorResult = await runProviderEditorPrompt(
          chainName,
          rpcOption,
        );
        if (isDefined(editorResult)) {
          return;
        }
      }
    } catch (error) {
      setStatusText("Failed during RPC edit...");
    }
    return await runRPCEditorPrompt(chainName);
  }
};
