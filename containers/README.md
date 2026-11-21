# The game container

One image, one process tree: MongoDB (single-node replica set) → backend (:8090) → game server (:7192).
[`game.Dockerfile`](game.Dockerfile) builds it, [`entrypoint-game.sh`](entrypoint-game.sh) runs it.

```sh
docker build -f containers/game.Dockerfile -t localhost/al-game .
docker run -d --name al-game -p 8090:8090 -p 7192:7192 localhost/al-game
```

The game itself, and the three pinned repositories this container runs, are credited in the
[root README](../README.md#credits).

## What the entrypoint does

1. If `/app/reference/local` has no clone, runs `scripts/local/fetch_stack.sh` (the three pinned game
   repositories; `AL_WITH_ART=1` also fetches art/sounds/vendored browser libraries).
2. Installs the clone's dependencies when missing: `npm ci --omit=dev` in `adventureland/` **and** in
   `adventureland/node/`. The second one matters - the game server's own dependencies (`socket.io`, `mongodb`, ...)
   are declared in `node/package.json` with its own lockfile, and installing only the repository root leaves
   `server.js` unable to `require("socket.io")`, so it exits immediately.
3. Starts `scripts/local/seed_account.mjs` in the background when `DEFAULT_EMAIL`/`DEFAULT_PASSWORD` are set.
4. Starts `scripts/local/seed_fixtures.mjs` in the background when `SEED_FIXTURES` (or `SEED_FIXTURES_JSON`) is set,
   after the account seeder.
5. `exec`s `scripts/local/supervisor.mjs`, which is the container's main process and owns its lifetime.

Both seeders wait for the backend themselves, so they can start before the stack is up; neither is the main process,
so a slow seed can never keep the container "running but not serving".

## Mounts

| path | why |
| --- | --- |
| `/app/reference/local` | the pinned clone + generated config + database + logs. Mount it to persist and reuse; a fresh mount triggers the clone |
| `/app/fixtures` | read-only fixture directory; `SEED_FIXTURES=/app/fixtures/<file>.json` |

On an SELinux host add `:z` to the bind mounts (Docker accepts the option too and ignores it where SELinux is off) (`-v "$PWD/clone:/app/reference/local:z"`), otherwise the first write
into the clone fails with `EACCES`.

## Environment

| variable | meaning |
| --- | --- |
| `DEFAULT_EMAIL`, `DEFAULT_PASSWORD` | account created at startup |
| `DEFAULT_CHARACTER`, `DEFAULT_CHARACTER_TYPE` | optional character for that account |
| `SEED_FIXTURES`, `SEED_FIXTURES_JSON` | fixture file path, or inline JSON |
| `AL_WITH_ART` | `1` fetches art/sounds/vendored browser libraries on first start (~210 MB) |
| `AL_API_PORT`, `AL_GAME_PORT`, `AL_MONGODB_PORT` | ports *inside* the container (publish with `-p` as usual) |

## Watching a character

The client page is served by the backend: `http://127.0.0.1:8090/?watch=<character>`. The `?watch=` deep link comes
from `scripts/local/patch_client.mjs`, which appends a small shim to the served `js/game.js` at every start.

### Watching a party that plays elsewhere (relay mode)

The page can also render characters that are **not** connected to this container: `/?watch=<name>&relay=1`
reads a Server-Sent-Events stream from a local relay instead of the game server's own stream. The relay and
the party side live in [adventureland-client](https://github.com/DionJones615/adventureland-client)
(`npm run live:relay`, `examples/live-party/`); the shim merges what each running client sees into one view.

- no local login is needed: relay mode creates the client's socket object only so `init_socket()` registers
  its packet handlers, then delivers the relay's frames through `socket.emitEvent()`;
- everything visual is the client's own code (map, sprites, camera follow, panels);
- a **PARTY** panel lists every publisher with hp/mp, distance, gold and the run's counters;
- **partywatch** (a chip in that panel's header) centres the camera on the party's bounding box and
  zooms out until everyone fits, with a name marker over each member; clicking a character row follows
  that character instead, at the normal zoom;
- `relay=<url>` points at another relay; without it the observer path above is used unchanged.
