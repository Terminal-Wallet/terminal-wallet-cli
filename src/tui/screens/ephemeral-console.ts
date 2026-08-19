/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The 7702 ephemeral console.
 *
 * Relay-adapt sends (unshield-to-base, private swaps, base shields) execute
 * from a throwaway account whose index the wallet ratchets forward after each
 * success. That is invisible until a send half-fails and leaves assets at an
 * address the wallet has already moved past.
 *
 * Which is why this is a list rather than a menu. The console it replaces asked
 * you to type the index to recover from — knowledge you do not have, since the
 * wallet moved past it without saying so, and the one index you do know (the
 * current one) is the case guaranteed to hold nothing. Here the accounts are
 * on screen with what is at each of them, and every action hangs off the row
 * you have selected.
 *
 * Password-gated on entry: three actions mutate the persisted index and one
 * moves funds.
 */
import blessed from "blessed";
import { NetworkName, isDefined } from "@railgun-community/shared-models";
import { DeckContext } from "../context";
import { getInputProvider } from "../../core/input";
import { setState, setStatusMessage } from "../store";
import { tag } from "../format/tags";
import { createModal } from "../widgets/modal";
import { showText } from "./popout";
import {
  IndexRow,
  buildIndexRows,
  holdsAssets,
  rowLabel,
  scanVerdict,
} from "../format/ephemeral-rows";
import {
  balanceLines,
  parseIndex,
  rewindsIndex,
  rewindWarning,
  advanceWarning,
} from "../format/ephemeral";
import {
  advanceEphemeralIndex,
  getCurrentEphemeralInfo,
  getEphemeralHistory,
  setEphemeralIndex,
  syncEphemeralIndexFromHistory,
} from "../../railgun/wallet/ephemeral-util";
import {
  scanEphemeralAssets,
  EphemeralAssetScan,
} from "../../railgun/wallet/ephemeral-recovery";
import { getSaltedPassword } from "../../railgun/wallet/wallet-password";
import { getCurrentNetwork } from "../../railgun/engine/engine";

/**
 * Spelled out on screen rather than left to a footer.
 *
 * The panel was reported as missing sync/advance/set entirely. They were bound
 * — but the footer they were listed in ran past the modal's width cap and was
 * truncated, so half the actions were invisible. Two short lines inside the
 * panel cannot be cut off by a narrow terminal the way one long one can.
 */
const ACTIONS_ON_ROW = "Enter scan · b balances · r recover · m make current";
const ACTIONS_GLOBAL = "s sync from history · a advance · x set index · Esc close";

