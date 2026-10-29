# Corrections and additions: OpenDAoC headless client, handshake to in-world (verified against source)

Paths are relative to `C:/Users/joshu/Code/daoc-sdk/server/core/GameServer` unless marked otherwise. Every item below was checked by reading the code. Items marked **[CONTRADICTION]** settle a disagreement between the input reports. Items marked **[WRONG]** fix a claim that is false. Items marked **[NEW]** are gaps that would block a working client.

## 1. Framing and crypto

**1.1 Inbound reassembly (`GameClient.cs:347-414`).** The server does reassemble packets that span several reads. Three details matter:
- The `do{…}while(endPosition-1 > currentOffset)` loop leaves 1 byte over as a special case.
- A partial frame is moved to the start of the buffer.
- **[WRONG] login-crypto's "large unprocessed backlog causes overflow".** A backlog stays in the kernel socket buffer. Each tick reads at most `1024 - partialLen` bytes, and only a *single frame larger than about 1024 bytes* triggers the overflow disconnect (`CoreBase/Network/BaseClient.cs:101-110`). Throughput is about 1 KB per 33 ms tick, roughly 30 KB/s inbound. That is fine for a bot, but long bursts arrive late rather than failing.

**1.2 Version check (`CheckVersion`, `GameClient.cs:285-345`).**
- It reads `ReceiveBuffer[11..13]` from the **first** receive and assumes that receive starts at offset 0. The source comment says "assumes the first packet is received in full".
- If that read is under 17 bytes, the server disconnects.
- Send the 19-byte 0xF4 frame in a single write, with `setNoDelay(true)`. Do not pipeline anything else before the 0x22 reply.

**1.3 Checksum.** It was verified as a port of `PacketProcessor.cs:608-622`: `byte val1/val2 += …` wraps at 8 bits, and `(ushort)(val2 - ((val1+val2)<<8))`. The JS form `(v2 - ((v1+v2)<<8)) & 0xFFFF` is equivalent. Golden frames computed with that port (not yet confirmed against a live server):
```
F4 (LotM 0x06, 1.127, rev 'a'): 00 07 00 00 00 00 00 00 00 F4 06 01 01 1B 61 00 00 53 B0
F4 (rev 0x00):                  00 07 00 00 00 00 00 00 00 F4 06 01 01 1B 00 00 00 D7 8D
A7 bot1/secret, seq=1:          00 14 00 01 00 00 00 00 00 A7 05 00 00 00 62 6F 74 31 00 07 00 00 00 73 65 63 72 65 74 00 F2 CC
FC realm=1, seq=2:              00 01 00 02 00 00 00 00 00 FC 01 87 FB
```
The sequence, session and parameter header fields are never validated. The only use of sequence is that the PingReply echoes `seq+1`.

**1.4 [CONTRADICTION] Layout of the 0x22 CryptKey reply received by a 1.127 client.**
- login-crypto is correct; client-handlers is wrong. client-handlers cites `PacketLib1124.cs:747` (`[u8 clientType][u8 0]…`), but that method is overridden.
- For 1126/1127 the winning method is `PacketLib1126.cs:52-76`: `u32LE 0`, `"1.127"` (5 raw bytes, no NUL), `00 00 00`. Payload is 12 bytes.
- For 1128/1129 it is `PacketLib1128.cs:8-21`, with 4 trailing zero bytes (payload 13).
- The version string is built from the client version (`Version/1000 + "." + Version-1000`), so it echoes whatever you sent.
- The reply is flushed immediately with `SendPendingPackets()`.

**1.5 No encryption in either direction.** This was confirmed. The handler takes the RC4 path only when `DataSize > 7` (`packets/Client/168/CryptKeyRequestHandler.cs:34-45`), and in that case it returns without replying. Keep the payload at exactly 7 bytes. `MinorRev = ReadString(1)` accepts 0x00.

