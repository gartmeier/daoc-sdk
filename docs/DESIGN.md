# daoc-sdk design

daoc-sdk is the Dark Age of Camelot counterpart of [rs-sdk](../reference/rs-sdk): a TypeScript/Bun toolkit for writing bots against a local [OpenDAoC](../server/core) server. It has a headless protocol client, a gateway, an SDK with low-level `sdk.*` and high-level `bot.*` APIs, an MCP `execute_code` server, and a bots/ folder with scripts.

Research notes (protocol specs with file and line references) are in [docs/research/](research/). Read them before touching the protocol:

- [daoc-login-crypto.md](research/daoc-login-crypto.md): framing, handshake, login to in-world sequence, anti-cheat
- [critic.md](research/critic.md): corrections, verified state machine. **Wins over the other notes where they disagree.**
- [daoc-client-handlers.md](research/daoc-client-handlers.md): every client-to-server packet layout
- [daoc-server-packets.md](research/daoc-server-packets.md): every server-to-client packet layout for 1.127
- [daoc-world-gameplay.md](research/daoc-world-gameplay.md): accounts, server properties, movement validation, combat, loot, merchants, DB data
- [rs-sdk-arch.md](research/rs-sdk-arch.md): rs-sdk architecture and what to port

## Topology

```
 script / MCP / cli             gateway (Bun.serve :7780)          headless client (client/runner.ts)
 ┌─────────────┐  WS JSON  ┌────────────────────────────┐ WS JSON ┌──────────────────────────────┐  DAoC TCP 1.127
 │ BotActions  │──sdk_*──▶ │ bots[username]             │─action─▶│ ActionQueue → executor       │──────────────▶ OpenDAoC
 │  └ BotSDK   │◀─sdk_*─── │ sdks[sessionId]            │◀─state──│ WorldModel → collectState()  │◀────────────── :10300
 └─────────────┘           │ HTTP /status /state /chat  │         │ Mover (0xA9 stream), LoS     │
                           └────────────────────────────┘         └──────────────────────────────┘
```

