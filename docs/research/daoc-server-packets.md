# OpenDAoC server-to-client packet catalogue for client 1.127 (PacketLib1127 resolution)

Root for all paths: `C:/Users/joshu/Code/daoc-sdk/server/core/GameServer/`. Nothing was modified.

## 0. Wire format, endianness, version selection

**Version detection** (`GameClient.cs:285-340`, `CheckVersion`):
- The first client packet must be at least 17 bytes. If it is 19 bytes or more (1.115c and later), version = `buf[11]*1000 + buf[12]*100 + buf[13]`. For 1.127 the client sends bytes `01 01 1B`, giving 1127.
- `AbstractPacketLib.CreatePacketLibForVersion` (`packets/Server/AbstractPacketLib.cs:72`) finds the class whose `[PacketLib(raw, ver)]` matches that number.
- The enum stops at `Version1129`. 1128 and 1129 also exist, but 1129 is an empty subclass of 1128, and 1128 only overrides `SendVersionAndCryptKey`.

**Inheritance** is a single straight chain: `PacketLib1129 → 1128 → 1127 → 1126 → … → 1100 → 199 → 198 → … → 169 → 168 → AbstractPacketLib`. There are no partial classes. The highest file in the chain that overrides a method wins.

**Server-to-client TCP framing** (`packets/Server/GSTCPPacketOut.cs`):
- Layout: `[u16 BE payloadLen][u8 opcode][payload…]`. `WritePacketLength` writes `Length-3`, which is the payload length without the 3-byte header.
- There is no checksum, no sequence number and no encryption on outbound packets. `EncryptPacket` is never called anywhere.
- For 1.126 and later, the CryptKey packet tells the client encryption is off.
- Packets are concatenated into one send buffer. The maximum is 2048 bytes per packet (`PacketProcessor.cs:493`); larger packets are dropped.

**UDP framing** (`GSUDPPacketOut.cs`): `[u16 BE payloadLen][u16 BE udpCounter][u8 opcode][payload]`. The counter is filled in at `PacketProcessor.cs:483-486`.
- If the client has no confirmed UDP endpoint (`UdpConfirm` is false), every UDP packet is converted to TCP by `ProcessUdpAsTcpPacket` (`PacketProcessor.cs:376-433`). The 2-byte counter is stripped and the packet looks identical to a TCP packet.
- **A headless client can skip UDP init entirely and receive everything (0xA1, 0xA9, 0xBA, 0x2F) over TCP.**

**Primitive writers** (`CoreBase/Network/PacketOut.cs`):

| Writer | Encoding |
|---|---|
| `WriteShort` | u16 **big-endian** |
| `WriteInt` | u32 BE |
| `WriteLong` | u64 BE |
| `WriteShortLowEndian` / `WriteIntLowEndian` / `WriteLongLowEndian` | little-endian |
| `WriteFloatLowEndian` | IEEE754 f32 **LE** (used for 1.124+ coordinates) |
| `WritePascalString` | `u8 len` + bytes, max 255, empty string is a single `00` |
| `WritePascalStringIntLE` | `u32 LE (byteLen+1)` + bytes + `00`. Empty string is `u32 0` with **no** trailing NUL |
| `WriteString(s)` | bytes + `00` (C string) |
| `WriteString(s, max)` / `WriteNonNullTerminatedString` | raw bytes, **no** NUL |
| `FillString(s, n)` | fixed n bytes, NUL-padded, truncated |

- Text encoding is **Windows-1252** (`CoreBase/Network/BaseServer.cs:17`).
- `GetPacketCode(e)` is the identity mapping (`AbstractPacketLib.cs:32`), so server opcodes are not version-remapped.
- `AbstractPacketLib.ParseVersion(1127, true) = 1` and `ParseVersion(1127, false) = 12`. These two bytes appear only in `SendLoginDenied`.

## 1. Opcode enum (`packets/Server/IPacketLib.cs:12-133`, `eServerPackets : byte`)

| Opcode | Name |
|---|---|
| 0x02 | InventoryUpdate |
| 0x04 | CharacterJump |
| 0x12 | MovingObjectCreate |
| 0x13 | MasterLevelWindow |
| 0x15 | EquipmentUpdate |
| 0x16 | VariousUpdate |
| 0x17 | MerchantWindow |
| 0x1B | SpellEffectAnimation |
| 0x1E | ConsignmentMerchantMoney |
| 0x1F | MarketExplorerWindow |
| 0x20 | PositionAndObjectID |
| 0x21 | DebugMode |
| 0x22 | CryptKey |
| 0x28 | SessionID |
| 0x29 | PingReply |
| 0x2A | LoginGranted |
| 0x2B | CharacterInitFinished |
| 0x2C | LoginDenied |
| 0x2D | GameOpenReply |
| 0x2F | UDPInitReply |
| 0x4B | PlayerCreate172 (the PlayerCreate opcode used by 1.124+) |
| 0x4C | VisualEffect |
| 0x4E | ControlledHorse |
| 0x70 | GroupMemberUpdate |
| 0x72 | SpellCastAnimation |
| 0x73 | InterruptSpellCast |
| 0x74 | AttackMode |
| 0x75 | ConcentrationList |
| 0x7B | TrainerWindow |
| 0x7E | Time |
| 0x7F | UpdateIcons |
| 0x81 | Dialog |
| 0x83 | QuestEntry |
| 0x86 | FindGroupUpdate |
| 0x88 | PetWindow |
| 0x89 | PlayerRevive |
| 0x8D | PlayerModelTypeChange |
| 0x91 | CharacterPointsUpdate |
| 0x92 | Weather |
| 0x99 | DoorState |
| 0x9E | ClientRegions (legacy, unused for 1.127) |
| 0xA1 | ObjectUpdate |
| 0xA2 | RemoveObject |
| 0xA4 | Quit |
| 0xA9 | PlayerPosition |
| 0xAD | CharacterStatusUpdate |
| 0xAE | PlayerDeath |
| 0xAF | Message |
| 0xB1 | ClientRegion |
| 0xB6 | MaxSpeed |
| 0xB7 | RegionChanged |
| 0xBA | PlayerHeading |
| 0xBC | CombatAnimation |
| 0xBD | Encumberance |
| 0xC3 | BadNameCheckReply |
| 0xC4 | DetailWindow |
| 0xC5 | AddFriend |
| 0xC6 | RemoveFriend |
| 0xC8 | Riding |
| 0xC9 | SoundEffect |
| 0xCC | DupNameCheckReply |
| 0xD0 | CheckLOSRequest |
| 0xD1 | HouseCreate |
| 0xD3 | PlaySound |
| 0xD4 | PlayerCreate (legacy) |
| 0xD6 | DisableSkills |
| 0xD8 | DelveInfo |
| 0xD9 | ObjectCreate |
| 0xDA | NPCCreate |
| 0xDB | ModelChange |
| 0xDE | ObjectGuildID |
| 0xE1 | ObjectDelete |
| 0xE2 | EmblemDialogue |
| 0xE3 | SiegeWeaponAnimation |
| 0xEA | TradeWindow |
| 0xEC | ChangeGroundTarget |
| 0xEE | ObjectDataUpdate |
| 0xEF | RegionSound |
| 0xF0 | CharacterCreateReply |
| 0xF3 | TimerWindow |
| 0xF5 | SiegeWeaponInterface |
| 0xF6 | ChangeTarget |
| 0xF7 | HelpWindow |
| 0xF9 | EmoteAnimation |
| 0xFA | MoneyUpdate |
| 0xFB | StatsUpdate |
| 0xFC | CharacterOverview1126 |
| 0xFD | CharacterOverview (legacy) |
| 0xFE | Realm |
| 0x03 / 0x05 / 0x08 / 0x09 / 0x0A / 0x0F / 0x18 | Housing |
| 0x45 / 0x46 / 0x59 | Minotaur relics |
| 0x49 / 0x4A / 0x61-0x6E | Keeps and warmap |

