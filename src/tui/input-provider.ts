/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Blessed-native implementation of the core WalletInputProvider — the modals the
 * wallet boot and every transaction flow use to ASK the user for input (token
 * pick, amount, address, gas, password, confirm). Designed to feel like one
 * cohesive app rather than ad-hoc prompts: a shared modal "chrome" (line border,
 * accent colour, drop shadow, title, and a dimmed footer of key hints) wraps each
 * dialog, the select list scrolls + shows a count + a right-aligned detail
 * column, and EVERY dialog cancels cleanly on Esc (resolve undefined/false) while
 * releasing grabKeys so the dashboard never gets stuck.
 *
 * A factory over (blessed, screen) so it shares the running screen. `notify`
 * routes to the store's status line.
 */
import { Mnemonic } from "ethers";
import { WalletInputProvider, InputChoice } from "../core/input";
import { TMPWalletInfo } from "../models/wallet-models";
import { emitCoreEvent } from "../core/events";
import { buildWalletInfo } from "../flows/new-wallet";
import { FormSpec } from "./form-core";
import { runFormCard } from "./widgets/form-card";
import { createModal, shifted } from "./widgets/modal";
import {
  RpcRow,
  leadBlock,
  rpcStatusLabel,
  rpcSummaryLine,
  shortenUrl,
} from "./format/rpc-status";
import { RpcEndpointEdit } from "../core/input";

