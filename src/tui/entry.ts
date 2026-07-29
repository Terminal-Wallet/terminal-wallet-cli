/**
 * The deck: the terminal wallet's screen.
 *
 * A dashboard rather than a menu tree — the portfolio, activity and sync state
 * are visible at once, and actions are reached from what you can see rather than
 * by descending through prompts. Clicking a balance seeds a transaction with
 * that token; the command palette shows every flow the current selection allows.
 *
 * This module owns the widgets and nothing else. State comes from the store,
 * which the adapter fills from the core bus; the things the deck has to go and
 * fetch live in the feeders; each screen is its own module and receives a
 * context rather than reaching in here. What remains is layout, drawing, and
 * wiring — which is the part that genuinely needs the widget handles.
 */
import blessed from "blessed";
import { NetworkName } from "@railgun-community/shared-models";
import { DeckContext } from "./context";
import { ensureFocus } from "./widgets/focus-guard";
import { createFeeders } from "./feeders";
import { getState, setState, setStatusMessage, subscribe, WalletState } from "./store";
import { footerStatus } from "./format/footer";
import { attachCoreAdapter } from "./adapter";
import { createBlessedInputProvider } from "./input-provider";
import { setInputProvider } from "../core/input";
import { onCoreEvent } from "../core/events";
import { installDeckLogSink, releaseDeckLogSink } from "./log-sink";
import { setTerminalRestore } from "../platform/lifecycle";
import { tag, short } from "./format/tags";
import {
  pctDelta,
  deltaColor,
  gasTicker,
  fmtAmount,
} from "./format/deck";
import { formatHistoryRows } from "./format/history";
import { syncTreeLine } from "./format/dashboard";
import { nextShieldMaturity, pendingNote } from "./format/shield-timer";
import {
  buildPortfolioRows,
  groupPrivateByToken,
  bucketTag,
  PortfolioRow,
  TokenGroup,
} from "./format/balances";
import { formatUSD } from "../price/portfolio";
import {
  computeLayout,
  defaultRails,
  tierFor,
  LEFT_W,
  RIGHT_W,
  CARD_H,
  CARD_TOP,
  TOP,
} from "./layout";
import { copyToClipboard } from "./widgets/clipboard";
import { openModalCount, shifted } from "./widgets/modal";
import { deckClickVerdict, escapeReachesDeck } from "./nav";
import { createPalette } from "./screens/palette";
import { createBuilder } from "./screens/builder";
import { showLogs, showText, showTxReview } from "./screens/popout";
import {
  openWalletMenu,
  openNetworkMenu,
  openStatusMenu,
  openUtilitiesMenu,
  refreshNow,
} from "./screens/utility-menu";
import { TokenKind } from "./screens/palette-grid";
import { getInputProvider } from "../core/input";
import { CoreHistoryItem } from "../core/history";
import { RailgunDisplayBalance } from "../models/balance-models";
import {
  getAllPrivateERC20BalancesForChain,
  getPublicERC20BalancesForChain,
} from "../railgun/balance/balance-util";
import { getCurrentNetwork } from "../railgun/engine/engine";
import { installRevertCapture } from "../railgun/network/revert-capture";
import { getWrappedTokenInfoForChain } from "../railgun/network/network-util";
import { initializeWalletSystems } from "../railgun/wallet/wallet-init";
import { overrideMainConfig, versionCheck } from "../config/config-overrides";
import { updateApiKey } from "../railgun/transaction/zeroX/0x-swap";
import { configuredDefaultNetwork } from "../config/config-manager";
import { installProcessHandlers } from "../platform/lifecycle";
import { installLogFile, logFilePath } from "../platform/log-file";
import { createLogger } from "../platform/logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../../package.json");

const log = createLogger("deck");

type Mode = "home" | "palette" | "build";