Client opcodes live in the same file, at lines 135-219 in `eClientPackets`. Examples: LoginRequest 0xA7, CryptKeyRequest 0xF4, CharacterSelect 0x10, WorldInit 0xD4, PlayerInit 0xE8, PositionUpdate 0xA9, PingRequest 0xA3, CheckLos 0xD0.

## 2. Which override 1.127 uses (resolution table)

| Method | Winning file:line | Opcode |
|---|---|---|
| SendVersionAndCryptKey | **1126**:52 for 1126/1127 clients; 1128:8 for 1128/1129 clients | 0x22 |
| SendLoginGranted(byte) | **1127**:13 | 0x2A |
| SendLoginDenied | 168:84 | 0x2C |
| SendSessionID | 168:133 | 0x28 |
| SendPingReply | 168:142 | 0x29 |
| SendRealm | 1125:61 | 0xFE |
| SendCharacterOverview | **1126**:78 (async) | 0xFC |
| SendDupNameCheckReply | 1126:35 | 0xCC |
| SendCharCreateReply | 168:385 | 0xF0 |
| SendRegions | **1126**:329 | 0xB1 |
| SendRegionChanged | **174**:385 (calls SendRegions first) | 0xB7 |
| SendGameOpenReply | 168:487 | 0x2D |
| SendUDPInitReply | 1125:371 | 0x2F (UDP-class packet) |
| SendPlayerPositionAndObjectID | **1124**:441 | 0x20 |
| SendPlayerJump | 168:519 | 0x04 |
| SendPlayerInitFinished | 168:543 | 0x2B |
| SendTime | 168:576 | 0x7E |
| SendMessage / SendRawMessage | **1127**:29/39 | 0xAF |
| SendPlayerCreate | **1124**:333 | **0x4B** |
| SendNPCCreate | **1124**:121 | 0xDA |
| SendObjectCreate | **176**:73 | 0xD9 |
| SendObjectUpdate | 168:724 (never overridden) | 0xA1 (UDP by default) |
| SendObjectRemove | 168:877 | 0xA2 |
| SendObjectDelete | 168:2864 | 0xE1 |
| SendObjectGuildID | 168:703 | 0xDE |
| SendLivingEquipmentUpdate | **1124**:52 | 0x15 |
| SendLivingDataUpdate | 171:343 | 0xEE |
| SendModelAndSizeChange | 168:990 | 0xDB |
| SendEmoteAnimation | 168:1001 | 0xF9 |
| SendCharStatsUpdate / SendCharResistsUpdate | **175**:188 / 175:331 | 0xFB |
| SendUpdatePoints | **190**:33 | 0x91 |
| SendStatusUpdate(byte) | **190**:53 (the no-arg version is 168:1252 and uses sit flag 0x02) | 0xAD |
| SendUpdateMoney | 168:1186 | 0xFA |
| SendUpdateMaxSpeed | 168:1201 | 0xB6 |
| SendEncumbrance | 168:2339 | 0xBD |
| SendUpdatePlayer | **179**:23 | 0x16 sub 0x03 |
| SendUpdatePlayerSkills | **1112**:21 | 0x16 sub 0x01 (+ sub 0x02 via NonHybrid) |
| SendNonHybridSpellLines | **1112**:189 | 0x16 sub 0x02 |
| SendUpdateCraftingSkills | 168:2280 | 0x16 sub 0x08 |
| SendUpdateWeaponAndArmorStats | **1126**:349 | 0x16 sub 0x05 |
| SendGroupWindowUpdate | 1125:387 | 0x16 sub 0x06 |
| SendGroupMembersUpdate / IconsUpdate | 168:1644/1670, writers from 1125:418/456 | 0x70 |
| SendInventoryItemsUpdate(dict, win) | **189**:90 → 189:129 partial | 0x02 |
| SendInventoryItemsUpdate(win, list) / SendInventorySlotsUpdate | 168:1740/1696 → **189**:160 SendInventorySlotsUpdateRange | 0x02 |
| WriteItemData / WriteTemplateData | **1124**:836 / 1124:996 | n/a |
| SendDialogBox | 168:1484 | 0x81 |
| SendCustomDialog | 168:1504 | 0x81 |
| SendQuestListUpdate | **173**:533 → SendTaskInfo (**184**:59) + 168:1546(offset 1) → SendQuestPacket (**1124**:490) | 0x83 |
| SendQuestUpdate / SendQuestRemove | 173:539/544 (index+1) | 0x83 |
| SendSpellCastAnimation | 168:1276 | 0x72 |
| SendSpellEffectAnimation | **174**:410 | 0x1B |
| SendInterruptAnimation | 168:2654 | 0x73 |
| SendCombatAnimation | **186**:54 | 0xBC |
| SendAttackMode | 168:371 | 0x74 |
| SendLosCheckRequest | 168:1533 → `gameutils/LosCheckHandler.cs:102` | 0xD0 |
| SendMerchantWindow | **1125**:607 | 0x17 |
| SendTradeWindow / SendCloseTradeWindow | **1109**:23 / 168:1979 | 0xEA |
| SendTrainerWindow | **1110**:146 → base **1105**:29 | 0x7B (multiple) |
| SendConcentrationList | **191**:83 | 0x75 |
| SendUpdateIcons (both overloads) | **1110**:46/51 | 0x7F |
| SendDelveInfo | **1110**:36 | 0xD8 |
| SendCustomTextWindow | **181**:40 | 0xC4 |
| SendDisableSkill | 168:2664 | 0xD6 |
| SendPetWindow | 181:102 | 0x88 |
| SendPlayerDied / Revive | 168:1988/2002 | 0xAE / 0x89 |
| SendPlayerQuit | 168:864 | 0xA4 |
| SendRiding | 168:1304 | 0xC8 |
| SendChangeTarget / SendChangeGroundTarget | 168:2924/2934 | 0xF6 / 0xEC |
| SendTimerWindow | 168:2413 | 0xF3 |
| SendDebugMode | 168:960 | 0x21 |
| SendPlaySound | 168:3313 | 0xD3 |

