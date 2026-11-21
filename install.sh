#!/usr/bin/env bash
# Installs SolidCraft Remote for this user (no sudo), then runs its setup.
#   curl -fsSL https://raw.githubusercontent.com/TTTray/solidcraft-remote/main/install.sh | bash
set -euo pipefail

SOURCE="${SOLIDCRAFT_REMOTE_SOURCE:-github:TTTray/solidcraft-remote}"
PREFIX="${PREFIX:-$HOME/.local}"

die() { echo "error: $*" >&2; exit 1; }

command -v node >/dev/null || die "Node.js 22 or newer is needed (Arch: sudo pacman -S nodejs npm)"
command -v npm >/dev/null || die "npm is needed (Arch: sudo pacman -S npm)"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || die "Node.js 22 or newer is needed (you have $(node --version))"
command -v solidcraft-cli >/dev/null || die "SolidCraft isn't installed (it provides solidcraft-cli)"

if ! command -v claude >/dev/null && [ ! -x "$PREFIX/bin/claude" ]; then
  echo "Installing Claude Code into $PREFIX…"
  npm install -g --prefix "$PREFIX" --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code
fi

echo "Installing SolidCraft Remote into $PREFIX…"
npm install -g --prefix "$PREFIX" --allow-git=root "$SOURCE"

CLAUDE="$(command -v claude || echo "$PREFIX/bin/claude")"
if ! "$CLAUDE" auth status 2>/dev/null | grep -q '"loggedIn": *true'; then
  echo
  echo "Sign in to Claude Code with your Claude subscription:"
  "$CLAUDE" auth login </dev/tty
fi

"$PREFIX/bin/solidcraft-remote" setup "$@"

case ":$PATH:" in
  *":$PREFIX/bin:"*) ;;
  *) echo; echo "Tip: $PREFIX/bin isn't on your PATH. Add it to run 'solidcraft-remote' directly (fish: fish_add_path $PREFIX/bin)." ;;
esac