export const runDeck = async (): Promise<void> => {
  installProcessHandlers();
  // Before anything that can log. The pane sink installed later diverts lines
  // into the screen and returns; this one is what makes them outlive it.
  installLogFile();

  const screen = blessed.screen({
    smartCSR: true,
    title: "Terminal Wallet",
    fullUnicode: true,
  });

  // --- state the widgets need that is not in the store -----------------------
  let mode: Mode = "home";
  let wantLeft = true;
  let wantRight = true;
  // Mirrors the rail so a click maps back to the token it landed on.
  let rows: PortfolioRow[] = [];
  let history: CoreHistoryItem[] = [];
  let seededToken: RailgunDisplayBalance | undefined;
  let seededKind: TokenKind | undefined;

  // The deck has one genuine cycle: the cards close over the context, the
  // context needs a render, and render needs the cards to draw. Rather than
  // relying on nothing being called before everything exists, the render is a
  // declared indirection that is filled in once the widgets are up.
  let draw: () => void = () => undefined;
  const render = () => draw();
  // Same cycle one level down: `render` draws the builder, and the builder is
  // constructed with a context that renders.
  let drawBuilder: () => void = () => undefined;
  // And once more for the palette: a click on the deck behind it means "that
  // instead", which has to close it — but the click handlers are wired before
  // the palette exists.
  let leavePalette: () => void = () => undefined;

  const feeders = createFeeders(render);
  // Late-bound: the builder is created below and needs `ctx` itself, the same
  // shape as `drawBuilder`.
  let startFlow: (flowId: string) => void = () => undefined;
  const ctx: DeckContext = {
    screen,
    render,
    openFlow: (flowId) => startFlow(flowId),
    refreshIdentity: () => feeders.refreshIdentity(),
    refreshBalances: () => feeders.refreshBalances(),
    refreshChainStats: () => feeders.refreshChainStats(),
    refreshHistory: () => feeders.refreshHistory(),
  };

  // --- regions ---------------------------------------------------------------
  const titleBar = blessed.box({ parent: screen, top: 0, left: 0, width: "100%", height: 1, tags: true });
  const idBar = blessed.box({ parent: screen, top: 1, left: 0, width: "100%", height: 1, tags: true });

  const copyBox = (left: number, width: number) =>
    blessed.box({
      parent: screen, top: 1, left, height: 1, width, tags: true,
      mouse: true, clickable: true, style: { hover: { bg: "blue" } },
    });
  const pubCopy = copyBox(1, 20);
  const zkCopy = copyBox(22, 22);

  const copyAddress = (get: () => string, label: string) => () => {
    const address = get();
    if (!address || address === "—") return;
    copyToClipboard(address);
    getInputProvider().notify(`Copied ${label} address`);
  };
  pubCopy.on("click", copyAddress(() => getState().publicAddress, "0x"));
  zkCopy.on("click", copyAddress(() => getState().privateAddress, "0zk"));

  /**
   * What a click on the deck's own chrome should do, given what is over it.
   *
   * The deck's chrome stays visible behind the builder, and every bit of it is
   * clickable. Clicking a stat card or a balance opens a second screen ON TOP
   * of a half-built transaction and leaves the one underneath orphaned: the new
   * screen owns `mode`, so Esc closes that instead, and there is no longer a
   * way back to the builder at all. Say why rather than doing nothing, or it
   * reads as the click having been missed.
   */
  const deckClick = (fn: () => void) => () => {
    switch (deckClickVerdict(mode, openModalCount())) {
      case "refuse":
        setStatusMessage("Finish or close the transaction first (Esc).");
        render();
        return;
      case "closeThenAct":
        // The palette is a chooser; clicking something else IS the choice.
        leavePalette();
        fn();
        return;
      case "ignore":
        return;
      default:
        fn();
    }
  };

  interface CardDef {
    key: string;
    label: string;
    render: (s: WalletState) => string;
    click: () => void;
  }

  const cardDefs: CardDef[] = [
    {
      key: "wallet",
      label: " ◆ wallet ",
      render: (s) =>
        [tag(s.walletName, "white"), tag(short(s.publicAddress), "gray"), tag("click → wallet", "gray")].join("\n"),
      click: () => void openWalletMenu(ctx),
    },
    {
      key: "network",
      label: " ○ network ",
      render: (s) =>
        [
          tag(s.network, "cyan"),
          feeders.blockNumber()
            ? tag(`#${feeders.blockNumber().toLocaleString("en-US")}`, "gray")
            : tag("—", "gray"),
          tag("click → network", "gray"),
        ].join("\n"),
      click: () => void openNetworkMenu(ctx),
    },
    {
      key: "status",
      label: " ↻ sync ",
      render: (s) =>
        [
          syncTreeLine("utxo", s.utxoTree, s.utxoLeaves, s.utxoProgress, s.utxoReady, tag),
          syncTreeLine("txid", s.txidTree, s.txidLeaves, s.txidProgress, s.txidReady, tag),
          s.broadcasters === "available" ? tag("waku ●", "green") : tag("waku ○", "yellow"),
        ].join("\n"),
      click: () => void refreshNow(ctx),
    },
    {
      key: "gas",
      label: " ▲ gas ",
      render: () => {
        const estimate = feeders.gasEstimate();
        return [
          tag("slow / avg / fast", "gray"),
          estimate ? tag(gasTicker(estimate), "magenta") : tag("—", "gray"),
          tag("click → update", "gray"),
        ].join("\n");
      },
      click: () => void ctx.refreshChainStats(),
    },
    {
      key: "utilities",
      label: " ▸ utilities ",
      // The card is the only advertisement this menu gets, so it names what is
      // actually inside. Listing two of four is how the 7702 console came to
      // look like it did not exist.
      render: () =>
        [
          tag("fee mode · sender privacy", "gray"),
          tag("7702 ephemeral accounts", "gray"),
          tag("click → open (u)", "yellow"),
        ].join("\n"),
      click: () => void openUtilitiesMenu(ctx),
    },
  ];

  const utilCard = cardDefs[cardDefs.length - 1];
  const statusCardDefs = cardDefs.slice(0, -1);
  const cards = cardDefs.map((def) => {
    const box = blessed.box({
      parent: screen, top: CARD_TOP, height: CARD_H, tags: true, mouse: true, clickable: true,
      border: { type: "line" }, label: def.label, padding: { left: 1, right: 1 },
      style: { border: { fg: "gray" }, hover: { border: { fg: "cyan" } } },
    });
    box.on("click", deckClick(def.click));
    return { def, box, visible: true };
  });

  const leftRail = blessed.list({
    parent: screen, top: TOP, left: 0, width: LEFT_W, bottom: 1, tags: true,
    label: " portfolio ", border: { type: "line" }, keys: true, mouse: true, vi: true,
    scrollbar: { ch: " ", style: { bg: "green" } },
    style: { border: { fg: "gray" }, selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
  });
  const center = blessed.box({
    parent: screen, top: TOP, left: LEFT_W, right: RIGHT_W, bottom: 1, tags: true,
    border: { type: "line" }, label: " deck ", style: { border: { fg: "cyan" } },
    padding: { left: 1, right: 1 },
  });
  const homeBox = blessed.box({ parent: center, top: 0, left: 0, right: 0, bottom: 0, tags: true });
  const paletteBox = blessed.box({
    parent: center, top: 0, left: 0, right: 0, bottom: 0, tags: true, hidden: true, keys: true, mouse: true,
  });
  // The builder takes the top half of the centre for its rows and gives the rest
  // to the breakdown, which is the part the user is actually reading before they
  // approve a spend.
  const buildList = blessed.list({
    parent: center, top: 0, left: 0, right: 0, height: "45%", tags: true, hidden: true,
    keys: true, mouse: true, vi: true,
    scrollbar: { ch: " ", style: { bg: "green" } },
    style: { selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
  });
  const buildSummary = blessed.box({
    parent: center, top: "45%", left: 0, right: 0, bottom: 0, tags: true, hidden: true,
    scrollable: true, alwaysScroll: true, mouse: true,
    scrollbar: { ch: " ", style: { bg: "green" } },
  });
  const activity = blessed.list({
    parent: screen, top: TOP, right: 0, width: RIGHT_W, bottom: 1, tags: true,
    label: " activity · Enter to review ", border: { type: "line" },
    keys: true, mouse: true, vi: true,
    scrollbar: { ch: " ", style: { bg: "green" } },
    style: { border: { fg: "gray" }, selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
    padding: { left: 1, right: 1 },
  });
  const cmdBtn = blessed.box({
    parent: screen, bottom: 0, left: 0, height: 1, width: 14, tags: true, mouse: true, clickable: true,
    content: tag(" : commands ", "cyan"), style: { hover: { bg: "cyan", fg: "black" } },
  });
  const footer = blessed.box({ parent: screen, bottom: 0, left: 14, width: "100%-14", height: 1, tags: true });
  const tooSmall = blessed.box({
    parent: screen, top: "center", left: "center", width: "80%", height: 5, hidden: true, tags: true,
    border: { type: "line" }, label: " resize ", style: { border: { fg: "red" } }, content: "",
  });

  // --- layout ----------------------------------------------------------------
  const relayout = (resetRails: boolean) => {
    const width = (screen.width as number) || 80;
    const height = (screen.height as number) || 24;

    if (resetRails) {
      ({ left: wantLeft, right: wantRight } = defaultRails(width));
    }

    const l = computeLayout({ width, height, wantLeft, wantRight });

    if (l.tooSmall) {
      tooSmall.setContent(
        `\n  {red-fg}Terminal too small.{/}  Resize to continue.\n  (now ${width}×${height})`,
      );
      tooSmall.show();
      tooSmall.setFront();
      screen.render();
      return;
    }
    tooSmall.hide();

    const shown = [...statusCardDefs.slice(0, l.statusCards), utilCard];
    const cardWidth = Math.floor(width / shown.length);
    for (const card of cards) card.visible = false;
    shown.forEach((def, index) => {
      const card = cards.find((c) => c.def.key === def.key);
      if (!card) return;
      card.visible = true;
      card.box.show();
      card.box.top = CARD_TOP;
      card.box.height = CARD_H;
      card.box.left = index * cardWidth;
      card.box.width =
        index === shown.length - 1 ? width - index * cardWidth : cardWidth;
    });
    for (const card of cards) if (!card.visible) card.box.hide();

    center.left = l.centerLeft;
    center.right = l.centerRight;

    if (wantLeft) {
      leftRail.show();
      leftRail.width = LEFT_W;
      // An overlay sits over the centre rather than displacing it.
      if (l.leftOverlay) leftRail.setFront();
    } else {
      leftRail.hide();
    }
    if (wantRight) {
      activity.show();
      if (l.rightOverlay) activity.setFront();
    } else {
      activity.hide();
    }

    // Hiding a rail that held focus empties the focus history — rewindFocus
    // skips anything not visible — and the next element appended into a
    // scrollable box then throws from inside blessed. The centre pane is
    // always visible, so it is the one thing that can always hold it.
    ensureFocus(screen, center);

    screen.render();
  };

  // --- renders ---------------------------------------------------------------
  const trend = (symbol: string) => {
    const series = feeders.priceHistory()[symbol] ?? [];
    const delta = pctDelta(series);
    return series.length >= 2
      ? tag(delta > 0 ? "▲" : delta < 0 ? "▼" : "·", deltaColor(delta))
      : " ";
  };

  // Fixed column widths: an 18-decimal amount would otherwise bleed the rail.
  const publicRow = (b: WalletState["publicBalances"][number]) =>
    `${b.symbol.slice(0, 6).padEnd(6)}${fmtAmount(b.amount, 5).padStart(12)} ${(b.usd ?? "").padStart(8)} ${trend(b.symbol)}`;

  const privHeader = (g: TokenGroup, spendable: boolean) =>
    `${g.symbol.slice(0, 6).padEnd(6)}${fmtAmount(g.totalAmount, 5).padStart(12)} ` +
    `${(g.totalUsd !== undefined ? formatUSD(g.totalUsd) : "").padStart(8)} ${trend(g.symbol)}` +
    `${spendable ? ` ${tag("spendable", "green")}` : ""}`;

  // A position has a name and a count, not an amount and a price — the columns
  // the token rows use would all be empty.
  const nftRow = (n: WalletState["privateNFTs"][number]) => {
    const head = `  ${tag("◆", "magenta")} ${n.label.slice(0, 28).padEnd(28)}${
      n.amount === "1" ? "" : tag(` x${n.amount}`, "gray")
    }`;
    if (!n.detail) return head;
    // Warned positions are coloured, so one approaching its threshold is
    // visible without reading the number. The detail leads with the risk, so
    // a rail too narrow for the line loses the amounts rather than the reason.
    const warned = n.detail.includes("▲");
    return `${head}\n     ${tag(n.detail, warned ? "yellow" : "gray")}`;
  };

  const privBucket = (b: WalletState["privateBalances"][number]) => {
    const bucket = bucketTag(b.bucket);
    return `  ${tag("└", "gray")}${fmtAmount(b.amount, 5).padStart(12)}  ${
      bucket.short ? tag(bucket.short, bucket.color) : tag("untagged", "gray")
    }`;
  };

  draw = () => {
    const s = getState();

    titleBar.setContent(
      `${tag("◆ TERMINAL WALLET", "green")}${tag("  · RAILGUN privacy wallet", "gray")}`,
    );

    const present = (a: string) => a && a !== "—";
    pubCopy.setContent(
      present(s.publicAddress) ? tag(`${short(s.publicAddress)} ⧉`, "cyan") : tag("0x —", "gray"),
    );
    zkCopy.setContent(
      present(s.privateAddress) ? tag(`${short(s.privateAddress)} ⧉`, "magenta") : tag("0zk —", "gray"),
    );
    idBar.setContent(
      `${" ".repeat(45)}${tag(s.walletName, "white")}${tag(" · ", "gray")}${tag(s.network, "gray")}` +
        tag("   (click an address to copy)", "gray"),
    );

    for (const card of cards) if (card.visible) card.box.setContent(card.def.render(s));

    // Private first, grouped per token with its buckets beneath, then public —
    // one scrollable rail. Only rows carrying a token are clickable.
    rows = buildPortfolioRows(
      groupPrivateByToken(s.privateBalances),
      s.publicBalances,
      s.privateUSD,
      s.publicUSD,
      { tag, publicRow, privHeader, privBucket, nftRow },
      // A shield is pending for an hour. The bucket says only that funds are
      // waiting, which reads as indefinite; history has the timestamps.
      //
      // From `s`, not the `history` this render is about to update. Read from
      // the module variable it was one render stale — the countdown could only
      // appear on the render AFTER the shield reached history, and if nothing
      // else changed there was no such render, so it never appeared at all.
      (summary) =>
        pendingNote(summary, nextShieldMaturity(s.history, Math.floor(Date.now() / 1000))),
      s.privateNFTs,
    );
    const empty =
      !s.privateBalances.length && !s.publicBalances.length && !s.privateNFTs.length;
    leftRail.setLabel(empty ? " portfolio · waiting for scan… " : " portfolio ");
    leftRail.setItems(rows.map((r) => r.text));

    ({ history } = s);
    activity.setItems(formatHistoryRows(s.history, tag));

    // The deck stops taking input while a transaction is being built, so it
    // should stop LOOKING like it takes input. Refusing a click with a message
    // explains it once; the borders explain it every time you glance at them.
    const dim = mode === "build";
    for (const card of cards) {
      card.box.style.border.fg = dim ? "black" : "gray";
      // And the hover with it. A card that lights up under the pointer is
      // saying it can be clicked, which while the builder is up it cannot —
      // the dim border and the bright hover were telling opposite stories.
      card.box.style.hover.border.fg = dim ? "black" : "cyan";
    }
    leftRail.style.border.fg = dim ? "black" : "gray";
    activity.style.border.fg = dim ? "black" : "gray";
    // And they stop taking a selection at all. Refusing the ACTION while the
    // highlight still moved under the pointer was the worst of both: the deck
    // looked like it was responding and then did nothing. `List.select`
    // returns early when this is off, for the mouse and the keyboard alike.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (leftRail as any).interactive = !dim;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (activity as any).interactive = !dim;

    if (mode === "home") {
      homeBox.setContent(
        `${tag("PORTFOLIO", "white")}\n\n` +
          `  private   ${tag(s.privateUSD, "green")}\n` +
          `  public    ${tag(s.publicUSD, "green")}\n\n` +
          `${tag("Start a transaction:", "gray")}\n` +
          `  ${tag(":", "cyan")} command palette  (or click ${tag(": commands", "cyan")})\n` +
          `  ${tag("click", "cyan")} a balance to seed the builder\n` +
          `  ${tag("b", "cyan")}/${tag("v", "cyan")} peek rails`,
      );
    } else if (mode === "build") {
      // The breakdown reflects live balances, so a scan landing mid-compose
      // updates what the user is about to approve.
      drawBuilder();
    }

    // Work in flight outranks a message, and a message outlives nothing: see
    // format/footer.ts for why the order is what it is.
    const status = footerStatus(s, Date.now());
    footer.setContent(
      ` ${tag(status.text, status.active ? "yellow" : "gray")}   ` +
        tag(": cmds · u utils · t sync · l logs · Tab+Enter review · q quit", "gray"),
    );

    screen.render();
  };

  // --- palette and builder ---------------------------------------------------
  const backHome = () => {
    mode = "home";
    homeBox.show();
    center.setLabel(" deck ");
    leftRail.focus();
    render();
  };

  const builder = createBuilder({
    ctx,
    list: buildList,
    summary: buildSummary,
    center,
    onClose: backHome,
  });
  // Closes the render cycle: `render` draws the builder, and the builder is
  // built from `render`. Same shape as `draw` above.
  drawBuilder = builder.render;
  startFlow = (flowId) => {
    mode = "build";
    homeBox.hide();
    // A flow that ends without emitting tx:result leaves the bar pinned at its
    // last percentage, and footerStatus gives the bar precedence over the
    // status line — so every later message renders behind it.
    //
    // What makes that hard to recognise is that it does eventually clear: a
    // merkletree scan finishing both trees also resets it (adapter.ts,
    // "scan:complete"). So the symptom is not a bar that is stuck forever but
    // one that un-sticks at an unrelated moment, which reads as flaky rather
    // than as a missing terminator. Starting a new flow is a point where the
    // previous one is definitely over, so say so rather than waiting for a
    // scan to do it by coincidence.
    setState({ scanProgress: -1, scanLabel: "" });
    // A flow entered from a screen rather than the palette — recovery hands
    // off this way. Its loaders reach the network before `open` draws
    // anything, and until then the centre pane is blank: say what is happening
    // now, or the handover reads as the action having quietly failed.
    center.setLabel(" build ");
    setStatusMessage("Opening…");
    render();
    void builder.open(flowId);
  };

  const palette = createPalette({
    ctx,
    box: paletteBox,
    // The palette has already closed itself by the time this runs, so the
    // builder is free to take the centre pane.
    onSelect: (flowId, seed) => {
      mode = "build";
      homeBox.hide();
      void builder.open(flowId, seed);
    },
    seeded: () => ({ token: seededToken, kind: seededKind }),
    onClose: backHome,
  });

  leavePalette = () => palette.close();

  const openPalette = () => {
    mode = "palette";
    homeBox.hide();
    center.setLabel(" command palette ");
    palette.open();
  };

  // --- interactions ----------------------------------------------------------
  // Clicking a balance anchors the palette to that token's kind, so the actions
  // it offers are the ones that token can actually do.
  const resolveSeed = async (symbol: string) => {
    const net = getCurrentNetwork();
    const all = [
      ...(await getAllPrivateERC20BalancesForChain(net)),
      ...(await getPublicERC20BalancesForChain(net, true)),
    ];
    seededToken = all.find((b) => b.symbol === symbol);
  };

  leftRail.on("select", (_item: unknown, index: number) => {
    deckClick(() => {
      const row = rows[index];
      // A position is not a token and cannot seed a builder with an amount, so
      // clicking one opens what it IS. The rail only has room for the risk;
      // everything else about the position lives here.
      if (row?.nft) {
        const lines = row.nft.detailLines;
        if (lines?.length) void showText(ctx, "f(x) position", lines.join("\n"), "magenta");
        return;
      }
      if (!row?.token) return; // headers and spacers carry no token
      seededKind = row.kind;
      void resolveSeed(row.token.symbol).then(() => openPalette());
    })();
  });

  activity.on("select", (_item: unknown, index: number) => {
    deckClick(() => {
      const entry = history[index];
      if (entry) void showTxReview(ctx, entry);
    })();
  });

  cmdBtn.on("click", deckClick(() => openPalette()));

  // --- keys ------------------------------------------------------------------
  const quit = () => {
    feeders.stopPolling();
    // Released before the screen goes: anything logged during teardown belongs
    // on the terminal, and there is no pane left to hold it.
    releaseDeckLogSink();
    screen.destroy();
    process.exit(0);
  };

  // While a transaction is being built it owns the keyboard. blessed suppresses
  // these already once a field is READING, but not between fields — so moving
  // around the builder and pressing `q` quit the app, and `u` opened a menu
  // over a half-built transaction.
  const deckKey = (fn: () => void) => () => {
    if (mode === "build") return;
    fn();
  };
  screen.key(["C-c"], quit);
  screen.key(["q"], deckKey(quit));
  // `:` is the reliable command key — most terminals swallow Ctrl/Cmd-K before a
  // TUI ever sees it. C-k is kept as a best-effort second binding.
  screen.key([":", "C-k"], deckKey(() => openPalette()));
  screen.key(["u"], deckKey(() => void openUtilitiesMenu(ctx)));
  screen.key(["t"], deckKey(() => void openStatusMenu(ctx)));
  // NOT gated on the builder. Every other deck key opens a screen that would
  // orphan a half-built transaction, which is why `deckKey` refuses them — but
  // the log pane is read-only and closes back to where it was, and the moment
  // you most need it is while a send is failing in front of you. It was the one
  // place the failure detail existed and the one time it could not be opened.
  screen.key(["l"], () => void showLogs(ctx));
  screen.key(["b"], deckKey(() => {
    wantLeft = !wantLeft;
    relayout(false);
  }));
  screen.key(["v"], deckKey(() => {
    wantRight = !wantRight;
    relayout(false);
  }));
  // The footer advertises S while composing, so it is bound — but only in the
  // builder, where it means "review and send" rather than a stray letter.
  screen.key(shifted("S"), () => {
    if (mode === "build") builder.send();
  });
  screen.key(["escape"], () => {
    // A dialog owns Escape while it is up. modal.ts exempts Escape from the
    // key grab so a dialog can always be dismissed; that exemption is
    // screen-wide, so this handler hears it too — and the Escape that closed a
    // dialog opened from the builder was closing the builder behind it.
    if (!escapeReachesDeck(openModalCount())) return;
    if (mode === "build") {
      builder.close();
      return;
    }
    if (mode === "palette") {
      palette.close();
      return;
    }
    const width = (screen.width as number) || 80;
    wantLeft = tierFor(width) !== "narrow";
    wantRight = tierFor(width) === "wide";
    relayout(false);
  });
  screen.key(["tab"], () => {
    // Tab is a no-op cycle in the builder: it returns focus to the rows rather
    // than moving it out to a rail mid-compose.
    if (mode === "build") buildList.focus();
    else if (screen.focused === leftRail && !activity.hidden) activity.focus();
    else leftRail.focus();
    screen.render();
  });
  screen.on("resize", () => {
    relayout(true);
    palette.rebuild();
    render();
  });

  // --- boot ------------------------------------------------------------------
  setInputProvider(createBlessedInputProvider(blessed, screen));
  attachCoreAdapter();
  subscribe(render);

  // Before anything boots: the engine's provider health checks fire during
  // initializeWalletSystems, and unclaimed they land on top of the screen.
  installDeckLogSink();
  // And how to undo both, for a fatal error: without this the reason the
  // process died is written into a pane that dies with it, on a screen the
  // terminal is about to stop showing.
  setTerminalRestore(() => {
    releaseDeckLogSink();
    screen.destroy();
  });

  const seedNetwork = configuredDefaultNetwork();
  if (seedNetwork) {
    setState({
      network: seedNetwork,
      baseSymbol: getWrappedTokenInfoForChain(seedNetwork as NetworkName).symbol,
    });
  }
  setStatusMessage("Booting wallet…");
  relayout(true);
  leftRail.focus();
  render();

  try {
    await overrideMainConfig(version);

    // The operator's version floor. Below it this build is not allowed to run,
    // so tear the screen down and release the log sink first — otherwise the
    // reason goes into a pane that is about to stop existing, and the app just
    // disappears.
    const verdict = versionCheck(version);
    if (!verdict.ok) {
      releaseDeckLogSink();
      feeders.stopPolling();
      screen.destroy();
      log.error(verdict.message);
      process.exit(69);
    }
    if (verdict.newer) setStatusMessage(verdict.newer);

    // After the remote config lands and before anything can quote: that fetch
    // is what fills configDefaults.apiKeys, and this is what hands the 0x key
    // to the SDK. Without it every swap quote fails with "no API key
    // configured" while the key sits in config, fetched and unused.
    updateApiKey();
    await initializeWalletSystems();
  } catch (err) {
    setStatusMessage(`Boot failed: ${(err as Error).message}`);
    log.error("deck boot failed", err);
    return;
  }
  setStatusMessage("Wallet ready.");
  installRevertCapture(getCurrentNetwork());

  // Balances are re-read when a scan reports something new — not on a timer.
  // A poll would re-read a cache nothing had written to.
  //
  // Activity comes from the same place. It was loaded once at boot and then
  // only by hand, so a transaction you had just sent did not appear until you
  // went and asked for it — which is not what a live pane implies. A scan is
  // what discovers new history, so it is the event that should re-read it.
  onCoreEvent((event) => {
    if (event.type === "balances:refreshed" || event.type === "scan:complete") {
      void feeders.refreshBalances();
      void feeders.refreshHistory();
    }
  });

  feeders.refreshIdentity();
  setInterval(feeders.refreshIdentity, 5000);
  void feeders.refreshHistory();
  await feeders.refreshBalances();
  void refreshNow(ctx); // one scan on load so balances populate unprompted
  feeders.startPolling();
};