- **The SDK never speaks the DAoC protocol.** It sends `BotAction` JSON and receives `BotWorldState` snapshots. The contract is in [sdk/types.ts](../sdk/types.ts).
- **The client owns the TCP socket, packet codecs, the world model, and the mover.** DAoC has no click-to-walk, so the client streams 0xA9 position updates itself, both while moving and as a heartbeat of at least 1 per second. It answers 0xD0 line-of-sight checks with "clear", and it asks for unknown players with 0xD5.
- **The gateway is a dumb router** with the same envelope as rs-sdk (`connected`/`state`/`actionResult` ↔ `action`, `sdk_connect`/`sdk_action` ↔ `sdk_state`/`sdk_action_result`/`sdk_error`), plus `lastState` replay, control and observe modes, and last-controller-wins.
  - **Takeover:** the old controller gets `sdk_error` "Disconnected: another controller connected" and its socket is closed. BotSDK then turns auto-reconnect off and reports `wasPreempted()` / `getPreemptedReason()` until the next `connect()`. `runScript` aborts with `BotPreemptedError` (a `BotDisconnectedError` subclass) in both `onDisconnect: 'error'` and `'wait'` modes, because a pre-empted SDK never reconnects.
  - **Exposure** (`gateway/security.ts`): it listens on `GATEWAY_HOSTNAME` (default `127.0.0.1`). Every request, WebSocket upgrades included, is checked first: a foreign browser `Origin` gets 403, and on a loopback bind so does a non-loopback `Host` (DNS rebinding). CORS headers go only to loopback origins and the gateway's own. `POST /say`, `/dm` and `/bots/<bot>/auth` need `Content-Type: application/json` (415 otherwise), so a cross-origin "simple" POST never reaches a bot.
  - **Auth** is a pluggable `GatewayAuthHook`; `createGateway()` allows everything by default. The CLI entrypoint installs `botEnvAuth` (the password must equal the bot's `bot.env` `PASSWORD`, constant-time; unknown bots are refused) when `GATEWAY_AUTH=botenv`, which is also the default once `GATEWAY_HOSTNAME` is not loopback. `GATEWAY_AUTH=none` turns it off.
- **Pinned protocol:** client version 1.127 (`01 01 1B`), client type 0x06. TCP only, no UDP, no encryption.

## Repository layout and ownership

```
sdk/types.ts          shared contract (BotWorldState, BotAction, ActionResult). Additive changes only.
data/                 static world data from server/db SQL dumps: sql.ts (parser), zones.ts (zone lookup), spec-names.ts (a line's key, display and item names; no imports), index.ts (other loaders), generated/ (gitignored JSON cache)
client/               headless DAoC client
  net/                framing (C→S 12-byte header + checksum, S→C 3-byte header stream decoder), TCP connection
  protocol/           PacketReader/PacketWriter, opcodes, outgoing encoders, incoming decoders (pure functions)
  model/              WorldModel: applies decoded packets (player, objects, inventory, skills, chat, dialogs, merchant, group, effects, pet window and summons)
  movement.ts         Mover: heartbeat + moveTo along waypoints at ≤0.9×maxSpeed, 200 ms cadence, snaps on server correction
  session.ts          DaocSession: connect → login → (create char) → enter world → playing; keepalive ping; LoS replies; 0xD5; region change; quit
  client.ts           DaocClient: session + model + mover; collectState(): BotWorldState; execute(action): Promise<ActionResult>
  action-queue.ts     FIFO queue with TTL (port of rs-sdk BotActionQueue)
  runner.ts           one bot per process, bridging DaocClient ↔ gateway
  swarm.ts            many bots in one process
  dev/                live smoke scripts against the local server
gateway/              gateway.ts, types.ts, state-fanout.ts, security.ts (Origin/Host checks, bot.env auth), viewer/ (port of rs-sdk server/gateway, without engine coupling)
sdk/                  index.ts (BotSDK), actions.ts (BotActions = bot.*), runner.ts (runScript), cli.ts, chat.ts, chat-history.ts (shared with the gateway), formatter.ts, execution-context.ts, pathfinding.ts, generate-api-docs.ts, API.md, test/
sdk/group/            group coordination on top of BotSDK/BotActions (one control connection per member, in one process):
  types.ts            the JSON contract: MemberReport, Sighting, Contact, Orders, GroupEvent, GroupDefinition
  blackboard.ts       shared picture: merges members' sightings into contacts (freshness, staleness, sticky threat, cc, kills)
  member.ts           MemberAgent: publishes its snapshots, runs its role's behaviour list; orders changes interrupt
  behaviors.ts        behaviour library (release, retreat, flee, heal, crowdControl, pull, tank, assist, position, holdFormation, rest, buff, shedLoad)
  pets.ts             pets in a run: withPets wraps every member's list; petControl on its own side tick is the one authority over a window pet (learnings/pets.md)
  strategy.ts, pve.ts GroupStrategy (decide + behaviours + settings), Coordinator, the PvE leveling policy
  rvr.ts              the RvR roaming policy for battlegrounds (patrol, fight enemy players, hunt, fall back, regroup)
  keeps.ts            a battleground's keeps, arrival points and the circles round the keeps whose guards attack us
  battleground.ts     getting a group into a battleground: portal keeps, medallion, the battleground teleporter
  observer.ts         metrics, findings and runs/<stamp>.md reports; runner.ts runGroup/runGroupScript; cli.ts; terrain.ts camps/danger/aggro
mcp/                  server.ts, execute-code.ts, console-capture.ts, api/ (BotManager, which spawns client/runner.ts when no client is attached)
bots/                 create-bot.ts, _template/, examples/ (+ script-args.ts); each bots/<name>/ is gitignored
groups/               create-group.ts, _template/; each groups/<name>/ (group.json, strategy.ts, runs/) is gitignored
scripts/              build-data.ts, setup-server.ts, check-submodules.ts
server/docker/        docker-compose.yml and Dockerfile that build OpenDAoC from the server/core submodule
learnings/            per-topic markdown notes for agents writing bots
```

## Conventions

- Bun and TypeScript, strict mode with `noUncheckedIndexedAccess` (see tsconfig.json). Use `bun test` for tests, colocated as `*.test.ts`.
- 4-space indent, single quotes, semicolons, the same style as rs-sdk.
- Protocol encoders and decoders are pure functions over `Uint8Array`. They get **golden byte tests** against the layouts in the research notes and the C# handlers. Cite the C# file and line in a comment on each encoder and decoder.
- `sdk.send*` success means **dispatched**. `bot.*` methods **observe** evidence (position, HP, inventory, messages) before they report success.
- Strings on the wire are CP1252. Use the PacketReader/PacketWriter helpers, never ad-hoc TextEncoder.
- Never hard-code credentials. Bots read `bots/<name>/bot.env`.

## Local server

```
docker compose -f server/docker/docker-compose.yml up -d --build   # bun run server:up
bun run server:setup                                               # bot-friendly server properties
```

- Game server: TCP `localhost:10300`.
- MariaDB: `localhost:13306`, user root, password `daoc-sdk`, database `opendaoc`.
- Accounts are auto-created on first login.
- Do not use GM accounts for gameplay bots: mobs never attack PrivLevel > 1.

## bot.env

```
BOT_USERNAME=mybot        # account name, [a-zA-Z0-9]
PASSWORD=...              # game account password; the gateway also checks it under GATEWAY_AUTH=botenv
CHAR_NAME=Mybot           # ^[A-Z][a-zA-Z]+, ≥3 chars; default derived from the username (defaultCharName in client/client.ts):
                          #   digits map to a-j (0→a … 9→j), other non-letters are dropped, under 3 letters is padded
                          #   with 'bot', then capitalised: mybot → Mybot, qzrev1 → Qzrevb, t3 → Tdbot
REALM=albion              # albion | midgard | hibernia
CLASS=Fighter             # base or advanced class name valid for the realm (level-1 classes, e.g. Fighter, Mage, Viking, Naturalist)
RACE=Briton
GENDER=male               # male | female; optional, validateCharacter resolves it when unset (bad values are rejected)
SERVER=localhost:10300    # DAoC server for the client
GATEWAY_URL=ws://localhost:7780
SHOW_CHAT=true
```
