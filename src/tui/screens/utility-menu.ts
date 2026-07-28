/**
 * The scoped card menus and everything they can invoke.
 *
 * Each top card opens only its own concern — wallet, network, sync, utilities —
 * and one dispatcher handles every action id. The per-card menus decide which
 * ids a card surfaces; this decides what an id does.
 *
 * Long-running engine work (rescans, POI, history) is started and reported
 * rather than awaited: it runs for minutes and its progress arrives as scan and
 * balance events, so holding a menu open on it would block the UI on something
 * it cannot show. Both outcomes report through the store so a failure is
 * visible instead of silently never finishing.
 */
import { NetworkName } from "@railgun-community/shared-models";
import { refreshBalances } from "@railgun-community/wallet";
import { DeckContext } from "../context";
import { getState, setState, setStatusMessage } from "../store";
import { getInputProvider, InputChoice } from "../../core/input";
import { tag, short } from "../format/tags";
import { showAddresses, refreshAfterSwitch } from "./addresses";
import { showMnemonic } from "./mnemonic";
import { showAddToken, showAddContact, showSigners } from "./forms";
import { runPOITools } from "./poi-tools";
import {
  runSwitchNetworkFlow,
  runSwitchWalletFlow,
  runNewWalletFlow,
  runEditRpcFlow,
  revealMnemonic,
} from "./utility-flows";
import { walletMenu, networkMenu, statusMenu, utilitiesMenu } from "./deck-menus";
import {
  buildBroadcasterRows,
} from "./broadcaster-list-edit";
import {
  getBroadcasterFavorites,
  getBroadcasterBlocklist,
  setBroadcasterPref,
  moveBroadcasterFavorite,
  BroadcasterPref,
} from "../../railgun/wallet/broadcaster-prefs";
import { favoriteRank } from "../../flows/broadcaster-rank";
import {
  listExternalSigners,
} from "../../railgun/wallet/external-signers";
import {
  getDefaultFeeModePref,
  setDefaultFeeModePref,
  shouldShowSender,
  toggleShouldShowSender,
  getCurrentRailgunID,
} from "../../railgun/wallet/wallet-util";
import {
  fullTxidRescan,
  fullRescanAll,
} from "../../railgun/wallet/wallet-tools";
import {
  startWakuClient,
  stopWakuClient,
  resetWakuClient,
} from "../../railgun/waku/connect-waku";
import { getChainForName } from "../../railgun/network/network-util";
import { loadTransactionHistory } from "../../railgun/transaction-history";
import { confirmPassword } from "../../railgun/wallet/wallet-password";
import { processDestroyExit } from "../../platform/lifecycle";
import { openEphemeralConsole } from "./ephemeral-console";

const network = (): NetworkName => getState().network as NetworkName;

/** Report the outcome of work that was started rather than awaited. */
const report = (label: string, work: Promise<unknown>, done: string) => {
  void work
    .then(() => setStatusMessage(done))
    .catch((err: Error) => setStatusMessage(`${label} failed: ${err.message}`));
};

/**
 * Kick a single engine scan and re-read the display.
 *
 * Guarded against stacking: repeated clicks would queue scans the engine is
 * already retrying internally.
 */
let refreshing = false;
export const refreshNow = async (ctx: DeckContext): Promise<void> => {
  if (refreshing) {
    setStatusMessage("Refresh already in progress…");
    return;
  }
  refreshing = true;
  setStatusMessage("Refreshing balances…");
  try {
    refreshBalances(getChainForName(network()), [getCurrentRailgunID()]);
    await ctx.refreshBalances();
    await ctx.refreshChainStats();
    // Deliberately not a terminal message: the scan reports its own completion
    // (adapter, scan:complete) and replaces this. Claiming "will populate as it
    // completes" and then never updating is what made the footer look frozen.
    setStatusMessage("Scanning…");
  } catch (err) {
    setStatusMessage(`Refresh failed: ${(err as Error).message}`);
  } finally {
    refreshing = false;
  }
};

/**
 * Broadcaster allow/blocklist, and the order favourites are tried in.
 *
 * Favourites are ranked: #1 is the broadcaster new sends default to, and the
 * rest are fallbacks in order. Selecting a row opens its actions rather than
 * cycling in place, because promote/demote needs somewhere to live and having
 * this disagree with the same editor in the fee flow would be worse. Edits
 * persist as they are made rather than on exit.
 */
