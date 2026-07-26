/**
 * The address screen, and the refresh a wallet or chain switch needs.
 *
 * Both were closures inside the deck. They are the smallest useful thing to
 * extract against the context, and they exercise both halves of it: one only
 * mounts and renders, the other only causes.
 */
import blessed from "blessed";
import { DeckContext } from "../context";
import { createModal } from "../widgets/modal";
import { copyToClipboard } from "../widgets/clipboard";
import { tag } from "../format/tags";
import { getInputProvider } from "../../core/input";
import {
  getCurrentRailgunAddress,
  getCurrentWalletPublicAddress,
} from "../../railgun/wallet/wallet-util";

/** Both addresses, click or Enter to copy. */
export const showAddresses = async (ctx: DeckContext): Promise<void> => {
  // Reading either throws before a wallet is loaded, and the screen is reachable
  // from the identity bar at that point, so absence is shown rather than thrown.
  let pub = "—";
  let priv = "—";
  try {
    pub = getCurrentWalletPublicAddress();
  } catch {
    /* pre-boot */
  }
  try {
    priv = getCurrentRailgunAddress();
  } catch {
    /* pre-boot */
  }

  const rows = [
    { label: "Public (0x)", value: pub },
    { label: "Private (0zk)", value: priv },
  ];

  const { box, guardFocus, close } = createModal(blessed, ctx.screen, {
    title: "Addresses — click to copy",
    widthPct: 84,
    height: 7,
    accent: "cyan",
    footer: "Enter / click copy · Esc close",
    onDismiss: () => close(),
  });

  const list = blessed.list({
    parent: box,
    top: 0,
    left: 0,
    right: 0,
    bottom: 1,
    tags: true,
    keys: true,
    mouse: true,
    vi: true,
    style: { selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
  });

  list.setItems(rows.map((r) => `${tag(r.label.padEnd(14), "gray")}${r.value}`));
  list.on("select", (_item: unknown, index: number) => {
    const row = rows[index];
    if (row && row.value !== "—") {
      copyToClipboard(row.value);
      getInputProvider().notify(`Copied ${row.label} address`);
    }
  });
  list.key(["escape", "q"], () => close());

  guardFocus(list);
  list.focus();
  ctx.screen.render();
};

/**
 * Re-read everything that is scoped to a wallet or a chain.
 *
 * Anything that switches either has to call this: the store still holds the
 * previous wallet's balances and history, and nothing else will correct it —
 * balances arrive on scan events that will not fire for a chain nobody has
 * asked about yet.
 *
 * History is fired without awaiting: it is the slowest of the four and the least
 * urgent, and a failure to load it should not hold up the rest of the refresh.
 */
export const refreshAfterSwitch = async (ctx: DeckContext): Promise<void> => {
  ctx.refreshIdentity();
  await ctx.refreshBalances();
  await ctx.refreshChainStats();
  void ctx.refreshHistory();
  ctx.render();
};
