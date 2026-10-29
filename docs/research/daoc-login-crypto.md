# OpenDAoC handshake and wire protocol spec for a headless TS client

All paths are relative to `C:/Users/joshu/Code/daoc-sdk/server/core`. BE means big-endian (network order) and LE means little-endian. "u16 BE" is `PacketIn.ReadShort`; "u32 LE" is `ReadIntLowEndian`.

## 0. Summary of key facts
- **There is no encryption on the wire.** Both directions are plaintext. `IPacketEncoding.EncryptPacket` and `DecryptPacket` are never called anywhere (grep finds only the definitions). `GameClient.ProcessInboundTcpBytes` (GameClient.cs:347-414) and `PacketProcessor.Process*Packet` (PacketProcessor.cs:320-493) copy raw bytes. RSA is compiled out (`#if RSA_ENCRYPTION`, PacketLib168.cs:65-73), and so is `CryptLib168.GenerateRSAKey` (GameServer.cs:337-342, commented out). In 1.126+ the CryptKey reply sends "key length 0", described as "Actually forces Encryption Off to work with Portal" (PacketLib1126.cs:48-76, PacketLib1128.cs:8-21).
- **TCP-only works.** UDP is optional; the server falls back to TCP for every UDP packet when `UdpEndPoint == null` or `!UdpConfirm` (PacketProcessor.cs:239-263). The docker-compose maps `10400:10400`, which is TCP by default, so UDP is not even reachable in the stock container.
- **Recommended emulated version: 1.127** (raw bytes `01 01 1B`). Reasons are in section 7.
- **Ports:** TCP 10300 for login and game (same socket for the whole session). UDP 10400 (optional).

## 1. Framing

### 1.1 Client → Server (TCP and UDP use the same format)
The parser is `GSPacketIn.Load` (packets/Client/GSPacketIn.cs:101-114), with `HDR_SIZE = 12` (line 14).
```
off size field
0   2   payloadLen  u16 BE   (= N, payload bytes only)
2   2   sequence    u16 BE   (ignored except echoed by ping reply; real client increments per packet)
4   2   sessionId   u16 BE   (ignored on TCP; MUST match on UDP — GameServer.cs:1088)
6   2   parameter   u16 BE   (ignored)
8   1   0x00        (high byte of code, ignored: m_code = buf[offset+9])
9   1   code        u8       (opcode, eClientPackets)
10  N   payload
10+N 2  checksum    u16 BE
total = N + 12
```
Checksum (`PacketProcessor.CalculateChecksum`, PacketProcessor.cs:608-622) covers bytes `[0, N+10)`, which is everything including the length field and excluding the checksum itself:
```ts
function cks(b: Uint8Array, off: number, len: number): number {
  let v1 = 0x7E, v2 = 0x7E;
  for (let i = off; i < off + len; i++) { v1 = (v1 + b[i]) & 0xFF; v2 = (v2 + v1) & 0xFF; }
  return (v2 - ((v1 + v2) << 8)) & 0xFFFF;   // C#: (ushort)(val2 - ((val1 + val2) << 8)), byte+byte promotes to int
}
```
A bad TCP checksum disconnects the client (GameClient.cs:377-387). A bad UDP checksum drops the packet (GameServer.cs:1069-1081).

Receive-side constraints (CoreBase/Network/BaseClient.cs):
- `TCP_RECEIVE_BUFFER_SIZE = 1024` (line 18). A single client packet larger than about 1012 bytes of payload, or a large unprocessed backlog, causes a "receive buffer overflow" disconnect (lines 105-114).
- The server calls `Receive()` once per game-loop tick (`GAME_LOOP_TICK_RATE` default 30, so about 33 ms; ClientService.cs:69-90), and each call does one `ReceiveAsync`.
- Packets are dispatched synchronously in game-loop order.

UDP receive (CoreBase/Network/BaseServer.cs:22-23, 139-211): datagrams are read into 64-byte chunks (`UDP_RECEIVE_BUFFER_CHUNK_SIZE = 64`), so a client UDP datagram must be **≤ 64 bytes total**. The first UDP packet latches `client.UdpEndPoint`; packets from a different endpoint are ignored afterwards (GameServer.cs:1098-1105).