export const showBroadcasterList = async (): Promise<void> => {
  const provider = getInputProvider();
  for (;;) {
    const lists = {
      favorites: getBroadcasterFavorites(),
      blocklist: getBroadcasterBlocklist(),
    };
    const choices: InputChoice[] = buildBroadcasterRows(lists).map((row) => ({
      label:
        row.pref === "favorite"
          ? `${tag(`#${row.rank + 1}`, "yellow")} ${tag(short(row.address), "green")}`
          : `   ${tag(short(row.address), "red")}`,
      value: row.address,
      hint:
        row.rank === 0
          ? "default for new sends"
          : row.pref === "favorite"
            ? `fallback #${row.rank}`
            : "blocked",
    }));
    choices.push({
      label: tag("+ Add broadcaster…", "yellow"),
      value: "__add",
      hint: "0zk address",
    });
    choices.push({ label: "Done", value: "__done" });

    const picked = await provider.select("Broadcaster allow / blocklist", choices);
    if (!picked || picked === "__done") {
      return;
    }
    if (picked === "__add") {
      const address = await provider.input("Broadcaster 0zk address", {
        hint: "added as favorite",
      });
      if (address?.trim()) {
        setBroadcasterPref(address.trim(), "favorite");
      }
      continue;
    }
    const rank = favoriteRank(lists.favorites, picked);
    const isFavorite = rank !== Number.POSITIVE_INFINITY;
    const action = await provider.select(short(picked), [
      ...(isFavorite && rank > 0
        ? [
            { label: "Make default", value: "top", hint: "to #1" },
            { label: "▲ Move up", value: "up", hint: `to #${rank}` },
          ]
        : []),
      ...(isFavorite && rank < lists.favorites.length - 1
        ? [{ label: "▼ Move down", value: "down", hint: `to #${rank + 2}` }]
        : []),
      ...(isFavorite
        ? []
        : [{ label: "Favorite", value: "favorite", hint: "adds to the end" }]),
      { label: "Block", value: "blocked", hint: "hide it" },
      { label: "Remove", value: "none" },
    ]);
    if (!action) continue;
    if (action === "top") moveBroadcasterFavorite(picked, -lists.favorites.length);
    else if (action === "up") moveBroadcasterFavorite(picked, -1);
    else if (action === "down") moveBroadcasterFavorite(picked, 1);
    else setBroadcasterPref(picked, action as BroadcasterPref);
  }
};

/**
 * The default fee mode for new private sends.
 *
 * This is the signer choice only. Which broadcaster relays a send is decided
 * separately, by the favourites order: #1 if it is reachable, otherwise the
 * next favourite, otherwise whoever is cheapest.
 */
export const showDefaultFeeSetting = async (): Promise<void> => {
  const provider = getInputProvider();
  const current = getDefaultFeeModePref();
  const choice = await provider.select("Default fee mode (new private sends)", [
    {
      label: "Broadcaster (auto-best)",
      value: "broadcaster",
      hint: current === "broadcaster" ? "current" : "relay · pay in-token",
    },
    {
      label: "Self-send (your public wallet pays gas)",
      value: "self-signer",
      hint: current === "self-signer" ? "current" : undefined,
    },
    ...listExternalSigners().map((s) => ({
      label: `External signer — ${s.label}`,
      value: `external:${s.label}`,
      hint: current === `external:${s.label}` ? "current" : short(s.address),
    })),
  ]);
  if (!choice) {
    return;
  }
  setDefaultFeeModePref(choice);
  provider.notify(
    `Default fee: ${
      choice === "broadcaster"
        ? "broadcaster (auto-best)"
        : choice === "self-signer"
          ? "self-send"
          : choice.replace("external:", "external — ")
    }.`,
  );
};

/**
 * Destroy every trace of the wallet on this device.
 *
 * Two confirmations and a password re-entry, because it is unrecoverable
 * without the seed. The destroy tears the modules down and exits the process
 * itself, so nothing runs after it.
 */
