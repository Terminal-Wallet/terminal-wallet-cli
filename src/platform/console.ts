/**
 * Raw terminal control — screen clearing, window title, resize, and the logo.
 *
 * This is the only presentation left outside the renderer, and it lives here
 * because the lifecycle path needs it before (and after) any UI exists: the
 * shutdown handler clears the screen whether or not anything was ever drawn.
 * It moves under the renderer once one exists.
 */

export const RAILGUN_HEADER = `
 ███████████ ██████████ ███████████   ██████   ██████ █████ ██████   █████   █████████   █████
░█░░░███░░░█░░███░░░░░█░░███░░░░░███ ░░██████ ██████ ░░███ ░░██████ ░░███   ███░░░░░███ ░░███
░   ░███  ░  ░███  █ ░  ░███    ░███  ░███░█████░███  ░███  ░███░███ ░███  ░███    ░███  ░███
    ░███     ░██████    ░██████████   ░███░░███ ░███  ░███  ░███░░███░███  ░███████████  ░███
    ░███     ░███░░█    ░███░░░░░███  ░███ ░░░  ░███  ░███  ░███ ░░██████  ░███░░░░░███  ░███
    ░███     ░███ ░   █ ░███    ░███  ░███      ░███  ░███  ░███  ░░█████  ░███    ░███  ░███      █
    █████    ██████████ █████   █████ █████     █████ █████ █████  ░░█████ █████   █████ ███████████
   ░░░░░    ░░░░░░░░░░ ░░░░░   ░░░░░ ░░░░░     ░░░░░ ░░░░░ ░░░░░    ░░░░░ ░░░░░   ░░░░░ ░░░░░░░░░░░
`;

// ESC. The previous escape here was \u{033} — that is hex 0x33, the digit "3",
// not ESC (0x1b) — so every screen clear printed a stray "3" before the first
// control sequence took effect.
const ESC = "";

/** Clear the screen, home the cursor, and drop the scrollback. */
export const clearConsoleBuffer = (): void => {
  process.stdout.write(`${ESC}[2J${ESC}[H${ESC}[2J${ESC}[3J`);
};

export const setConsoleTitle = (
  titleMessage = "🛡️ TERMINAL WALLET - CLI for 0x and 0zk addresses",
): void => {
  if (process.platform === "win32") {
    process.title = titleMessage;
  } else {
    process.stdout.write(`${ESC}]2;${titleMessage}${ESC}\\`);
  }
};

export const printLogo = (): void => {
  process.stdout.write(`${RAILGUN_HEADER}\n`);
};

export const resizeWindow = (width: number, height: number): void => {
  process.stdout.write(`${ESC}[8;${height};${width}t`);
};
