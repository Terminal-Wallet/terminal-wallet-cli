/**
 * blessed markup helpers.
 *
 * blessed styles inline with `{color-fg}…{/}` tags rather than escape codes, so
 * these are the terminal-UI equivalent of what `colors` used to do by patching
 * String.prototype — with the difference that they are ordinary functions,
 * scoped to the renderer, and cannot leak styling into the wallet core.
 */

/** Wrap text in a blessed foreground-colour tag. */
export const tag = (text: string, color: string): string =>
  `{${color}-fg}${text}{/}`;

/** Abbreviate a long address for a fixed-width row. */
export const short = (a: string): string =>
  a && a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
