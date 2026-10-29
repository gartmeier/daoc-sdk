# Final pass

## Finder notes

## live-e2e
I followed README and CLAUDE.md as a new user would. Port :7780 was free, so I started my own gateway with `bun run gateway`. Another agent's viewer tab and its qzrev1/2 clients attached to it while it ran; that was harmless. I created fe2e1..fe2e9 with `bun bots/create-bot.ts` (fe2e2 `--class=Mage`, fe2e4 `--realm=midgard` Viking, fe2e5 `--realm=hibernia` Guardian, the rest Albion Fighters). Every account and character was created on first login, and `in game (phase playing)` appeared within about 0.6 s.

**PASS**
- **cli:** `bun sdk/cli.ts`, including the stale and no-client messages. `bun sdk/chat.ts` say and `--to` also work.
- **Template:** fe2e1 +16 xp, Midgard fe2e4 +17 xp, swarm bot fe2e9 +16 xp.
- **Grinder:** `bun bots/examples/grinder.ts fe2e1 300` gave 15 kills, L1→3, 0 deaths.
- **Merchant run:** `merchant-run.ts fe2e1` sold 4/4 for 4c.
- **Explorer:** `explorer.ts fe2e6 600 5`.
- **Duo:** `duo.ts fe2e3 fe2e8 2` grouped and got 2 kills.
- **Buying via bot.buyItem:** page/slot and exact name each bought 20 rough blunt bolts for 19c. Insufficient funds is reported correctly. Note that `/bolts/i` picks the shortest name ('blunt bolts', 90c), as documented.
- **trainSpec:** Slash 1→2 at Master Graent (L3), and Slash 2→3 at Captain Rion after promotion.
- **Promotion:** Fighter→Armsman at L5 via Master Visur → Camelot → `navigateDialog` with the 'join…' then 'slashing' keywords.
- **Styles live:** `killNpc` with styles Ruby Slash showed 'perform perfectly'. `useStyle` refuses when fatigued.
- **Dialog:** `talkTo` and `navigateDialog` on Master Graent (practice weapon) worked. `respondToDialog(false)` declined a group invite. `acceptGroupInvite` worked in duo.
- **Abilities and items:** Sprint on and off, drop, loot.
- **Zone crossing inside a region:** Camelot Hills → Salisbury Plains.
- **castSpell:** works when the target is fresh.
- **Viewer:** `/viewer` and `/viewer/fe2e1` in the built-in browser rendered the map, panel, inventory and messages with no console errors. curl on /bots, /zones/1, /zones/100, /state, /status, /chat and the assets returned 200, and names are HTML-escaped.
- **MCP over stdio:** I spawned `bun run mcp/server.ts` from my own driver and ran initialize, tools/list, `execute_code` code (auto-spawned the client), `execute_code` script with `args`, an exception, a timeout (the timed-out code stops acting: only ticks 0–2 were said), list_bots and disconnect_bot (clean quit, killed: false, including the 60 s quit after combat).
- **Swarm:** `bun client/swarm.ts fe2e4 fe2e6 fe2e7 fe2e8 fe2e9` ran for about 2.5 min. During it, swarm-check `--walk` ran 110 s with 0 not-in-game samples, 0 teleports and 0 corrections, and a template run on a swarm bot worked concurrently. All bots quit with exit 0 and the swarm process ended.

**Other observations, not filed as findings**
- After MCP timed out an `await Bun.sleep(90000)`, the timer kept the MCP server alive for about 30 s after stdin closed.
- `killNpc` stylesUsed counts queued styles, not performed ones.

**Cleanup:**
- All runners (fe2e1/2/3/4/5/6/8) and swarm bots were quit through `bun client/dev/swarm-check.ts ... --seconds=0 --quit` or MCP disconnect_bot. Every log shows 'exit 0: quit'.
- I stopped my gateway (curl to :7780 now fails) and closed my browser tab. No bun processes I started remain.
- Nothing was committed. No repo files were edited, apart from create-bot output (bots/fe2e*/) and bots/fe2e7/client.log, which the MCP-spawned runner writes.
- Scratch scripts and logs are in C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/final/e2e/ (scripts/, *.log).

