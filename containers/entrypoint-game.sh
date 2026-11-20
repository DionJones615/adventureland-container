#!/usr/bin/env bash
# First start clones the pinned repositories into the volume and installs their dependencies; every
# start then boots the stack.
set -euo pipefail

LOCAL=/app/reference/local
mkdir -p "$LOCAL/.state" "$LOCAL/.logs" "$LOCAL/.run" "$LOCAL/.cache"

if [ ! -d "$LOCAL/adventureland/node" ] || [ ! -d "$LOCAL/common" ]; then
  echo "[al-game] fetching the pinned game repositories (first start, needs network)"
  AL_WITH_ART="${AL_WITH_ART:-0}" bash /app/scripts/local/fetch_stack.sh
fi

# The game repositories do not vendor node_modules and the clone lives on a mount, so dependencies
# are installed once per clone. Two places matter: the repository root, and node/ - the game
# server's own dependencies (socket.io, mongodb, ...) are declared in node/package.json with its own
# lockfile. Installing only the root leaves server.js unable to require socket.io, and it exits.
install_deps() {
  dir="$1"
  [ -d "$dir" ] || return 0
  if [ -d "$dir/node_modules" ]; then
    return 0
  fi
  echo "[al-game] installing dependencies in $dir (first start, needs network)"
  if [ -f "$dir/package-lock.json" ]; then
    ( cd "$dir" && npm ci --omit=dev --no-audit --no-fund )
  else
    ( cd "$dir" && npm install --omit=dev --no-audit --no-fund )
  fi
}

install_deps "$LOCAL/adventureland"
install_deps "$LOCAL/adventureland/node"

# The default account is created once the backend answers (DEFAULT_EMAIL/DEFAULT_PASSWORD). The
# seeder waits for the API itself, so it can start before the stack is ready; it is not the main
# process, so the stack still owns the container lifetime.
if [ -n "${DEFAULT_EMAIL:-}" ] && [ -n "${DEFAULT_PASSWORD:-}" ]; then
  echo "[al-game] seeding the default account ${DEFAULT_EMAIL}"
  node /app/scripts/local/seed_account.mjs &
fi

# Fixtures: characters with a known inventory, equipment, skills and location. Runs after the
# default account, and leaves .state/fixtures.ready when it is done.
if [ -n "${SEED_FIXTURES:-}" ] || [ -n "${SEED_FIXTURES_JSON:-}" ]; then
  echo "[al-game] seeding fixtures ${SEED_FIXTURES:-<inline>}"
  ( node /app/scripts/local/seed_account.mjs; node /app/scripts/local/seed_fixtures.mjs ) &
fi

echo "[al-game] starting MongoDB + backend + game server"
exec node /app/scripts/local/supervisor.mjs