**1.6 Server-to-client framing.** `[u16BE len=Length-3][u8 code][payload]` (`packets/Server/GSTCPPacketOut.cs:21-25`).
- UDP packets that fall back to TCP are rewritten into exactly this format (`PacketProcessor.cs:376-433`).
- The fallback is taken whenever `UdpEndPoint == null`, whatever `UdpConfirm` says (`PacketProcessor.cs:239`). If you never send a UDP datagram, everything arrives on TCP.

**1.7 Strings.**
- `WritePascalStringIntLE("")` writes `u32 0` with no NUL. A non-empty string writes `u32(len+1)`, the bytes, then a NUL.
- `WriteString(s, max)` writes no NUL.
- `WriteString(s)` writes a C string.
- `FillString` pads with NULs.
- Inbound `ReadIntPascalStringLowEndian` reads exactly n bytes and truncates at the first NUL. You may send either `len` or `len+1`+NUL.

## 2. Login to in-world: authoritative sequence and gating

**2.1 [CONTRADICTION] Order of 0xBF and 0xE8.**
- Both orders work on the server. 0xE8 only needs `client.Player != null`. 0xBF needs `ClientState == WorldEnter` (`GameOpenRequestHandler.cs:8`).
- Recommended order: **D4 → wait for 0x20 → BF(0) → wait for 0x2D → E8 → wait for 0x2B.** Reasons:
  - `ClientService.EndTickInternal` (`ECS-Services/ClientService.cs:131-140`) comments that GameOpen arrives while the retail client is still on its loading screen. In other words, GameOpen comes before PlayerInit.
  - `UpdateWorld` (the NPC, object and door create stream) runs **only in `Playing` with `ObjectState == Active`** (`ClientService.cs:129-136`). Nothing populates until 0xBF is sent.
  - `GameOpen` calls `PlayerObjectCache.Clear()`, so every NPC is created again after it.
- **[WRONG] client-handlers' "Server sends 0x88 position".** That is a legacy-opcode comment in `WorldInitRequestHandler.cs:64`. The packet actually sent is **0x20 `SendPlayerPositionAndObjectID`** (`PacketLib1124.cs:441-487`).

**2.2 How WorldInit behaves (`WorldInitRequestHandler.cs:13-30`).** It is `async void`. It loads the player from the DB, sets `WorldEnter` before `AddToWorld()`, and then sends 0x20 and the rest of the burst. Waiting for 0x20 therefore guarantees Player != null, WorldEnter, and ObjectState Active.

**2.3 Character index.** `charIndex = (Account.Realm-1)*10 + slot`. The server maps it back with `Account.Realm*100 + (charIndex - (Realm*10-10))`. If no character is found, it silently does nothing: no 0x20 arrives, so put a timeout on the 0x20 wait.

**2.4 [NEW] Effects of 0xFC on `Account.Realm` (`CharacterOverviewRequestHandler.cs:87-143`).**
- Every 0xFC first sets state to CharScreen. If the account has **no characters**, it also resets `Account.Realm` to None.
- When `allow_all_realms=false` and `Account.Realm` is already set, the requested realm byte is **ignored**: you get the overview for the saved realm, and D4 index math uses the saved realm.
- The realm is held in memory per session. Send 0xFC(realm) after every login, before 0xFF or 0xD4.

**2.5 [NEW] Getting 0x2A after 0xFF does NOT mean the character was created (`CharacterCreateRequestHandler.cs:87-92, 455-505`).**
- These failures all return `true` (needRefresh), so `SendLoginGranted` is sent anyway: disabled class or race, invalid class enum (unless `BAN_HACKERS`), and `IsCharacterValid` failure (bad realm, class, race or stat budget).
- After 0x2A you **must re-send 0xFC(realm) and check that the slot is filled** in 0xFC.
- On success the server refreshes `Account.Characters` (`FillObjectRelations`).
- In the 1.126+ packet, `ch.Region` stays 0 (the Region byte is read only for 1125). `StartupLocations` assigns the real position.

