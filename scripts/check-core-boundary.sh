#!/usr/bin/env bash
#
# Dependency-direction guard.
#
# The rule: code outside the renderer must not import the renderer, a renderer
# toolkit, or a terminal-styling library. Core emits events and asks through the
# input seam; it never imports the things that draw.
#
# Everything outside the renderer is in scope. Narrow it for a one-off check
# with e.g. SCOPE=src/flows.

#
# NOTE on `colors`: this library works by augmenting String.prototype, and the
# TypeScript augmentation is program-global once ANY file imports it. So a guard
# that greps for `import "colors"` is worthless — a file can use `.grey`/`.yellow`
# with no import of its own and pass. We match the string-property USE instead.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Default scope is now EVERYTHING except the renderer. It started at src/core
# while the boundary was being established; the tree satisfies the strict rule
# now, so this enforces it rather than documenting an intention.
SCOPE="${SCOPE:-src}"

if [ ! -e "$SCOPE" ]; then
  echo "core-boundary: SKIP — $SCOPE does not exist yet (nothing to check)"
  exit 0
fi

# Directories never subject to the guard: the renderer itself, and (later) the
# network layer, which is allowed the raw transports everything else is denied.
EXCLUDES=(--exclude-dir=ui --exclude-dir=tui --exclude-dir=net)

fail=0

# --- 1. renderer / toolkit / prompt-library imports ---------------------------
IMPORT_PATTERN='from[[:space:]]+["'\'']((\.\.?/)+(tui|ui|ui-blessed|ui-ink)/|blessed|ink|react|enquirer)|require\(["'\''](blessed|enquirer|ink|react)'

if hits="$(grep -REn "${EXCLUDES[@]}" --include='*.ts' --include='*.tsx' "$IMPORT_PATTERN" "$SCOPE" 2>/dev/null)"; then
  echo "core-boundary: FAIL — $SCOPE must not import a renderer or prompt library:" >&2
  echo "$hits" | sed 's/^/    /' >&2
  fail=1
fi

# --- 2. `colors` String.prototype styling ------------------------------------
# Matches `.grey`, `.yellow.bold`, `"text".red` etc. Deliberately anchored to a
# property access so ordinary identifiers containing a colour name don't trip it.
COLORS_PATTERN='\.(black|red|green|yellow|blue|magenta|cyan|white|gray|grey|bold|dim|italic|underline|inverse|strikethrough|rainbow|zebra|america|trap|random|bg[A-Z][a-z]+)\b'

if hits="$(grep -REn "${EXCLUDES[@]}" --include='*.ts' --include='*.tsx' "$COLORS_PATTERN" "$SCOPE" 2>/dev/null)"; then
  echo "core-boundary: FAIL — $SCOPE must not style output with \`colors\` (String.prototype):" >&2
  echo "$hits" | sed 's/^/    /' >&2
  echo "    Emit an event or return data; let the renderer decide how it looks." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "core-boundary: OK — $SCOPE imports no renderer and styles no output"
