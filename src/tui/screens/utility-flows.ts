/**
 * Renderer-agnostic wallet "utility" flows — switch network/wallet, add token,
 * contacts, new/import wallet, reveal mnemonic. Each collects input through the
 * input-provider seam (so it runs in blessed or legacy) and calls the existing
 * core functions. Returns a boolean/info the caller can use to refresh the UI.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { getInputProvider, RpcRowInput } from "../../core/input";
import { probeRpcEndpoint } from "../../railgun/network/rpc-probe";
import configDefaults from "../../config/config-defaults";
import { loadAppConfig } from "../../config/config-manager";
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
  // The EFFECTIVE base list, which twallet.config.json replaces outright when
  // it carries an override — so on a machine with one, there are no built-ins
  // in play and a list of one endpoint is correct, not broken.
  const base = new Set(
    configDefaults.networkConfig[chainName].providers.map(
      (p: { provider: string }) => p.provider,
    ),
  );
  const fromConfig = new Set(loadAppConfig().providers?.[chainName] ?? []);

  const rows: RpcRowInput[] = options.map((o) => ({
    url: o.provider,
    enabled: o.enabled,
    // Only an endpoint added in the editor lives on the keychain and can be
    // removed there. Anything in the base list comes back on the next load.
    origin: fromConfig.has(o.provider)
      ? "config"
      : base.has(o.provider)
        ? "builtin"
        : "custom",
  }));

  // Probing is the flow's job, not the modal's — the seam stays free of the
  // network, and the list repaints as each answer lands rather than blocking on
  // the slowest endpoint.
  const probe = (targets: RpcRowInput[], repaint: () => void) => {
    for (const row of targets) {
      void probeRpcEndpoint(row.url).then((result) => {
        row.probe = result;
        repaint();
      });
    }
  };

  const edits = await provider.promptRpcEndpoints(
    `RPC endpoints · ${chainName}`,
    rows,
    probe,
  );
  if (!edits) return false;
  if (!edits.length) {
    provider.notify("No changes.");
    return false;
  }

  for (const edit of edits) {
    if (edit.action === "remove") removeCustomProvider(chainName, edit.url);
    else setCustomProviderStatus(chainName, edit.url, edit.action === "enable");
  }
  await loadProviderList(chainName);
  provider.notify(
    `Updated ${edits.length} endpoint${edits.length === 1 ? "" : "s"}.`,
  );
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
