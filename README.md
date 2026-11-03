# daoc-sdk

A starter kit for writing Dark Age of Camelot bots against a local [OpenDAoC](https://github.com/OpenDAoC/OpenDAoC-Core) server. It has a headless DAoC client written in TypeScript, an SDK with high-level `bot.*` and low-level `sdk.*` APIs, agent documentation, and an MCP server so a coding agent can play directly.

It is the DAoC counterpart of [rs-sdk](https://github.com/MaxBittker/rs-sdk) and copies its shape: the same gateway envelope, the same `runScript` / `execute_code` workflow, and the same `bots/<name>/` layout. Bots run only against your own server.

## Quick start

Requirements: [Bun](https://bun.sh) 1.1+, Docker, git.

The OpenDAoC server source (`server/core`) and its DB dump (`server/db`, our fork with one fix: see docs/SERVER.md) are git submodules. Clone with `git clone --recurse-submodules <url>`, or fetch them in an existing clone; `reference/rs-sdk` and `server/buildnav` are optional.

```sh
git submodule update --init server/core server/db   # required: the server build and data/ read them
bun install
bun run server:up        # build and start OpenDAoC + MariaDB (first run: several minutes)
bun run server:setup     # bot-friendly server properties (xp_rate 3, no per-IP limits, instant quit)

bun bots/create-bot.ts mybot                 # bots/mybot/{bot.env,script.ts,lab_log.md}
bun gateway/gateway.ts                       # SDK gateway on ws://localhost:7780 (leave running)
bun client/runner.ts mybot                   # headless client: logs in, creates the character (leave running)
bun sdk/cli.ts mybot                         # what the bot sees
bun bots/mybot/script.ts                     # starter script: walk, kill a monster, loot
```

Stop a client with a quit action so the character leaves the world: `bun client/dev/swarm-check.ts mybot --seconds=0 --quit`, `await sdk.sendQuit()` in a script, or MCP `disconnect_bot`. Ctrl+C is clean only when typed in the client's own console. On Windows, a signal sent from another process (`Stop-Process`, `taskkill`, `child.kill()`) kills bun outright, and the character then stays link-dead for 60 s, during which logins are refused.

With Claude Code:

```sh
claude "create a bot called mybot and level it to 5"
```

The MCP server in `.mcp.json` gives the agent an `execute_code` tool. It starts the gateway and the headless client by itself. [CLAUDE.md](CLAUDE.md) is the agent playbook.

## Writing bots

A script in `bots/mybot/kill.ts`, run with `bun bots/mybot/kill.ts`:

```typescript
import { runScript, type ScriptContext } from '../../sdk/runner';

const main = async ({ bot, sdk }: ScriptContext) => {
    const mob = bot.findKillableNpc();
    if (mob) console.log((await bot.killNpc(mob)).message);
    return sdk.getPlayer();
};

export default main;
if (import.meta.main) await runScript(main, { timeout: 60_000 });
```

The guarded `export default main` lets MCP run the same file: `execute_code({ bot_name: 'mybot', script: 'bots/mybot/kill.ts' })`. Inline code works too: `execute_code({ bot_name: 'mybot', code: 'const mob = bot.findKillableNpc(); return mob && await bot.killNpc(mob);' })`.

- `bot.*` (BotActions) methods walk, fight, cast, loot, trade and talk. Each one observes evidence before it reports success: position, health, inventory, messages.
- `sdk.*` (BotSDK) gives state reads plus `send*` methods that only report that the client **dispatched** a packet.
- **One controller per bot.** The newest control connection (a script, MCP `execute_code`, `swarm-check`, the viewer's control mode) wins. A `runScript` script that is taken over aborts at once with `BotPreemptedError`, a subclass of `BotDisconnectedError`; the game client keeps running. `sdk/cli.ts` and `sdk/chat.ts` connect as observers and never take over.
- Full reference: [sdk/API.md](sdk/API.md), generated from source.
- Topic notes from live runs: [learnings/](learnings/README.md).
- Examples:
  - [bots/examples/](bots/examples/): `grinder.ts`, `merchant-run.ts`, `caster.ts`, `explorer.ts`, `duo.ts`.
  - Run one with `bun bots/examples/<x>.ts <bot> [args]`. A copy in `bots/<bot>/` takes the same args without the bot name (`scriptArgs()` in `bots/examples/script-args.ts`), and MCP takes them as `args`.

## Architecture

```
 script / MCP / cli             gateway (Bun.serve :7780)          headless client (client/runner.ts)
 ┌─────────────┐  WS JSON  ┌────────────────────────────┐ WS JSON ┌──────────────────────────────┐  DAoC TCP 1.127
 │ BotActions  │──sdk_*──▶ │ bots[username]             │─action─▶│ ActionQueue → executor       │──────────────▶ OpenDAoC
 │  └ BotSDK   │◀─sdk_*─── │ sdks[sessionId]            │◀─state──│ WorldModel → collectState()  │◀────────────── :10300
 └─────────────┘           │ HTTP /status /state /chat  │         │ Mover (0xA9 stream), LoS     │
                           └────────────────────────────┘         └──────────────────────────────┘
```

- **The SDK never speaks the DAoC protocol.** It sends `BotAction` JSON and gets `BotWorldState` snapshots ([sdk/types.ts](sdk/types.ts)).
- **The headless client** (`client/`) owns the TCP session (protocol 1.127, no encryption), the world model, and the mover. DAoC has no click-to-walk, so the client streams position updates itself. It also answers the server's line-of-sight checks with "clear".
- **The gateway** routes between scripts and clients by username, like rs-sdk's. It also serves `/status`, `/state/<bot>`, `/chat/<bot>`, `POST /say/<bot>`, `POST /dm/<bot>` and a browser viewer at `/viewer`, for one bot, a whole group (`/viewer/group/<group>`) or every bot in a region with each group's run, such as three groups fighting in a battleground (`/viewer/region/<regionId>`). A group run publishes its coordinator's picture there once a second. See [Gateway access](#gateway-access).
- **Static world data** (`data/`) is parsed from the OpenDAoC DB dump: NPC spawns, merchants' item lists, items, spells, styles, zones, classes and races. It also includes a ground-height estimate, because the server ships no terrain or navmesh. Navmeshes can be generated from a local DAoC client with `bun run navmesh:build` (Windows; `server/buildnav`, output in `server/navmesh/`, not redistributable); `walkTo` then routes over them (learnings/walking.md).

### Gateway access

The gateway has no login server of its own, so by default it is reachable only from this machine:

- **Bind address:** `GATEWAY_HOSTNAME` (default `127.0.0.1`). `0.0.0.0` exposes it to the network. The port is `AGENT_PORT` (default 7780).
- **Passwords:** `GATEWAY_AUTH=botenv` makes clients, SDKs and HTTP callers present the `PASSWORD` from the bot's `bots/<name>/bot.env` (or any `bot.env` whose `BOT_USERNAME` matches); unknown bots are refused. `botenv` is the default when `GATEWAY_HOSTNAME` is not a loopback address, and `GATEWAY_AUTH=none` turns it off. On the default loopback bind there is no password check. The startup log states the mode. Under `botenv`, the viewer asks for the password even to observe, and HTTP callers pass it as `Authorization: Bearer <password>` or a `password` field in the JSON body.
- **Browsers:** requests with a foreign `Origin` are refused with 403, including WebSocket upgrades. Only loopback origins (any port) and the gateway's own origin are allowed, and only they get CORS headers. On a loopback bind, a non-loopback `Host` header is also refused, which blocks DNS rebinding. The SDK, the headless client and curl send no `Origin`.
- **Groups:** `/groups` lists the `groups/*/group.json` groups on the gateway's own disk (others don't exist for it). `/groups/<group>/live`, `/groups/<group>/runs[/<stamp>]` and the runner's `POST /groups/<group>/publish` take the group leader's password under `botenv`, as a bearer token only (never `?password=`), and it reads the whole group. `POST /groups/<group>/control` (wind down a run) needs the leader's bot.env password even on loopback, like the viewer's control mode.
- **POST bodies must be JSON:** `/say/<bot>`, `/dm/<bot>`, `/bots/<bot>/auth` and the `/groups/<group>/...` POSTs answer 415 unless the request has `Content-Type: application/json`, for example `curl -X POST -H 'Content-Type: application/json' -d '{"text":"hi"}' localhost:7780/say/mybot`.

Design notes and protocol research: [docs/DESIGN.md](docs/DESIGN.md), [docs/research/](docs/research/). Server operation: [docs/SERVER.md](docs/SERVER.md).

## Layout

```
bots/            create-bot.ts, _template/, examples/, and one folder per bot (each bot folder, including bot.env, scripts and lab_log.md, is gitignored)
client/          headless DAoC client: net/, protocol/, model/, movement.ts, session.ts, runner.ts, swarm.ts
gateway/         gateway.ts (rs-sdk-compatible router), groups.ts (group views), viewer/
sdk/             index.ts (BotSDK), actions.ts (BotActions), runner.ts, cli.ts, chat.ts, API.md
mcp/             server.ts (execute_code, list_bots, disconnect_bot), api/ (BotManager)
data/            DB dump parsers and query helpers; generated/ is a cache
scripts/         setup-server.ts, build-data.ts, check-submodules.ts
LICENSES/        third-party license texts (rs-sdk MIT, OpenDAoC GPL-3.0)
server/          docker/ (compose + Dockerfile), core/ (OpenDAoC source), db/ (DB dump)
learnings/       per-topic notes for agents
docs/            design, server, research notes, build reports
```

## Gameplay modifications

`bun run server:setup` changes only server properties. The game rules are stock OpenDAoC.

- **`xp_rate` 3:** three times the normal experience (`--xp=N` to change it).
- **Instant `/quit`** when out of combat (`disable_quit_timer`). After recent combat the server still makes you wait up to 60 s.
- **No per-IP limits** on accounts (`time_between_account_creation_sameip` 0, `total_accounts_allowed_sameip` 1000). Every bot connects from the same Docker NAT address.
- **Accounts are created on first login;** characters may be in all three realms on one account.
- **No idle kick, no hacker bans** (a protocol mistake gets a kick, not a ban).
- **Unchanged defaults:**
  - `start_as_base_class`: an Armsman starts as a Fighter.
  - autoloot is on.
  - LoS checks stay on; the client answers them.

Keep gameplay bots at PrivLevel 1. Monsters never attack GM accounts.

## Credits

- **[OpenDAoC](https://github.com/OpenDAoC/OpenDAoC-Core)** (GPL-3.0) is the server emulator everything here runs against. Its C# source in `server/core` is the reference for every packet layout and game rule. OpenDAoC descends from Dawn of Light (DOL).
- **[rs-sdk](https://github.com/MaxBittker/rs-sdk)** (MIT, Copyright (c) 2025 Lost City) by Max Bittker inspired the architecture, the agent workflow and much of the SDK surface; several files are adapted from it (see License). rs-sdk is in turn built on the [LostCity](https://github.com/LostCityRS/Server) engine.
- Dark Age of Camelot is a trademark of its owners. This project is not affiliated with or endorsed by them. It is for education and research on private, local servers. Bots made here are not for use on live or official servers.

## License

Copyright (C) 2026 Joshua Gartmeier

daoc-sdk is licensed under the **GNU General Public License, version 3 or (at your option) any later version** (`GPL-3.0-or-later`), with no warranty. The full text is in [LICENSE](LICENSE). The GPL applies because daoc-sdk is built to run with OpenDAoC and ports parts of its source: protocol layouts, `ConLevelGrid`, the class and race tables, and message texts.

Third-party code keeps its own license and notices, and the git submodules (`server/core`, `server/db`, `server/buildnav`, `reference/rs-sdk`) stay under their own licenses:

- OpenDAoC ships the GPL-3.0 text, and its file headers say "GPL v2 or later". Its text is in [LICENSES/OpenDAoC-GPL-3.0.txt](LICENSES/OpenDAoC-GPL-3.0.txt); `sdk/actions-helpers.ts` carries a notice for the ported `ConLevelGrid`.
- rs-sdk code adapted here is MIT (Copyright (c) 2025 Lost City), which is compatible with the GPL. The full MIT text is in [LICENSES/rs-sdk-MIT.txt](LICENSES/rs-sdk-MIT.txt), and each derived file names it in a header comment:
  - copied verbatim (or re-indented): `sdk/execution-context.ts`, `sdk/redact.ts`, `mcp/console-capture.ts`;
  - adapted: `sdk/index.ts`, `sdk/runner.ts`, `sdk/cli.ts`, `sdk/chat.ts`, `sdk/chat-history.ts`, `sdk/formatter.ts`, `sdk/generate-api-docs.ts`, `sdk/test/api-docs.test.ts`, `sdk/test/sdk-unit.test.ts`, `mcp/server.ts`, `mcp/execute-code.ts`, `mcp/api/index.ts`, `gateway/gateway.ts`, `gateway/gateway.test.ts`, `client/action-queue.ts`, `client/action-queue.test.ts`.
