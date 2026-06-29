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

  # If run from inside the Margin checkout, update that checkout in place. Guard hard:
  # adopt the discovered repo ONLY when its origin is foundingadmin/margin. Without this,
  # `rev-parse --show-toplevel` can walk UP into an unrelated parent repo (e.g. a home
  # folder that is itself a git checkout) and we'd hard-reset the wrong repository.
  local SCRIPT_DIR REPO_ROOT
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" \
     && git -C "$REPO_ROOT" remote get-url origin 2>/dev/null | grep -qiE 'foundingadmin/margin(\.git)?/?$'; then
    TARGET="$REPO_ROOT"
  fi

  if [ -d "$TARGET/.git" ]; then
    echo "↻ Updating Margin in: $TARGET"
    git -C "$TARGET" fetch origin main
    # Match main exactly. This folder is a load-only copy of the extension, so a hard
    # reset is the most reliable "always be on latest" — it never stalls on conflicts.
    git -C "$TARGET" reset --hard origin/main
  elif [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    # The folder exists but isn't a git checkout (e.g. an unzipped download). Convert it
    # in place into a real clone of main — a one-time fix, after which runs just pull.
    echo "🔧 Converting existing folder into a Margin checkout: $TARGET"
    git -C "$TARGET" init -q
    if git -C "$TARGET" remote get-url origin >/dev/null 2>&1; then
      git -C "$TARGET" remote set-url origin "$REPO_URL"
    else
      git -C "$TARGET" remote add origin "$REPO_URL"
    fi
    git -C "$TARGET" fetch origin main
    git -C "$TARGET" reset --hard origin/main
    git -C "$TARGET" branch -M main 2>/dev/null || true
  else
    echo "⬇️  Cloning Margin into: $TARGET"
    mkdir -p "$(dirname "$TARGET")"
    git clone "$REPO_URL" "$TARGET"
  fi

  echo
  echo "✅ Margin is up to date at: $TARGET"
  echo "👉 Open chrome://extensions and click the reload ↻ on the Margin card."

  # Best-effort: bring the extensions page up in Comet so the reload button is one click
  # away. Fall back to just launching Comet, then to Chrome, if a step isn't available.
  open -a "Comet" "chrome://extensions/" 2>/dev/null \
    || open -a "Comet" 2>/dev/null \
    || open -a "Google Chrome" "chrome://extensions/" 2>/dev/null \
    || true
}

main "$@"
