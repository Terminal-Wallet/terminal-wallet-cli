/**
 * OSC 52 terminal clipboard escape. Writing this sequence to a TTY asks the
 * *local* terminal emulator to copy the payload — so it works over SSH with no
 * native dependency. Pure string builder (the actual stdout write + system
 * fallback live in ui-blessed/clipboard.ts).
 *
 * Format: ESC ] 52 ; c ; <base64(text)> BEL
 */

const ESC = "\x1b";
const BEL = "\x07";

/** base64 of the payload (exported for testing the encoding independently). */
export const osc52Payload = (text: string): string =>
  Buffer.from(text, "utf8").toString("base64");

/** Build the full OSC 52 copy escape for `text`. */
export const osc52 = (text: string): string =>
  `${ESC}]52;c;${osc52Payload(text)}${BEL}`;
