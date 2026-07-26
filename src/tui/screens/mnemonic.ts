/**
 * The recovery-phrase screen.
 *
 * Its own modal rather than a generic one: it is the single most sensitive thing
 * the wallet ever draws, so it gets a red accent, a scrollable body sized to the
 * phrase, and no reuse of a component that might later grow a "copy on select"
 * convenience nobody thought about here.
 */
import blessed from "blessed";
import { DeckContext } from "../context";
import { createModal, modalWidth } from "../widgets/modal";
import { copyToClipboard } from "../widgets/clipboard";
import { layoutMnemonic } from "./mnemonic-layout";
import { tag } from "../format/tags";
import { getInputProvider } from "../../core/input";

export const showMnemonic = async (
  ctx: DeckContext,
  mnemonic: string,
  derivationIndex: number,
): Promise<void> => {
  const words = mnemonic.trim().split(/\s+/);
  const widthPct = 72;
  const innerWidth = modalWidth(ctx.screen, widthPct) - 4; // box minus border + padding
  const longest = words.reduce((max, w) => Math.max(max, w.length), 0);

  const lines = layoutMnemonic(words, innerWidth).map((row) =>
    row
      .map(
        (cell) =>
          `${tag(`${cell.n.toString().padStart(2)}.`, "gray")} ${cell.word.padEnd(longest)}`,
      )
      .join("  "),
  );

  const { box, guardFocus, close } = createModal(blessed, ctx.screen, {
    title: "◆ Recovery phrase — keep it secret",
    widthPct,
    height: lines.length + 6,
    accent: "red",
    footer: "c copy · Esc / Enter dismiss",
    onDismiss: () => close(),
  });

  blessed.box({
    parent: box,
    top: 0,
    left: 0,
    right: 0,
    bottom: 1,
    tags: true,
    content: `${tag(`derivation index ${derivationIndex}`, "gray")}\n\n${lines.join("\n")}`,
  });

  box.key(["c"], () => {
    copyToClipboard(mnemonic);
    getInputProvider().notify("Copied recovery phrase");
  });
  box.key(["escape", "enter", "q"], () => close());

  guardFocus(box);
  box.focus();
  ctx.screen.render();
};