### 1.2 Server → Client TCP
Built by `GSTCPPacketOut` (packets/Server/GSTCPPacketOut.cs:13-25):
```
0  2  payloadLen u16 BE (= Length - 3)
2  1  code u8 (eServerPackets)
3  N  payload
```
There is no sequence, session or checksum. Many packets are concatenated into one TCP send of up to 8192 bytes (`TCP_SEND_BUFFER_SIZE`), so parse it as a stream. Packets with more than 2048 total bytes are discarded server-side (PacketProcessor.cs:495-515).

UDP packets that fall back to TCP (`ProcessUdpAsTcpPacket`, PacketProcessor.cs:376-433) are rewritten to exactly the same 3-byte-header TCP format, with the counter stripped.

### 1.3 Server → Client UDP
Built by `GSUDPPacketOut` (packets/Server/GSUDPPacketOut.cs:12-25) and `ProcessUdpPacket` (PacketProcessor.cs:435-493):
```
0  2  payloadLen u16 BE (= Length - 5)
2  2  udpCounter u16 BE (per-client, incremented per packet, wraps)
4  1  code
5  N  payload
```
There is no checksum. Several packets can be concatenated in one datagram (up to `UDP_SEND_BUFFER_SIZE = 1024`).

### 1.4 Strings (the server uses CP1252, `BaseServer.DefaultEncoding`, BaseServer.cs:17)
- **IntLE-pascal** (1.125+ main string type):
  - Server writes `u32 LE (byteLen+1)`, then the bytes, then `0x00`. An empty string is just `u32 0` with no NUL (PacketOut.cs:211-223).
  - Server reads `u32 LE n`, then reads n bytes and truncates at the first NUL (PacketIn.cs:135-138, 82-115).
  - Client should send `u32 LE (len+1)`, the bytes, then `0x00`.
- **Byte-pascal:** `u8 len` followed by bytes, no NUL (PacketOut.cs:173-209). Used by LoginGranted.
- **Fixed / C strings:** `FillString(s, len)` writes NUL padding. `WriteString(s, max)` writes up to `max` bytes with **no** terminator (PacketOut.cs:242-288).

## 2. Version detection (first packet)
`GameClient.OnReceive` → `CheckVersion(size)` (GameClient.cs:276-345) runs on the **first TCP receive only** and reads directly from `ReceiveBuffer[0..size)`:
- `size < 17` → disconnect.
- `size < 19` → pre-1.115 format: `version = b[12]*100 + b[13]*10 + b[14]`.
- `size ≥ 19` → 1.115+ format: `version = b[11]*1000 + b[12]*100 + b[13]` (payload bytes 1..3, i.e. major, minor, build).
- `AbstractPacketLib.CreatePacketLibForVersion(raw)` (packets/Server/AbstractPacketLib.cs:72-97) matches `[PacketLib(raw, …)]` exactly. Supported raw versions: every value from 168 to 199, 1100 to 1129, **including 1127, 1128 and 1129** (PacketLib1127/1128/1129.cs). An unknown version disconnects.
- **Implementation requirement:** write the 19-byte 0xF4 packet in a single `socket.write` with `setNoDelay(true)`, and do not send anything else until the 0x22 reply arrives. The first recv must contain at least 19 bytes.

Packet handlers are always loaded from the namespace ending in `v168` (PacketProcessor.cs:71). Version-specific behaviour is done by `client.Version` branches inside handlers and by PacketLib overrides.

## 3. CryptKey exchange (1.115+ path)

