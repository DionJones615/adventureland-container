# adventureland-container

The [Adventure Land](https://adventure.land) game stack in **one container**: MongoDB (single-node replica set),
the account backend, and the game server. Nothing else — no bot, no protocol client. Point any client at it, or use
it as the fixture-backed server for end-to-end tests.

```sh
docker build -f containers/game.Dockerfile -t localhost/al-game .
docker run -d --name al-game -p 8090:8090 -p 7192:7192 \
  -e DEFAULT_EMAIL=dev@example.test -e DEFAULT_PASSWORD=dev-password-123 \
  -v "$PWD/containers/fixtures:/app/fixtures:ro,z" \
  -e SEED_FIXTURES=/app/fixtures/e2e.json \
  localhost/al-game
```

| what | where |
| --- | --- |
| client page (landing, login, `?watch=<character>`) | <http://127.0.0.1:8090/> |
| account API | `POST http://127.0.0.1:8090/api/<method>` |
| game socket | `http://127.0.0.1:7192/socket.io/` (and `/socket.io-msgpack/`) |

Podman works exactly the same: swap `docker` for `podman`. The helper script auto-detects whichever
engine is installed (podman first, then docker) and `AL_CONTAINER_BIN=docker` forces one.

The first start clones the three pinned game repositories into `/app/reference/local` and installs their
dependencies (`npm ci` in `adventureland/` and `adventureland/node/` - the game server declares its own in
`node/package.json`). That needs network and a few minutes; mount `/app/reference/local` to reuse a prepared clone.
Game data (`data.js`) is fetched during the image build.

A matching client image (protocol client + bot runner, with **loop scripts mounted** at run time) lives at
[DionJones615/adventureland-client](https://github.com/DionJones615/adventureland-client); its CI pulls this image and
runs e2e against it. Pair them on one docker network:

```sh
docker network create al
docker run -d --network al --name al-game -p 8090:8090 -p 7192:7192 ghcr.io/dionjones615/adventureland-container:latest
docker run --rm --network al -e AL_API=http://al-game:8090 -e AL_GAME_ADDRESS=al-game:7192 \
  -e AL_BOT_CHARACTER=Devmage -v "$PWD/loops:/loops:ro,z" -e BOT_LOOP=/loops/mine.mjs \
  ghcr.io/dionjones615/adventureland-client:latest
```

## With the helper script

```sh
npm ci
npm run container:build
npm run container:up -- --fixtures containers/fixtures/e2e.json --seed-email dev@example.test --seed-password dev-password-123
npm run container:status
npm run container:logs -- -f
npm run container:down
```

`up` accepts `--api-port`, `--game-port`, `--clone`, `--fixtures` (or `--no-fixtures`), `--seed-email`,
`--seed-password`, `--seed-character`, `--seed-character-type` and `--dry-run`.

## Seeding: accounts and fixtures

**Default account** — set `DEFAULT_EMAIL` and `DEFAULT_PASSWORD` and the account exists when the stack is ready.
`DEFAULT_CHARACTER` (+ `DEFAULT_CHARACTER_TYPE`) also creates a character. No env, nothing created.

**Fixtures** — declare many characters with a known state. Applied at start (`SEED_FIXTURES`) or on demand with
`npm run seed:fixtures -- --file containers/fixtures/e2e.json`:

```json
{
  "account": { "email": "dev@example.test", "password": "dev-password-123" },
  "characters": [
    {
      "name": "E2EMage", "type": "mage", "level": 40,
      "map": "main", "x": -100, "y": 800,
      "gold": 5000, "hp": 400, "mp": 400,
      "skills": { "fireball": { "level": 30 }, "blink": { "level": 10 } },
      "inventory": [ { "slot": 0, "name": "hpot1", "q": 200 } ],
      "equipment": { "mainhand": { "name": "staff", "level": 3 }, "helmet": { "name": "helmet" } }
    }
  ]
}
```

| key | meaning |
| --- | --- |
| `account` | credentials for the account; defaults to `DEFAULT_EMAIL`/`DEFAULT_PASSWORD` |
| `name`, `type`, `level` | identity (`warrior`…`merchant`); level is stored on the character document |
| `map`, `x`, `y` | starting position (`in` is set to the map) |
| `gold`, `hp`, `mp` | wallet and pools (`hp`/`mp` omitted when absent) |
| `skills` | `{ name: { level } }` |
| `inventory` | `{ slot?, name, q?, level? }`; no slot means first free |
| `equipment` | `{ slot: { name, level? } }`; `auto` lets the item type pick the slot |

Unknown items, skills or maps warn and are skipped; `--strict` makes them fail. When seeding finishes, the seeder
writes `reference/local/.state/fixtures.ready` (`{"at": …, "failures": n}`) — written even on failure, so a broken
fixture is visible rather than silent.

Why the split: the account and character are created through the API (correct document shape), then
inventory/equipment/skills/position are written into the character document, because those have no API.

## Selling: the injected test merchant

Upstream `design/maps.js` defines **no** `merchants` arrays, and the server refuses every sale unless one is
within `B.sell_dist` (400) - `socket.on("sell")` answers `distance` otherwise. On a fresh clone nothing can be sold
anywhere, through the UI or from a bot.

The entrypoint therefore appends one guarded block to the cloned map data before the server starts:

```js
/* local test merchant (generated by scripts/local/patch_merchants.mjs) */
(function () {
	if (!maps["main"]) return;
	maps["main"].merchants = [{ id: "standmerchant", x: -193, y: 680 }];
})();
```

`(x=-193, y=680)` is the position of the real `standmerchant` NPC on main, just south of the goo field the fixtures
farm - so a character farming around `(-100, 800)` is inside both the sell radius and the item-transfer radius.

| variable | default | meaning |
| --- | --- | --- |
| `AL_TEST_MERCHANT` | `main:-193,680` | `off` leaves the stack exactly as upstream ships it; `map:x,y` moves the sell point |

The patch is idempotent (the marker comment is the guard), edits only the git-ignored clone under
`reference/local/`, and touches nothing but merchant coordinates - the precomputed BFS stays valid. Run it by hand
with `npm run patch:merchants`.

## Host stack (no container)

The same tree boots on the host when you want it without a container:

```sh
npm run local:fetch    # clone the pinned repositories into reference/local
npm run local:up       # MongoDB + backend :8090 + game server :7192
npm run seed:fixtures -- --file containers/fixtures/e2e.json
npm run local:down
```

## Tests

```sh
npm run test:unit      # fixture parsing/patch building + the account API (fake fetch), no server needed
```

## Credits

This container is a thin wrapper around other people's work. It exists because these do:

| source | what it provides | pinned |
| --- | --- | --- |
| [kaansoral/adventureland_mongodb](https://github.com/kaansoral/adventureland_mongodb) | the Adventure Land game itself: client, game server, backend, `design/` data | [`a5c133d`](https://github.com/kaansoral/adventureland_mongodb/commit/a5c133dcc31f97edab987119517b4a60581248f6) |
| [kaansoral/common_engine](https://github.com/kaansoral/common_engine) | the shared engine the game server is built on (mounted as `common/`) | [`fa74fab`](https://github.com/kaansoral/common_engine/commit/fa74fabf5d3782503712621e037bfb934ecb8439) |
| [kaansoral/adventureland_secretsandconfig](https://github.com/kaansoral/adventureland_secretsandconfig) | the config keys/options template the stack boots from | [`6b3493b`](https://github.com/kaansoral/adventureland_secretsandconfig/commit/6b3493be30abe367cfaf879a2d5ad370742e0866) |
| [adventure.land](https://adventure.land) | the game data (`data.js`) this image fetches at build: items, monsters, maps, skills | live |

Those three repositories are cloned at container start and never redistributed here — see the pins in
[`scripts/local/fetch_stack.sh`](scripts/local/fetch_stack.sh). The game is
[Adventure Land](https://adventure.land), created and maintained by its authors; this project is not
affiliated with them, and the container, seeding and fixture code here is original.

## Licensing

The code in this repository (container files, seeding and fixture scripts, the account API, the tests) is MIT —
see [`LICENSE`](LICENSE).

The game is **not** included and is **not** MIT. `adventureland_mongodb`, `common_engine` and
`adventureland_secretsandconfig` carry no separate licence beyond the `LICENSE` in the game repository
(AdventureLandOnlyUse): free to use and modify, no reselling, no redistribution of the source or files, and
**attribution plus a crawlable link to <https://adventure.land>**. That is why they are cloned at container start
into `reference/local` and git-ignored instead of being baked into an image — see [Credits](#credits) for the
repositories and the exact commits.

Game data (`data.js`) is fetched from <https://adventure.land/data.js> during the image build and is not
redistributed here either. No game art, sounds or fonts are included.