**2.6 0xFF payload size for 1.127.**
- Total = `1 + (4+nameLen+1) + 100` bytes.
- The three "strings" are consumed as a raw `Skip(5)` each, so send them as exactly `01 00 00 00 00`. Any other length misaligns the class, realm and stat fields.
- `CustomMode=1` applies the face bytes and sets CustomisationStep=2.

**2.7 Two 0x2A packets.** 0x2A arrives in reply to A7, again after 0x10 CharacterSelect (followed by 0x28), and again after 0xFF. The decoder must not treat a later 0x2A as a fresh login.
- 0x10 is optional. The 0xA9 sessionId field is skipped by the server, so you do not need 0x28. 0x28 is u16 **LE**, confirmed at `PacketLib168.cs:133-140`.
- Skip 0x9D. It throws an NRE (caught server-side) if no character matches the slot, and its 0xB1 reply advertises `REGION_PORT` (10400 in both compose files), which the bot does not need.

**2.8 [NEW] Login denial facts (`LoginRequestHandler.cs`).**
- A failure path calls `SendLoginDenied`, then `SendPendingPackets()` in `finally`, then `Disconnect()` (:466-476). You will see 0x2C before the socket closes.
- Code 0x07 `AccountNotFound` is sent when auto-creation is off. The input reports missed this one.
- If another socket for the same account is still in `Connecting` state, you get 0x0B.

