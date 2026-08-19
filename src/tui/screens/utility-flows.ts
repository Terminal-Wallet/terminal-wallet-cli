/**
 * Renderer-agnostic wallet "utility" flows — switch network/wallet, add token,
 * contacts, new/import wallet, reveal mnemonic. Each collects input through the
 * input-provider seam (so it runs in blessed or legacy) and calls the existing
 * core functions. Returns a boolean/info the caller can use to refresh the UI.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { getInputProvider } from "../../core/input";
import {
  switchRailgunNetwork,
  switchRailgunWallet,
} from "../../railgun/wallet/private-wallet";
import { getCurrentWalletName, getWalletNames } from "../../railgun/wallet/wallet-util";
import { getCurrentWalletMnemonicAndIndex } from "../../railgun/wallet/public-utils";
import {
  getCurrentNetwork,
  getProviderOptions,
  setCustomProviderStatus,
  removeCustomProvider,
  loadProviderList,
} from "../../railgun/engine/engine";
import { initilizeFreshWallet, reinitWalletForChain } from "../../railgun/wallet/wallet-init";

const NETWORKS: { label: string; value: NetworkName }[] = [
  { label: "Ethereum", value: NetworkName.Ethereum },
  { label: "Ethereum Sepolia (testnet)", value: NetworkName.EthereumSepolia },
  { label: "Polygon", value: NetworkName.Polygon },
  { label: "Arbitrum", value: NetworkName.Arbitrum },
  { label: "BNB Chain", value: NetworkName.BNBChain },
];

/** Pick + switch the active network. Returns the new network if it changed. */
export const runSwitchNetworkFlow = async (): Promise<NetworkName | undefined> => {
  const provider = getInputProvider();
  const current = getCurrentNetwork();
  const choice = await provider.select(
    "Switch network",
    NETWORKS.map((n) => ({
      label: n.value === current ? `${n.label}  (current)` : n.label,
      value: n.value,
    })),
  );
  if (!choice) return undefined;
  if (choice === current) {
    provider.notify("Already on that network.");
    return undefined;
  }
  provider.notify(`Switching to ${choice}…`);
  await switchRailgunNetwork(choice as NetworkName);
  provider.notify(`Switched to ${choice}.`);
  return choice as NetworkName;
};

/** Pick + switch the active wallet (prompts for the password). Returns true on switch. */
export const runSwitchWalletFlow = async (): Promise<boolean> => {
  const provider = getInputProvider();
  const names = getWalletNames();
  if (names.length <= 1) {
    provider.notify("Only one wallet — use “New / Import Wallet” to add another.");
    return false;
  }
  const current = getCurrentWalletName();
  const choice = await provider.select(
    "Switch wallet",
    names.map((n) => ({ label: n === current ? `${n}  (active)` : n, value: n })),
  );
  if (!choice || choice === current) return false;
  provider.notify(`Loading ${choice}…`);
  const ok = await switchRailgunWallet(choice);
  provider.notify(ok ? `Switched to ${choice}.` : "Wallet switch failed.");
  return !!ok;
};

/** Create or import another wallet, then activate it. Returns true on success. */
export const runNewWalletFlow = async (): Promise<boolean> => {
  const provider = getInputProvider();
  const cache = await initilizeFreshWallet(false);
  if (!cache) {
    provider.notify("Cancelled — no wallet added.");
    return false;
  }
  await reinitWalletForChain(getCurrentNetwork());
  provider.notify("New wallet ready.");
  return true;
};

/**
 * NOTE: Add Token, Contacts, and External-signer import moved to single-page
 * form cards — see src/ui/utility-forms.ts (specs) + src/ui-blessed/form-card.ts
 * (renderer). The deck's signer list/remove menu lives in deck-entry.ts.
 */

/**
 * View / toggle / add / remove this chain's RPC providers over the input-provider
 * seam (the legacy runRPCEditorPrompt is enquirer-bound and won't render in
 * blessed). Returns true if the provider list changed (caller reloads it).
 */
export const runEditRpcFlow = async (
  chainName: NetworkName,
): Promise<boolean> => {
  const provider = getInputProvider();
  const options = getProviderOptions(chainName);
  const pick = await provider.select(`RPC providers · ${chainName}`, [
    ...options.map((o) => ({
      label: o.provider,
      value: `url:${o.provider}`,
      hint: o.enabled ? "enabled" : "disabled",
    })),
    { label: "+ Add custom RPC URL", value: "add", hint: "https://…" },
  ]);
  if (!pick) return false;

  if (pick === "add") {
    const url = await provider.input("Custom RPC URL", { hint: "https://… endpoint" });
    if (!url) {
      provider.notify("Cancelled.");
      return false;
    }
    setCustomProviderStatus(chainName, url.trim(), true);
    await loadProviderList(chainName);
    provider.notify("Added custom RPC.");
    return true;
  }

  const url = pick.slice(4);
  const current = options.find((o) => o.provider === url);
  const action = await provider.select(url, [
    { label: current?.enabled ? "Disable" : "Enable", value: "toggle" },
    { label: "Remove", value: "remove", hint: "custom only" },
  ]);
  if (!action) return false;
  if (action === "toggle") {
    setCustomProviderStatus(chainName, url, !current?.enabled);
  } else {
    removeCustomProvider(chainName, url);
  }
  await loadProviderList(chainName);
  provider.notify(action === "toggle" ? "Provider updated." : "Provider removed.");
  return true;
};

/** Confirm + reveal the current wallet's mnemonic (prompts for password). */
export const revealMnemonic = async (): Promise<
  { mnemonic: string; index: number } | undefined
> => {
  const provider = getInputProvider();
  const ok = await provider.confirm(
    "Reveal this wallet's recovery phrase on screen? Make sure nobody is watching.",
  );
  if (!ok) return undefined;
  const res = await getCurrentWalletMnemonicAndIndex();
  if (!res) {
    provider.notify("Couldn't read the recovery phrase.");
    return undefined;
  }
  return { mnemonic: res.walletMnemonic, index: res.derivationIndex };
};