**C→S 0xF4 CryptKeyRequest.** Handler: packets/Client/168/CryptKeyRequestHandler.cs:31-61. The payload must be **exactly 7 bytes**. If `DataSize > 7`, the server treats the trailing data as an RC4 key: it stores the key and returns **without replying** (line 34-45), which leaves the client hung.
```
p[0] u8 clientType = (eClientType & 0x0F) | (addons & 0xF0)
     eClientType: Classic=1, SI=2, ToA=3, Cata=4, DR=5, LotM=6 (GameClient.cs:512-521)
     addons: 0x10 bit4, 0x20 NewNewFrontiers, 0x40 Foundations, 0x80 NewFrontiers. Recommend 0x06 (or 0x06|0x80|0x40|0x20)
p[1] u8 major = 0x01
p[2] u8 minor = 0x01
p[3] u8 build = 0x1B (27 → 1.127) | 0x1C (1.128) | 0x1D (1.129)
p[4] u8 revision ASCII ('a'=0x61, or 0x00)   -> client.MinorRev
p[5..6] u16 build number (skipped)
```
Full 19 bytes for 1.127, assuming sequence=0 and session=0:
`00 07 00 00 00 00 00 00 00 F4 06 01 01 1B 00 00 00` followed by the 2-byte checksum (compute it).

**S→C 0x22 CryptKey** (`SendVersionAndCryptKey`):
- 1.126/1.127 (PacketLib1126.cs:52-76): `u32 LE 0` (no key), then `"1.127"` as 5 raw bytes (`WriteString(…,5)`, no NUL), then `0x00`, `0x00`, `0x00`. Payload is 12 bytes.
- 1.128/1.129 (PacketLib1128.cs:8-21): `u32 LE 0`, `"1.128"` as 5 bytes, then 4 × `0x00`. Payload is 13 bytes.
- The server flushes this immediately via `SendPendingPackets()`. That is required because `ClientService.EndTickInternal` does not send in the `NotConnected` state (ClientService.cs:110-140).

**RC4/RSA notes (for completeness; none of this is used):**
- `CLIENT_ENABLE_ENCRYPTION_RC4` defaults to false (serverproperty/ServerProperties.cs:101). Even when it is true, the server only stores the S-Box and never encrypts or decrypts anything.
- The algorithm, if it is ever needed (packets/Server/PacketEncoding1110.cs):
  - Key schedule: standard RC4 KSA over a common key of any length (`GenerateSBox`, lines 152-171).
  - Keystream is a modified RC4 PRGA. It runs over the second half `[len/2, len)` first, then over the first half `[0, len/2)`, where offsets start after the 2-byte length.
  - After the standard swap, `xor = S[(S[i]+S[j])&0xFF]`. On **decrypt**: `buf[k]^=xor; j+=buf[k]` (j is fed the plaintext). On **encrypt**: `j+=buf[k]; buf[k]^=xor` (same plaintext feedback).
  - Encrypt length = `payloadLen+1` (+2 if UDP). The decrypt length expression has an operator-precedence bug: `(b0<<8)|(b1+10)`.
  - The S-Box is copied fresh per packet, so there is no stream state.
  - RSA (CryptLib168.dll P/Invoke, CryptLib168.cs) is dead code. **Do not implement any of this.**

## 4. Ordered sequence: TCP connect → in-world (1.127)

States are `eClientState` (GameClient.cs:501-510): NotConnected=0, Connecting=1, CharScreen=2, WorldEnter=3, Playing=4, Linkdead=5, Disconnected=6.