export const openEphemeralConsole = async (ctx: DeckContext): Promise<void> => {
  const encryptionKey = await getSaltedPassword();
  if (!isDefined(encryptionKey)) return;
  const chainName: NetworkName = getCurrentNetwork();
  const provider = getInputProvider();

  const scans = new Map<number, EphemeralAssetScan>();
  let rows: IndexRow[] = [];
  let currentIndex = -1;
  let busy = false;

  return new Promise<void>((resolveClosed) => {
    let done: () => void = () => undefined;
    const { box, guardFocus, close } = createModal(blessed, ctx.screen, {
      title: `7702 ephemeral accounts · ${chainName}`,
      widthPct: 88,
      maxWidth: 160, // a panel, not a dialog — see modalWidth
      height: Math.max(12, ((ctx.screen.height as number) || 24) - 4),
      accent: "magenta",
      footer: `${ACTIONS_ON_ROW}  ·  ${ACTIONS_GLOBAL}`,
      onDismiss: () => done(),
    });

    const header = blessed.box({
      parent: box,
      top: 0,
      left: 0,
      right: 0,
      height: 4,
      tags: true,
    });
    const list: any = blessed.list({
      parent: box,
      top: 4,
      left: 0,
      right: 0,
      bottom: 1,
      tags: true,
      keys: true,
      mouse: true,
      vi: true,
      items: [],
      style: { selected: { bg: "magenta", fg: "black" } },
      scrollbar: { ch: " ", style: { bg: "magenta" } },
    });

    const selected = (): IndexRow | undefined => rows[list.selected ?? 0];

    const draw = () => {
      header.setContent(
        [
          `${tag("current index", "gray")} ${tag(`${currentIndex}`, "cyan")}   ` +
            `${tag(scanVerdict(rows), "gray")}`,
          rows.length
            ? tag(
                "an account below the current index still holding funds is stranded — recover it",
                "gray",
              )
            : tag("no ephemeral history on this chain yet", "gray"),
          `${tag("on this row:", "gray")} ${tag(ACTIONS_ON_ROW, "cyan")}`,
          `${tag("anywhere:  ", "gray")} ${tag(ACTIONS_GLOBAL, "cyan")}`,
        ].join("\n"),
      );
      const keep = list.selected ?? 0;
      list.setItems(
        rows.map((row) => {
          const label = rowLabel(row);
          return holdsAssets(row) ? `{yellow-fg}${label}{/}` : label;
        }),
      );
      list.select(Math.min(keep, Math.max(0, rows.length - 1)));
      ctx.screen.render();
    };

    /** Re-read the index and history; keeps whatever has already been scanned. */
    const reload = async () => {
      const info = await getCurrentEphemeralInfo(chainName, encryptionKey);
      currentIndex = info.index;
      const history = await getEphemeralHistory(chainName, encryptionKey);
      rows = buildIndexRows(currentIndex, history.entries, scans);
      draw();
    };

    /**
     * Serialises the actions. Every one of them awaits the chain or a modal,
     * and a second keypress part-way through would interleave two of them on
     * the same shared row state.
     */
    const run = async (label: string, work: () => Promise<void>) => {
      if (busy) return;
      busy = true;
      try {
        await work();
      } catch (err) {
        provider.notify(`${label} failed: ${(err as Error).message}`);
      } finally {
        busy = false;
        ctx.screen.render();
      }
    };

    const scanRow = (row: IndexRow) =>
      run("Scan", async () => {
        setStatusMessage(`Scanning ephemeral [${row.index}]…`);
        scans.set(row.index, await scanEphemeralAssets(chainName, row.address));
        await reload();
        provider.notify(
          holdsAssets(rows.find((r) => r.index === row.index) as IndexRow)
            ? `[${row.index}] is holding funds — press r to recover`
            : `[${row.index}] is empty.`,
        );
      });

    const showBalances = (row: IndexRow) =>
      run("Balances", async () => {
        setStatusMessage(`Reading ephemeral [${row.index}]…`);
        const scan =
          scans.get(row.index) ??
          (await scanEphemeralAssets(chainName, row.address));
        scans.set(row.index, scan);
        await reload();
        await showText(
          ctx,
          `7702 ephemeral · [${row.index}]`,
          balanceLines(row.index, row.address, scan).join("\n"),
        );
      });

    /**
     * Hand recovery to the transaction builder rather than driving it here.
     *
     * It used to run its own sequence of modals over this list: an
     * informational summary that could only be dismissed, then a separate
     * yes/no that opened behind it, with this list still holding the escape
     * key and tearing the whole stack down when it was pressed. The builder
     * already owns that job — one review that IS the confirmation, a password
     * re-auth, and a send — so this closes and defers to it.
     */
    const recover = async (_row: IndexRow): Promise<void> => {
      done();
      ctx.openFlow("ephemeral-recovery");
    };

    const makeCurrent = (row: IndexRow) =>
      run("Set index", async () => {
        if (row.index === currentIndex) {
          provider.notify(`[${row.index}] is already the current index.`);
          return;
        }
        // Rewinding can point the wallet at an already-spent account, whose
        // nonce-0 7702 authorization the network will reject.
        if (
          rewindsIndex(currentIndex, row.index) &&
          !(await provider.confirm(rewindWarning(currentIndex)))
        ) {
          return;
        }
        await setEphemeralIndex(chainName, row.index);
        await reload();
        provider.notify(`Ephemeral index set to ${row.index}.`);
      });

    const setArbitrary = () =>
      run("Set index", async () => {
        // The rows only cover indexes history knows about. An index beyond them
        // is reachable no other way, and setting one is how you skip past a
        // wedged account.
        const raw = await provider.input("Set ephemeral index to", {
          hint: `current is ${currentIndex}`,
        });
        const parsed = parseIndex(raw);
        if (!parsed.ok) {
          if (parsed.message !== "Cancelled.") provider.notify(parsed.message);
          return;
        }
        if (
          rewindsIndex(currentIndex, parsed.index) &&
          !(await provider.confirm(rewindWarning(currentIndex)))
        ) {
          return;
        }
        await setEphemeralIndex(chainName, parsed.index);
        await reload();
        provider.notify(`Ephemeral index set to ${parsed.index}.`);
      });

    const sync = () =>
      run("Sync", async () => {
        const { before, after } = await syncEphemeralIndexFromHistory(
          chainName,
          encryptionKey,
        );
        await reload();
        provider.notify(
          before === after
            ? `Index already in sync at ${after}.`
            : `Index realigned ${before} → ${after}.`,
        );
      });

    const advance = () =>
      run("Advance", async () => {
        const current = rows.find((row) => row.isCurrent);
        if (
          !(await provider.confirm(
            advanceWarning(currentIndex, current?.address ?? ""),
          ))
        ) {
          return;
        }
        const { before, after } = await advanceEphemeralIndex(chainName);
        await reload();
        provider.notify(`Ephemeral index ${before} → ${after}.`);
      });

    const onRow = (act: (row: IndexRow) => Promise<void>) => () => {
      const row = selected();
      if (row) void act(row);
    };

    list.key(["enter"], onRow(scanRow));
    list.key(["b"], onRow(showBalances));
    list.key(["r"], onRow(recover));
    list.key(["m"], onRow(makeCurrent));
    list.key(["s"], () => void sync());
    list.key(["a"], () => void advance());
    list.key(["x"], () => void setArbitrary());

    done = () => {
      close();
      resolveClosed();
    };
    list.key(["escape", "q"], done);
    box.key(["escape", "q"], done);

    // Clicking the panel's chrome must not take the keys off the list.
    guardFocus(list);
    list.focus();
    void run("Load", reload);
  });
};
