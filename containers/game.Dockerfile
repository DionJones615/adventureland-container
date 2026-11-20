# The Adventure Land game stack as one image: MongoDB + backend (:8090) + game server (:7192).
#
#   podman build -f containers/game.Dockerfile -t localhost/al-game .
#   podman run -d --name al-game -p 8090:8090 -p 7192:7192 localhost/al-game
#
# The three game repositories ship no licence, so they are NOT in this image: the entrypoint clones
# them into the mounted /app/reference/local on first start (scripts/local/fetch_stack.sh). The game
# data (data.js + sections) is fetched at build time, so the image is self-contained - mount
# /app/reference/local to reuse an existing clone and skip both.

FROM docker.io/library/node:22-bookworm-slim

LABEL org.opencontainers.image.title="adventureland-game" \
      org.opencontainers.image.description="Adventure Land local game stack (MongoDB, backend, game server) with seeded accounts and character fixtures" \
      org.opencontainers.image.source="https://github.com/DionJones615/adventureland-container" \
      org.opencontainers.image.licenses="MIT"

# git for the clone, procps for the stack's readiness checks, curl for health probing from outside.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl procps \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY containers ./containers
COPY scripts ./scripts

# Game data at build time: raw/data.js (served by the backend) and sections/*.json (fixture
# validation). Both are git-ignored in the repository, so they have to be produced here.
RUN npm run fetch-data

ENV AL_API_PORT=8090 \
    AL_GAME_PORT=7192 \
    AL_MONGODB_PORT=27017 \
    AL_WITH_ART=0

# Optional, both applied at start:
#   DEFAULT_EMAIL / DEFAULT_PASSWORD / DEFAULT_CHARACTER / DEFAULT_CHARACTER_TYPE
#   SEED_FIXTURES=/app/fixtures/<file>.json  (mount the directory at /app/fixtures)
ENV DEFAULT_EMAIL="" \
    DEFAULT_PASSWORD=""

EXPOSE 8090 7192

ENTRYPOINT ["/bin/bash", "/app/containers/entrypoint-game.sh"]
