# Local OpenDAoC server

daoc-sdk bots run against a local [OpenDAoC](../server/core) server in Docker. The stack is defined in [server/docker/docker-compose.yml](../server/docker/docker-compose.yml). It builds the game server from the local `server/core` submodule and seeds MariaDB from `server/db/opendaoc-db-core`.

## Quick start

The game server source (`server/core`) and the DB dump (`server/db`) are git submodules. Clone with `git clone --recurse-submodules <url>`, or in an existing clone run:

```
git submodule update --init server/core server/db   # required; reference/rs-sdk and server/buildnav are optional
```

`bun run server:up` refuses to start while either one is empty, and warns when `server/db` isn't on the commit this repo pins, because an empty `db-data` volume is seeded from whatever is checked out; `git submodule update server/db` fixes it (`scripts/check-submodules.ts`). It only warns: a different dump can be deliberate, and a volume that's already seeded isn't affected.

`server/db` comes from branch `daoc-sdk` of our fork, [gartmeier/OpenDAoC-Database](https://github.com/gartmeier/OpenDAoC-Database). That's [OpenDAoC's dump](https://github.com/OpenDAoC/OpenDAoC-Database) with two fixes, each on its own branch so it can go upstream as a PR: the capitals' 13 Item Merchants stop selling level 50-51 gear for copper (learnings/merchants.md), and Guardians, Heroes, Blademasters and Champions get their starter armour (learnings/classes-and-races.md). `daoc-sdk` merges both and adds a README notice saying what changed. A clone from before the fork runs this once in its main checkout, not a worktree: `git submodule sync server/db && git submodule update server/db`. Until the update, `git status` shows `server/db` as modified, and committing that puts the old dump back. To take newer upstream dumps, merge OpenDAoC's `master` into `daoc-sdk`, push it to the fork, check the new commit out in `server/db` and commit it in this repo.

```
bun run server:up       # docker compose -f server/docker/docker-compose.yml up -d --build
bun run server:setup    # bot-friendly server properties, restarts the gameserver, waits for :10300
bun run data:build      # optional: static world data in data/generated/ (built lazily on first use anyway)
```

On the first `server:up`:

- The image build takes a few minutes (`dotnet build` of the whole solution).
- MariaDB then imports the ~70 MB dump, which also takes a few minutes. The game server waits for the DB healthcheck.
- The game server creates the `serverproperty` rows on its first boot, so run `server:setup` after the server is up. The script waits for the table if it doesn't exist yet.

## Ports and credentials

| What | Where |
|---|---|
| Game/login server | TCP `localhost:10300`. The SDK uses TCP only. UDP 10400 is published but optional. |
| MariaDB | `localhost:13306`, user `root`, password `daoc-sdk`, database `opendaoc` |
| SQL shell | `docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc -e "..."` |
| Server logs | `docker compose -f server/docker/docker-compose.yml logs -f gameserver` |
| SDK gateway (not part of the server) | `ws://localhost:7780`, bound to 127.0.0.1 by default; `GATEWAY_HOSTNAME`, `GATEWAY_AUTH` and `AGENT_PORT` are described in the README under "Gateway access" |

Accounts are created automatically on first login (`AUTO_ACCOUNT_CREATION=True` plus the server property `allow_auto_account_creation`). Account names must match `^[a-zA-Z0-9]+$`. An `account` row exists only after the account's first login.

## Lifecycle

| Task | Command |
|---|---|
| Start, or rebuild after C# changes | `bun run server:up` |
| Stop, keeping the DB | `bun run server:down` |
| Restart only the game server | `docker compose -f server/docker/docker-compose.yml restart gameserver` (about 12 s until logins work, about 55 s with the 42 home-realm navmeshes mounted, measured before the default build added the capitals and Thidranki; wait for "Server is now listening" in `docker compose -f server/docker/docker-compose.yml logs gameserver`) |
| Reset everything: accounts, characters, properties | `docker compose -f server/docker/docker-compose.yml down -v`, then `server:up` and `server:setup` |
| Re-apply bot properties | `bun run server:setup` |

`down -v` deletes the `db-data` volume. The next `up` re-imports the dump from scratch.

The re-import reads whatever is checked out in `server/db`, so run `git submodule update server/db` before `down -v`. Updating alone doesn't change a DB that's already seeded, because the dump is only imported into an empty volume. A DB seeded from a dump older than the fork keeps both problems until it's re-imported, or until you run these and restart the game server: `UPDATE mob SET ClassType='DOL.GS.GameBountyMerchant' WHERE Guild='Item Merchant' AND ClassType='DOL.GS.GameMerchant';` and `UPDATE starterequipment SET Class='52;', TemplateID=CONCAT(TRIM(TRAILING '3' FROM TemplateID),'3') WHERE StarterEquipmentID IN (13,14,76,77,78,109);`. Characters made earlier keep their inventory.

## Throwaway stacks (scripts/throwaway-server.ts)

A live check that must leave the shared stack alone gets its own compose project, volume and ports, generated from `server/docker/docker-compose.yml` and running `daoc-sdk-gameserver:latest`.

```bash
bun run server:throwaway up     # exits 0 once logins work, and prints the ports
bun run server:throwaway down   # removes this stack and its volume
```

Point a bot at it with `SERVER=127.0.0.1:<port>` in `bot.env`, or give a `DaocClient` the host and port (no gateway needed, as in `client/dev/smoke.ts`). Use one account per character.

- **Names.** The default is the checkout's folder, so each worktree has its own stack; `--name=<name>` makes another. `up` on a stack that is up starts nothing and prints its ports again.
- **Ports.** The first of nine slots with nothing published: `10300+10n` game, `10400+10n` UDP, `13306+10n` MariaDB. A slot another `up` takes first moves this one to the next. Docker Desktop doesn't report a port held by a program outside Docker: `up` then fails at the handshake, after the server is listening.
- **Readiness.** `up` waits for this boot's `Server is now listening` line, then for the 0xF4 handshake on the published port. A crash fails it at once with the end of the log.
- **What differs from the shared stack.** No navmeshes, so NPCs walk straight. Only the two account limits of `server:setup` are set (`time_between_account_creation_sameip`, `total_accounts_allowed_sameip`), so `xp_rate`, the quit timer and the rest stay stock. `restart: "no"`, so a forgotten stack stays down after a Docker restart. `oom_score_adj: 500`, so it goes before the shared gameserver if the Docker VM runs out of memory. Each stack holds about 2-2.5 GiB there.
- **Image.** `up` never builds. It warns when the image is older than the last commit that moved the `server/core` pin. `docker compose -f server/docker/docker-compose.yml build gameserver` replaces the image without touching the running shared stack.
- **Seed volume.** The first `up` stops its stack once booted, copies the database into a volume `daoc-seed-<hash>`, and later ones restore that copy. It holds no accounts, because no client has connected yet. The hash covers the dump's commit and uncommitted changes, the image id, the shared `db` service and the two limits, so a rebuilt image or a moved pin costs one cold boot and a new seed, which replaces the older ones. `down` leaves the seed (about 400 MB); `docker volume rm` the name from `docker volume ls --filter name=daoc-seed-` to get the space back. `--cold` seeds from the dump and neither uses nor saves a seed, for a check of the seeding itself.

| `up` | Seconds | Where they go |
|---|---|---|
| First, saving a seed | 74 | as `--cold`, plus 3 to save and 6 to start MariaDB again |
| From the seed | 25-31 | restore 2, MariaDB start 6, gameserver boot 15-22 |
| `--cold` | 63-72 | MariaDB 26-31 (18-23 of it the SQL import), first boot 17-19, restart and second boot 16-19 |
| On a stack that is up | 4 | |

Measured 2026-11-03 with the shared stack and up to three other throwaway stacks running. Turning off InnoDB durability saved 4 s of the import, and a 2 s healthcheck interval 4 s of a cold boot and nothing from the seed, so the stack keeps the shared file's settings.

## `server:setup` (scripts/setup-server.ts)

The script waits for MariaDB, then checks each property key and value type against the `[ServerProperty]` attributes in `server/core/GameServer`. It updates rows, or inserts them if missing, and verifies the values with SQL. If anything changed, it restarts the **gameserver container only**, then waits until the server answers a real 0xF4 → 0x22 handshake. A plain TCP connect isn't enough, because Docker's port proxy accepts connections before the server is listening.

| Property | Value | Why |
|---|---|---|
| `time_between_account_creation_sameip` | 0 (default 15 min) | Under Docker Desktop every bot connects from the same NAT IP |
| `total_accounts_allowed_sameip` | 1000 (default 20) | Same reason |
| `allow_auto_account_creation` | True | Accounts are created on first login |
| `allow_all_realms` | True (default False) | One account can own characters in all three realms |
| `allow_dual_logins` | True | |
| `disable_quit_timer` | True (default False) | Instant `/quit` when not in combat |
| `player idle kick` | False | Idle bots are never kicked |
| `ban_hackers` | False | A protocol mistake gets a kick, not a ban |
| `xp_rate` | 3 (`--xp=N`) | Faster levelling for test runs |

`check_los_before_aggro` and `check_los_during_player_cast` keep their defaults (True). The headless client answers each 0xD0 LoS request from the terrain heightmap between the two objects (`client/session.ts` `losClear`, `sdk/vision.ts` `lineOfSight`); with no terrain built or `DAOC_LOS=clear`, with "clear".

Options:

```
--dry-run                show the diff and SQL, change nothing
--xp=<rate>              xp_rate (default 3)
--set <key>=<value>      any other property, validated against the C# source (repeatable), e.g. --set starting_money=10000
--restart | --no-restart force or skip the restart (default: restart only when something changed)
--gm=<account>[:<lvl>]   set PrivLevel (default 3 = admin) for a human/admin account
--ungm=<account>         set PrivLevel back to 1
--timeout=<s>            wait limit for DB/server (default 240)
```

**Gameplay bots must stay at PrivLevel 1.** Accounts with PrivLevel > 1 are never attacked (`GamePlayer.IsAttackable`, GamePlayer.cs:260). They also skip fall damage, speed checks, interact range and loot ownership, so PvE results from them mean nothing. A PrivLevel change applies on the account's next login. To let a normal bot use one GM command, grant just that command instead: `INSERT INTO singlepermission (PlayerID, Command, SinglePermission_ID) VALUES ('<account>', 'jump', UUID());`.

## Server-side mods

- **C# changes:** edit `server/core`, then run `bun run server:up` to rebuild the image (Dockerfile at `server/docker/Dockerfile.gameserver`).
- **Runtime scripts:** `ENABLE_COMPILATION=True` compiles every `*.cs` under `/app/scripts` at startup into `./lib/GameServerScripts.dll`. Nothing is mounted there today. To add custom `[Cmd]` commands, event hooks or `[ServerProperty]` fields without a rebuild, bind-mount a host folder at `/app/scripts` in the compose file.
- **Server properties:** use `bun run server:setup --set key=value` (values are checked against the type of the attribute's default literal, which is what `ServerProperties.Load` converts to, so a `double` field with default `0` takes only integers), or SQL followed by a gameserver restart. `/serverproperties refresh` also works for an admin in game.
- **Useful GM/admin commands** (PrivLevel 2/3 or `singlepermission`): `/jump to <x> <y> <z> [region]`, `/player level <n>`, `/item create <id_nb>`, `/plvl`, `/reload mob`.

## Gotchas

- **60 s link-dead lockout.** If a playing client drops without `/quit`, its character stays in the world as link-dead for 60 s (`SECONDS_TO_QUIT_ON_LINKDEATH`, GamePlayer.cs:41). Logging in again during that time is refused with 0x2C code 0x11 (`AccountIsInLogoutProcedure`). Back off for 60 s, or quit cleanly (`disable_quit_timer` makes `/quit` instant out of combat): `sdk.sendQuit()`, MCP `disconnect_bot` or `bun client/dev/swarm-check.ts <bot> --seconds=0 --quit`. On Windows, a signal sent to the client from another process (`Stop-Process`, `taskkill`, `child.kill()`) kills bun outright, so it never sends `/quit`.
- **Soft link-death after 5 s without 0xA9.** The client must send position updates at least every ~1 s while idle.
- **Per-IP limits.** All bots share one source IP through Docker Desktop. If `server:setup` hasn't run, account creation is throttled to one per 15 min, with at most 20 accounts.
- **GM accounts are never attacked**, as described above.
- **Start as base class.** `start_as_base_class` defaults to True, so an Armsman is created as a Fighter and promotes at a trainer later.
- **Training needs no trainer:** `allow_train_anywhere` defaults to True (ServerProperties.cs:2103, train.cs:143), so the trainer window and `/train` work anywhere. A respec still needs one targeted (respec.cs:62-67).
- **Respecs are free,** with `free_respec` off, at any level: the stone check tests `TimeSpan...Hours > 24`, which can never hold (respec.cs:96, 153). `bot.respec` uses this ([learnings/builds.md](../learnings/builds.md#respec)).
- **Valkyrie, Bainshee, Heretic, Warlock, Vampiir and Mauler can't be created.** Valkyrie and Bainshee are in the starting-class list, but their `EligibleRaces` lists are commented out (ClassValkyrie.cs:50, ClassBainshee.cs:169). The others aren't starting classes. Half Ogre, Frostalf, Shar and the Minotaur races can't be created either: they have no `STARTING_STATS_DICT` entry (GlobalConstants.cs:928-933). Use `getStartingClasses(realm)` and `validateCharacter()` from `data/index.ts`.
- **Navmeshes are optional; terrain is missing.** The image builds a musl `libDetour.so` (64-bit polyrefs) from `server/core/Pathing/Detour` into `/app/lib/`, and compose mounts `server/navmesh/` read-only at `/app/navmesh`. No `.nav` files ship (they are derived from client assets): `bun run navmesh:build` generates them, the same files the SDK's `walkTo` uses, plus `zoneNNN.terrain` heightmaps that only the SDK reads (the server ignores them). Meshes load at startup, before the server listens, so restart the gameserver after a build (`docker compose -f server/docker/docker-compose.yml restart gameserver`; a container from before this mount existed needs `bun run server:up`) and expect about 55 s instead of 12 s until logins work (42 meshes from the Windows bind mount take ~41 s). The log then shows "Loading NavMesh successful for zone N" per zone, and `LocalPathfindingMgr` routes NPCs around walls in those zones. Without meshes, Docker creates an empty `server/navmesh/` for the mount, each zone logs a DBG "File not found", and NPCs move in straight lines. The meshes stay in memory: regions 1, 100 and 200 (42 zones, 1.3 GB on disk) raised the container from about 2.1 GB to 3.6 GB, so give Docker Desktop enough memory, or build fewer zones. The DB has no terrain heights either. Get Z from server updates of nearby objects, or use `estimateZ(regionId, x, y)` from `data/index.ts`. It interpolates (IDW) over nearby spawn, bind and startup heights. Leave-one-out error over mob spawns in regions 1, 100 and 200 is about 25 units median and about 200 units at p90. The server never validates a player's Z for movement, but every 3D range check (melee 128, interact 192) uses it. In zones with a loaded mesh it also matters in two more places. A mob chasing a player more than ~128 units off the mesh can't path to them: it is teleported to the closest reachable node or, in combat, gets DamageImmunity and regenerates (`NpcMovementComponent.HandleUnreachableDestination`). A ground target more than 16 units off the mesh (`ground_target_snap_max_distance`) is silently dropped (`PlayerGroundTargetHandler.ValidateGroundTarget`). So keep the SDK's navmesh walking on: the client then takes every z it sends from the terrain or the mesh (sdk/ground.ts), also for a raw `sdk.sendMoveTo` without z, and stays within ~13 units of the mesh on most ground, at most about 40 (steep slopes, wading, and swimming 24 under it), well inside the 128-unit limit. Take ground-target z from `navmeshGroundZ`.
- **Restarts kick everyone.** `server:setup` restarts the gameserver only when a property changed, but any connected bot is disconnected when it does.
- **`serverproperty` rows only exist after the first boot.** The setup script inserts missing rows, but values are only read at startup or on refresh.