Relayed player movement does not go through PacketLib. It is built in `packets/Client/168/PlayerPositionUpdateHandler.cs:690` (0xA9) and `PlayerHeadingUpdateHandler.cs:69+` (0xBA).

## 3. Exact layouts (1.127). Offsets are into the payload; BE unless marked LE.

### Login and character screen

**0x22 CryptKey** (1126:52; this is what a 1.127 client receives)
- `u32LE 0` (encryption off)
- `"1.127"` as exactly 5 raw bytes, no NUL
- `u8 0` revision, `u8 0`, `u8 0` build
- Total 12 bytes. The 1128 version adds one more `u8 0`.

**0x2A LoginGranted** (1127:13)
- `pascal accountName`
- `pascal ServerNameShort`
- `u8 0x05` (server id)
- `u8 type` (color, or 7 if color is 0; 0x07 allows chars in all realms; 01 mordred, 03 gaheris)
- `u8 0x00` (0 = subscribed, 1 = trial)
- Sent on login (`LoginRequestHandler.cs:436`) and again on CharacterSelect, followed by SessionID (`CharacterSelectRequestHandler.cs:15-16`).

**0x2C LoginDenied** (168:84)
- `u8 eLoginError`, `u8 0x01`, `u8 1`, `u8 12`, `u8 0`
- Error codes are listed at `IPacketLib.cs:224-254`: 01 bad password, 02 invalid account, 05 wrong version, 0B already logged in, 0C full, 0D closed, 14 banned, 0xAA service unavailable, and others.

**0x28 SessionID**: `u16 **LE** sessionId` (note: little-endian here).

**0x29 PingReply**
- `u32 BE timestamp` (echo of the client value)
- `00×4`
- `u16 BE (clientSeq+1)`
- `00×6`

**0xFE Realm** (1125): `u8 realm` (0 none, 1 Alb, 2 Mid, 3 Hib), then `00×12`.

**0xFC CharacterOverview1126** (1126:78)
- This method is `async void`: the packet is sent after a DB query, so it may arrive late.
- With no characters on the account: `u32LE×4 = 0` and nothing else.
- Header: `u32LE realmSwitcherBit` (1 if chars are allowed in all realms), then `u32LE 0`, `u32LE 0`, `u32LE 0`.
- Then exactly 10 slots, account slots `realm*100+0` through `realm*100+9`.
- An empty slot is a single `u8 0`.
- A filled slot (field order):
  - `u8 level`
  - `pascalIntLE name`
  - `u32LE 0x18`
  - `u8 1`
  - `u8 eyeSize`, `lipSize`, `eyeColor`, `hairColor`, `faceType`, `hairStyle`
  - `u8 (bootsExt<<4)|glovesExt`
  - `u8 (torsoExt<<4)|hoodUp`
  - `u8 customisationStep`
  - `u8 mood`
  - `00×13`
  - `pascalIntLE location` (≤22 chars), `pascalIntLE className`, `pascalIntLE raceName`
  - `u16LE model`, `u8 regionId`, `u8 expansion` (0, or region.Expansion+1)
  - `u16LE` × 8: helmModel, glovesModel, bootsModel, **RHcolor**, torsoModel, cloakModel, legsModel, armsModel
  - `u16LE` × 8 colors: helm, gloves, boots, LH, torso, cloak, legs, arms
  - `u16LE` × 4 weapon models: RH, LH, 2H, Ranged
  - `u8` × 8 stats: STR, DEX, CON, QUI, INT, PIE, EMP, CHA
  - `u8 class`, `u8 realm`
  - `u8 ((race&0x10)<<2) + (race&0x0F) | gender<<7`
  - `u8 activeR`, `u8 activeL`: 2H gives 02 02, ranged gives 03 03, otherwise RH?00:FF and LH?01:FF
  - `u8 0` (SI flag)
  - `u8 CON`
  - `u8 0`

**0xCC DupNameCheckReply** (1126): `FillString(name,24)`, `u8 result`.

**0xF0 CharCreateReply**: `FillString(name,24)`.

### World entry

The sequence is in `packets/Client/168/WorldInitRequestHandler.cs:114-149` and `PlayerInitRequestHandler.cs:21-64`.