| # | Dir | Opcode | Payload (1.127) | Server effect / gating |
|---|---|---|---|---|
| 1 | C→S | 0xF4 CryptKeyRequest | see §3 | Selects the PacketLib. State stays NotConnected. |
| 2 | S→C | 0x22 CryptKey | see §3 | |
| 3 | C→S | 0xA7 LoginRequest | `intLEPascal(username)`, `intLEPascal(password)`. Nothing else is read for ≥1126 (LoginRequestHandler.cs:149-153). | Async handler. Username must match `^[a-zA-Z0-9]*$`. The password is sent in plaintext; the server stores `"##"+hex(MD5(UTF-16BE(pw)))` with no zero padding (`CryptPassword`, :479-498). Auto-creates the account if enabled. |
| 4 | S→C | 0x2A LoginGranted (PacketLib1127.cs:13-27) | `bytePascal(accountName)`, `bytePascal(ServerNameShort)`, `u8 0x05`, `u8 colorType` (0→7), `u8 0x00` (trial flag) | State → Connecting. Failure is **0x2C LoginDenied** (PacketLib168.cs:84-101): `u8 eLoginError, 0x01, 0x01, 0x0C, 0x00`, followed by a disconnect. Codes are in IPacketLib.cs:229-258. |
| 5 | C→S | 0xFC CharacterOverviewRequest | `u8 realm` (0=ask, 1=Alb, 2=Mid, 3=Hib) (CharacterOverviewRequestHandler.cs:87-143) | Needs Account. State → CharScreen. realm=0 gets **0xFE Realm** back: `u8 realm` + 12×00 (PacketLib1125.cs:61-69). realm 1..3 sets `Account.Realm` and gets 0xFC back. |
| 6 | S→C | 0xFC CharacterOverview1126 (PacketLib1126.cs:78-298) | `u32LE flags` (bit0 = all-realms allowed), `u32LE 0`×3, then 10 slots (`realm*100 .. +9`). Empty slot: `u8 0`. Filled slot: `u8 level`, `intLEPascal name`, `u32LE 0x18`, `u8 1`, 6 face bytes, `u8 ext boots/gloves`, `u8 ext torso/hood`, `u8 customStep`, `u8 mood`, 13×00, `intLEPascal location`, `intLEPascal class`, `intLEPascal race`, `u16LE model`, `u8 region`, `u8 expansion`, then 8×u16LE (helm/gloves/boots models, RH color, torso/cloak/legs/arms models), 8×u16LE colors, 4×u16LE weapon models, 8×u8 stats, `u8 class`, `u8 realm`, `u8 race/gender` (`((race&0x10)<<2)+(race&0x0F) \| gender<<7`), 2×u8 active-weapon bytes, `u8 0`, `u8 con`, `u8 0` | Empty account: 16 zero bytes only. |
| (opt) | C→S | 0xFF CharacterCreateRequest | 1.126 layout is in CharacterCreateRequestHandler.cs:263-326 (`CreationCharacterData`). Starts with `u8 slot` (UI index incl. realm*10), `intLEPascal name`, `u32 0x18`, … `u8 Operation` (1=create, 2=customize, 3=delete), … The three location/class/race strings are skipped as 5 bytes each, so send `01 00 00 00 00`. | Name must match `^[A-Z][a-zA-Z]`, length ≥ 3, or the client is disconnected (and banned if BAN_HACKERS). Success is answered with 0x2A again; the client should then re-send 0xFC. Also 0xCB DuplicateNameCheck → 0xCC DupNameCheckReply (`FillString(name,24)`, `u8 result`) (PacketLib1126.cs:35-46). |
| 7 | C→S | 0x10 CharacterSelectRequest | Content ignored (CharacterSelectRequestHandler.cs:8-16); send e.g. 0x00 or a name | Needs Account. Replies 0x2A LoginGranted, then **0x28 SessionID** (`u16 **LE** sessionId`, PacketLib168.cs:133-140). Optional, but it is the only way to learn sessionId (needed for UDP and to mirror in position packets). |
| 8 | C→S | 0x9D RegionListRequest | `u8 uiSlot` (0-9 → slot 100+, 0x0A-0x13 → 200+, 0x14+ → 300+) (RegionListRequestHandler.cs:10-19) | Status None but dereferences Account. Replies **0xB1 ClientRegion** (PacketLib1126.cs:329-347): `intLEPascal ip`, `u32LE port`, `u32LE port`. Optional; keep using the same TCP socket. |
| 9 | C→S | 0xD4 WorldInitRequest | `u8 charIndex` (Alb 0-9, Mid 10-19, Hib 20-29; slot = Realm*100 + idx - (Realm*10-10)) (WorldInitRequestHandler.cs:154-177) | Needs Account. Only works while state is CharScreen (or Playing). **Async:** loads the player from the DB, then state → WorldEnter, then `AddToWorld`. |
| 10 | S→C | burst | **0x20 PositionAndObjectID** (PacketLib1124.cs:441-487): `f32LE x, y, z`, `u16BE objectId`, `u16BE heading`, `u16BE zoneXoff/0x2000`, `u16BE zoneYoff/0x2000` (dungeons, else 0), `u16BE regionSkin`, `u8 flags` (0x80 diving enabled \| underwater), `u8 0` (or `bytePascal serverName` if housing), `u8 0` ×4. Then 0xB6 MaxSpeed (`u16BE pct`, `u8 turnDisabled`, `u8 waterSpeed`), 0x02 inventory, skills, 0xFA money, 0xFB stats, and so on (WorldInitRequestHandler.cs:114-149). | **Wait for 0x20 before sending 0xBF.** GameOpen is silently ignored unless the state is already WorldEnter. |
| 11 | C→S | 0xBF GameOpenRequest | `u8 udpFlag` (send 0 for TCP-only; 1 sets UdpConfirm) (GameOpenRequestHandler.cs:6-20) | Requires WorldEnter. State → **Playing**. Replies **0x2D GameOpenReply** (`u8 0`), then 0xAD status update (posted next tick), 0x91 points. |
| 12 | C→S | 0xE8 PlayerInitRequest | empty (or 1 byte) | Needs Player. Sends points, region color scheme, 0x89 revive, **0x7E Time** (`u32BE gameTime`, `u32BE dayIncrement`), group info, MOTD, then **0x2B CharacterInitFinished** (`u8 0`) (PlayerInitRequestHandler.cs:18-130). After 0x2B the client is in-world. |
| 13 | loop | 0xA9 PositionUpdate (C→S) every 200 ms while moving and at least every ~1 s while idle; 0xA3 Ping every ~10-30 s | see §6 | |