export const showDestruct = async (): Promise<void> => {
  const provider = getInputProvider();
  if (!(await provider.confirm("Destroy ALL wallet data on this device?"))) {
    return;
  }
  if (
    !(await provider.confirm(
      "There is NO recovery without your seed. Continue?",
    ))
  ) {
    return;
  }
  if (!(await confirmPassword().catch(() => false))) {
    provider.notify("Password did not match — aborted.");
    return;
  }
  setStatusMessage("Wiping all data…");
  await processDestroyExit();
};

/** What each action id does. The per-card menus decide which ids are offered. */
export const dispatchUtility = async (
  ctx: DeckContext,
  id: string,
): Promise<void> => {
  const net = network();
  switch (id) {
    // --- wallet ---
    case "switch-wallet":
      if (await runSwitchWalletFlow()) await refreshAfterSwitch(ctx);
      break;
    case "new-wallet":
      if (await runNewWalletFlow()) await refreshAfterSwitch(ctx);
      break;
    case "contacts":
      await showAddContact(ctx);
      break;
    case "signers":
      await showSigners(ctx);
      break;
    case "mnemonic": {
      const revealed = await revealMnemonic();
      if (revealed) await showMnemonic(ctx, revealed.mnemonic, revealed.index);
      break;
    }
    case "reveal-address":
      await showAddresses(ctx);
      break;

    // --- network ---
    case "network":
      if (await runSwitchNetworkFlow()) await refreshAfterSwitch(ctx);
      break;
    case "add-token":
      await showAddToken(ctx);
      break;
    case "edit-rpc":
      await runEditRpcFlow(net);
      break;
    case "waku-start":
      setStatusMessage("Starting Waku…");
      report("Waku start", startWakuClient(net), "Waku started.");
      break;
    case "waku-stop":
      setStatusMessage("Stopping Waku…");
      report("Waku stop", stopWakuClient(), "Waku stopped.");
      break;
    case "reset-broadcasters":
      setStatusMessage("Refreshing Waku / broadcasters…");
      report(
        "Reset",
        resetWakuClient(),
        "Waku / broadcasters refreshed.",
      );
      break;
    case "broadcaster-prefs":
      await showBroadcasterList();
      break;

    // --- sync and maintenance ---
    case "refresh":
      await refreshNow(ctx);
      break;
    case "txid-rescan":
      setStatusMessage("Full TXID rescan started…");
      report("TXID rescan", fullTxidRescan(net), "TXID rescan complete.");
      break;
    case "full-rescan":
      // Hard resync of both trees. The latched sync state is cleared so the
      // bars regenerate visibly rather than sitting on a stale ✓.
      setStatusMessage("Full UTXO + TXID rescan started — watch the sync card.");
      setState({
        utxoReady: false,
        txidReady: false,
        utxoSynced: false,
        txidSynced: false,
        utxoProgress: 0,
        txidProgress: 0,
        utxoLeaves: -1,
        txidLeaves: -1,
      });
      report("Full rescan", fullRescanAll(net), "Full rescan complete.");
      break;
    case "poi":
      await runPOITools(net);
      break;
    case "activity":
      setStatusMessage("Loading activity…");
      report(
        "History",
        loadTransactionHistory(net, getCurrentRailgunID()),
        "Activity loaded.",
      );
      break;

    // --- utilities ---
    case "default-fee":
      await showDefaultFeeSetting();
      break;
    case "toggle-sender":
      toggleShouldShowSender();
      setStatusMessage(
        `Private TX sender ${shouldShowSender() ? "shown" : "hidden"}.`,
      );
      break;
    case "ephemeral-accounts":
      await openEphemeralConsole(ctx);
      break;
    case "destruct":
      await showDestruct();
      break;
  }
};

const openCardMenu = async (
  ctx: DeckContext,
  title: string,
  choices: InputChoice[],
): Promise<void> => {
  const id = await getInputProvider().select(title, choices);
  if (id) {
    await dispatchUtility(ctx, id);
  }
};

export const openWalletMenu = (ctx: DeckContext) =>
  openCardMenu(ctx, "◆ Wallet", walletMenu());
export const openNetworkMenu = (ctx: DeckContext) =>
  openCardMenu(ctx, "○ Network", networkMenu());
export const openStatusMenu = (ctx: DeckContext) =>
  openCardMenu(ctx, "↻ Sync & maintenance", statusMenu());
export const openUtilitiesMenu = (ctx: DeckContext) =>
  openCardMenu(ctx, "▸ Utilities", utilitiesMenu(shouldShowSender()));