**0xB1 ClientRegion** (1126:329)
- `pascalIntLE ip` (local addresses are replaced with the socket's local IP)
- `u32LE port`
- `u32LE port`
- Sent in reply to RegionListRequest (`RegionListRequestHandler.cs:19`, character region only) and before every 0xB7.

**0xB7 RegionChanged** (174:385), 14 bytes:

| Offset | Type | Field |
|---|---|---|
| 0 | u16 | regionSkin |
| 2 | u16 | ZoneSkinID (current zone, or 0) |
| 4 | u16 | 0 |
| 6 | u16 | 0x0001 |
| 8 | u8 | 0x0C |
| 9 | u8 | 0 |
| 10 | u16 | 0xFFBF |

**0x20 PositionAndObjectID** (1124:441):

| Offset | Type | Field |
|---|---|---|
| 0 | f32LE | X (global) |
| 4 | f32LE | Y |
| 8 | f32LE | Z |
| 12 | u16 | **your ObjectID** |
| 14 | u16 | heading |
| 16 | u16 | dungeon zone XOffset/0x2000 (0 if not a dungeon) |
| 18 | u16 | dungeon zone YOffset/0x2000 |
| 20 | u16 | regionSkin |
| 22 | u8 | flags (0x80 diving enabled, 0x01 underwater) |
| 23 | u8 or pascal | 0, or `pascal ServerName` in a housing region |
| then | u8×4 | 0 |

**0x2D GameOpenReply**: `u8 0`. **0x2B CharacterInitFinished**: `u8 mobs` (0).

**0x7E Time**: `u32 gameTimeMs`, then `u32 dayIncrement`. gameTimeMs is milliseconds into a 24h game day, so it wraps at 86,400,000 (`world/DayNightCycleTimer.cs:13`).

**0x2F UDPInitReply** (1125): `u64LE DateTime.Now.Ticks>>24`. Sent with forced UDP; with no UDP endpoint it is converted to TCP.

**0x04 CharacterJump** (teleport or correction):
- `u32 X`, `u32 Y` (global; 0 when headingOnly)
- `u16 objectId`
- `u16 Z`
- `u16 heading`
- `u16 houseNumber`

### Objects

**0x4B PlayerCreate** (1124:333; 1.124+ uses 0x4B, not 0xD4):

| Offset | Type | Field |
|---|---|---|
| 0 | f32LE | X |
| 4 | f32LE | Y |
| 8 | f32LE | Z |
| 12 | u16 | sessionId |
| 14 | u16 | objectId |
| 16 | u16 | heading |
| 18 | u16 | model |
| 20 | u8 | level |
| 21 | u8 | flags: `(realm&3)<<2`, 0x01 dead, 0x02 underwater, 0x10 stealth, 0x20 wireframe, 0x40 vampiir |
| 22 | u8×7 | face: eyeSize, lipSize, mood, eyeColor, hairColor, faceType, hairStyle |
| 29 | u8×3 | 0 |
| 32 | pascal×5 | name, guild, lastName, prefix, title |

- After the strings: if on a horse, `u8 horseId`, `u8 barding` (|emblem bit), `u16 color` (LE when it is the guild emblem, BE otherwise), `u8 saddle`, `u8 saddleColor`. If not on a horse, a single `u8 0`.
- It is followed by 0xDE ObjectGuildID. If the player is mounted, the steed's 0xDA is sent first.

**0xDA NPCCreate** (1124:121):

| Offset | Type | Field |
|---|---|---|
| 0 | u16 | oid |
| 2 | u16 | speed |
| 4 | u16 | heading |
| 6 | u16 | Z |
| 8 | u32 | X (global) |
| 12 | u32 | Y (global) |
| 16 | u16 | speedZ |
| 18 | u16 | model |
| 20 | u8 | size |
| 21 | u8 | level (\|0x80 statue) |
| 22 | u8 | flags: realm<<6, 0x01 ghost, 0x02 has inventory (expect a 0x15 for this NPC), 0x04 torch, 0x10 peace, 0x20 flying |
| 23 | u8 | 0x20 (max stick) |
| 24 | u8 | flags2: 0x01 cant-target, 0x02 dont-show-name, 0x04 stealthed, 0x08 quest available, 0x10 quest finish, 0x80 pet/controlled (any owner) |
| 25 | u8 | flags3: 0x01 lesson, 0x02 lore, 0x20 pending |
| 26 | u16 | 0 |
| 28 | pascal | name (≤47; GMs see `[name]-DOR-NON`) |
| then | pascal | guildName (≤47) |
| then | u8 | 0 |

- Moving objects such as boats use 0x12 instead.
- On PvP servers it may be followed by 0xDE fake-guild packets.

**0xD9 ObjectCreate** (176:73; static items, doors, loot):

| Offset | Type | Field |
|---|---|---|
| 0 | u16 | oid |
| 2 | u16 | emblem |
| 4 | u16 | heading |
| 6 | u16 | Z |
| 8 | u32 | X |
| 12 | u32 | Y |
| 16 | u16 | model (\|0x8000 underwater NPC) |
| 18 | u16 | flags: realm<<4, 0x01 underwater, 0x04 you own this timed loot, 0x08 keep banner |
| 20 | u32 | `(emblem&0x10000)<<9` |
| 24 | pascal | name (≤48) |
| then | u8 + u32 or u8 | doors: `u8 4` + `u32 doorId`; otherwise `u8 0` |

**0xA1 ObjectUpdate** (168:724), 24 bytes. Used for NPCs, items and doors, never players. It is resent every `world_npc_update_interval` (5000 ms default) and when movement changes; static objects every 30000 ms. It is UDP by default, so it arrives over TCP if UDP is unset (`ECS-Services/ClientService.cs:665,820-825`).

| Offset | Type | Field |
|---|---|---|
| 0 | u16 | speed: low bits = horizontal speed, bit15 = zSpeed negative, bits12-14 = `(zSpeed&0x70)<<8` |
| 2 | u16 | heading: low 12 bits = heading, high 4 bits = `zSpeed&0xF` (zSpeed = velocity.Z/4) |
| 4 | u16 | X offset in current zone |
| 6 | u16 | destination X offset in target zone |
| 8 | u16 | Y offset in zone |
| 10 | u16 | destination Y offset |
| 12 | u16 | Z |
| 14 | u16 | destination Z |
| 16 | u16 | objectId |
| 18 | u16 | targetId (non-zero means attack state; 65535 is a dummy) |
| 20 | u8 | health % |
| 21 | u8 | flags: realm<<6, 0x01 cant-target/statue, 0x02 no-name, 0x04 = bit8 of zoneSkin, 0x08 = bit8 of targetZoneSkin, 0x10 underwater, 0x20 flying |
| 22 | u8 | zoneSkin low byte |
| 23 | u8 | targetZoneSkin low byte |

- Zone skin IDs are 9 bits: `zoneSkin = b22 | ((flags&0x04)<<6)` and `targetZoneSkin = b23 | ((flags&0x08)<<5)`.
- Speed 0 means the NPC is stationary at the given position. Otherwise it is moving toward the destination point.

**0xA2 RemoveObject**: `u16 oid`, `u16 type` (0 dead NPC, 1 live NPC, 2 player). Callers: `GameObject.cs:642`, `GameNPC.cs:2044`, `GamePlayer.cs:1927/1975/7986`.

**0xE1 ObjectDelete**: `u16 oid`, `u16 1`. Used for stealth and invalid targets.
- **The server does not send remove packets when an NPC leaves visibility (6000 units).** The client must cull objects itself, by distance over 6000 or by going without a 0xA1 for well over 5 s.

**0xA9 PlayerPosition** (relayed other players; `PlayerPositionUpdateHandler.cs:690`, built for viewers on 1.127+), 40 bytes:

| Offset | Type | Field |
|---|---|---|
| 0 | f32LE | X (global) |
| 4 | f32LE | Y |
| 8 | f32LE | Z |
| 12 | f32LE | speed |
| 16 | f32LE | fallSpeed |
| 20 | u16 | sessionId |
| 22 | u16 | objectId |
| 24 | u16 | zone ID (`CurrentZone.ID`, not skin) |
| 26 | u8 | stateFlags |
| 27 | u8 | 0 |
| 28 | u16 | steed seat |
| 30 | u16 | raw heading (or the steed's oid when riding) |
| 32 | u8 | actionFlags |
| 33 | u8 | RP flag |
| 34 | u8 | 0 |
| 35 | u8 | health% \| 0x80 if in attack state |
| 36 | u8 | mana % |
| 37 | u8 | endurance % |
| 38 | u16 | 0 |

- stateFlags (`:784`): 0x80 strafe right, 0x40 strafe left, 0x20 strafe full speed, 0x10 sit, 0x08 jump, 0x04 swim. Combinations: dead = 0x14, riding = 0x18, flying = 0x0C, climbing = 0x1C.
- actionFlags (`:800`): 0x80 torch, 0x40 teleport, 0x30 target in view, 0x08 ground target in view, 0x04 diving, 0x02 stealthed, 0x01 wireframe.
- The inbound format from the client is the same, read at `:58-79`.

**0xBA PlayerHeading** (1.127 build at `PlayerHeadingUpdateHandler.cs:69-83`):
- `u16 sessionId`, `u16 0` (target), `u16 heading`
- `u8 seat`, `u8 actionFlags`, `u8 0`
- `u8 stateFlags>>2`
- `u8 health|0x80`, `u8 mana%`, `u8 endu%`, `u8 0`

**0x15 EquipmentUpdate** (1124:52; NPCs and players)
- `u16 oid`
- `u8 visibleActiveWeaponSlots` (low nibble right-hand slot, high nibble left-hand, 0xF means none)
- `u8 currentSpeed`
- `u8 cloakInvis|helmInvis<<1`
- `u8 hoodUp|quiverSlot`
- `u8 count`
- Per item:
  - `u8 slot` (|0x80 new-emblem flag on LH/cloak)
  - `u16 model` (low 13 bits model; 0x8000 means a u16 texture follows, 0x4000 a u8 texture, 0x2000 a u16 effect)
  - `[u8 extension]`, present only when slot is below 10 or above 13 (armor slots)
  - `[texture]`
  - `[u16 effect]`

**0xEE ObjectDataUpdate** (171)
- `u16 oid`, `u8 0`, `u8 level`
- Then either `pascal guild` + `pascal lastName` (players), `u8 0xFF` (NPC with no string update), or `pascal guild` + `pascal name`.

**0xDE ObjectGuildID**: `u16 oid`, then either `u32 0` or `u16 gid` + `u16 gid`, then `u16 0`.

### Player state

**0xAD StatusUpdate** (190:53), 22 bytes:
- 0 `u8 hp%`, 1 `mana%`, 2 `sitFlag` (0x02 sitting), 3 `endu%`, 4 `conc%`, 5 `0`
- Then u16: 6 maxMana, 8 maxEndu, 10 maxConc, 12 maxHP, 14 HP, 16 endu, 18 mana, 20 conc

**0x91 PointsUpdate** (190:33), 48 bytes:
- `u32 RP`, `u16 levelPermill` (XP toward next level ×1000), `u16 specPts`, `u32 BP`, `u16 realmSpecPts`, `u16 champLevelPermill`
- `u64LE XP`, `u64LE XPnext`, `u64LE 0`, `u64LE 0`

**0xFB StatsUpdate** (175:188), 78 bytes. Stat order: STR, DEX, CON, QUI, INT, PIE, EMP, CHA.
- 8×u16 base, `u16 0`
- 8×u16 buffs, `u16 0`
- 8×u16 item bonuses, `u16 0`
- 8×u8 item caps, `u8 0`
- 8×u8 RA bonuses, `u8 0`
- **byte 72 = 0x00**, `u8 conLostAtDeath`, `u16 maxHP`, `u16 0`

**0xFB resists variant** (175:331), also 78 bytes. Resist order: crush, slash, thrust, heat, cold, matter, body, spirit, energy.
- 9×u16 racial, 9×u16 buff, 9×u16 item, 9×u8 caps, 9×u8 RA
- **byte 72 = 0xFF**, `u8 0`, `u16 0`, `u16 0`
- Tell the two variants apart by byte 72.

**0xFA Money**: `u8 copper`, `u8 silver`, `u16 gold`, `u16 mithril`, `u16 platinum`.

**0xB6 MaxSpeed**: `u16 maxSpeedPercent` (a percentage, not an absolute speed), `u8 turningDisabled`, `u8 waterSpeed`.

**0xBD Encumbrance**: `u16 maxCarry`, `u16 currentWeight`.

**0x16 VariousUpdate** subcodes, header `[sub][count][subtype][x]`:
- **sub 0x03 UpdatePlayer** (179), header `03 0F 00 00`. Entries are pascal strings ("None" means hidden) with u8 values in between:
  - `u8 level`, `pascal name`
  - `u8 maxHP>>8`, `pascal className`
  - `u8 maxHP&FF`, `pascal profession`
  - `u8 0`, `pascal classTitle`
  - `u8 realmLevel`, `pascal realmTitle`
  - `u8 realmSpecPts`, `pascal baseClass`
  - `u8 house>>8`, `pascal guildName`
  - `u8 house&FF`, `pascal lastName`
  - `u8 ML+1`, `pascal raceName`
  - `u8 0`, `pascal guildRank`
  - `u8 0`, `pascal craftGuild`
  - `u8 0`, `pascal craftTitle`
  - `u8 0`, `pascal MLtitle`
  - `u8 0`, `pascal customTitle`
  - `u8 CL+1 or 0`, `pascal CLtitle`
- **sub 0x05 WeaponArmorStats** (1126), header `05 06 00 00`:
  - `u8 wd/256, 0, wd%256, 0` (wd = weapon damage ×100)
  - `u8 ws>>8, 0, ws&FF, 0` (weapon skill)
  - `u8 eaf>>8, 0, eaf&FF, 0` (effective armor factor)
- **sub 0x08 CraftingSkills**: `08 n 03 00`, then per skill `u16 points`, `u8 icon`, `u32 1`, `pascal name`.
- **sub 0x06 GroupWindow** (1125): `06 n`, then per member `pascal name`, `pascal className`, `u16 oid`, `u8 level`.

**0x70 GroupMemberUpdate** (writers in 1125). The packet is a run of records ending in `00`:
- Status record: `u8 0x20|groupIndex`, `u8 hp%`, `u8 mana%`, `u8 endu%`, `u8 status`. Status bits: 0x01 dead, 0x02 mezzed, 0x04 diseased, 0x08 poisoned, 0x10 linkdead, 0x20 in another region (that case sends hp/mana/endu = 0), 0x40 nearsighted.
- Icons record: `u8 0x80|groupIndex`, `u8 n`, then n × (`u8 0`, `u16 icon`).

### Skills (needed to cast spells and use styles)

**0x16 sub 0x01 UpdatePlayerSkills** (1112:21). Builds the "usable skills" list with `GamePlayer.GetAllUsableSkills`.
- One or more packets, each with header `01 [entriesInPacket] [subtype] [firstIndex]`.
- Subtype is **0x63 (99) if more pages follow and 0x03 on the last page**. The code writes count and subtype afterwards, at offsets 4 and 5 of the raw buffer. Packets break at about 1400 bytes; the maximum is 255 entries.
- Entry layouts:

| Entry type | Layout |
|---|---|
| Specialization | `u8 level`, `u16 internalID`, `u8 skillType=0`, `u16 0`, `u8 bonus`, `u16 icon`, `pascal name` |
| Ability | `u8 level`, `u16 internalID`, `u8 skillType` (1 Abilities, 5 AbilitiesSpell, 6 RealmAbilities), `u16 0`, `u8 0`, `u16 icon`, `pascal name` |
| Spell (hybrid list) | `u8 level`, `u16 internalID`, `u8 skillType` (3 spells, 4 songs), `u16 specIndex` (0xFF songs, 0xFE unknown, else index of the spec in this list), `u8 0`, `u16 icon` (InternalIconID or Icon), `pascal name` |
| Style | `u8 specLevelReq`, `u16 internalID`, `u8 2`, `u16 prereq`, `u8 specInternalIndex`, `u16 icon`, `pascal name` |

- Style prereq: 0x100 means none; `attackResult` (plus `(100+styleIdx-specCount)<<8` for style-follows-style) is offensive; `100+x` is defensive; `200+x` is positional.
- `eSkillPage` (`gameutils/Skill/Skill.cs:224`): 0 Spec, 1 Abilities, 2 Styles, 3 Spells, 4 Songs, 5 AbilitiesSpell, 6 RealmAbilities.
- When `ForceTooltipUpdate` is on, a burst of 0xD8 delve packets follows.

**0x16 sub 0x02 spell lines** (1112:189)
- One packet per line, header `02 [nSpells+1] 02 [lineIndex]`.
- Line entry: `u16LE 0`, `u16 lineInternalID`, `u16 0`, `pascal lineName`.
- Per spell: `u16LE level`, `u16 internalID`, `u16 icon`, `pascal name`.
- For a style or ability in the list, the first field is `u16LE (reqLevel + 512 for a style, or + 256 for an ability)`.
- Footer packet: `02 00 63 00`.
- The client UseSpell packet references (lineIndex, spellIndex). UseSkill references the index into the usable-skills list minus the number of specs (see the DisableSkill math at 168:2697).

**0xD6 DisableSkills** (cooldowns)
- Skill form: `u16 0`, `u8 n`, `u8 1`, then n × (`u16 skillIndex` (list index minus specCount), `u16 seconds`).
- Spell form: `u16 seconds`, `u8 n`, `u8 2`, then n × (`u8 lineIndex`, `u8 spellIndex`).

**0x7B TrainerWindow** (1105:29, wrapped by 1110). Several packets in sequence:
1. `[nSpecs][specPts] 00 00`, then per spec `u8 i`, `u8 level`, `u8 level+1`, `pascal name`.
2. `[nRA][realmPts] 01 00`, then per RA `u8 i`, `u8 level`, `u8 cost`, `pascal name` (in `[brackets]` if the requirement is unmet).
3. Per spec, a name-index packet: `[count][specPts] 04 00 [startIndex]` followed by pascal names.
4. `[nSpecs][specPts] 03 00 00`, `49×u8 0xFF`, then per spec `u8 idx`, `u8 count`, `u8 autotrain`, then count × 7-byte entries:
   - Ability: `u8 lvl`, `u16 icon`, `u8 page`, `u8 0`, `u8 0xFD`, `u16 internalID`
   - Spell: `u8 lvl`, `u16 icon`, `u8 page`, `u8 0`, `u8 0xFE` or `0xFF` (songs), `u16 internalID`
   - Style: `u8 lvl`, `u16 icon`, `u8 page`, `u8 openingType`, `u8 openingValue`, `u16 internalID`
5. `[nRA][rp] 05 00`, then per RA `u8 lvl`, `u8 0`, `u8 maxLvl`, maxLvl × `u8 cost`, `pascal name`.

### Combat and spells

**0xBC CombatAnimation** (186:54), 14 bytes:
- `u16 attackerOid` (0 if the attacker is out of range or undetected)
- `u16 defenderOid`
- `u16 attackerWeaponModel`, `u16 defenderWeaponOrShieldModel`
- `u16 **LE** style/animationId`
- `u8 stance`
- `u8 result`: 0 miss, 1 parry, 2 block, 3 evade, 4 fumble, 10 hit unstyled, 11 hit styled (`ECS-Components/Actions/WeaponAction.cs:280-330`)
- `u8 targetHP%`
- `u8 0`
- Special animation IDs: BowPrepare 0x3E80, OneDual 0x3E81, BothDual 0x3E82, BowShoot 0x3E83. For bow prepare and shoot the stance byte carries the flight time.

**0x72 SpellCastAnimation**: `u16 casterOid`, `u16 clientEffect`, `u16 castTime` in **units of 100 ms** (`spells/SpellHandler.cs:1074`), `u16 0`.

**0x1B SpellEffectAnimation** (174, filtered by the client's effect filter)
- `u16 casterOid` (0 if hidden or out of range)
- `u16 clientEffect`
- `u16 targetOid`
- `u16 boltTime`
- `u8 noSound`
- `u8 success`
- The rest of the packet is in the code after 174:470.

**0x73 Interrupt**: `u16 oid`, `u16 1`.

**0x74 AttackMode**: `u8 on`, `00×3`.

**0xAE PlayerDeath**: `u16 victimOid`, `u16 killerOid`, `00×4`.

**0x89 Revive**: `u16 oid`, `u16 0`.

**0xF6 ChangeTarget**: `u16 oid`, `u16 0`.

**0xEC ChangeGroundTarget**: `u32 x`, `u32 y`, `u32 z`.

**0xD0 CheckLOSRequest** (`gameutils/LosCheckHandler.cs:102`): `u16 sourceOid`, `u16 targetOid`, `u16 0`, `u16 0`.
- **The headless client must answer** with client opcode 0xD0: `u16 sourceOid`, `u16 targetOid`, `u16 flags` where `flags&0x100` means LOS is clear (`packets/Client/168/CheckLosResponseHandler.cs`).
- The check times out after `los_check_timeout` = 1500 ms. NPC aggro, pet behaviour and player spell or ranged checks depend on this answer.
- A bot should answer from geometry if it has any, or always answer "true".

### Effects and concentration

**0x7F UpdateIcons** (1110:51)
- Header: `u8 entriesCount`, `u8 0`, `u8 Icons` (a field from 190, always 0), `u8 0`.
- Changed or new entries: `u8 index`, `u8 iconSource` (0xFF for an ability effect with icon ≤5000, otherwise index), `u8 immune/disabled`, `u16 icon`, `u16 remainingSeconds`, `u16 tooltipId` (spell internal ID, used for delve), `u8 isNegative`, `pascal name`.
- Removed tail slots: `u8 index` + `00×10`.
- This is a delta packet. The client keeps an index-to-effect array.

**0x75 ConcentrationList** (191:83)
- Header: `u8 n`, `00×3`.
- Per effect: `u8 i`, `u8 0`, `u8 concCost`, `u16 icon`, `pascal name`, `pascal ownerName`. Names longer than 14 characters are cut to 12 and suffixed with "..".

**0xD8 DelveInfo** (1110:36): a C string of up to 2048 bytes, an S-expression such as `(Spell (Index "123")(Name "X")…)`. Builders: `packets/Utils/ClientDelve.cs` and `packets/Client/168/DetailDisplayHandler.cs`.

### Chat and UI

**0xAF Message** (1127:39)
- `u8 eChatType`
- Optional raw `"@@"` (only when type is CT_Send) or `"##"` (location CL_PopupWindow)
- C string message
- Not sent while on the character screen. The legacy 168 header (session ID etc.) is gone.
- eChatType values (`IPacketLib.cs:270`): 01 say, 02 send/tell, 03 group, 04 guild, 05 broadcast, 06 emote, 07 help, 08 chat, 0A officer, 0B alliance, 10 spell, 11 you-hit, 12 system, 13 items, 14 merchant, 15 your death, 16 other's death, 17 other's combat, 19 spell expires, 1A loot, 1B resisted, 1C important, 1D damaged, 1E action, 1F spell pulse, 23 LFG, 24 trade, C8-CB screen-centre variants.

**0x81 Dialog** (168:1484)
- `u8 0`, `u8 eDialogCode`, `u16 d1`, `u16 d2`, `u16 d3`, `u16 d4`
- `u8 type` (0 OK, 1 yes/no)
- `u8 autowrap`
- message bytes, then `u8 0`
- eDialogCode: 00 warning, 03 guild invite, 05 group invite, 06 custom (d1 = sessionId, d2 = 1), 08 guild leave, 14 pay rent, 19 ML, 1A keep claim, 20 buy respec, 30-32 warmap, 64 quest subscribe (d1 = questId, d2 = npcOid, d3: 0 subscribe / 1 abort).

**0xC4 DetailWindow / CustomTextWindow** (181:40)
- `u8 0`, `u8 0`, `pascal caption`
- Repeated `u8 lineNo` (1-based) + `pascal text`. Lines over 255 chars are split across consecutive line numbers; at most 200 lines.
- Trailing `u8 0`.

**0xF3 TimerWindow**: `u16 seconds`, `u8 titleLen`, `u8 1`, C string title. To close: `u16 0`, `u8 0`, `u8 0`.

**0x88 PetWindow** (181)
- `u16 petOid`, `00 00`
- `u8 action` (2 open, 1 update, 0 close)
- `u8 aggro` (1 aggressive, 2 defensive, 3 passive)
- `u8 walk` (1 follow, 2 stay, 3 goto, 4 here)
- `u8 0`
- `u8 n` (≤8), then n × `u16 icon`: effects in `GetSortedEffects()` order, skipping `Icon == 0`, disabled and immunity effects (181:157-166)
- A close is always `00 00 00 00 00 01 01 00 00`: it is sent as `(null, Close, 0, 0)` and enum 0 is Aggressive and Follow (CharacterClassBase.cs:305), so aggro and walk read `01 01` and mean nothing

**0x83 QuestEntry**
- The task line is sent first (184:59): `u8 0`, `u16LE nameLen`, `00 00 00`, name.
- Quests then use index 1 onward (173 adds +1; at most 25 quests).
- 1124:490 formats:
  - Removed quest: `u8 idx` + `00×5`.
  - Normal quest: `u8 idx`, `u8 nameLen`, `u16LE descLen`, `u8 0`, `u8 0`, name (no NUL), desc (no NUL). The name is "Name (Level N)" and the description is "[Step #k]: …", each ≤255.
  - RewardQuest: `u8 idx`, `u8 nameLen`, `u16 0`, `u8 goalCount`, `u8 level`, name, `pascal desc`. Then per goal: `u16LE len`, text ending in "\r", `u16LE zone2`, `u16LE x2`, `u16LE y2`, `u16LE 0`, `u16LE type`, `u16LE 0`, `u16LE zone1`, `u16LE x1`, `u16LE y1`, `u8 achieved`, then `u8 0` or `u8 goalIdx` + TemplateData.

### Inventory and merchant

**0x02 InventoryUpdate** (189:129/160)
- `u8 count`, `u8 0`
- `u8 cloakInvis|helmInvis<<1`
- `u8 hood|quiver` (or houseVault index + 1)
- `u8 visibleActiveWeaponSlots`
- `u8 windowType`: 0 update, 1 equipment, 2 inventory, 3 player vault, 4 house vault, 5/6 consignment, 7 horse bags
- Then count × (`u8 slot` + ItemData).
- At most 30 items per packet (`max_items_per_packet`). Later chunks use windowType 0.
- On world init: one packet with windowType 1 (equipped items), then windowType 2 (slots 40-95).

**Slot numbers** (`gameutils/IGameInventory.cs:9`):

| Slot(s) | Meaning |
|---|---|
| 10 / 11 / 12 / 13 | right hand / left hand / two-handed / ranged |
| 14-17 | quivers |
| 21 | head |
| 22 | hands |
| 23 | feet |
| 24 | jewelry |
| 25 | torso |
| 26 | cloak |
| 27 | legs |
| 28 | arms |
| 29 | neck |
| 32 | waist |
| 33 / 34 | bracers |
| 35 / 36 | rings |
| 37 | mythical |
| 40-79 | backpack |
| 80-95 | horse bags |
| 110-149 | vault |

**ItemData** (1124:836). An empty slot is `00×24`.
- `u16 0` (unique ID)
- `u8 level`
- `u8 value1`, `u8 value2`: GenericItem gives count&FF / count>>8; arrows, bolts and poison give count / SPD_ABS; thrown gives DPS / count; shield gives size / DPS; default is DPS_AF / SPD_ABS
- `u8 hand<<6` (or DPS_AF for garden objects)
- `u8 (typeDamage<<6)|objectType`
- `u8 0`
- `u16 weight`
- `u8 condition%`, `u8 durability%`, `u8 quality`, `u8 bonus`, `u8 bonusLevel`
- `u16 model`
- `u8 extension`
- `u16 color/emblem`
- `u8 flag`: 0x01 new emblem, 0x02 salvage, 0x04 craft, 0x08 spell1 present, 0x10 spell2 present
- `[u16 icon1 + pascal name1]` when flag has 0x08
- `[u16 icon2 + pascal name2]` when flag has 0x10
- `u16 effect`
- `pascal name` (≤55; prefixed with "N " when count > 1; consignment price appended)

**TemplateData** (1124:996)
- Same layout up to the extension byte; condition and durability come from the template base values.
- Then `u16 color/emblem`, `u8 template.Flags`, `u16 effect`, `pascal name` (prefixed with count).
- There are no spell blocks.

**0x17 MerchantWindow** (1125:607). One packet per non-empty page; 5 pages × 30 items maximum.
- `u8 itemCount`, `u8 eMerchantWindowType` (0 normal, 1 BP, 2 count, 3-0x0D housing), `u8 page`
- Per item: `u8 index`, `u8 level`, `u8 value1`, `u8 SPD_ABS`, `u8 hand<<6` (or DPS_AF for garden), `u8 (typeDamage<<6)|objType`, `u8 usable` (1 if the player can use it), `u16LE value2` (weight, or packSize×weight), `u32LE price` (copper), `u16LE model`, `pascalIntLE name`
- An empty merchant sends `00 type 00 00`.

**0xEA TradeWindow** (1109:23). Sent to both traders by every `TradeUpdate` (`gameutils/PlayerTradeWindow.cs:378-394`), its only caller for a player trade. Accept state is not on the wire: every 0xEA means both accepts were reset, and a plain accept sends none (`:408-414`).

| Offset | Field |
|---|---|
| 0-9 | our offered backpack slots, u8, zero-padded |
| 10-11 | u16 0 |
| 12-21 | our money, u16 each: mithril, platinum, gold, silver, copper |
| 22-23 | u16 0 |
| 24-33 | partner money, same order |
| 34-35 | u16 0 |
| 36-37 | `u8 partnerItemCount`, `u8 1`; u16 0 when the window has no partner list (self-craft) |
| 38, 39 | `u8 repair`, `u8 combine` |
| 40+ | count × (`u8 slot` + ItemData). The slot is the **partner's** backpack slot |
| end | pascal `Trading with <name>` or `Selfcrafting` |

**0xEA close** (168:1979): exactly 40 zero bytes, with no cause. An open window is at least 41 bytes, so a payload of 40 or less means closed. Sent to both traders by `CloseTrade`.

Read from source; not yet seen on the wire. The commands are 0xDD (`toSlot = 1000 + objectId`) and 0xEB in [daoc-client-handlers.md](daoc-client-handlers.md).

## 4. Coordinate system

- **Global coordinates** are per region, as int32 X/Y (u32 on the wire for 0xDA, 0xD9, 0x04 and 0xEC; f32LE on the wire for 0x20, 0x4B and 0xA9) and Z as u16 or f32.
- A region (u16 ID; `Region.Skin` is what goes on the wire, and differs only for instances) contains zones.
- **Zone offsets**: `XOffset = OffX*8192`, `YOffset = OffY*8192`, `Width/Height = n*8192` (`world/WorldMgr.cs:608-611`), with data in `scripts/dbupdater/insert/Zones.xml`. Example: Camelot Hills (zone 0, region 1) has OffX 67 and OffY 59, so XOffset = 548864, YOffset = 483328, and width/height = 8×8192 = 65536.
- Zone-relative u16 offsets are therefore `global - zone.XOffset` (range 0..65535).
- `CurrentZone = region.GetZone(x, y)` (`gameobjects/GameObject.cs:85`).
- To convert 0xA1 back to global: `globalX = zones[zoneSkinId].XOffset + xOff`. **The client needs the Zones.xml table** (or `DbZone`) to map zone ID or skin to offsets.
- 1.127 player packets (0xA9, 0x20, 0x4B) carry **global floats**, so the table is not needed for them. 0xA9 carries `zone.ID` and 0xA1 carries `ZoneSkinID` (the same as the ID except for instances).
- 0x20 carries dungeon zone offsets divided by 0x2000 (8192).
- **Heading**: 4096 units per full circle; `Heading = raw & 0xFFF`, and the high 4 bits are client flags (`GameObject.cs:87-92`).
  - 0 points toward +Y (south/"bottom") and the value increases clockwise (`world/Point2D.cs:95-140`).
  - `heading = atan2(-dx, dy) * 4096/(2π)`, wrapped by adding 4096 if negative.
  - Point at heading h and distance d: `x' = x - sin(h·2π/4096)·d`, `y' = y + cos(h·2π/4096)·d`.
- **Distances**: `VISIBILITY_DISTANCE = 6000` (`world/WorldMgr.cs:60`). Speeds are units per second; MaxSpeed is a percentage of the base speed.
- **Login/world-entry order**, as sent by the server:
  1. On login: 0x22 → 0x2A.
  2. Character screen: 0xFE / 0xFC.
  3. On character select: 0x2A + 0x28.
  4. 0xB1.
  5. On world init: 0x20, 0xB6, 0x02 (equipment), 0x02 (inventory), 0x16/01…0x16/02 (skills and spell lines), 0x16/08, 0x16/03, 0xFA, 0xFB, 0xFB (resists), 0x7F, 0x16/05, 0x83…, 0x91, 0x75, 0xDE, 0x21, 0xB6.
  6. On player init: 0x91, 0x7E, 0x2B, then MOTD as 0xAF.
  7. On game open: 0x2D, 0xAD (deferred), 0x91.
  8. NPCs, objects and players then stream in via 0xDA, 0xD9, 0x4B and 0x15.