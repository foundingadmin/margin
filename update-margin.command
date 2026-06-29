#!/bin/bash
# Margin — one-click updater (macOS)
#
# Double-click this file in Finder to keep your local copy of Margin in sync
# with the `main` branch on GitHub:
#   • first run  → clones the repo into the target folder
#   • every run after → pulls the latest main
# Then open chrome://extensions and click the reload ↻ on the Margin card.
#
# Target folder defaults to "~/Custom Apps/margin". Override per-run with:
#   MARGIN_DIR="/some/other/path" ./update-margin.command
#
# The whole body lives in main() so bash parses the entire script before running
# it — that way the `git reset` below can rewrite this file on disk mid-run
# (when a newer version lands) without corrupting the in-progress execution.

main() {
  set -euo pipefail

  local REPO_URL="https://github.com/foundingadmin/margin.git"
  local DEFAULT_TARGET="$HOME/Custom Apps/margin"
  local TARGET="${MARGIN_DIR:-$DEFAULT_TARGET}"

  # If run from inside a checkout already, update that checkout in place
  # (works no matter where the folder lives).
  local SCRIPT_DIR REPO_ROOT
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    TARGET="$REPO_ROOT"
  fi

  if [ -d "$TARGET/.git" ]; then
    echo "↻ Updating Margin in: $TARGET"
    git -C "$TARGET" fetch origin main
    # Match main exactly. This folder is a load-only copy of the extension, so a hard
    # reset is the most reliable "always be on latest" — it never stalls on conflicts.
    git -C "$TARGET" reset --hard origin/main
  else
    echo "⬇️  Cloning Margin into: $TARGET"
    mkdir -p "$(dirname "$TARGET")"
    git clone "$REPO_URL" "$TARGET"
  fi

  echo
  echo "✅ Margin is up to date at: $TARGET"
  echo "👉 Open chrome://extensions and click the reload ↻ on the Margin card."

  # Best-effort: bring the extensions page up so the reload button is one click away.
  open -a "Google Chrome" "chrome://extensions/" 2>/dev/null || true
}

main "$@"