export const createBlessedInputProvider = (
  blessed: any,
  screen: any,
): WalletInputProvider => {
  /** Status-line notice from inside a modal, where the provider object is not yet built. */
  const notifyStatus = (text: string) =>
    emitCoreEvent({ type: "status:message", text, durationMs: 10_000 });

  // Centered single-line text/password modal. Resolves the raw value or
  // undefined (Esc/empty). grabKeys keeps the global menu shortcuts from firing
  // while the modal is focused.
  const promptText = (
    message: string,
    censor: boolean,
    hint?: string,
    countWords = false,
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      let finish: (val?: string) => void = () => undefined;
      const { box, guardFocus, close } = createModal(blessed, screen, {
        title: message,
        widthPct: 60,
        // The counter needs its own line, and only the fields that ask for one
        // get it — a word count under the wallet password would be nonsense at
        // best and a hint at worst.
        height: (hint ? 8 : 7) + (countWords ? 1 : 0),
        accent: "cyan",
        footer: "Enter submit · Esc cancel",
        onDismiss: () => finish(undefined),
      });
      if (hint) {
        blessed.text({
          parent: box,
          top: 0,
          left: 1,
          right: 1,
          tags: true,
          content: `{gray-fg}${hint}{/}`,
        });
      }
      const input = blessed.textbox({
        parent: box,
        top: hint ? 2 : 1,
        left: 1,
        right: 1,
        height: 1,
        censor,
        // NOTE: do NOT set inputOnFocus. We arm reading once via readInput()
        // below; inputOnFocus would ALSO arm on focus, double-attaching keypress
        // listeners (blessed attaches on nextTick, removes synchronously) and
        // multiplying keystrokes when focus churns (guardFocus refocus / clicks).
        keys: true,
        mouse: true,
        style: { bg: "black", focus: { bg: "black" } },
      });
      // A censored field gives no feedback at all, and a seed usually arrives
      // from a clipboard in one burst — the failure to catch is a paste that
      // dropped its tail, which looks exactly like a whole one. Count the words
      // as they land, so the check happens before Enter rather than after the
      // balance comes back wrong.
      const counter = countWords
        ? blessed.text({
            parent: box,
            top: hint ? 3 : 2,
            left: 1,
            right: 1,
            tags: true,
            content: "{gray-fg}0 words{/}",
          })
        : undefined;
      if (counter) {
        const tick = () => {
          const n = input.getValue().trim().split(/\s+/).filter(Boolean).length;
          // 12 and 24 are the only counts a BIP39 phrase comes in; anything
          // else is a truncated paste or a stray token, so say so rather than
          // leaving the number to be interpreted.
          const ok = n === 12 || n === 24;
          counter.setContent(
            n === 0
              ? "{gray-fg}0 words{/}"
              : ok
                ? `{green-fg}${n} words{/}`
                : `{yellow-fg}${n} words — expected 12 or 24{/}`,
          );
          screen.render();
        };
        // blessed applies the keystroke to the value AFTER the listeners run,
        // so read it on the next tick or the counter trails by one character.
        input.on("keypress", () => setImmediate(tick));
      }

      let settled = false;
      finish = (val?: string) => {
        if (settled) return;
        settled = true;
        // blessed's own teardown: removes its keypress listener, hides the
        // cursor and releases grabKeys. "stop" performs all of that and returns
        // without emitting submit/cancel, which we have already decided.
        (input as unknown as { _done?: (err: string) => void })._done?.("stop");
        close();
        resolve(val);
      };
      input.on("submit", () => finish(input.getValue() || undefined));
      input.on("cancel", () => finish(undefined));
      input.key(["escape"], () => finish(undefined));
      guardFocus(input);
      input.focus();
      input.readInput(); // single arm — see the inputOnFocus note above

      // blessed cancels the read on ANY blur (textarea.js binds
      // `on('blur', __done)`, and __done is _done(null, null) → "cancel").
      // Its own click-to-focus emits a blur on the already-focused element, so
      // clicking into the field dismissed the prompt — and once cancelled the
      // keypress listener is gone, so nothing could be typed either.
      //
      // Losing focus is not an answer. Esc, Enter, [x] and an outside click are.
      input.removeListener(
        "blur",
        (input as unknown as { __done: () => void }).__done,
      );
      screen.render();
    });

  // Dedicated password/unlock modal. Hardened against accidental dismissal: a
  // blur / stray click / Esc does NOT close it — it re-grabs input and stays up.
  // The ONLY ways out are the explicit [Unlock] (submit) and [Cancel] buttons.
  const promptPasswordModal = (
    message: string,
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      let finish: (val?: string) => void = () => undefined;
      const { box, guardFocus, close } = createModal(blessed, screen, {
        title: message,
        widthPct: 60,
        height: 9,
        accent: "green",
        footer: "Enter / [Unlock] · [x] to cancel · outside clicks won't dismiss",
        // The [x] is an explicit cancel, same as the button. Outside clicks are
        // still ignored: this modal guards a spend confirmation.
        onDismiss: () => finish(undefined),
        hardened: true,
      });
      blessed.text({
        parent: box, top: 0, left: 1, right: 1, tags: true,
        content: "{gray-fg}· Enter your wallet password.{/}",
      });
      const input = blessed.textbox({
        parent: box, top: 2, left: 1, right: 1, height: 1,
        // No inputOnFocus: we arm reading explicitly via readInput(). Combining
        // both double-attaches keypress listeners and multiplies keystrokes.
        censor: true, keys: true, mouse: true,
        // Filled field so the input area is clearly visible.
        style: { bg: "#2b303b", fg: "white", focus: { bg: "#1f4f82", fg: "white" } },
      });
      const unlock = blessed.box({
        parent: box, bottom: 1, left: 1, width: 12, height: 1, tags: true, mouse: true, clickable: true, autoFocus: false,
        content: "{center}[ Unlock ]{/}", style: { bg: "green", fg: "black", hover: { bg: "white" } },
      });
      const cancel = blessed.box({
        parent: box, bottom: 1, left: 14, width: 12, height: 1, tags: true, mouse: true, clickable: true, autoFocus: false,
        content: "{center}[ Cancel ]{/}", style: { bg: "red", fg: "white", hover: { bg: "white", fg: "black" } },
      });
      let closing = false;
      finish = (val?: string) => {
        if (closing) return;
        closing = true;
        close();
        resolve(val);
      };
      input.on("submit", () => finish(input.getValue() || undefined));
      // blur / Esc / stray click → keep the modal up and resume input. Re-arm
      // exactly once (no inputOnFocus, so focus() alone won't re-attach a
      // listener — readInput() does, and its internal _reading guard prevents a
      // second concurrent listener).
      input.on("cancel", () => {
        if (closing) return;
        input.focus();
        input.readInput();
        screen.render();
      });
      unlock.on("click", () => finish(input.getValue() || undefined));
      cancel.on("click", () => finish(undefined));
      guardFocus(input);
      input.focus();
      input.readInput();
      screen.render();
    });

  const promptConfirm = (message: string): Promise<boolean> =>
    new Promise((resolve) => {
      let done: (v: boolean) => void = () => undefined;
      const { box, guardFocus, close } = createModal(blessed, screen, {
        title: "Confirm",
        widthPct: 55,
        height: 9,
        accent: "yellow",
        footer: "y / Enter = yes · n / Esc = no",
        onDismiss: () => done(false),
      });
      blessed.text({
        parent: box,
        top: 0,
        left: 1,
        right: 1,
        tags: true,
        content: message,
      });
      done = (v: boolean) => {
        close();
        resolve(v);
      };
      // Clickable Yes/No (mouse) alongside the y/n/Enter/Esc keys.
      const yes = blessed.box({
        parent: box,
        bottom: 2,
        left: 1,
        width: 11,
        height: 1,
        tags: true,
        mouse: true,
        clickable: true,
        autoFocus: false, // a button triggers; it must never hold the keys
        content: "{center}[ Yes ]{/}",
        style: { bg: "green", fg: "black", hover: { bg: "white" } },
      });
      const no = blessed.box({
        parent: box,
        bottom: 2,
        left: 14,
        width: 11,
        height: 1,
        tags: true,
        mouse: true,
        clickable: true,
        autoFocus: false, // a button triggers; it must never hold the keys
        content: "{center}[ No ]{/}",
        style: { bg: "red", fg: "white", hover: { bg: "white", fg: "black" } },
      });
      yes.on("click", () => done(true));
      no.on("click", () => done(false));
      box.key(["y", ...shifted("Y"), "enter"], () => done(true));
      box.key(["n", ...shifted("N"), "escape"], () => done(false));
      guardFocus(box);
      box.focus();
      screen.render();
    });

  const promptSelect = (
    message: string,
    items: InputChoice[],
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      // Right-align the optional detail column (e.g. balance) under a padded
      // label so the list reads like a table.
      let done: (v?: string) => void = () => undefined;
      const labelW = items.reduce((m, i) => Math.max(m, i.label.length), 0);
      const rows = items.map((i) =>
        i.hint ? `${i.label.padEnd(labelW + 2)}{gray-fg}${i.hint}{/}` : i.label,
      );
      // Cap height to the viewport and scroll the rest (long token lists).
      const screenH = (screen.height as number) || 24;
      const listH = Math.max(3, Math.min(items.length, screenH - 8));
      // Wide enough for a label plus a hint that says something. At 62% an
      // 80-column terminal gave the hint about 26 cells after the label
      // column, which silently truncated every position's risk line.
      const { box, guardFocus, close } = createModal(blessed, screen, {
        title: items.length > 1 ? `${message}  (${items.length})` : message,
        widthPct: 82,
        maxWidth: 110,
        height: listH + 4,
        accent: "cyan",
        footer: "↑/↓ move · Enter select · Esc cancel",
        onDismiss: () => done(undefined),
      });
      const list = blessed.list({
        parent: box,
        top: 0,
        left: 0,
        right: 0,
        height: listH,
        tags: true,
        keys: true,
        mouse: true,
        vi: true,
        items: rows,
        scrollbar: { ch: " ", style: { bg: "green" } },
        style: {
          selected: { bg: "cyan", fg: "black" },
          item: { fg: "white" },
        },
      });
      done = (v?: string) => {
        close();
        resolve(v);
      };
      list.on("select", (_item: any, idx: number) => done(items[idx]?.value));
      // blessed lists handle Esc internally and emit "cancel" — relying only on
      // .key(["escape"]) is flaky (it can be pre-empted by the list's own
      // keypress handler when nothing is highlighted). Bind both, plus the box.
      list.on("cancel", () => done(undefined));
      list.key(["escape", "q"], () => done(undefined));
      box.key(["escape", "q"], () => done(undefined));
      box.on("click", () => {
        list.focus();
        screen.render();
      });
      guardFocus(list);
      list.focus();
      screen.render();
    });

  /**
   * Live RPC endpoint editor: one screen, focused on open.
   *
   * Replaces a chain of selects (pick a URL, then pick Enable/Disable/Remove,
   * then back out and repeat) where the only status was the user's own
   * enabled flag. That flag is a preference; it never said whether the endpoint
   * answers, and a dead one looked exactly like a working one.
   *
   * Every enabled endpoint is probed for its head block as the modal opens, so
   * the list reports what is actually reachable and how far behind the leader
   * each one is. Toggling is Space, in place — no round trip.
   */
  const promptRpcEndpoints = (
    title: string,
    initial: RpcRow[],
    onProbe: (rows: RpcRow[], paint: () => void) => void,
  ): Promise<RpcEndpointEdit[] | undefined> =>
    new Promise((resolve) => {
      let done: (v?: RpcEndpointEdit[]) => void = () => undefined;
      const rows: RpcRow[] = initial.map((r) => ({ ...r }));
      const removed = new Set<string>();
      const startEnabled = new Map(rows.map((r) => [r.url, r.enabled]));

      const visible = () => rows.filter((r) => !removed.has(r.url));
      const urlW = Math.min(
        46,
        visible().reduce((m, r) => Math.max(m, shortenUrl(r.url).length), 0),
      );

      const rowFor = (r: RpcRow) => {
        const box = r.enabled ? "{green-fg}[x]{/}" : "[ ]";
        const status = rpcStatusLabel(r, leadBlock(visible()));
        // Disabled endpoints are not probed, so do not imply they were.
        const cell = !r.enabled
          ? "{gray-fg}disabled{/}"
          : !r.probe
            ? `{gray-fg}${status}{/}`
            : r.probe.ok
              ? `{green-fg}${status}{/}`
              : `{red-fg}${status}{/}`;
        const tail = r.isDefault ? "" : " {gray-fg}(custom){/}";
        return `${box} ${shortenUrl(r.url).padEnd(urlW + 2)}${cell}${tail}`;
      };

      const screenH = (screen.height as number) || 24;
      const listH = Math.max(3, Math.min(Math.max(rows.length, 1), screenH - 10));
      const { box, guardFocus, close } = createModal(blessed, screen, {
        title,
        widthPct: 78,
        height: listH + 6,
        accent: "cyan",
        footer:
          "↑/↓ · Space on/off · o only-custom · a add · r remove · p re-check · Enter save · Esc",
        onDismiss: () => done(undefined),
      });
      const list = blessed.list({
        parent: box, top: 0, left: 0, right: 0, height: listH,
        tags: true, keys: true, mouse: true, scrollable: true,
        style: { selected: { bg: "#1f4f82", fg: "white" }, item: { fg: "white" } },
      });
      const summary = blessed.text({
        parent: box, bottom: 1, left: 1, right: 1, tags: true, content: "",
      });

      const paint = () => {
        const items = visible();
        list.setItems(items.length ? items.map(rowFor) : ["{gray-fg}none configured{/}"]);
        summary.setContent(`{gray-fg}${rpcSummaryLine(items)}{/}`);
        screen.render();
      };

      const selected = (): RpcRow | undefined => visible()[list.selected as number];

      list.key(["space"], () => {
        const r = selected();
        if (!r) return;
        r.enabled = !r.enabled;
        // Newly enabled means newly worth asking; newly disabled means the old
        // answer is about to be misleading.
        r.probe = undefined;
        paint();
        if (r.enabled) onProbe([r], paint);
      });
      list.key(["o"], () => {
        // "Only custom", in one keystroke. Working around a bad shipped
        // endpoint otherwise means finding each default in the list and
        // toggling it, which is the fiddly part of an already fiddly job.
        // Reversible: if the defaults are already all off, this puts them back.
        const defaults = visible().filter((r) => r.isDefault);
        if (!defaults.length) {
          notifyStatus("No shipped endpoints on this chain.");
          return;
        }
        if (!visible().some((r) => !r.isDefault && r.enabled)) {
          notifyStatus("Add or enable a custom endpoint first — this would leave none.");
          return;
        }
        const turningOff = defaults.some((r) => r.enabled);
        for (const r of defaults) {
          r.enabled = !turningOff;
          r.probe = undefined;
        }
        paint();
        if (!turningOff) onProbe(defaults, paint);
      });
      list.key(["p"], () => {
        for (const r of visible()) if (r.enabled) r.probe = undefined;
        paint();
        onProbe(visible().filter((r) => r.enabled), paint);
      });
      list.key(["r"], () => {
        const r = selected();
        // Defaults come from the shipped config; removing one would be undone
        // on the next load, so it is disabled instead.
        if (!r || r.isDefault) {
          notifyStatus("Only custom endpoints can be removed — disable this one instead.");
          return;
        }
        removed.add(r.url);
        paint();
      });
      list.key(["a"], () => {
        void (async () => {
          const url = await promptText("Custom RPC URL", false, "https://… endpoint");
          if (url?.trim()) {
            const trimmed = url.trim();
            if (!visible().some((r) => r.url === trimmed)) {
              const added: RpcRow = { url: trimmed, enabled: true, isDefault: false };
              rows.push(added);
              paint();
              onProbe([added], paint);
            }
          }
          guardFocus(list);
          list.focus();
          paint();
        })();
      });
      done = (v?: RpcEndpointEdit[]) => { close(); resolve(v); };
      list.key(["escape"], () => done(undefined));
      list.key(["enter"], () => {
        const edits: RpcEndpointEdit[] = [];
        for (const url of removed) edits.push({ url, action: "remove" });
        for (const r of visible()) {
          if (startEnabled.get(r.url) !== r.enabled || !startEnabled.has(r.url)) {
            edits.push({ url: r.url, action: r.enabled ? "enable" : "disable" });
          }
        }
        done(edits);
      });
      box.on("click", () => { list.focus(); screen.render(); });

      paint();
      guardFocus(list);
      // Focused on open: the previous editor needed a click before any key did
      // anything.
      list.focus();
      screen.render();
      onProbe(visible().filter((r) => r.enabled), paint);
    });

  // Same list as promptSelect, with a checkbox column. Space toggles, Enter
  // confirms the set. Cancel and "confirmed nothing" are different answers, so
  // Esc resolves undefined while Enter on an empty set resolves [].
  const promptMultiSelect = (
    message: string,
    items: InputChoice[],
    initial: string[],
  ): Promise<string[] | undefined> =>
    new Promise((resolve) => {
      let done: (v?: string[]) => void = () => undefined;
      const chosen = new Set(initial);
      const labelW = items.reduce((m, i) => Math.max(m, i.label.length), 0);
      const rowFor = (i: InputChoice) =>
        `${chosen.has(i.value) ? "{green-fg}[x]{/}" : "[ ]"} ` +
        (i.hint ? `${i.label.padEnd(labelW + 2)}{gray-fg}${i.hint}{/}` : i.label);

      const screenH = (screen.height as number) || 24;
      const listH = Math.max(3, Math.min(items.length, screenH - 8));
      const { box, guardFocus, close } = createModal(blessed, screen, {
        title: `${message}  (${items.length})`,
        widthPct: 62,
        height: listH + 4,
        accent: "cyan",
        footer: "↑/↓ move · Space toggle · Enter confirm · Esc cancel",
        onDismiss: () => done(undefined),
      });
      const list = blessed.list({
        parent: box,
        top: 0,
        left: 0,
        right: 0,
        height: listH,
        tags: true,
        keys: true,
        mouse: true,
        vi: true,
        items: items.map(rowFor),
        scrollbar: { ch: " ", style: { bg: "green" } },
        style: { selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
      });
      done = (v?: string[]) => {
        close();
        resolve(v);
      };
      const toggle = () => {
        const index = (list as any).selected as number;
        const item = items[index];
        if (!item) return;
        if (chosen.has(item.value)) chosen.delete(item.value);
        else chosen.add(item.value);
        list.setItem(index, rowFor(item));
        screen.render();
      };
      list.key(["space"], toggle);
      // A blessed list emits "select" on Enter, which here means "I am done",
      // not "I picked this row" — the row is toggled with Space.
      list.on("select", () => done(items.filter((i) => chosen.has(i.value)).map((i) => i.value)));
      list.on("cancel", () => done(undefined));
      list.key(["escape", "q"], () => done(undefined));
      box.key(["escape", "q"], () => done(undefined));
      box.on("click", () => {
        list.focus();
        screen.render();
      });
      guardFocus(list);
      list.focus();
      screen.render();
    });

  // Single-card New / Import wallet flow: collect mode + name + (seed) on one
  // card, then assemble via the pure buildWalletInfo (new → generate, import →
  // validate). The seed field is collected only for import; the password-confirm
  // path stays downstream in initilizeFreshWallet.
  const promptNewWallet = async (): Promise<TMPWalletInfo | undefined> => {
    let built: TMPWalletInfo | undefined;
    const spec: FormSpec = {
      title: "New / Import Wallet",
      fields: [
        {
          key: "mode", label: "Mode", type: "select",
          staticOptions: [
            { label: "New wallet (generate a fresh seed)", value: "new" },
            { label: "Import an existing seed phrase", value: "import" },
          ],
        },
        { key: "name", label: "Wallet name", type: "text", required: true },
        {
          key: "mnemonic", label: "Seed phrase", type: "password", secret: true,
          countWords: true,
          // The row shows the word count once entered — the only way to tell a
          // whole paste from a truncated one behind a mask.
          hint: "12 / 24 words — import only. Check the word count on the row.",
        },
      ],
      submitLabel: "Create wallet",
      // Cross-field: import requires a valid seed (per-field validators are skipped
      // for a blank optional field, so enforce it here where it always runs).
      validate: (vals) => {
        const m = String(vals.mnemonic ?? "").trim();
        if (vals.mode === "import") {
          if (!m) return "Import needs a seed phrase.";
          if (!Mnemonic.isValidMnemonic(m)) return "Enter a valid 12 / 24-word seed phrase.";
        } else if (m) {
          // Mode defaults to "new" and the seed field sits on the same card, so
          // pasting a seed without switching Mode is one keystroke away — and
          // it would generate a fresh wallet over the top, silently, behind a
          // mask that shows nothing either way.
          return "Mode is New — switch to Import to use this seed, or clear it.";
        }
        return undefined;
      },
      submit: async (vals) => {
        const info = buildWalletInfo({
          mode: vals.mode === "import" ? "import" : "new",
          walletName: String(vals.name ?? ""),
          mnemonic: vals.mnemonic ? String(vals.mnemonic) : undefined,
        });
        if (!info) return { ok: false, error: "Invalid wallet details." };
        built = info;
        return { ok: true, message: vals.mode === "import" ? "Importing wallet…" : "Creating wallet…" };
      },
    };
    const res = await runFormCard(blessed, screen, spec, { mode: "new" });
    return res?.ok ? built : undefined;
  };

  return {
    promptPassword: (message) => promptPasswordModal(message),
    confirm: (message) => promptConfirm(message),
    // Emitted rather than written straight to the store. The bar decides when a
    // message is stale from `statusUntil`, so a direct write leaves whatever
    // expiry the previous message set — and once that passed, every later
    // notification was discarded as stale before it was ever drawn. Going
    // through the event also puts notices in the log, where they can be read
    // back and copied.
    notify: (message) =>
      emitCoreEvent({ type: "status:message", text: message, durationMs: 10_000 }),
    promptNewWallet,
    promptRpcEndpoints,
    select: (message, choices) => promptSelect(message, choices),
    multiSelect: (message, choices, opts) =>
      promptMultiSelect(message, choices, opts?.initial ?? []),
    input: (message, opts) =>
      promptText(message, opts?.password ?? false, opts?.hint, opts?.countWords),
  };
};
