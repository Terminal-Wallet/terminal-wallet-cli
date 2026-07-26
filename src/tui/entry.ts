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
import { createFeeders } from "./feeders";
import { getState, setState, subscribe, WalletState } from "./store";
import { footerStatus } from "./format/footer";
import { attachCoreAdapter } from "./adapter";
import { createBlessedInputProvider } from "./input-provider";
import { setInputProvider } from "../core/input";
import { onCoreEvent } from "../core/events";
import { installDeckLogSink, releaseDeckLogSink } from "./log-sink";
import { tag, short } from "./format/tags";
import {
  pctDelta,
  deltaColor,
  gasTicker,
  fmtAmount,
} from "./format/deck";
import { formatHistoryRows } from "./format/history";
import { syncTreeLine } from "./format/dashboard";
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
import { createPalette } from "./screens/palette";
import { createBuilder } from "./screens/builder";
import { showLogs, showTxReview } from "./screens/popout";
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
import { createLogger } from "../platform/logger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require("../../package.json");

const log = createLogger("deck");

type Mode = "home" | "palette" | "build";

export const runDeck = async (): Promise<void> => {
  installProcessHandlers();

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

  const feeders = createFeeders(render);
  const ctx: DeckContext = {
    screen,
    render,
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
      render: () =>
        [tag("sender privacy", "gray"), tag("wipe data", "gray"), tag("click → open (u)", "yellow")].join("\n"),
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
    box.on("click", def.click);
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
    parent: screen, top: TOP, right: 0, width: RIGHT_W, height: 8, tags: true,
    label: " activity · Enter to review ", border: { type: "line" },
    keys: true, mouse: true, vi: true,
    scrollbar: { ch: " ", style: { bg: "green" } },
    style: { border: { fg: "gray" }, selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
    padding: { left: 1, right: 1 },
  });
  const logsBox = blessed.box({
    parent: screen, top: TOP + 8, right: 0, width: RIGHT_W, bottom: 1, tags: true,
    label: " logs · click to expand ", border: { type: "line" },
    mouse: true, clickable: true,
    style: { border: { fg: "gray" }, hover: { border: { fg: "cyan" } } },
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
      logsBox.show();
      if (l.rightOverlay) {
        activity.setFront();
        logsBox.setFront();
      }
    } else {
      activity.hide();
      logsBox.hide();
    }

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

  const privBucket = (b: WalletState["privateBalances"][number]) => {
    const bucket = bucketTag(b.bucket);
    return `  ${tag("└", "gray")}${fmtAmount(b.amount, 5).padStart(12)}  ${
      bucket.short ? tag(bucket.short, bucket.color) : tag("untagged", "gray")
    }`;
  };

  draw = () => {
    const s = getState();

    titleBar.setContent(
      `${tag("◆ TWALLET", "green")}${tag("  · RAILGUN privacy wallet", "gray")}`,
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
      { tag, publicRow, privHeader, privBucket },
    );
    const empty = !s.privateBalances.length && !s.publicBalances.length;
    leftRail.setLabel(empty ? " portfolio · waiting for scan… " : " portfolio ");
    leftRail.setItems(rows.map((r) => r.text));

    ({ history } = s);
    activity.setItems(formatHistoryRows(s.history, tag));

    const tail = s.logs.slice(-12);
    logsBox.setContent(tail.length ? tail.join("\n") : tag("…", "gray"));

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
    const row = rows[index];
    if (!row?.token) return; // headers and spacers carry no token
    seededKind = row.kind;
    void resolveSeed(row.token.symbol).then(() => openPalette());
  });

  activity.on("select", (_item: unknown, index: number) => {
    const entry = history[index];
    if (entry) showTxReview(ctx, entry);
  });

  logsBox.on("click", () => showLogs(ctx));
  cmdBtn.on("click", () => openPalette());

  // --- keys ------------------------------------------------------------------
  const quit = () => {
    feeders.stopPolling();
    // Released before the screen goes: anything logged during teardown belongs
    // on the terminal, and there is no pane left to hold it.
    releaseDeckLogSink();
    screen.destroy();
    process.exit(0);
  };

  screen.key(["q", "C-c"], quit);
  // `:` is the reliable command key — most terminals swallow Ctrl/Cmd-K before a
  // TUI ever sees it. C-k is kept as a best-effort second binding.
  screen.key([":", "C-k"], () => openPalette());
  screen.key(["u"], () => void openUtilitiesMenu(ctx));
  screen.key(["t"], () => void openStatusMenu(ctx));
  screen.key(["l"], () => showLogs(ctx));
  screen.key(["b"], () => {
    wantLeft = !wantLeft;
    relayout(false);
  });
  screen.key(["v"], () => {
    wantRight = !wantRight;
    relayout(false);
  });
  // The footer advertises S while composing, so it is bound — but only in the
  // builder, where it means "review and send" rather than a stray letter.
  screen.key(["S"], () => {
    if (mode === "build") builder.send();
  });
  screen.key(["escape"], () => {
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

  const seedNetwork = configuredDefaultNetwork();
  if (seedNetwork) {
    setState({
      network: seedNetwork,
      baseSymbol: getWrappedTokenInfoForChain(seedNetwork as NetworkName).symbol,
    });
  }
  setState({ status: "Booting wallet…" });
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
    if (verdict.newer) setState({ status: verdict.newer });

    // After the remote config lands and before anything can quote: that fetch
    // is what fills configDefaults.apiKeys, and this is what hands the 0x key
    // to the SDK. Without it every swap quote fails with "no API key
    // configured" while the key sits in config, fetched and unused.
    updateApiKey();
    await initializeWalletSystems();
  } catch (err) {
    setState({ status: `Boot failed: ${(err as Error).message}` });
    log.error("deck boot failed", err);
    return;
  }
  setState({ status: "Wallet ready." });
  installRevertCapture(getCurrentNetwork());

  // Balances are re-read when a scan reports something new — not on a timer.
  // A poll would re-read a cache nothing had written to.
  onCoreEvent((event) => {
    if (event.type === "balances:refreshed" || event.type === "scan:complete") {
      void feeders.refreshBalances();
    }
  });

  feeders.refreshIdentity();
  setInterval(feeders.refreshIdentity, 5000);
  void feeders.refreshHistory();
  await feeders.refreshBalances();
  void refreshNow(ctx); // one scan on load so balances populate unprompted
  feeders.startPolling();
};