**Not covered:** a quest-offer dialog box, and a real jump through a zone point (it can't be done without a 0x90 sender).

## protocol
This was a read-only review of client/** against server/core (PacketLib1127 and its base classes, the client handlers, PlayerPositionUpdateHandler and PlayerMovementMonitor). I did not edit any repo files and did not start any processes, bots or gateways. My only artifact is the scratch repro C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/final/client-protocol/stats.ts, which runs the real decoder and model offline. I also ran one read-only DB query: no mob or worldobject rows have z < 0, so the unsigned u16 z in 0xDA/0xA1/0x04 is safe.

Checked field by field and found correct (no finding):
- **Framing:** framing.ts.
- **Objects:** 0xDA NPCCreate (1124:121-279, flags, flags2, flags3); 0xA1 ObjectUpdate (168:724-862), including the 9th zone-skin bit for current and target zones, the speed/zSpeed bits and the masked heading; 0xA2 type semantics; 0xE1; 0xD9 (176:73-149: flag bits, door kind 4); 0x4B (1124:333-439, 7 face bytes + 3); relayed 0xA9 for 1.127 (CreateOutPak1127, including the trailing u16); relayed 0xBA (CreateOutPak1127, stateFlags << 2); 0xEE.
- **Self state:** 0xAD (190:53-75); 0x91 (190:33-50, u64 LE); 0xFA; 0xB6; 0xBD; 0x20 (1124:441-487); 0x04 (168:519-541); 0xB7 (174:385-406).
- **Inventory:** 0x02 (189:129-200, 6-byte header, u8 client slot). WriteItemData 1124:836-990 is 24 bytes empty, with optional spell blocks.
- **Skills and spells:** 0x16 sub 01 (1112:21-180; the header count byte is patched at offset 1 and subtype 99 at offset 2); sub 02 lines and footer (1112:189-260); sub 03 (179:23-90); sub 06 (1125:387-411).
- **Group:** 0x70 records 0x20|idx and 0x80|idx (1125:418-480; GroupIndex is 0-based, Group.cs:360-371).
- **Windows:** 0x17 merchant (1125:607-725); 0x7B trainer (1105:29-60; nextLevel = level+1, which equals the cost); 0x81 dialog; 0xC4 text window; 0xAF message (1127:39-58).
- **Combat and effects:** 0xBC (186:54-100); 0x72 (100 ms units, SpellHandler.cs:1074); 0x1B; 0x73; 0xAE; 0x89; 0x74; 0xF6; 0xEC; 0xD6 (168:2664-2760: skill index minus specCount, line/spell index); 0x7F (1110:51-140; a removed slot is index + 10 zero bytes, and index shifting is handled correctly by the index-keyed map); 0x75 (191:83-125).
- **Login:** 0x28 is u16 LE; 0xCC; the overview realm lock (CharacterOverviewRequestHandler 1124 path).
- **Encoders:** all checked against their handlers: 0xA9 (40 bytes; state/action flags; on-ground bit 0x8000 gives zero fall damage with zSpeed 0), 0xBB/0x7D/0x71 prefix and flags (0x2000 & 0xA000), 0xB0 0x6000, 0xD0 LoS reply (key = source/target pair, 0x100 = clear), 0xD5/0xBE LE, 0xDD, 0x80, 0x78/0x79 (page*30+slot, menu id), 0x53 (264 bytes, val>1, RA at +64), 0x82, 0xAF ReadString(255), 0xEC, 0xC7, 0x74, 0x7A, 0xB5, 0xA3, 0xD4 charIndex vs WorldInitRequestHandler realm offset.

Lifecycle:
- Region change: clearWorld matches the server's PlayerObjectCache.Clear in GameOpenRequestHandler.
- Link-death clocks: they are reset on the Playing transition (GameClient.cs:42-48), so the mover pause during a region change is safe.
- Speed monitor: the mover's dt-based steps stay under 1.15× MaxSpeed.
- Loot: the 30 s static-object re-send logic is correct.
- Culling: NPC_STALE 16 s vs the 5 s WORLD_NPC_UPDATE_INTERVAL and OBJECT_STALE 95 s vs 30 s are both fine.

**isSitting:** the 0xAD sync covers every Sit(false) path: OnPlayerMove, StartAttack and /stand. The remaining stale paths are in finding 3.

Not reported:
- **0xA1 for unknown objects:** 0xA1 updates for unknown oids are dropped and 0xBE is never sent. Its encoder exists but is unused, and docs/research recommends it. The only concrete trigger I found is a narrow one: extrapolation-based culling near the 6000-unit boundary, so I left it out as speculative.
- **Already-documented gaps:** idle players are never culled, and instance zone skins. I did not run live bots.

## sdk-semantics
Scope: I read every file under sdk/ in full: index.ts, actions.ts, actions-helpers.ts, runner.ts, cli.ts, chat.ts, chat-history.ts, formatter.ts, pathfinding.ts and execution-context.ts. To check semantics end to end I also read the client paths they depend on: client.ts executeInner, movement.ts, the world-model death, attack-mode and message code, and bridge.ts result ordering. I checked server ground truth in OpenDAoC for /train, /invite, say/send/group/whisper rate limits, sit messages, DoT messages, PlayerMoveItem paper-doll, SayTo chat types and Money.

Checks:
- `bun run docs:api:check` passes (48 BotActions methods, 99 BotSDK methods, 71 types).
- `bun test ./sdk` passes 128/128.
- The CLAUDE.md quick-reference signatures match the code. Its claim that walkToObject adopts the target's z is wrong (finding walktoobject-no-z-adopt-in-tolerance).

Repros: five findings were reproduced in a scratch FakeWorld test (a copy of the sdk/test/actions.test.ts harness) at C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/final/sdk-review/review.test.ts. They are: castSpell counting a DoT tick, useItem on an equipped item, walkToObject not adopting z, and attack mode left on after a killNpc timeout. The others come from code reading with server file:line citations.

Verified OK, not reported:
- walkTo region change and death: the client mover stops itself (session.ts:113, 425), and route returns region_changed or died.
- Waypoint bookkeeping is correct, because mover.state().waypoints includes the destination.
- Death detection through deathCount in killNpc, grind and walkTo.
- XP across level-ups: experience is the cumulative u64 from 0xBE/0x91.
- Abort propagation via withExecutionDeadline and executionContext.exit cleanup.

Known items I did not re-report: closeMerchant being client-only, damage-add procs (extended by the DoT/damage-shield finding), whisper spacing per BotActions instance (MCP keeps one instance per connection), isSitting stuck true, and walkToObject's timeout applying per attempt.

Compared with rs-sdk actions.ts, nothing critical is missing for DAoC. rs-sdk's door handling isn't needed here because the server doesn't check collisions. Feature gaps rather than defects: no vault deposit/withdraw (getVault exists, but has no helpers), no player-trade helpers, and no ranged or caster kill helper (known gap 1).

Not done: no live runs against the server. I started no processes, edited no repo files and committed nothing.

## gateway-mcp
Covered: gateway/gateway.ts in full; types.ts, state-fanout.ts; viewer/routes.ts, logic.ts, con.ts, index.html and bot.html; the connection, control and render paths of app.ts (all innerHTML sinks use esc(), and I found no XSS); mcp/server.ts, execute-code.ts, console-capture.ts and api/index.ts (BotManager). I also read the SDK and client code these depend on: sdk/index.ts connect, reconnect and handleMessage; client/bridge.ts message handling and queue; sdk/runner.ts settle logic. Compared against reference/rs-sdk: its gateway also binds 0.0.0.0 and allows everything in dev, but it has a login-server auth path that this port does not. Its execute-code BotExecutions is identical, but rs-sdk actions have no abort-time cleanup dispatches, so the supersede race is new to this port.

Live evidence: two scratch harnesses in C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/final/gateway-mcp-review/. repro.ts runs an in-process gateway on 127.0.0.1:0 with fake sockets; it does not touch the game server and logs in no bots. supersede.ts runs executeCode with a fake manager. Both scripts ran to completion and stopped their own gateway. I started no long-lived processes and edited no repo files.

Gotcha for anyone writing a harness on Windows: importing a repo module as 'C:/Users/...' creates a second module instance next to the backslash path that relative imports resolve to, so the AsyncLocalStorage execution context is not shared. Import via Bun.resolveSync instead.

Checked and not reported:
- Observe mode is correctly limited to say/send. Neither can inject commands, because the whole text is one &send/&say command.
- Malformed actions are rejected at the client (bridge.ts:249).
- sdk_connect on an already-registered socket is refused.
- An auth result that arrives after the socket closed is ignored.
- A pre-empted controller stops auto-reconnect and is reset by connect().
- lastState replay comes with stateReceivedAt, and the CLI/BotManager treat it as stale.
- Console capture is bounded, and nothing in sdk/client/mcp writes to stdout directly.
- MCP ReadResource path traversal is moot: the MCP caller already has execute_code.
- Brute-forcing /bots/<bot>/auth is not practical against the generated 12-character random passwords. The real issue is the missing auth, covered by the high-severity finding.

Not reported:
- The documented Windows handle-inheritance leak (detached children keep the MCP server's stdio pipes open). It is real, but I could not verify a clear fix. Spawning via ShellExecute (for example Start-Process) may avoid it; untested.
- Spawned clients and gateway outliving the MCP server process. This appears to be by design: characters persist and are reused by the next session.
- The execute_code timeout not covering the connect phase. Documented.

Not live-verified: the supersede race against a real client, where the timing between an attack(false) round trip and the next call's status fetch decides the order. The cross-origin result was shown with Bun's WebSocket and fetch sending an Origin header, not from a real browser. Private Network Access is irrelevant to the text/plain simple POST and is not enforced for WebSockets.

## docs-onboarding
What I covered:
- **Snippet typecheck:** typed every code snippet in CLAUDE.md, README.md and learnings/*.md (about 160 lines of API calls, option names and result fields) in a scratch file. It passes, and an injected bad method was caught, so the check is real.
- **Repo checks:** `bun run typecheck` is clean, `bun run docs:api:check` passes (48 BotActions / 99 BotSDK methods), and `bun run test` gives 347 pass / 0 fail.
- **Links and paths:** every relative markdown link and every repo file path named in the docs exists.
- **Documented defaults and reasons:** walk tolerance 64, stuckMs 8000, melee 90/118, chase 2500, kill timeout 60 s, loot settle 800, whisper 300 / 1.6 s, interact 4 s, cast range ×0.85, publish 250 ms, 100 messages / 500 chat history, lockout backoff 65 s, plus every documented `reason` string. All checked against sdk/actions.ts and the client.
- **C# citations:** spot-checked GamePlayer.cs:41/260, ClassValkyrie/Bainshee, GlobalConstants.cs:928-933, Point2D.GetHeading, SinglePermission (account name, command without the &), and the /serverproperties refresh, /jump, /plvl, /item, /player and /reload commands. All correct to within a line or two.
- **create-bot:** ran `--list`, `--help` and 13 class/realm/race variants with DAOC_BOTS_DIR pointing at scratch.
- **Other commands:** `bun run server:setup --dry-run` reports all 9 properties ok, and all documented setup-server flags exist. `cli.ts` usage works, `/status` answers, and the start locations in classes-and-races.md match the data.

Live checks (explorer.ts and duo.ts were never run in the acceptance pass). I made two fresh PrivLevel-1 Albion Fighters, qzrev1 and qzrev2, in scratch/bots, with runners started from the scratch cwd so nothing was written into the repo. Results:
- `explorer.ts qzrev1 300 4` passed.
- `duo.ts qzrev1 qzrev2 1` passed: grouped, shared kill with xp 10 + 10, split loot.
- `chat.ts --to` and the read path work. The [send] shows in default mode after a short delay.
- The documented `sdk.sendQuit()` snippet from death-and-rest.md quit both cleanly ("quit acknowledged (0xA4)", runner exit 0).

I started no gateway; I used the one already on :7780. No process I started is still running. I did not touch the other agents' fe2e*/mind processes.

Licensing: besides the two files the README names, mcp/console-capture.ts is a re-indented verbatim copy, and several other files are substantially copied (figures in the finding). None carries the MIT notice.

Not flagged as a bug: bots/ holds many leftover test bot folders (acpt1-3, run1-5, rrev1-3, ux*, uxmage*, uxr*). They are gitignored by `bots/*/`, but they are included in tsconfig's `bots/**/*.ts` typecheck.

Not covered: line-by-line accuracy of docs/research/*.md protocol notes against the C# source, and the historical build reports, which describe past states. Scratch files are in C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/final/docs-review/ (snippets.ts, tsconfig.json, starts.ts, combos.ts, bots/, qzrev*.log).

## tests-types
What I covered:
- **Test files.** I read every listed test file: sdk/test (actions, actions-helpers, sdk-unit, live-smoke, runner, api-docs, chat, formatter, the fixtures and fake-client), client (bridge, session, action-queue, movement, model, framing, outgoing, incoming), gateway, gateway/viewer, the mcp tests (server, execute-code, bot-manager), data, and bots/create-bot.
- **Scan for empty tests.** A scratch scanner (final/test-quality/scan.ts) found only one test with zero expects: gateway 'grace period force-closes'. It asserts implicitly via `until()` throwing and awaiting the close, so I did not report it.
- **Golden coverage.** All 34 outgoing encoders have byte-exact goldens. 12 incoming decoders have none; that is reported, after checking most of them against the C# writers.
- **Type safety.** Production code has almost no `as any`. The non-null assertions under noUncheckedIndexedAccess that I checked (actions.ts:1685, chat-history.ts:69, movement.ts:173/255, client.ts session!) are all guarded, so none were reported.
- **types.ts vs collectState.** I checked every PlayerState, NearbyNpc/Player/Object, Effect, ConcentrationEffect, Spell, Money and MovementState field against world-model.ts and session.ts writers. Real gaps found: trainer isOpen never resets, the 'blocked' stop reason is never produced, specName is always null, and the 'linkdead' phase is never set. The last two are documented in stage1-client.md, so I only mention them here.
- **The debuff bug.** I confirmed the StatsUpdate debuff wrap by running the real WorldModel in a scratch script (final/test-quality/stats-debuff.ts).

Flake runs:
- **Serial.** `bun run check` three times in a row: all exit 0, 347 pass / 0 fail, about 47 s each. No flakes.
- **Parallel stress.** 4 concurrent `bun test` runs: 2 of 4 failed in gateway/viewer/viewer.test.ts:188. The output is in the viewer finding; logs are in final/test-quality/stress3.log and stress4.log.

Side effect: the parallel stress run, through the viewer test's own utimesSync race, left gateway/viewer/logic.ts with a modified mtime of 2026-10-29 12:46:39.262, slightly in the future at the time I checked. File content is unchanged, and the original mtime is unknown, so I did not touch it.

Processes: I started no long-lived processes. All test runs exited. The fake runners spawned by bot-manager.test exited, since the list showed none from daoc-mgr dirs. The other bun processes still running (gateway, fe2e1-6, qzrev1/2, mcp/server.ts, mind/mcp.ts) were not started by me and were left alone. Nothing was committed and no repo files were edited.

Not covered:
- Live tests under sdk/test/live and client/dev; they are not part of the check, and I did not run them against the server.
- A per-field protocol audit of the decoders that already have tests, beyond spot checks (UseSpell, Buy, DialogResponse, UpdateIcons, DisableSkills, RemoveObject and NPC targetId all match the server).
- formatter.test.ts and data.test.ts were only skimmed.

Scratch files are in C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/final/test-quality/.

## Findings

- [high] (live-e2e->sdk) castSpell stops working after the caster dies: the client keeps a target the server has cleared, so 'You must select a target' repeats — sdk/actions.ts
- [medium] (live-e2e->docs-bots-data) Learnings say walking onto a zone point changes region; it does not, and the client cannot send the region-change request — learnings/regions-and-zones.md
- [medium] (live-e2e->docs-bots-data) Default Hibernia bot (Guardian) spawns with no armour and cannot kill a level-1 mob — bots/create-bot.ts
- [low] (live-e2e->docs-bots-data) Docs say training a weapon spec unlocks styles; base classes have none, so promotion is required (now verified live) — learnings/combat.md
- [low] (live-e2e->client) state.trainer.isOpen stays true forever after one trainSpec (even across region changes) — client/model/world-model.ts
- [low] (live-e2e->sdk) A script pre-empted by another controller fails with 'Bot client disconnected during script execution' — sdk/runner.ts
- [low] (live-e2e->sdk) grind/grinder.ts sits idle for the whole duration when nothing is in the con window, with no output and no distinct stopReason — sdk/actions.ts
- [low] (live-e2e->docs-bots-data) caster.ts claims 'nuke from range' but walks to the spawn point itself and engages at about 255u, so the L1 Mage dies — bots/examples/caster.ts
- [medium] (protocol->client) 0xFB StatsUpdate reads the buff/debuff column as unsigned, so any stat debuff turns PlayerState.stats into ~65 000 — client/protocol/incoming/player.ts
- [low] (protocol->client) A server-initiated 0xA4 (kick to the character screen) ends the session as a clean 'quit', so the runner exits 0 and the swarm never logs back in — client/session.ts
- [low] (protocol->client) isSitting and the 0xA9 SITTING flag stay true after a refused sit or a same-region server teleport, until the next 0xAD — client/client.ts
- [low] (protocol->client) Style.specName is always null even though the byte the server sends maps directly to a spec name — client/model/world-model.ts
- [low] (protocol->client) After more than 5 s with no 0xA9, the next UseSkill/UseSpell/UseSlot is misparsed by the server; the client neither detects this nor protects against it (phase 'linkdead' is never set) — client/client.ts
- [medium] (sdk-semantics->sdk) castSpell treats any DoT tick or damage-shield hit as the new cast completing, and adds that damage to its total — sdk/actions.ts
- [medium] (sdk-semantics->sdk) useItem on an equipped item reports success at once with no server evidence; backpack items and useAbility accept any message as proof — sdk/actions.ts
- [medium] (sdk-semantics->sdk) walkToObject never adopts the target's z when already within the 2D tolerance, so attack/interact/whisper fail with out_of_reach — sdk/actions.ts
- [medium] (sdk-semantics->sdk) After a timeout or cancel, killNpc/rest/walkTo clean up only if the last snapshot shows the bot attacking, sitting or moving, so attack mode can stay on — sdk/actions.ts
- [low] (sdk-semantics->sdk) bot.say() reports success when the server dropped the line for speaking too fast — sdk/actions.ts
- [low] (sdk-semantics->sdk) castSpell never checks for death, so a caster killed mid-cast gets 'timeout' or 'interrupted' instead of 'died' — sdk/actions.ts
- [low] (sdk-semantics->sdk) bot.face(number) faces a nearby object instead of turning to the heading when the number matches an object id — sdk/actions.ts
- [low] (sdk-semantics->sdk) SHOW_CHAT=false (create-bot --no-chat) also removes NPC trainer dialog and our own say echo from the messages bot.* relies on — sdk/index.ts
- [low] (sdk-semantics->client) totalCopper and formatMoney swap platinum and mithril, so purse totals and money deltas are wrong at 1000 gold and above — client/model/world-model.ts
- [high] (gateway-mcp->gateway-mcp) Unauthenticated gateway binds 0.0.0.0, sends CORS *, and never checks the WebSocket Origin, so any LAN host or any web page can control, read or kick bots — gateway/gateway.ts
- [medium] (gateway-mcp->gateway-mcp) A superseding execute_code starts before the superseded code's cleanup runs, so the old killNpc/walkTo stop lands after the new call's first action — mcp/execute-code.ts
- [medium] (gateway-mcp->gateway-mcp) Gateway tracks one currentActionId per bot, so on takeover only the last-dispatched action is failed and the rest hang until the SDK's 60 s actionTimeout — gateway/gateway.ts
- [low] (gateway-mcp->gateway-mcp) A client that registers during the 1 s takeover settle window is told 'Connected', then silently replaced, so two clients log into one account — gateway/gateway.ts
- [low] (gateway-mcp->gateway-mcp) Dead bot sessions and their chat histories are never removed (unbounded, and anyone can create them) — gateway/gateway.ts
- [low] (gateway-mcp->gateway-mcp) /status/:user, /status and /bots skip the auth hook that /state and /chat enforce, leaking player name and position — gateway/gateway.ts
- [high] (docs-onboarding->docs-bots-data) rs-sdk MIT notice is missing from every copied file, the repo has no LICENSE, and the README lists only 2 of the derived files — README.md
- [medium] (docs-onboarding->docs-bots-data) Quick start never says to fetch the git submodules, so on a plain clone server:up and all data/ helpers fail — README.md
- [medium] (docs-onboarding->docs-bots-data) Docs call SIGINT a clean way to stop a client, but on Windows a SIGINT sent from another process kills it outright (60 s lockout) — CLAUDE.md
- [low] (docs-onboarding->docs-bots-data) Following CLAUDE.md's 'copy from bots/examples/' silently breaks the examples' arguments — bots/examples/grinder.ts
- [low] (docs-onboarding->docs-bots-data) create-bot --list shows Inconnu Acolyte and Saracen Disciple, which create-bot then refuses — bots/create-bot.ts
- [low] (docs-onboarding->docs-bots-data) MCP `script:` mode rejects every script the docs tell you to write, and the docs never show the pattern that works — CLAUDE.md
- [low] (docs-onboarding->docs-bots-data) DESIGN.md's bot.env block and README's layout line misdescribe defaults, keys and what git ignores — docs/DESIGN.md
- [low] (docs-onboarding->docs-bots-data) No learnings topic for grouping or chat, which rs-sdk has — learnings/README.md
- [medium] (tests-types->gateway-mcp) Viewer bundle-cache test changes the mtime of a real repo file, so it fails when test runs overlap and can leave the file's mtime in the future — gateway/viewer/viewer.test.ts
- [medium] (tests-types->client) 0xFB StatsUpdate reads the buff/debuff block as unsigned, so any stat debuff shows as about 65,000 in PlayerState.stats — client/protocol/incoming/player.ts
- [medium] (tests-types->client) DaocClient.collectState and execute(), the boundary between server packets and sdk/types.ts, have no unit test; SDK tests use hand-written fixtures that differ from what the client produces — client/client.ts
- [low] (tests-types->client) TrainerState.isOpen becomes true on the first 0x7B and never goes back to false, so trainer detection in interactWith and trainSpec only works once per session — client/model/world-model.ts
- [low] (tests-types->client) 12 server-packet decoders have no golden or decoder test at all — client/protocol/incoming/combat.ts
- [low] (tests-types->sdk) MovementState.lastStopReason declares 'blocked', but the client never produces it — sdk/types.ts
- [low] (tests-types->gateway-mcp) Tests create temp directories and never remove them (109 daoc-mgr-*, 22 daoc-gw-*, 21 daoc-exec-* now in %TEMP%) — mcp/bot-manager.test.ts

## Confirmed

- [high] sdk: castSpell stops working after the caster dies: the client keeps a target the server has cleared, so 'You must select a target' repeats
- [medium] docs-bots-data: Learnings say walking onto a zone point changes region; it does not, and the client cannot send the region-change request
- [medium] docs-bots-data: Default Hibernia bot (Guardian) spawns with no armour and cannot kill a level-1 mob
- [low] docs-bots-data: Docs say training a weapon spec unlocks styles; base classes have none, so promotion is required (now verified live)
- [low] client: state.trainer.isOpen stays true forever after one trainSpec (even across region changes)
- [low] sdk: A script pre-empted by another controller fails with 'Bot client disconnected during script execution'
- [low] sdk: grind/grinder.ts sits idle for the whole duration when nothing is in the con window, with no output and no distinct stopReason
- [low] docs-bots-data: caster.ts claims 'nuke from range' but walks to the spawn point itself and engages at about 255u, so the L1 Mage dies
- [medium] client: 0xFB StatsUpdate reads the buff/debuff column as unsigned, so any stat debuff turns PlayerState.stats into ~65 000
- [low] client: A server-initiated 0xA4 (kick to the character screen) ends the session as a clean 'quit', so the runner exits 0 and the swarm never logs back in
- [low] client: isSitting and the 0xA9 SITTING flag stay true after a refused sit or a same-region server teleport, until the next 0xAD
- [low] client: Style.specName is always null even though the byte the server sends maps directly to a spec name
- [low] client: After more than 5 s with no 0xA9, the next UseSkill/UseSpell/UseSlot is misparsed by the server; the client neither detects this nor protects against it (phase 'linkdead' is never set)
- [medium] sdk: castSpell treats any DoT tick or damage-shield hit as the new cast completing, and adds that damage to its total
- [medium] sdk: useItem on an equipped item reports success at once with no server evidence; backpack items and useAbility accept any message as proof
- [medium] sdk: walkToObject never adopts the target's z when already within the 2D tolerance, so attack/interact/whisper fail with out_of_reach
- [medium] sdk: After a timeout or cancel, killNpc/rest/walkTo clean up only if the last snapshot shows the bot attacking, sitting or moving, so attack mode can stay on
- [low] sdk: bot.say() reports success when the server dropped the line for speaking too fast
- [low] sdk: castSpell never checks for death, so a caster killed mid-cast gets 'timeout' or 'interrupted' instead of 'died'
- [low] sdk: bot.face(number) faces a nearby object instead of turning to the heading when the number matches an object id
- [low] sdk: SHOW_CHAT=false (create-bot --no-chat) also removes NPC trainer dialog and our own say echo from the messages bot.* relies on
- [low] client: totalCopper and formatMoney swap platinum and mithril, so purse totals and money deltas are wrong at 1000 gold and above
- [high] gateway-mcp: Unauthenticated gateway binds 0.0.0.0, sends CORS *, and never checks the WebSocket Origin, so any LAN host or any web page can control, read or kick bots
- [medium] gateway-mcp: A superseding execute_code starts before the superseded code's cleanup runs, so the old killNpc/walkTo stop lands after the new call's first action
- [medium] gateway-mcp: Gateway tracks one currentActionId per bot, so on takeover only the last-dispatched action is failed and the rest hang until the SDK's 60 s actionTimeout
- [low] gateway-mcp: A client that registers during the 1 s takeover settle window is told 'Connected', then silently replaced, so two clients log into one account
- [low] gateway-mcp: Dead bot sessions and their chat histories are never removed (unbounded, and anyone can create them)
- [high] docs-bots-data: rs-sdk MIT notice is missing from every copied file, the repo has no LICENSE, and the README lists only 2 of the derived files
- [medium] docs-bots-data: Quick start never says to fetch the git submodules, so on a plain clone server:up and all data/ helpers fail
- [medium] docs-bots-data: Docs call SIGINT a clean way to stop a client, but on Windows a SIGINT sent from another process kills it outright (60 s lockout)
- [low] docs-bots-data: Following CLAUDE.md's 'copy from bots/examples/' silently breaks the examples' arguments
- [low] docs-bots-data: create-bot --list shows Inconnu Acolyte and Saracen Disciple, which create-bot then refuses
- [low] docs-bots-data: MCP `script:` mode rejects every script the docs tell you to write, and the docs never show the pattern that works
- [low] docs-bots-data: DESIGN.md's bot.env block and README's layout line misdescribe defaults, keys and what git ignores
- [low] docs-bots-data: No learnings topic for grouping or chat, which rs-sdk has
- [medium] gateway-mcp: Viewer bundle-cache test changes the mtime of a real repo file, so it fails when test runs overlap and can leave the file's mtime in the future
- [medium] client: 0xFB StatsUpdate reads the buff/debuff block as unsigned, so any stat debuff shows as about 65,000 in PlayerState.stats
- [low] client: TrainerState.isOpen becomes true on the first 0x7B and never goes back to false, so trainer detection in interactWith and trainSpec only works once per session
- [low] client: 12 server-packet decoders have no golden or decoder test at all
- [low] sdk: MovementState.lastStopReason declares 'blocked', but the client never produces it
- [low] gateway-mcp: Tests create temp directories and never remove them (109 daoc-mgr-*, 22 daoc-gw-*, 21 daoc-exec-* now in %TEMP%)

## Fixes

### client

# Client fixer report

All 10 findings are fixed. Findings 2 and 8 were the same bug, and so were 1 and 9. `bun test ./client` passes 159 tests with 0 failures, `bun test ./sdk` passes 147 with 0 failures, and `bun run typecheck` is clean. Nothing was committed.

## Per finding

**2 and 8: 0xFB stat buffs read as unsigned (fixed)**
- `client/protocol/buffer.ts`: added `PacketReader.i16()`.
- `client/protocol/incoming/player.ts`: `decodeStatsUpdate` now reads the buff block as signed, citing PacketLib175.cs:254-275. This covers both the stats variant and the resists variant (175:368-372). The base and item blocks stay unsigned.
- Tests:
  - an `i16` golden;
  - a 0xFB golden with buffs `[-10, 5, ..., -1]` and a resist buff of -20;
  - a WorldModel test: STR base 60 with buff -15 gives strength 45, where it used to give 65581.

**1 and 9: trainer window stays open forever (fixed)**
- New `TrainerState` contract in `client/model/world-model.ts`:
  - Each 0x7B sets `isOpen: true`, `trainerObjectId` (the current target) and `receivedAt`.
  - The window closes when:
    - the target moves off that trainer (new `WorldModel.setSelfTarget()`, used by our 0xB0 and the server's 0xF6);
    - we walk more than 512 units from where we stood when the window arrived (checked in `cull()`);
    - `clearWorld()` runs (region change).
  - Closing keeps `receivedAt`, so callers can compare it to spot a fresh window.
- Live testing showed the server has `allow_train_anywhere=True` (TrainCommandHandler.CanTrain, train.cs:141-152). A window can therefore open far from any trainer. That is why the walk-away check measures from where we stood, not from the trainer.
- `client/client.ts` `targetServer` now calls `model.setSelfTarget`.
- Tests: four model tests covering retarget, the server's ChangeTarget, region change, walk-away, and a window that arrives with no target.

**7: platinum and mithril swapped in money totals (fixed in the client)**
- `world-model.ts` now exports `COPPER_PER` and `totalCopper()`: platinum is 10^7 copper, mithril 10^10 (Money.cs:39-66).
- Test: 1 platinum is 10,000,000 copper and 2 mithril is 2×10^10.

**3: server kick ends the session as a clean quit (fixed)**
- `client/session.ts`:
  - New `SessionEndReason` `'kicked'`.
  - A private `quitRequested` flag is set in `quit()` just before `&quit`, and by a new `noteQuitRequested()`.
  - `finishQuit()` still sends 0xFC and waits for the character overview. It then ends with `'quit'` or `'kicked'`, and `'kicked'` sets `lastError`.
  - It logs the 0xA4 using `decodeQuit`.
- `client/client.ts`: a raw `command` action starting with `&quit` calls `noteQuitRequested()`.
- `bridge.ts` needed no change: `'kicked'` already falls through to the unexpected-end branch, which logs in again with `relogin` and otherwise exits with code 1.
- Tests: three session tests (unrequested 0xA4 gives `'kicked'`; after `quit()` gives `'quit'`; after a noted raw `&quit` gives `'quit'`) and one bridge test (a kick exits 1, or logs in again with `relogin`).

**4: sitting state stays stale (fixed)**
- `client/client.ts` `sit` action: sitting down no longer sets the flags straight away. They now come from the 0xAD the server always sends after a successful sit (GamePlayer.cs:8720-8721). Standing up still clears them at once. The result message is now `'sit requested'`.
- `client/movement.ts`: `snap()` clears `sitting` for the reasons `'teleported'` and `'regionChange'`, because MoveTo stands the player up (GamePlayer.cs:7900).
- `client/session.ts`: also clears `model.self.isSitting` on a non-heading 0x04, a playing-phase 0x20 and a region change.
- Tests: two in the new `client/client.test.ts` and one session test (a heading-only 0x04 keeps us sitting, a real one stands us up).
- Known remaining edge: two server 0x04 senders do not stand the player up. One is the IsDiving Z+1 nudge (GamePlayer.cs:8382), the other is the rider-resync path (PlayerPositionUpdateHandler.cs:48). After those, the next 0xAD corrects the state.

**5: `Style.specName` always null (fixed)**
- `world-model.ts`: added `SPEC_BY_INTERNAL_INDEX`, the reverse of GlobalConstants.cs:801-891, using the exact `Specs` strings (for example 'Polearm', 'Longbows', 'Two Handed'). Styles now get `specName` from `e.bonus`, or `null` when the byte is unknown.
- Test: bonus 0x01 gives 'Slash', 0x41 gives 'Two Handed', 0xEE gives null.

**6: UseSkill/UseSpell/UseSlot misread after a position gap (fixed, except the optional phase change)**
- `movement.ts`: added `msSinceLastSend()`.
- `client.ts`: `ensureFreshPosition()` runs before 0xBB, 0x7D and 0x71. If the last 0xA9 is more than 4 s old, it sends one first. If that cannot be sent (zone unknown), the action fails with `no_zone` rather than reaching the server as a misread packet.
- Tests: a stale gap gives `[0xA9, 0x71]`, a fresh one gives `[0x71]`, and no zone refuses UseSkill.
- I did not set phase `'linkdead'`. Changing the phase would make `inGame` false and affect the bridge's quit phases, so it is not a safe change on its own.

**10: 12 decoders without tests (fixed)**
- `client/protocol/incoming/incoming.test.ts`: added goldens built with PacketWriter, each citing its C# writer, for:
  - Realm and DupNameCheckReply;
  - Encumbrance, Quit and Time;
  - ObjectDelete and ObjectDataUpdate;
  - AttackMode, ChangeTarget and ChangeGroundTarget;
  - Interrupt;
  - SpellEffect, with and without the success byte.
- I kept `decodeRealm`. `decodeQuit` is now used by the session.

## Files changed
- `client/protocol/buffer.ts`
- `client/protocol/incoming/player.ts`
- `client/model/world-model.ts`
- `client/client.ts`
- `client/movement.ts`
- `client/session.ts`
- Tests: `client/model/model.test.ts`, `client/protocol/incoming/incoming.test.ts`, `client/session.test.ts`, `client/bridge.test.ts`, and the new `client/client.test.ts`.
- `sdk/types.ts` (additive only): `TrainerState` gained optional `trainerObjectId?: number | null` and `receivedAt?: number`, and the `isOpen` doc comment now describes the new lifetime.

## Live verification
I used a fresh account fxcl1 (character Fxclb, PrivLevel 1) and a gateway on port 7801.
- **Sit:** right after the sit request `isSitting` was false. It became true after "You sit down." and the 0xAD, and was false after standing.
- **Trainer:** I traced state changes in order:
  1. Interacting with Master Graent opened the window with `trainerObjectId` 14291.
  2. `openTrainer` refreshed `receivedAt`.
  3. Clearing the target closed it.
  4. Targeting the trainer again and opening reopened it.
  5. Walking 700 units away closed it, with the target still on the trainer.
- **Quit:** a requested quit gave `quit acknowledged (0xA4)` and `exit 0: quit`, three times.
- **Not tested live:** the server kick (the idle kick is off on this server) and the 4 s position gap.

The bot was stopped with `sendQuit` (`exit 0: quit`), and the 7801 gateway is stopped and confirmed down. `bots/fxcl1/` (bot.env set to gateway 7801, script.ts, lab_log.md) is still there.

## For the sdk fixer
- `sdk/actions.ts` `interactWith` (~line 546) and `trainSpec` (~line 1399): take `trainer.receivedAt` before sending and wait for a newer value, rather than relying on `isOpen`. Retargeting now closes the window, but re-targeting the same trainer keeps it open, so `trainSpec` can still resolve at once from the old window.
- `sdk/formatter.ts:24`: the money units should be `[['m', 10_000_000_000], ['p', 10_000_000], ['g', 10_000], ['s', 100], ['c', 1]]`.
- `rest()`: the comment "client marks us sitting as soon as it sends the request" is no longer true. `isSitting` now only becomes true after the server confirms with 0xAD, so the fallback path is still correct. The mock at `actions.test.ts:665` could match the new behaviour.
- `sdk/API.md` / the docs generator: describe `'kicked'`, the optional `TrainerState.trainerObjectId` and `receivedAt`, and the new `isOpen` lifetime.

## Left for the docs area
`docs/build-reports/stage1-client.md:58` and `:119` still list `Style.specName` as always null. That file is outside `client/`, so I did not edit it.

### sdk

# sdk fixer report

I fixed all 12 findings in `sdk/**`; none turned out to be wrong. `bun test ./sdk` passes (147 tests, 0 failing), and `bun run typecheck` and `bun run docs:api:check` both pass. I committed nothing to git.

## Per finding

| # | Status | What changed |
|---|---|---|
| 1 castSpell after death (stale target) | Fixed in sdk. One part is left for the client area. | **`sdk/actions.ts` castSpell:** it now always sends the target before casting: the explicit target, the current target, or ourselves for friendly spells. The old check that skipped the send when the model already showed the target is gone (cites GamePlayer.cs:5743/:5900, GameLiving.cs:2842). On `no_target` it selects the target again and retries once. The cast observation moved into a new private method, `observeCast()`. **Fight loop (old :834):** it selects the target at least once per fight (`targeted` flag), even when the model already shows it. |
| 2 pre-emption reported as a client disconnect | Fixed | **`sdk/index.ts`:** stores `preemptedReason` when the gateway sends "another controller connected", and adds `wasPreempted()` and `getPreemptedReason()`. The flag is reset by `connect()`. **`sdk/runner.ts`:** new `BotPreemptedError extends BotDisconnectedError` ("Pre-empted by another controller (newest control connection wins); the game client is still running"). It logs "[Runner] Another controller took over" and aborts at once in both `'error'` and `'wait'` modes. |
| 3 grind idles silently with nothing to fight | Fixed in sdk | **`grind()`:** new option `noTargetTimeoutMs` (default 60 s; 0 or Infinity turns it off). Time spent idle near the anchor with no candidate is counted, and resting resets the count. When it runs out, grind returns `stopReason`/`reason` `'no_targets'` with a message naming the con window and level. `'no_targets'` is added to the `GrindResult.stopReason` union. |
| 4 DoT tick or damage-shield hit counted as cast completion | Fixed | **Strong evidence:** "You cast a \<this spell\>" (SpellHandler.cs:1337). **Weak evidence** counts only after the cast lands (castStart + the cast animation's castTimeMs − 250 ms; without the animation, the DB cast time × 0.6). Weak evidence is a spellEffect event, a resist, or a hit: "Your X hits" only when X is this spell, or a bare "You hit". "Extra damage" and "additional" lines are skipped. After weak evidence, interrupts are checked again. The damage sum uses the same rules. The InterruptSpellCast event also counts as an interrupt. |
| 5 useItem / useAbility accept anything as proof | Fixed | **useItem:** resolves equipment slots 10-37, names and stale item objects through a new `resolveUsableItem`. It looks the slot up in `state.equipment` for equipped items. Evidence must be one of: a message containing the item name, a refusal from the new `USE_ITEM_REFUSALS` (`sdk/actions-helpers.ts`, server texts with GameObject.txt and GamePlayer.cs citations, plus CAST_REFUSALS), a change to the slot, or an effect change. It then keeps listening for 400 ms before checking refusals. **useSkillObserved with no confirm patterns** (useAbility): needs a message naming the ability or a non-combat message type, or an effect change, and checks refusals again after 300 ms. |
| 6 walkToObject never adopts the target's z | Fixed | When the bot is within the 2D tolerance but out of range in 3D, walkToObject sends `moveTo(obj.x, obj.y, obj.z)` itself and waits for the z to update. `route()` is unchanged. |
| 7 cleanup depends on the last snapshot | Fixed | **killNpc:** `fight()` sets local flags (attack sent, move sent) before each send, and the `finally` sends attack-off and stop from those flags. **rest:** the stand-up runs if any sit was dispatched (`sits` moved out of the closure). **route:** stop is sent unconditionally on cancel and on timeout. **follow:** stop is sent if a move was ever dispatched. |
| 8 bot.say reports success when the server dropped the line | Fixed | `lastSayAt` plus `SAY_SPACING_MS = 600` between calls. It watches for "Slow down! Think before…": a single-line say is retried once, then fails with `rate_limited`. A multi-chunk say fails at once so already-sent chunks are not repeated. |
| 9 death mid-cast not reported as died | Fixed | Both cast waits, and the check after them, compare `isDead`/`deathCount` and return reason `died` with no `retryAfterMs`. `castFailureReason` maps "You are dead…" to `died`. The check before casting still returns `dead`; the docstring documents both reasons. |
| 10 face(number) can face an object | Fixed | A bare number is always a heading. Objects are passed as an object, a name pattern, or `{ objectId }`. The signature is `Exclude<ObjectTarget, number> \| Point \| number \| { objectId: number }`. No caller in the repo passed an object id as a number. |
| 11 SHOW_CHAT=false drops NPC dialog and our own echoes | Fixed | New `isOtherPlayersChat()` in `sdk/chat-history.ts` (exported). It hides only other players' chat. It keeps our own echoes, popup text, and speech from nearby NPCs (CT_Say, GameNPC.cs:2607-2608). The `showChat` field is now documented in `sdk/types.ts`. |
| 12 'blocked' stop reason is never produced | Fixed | Removed `'blocked'` from `MovementState.lastStopReason`. |

`sdk/API.md` is regenerated with `bun run docs:api`.

## Tests added
- **`sdk/test/actions.test.ts`:**
  - Stale model target.
  - Retry once on `no_target`.
  - A foreign DoT tick and a damage-shield hit mid-cast, then an interrupt, gives `interrupted` with 0 damage. A cast that lands counts only its own damage.
  - Death mid-cast gives `died`.
  - walkToObject adopts z (the finding's own repro).
  - A walk timeout sends stop when no snapshot shows the move yet.
  - killNpc timeout before the AttackMode echo gives `[true, false]` and attack ends up off.
  - The fight selects a stale target once.
  - Equipped useItem the server ignores gives `no_response`. Combat spam is not evidence. `useItem(10)` resolves the equipped item, and a refusal that trails the attempt wins.
  - Backpack useItem: combat lines are not evidence, a stack change is.
  - useAbility: combat spam gives `no_response`, and a trailing refusal wins.
  - Back-to-back says both get through, and a slow-down gives `rate_limited`.
  - `face(1024)` with an NPC whose objectId is 1024 still turns to the heading.
  - grind returns `no_targets`.
  - I updated the existing useItem test to use the real server text "You attempt to use X.".
- **`sdk/test/sdk-unit.test.ts`:** showChat keeps NPC, own and popup lines and drops other players' lines (I updated the existing expectation to match). A takeover message sets the pre-emption flag.
- **`sdk/test/runner.test.ts`:** pre-emption gives `BotPreemptedError` quickly in both `'error'` and `'wait'` modes, and a real loss is still a plain `BotDisconnectedError`.

## Live verification
I used a fresh Albion Mage, fxsd1 (character Fxsdb), with a gateway on 7802.
- **Two back-to-back `bot.say`:** both were echoed.
- **`face(1024)`:** "Facing 1024".
- **castSpell on a puny skeleton:** "Cast Minor Vitality Drain … for 2 damage" with castTimeMs 2400. The next cast was correctly reported `interrupted` by a melee hit.
- **Finding 1, live:** the Mage died and released. The model target was still the skeleton (23143) at 3908u. castSpell on it succeeded on the first try ("… for 7 damage"). Before the fix this was a `no_target` loop.
- **Finding 2, live:** I started a 30 s script, then a second script on the same bot. The first printed "[Runner] Another controller took over - aborting script" and `BotPreemptedError`.
- **Cleanup:** I quit fxsd1 with `sdk.sendQuit()` (the client logged "exit 0: quit") and then stopped the 7802 gateway. Nothing I started is still running.

## Left for other areas
- **client/ (finding 1, root cause):** in `client/model/world-model.ts` `markSelfDead()`, set `this.self.targetObjectId = null`, to mirror GamePlayer.cs:5743/5900. The sdk no longer depends on this.
- **bots/examples/caster.ts:** add `'no_target'` to the break list (around line 77). Consider also breaking on the new `'died'` reason.
- **bots/examples/grinder.ts:** print `result.reason` and `message` as well as `stopReason`. Optionally, when grind returns `no_targets`, move to the nearest con-appropriate spawn from `findNpcSpawns`.
- **Docs (not mine):**
  - CLAUDE.md Troubleshooting: add `BotPreemptedError` (another controller took over; the client is fine).
  - `learnings/combat.md`: grind `no_targets` / `noTargetTimeoutMs`; castSpell now reselects the target, and its reasons `died` vs `dead`; `face()` treats a number as a heading only.
  - `bots/create-bot.ts:53`: the `--no-chat` help text ("hide other players' chat") is now accurate.
- **Unrelated failures:** 7 tests in `bots/` fail on scriptArgs import paths in `bots/examples/*` and `bots/_template`. That is the bots area's in-progress work and does not involve sdk code.
- **Outside edit:** someone else added a GPL attribution header line to `sdk/actions-helpers.ts` while I worked. I left it in place.

Main files changed: `C:/Users/joshu/Code/daoc-sdk/sdk/actions.ts`, `sdk/actions-helpers.ts`, `sdk/index.ts`, `sdk/runner.ts`, `sdk/chat-history.ts`, `sdk/types.ts`, `sdk/API.md`, `sdk/test/actions.test.ts`, `sdk/test/sdk-unit.test.ts`, `sdk/test/runner.test.ts`. A copy of `sdk/` from before my edits is at `C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/sdk-orig` if you want to diff.

### gateway-mcp

## gateway-mcp fixer report

All 7 findings are fixed; none were skipped. `bun test ./gateway ./mcp` passes 67/67, `bun run typecheck` is clean, and three viewer test runs in parallel all passed with `logic.ts`'s mtime unchanged. Nothing was committed.

### 1. [high] Gateway exposure: fixed
- **New file `gateway/security.ts`:**
  - `checkRequestSource` refuses any request with a foreign `Origin` header. Allowed origins are http(s) on a loopback host (any port) or the gateway's own origin. On a loopback bind it also refuses a non-loopback `Host`, which blocks DNS rebinding.
  - `corsHeadersFor` echoes `Access-Control-Allow-Origin` only to allowed origins and adds `Vary: Origin`.
  - `isJsonRequest` checks for a JSON body.
  - `findBotPassword` looks up `bots/<name>/bot.env`, or any `bot.env` whose `BOT_USERNAME` matches.
  - `botEnvAuth` compares passwords in constant time and refuses unknown usernames.
  - `resolveAuthMode` picks the auth mode.
- **`gateway/gateway.ts`:**
  - The default hostname is now `127.0.0.1`; `GATEWAY_HOSTNAME` opts in to other addresses.
  - The source check runs first in `fetch()`, before `srv.upgrade` and every route.
  - The wildcard `corsHeaders` are gone; CORS is added per request.
  - `/say` and `/dm` return 415 unless the body is `application/json`.
  - The CLI entrypoint installs `botEnvAuth` when `GATEWAY_AUTH=botenv`. That is also the default when `GATEWAY_HOSTNAME` is not loopback; `GATEWAY_AUTH=none` turns it off. The startup log states the mode.
- **`gateway/viewer/routes.ts`:** the `ACAO *` is removed, `POST /bots/<bot>/auth` requires JSON, and its private `bot.env` reader is replaced by `findBotPassword`.
- **Decision for you:** on the default loopback bind there is still no password check unless `GATEWAY_AUTH=botenv` is set. With the Origin and Host checks in place, only local processes can reach it, and they can read `bot.env` anyway. Under botenv, the viewer's observe socket needs the password typed in. Turning botenv on by default would also break any client that has no `bot.env`.
- **Tests (`gateway/gateway.test.ts`, "gateway exposure"):** default bind, foreign-Origin WebSocket refused while a localhost one is allowed, text/plain and cross-origin POSTs never reach the bot, CORS only for loopback origins, a foreign Host gets 403, the origin rules, `botEnvAuth`/`resolveAuthMode`, and an impostor `connected` cannot kick the real client.

### 2. [medium] Superseded `execute_code` cleanup: fixed
- **`mcp/execute-code.ts`:** keeps the raw `work()` promise. After any abort (superseded, timeout or cancel) it waits for that promise, capped at `EXECUTION_SETTLE_MS = 2000` as in `sdk/runner.ts`, before building the result and world summary. The task promise that `BotExecutions.run` waits on as `previous.done` therefore includes the old run's cleanup. A new optional `ExecuteOptions.settleMs` exists for tests.
- **Side effect:** a stopped call whose code keeps calling `bot`/`sdk` now returns up to 2 s later.
- **Tests:** a superseded run's 200 ms finally-stop lands before the next call's first action; the wait is capped when stopped code never settles.

### 3. [medium] One in-flight slot per bot: fixed
- `currentActionId` is replaced by `BotSession.inFlight: Map<actionId, {sdk, sessionId} | {http}>`, filled by `sdk_action` and by HTTP chat dispatch.
- A result removes only its own id. A result with no id is matched only when exactly one action is outstanding.
- Results and lost-action errors go to the session that sent the action, or to every SDK on the bot if that session is gone.
- When the bot socket closes, `failInFlight` fails every remaining entry before the takeover early-return.
- HTTP chat sent to a dead session now fails at once.
- **Tests:** two actions are both failed on takeover; an observer's answered action does not hide the controller's pending one, and each result reaches only its sender.

### 4. [low] Takeover settle window: fixed
- The waiting client stays in `pendingTakeovers` with `settling: true` during the pause. A `connected` that arrives then takes its place.
- The settle timer registers whichever client holds the slot when it fires.
- A superseded waiting client now gets `save_and_disconnect` before the close, so it exits instead of reconnecting.
- If the settling client's socket closes during the pause, SDKs are sent `Bot disconnected`.
- **Test:** A, then B, then A closes, then C connects within the window. B is told to quit and closed and never gets `status`; C registers after the pause and its state frames are accepted.

### 5. [low] Dead sessions never removed: fixed
- Sessions record `disconnectedAt`. A sweep (`setInterval`, unref'd, cleared in `stop()`) deletes the session and its chat history once it has no client, no takeover in progress and no SDK attached, and has been dead longer than `deadSessionRetentionMs` (default 30 min).
- A `maxBotSessions` cap (default 500) evicts the longest-dead idle sessions first.
- In-flight entries older than 10 min are also dropped.
- **Tests:** retention (including that an SDK-watched session is kept) and the cap.

### 6. [medium] Viewer test changed a repo file's mtime: fixed
- `buildAppBundle(dir = DIR)` caches per directory. The cache key is now every module's name, size and mtime, so one future-dated file can no longer hide edits to the others.
- The test copies the viewer modules into a temp dir, changes mtimes only on the copies, and removes the dir. It now also checks that a future-dated `logic.ts` doesn't hide a later `app.ts` edit. No repo file is touched.

### 7. [low] Leaked temp dirs: fixed
- **`mcp/bot-manager.test.ts`:** a `tempDir()` helper records every root (`daoc-mgr-*`, `daoc-gw-*`). `afterAll` waits up to 5 s for the spawned processes to exit, then removes them.
- **`mcp/execute-code.test.ts`:** removes its `daoc-exec-*` dir in `afterAll`.
- An mcp test run no longer adds dirs: %TEMP% held 192 before and 192 after. I did not delete those 192 leftovers from earlier runs.

### Live verification
- I created fresh bot `fxga1` (`--gateway=ws://localhost:7803`) and ran `bun gateway/gateway.ts` with `AGENT_PORT=7803 GATEWAY_AUTH=botenv`. Netstat showed it listening on 127.0.0.1 only.
- `curl` with a foreign Origin got 403. With `Origin: http://localhost:5173` it got 200 and that origin echoed back. A rebinding Host got 403, and an unauthenticated `/state` got 401.
- The real runner authenticated with its `bot.env` password and reached `in game`. `sdk/cli.ts` showed state and `sdk/chat.ts` sent a say.
- An impostor `connected` and an SDK with a wrong password were both refused, and the real client stayed connected. A foreign-Origin WebSocket was refused.
- Shutdown: the bot quit through `sdk.sendQuit()` (runner exit 0, `quit acknowledged (0xA4)`), then I stopped the 7803 gateway. I started nothing else; port 7803 is free.

### Left for other areas
- **Docs (README, DESIGN, CLAUDE.md):** they need to cover `GATEWAY_HOSTNAME` (default 127.0.0.1, `0.0.0.0` exposes it to the LAN) and `GATEWAY_AUTH=botenv|none` (botenv is the default when not on loopback). They should also say that foreign browser Origins are refused, that `/say`, `/dm` and `/bots/<bot>/auth` need `Content-Type: application/json`, and that under botenv the viewer needs the password even to observe. I own only gateway and mcp, so I did not edit them.
- **Unrelated failures in `bun test ./sdk ./client ./bots`:** these appear to come from other fixers' work in progress — `bots/examples/script-args.test.ts` expects `export default main;`, `sdk/test/api-docs.test.ts` finds `API.md` out of date, an sdk-unit showChat/chat-history test, and an actions `useItem` test. None involves the gateway.
- **Optional, SDK area:** BotSDK could also fail its pending actions when a fresh `sdk_connected` arrives after a takeover. The gateway now covers this case itself.

Files changed:
- C:/Users/joshu/Code/daoc-sdk/gateway/security.ts (new)
- C:/Users/joshu/Code/daoc-sdk/gateway/gateway.ts
- C:/Users/joshu/Code/daoc-sdk/gateway/gateway.test.ts
- C:/Users/joshu/Code/daoc-sdk/gateway/viewer/routes.ts
- C:/Users/joshu/Code/daoc-sdk/gateway/viewer/viewer.test.ts
- C:/Users/joshu/Code/daoc-sdk/mcp/execute-code.ts
- C:/Users/joshu/Code/daoc-sdk/mcp/execute-code.test.ts
- C:/Users/joshu/Code/daoc-sdk/mcp/bot-manager.test.ts
- C:/Users/joshu/Code/daoc-sdk/bots/fxga1/ (created by `create-bot` for the live check)

### docs-bots-data

# Fixer report: docs-bots-data

All 12 findings are handled. Nine are fully fixed. Findings 1, 7 and 10 also need a small change in another area, listed at the end. Nothing was committed to git.

Checks:
- `bun test ./data ./scripts ./bots`: 65 pass, 0 fail.
- The full `bun run test`: 438 pass, 0 fail.
- `bun run typecheck`: clean.
- `bun run docs:api:check`: API.md is still current.

## Per finding

**1. Zone points don't fire by walking (medium): docs fixed, SDK part left open**
- `learnings/regions-and-zones.md` rewritten. A zone point is used only when the client sends 0x90 with its id (RegionChangeRequestHandler.cs:11, :23 u16 LE for 1126+, IPacketLib.cs:148). Realm filter for PrivLevel 1 at :33-37. Position updates never trigger it, the SDK can't send 0x90 yet, so change regions with teleporters.
- The reported live repro (zone point 111, stayed in region 1) and the working zone-boundary walk inside region 1 are recorded.
- Added a CLAUDE.md troubleshooting bullet.
- I did not repeat the zone-walk repro myself.

**2. Hibernia default Guardian starts unarmoured (medium): fixed**
- **Root cause in data:** new `starterequipment.json` builder (`buildStarterEquipment`, `splitClassList`, mirrors Util.cs:86) in `data/build.ts`. New helpers in `data/index.ts`:
  - `getStarterEquipment(cls)` follows StartupEquipment.cs:125-128, including class-0 rows only for classes that have rows of their own.
  - `getStarterArmour(cls)` returns the armour the server will actually give, plus the missing template ids.
- **Default changed:** `bots/create-bot.ts` now defaults Hibernia to **Naturalist**/Celt. It has club, shield and full brea armour; its rows are `53;48;47;46`, since eCharacterClass has Naturalist=53 and Stalker=54.
- **Warnings:** create-bot prints a warning, and `--list` marks `[no starter armour]`, for Guardian, Blademaster, Hero and Champion.
- **Docs:** `learnings/classes-and-races.md` updates the defaults, documents the Guardian gap (rows 13, 14, 76, 77, 78, 109) with an opt-in SQL fix, corrects the "all melee start armoured" line, and adds a Naturalist start row. CLAUDE.md, DESIGN.md and the usage text are updated too.
- **Live (fxdo1/fxdo3, gateway 7804):**
  - The Naturalist starts with slots 10, 11, 21-28. It killed 3 badger cubs (+17, +35, +35 XP, level 1 to 2), taking 1-4 per hit.
  - A fresh Blademaster becomes a Guardian *before* the gear is handed out, so it gets slots 10, 11, 40 only. An L1 badger cub hit it for 10-11 and killed it.
  - Caveat: the Naturalist did lose once, to an L1 large frog (the frog was at 16 %).

**3. Styles need promotion (low): fixed**
- `learnings/combat.md` rewritten: style rows are keyed by class (SkillBase.cs:600-625, Specialization.cs:374-381). `getStylesFor` returns 0 for Fighter (14), Viking (35), Guardian (52) and Naturalist (53), and 84 for Armsman (2).
- New `## Promotion` section in `learnings/npc-dialog.md` with the verified Fighter to Armsman path (GameTrainer.cs:300-318, ArmsmanTrainer.cs:96-125). It notes that the base trainer stops at level 5 (FighterTrainer.cs:63-65).
- `classes-and-races.md` no longer calls promotion unverified, and the README topic table is updated.

**4. caster.ts walks into the camp (low): fixed, verified live**
- `bots/examples/caster.ts` now stops 0.85 × spell range short of the spawn, on the line towards it, and searches with radius ≥ range.
- Live on fresh Mage fxdo2: target at 1412 units, 4 casts for 10 damage before the skeleton arrived, then a melee kill (+35 XP).
- `learnings/spells.md` updated with the old and new results.

**5. Licence notices (high, fair to call it medium): fixed**
- Added `LICENSES/rs-sdk-MIT.txt` (full MIT text, "Copyright (c) 2025 Lost City") and `LICENSES/OpenDAoC-GPL-3.0.txt` (copied from server/core/LICENSE).
- One-line, comment-only headers at the top of each file (after the shebang where there is one):
  - copied: `sdk/execution-context.ts`, `sdk/redact.ts`, `mcp/console-capture.ts`
  - adapted: `sdk/{index,runner,cli,chat,chat-history,formatter,generate-api-docs}.ts`, `sdk/test/{api-docs,sdk-unit}.test.ts`, `mcp/{server,execute-code}.ts`, `mcp/api/index.ts`, `gateway/gateway{,.test}.ts`, `client/action-queue{,.test}.ts`
  - GPL notice: `sdk/actions-helpers.ts` (for the ConLevelGrid port)
- My own overlap scan found 6 more derived files than the finding listed, and those are covered too. `action-queue.test.ts` was nearly verbatim (50 of 53 lines).
- The README credits and License section now name Lost City and list every derived file.
- As the fix hint suggested, I did not add a root LICENSE or a package.json `license` field; that stays with the maintainer.
- Regression test: `scripts/license-notices.test.ts` checks both licence texts, and that every file the README lists carries the notice.

**6. Submodules missing from setup (medium): fixed**
- `git submodule update --init server/core server/db` (or `--recurse-submodules`) is now the first step in the README Quick start, the docs/SERVER.md Quick start, and CLAUDE.md step 1.
- New `scripts/check-submodules.ts` (with a test). `server:up` in package.json now runs it first and fails fast when either directory is empty.

**7. SIGINT is not a clean stop on Windows (medium): docs fixed, client headers left open**
- Corrected CLAUDE.md, learnings/README.md rule 9 and learnings/death-and-rest.md:
  - Ctrl+C is clean only when typed in the client's own console. A SIGINT/SIGTERM sent by `process.kill`, `child.kill`, `Stop-Process` or `taskkill` kills it abruptly.
  - The quit paths are `sdk.sendQuit()`, `disconnect_bot` and `bun client/dev/swarm-check.ts <bots> --seconds=0 --quit`. The last was verified live; it also releases a dead character first.
- The `client/swarm.ts` and `client/runner.ts` header comments still need the same caveat.

**8. Copied examples misread their arguments (low): fixed**
- New `bots/examples/script-args.ts` with `scriptArgs()`. It drops argv[0] only when runScript would take the bot name from argv, using the same priority as `loadEnvFromArgs`.
- Every example imports it as `'../examples/script-args'`, so a copy in `bots/<name>/` still resolves.
- Live: a copy at `bots/fxdo1/grinder.ts 15 badger` ran 15 s with the pattern applied.
- Documented in CLAUDE.md, learnings/README.md and README.md.

**9. --list offers races create-bot refuses (low): fixed**
- New `getPlayableRacesForClass` in data. `--list` and the default-race pick use it, so Inconnu Acolyte and Saracen Disciple are gone.

**10. MCP `script:` mode rejects the documented scripts (low): docs and scripts fixed, mcp description left open**
- `bots/_template/script.ts` and all 5 examples now use `const main = ...; export default main; if (import.meta.main) await runScript(main, ...)`.
- MCP `args` are named per example, for example grinder takes `{ seconds, pattern }` and duo takes `{ follower, kills }`.
- The CLAUDE.md MCP table, the session loop, README.md and learnings/README.md show the pattern.
- Tests: each file has the guard and a default export, has no `process.argv` reads, and imports without side effects (`bots/examples/script-args.test.ts`).
- Not exercised through a real MCP `execute_code` call, only by importing each file the way loadScript does.

**11. DESIGN.md and README misdescribe bot.env and git ignores (low): fixed**
- DESIGN.md: the real CHAR_NAME rule (digits to a-j, padding with "bot"), the GENDER key, and chat-history moved to `sdk/`.
- README: each whole bot folder is gitignored, not just bot.env.

**12. No grouping/chat topic (low): fixed**
- New `learnings/grouping-and-chat.md`, split into verified and unverified, covering invite and accept, shared XP and loot, follow, the chat helpers, the chat CLI, pacing, and treating player chat as untrusted.
- The invite rules are cited from source: online-name lookup at invite.cs:50-70, the same-realm check at NormalServerRules.cs:131-139, already grouped at invite.cs:84, leader only at invite.cs:15. While checking these I found the invitee does not have to be in view.
- Indexed in learnings/README.md and the CLAUDE.md topic list.

## Live verification
- Fresh PrivLevel-1 bots on a private gateway (port 7804):
  - fxdo1, Hibernia Naturalist
  - fxdo2, Albion Mage
  - fxdo3, Blademaster that started as a Guardian
- All three quit through `swarm-check --quit`, and every runner exited 0. fxdo3 was dead at the time and was released automatically first.
- The gateway was stopped afterwards. The `bots/fxdo1..3/` folders remain; they are gitignored.

## Left for other areas
- **client and sdk (finding 1):**
  - `PlayerRegionChangeRequest: 0x90` in `client/protocol/opcodes.ts`
  - a u16 LE encoder in `client/protocol/outgoing.ts`
  - `sdk.sendRegionChangeRequest(id)` and `bot.useZonePoint(zp)`
  - optionally, `travelTo` routing to other regions through `getZonePointsFrom`
- **client (finding 7):** the Windows signal caveat in the header comments of `client/swarm.ts` (lines 9-10) and `client/runner.ts` (lines 7-8).
- **mcp (finding 10):** the `script` description in `mcp/server.ts` (line 38) should mention the `export default main; if (import.meta.main) runScript(main)` form.

## Regression

# Final regression report

The repo passes all checks and every live scenario after the concurrent fixes. I found one more bug during the live run and fixed it: `grind()` did not count a death that happened in its last fight. Nothing was committed to git, and nothing I started is still running.

## Static checks

| Check | Result |
|---|---|
| `bun run typecheck` (tsc --noEmit) | clean |
| `bun run test`, before my fix | 438 pass / 0 fail (28 files, 3795 expects) |
| `bun run test`, after my fix | **439 pass / 0 fail** (28 files) |
| `bun run docs:api:check` | API.md is current: 48 BotActions methods, 101 BotSDK methods, 71 result/state types |

## Live regression

All accounts were fresh: freg1 to freg6, all PrivLevel 1 (checked in the `account` table). The gateway ran on :7780, bound to 127.0.0.1 with auth `none`.

| Scenario | Bot(s) | Result |
|---|---|---|
| create-bot (Fighter ×5, `--class=Mage` ×1) | freg1-6 | PASS. bot.env, script.ts and lab_log.md written; accounts and characters created on first login |
| gateway start, `/status` | — | PASS. Listening on 127.0.0.1 only |
| runner to `in game (phase playing)` | freg1-5 | PASS. All in under 5 s |
| `sdk/cli.ts` | freg1 | PASS. `In Game: true`, full starter armour, trainer in view |
| template `script.ts` | freg1 | PASS. Walked out and back, killed a spirit hound (+17 xp, +3c) |
| `grinder.ts` 120 s | freg1 | PASS, with the bug below. 13 kills, +221 xp, +32c, reached level 2, picked up a Focus Staff. It ran 143 s; the final wild-sow fight ran past the deadline and the bot died in it, but the result said `deaths: 0` |
| `merchant-run.ts` with no junk | freg2 | PASS. Correctly returned "nothing to sell" |
| `merchant-run.ts` with loot (after `releaseAndRespawn`) | freg1 | PASS. Walked into Prydwen Keep and sold the Focus Staff to Torr Fletcher for 1c ("35c -> 36c") |
| `caster.ts` | freg3 (Mage) | PASS. Target at 1301 u; 3 Minor Vitality Drain casts for 13 damage; 2 interrupts reported correctly; finished in melee (+35 xp), then rested |
| `duo.ts` (3 kills) | freg4 + freg5 | PASS. Group formed; 3 spirit hounds killed with shared xp and loot |
| MCP over stdio, code mode (`client/dev/mcp-e2e.ts`) | freg6 | **MCP E2E PASS**. Client auto-spawned, say echoed, client reused on the second call, `disconnect_bot` reported "quit and exited", process gone |
| MCP over stdio, script mode (`script: bots/freg6/script.ts`) | freg6 | PASS. ok=true, killed a spirit hound, logs returned; `disconnect_bot` quit the client cleanly |
| `client/swarm.ts`, 3 bots for 60 s, watched by `swarm-check --walk` | freg1, freg2, freg6 | **SWARM CHECK PASS**. 60 samples per bot, 0 not-in-game, max state age 250 ms, 0 teleports, 0 corrections; each bot "exit 0, logins 1" |
| Viewer `/viewer` and `/viewer/freg3` | — | PASS. HTTP 200; the bot list rendered all 6 bots; the bot page showed the map, stats, effects, inventory and messages live; no console errors |

## Fix made during the regression

- **Bug:** `grind()` checks for death only at the top of its loop. If the final `killNpc` runs past the duration deadline and the bot dies in it, the loop exits and the result reports `deaths: 0` with `stopReason: 'duration'` while the bot is dead. That is what happened in the grinder run above.
- **Fix (`sdk/actions.ts`, at the end of `grind()`):** before `finish('duration')`, check `isDead`/`deathCount` once more, count the death, and return `finish('died')` when `respawn` is not set.
- **Test:** "counts a death in the last fight that ran past the deadline" in `sdk/test/actions.test.ts` (grind block). It fails without the fix and passes with it.

## Cleanup

- Every bot was stopped with a quit action:
  - freg1 and freg2: `swarm-check --quit` (exit 0: quit).
  - freg1, freg2 and freg6 in the swarm: swarm-check `--quit` (finished 0: quit).
  - freg3, freg4 and freg5: `swarm-check --quit` (exit 0: quit).
  - freg6 under MCP: `disconnect_bot`, twice.
- The gateway I started was stopped after all bots had quit.
- No process listens on ports 7780-7810, and no `client/runner.ts`, `client/swarm.ts` or `gateway/gateway.ts` process remains.
- Two `bun run mcp/server.ts` processes were already running before I started (pids 19508 and 37228). They are not mine and I did not touch them.
- The viewer tab I opened in the browser pane is closed. Another viewer page, not opened by me, was watching acpt1 on the gateway (it showed up in the gateway log).
- `bots/freg1..freg6/` are still in the repo. The temporary `bots/freg1/release.ts` I used is deleted.

## Remaining known issues

1. **Grind overshoot (not fixed):** `grind()` runs its last kill to completion past `durationMs` (143 s on a 120 s grind). A mob that attacks near the deadline can kill the bot after the time is up. The death is now counted, but with `respawn: true` the bot is left dead when grind returns. Callers such as `grinder.ts` should check `isDead()` afterwards, or grind could release when `respawn` is set.
2. **Viewer timestamps:** the viewer's message times read about an hour later than the runner logs (13:51 vs 12:56). This is probably server time against local time; cosmetic, not investigated.
3. **Carried over from the fixer reports, not verified here:**
   - Zone points cannot be crossed by walking: the SDK has no 0x90 sender yet.
   - Guardian, Blademaster, Hero and Champion start without armour, because their armour item templates are missing.
   - Two server 0x04 paths do not stand the player up, so the sit state can be wrong until the next 0xAD.
   - Server kick and the 4 s position-gap refresh were not tested live.
   - With the default loopback bind, the gateway has no password check unless `GATEWAY_AUTH=botenv` is set.
   - `docs/build-reports/stage1-client.md:58` and `:119` still say `Style.specName` is always null.
   - `markSelfDead()` in `client/model/world-model.ts` still keeps the old target. The sdk works around it.
   - `bots/examples/caster.ts` does not break on `no_target` or `died`.
   - The docs (CLAUDE.md, README.md, docs/DESIGN.md) are not updated for `BotPreemptedError`, `GATEWAY_HOSTNAME`/`GATEWAY_AUTH`, or the JSON content-type requirement.

Files changed:
- `C:/Users/joshu/Code/daoc-sdk/sdk/actions.ts`
- `C:/Users/joshu/Code/daoc-sdk/sdk/test/actions.test.ts`

Logs from this run are in `C:/Users/joshu/AppData/Local/Temp/claude/C--Users-joshu-Code-daoc-sdk/8a26ca28-643a-4772-a3b5-f937b7c99a27/scratchpad/reg/` (gateway, runner, swarm and grinder output).