Optional UDP:
- C→S 0x14 UDPInitRequest over UDP: 1.124+ payload is `char[20] localIP` + `u16BE localPort` (UDPInitRequestHandler.cs:10-14), 34 bytes total, using the session id from 0x28.
- Server replies **0x2F UDPInitReply** with `u64LE (DateTime.Now.Ticks>>24)` (PacketLib1125.cs:371-385), forced to UDP if an endpoint is known, else TCP.
- 0xF2 UDPPingRequest (empty payload on 1.124+) refreshes `UdpPingTime`/`UdpConfirm`. `UdpConfirm` expires after 70 s (ClientService.cs:95-96).
- The handler type (TCP/UDP) is **not enforced** (`ProcessInboundPacket`, PacketProcessor.cs:160-202), so any opcode can arrive on either transport.

Ping (PingRequestHandler.cs:15-21):
- C→S 0xA3: payload `4 bytes skipped`, `u32BE timestamp`. Send at least 8 bytes, e.g. 12.
- S→C **0x29 PingReply** (PacketLib168.cs:142-151): `u32BE timestamp`, 4×00, `u16BE (clientSeq+1)`, 6×00.

Quit: S→C 0xA4 `u8 totalOut, u8 level`. Client crash notice is 0x37 (disconnects).

Minimal path: F4 → 22, A7 → 2A, FC(realm) → FC, D4(idx) → 20…, BF(0) → 2D, E8 → 2B. Optionally add 10 → 2A,28 (gets sessionId) and 9D → B1 before D4.