**2.9 [NEW] Reconnect and takeover semantics (needed for rs-sdk's `save_and_disconnect` / restart logic).**
- If the TCP connection drops while `Playing`, `GameClient.OnDisconnect` (:416-458) calls `OnLinkDeath(false)`. That is a hard link-death: state becomes Linkdead, and the character stays in the world for `SECONDS_TO_QUIT_ON_LINKDEATH = 60` (`gameobjects/GamePlayer.cs:41`).
- A re-login during that window gets **0x2C code 0x11 `AccountIsInLogoutProcedure`** (`LoginRequestHandler.cs:231-240`). There is no server-side takeover. The runner must back off for at least 60 s and then retry.
- A clean exit is `&quit` via 0xAF. Constraints:
  - The player must be alive and not mounted.
  - The player must not be moving: send a final 0xA9 with `speed=0` first.
  - The quit timer is at least 20 s, and up to 60 s after combat (`GamePlayer.QuitTimer`, :685-800).
  - The timer is instant only with `disable_quit_timer` (and not in combat) or with PrivLevel > 1.
  - When it completes the server sends **0xA4** (`totalOut=0`). After 0xA4, close the socket.
- Dropping the socket in CharScreen or WorldEnter quits immediately (WorldEnter saves the character first).

## 3. Position updates and liveness

**3.1 0xA9 payload layout (`packets/Client/168/PlayerPositionUpdateHandler.cs:58-82`).** This is verified and matches the reports: 40 bytes for 1.127.
```
0 f32LE x | 4 f32LE y | 8 f32LE z | 12 f32LE speed | 16 f32LE zSpeed | 20 u16 sess(skip) | 22 u16 oid(skip)
24 u16BE zoneId | 26 u8 stateFlags | 27 u8 | 28 u16BE fallingDamage | 30 u16BE heading | 32 u8 actionFlags | 33-34 | 35 health | 36-39 pad
```
The packet length is not validated.

**3.2 [NEW] Where the link-death timer is refreshed.**
- `LastPositionUpdatePacketReceivedTime` is set **only** in three places: in the 0xA9 handler (line ~137), and only after both `ProcessStateFlags` and the zone-ID check pass; in `ClientState` transitions to Playing or CharScreen (`GameClient.cs:44-49`); and in `AddToWorld` (`GamePlayer.cs:~7786`).
- **[WRONG] world-gameplay's "0xBB/0x71/0x7D refresh the link-death timer".** Their position prefix calls `OnPositionUpdateFromPacket` directly and never touches the timer.
- Consequences:
  - An 0xA9 with an unknown zoneId never refreshes the timer, and it kicks you to the character screen (`GameServiceUtils.KickPlayerToCharScreen`).
  - The 5 s clock starts at 0xBF (the Playing transition). **Send the first 0xA9 right after 0x2D**, using the 0x20 position, `speed=0`, `fallingDamage=0x8000`, and the computed zoneId.

**3.3 [NEW] Soft link-death lifecycle (`PlayerMovementComponent.cs:52-61`, `GamePlayer.cs:824-834, 1076-1115`).**
- After 5 s without 0xA9, `OnLinkDeath(soft=true)` runs. State **stays Playing**.
- A `LinkDeathTimer` broadcasts the position every 1 s. After 60 s it saves the character and calls `LinkDeathQuit`, which **closes the socket**.
- The next 0xA9 (or 0xBB/0x71/0x7D) recovers: it calls `MoveTo(locationAtLinkDeath)`, which sends an 0x04 jump. That packet's own data is discarded.
- For 0xBB, 0x71 and 0x7D during recovery, the 18-byte prefix is **not** consumed, so `flagSpeedData` and the indexes are read from the x/y bytes. Always recover with 0xA9 first.

**3.4 zoneId [NEW: data dependency].**
- `WorldMgr.GetZone(zoneId)` (`world/WorldMgr.cs:688`) looks up by **Zone.ID**, not skin.
- **No server packet tells the client its zone ID at world entry.**
  - 0x20 carries the region *skin* (offset 20) plus dungeon offsets only.
  - 0xB7 carries ZoneSkinID, and only on region change.
- The client must compute `zone = first zone in region where XOffset ≤ x < XOffset+Width*8192, and likewise for y`. Offsets are `OffsetX*8192` (`WorldMgr.cs:608-611`).
- Bundle the zone table from `server/db/opendaoc-db-core/zones.sql` (columns ZoneID, RegionID, OffsetY, OffsetX, Width, Height, …) or from `scripts/dbupdater/insert/Zones.xml`.
- The server never checks that zoneId matches the position: any valid ID is accepted. It does drive `CheckAreas` and the "You have entered" messages.

**3.5 [NEW] State flags.**
- `ProcessStateFlags` returns false (dropping the packet without refreshing the timer) only when `BAN_HACKERS` bans you. Otherwise RIDING, FLYING and DEAD are silently stripped.
- Send `stateFlags=0`, or `0x04` (swim) when in water.
- 0xBA (`PlayerHeadingUpdateHandler.cs:6-24`) is accepted in any client state with ObjectState Active. It sets `Heading` and `ActionFlags`, and does not refresh the timer.

**3.6 Action flags are direction-dependent (enum at `PlayerPositionUpdateHandler.cs:~800`).**
- Inbound: 0x04 = pet in view, 0x02 = diving.
- Outbound: 0x04 = diving, 0x02 = stealthed (`GetActionFlagsOut`).
- `TARGET_IN_VIEW` is bits 0x30, and both must be set.

**3.7 Speed monitor (verified, `gameutils/PlayerMovementMonitor.cs:56-130`).**
- Samples are timestamped with `MonotonicTime.NowMs` when the **server processes** them. The allowance is `MaxSpeed*1.15*(Δt+tick)/1000`.
- `MaxSpeed` (absolute) is `pct * 191/100`, where `pct` is the 0xB6 u16BE value (`SendUpdateMaxSpeed`, `packets/Server/PacketLib168.cs:1201-1213`).
- A steed's MaxSpeed replaces the player's when mounted.
- Jitter can cause false violations, because two 200 ms steps processed in back-to-back 33 ms ticks look too fast. One violation is harmless (it takes 6 within 1.5 s).
- Use a steady 200 ms cadence and about 0.9× speed per step on localhost.
- After any 0x04 or 0x20, snap the local position. `ForceUpdatePosition` pauses the monitor for 750 ms.

**3.8 [NEW] Interaction between movement and casting.**
- Any XY change calls `Owner.OnPlayerMove()` (`PlayerMovementComponent.cs:100-104`). This is also true of the 0xBB, 0x71 and 0x7D position prefixes. It interrupts casting and forces a stand.
- Repeat the exact last position in those prefixes, and keep 0xA9 positions unchanged during a cast (send 0xA9 with the same xyz and `speed=0`).
- Those prefixes also overwrite `Player.Heading`, so put the facing-to-target heading in them.

**3.9 Cross-region move (`GamePlayer.MoveTo`, :7854-7932).**
- `RemoveFromWorld` runs, then 0xB1 and 0xB7 (`PacketLib174.cs:385-406`). State stays Playing, so 0xA9 packets are dropped (object Inactive) until re-entry.
- The client must immediately send **D4** (charIndex is not read in this path, but send the same byte). Then wait for 0x20, then send **BF(0)** and **E8**.
- A same-region move sends only **0x04 CharacterJump** (`u32BE x, u32BE y, u16 oid, u16 z, u16 heading, u16 house`).

## 4. World population

**4.1 [NEW, blocking for nearbyPlayers] Players already in range are never pushed to a newly entered client.**
- `UpdateWorld` comments "Players aren't updated here on purpose" (`ClientService.cs:765-792`).
- `SendPlayerCreate` (0x4B) is sent only in these cases:
  - to others when *they* call `AddToWorld` (`GamePlayer.cs:7765-7770`);
  - on stealth changes;
  - on last-name changes;
  - **on request via 0xD5 CreatePlayerRequest**: `u16 **LE** sessionId` for 1126+ (`PlayerCreationRequestHandler.cs:13-30`), answered with 0x4B and 0x15.
- The client must therefore watch relayed 0xA9 (sessionId at payload offset 20, objectId at 22) and 0xBA (sessionId at 0) for unknown sessionIds, and send 0xD5. Throttle one request per sessionId.

**4.2 NPCs.** They are created proactively (0xDA, plus 0x15 if flags&0x02) on the per-player `WORLD_PLAYER_UPDATE_INTERVAL` (1000 ms) pass.
- An NPC is re-sent as 0xA1 (TCP) every `world_npc_update_interval` (5000 ms).
- Your target and your pet get 0xA1 whenever HP changes, at most every 250 ms.
- When an NPC leaves the 6000 range it is dropped from the server cache and **re-created** (0xDA) if it comes back. No remove packet is sent, so cull locally when there has been no 0xA1 for well over 5 s or the distance exceeds 6000.
- Sending 0xB0 to target an NPC triggers an immediate 0xA1 (`PlayerTargetHandler.cs`, `UpdateObjectForPlayer`).
- In 0xA1, mask the heading with `&0xFFF`, because the top 4 bits carry zSpeed while moving.
- 0xA1 X/Y are zone-relative to **ZoneSkinID** (9 bits: low byte at offset 22, bit 8 from flags&0x04). That gives a second hard dependency on the zone table.

## 5. Other packet facts confirmed (no change needed)

- 0xBB UseSkill and 0x71 UseSlot: 18-byte prefix (`f32 x,y,z,speed`, `u16BE heading`), then `u16 flagSpeedData`, `u8`, `u8`. Payload 22 bytes.
  - `flagSpeedData` is **outside** the conditional prefix. client-handlers' wording "18-byte prefix … flagSpeedData" is ambiguous; this is the precise form.
  - Set `0x2000` (any bit of 0xA000) in `flagSpeedData` for target-in-view.
- 0x7D UseSpell: prefix, `u16 flagSpeedData`, `u8 level`, `u8 lineIdx`, 2 trailing bytes. Payload 24 bytes.
- 0xAF command: `u8 skip`, then `ReadString(255)` (1.127). Commands confirmed: `&quit`/`&q`, `&say`, `&send`, `&whisper`, `&release`/`&rel`.
- 0xAF S→C chat (`PacketLib1127.cs:39-58`): `u8 type`, then a `"@@"` prefix (CT_Send) or `"##"` prefix (popup), then a C string.
  - **NPC dialog text** (`GameNPC.SayTo`, :2579-2601) arrives as **type 0x12 CT_System with the "##" prefix**, formatted by `GameNPC.SayTo.Says`. Parse `[keywords]` from that text.
  - No 0xAF is sent while in CharScreen.
- 0xD0 LoS request (`gameutils/LosCheckHandler.cs:102-107`): `u16 src, u16 tgt, u16 0, u16 0`. Reply with 0xD0 `u16 src, u16 tgt, u16 0x0100` (`CheckLosResponseHandler.cs`). Requests are sent only while Playing.
- 0xB0: `u16BE oid`, `u16BE flags` (0x6000 = in view). Targets beyond 6000 get 0xE1 and are cleared.
- 0x7A: `u32 x, u32 y, u16 sess, u16 oid` (12 bytes). Range is checked against 6000; `Interact` then checks 192 (3D).
- 0x74: refused while the active weapon slot is Distance.
- 0xCB DupNameCheck reads `ReadString(24)` for 1126+.
- 0x90 zonePointId and 0xBE / 0xD5 ids are LE for 1126+.
- 0xAD (`PacketLib190.cs:53-75`): first arrives one tick after 0xBF (posted). Until then HP, mana and endurance are unknown; treat 0x2B plus the first 0xAD as "ready".
- 0x91 (`PacketLib190.cs:33-50`): XP and XPnext are u64 **LE**; the RP, BP and spec fields are BE.

## 6. Local environment (the user's own stack, untracked `server/docker/`)

- `C:/Users/joshu/Code/daoc-sdk/server/docker/docker-compose.yml`:
  - It builds from local `server/core`, so server mods can be applied and tested. `EnableCompilation=True` compiles `/app/scripts`, but nothing is mounted there by default.
  - MariaDB is published on **host port 13306**, root password `daoc-sdk`, database `opendaoc`. The DB is seeded from a bind mount of `../db/opendaoc-db-core`, which avoids the copy-up race described for `server/core/docker-compose.yml`.
  - The game server is on TCP 10300. UDP 10400 **is** published here, unlike in core's compose. It is still optional, since sending no UDP means everything comes over TCP.
  - The DB has a healthcheck, and the game server waits on it with `condition: service_healthy`.
  - `AUTO_ACCOUNT_CREATION=True`.
- From Windows through Docker Desktop, every bot connects from the same NAT address. Before mass account auto-creation, apply `time_between_account_creation_sameip=0` and raise `total_accounts_allowed_sameip` with SQL on port 13306 (the `serverproperty` rows exist after first boot), or pre-insert `account` rows with plaintext passwords.

## 7. Minimal state machine for the TS client (resolved)

```
connect(TCP 10300, noDelay) -> write F4 (19B) -> await 0x22
-> A7 -> await 0x2A | 0x2C(code)->fail
-> FC(realm 1..3) -> await 0xFC overview (async; may be the 16-byte empty form)
   [create: FF -> await 0x2A -> FC -> verify slot filled; else invalid-char]
-> D4(charIndex=(realm-1)*10+slot) -> await 0x20 (timeout => char not found)
   record oid@12 u16BE, xyz f32LE, heading@14, regionSkin@20
-> BF(00) -> await 0x2D -> IMMEDIATELY A9 (same pos, speed 0, fall 0x8000, zoneId from table)
-> E8 -> await 0x2B => in-world
loop: A9 every 200 ms moving / <=1 s idle; A3 every ~30 s; answer every 0xD0 within 1.5 s;
      0xD5 for unknown sessionIds seen in 0xA9/0xBA; snap on 0x04/0x20; on 0xB7: D4 -> await 0x20 -> BF -> E8.
exit: A9 speed 0 -> AF "&quit" -> await 0xA4 -> close. Abrupt close => 60 s 0x11 lockout.
```