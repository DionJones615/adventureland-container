#!/usr/bin/env bash
# Fetch (or refresh) the pinned local Adventure Land stack used to test the reference client.
#
# Adventure Land is three public repositories that are wired together with symlinks (see the
# upstream README): the game itself, a shared engine cloned as `common`, and a config template
# cloned as `secretsandconfig`. None of them are vendored into this corpus: everything lands in
# reference/local/, which is git-ignored.
set -euo pipefail

GAME_REPO="${AL_GAME_REPO:-https://github.com/kaansoral/adventureland_mongodb.git}"
GAME_SHA="${AL_GAME_SHA:-a5c133dcc31f97edab987119517b4a60581248f6}"
COMMON_REPO="${AL_COMMON_REPO:-https://github.com/kaansoral/common_engine.git}"
COMMON_SHA="${AL_COMMON_SHA:-fa74fabf5d3782503712621e037bfb934ecb8439}"
CONFIG_REPO="${AL_CONFIG_REPO:-https://github.com/kaansoral/adventureland_secretsandconfig.git}"
CONFIG_SHA="${AL_CONFIG_SHA:-6b3493be30abe367cfaf879a2d5ad370742e0866}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$ROOT/reference/local"
GAME="$DEST/adventureland"

# Boot-oriented sparse set: the corpus clone (reference/upstream) is documentation-oriented and
# deliberately omits design/, the language index and the seeder. Booting needs all three.
SPARSE_PATHS=(
  "/node/"
  "/design/"
  "/docs/"
  "/htmls/"
  "/css/"
  "/js/*.js"
  "/languages/*.js"
  "/languages/en/"
  "/scripts/seed_mongodb.js"
  "/*.js"
  "/*.json"
  "/LICENSE"
  "/README.md"
)
# node/precomputed_map_data.js is included on purpose: the committed BFS grid saves the ~40 s
# precompute on a fresh install. AL_FORCE_BFS=1 recomputes it from design/maps.js.

# The web client renders from images/ and sounds/ only. They are ~127 MB and ~54 MB, deliberately not
# part of the default clone; set AL_WITH_ART=1 to fetch them so the browser can actually draw the world.
if [ "${AL_WITH_ART:-0}" = "1" ]; then
  # Art, sound, and the vendored browser libraries the page loads (jquery, pixi ~24 MB, socket.io,
  # howler, interact, codemirror). Without them the page boots with "jQuery is not defined" and
  # renders nothing, so they belong to the same opt-in.
  SPARSE_PATHS+=("/images/" "/sounds/" "/js/*/" "/js/*/*")
  echo "[fetch_stack] including game art, sound and vendored browser libraries (AL_WITH_ART=1, ~210 MB)"
fi

clone_pinned() {
  local repo="$1" sha="$2" dest="$3"
  if [ -d "$dest/.git" ]; then
    echo "[fetch_stack] reusing $dest"
  else
    rm -rf "$dest"
    mkdir -p "$(dirname "$dest")"
    git clone --filter=blob:none --no-checkout --depth 1 "$repo" "$dest" >/dev/null
  fi
  git -C "$dest" fetch --depth 1 origin "$sha" >/dev/null 2>&1 || true
  git -C "$dest" checkout --detach "$sha" >/dev/null
  local actual
  actual="$(git -C "$dest" rev-parse HEAD)"
  if [ "$actual" != "$sha" ]; then
    echo "[fetch_stack] ERROR: $dest is $actual, expected $sha" >&2
    exit 1
  fi
}

echo "[fetch_stack] destination: $DEST"
mkdir -p "$DEST"

echo "[fetch_stack] game    $GAME_SHA"
clone_pinned "$GAME_REPO" "$GAME_SHA" "$GAME"
cd "$GAME"
# Two tracked files are written by the stack itself: node/precomputed_map_data.js when the BFS grid is
# recomputed, and version.js when the servers boot. Restore them first, or sparse-checkout warns about a
# dirty work tree (and a future checkout could conflict).
git checkout -- node/precomputed_map_data.js version.js 2>/dev/null || true
git sparse-checkout init --no-cone >/dev/null
git sparse-checkout set "${SPARSE_PATHS[@]}" 2>/dev/null
git checkout --detach "$GAME_SHA" >/dev/null
git checkout -- node/precomputed_map_data.js version.js 2>/dev/null || true

echo "[fetch_stack] engine  $COMMON_SHA"
clone_pinned "$COMMON_REPO" "$COMMON_SHA" "$DEST/common"

echo "[fetch_stack] config  $CONFIG_SHA"
clone_pinned "$CONFIG_REPO" "$CONFIG_SHA" "$DEST/secretsandconfig"
# options.js is rewritten by scripts/local/apply_config.mjs on every start, so a refresh has to put the
# committed template back before dropping the generated copy of it - otherwise the next run finds a
# generated options.js and no options_base.js to build from.
git -C "$DEST/secretsandconfig" checkout -- options.js 2>/dev/null || true
rm -f "$DEST/secretsandconfig/options_base.js"

# Symlinks exactly as the upstream README wires them.
ln -sfn "../common" "$GAME/common"
ln -sfn "../secretsandconfig" "$GAME/secretsandconfig"

cat > "$DEST/UPSTREAM-LOCAL.md" <<EOF
# Pinned local stack

| component | repository | commit |
|---|---|---|
| game | $GAME_REPO | $GAME_SHA |
| engine (common) | $COMMON_REPO | $COMMON_SHA |
| config (secretsandconfig) | $CONFIG_REPO | $CONFIG_SHA |

Fetched at $(date -u +%Y-%m-%dT%H:%M:%SZ) into reference/local/, which is git-ignored.

The game clone here is sparse but **boot-oriented**: it keeps design/, the language index,
scripts/seed_mongodb.js and js/*.js, which the documentation clone in reference/upstream/
omits. Neither repository is vendored into the corpus; the config template carries no real secrets.

Start it with 'npm run local:up'.
EOF

echo "[fetch_stack] OK: game=$(git -C "$GAME" rev-parse --short HEAD) engine=$(git -C "$DEST/common" rev-parse --short HEAD) config=$(git -C "$DEST/secretsandconfig" rev-parse --short HEAD)"