## 5. Gating (PacketPreprocessing)
- packets/Server/PacketPreprocessing.cs:5-99 defines `eClientStatus`: `None=0` passes, `LoggedIn=1` needs `client.Account != null`, `PlayerInGame=2` needs `client.Player != null`.
- A failed check drops the packet silently (PacketProcessor.cs:182-188). An unregistered opcode is also dropped silently.
- Status per opcode (attributes in packets/Client/168/*.cs):
  - **None:** F4 CryptKey, A7 Login, A3 Ping, 9D RegionList (crashes without Account), BF GameOpen, 37 ClientCrash, 14 UDPInit, F2 UDPPing, 0xC2 (0x6A^168 BadNameCheck, attribute defaults to None), 0xF5 SiegeCommand.
  - **LoggedIn:** FC CharOverview, 10 CharSelect, FF CharCreate, C0 CharDelete, CB DupNameCheck, D4 WorldInit.
  - **PlayerInGame:** everything else, including A9, BA, E8, AF command, B0 target, 7A interact, 74 attack, 7D spell, 71 slot, BB skill, D5 CreatePlayerRequest, BE CreateObjectRequest.
- Additional state checks inside handlers:
  - WorldInit only in CharScreen or Playing (:15).
  - GameOpen only in WorldEnter (:8).
  - PositionUpdate only if `Player.ObjectState==Active && ClientState==Playing` (:18).
  - `SendRawMessage` is suppressed in CharScreen (PacketLib1127.cs:41).
- Concurrency:
  - Two logins with the same username in flight cause a disconnect (`_clientsLoggingIn`, LoginRequestHandler.cs:165-172).
  - An account that is already online gets 0x0B (AccountAlreadyLoggedIn) or 0x11 (AccountIsInLogoutProcedure).
  - Several handlers are `async void`: Login (A7), WorldInit (D4), and `SendCharacterOverview`. **Always wait for the reply** before sending the next step.

## 6. Movement packets and anti-cheat / timeouts

**C→S 0xA9 PositionUpdate, ≥1.127** (PlayerPositionUpdateHandler.cs:58-81):
```
f32LE x, f32LE y, f32LE z            (absolute world coords)
f32LE speed                          (sets CurrentSpeed)
f32LE zSpeed                         (fall speed; negative = falling)
u16BE sessionId (skipped)
u16BE objectId  (skipped, 1.127+)
u16BE zoneId                         (MUST be a valid zone ID or you get kicked to char screen, :91-103)
u8    stateFlags  (STRAFE_R 0x80 | STRAFE_L 0x40 | STRAFE_FULL 0x20 | SIT 0x10 | JUMP 0x08 | SWIM 0x04; combos: DEAD=0x14, RIDING=0x18, FLYING=0x0C, CLIMB=0x1C) (:753-766)
u8    unknown
u16BE fallingDamage (bit15 set = landed; fall damage if -zSpeed > 500)
u16BE heading (0..4095)
u8    actionFlags (TORCH 0x80, TELEPORT 0x40, TARGET_IN_VIEW 0x30, GT_IN_VIEW 0x08, PET_IN_VIEW 0x04, DIVING 0x02, WIREFRAME 0x01)
u8,u8 unknown, u8 health, then 2 + 2 trailing bytes   => payload ≈ 40 bytes
```
The client needs a zone table to compute zoneId; the server loads zones from the `DbZone` table (GameServer/world/WorldMgr.cs:351).

**C→S 0xBA HeadingUpdate, ≥1.127** (PlayerHeadingUpdateHandler.cs:10-22): `u16 session`, `u16 target`, `u16BE heading`, `u8 unk`, `u8 actionFlags`, `u8 steedSlot`, `u8 stateFlags>>2`. This does **not** refresh the link-death timer.

**Things a headless client can trip:**
1. **Soft link-death after 5 s without 0xA9.** `SOFT_LINK_DEATH_THRESHOLD = 5000` (ECS-Components/PlayerMovementComponent.cs:15, 54-61). Only 0xA9 sets `LastPositionUpdatePacketReceivedTime` (:137). The timestamp is reset on entering Playing and in AddToWorld (GameClient.cs:44-49, GamePlayer.cs:7786). If it lapses, the next 0xA9 is swallowed and the player is teleported back to the link-death location (`IsPositionUpdateFromPacketAllowed`, GamePlayer.cs:824-834); UseSkill, UseSlot and UseSpell are blocked the same way. **Send 0xA9 at least every 1 s while idle.**
2. **Hard timeout after 150 s without ping.** `HARD_TIMEOUT = 150000` on `PingTime` in every state (ClientService.cs:18, 741-749). `PingTime` is refreshed only by 0xA3, by LoginRequest, and by state changes into Playing or CharScreen.
3. **Speed hack monitor** (gameutils/PlayerMovementMonitor.cs:84-145, constants :35-43):
   - Each XY change is sampled using server receive time. A violation is `dist² > (maxSpeed*1.15*(dt+tick)/1000)²`.
   - 6 violations within 1500 ms teleport the player back via `MoveTo`. After 5 consecutive teleports the player is kicked (`SendPlayerQuit` + disconnect).
   - `maxSpeed = Player.MaxSpeed`, with base `PLAYER_BASE_SPEED = 191` units/s (GamePlayer.cs:8133) scaled by the 0xB6 MaxSpeed percentage.
   - Mitigation: step at a steady cadence of about 200 ms (the server's `BROADCAST_MINIMUM_INTERVAL` comment says clients send every 200 ms at most) with displacement ≤ 0.9 × speed × dt.
   - When the server teleports the player (0x04 CharacterJump `u32BE x, u32BE y, u16BE oid, u16BE z, u16BE heading, u16BE house`, PacketLib168.cs:519-541; or a new 0x20), **snap the local position** to it, otherwise violations keep accumulating.
   - Samples processed in the same tick overwrite each other (:70-76).
4. **Forged flags.**
   - FLYING without /debug, or RIDING when not riding, are stripped. With `BAN_HACKERS` (default false) they ban (:690-718).
   - The pre-1.124 path bans "HACK_FLY"; that path is not used at 1.127.
   - DEAD is stripped if HP > 0.
5. **Unknown zoneId** in 0xA9 kicks the player to the character screen.
6. **Idle kick** (`KICK_IDLE_PLAYER_STATUS`, default false, 60 min; ClientService.cs:751-760). Activity is any XY movement.
7. **Account limits.**
   - Auto-creation is limited to 1 account per IP per **15 min** (`time_between_account_creation_sameip`) and 20 per IP (ServerProperties.cs:2401-2419; LoginRequestHandler.cs:296-325). For a bot farm, pre-create accounts in the `account` table (the plaintext password is accepted and hashed on first login, :366-369) or change these properties.
   - `MAX_PLAYERS` defaults to 4000.
   - Also checked: `CLIENT_VERSION_MIN/MAX`, `CLIENT_TYPE_MAX`, `STAFF_LOGIN`, `TESTER_LOGIN`, `FORCE_DISCORD_LINK` and bans (serverrules/AbstractServerRules.cs:51-200).
8. **Malformed character name** in 0xFF disconnects the client.

## 7. Version recommendation: 1.127
- In server code, 1.127, 1.128 and 1.129 behave the same apart from one packet: 1128 overrides only `SendVersionAndCryptKey` (4 trailing zero bytes instead of 3), and 1129 is empty.
- The last behavioural branches are `>= Version1127`:
  - position/heading layout: ObjectID and target fields (PlayerPositionUpdateHandler.cs:67, PlayerHeadingUpdateHandler.cs:13)
  - PlayerCommandHandler.cs:12, HousingMenuRequestHandler.cs:51
  - LoginGranted type workaround and chat formatting (PacketLib1127.cs)
- Code comments describe observed 1.127 behaviour: eLoginError list (IPacketLib.cs:229), eChatLoc note, GameOpen flag "(1.127)", UDP ping interval "1.127 = 65 seconds" (ClientService.cs:94). 1.127 is the client OpenDAoC was verified against.
- Emulate raw version `01 01 1B`, clientType `0x06` (LotM; avoids `region.Expansion` gating in the character overview). Keep the version byte configurable; 1.128/1.129 only change the 0x22 reply length.

## 8. Key server→client opcodes for the client decoder
Full list in GameServer/packets/Server/IPacketLib.cs:12-127; client opcodes at :131-213, with the `^168` note.

0x22 CryptKey, 0x28 SessionID (u16 LE!), 0x29 PingReply, 0x2A LoginGranted, 0x2B CharacterInitFinished, 0x2C LoginDenied, 0x2D GameOpenReply, 0x2F UDPInitReply, 0x20 PositionAndObjectID, 0x04 CharacterJump, 0xA9 PlayerPosition (other players, 1.127 layout in PlayerPositionUpdateHandler.cs:611-635), 0xBA PlayerHeading, 0xA1 ObjectUpdate, 0xA2 RemoveObject, 0xAF Message, 0xAD CharacterStatusUpdate (PacketLib190.cs:53-75), 0xB6 MaxSpeed, 0xB1 ClientRegion, 0xB7 RegionChanged, 0x7E Time, 0xD4 PlayerCreate, 0xDA NPCCreate, 0xD9 ObjectCreate, 0xE1 ObjectDelete, 0xFC/0xFD CharacterOverview, 0xFE Realm, 0xA4 Quit.