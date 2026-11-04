# OpenDAoC client→server packet catalogue, for the daoc-sdk headless client

Paths are relative to `C:/Users/joshu/Code/daoc-sdk/server/core/GameServer`. The handler folder is `packets/Client/168/`. Layouts are for the newest client branches, 1.127 to 1.129, unless a field says otherwise. Supported versions are listed at `packets/Server/PacketLib*.cs`; the newest are `PacketLib1127/1128/1129.cs`.

## 0. Framing, primitives, dispatch (read this first)

**Inbound TCP framing** (`GameClient.cs:347-412`, `packets/Client/GSPacketIn.cs:101-115`):

| off | type | field |
|---|---|---|
| 0 | u16 BE | `psize` = payload length only (excludes this 10-byte header and the 2-byte checksum) |
| 2 | u16 BE | sequence. Ignored, except Ping echoes it (`seq+1`) |
| 4 | u16 BE | sessionID. Ignored on TCP. Used on UDP to find the client (`GameServer.cs:1088`) |
| 6 | u16 BE | parameter (unused by handlers) |
| 8 | u8 | high byte of the code. Ignored. Send 0x00 |
| 9 | u8 | **packet code** (`m_code = buf[offset+9]`) |
| 10 | psize bytes | payload. Handlers read from payload offset 0 |
| 10+psize | u16 BE | checksum |

- Total frame length is `psize + 12` (`HDR_SIZE = 12`).
- **Checksum** (`packets/Server/PacketProcessor.cs:608-622`) covers every byte from offset 0 up to the checksum, including the length field:
  ```
  v1=0x7E; v2=0x7E; for b of frame[0..len-2): v1=(v1+b)&0xFF; v2=(v2+v1)&0xFF;
  chk = (v2 - ((v1+v2) << 8)) & 0xFFFF   // written BE at the end
  ```
- A bad checksum makes the server disconnect.
- Several packets can be concatenated in one TCP write.
- **No encryption on inbound traffic.** `DecryptPacket` is never called. Do not bundle an RC4 key in 0xF4: keep its payload at 7 bytes or fewer.
- UDP uses the same frame, one packet per datagram (`GameServer.cs:1058-1125`). The client is looked up by header sessionID, and the first datagram locks `UdpEndPoint`.
- **Handler table** (`PacketProcessor.cs:117-157,160-202`): one 256-entry array indexed by code. `PacketHandlerType` (TCP/UDP) is **not** checked, so "UDP" handlers (0x14, 0xF2) also work over TCP. Unknown codes are silently dropped.
- **Preprocessor** (`packets/Server/PacketPreprocessing.cs`): `None(0)` = always runs, `LoggedIn(1)` = `client.Account != null`, `PlayerInGame(2)` = `client.Player != null`. A failed check is silently dropped (info log only).
- **Version detection** happens on the very first TCP receive (`GameClient.cs:283-344`). If size ≥ 19, `ver = buf[11]*1000 + buf[12]*100 + buf[13]` (payload bytes 1-3 = major, minor, build). For example `01 01 1B` gives 1127. The buffer is then processed normally as packets.

**Reader primitives** (`CoreBase/Network/PacketIn.cs`):
- `ReadShort` / `ReadInt`: **big-endian** u16/u32. `*LowEndian`: little-endian.
- `ReadFloatLowEndian`: IEEE f32 LE.
- `ReadString(n)`: always consumes **exactly n bytes** and cuts at the first NUL.
- `ReadPascalString`: u8 length + bytes.
- `ReadIntPascalStringLowEndian`: **u32 LE length + bytes**, no NUL.
- Strings are Windows-1252 (`CoreBase/Network/BaseServer.cs:17`).

**Client states** (`GameClient.cs:501`): NotConnected 0, Connecting 1, CharScreen 2, WorldEnter 3, Playing 4, Linkdead 5, Disconnected 6.

**Timeouts the bot must respect:**
- **Hard timeout:** 150 s without 0xA3 Ping disconnects you (`ECS-Services/ClientService.cs:18,741`). `PingTime` is also reset on any client-state change (`GameClient.cs:47`).
- **Soft link-death:** 5 s without a **0xA9 position update** while Playing (`ECS-Components/PlayerMovementComponent.cs:15,53-61`). The heading packet 0xBA does **not** refresh this timer, so send 0xA9 at least every ~1-4 s even when idle.
- When a link-death timer is running, the next 0xA9 is consumed only to recover: it calls `IsPositionUpdateFromPacketAllowed`, which returns false and teleports you to the link-death location (`gameobjects/GamePlayer.cs:824-834`).
- **Speed-hack monitor** (`gameutils/PlayerMovementMonitor.cs:37-42`): XY distance between samples must stay within `maxSpeed*1.15*(dt+tick)`. 6 violations within 1.5 s trigger a teleport back; after 5 teleports you are kicked.
- **UDP:** `UdpConfirm` drops to false if there is no UDP ping for 70 s (`ClientService.cs:95`). With UDP unconfirmed, the server sends all "UDP" packets over TCP (`PacketProcessor.cs:239-263`). **A TCP-only bot is fully viable: send GameOpen with flag=0.**

**Headless login sequence (server-side requirements):**
1. `0xF4` CryptKeyRequest. Server replies with CryptKey.
2. `0xA7` Login. Server replies with LoginGranted or LoginDenied; state becomes Connecting.
3. `0xFC` CharOverview with realm (1/2/3). State becomes **CharScreen** and `Account.Realm` is set.
4. Optional: `0xCB` duplicate-name check, then `0xFF` create character.
5. Optional: `0x9D` RegionListRequest.
6. `0x10` CharSelect. Server sends LoginGranted and SessionID.
7. `0xD4` WorldInit with the char index. This loads the player and calls `AddToWorld`. Server sends 0x88 position, inventory, skills and so on. State becomes **WorldEnter**.
8. `0xE8` PlayerInit. Server sends PlayerInitFinished and others.
9. `0xBF` GameOpen. State becomes **Playing**.
10. From here: `0xA9` / `0xBA` / etc.

**After a cross-region teleport** (`GamePlayer.MoveTo`): the server calls `RemoveFromWorld` and sends RegionChanged (`gameobjects/GamePlayer.cs:~7877-7906`). The client must send `0xD4` again, then `0xE8`, then `0xBF`. WorldInit accepts state Playing, needs `ObjectState == Inactive`, and sets WorldEnter. GameOpen requires WorldEnter.

---

## 1. Handler table

Pre = preprocessor (N = None, L = LoggedIn, G = PlayerInGame).

| Code | Enum (`packets/Server/IPacketLib.cs:131-212`) | Handler class / file | Pre | Notes |
|---|---|---|---|---|
| 0x00 | HouseMenuRequest | HousingMenuRequestHandler | G | u16 house, u8 menuId, u8 flag (1127 uses `_menu1127`) |
| 0x01 | HouseEdit | HouseEditHandler | G | |
| 0x03 | HouseUserPermissionRequest | HouseUsersPermissionsRequestHandler | G | u8, u8, u16 house |
| 0x05 | HousePermissionRequest | HousePermissionsRequestHandler | G | u16 pid, u16 house |
| 0x06 | HouseUserPermissionSet | HouseUsersPermissionsSetHandler | G | u8 slot, u8 level, u16 house |
| 0x07 | HousePermissionSet | HousePermissionsSetHandler | G | u8 level, u8, u16 house, 15×u8 perms, u8 |
| 0x0B | HouseEnterLeave | HouseEnterLeaveRequestHandler | G | u16 pid, u16 house, u8 enter |
| 0x0C | HousePlaceItem | HousingPlaceItemHandler | G | u8, u8 slot, u16 house, u8, u8 pos, u8 method, u8 rot, i16 x, i16 y |
| 0x0D | PlayerPickupHouseItem | HousingPickupItemHandler | G | u8, u8 pos, u16 house, u8 method |
| 0x0E | HouseDecorationRotate | HousingDecorationRotate | G | u8, u8 pos, u16 house, u16 angle, u16 |
| 0x10 | CharacterSelectRequest | CharacterSelectRequestHandler | L | **payload ignored** |
| 0x11 | MarketSearchRequest | PlayerMarketSearchRequestHandler | G | u8 nameLen, 3 skip, … |
| 0x14 | UDPInitRequest | UDPInitRequestHandler (type UDP) | N | |
| 0x18 | HouseDecorationRequest | HousingDecorationRotateRequestHandler | G | u16 house, u8 idx, u8 |
| 0x1A | SetMarketPrice | PlayerSetMarketPrice | G | u8 slot, u8, u16, u32 BE price |
| 0x1C | WithDrawMerchantMoney | PlayerWithdrawMerchantMoney | G | no payload |
| 0x37 | ClientCrash | ClientCrashPacketHandler | N | server quits and disconnects |
| 0x40 | QuestRewardChosen | QuestRewardChosenHandler | G | |
| 0x48 | ShowWarmapRequest | WarmapShowRequestHandler | G | u8 code, u8 realmMap, u8 keepId |
| 0x4C | MinotaurRelicWindow | MinotaurRelicWindowHandler | G | no payload |
| 0x4F | RemoveQuestRequest | QuestRemoveRequestHandler | G | u16, u16 questIndex, u16, u16 |
| 0x53 | TrainHandler | PlayerTrainHandler (PlayerTrainRequestHandler.cs:79) | G | |
| 0x64 | BuyHookPoint | BuyHookPointHandler | G | u16 keep, u16 wall, u16 hp, u16 slot, u8 payType, 3 skip |
| 0x66 | WarmapBonusRequest | warmapbonusesrequesthandler | G | no payload |
| 0x6F | KeepComponentInteract | KeepComponentInteractHandler | G | u16 keep, u16 wall, u16 resp, u16 hpIdx |
| 0x71 | UseSlot | UseSlotHandler | G | |
| 0x74 | PlayerAttackRequest | PlayerAttackRequestHandler | G | |
| 0x76 | RemoveConcentrationEffect | RemoveConcentrationEffectHandler | G | u8 index |
| 0x78 | BuyRequest | PlayerBuyRequestHandler | G | |
| 0x79 | SellRequest | PlayerSellRequestHandler | G | |
| 0x7A | ObjectInteractRequest | ObjectInteractRequestHandler | G | |
| 0x7B | TrainWindowHandler | PlayerTrainWindowHandler | G | no payload; needs CanTrain |
| 0x7C | ChampionTrainHandler | PlayerChampionTrainHandler | G | |
| 0x7D | UseSpell | UseSpellHandler | G | |
| 0x80 | DestroyItemRequest | DestroyItemRequestHandler | G | |
| 0x82 | DialogResponse | DialogResponseHandler | G | |
| 0x84 | LookingForGroupFlag | LookingForAGroupFlagHandler | G | u8 (1 = set LFG, 0 = clear, other = group status) |
| 0x85 | LookingForGroup | LookingForAGroupHandler | G | u8 grouped |
| 0x87 | InviteToGroup | InviteToGroupHandler | G | **no payload**; uses server-side TargetObject |
| 0x8A | PetWindow | PetWindowHandler | G | u8 aggro (1 aggr, 2 def, 3 pass), u8 walk (1 follow, 2 stay, 3 goTarget, 4 here), u8 cmd (1 attack, 2 release); 0 skips that field only. A non-zero aggro returns and walk 2-4 return, but walk 1 falls through to cmd (`00 01 01` is follow, then attack): one order per packet. No target field: attack, goTarget and release read TargetObject (0xB0) |
| 0x90 | PlayerRegionChangeRequest | PlayerRegionChangeRequestHandler | G | |
| 0x99 | DoorRequest | DoorRequestHandler | G | |
| 0x9D | RegionListRequest | RegionListRequestHandler | **N** (but dereferences Account) | |
| 0x9F | DisbandFromGroup | DisbandFromGroupHandler | G | **no payload** |
| 0xA3 | PingRequest | PingRequestHandler | N | |
| 0xA5 | ObjectUpdateRequest | ObjectUpdateRequestHandler | G | ignored |
| 0xA7 | LoginRequest | LoginRequestHandler | N | |
| 0xA9 | PositionUpdate | PlayerPositionUpdateHandler | G (+ Playing) | |
| 0xAF | CommandHandler | PlayerCommandHandler | G | slash commands and chat |
| 0xB0 | PlayerTarget | PlayerTargetHandler | G | |
| 0xB5 | PickUpRequest | PlayerPickUpRequestHandler | G | |
| 0xBA | PlayerHeadingUpdate | PlayerHeadingUpdateHandler | G | |
| 0xBB | UseSkill | UseSkillHandler | G | |
| 0xBE | CreateObjectRequest | CreateObjectRequestHandler | G | |
| 0xBF | GameOpenRequest | GameOpenRequestHandler | N (needs WorldEnter) | |
| 0xC0 | CharacterDeleteRequest | CharacterDeleteRequestHandler | L | legacy (<1.104) |
| 0xC2 | (0x6A^168) | BadNameCheckRequestHandler | N | `string[30]` name |
| 0xC7 | PlayerSitRequest | PlayerSitRequestHandler | G | |
| 0xC8 | PlayerDismountRequest | PlayerDismountRequestHandler | G | no payload |
| 0xCA | BonusesListRequest | PlayerBonusesListRequestHandler | G | u8 code (0) |
| 0xCB | DuplicateNameCheck | DupNameCheckRequestHandler | L | |
| 0xD0 | CheckLosRequest | CheckLosResponseHandler | G | |
| 0xD4 | WorldInitRequest | WorldInitRequestHandler | L | |
| 0xD5 | CreatePlayerRequest | PlayerCreationRequestHandler | G | |
| 0xD8 | DetailRequest | DetailDisplayHandler | G | delve |
| 0xDC | ClientFilterSettings | ClientFilterSettingsHandler | G | |
| 0xDD | PlayerMoveItem | PlayerMoveItemRequestHandler | G | |
| 0xE0 | PlayerAppraiseItemRequest | PlayerAppraiseItemRequestHandler | G | |
| 0xE2 | EmblemDialogResponse | EmblemDialogReponseHandler | G | u8 primary&0F, u8 secondary&07, u8 pattern&03, u8 logo |
| 0xE4 | ShipHookPoint | ShipHookpointInteract | G | u16, u16 oid, u16, u8 slot, u8 flag, u8 currency, u8, u16, u8 type, u8, u16 |
| 0xE8 | PlayerInitRequest | PlayerInitRequestHandler | G | **payload ignored** |
| 0xEB | ModifyTrade | PlayerModifyTradeHandler | G | |
| 0xEC | PlayerGroundTarget | PlayerGroundTargetHandler | G | |
| 0xED | CraftRequest | MakeProductHandler | G | u16 BE recipe/item id, then `CraftItem(id)` |
| 0xF2 | UDPPingRequest | UDPPingRequestHandler (type UDP) | N | |
| 0xF4 | CryptKeyRequest | CryptKeyRequestHandler | N | |
| 0xF5 | SiegeCommandRequest | SiegeWeaponActionHandler (raw 0xF5) | N | u16, u8 action, u8 ammo |
| 0xF8 | PlayerCancelsEffect | PlayerCancelsEffectHandler | G | |
| 0xFC | CharacterOverviewRequest | CharacterOverviewRequestHandler | L | |
| 0xFF | CharacterCreateRequest | CharacterCreateRequestHandler | L | create, customize and delete |

No other v168 handlers exist outside `packets/Client/168`: a grep for the namespace elsewhere found nothing.

---

## 2. Byte layouts

### Login and character phase

**0xF4 CryptKeyRequest** (`CryptKeyRequestHandler.cs:31-61`, 1.115+), payload 7 bytes (frame 19):
```
u8 clientType   // low nibble = eClientType, high nibble = eClientAddons
u8 major(=1) u8 minor(=1) u8 build(e.g. 0x1B=27)   // consumed by version detection; Skip(3) here
char rev[1]     // revision letter, e.g. 'a'
u16 build       // skipped
```
- If DataSize > 7, the server instead reads `u32 LE len + key` as the RC4 sbox, only when `CLIENT_ENABLE_ENCRYPTION_RC4` is on, and sends no reply. **Avoid this.**
- Reply: CryptKey `[u8 clientType][u8 0][char ver[5] "1.127"][u8 0][u8 0][u8 0]` (`packets/Server/PacketLib1124.cs:747`). Encryption is disabled.

**0xA7 LoginRequest** (`LoginRequestHandler.cs:149-153`). For ≥1126 there is no type/version prefix:
```
u32 LE userLen; char user[userLen]
u32 LE passLen; char pass[passLen]
```
- 1125 (lines 123-147): `u8 type, u8 maj, u8 min, u8 build, u8 rev, u16 build`, then the same two strings. ≤1124 uses u16 LE lengths.
- Username must match `^[a-zA-Z0-9]*$`.
- Auto account creation happens only if `AutoAccountCreation && ALLOW_AUTO_ACCOUNT_CREATION`, subject to per-IP limits.
- Password hash: `CryptPassword` (line ~220; PHP equivalent in the comment at the top of the file). MD5 of the password as 2 bytes per char (`ch>>8`, `ch`), uppercased, zeros at even positions stripped, prefixed with `##`.
- Replies: LoginGranted, or LoginDenied with `eLoginError` (`IPacketLib.cs:217`). Concurrent logins with the same username get a disconnect.

**0xFC CharacterOverviewRequest** (`CharacterOverviewRequestHandler.cs:87-143`, ≥1124):
```
u8 realm   // 0 = ask: server sends Realm packet (account realm or None)
           // 1 Alb, 2 Mid, 3 Hib: server sends CharacterOverview(realm)
```
- Sets ClientState = CharScreen and, if allowed, `Account.Realm = realm` (in memory). **Required before 0xD4.**

**0xCB DuplicateNameCheck** (`DuplicateNameCheckRequestHandler.cs:56-59`): `char name[24]` (≥1126; 30 before). Reply DupNameCheckReply with result 0 = ok, 1 = invalid name, 2 = taken.

**0xFF CharacterCreateRequest** (`CharacterCreateRequestHandler.cs:263-327`), ≥1126:
```
u8   slotRaw              // (realm-1)*10 + slot(0..9); server: slot = slotRaw - (realm-1)*10
u32 LE nameLen; char name[nameLen]     // empty for delete
4    skip (observed 18 00 00 00)
u8 customMode (1 = apply face fields) u8 eyeSize u8 lipSize u8 eyeColor u8 hairColor u8 faceType u8 hairStyle
3    skip
u8 moodType
9    skip
u8 operation   // 1 create, 2 customize, 3 delete
u8 customizeType // 1 face, 2 attributes, 3 both
2    skip
15   skip      // 3 int-pascal strings (location/class/race), 5 bytes each as sent
u8 class  u8 realm     // 1125 has u8 level before class
u8 raceGender  // race = b & 0x1F, gender = (b>>7)&1 (0 male, 1 female)
u16 LE creationModel
// 1125 only: u8 region, 5 skip
u8 STR u8 DEX u8 CON u8 QUI u8 INT u8 PIE u8 EMP u8 CHA     // absolute values (race base + spent)
43   skip
u8 newConstitution
```
- Name regex `^[A-Z][a-zA-Z]`, min length 3. Breaking it as plvl 1 gets a disconnect, and an autoban if BAN_HACKERS.
- Create validation in `IsCharacterValid` (line 920): realm 1-3, class in `STARTING_CLASSES_DICT[realm]`, race in the class's eligible races, race/class gender constraints.
- Stat budget (`gameutils/CharacterStatValidator.cs:45-92`): for each stat, `above = value - raceBase`, `cost = above + max(0, above-10) + max(0, above-15)`. The sum must be exactly **30**.
- A bad class/realm gets an autoban plus disconnect (around line 489).
- Delete (op 3, empty name): `AccountSlot = Account.Realm*100 + (slotRaw - (Account.Realm-1)*10)`. Requires CharScreen. Refused if the character owns a house.
- Success reply: LoginGranted, which the client uses to refresh. Then re-request 0xFC to get the overview.
- DB `AccountSlot = slot + realm*100`.

**0x10 CharacterSelectRequest**: content ignored (`CharacterSelectRequestHandler.cs:8-16`). Sends LoginGranted and SessionID. Send any payload (for example 1 zero byte).

**0x9D RegionListRequest** (`RegionListRequestHandler.cs:10-19`): `u8 slotRaw`.
- Mapping: ≥0x14 gives 300+(s-0x14); ≥0x0A gives 200+(s-0x0A); otherwise 100+s.
- Replies with SendRegions(char.Region). Throws (caught) if no character matches.

**0xD4 WorldInitRequest** (`WorldInitRequestHandler.cs:154-160`): `u8 charIndex` = (realm-1)*10 + slot.
- Server computes `charSlot = Account.Realm*100 + (charIndex - (Realm*10-10))`.
- Requires state CharScreen to load the player, or Playing when re-entering after a region change.
- Then AddToWorld and sends, in order: position+OID (0x88), max speed, equipment and inventory, skills, crafting, player, money, stats, resists, icons, weapon/armor, quests, points, conc list, guild ID, debug mode, horse.

**0xE8 PlayerInitRequest**: no payload read. Sends points, color scheme, revive, time, PlayerInitFinished, group, MOTD. Fires GameEntered on first entry and RegionChanged otherwise (`PlayerInitRequestHandler.cs:18-78`).

**0xBF GameOpenRequest** (`GameOpenRequestHandler.cs:8-19`): `u8 flag` (1 = UDP working, sets UdpConfirm; use 0 for TCP-only). Only acts if state == WorldEnter. Sets Playing, clears the object cache, sends GameOpenReply and StatusUpdate.

**0x14 UDPInitRequest** (`UDPInitRequestHandler.cs:10-22`, ≥1124): `char localIP[20]; u16 BE localPort`. Reply UDPInitReply. Can go over TCP.

**0xF2 UDPPingRequest**: payload ignored for ≥1124. Sets UdpPingTime and UdpConfirm = true. Send it via UDP, about every 65 s, if you use UDP at all.

**0xA3 PingRequest** (`PingRequestHandler.cs:17-20`):
```
4 skip; u32 BE timestamp; (rest ignored)
```
- Reply PingReply: `[u32 BE timestamp][4×0][u16 BE seq+1][6×0]`, where seq = header sequence.
- **Send at least every ~60 s** (hard timeout 150 s).

**0x37 ClientCrash** (`ClientCrashPacketHandler.cs:13-22`): `char dll[16]`, then u32 BE uptime at payload offset 0x50. The server replies with Quit and disconnects. Never send it.

### Movement

**0xA9 PositionUpdate** (`PlayerPositionUpdateHandler.cs:58-82`). Requires `Player.ObjectState == Active` **and** `ClientState == Playing`. 1127+ payload is **40 bytes**:

| off | type | field |
|---|---|---|
| 0 | f32 LE | x (**absolute region coordinates**, not zone-relative; written straight into `Player.X`, `PlayerMovementComponent.cs:95-101`) |
| 4 | f32 LE | y |
| 8 | f32 LE | z |
| 12 | f32 LE | speed (`CurrentSpeed = (short)speed`; forced to 0 if crowd-controlled) |
| 16 | f32 LE | zSpeed (fall speed; negative = falling) |
| 20 | u16 BE | sessionID (skipped) |
| 22 | u16 BE | objectID (skipped; 1127+ only) |
| 24 | u16 BE | **zoneId**. Must exist in `WorldMgr.GetZone`, otherwise you are **kicked to char screen**. Used for area checks and the "You have entered" message |
| 26 | u8 | stateFlags (below) |
| 27 | u8 | unknown |
| 28 | u16 BE | fallingDamage. Bit15 = landed; triggers fall damage if `-zSpeed - 100*safeFall > 500` |
| 30 | u16 BE | heading (raw, kept in `RawHeading`; `Heading = raw & 0xFFF`) |
| 32 | u8 | actionFlags (below) |
| 33 | 2 | unknown |
| 35 | u8 | health (ignored) |
| 36 | 4 | trailing (2 + 2 for 1127+) |

On 1124-1126 the objectID is absent and there are only 2 trailing bytes (36 bytes total).

`StateFlags` (`PlayerPositionUpdateHandler.cs:784`):

| Bit | Flag |
|---|---|
| 0x80 | STRAFE_R |
| 0x40 | STRAFE_L |
| 0x20 | STRAFE_FULL |
| 0x10 | SITTING |
| 0x08 | JUMPING |
| 0x04 | SWIMMING |

Combinations:
- DEAD = SIT|SWIM. Stripped if HP > 0.
- RIDING = SIT|JUMP. **Ban/kick if not actually riding.**
- FLYING = JUMP|SWIM. **Ban/kick unless debug mode or IsAllowedToFly.**
- CLIMBING = SIT|JUMP|SWIM. Always allowed.

`ActionFlags` (line 800):

| Bit | Flag |
|---|---|
| 0x80 | TORCH |
| 0x40 | TELEPORT |
| 0x30 | TARGET_IN_VIEW (both bits) |
| 0x08 | GROUND_TARGET_IN_VIEW |
| 0x04 | PET_IN_VIEW |
| 0x02 | DIVING |
| 0x01 | WIREFRAME |

Set 0x30 when you have LOS to the target: the server uses `TargetInView` for melee and casting. Set 0x08 for ground-target LOS.

Heading math (`world/Point2D.cs:17,102-112`): `heading = atan2(-dx, dy) * 4096/(2π)`, wrapped to 0..4095. The forward vector is `(dx, dy) = (-sin θ, cos θ)` with `θ = h*2π/4096`.

The server rebroadcasts position at most every 200 ms. The client sends about every 200 ms while moving.

**0xBA PlayerHeadingUpdate** (`PlayerHeadingUpdateHandler.cs:11-25`), 1127+:
```
u16 BE sessionID (skip)
u16 BE targetOID (skip; 1127+)
u16 BE heading
u8 unknown
u8 actionFlags        // same bits as 0xA9
u8 steedSlot (skip)
u8 stateFlags>>2      // server does (b<<2) and uses the 0xA9 StateFlags rules; no strafe bits
```
This does **not** refresh the 5 s link-death timer.

### Targeting, interaction, combat

**0xB0 PlayerTarget** (`PlayerTargetHandler.cs:8-18`):
```
u16 BE targetOID   (0 = clear)
u16 BE flags       // 0x8000 examine (server sends examine messages), 0x4000|0x2000 LOS (either = in view), 0x0001 own attack mode
```
- If the target is beyond 6000 units, the server sends ObjectDelete and clears the target.
- Not in view prints "Target is not in view."
- **The target is the server-side `TargetObject` used by pickup, buy, sell, invite, disband, train, appraise and spells.** Always send 0xB0 first.

**0x7A ObjectInteractRequest** (`ObjectInteractRequestHandler.cs:9-24`):
```
u32 BE playerX  u32 BE playerY  (unused)
u16 BE sessionID (unused)
u16 BE targetOID
```
Calls `obj.Interact(player)`. The plvl-1 range check is `InteractDistance`, default 192 (`world/WorldMgr.cs:56`, `gameobjects/GameObject.cs:831-845`). It opens the merchant window, trainer window, NPC dialog and so on.

**0x74 PlayerAttackRequest** (`PlayerAttackRequestHandler.cs:8-23`): `u8 start (≠0 = start)`, `u8 clientAuto` (0 = user action; 1 = the client stopped on its own).
- Start is honoured only when start ≠ 0 and clientAuto == 0; everything else stops.
- Refused while the active weapon is ranged; use UseSlot 13 or a ranged style instead.

**0xC7 PlayerSitRequest** (`PlayerSitRequest.cs:8-9`): `u8 status` (≠0 sit, 0 stand).

**0xD0 CheckLosRequest**, i.e. the LOS **response** (`CheckLosResponseHandler.cs:8-13`):
```
u16 BE checkerOID  u16 BE targetOID  u16 BE result (bit 0x100 set = LOS true)  [u16 trailing]
```
This answers the server's CheckLOS request; echo back the checker and target IDs from it. Without a real client, a bot must answer itself, either always true or using its own geometry. Unanswered checks block NPC and pet attacks and some spells.

**0xEC PlayerGroundTarget** (`PlayerGroundTargetHandler.cs:12-27`):
```
u32 BE x  u32 BE y  u32 BE z   (absolute)
u16 BE flag   // 0x0100 = ground target in view
[u8,u8 unused]
```
Snapped to the navmesh when `GROUND_TARGET_SNAP_MAX_DISTANCE > 0`. If it fails it is unset.

**0x9F DisbandFromGroup**: no payload. Removes self, or the server-side target if you are leader and the target is in your group.

**0x87 InviteToGroup**: no payload. Invites the server-side target, which receives dialog code 0x05.

**0xF8 PlayerCancelsEffect** (`PlayerCancelsEffectHandler.cs:13-25`): `u16 BE effectTooltipId` (the icon ID from the server's effect/icon list). Calls `TryGetEffectByTooltipId(...).End(true)`.

**0x76 RemoveConcentrationEffect**: `u8 index` into the conc list.

**0xC8 PlayerDismountRequest**: no payload.

### Skills, spells, slots

All three share an 18-byte position prefix on ≥1124. **Gotcha:** the prefix is only consumed if `IsPositionUpdateFromPacketAllowed()` is true. While a link-death timer is running the reads misalign. This is a server bug; avoid by sending a 0xA9 first after any lag.

Shared prefix layout (≥1124):
```
f32 LE x  f32 LE y  f32 LE z  f32 LE speed  u16 BE heading      // applied as a position update
u16 BE flagSpeedData   // 0x4000 strafing, 0xA000 (any bit) target-in-view, 0x1000 GT-in-view
```
Set 0xA000 in `flagSpeedData` when the target is visible, otherwise spells and styles may fail on "not in view".

**0xBB UseSkill** (`UseSkillHandler.cs:15-30`): prefix, then `u8 index`, `u8 type`.
- Index is into `player.GetAllUsableSkills()` (`gameobjects/GamePlayer.cs:3397`), the same ordered list the server sends in the skills update.
- If type > 0, the index is offset by the first non-Specialization entry (abilities, styles, spells-as-skills). If type == 0, it is a raw index, usually a Specialization.
- Specialization runs the SpecActionHandler. Ability calls `RequestUseAbility`. Spell casts with the sibling SpellLine. Style calls `ExecuteWeaponStyle`, or sets the backup style when awaiting backup input.

**0x7D UseSpell** (`UseSpellHandler.cs:24-40,103-143`): prefix, then `u8 spellLevel`, `u8 spellLineIndex`, then 2 trailing bytes (ignored).
- Resolved via `GetAllUsableListSpells()[lineIndex]` (`gameobjects/GamePlayer.cs:3372`): the first Spell with `Level == spellLevel`, or Style/Ability with `SpecLevelRequirement == spellLevel`.
- Requires a valid server-side target for targeted spells.

**0x71 UseSlot** (`UseSlotHandler.cs:14-40`): prefix, then `u8 slot`, `u8 type` (eUseType: 0 click, 1 /use, 2 /use2).
- Calls `GamePlayer.UseSlot` (`gameobjects/GamePlayer.cs:6528`).
- Slot 10 (RH) or 11 (LH) with type 0 switches to Standard weapons. 12 switches to TwoHanded and 13 to Distance. 14-17 select a quiver. 9 summons the horse. Otherwise it uses the item (potions, charges).

### Inventory, loot, merchants, trade

Slot IDs (`gameutils/IGameInventory.cs`):

| Slot | Meaning |
|---|---|
| 1 | Ground |
| 7-9 | Horse |
| 10 | RH |
| 11 | LH |
| 12 | 2H |
| 13 | Ranged |
| 14-17 | Quivers |
| 21-37 | Armour and jewellery |
| 40-79 | Backpack |
| 80-95 | Horse bags |
| 100 | PaperDoll ("equip this") |
| 101-105 | Money |
| 110-149 | Vault |
| 600 | NewPaperDoll |
| 601 | GeneralVault |
| >1000 | Give to object (OID = slot - 1000) |

**0xDD PlayerMoveItem** (`PlayerMoveItemRequestHandler.cs:15-78`):
```
u16 BE (ignored, sessionID/OID)
u16 BE toSlot
u16 BE fromSlot
u16 BE count
```
- toSlot > 1000: give to an NPC/player (OID = toSlot-1000), range 128 (`GIVE_ITEM_DISTANCE`). Opens a trade window for players.
- toSlot 100/600: auto-equip, or unequip to the first free backpack slot.
- toSlot 1: drop.
- toSlot 601: vault shift-click.
- Otherwise `Inventory.MoveItem` (also handles swap and stack split). From/to must be in the ranges above.

**0x80 DestroyItemRequest** (`DestroyItemRequestHandler.cs:10-33`): `4 skip; u16 BE slot`. Refuses indestructible items, relics and equipped items.

**0xB5 PickUpRequest** (`PlayerPickUpRequestHandler.cs:12-29`):
```
u32 BE x  u32 BE y  u16 BE id  u16 BE obj    // ALL IGNORED
```
Picks up the **server-side TargetObject**: send 0xB0 with the loot OID first. Range `WORLD_PICKUP_DISTANCE`, default 256 (`serverproperty/ServerProperties.cs:631`). `&autoloot` also exists.

**0x78 BuyRequest** (`PlayerBuyRequestHandler.cs:13-57`):
```
u32 BE x  u32 BE y (unused)
u16 BE id (unused)
u16 BE itemSlot    // page*30 + slotOnPage (MAX_ITEM_IN_TRADEWINDOWS=30, 5 pages)
u8 count           // stacks; amount = count*PackSize
u8 menuId          // eMerchantWindowType (IPacketLib.cs:427): 0 Normal; 3,5-10 = housing types → HouseMgr.BuyHousingItem
```
Otherwise the TargetObject must be a GameMerchant, GameGuardMerchant, GameItemCurrencyGuardMerchant or GameLotMarker (`OnPlayerBuy`, `gameobjects/GameMerchant.cs:87-93`).

**0x79 SellRequest** (`PlayerSellRequestHandler.cs:12-49`): `u32 x; u32 y; u16 id; u16 BE invSlot`. Same merchant target rule (`OnPlayerSell`).

**0xE0 PlayerAppraiseItemRequest** (`PlayerAppraiseItemRequestHandler.cs:11-25`): `u32 x; u32 y; u16 id; u16 BE invSlot`. Needs a merchant or lot target.

**0xEB ModifyTrade** (`PlayerModifyTradeHandler.cs:11-56`):
```
u8 code (0 close, 1 update, 2 accept)  u8 repair  u8 combine  u8 unk
// if code==1:
u8 slots[10]       // inventory slot ids
u16 skip
u16 BE money[5]    // mithril, plat, gold, silver, copper
```

**0xD8 DetailRequest**, delve (`DetailDisplayHandler.cs:28-30`): `u16 BE objectType; u32 BE extraId; u16 BE objectId`.
- Types: 1 inventory slot, 2 spell (`level + lineIdx*100`), 4 merchant slot, 5 effect, 6 style, 7 trade, 8 ability, 9 trainer, 10 market, 19/29 quest reward, 24-28 "New" delves.
- The reply is a custom text window, useful for skill or item inspection.

### Chat and commands

**0xAF CommandHandler** (`PlayerCommandHandler.cs:10-24`):
```
u8 skip
// <1127: 7 more skip bytes
char cmd[≤255] NUL-terminated   // ReadString(255)
```
- Commands are registered with the `&` prefix (for example `&say`, `&send`, `&quit`/`&q`, `&stand`, `&train`, `&group`, `&invite`, `&where`, `&release`, `&bind`, `&stuck`, `&autoloot`, `&sprint`, `&face`, `&assist`). The client replaces `/` with `&`, so **send `&say hello`**.
- **Plain chat is also a command:** `&say`, `&send <name> <msg>`, `&group`, `&guild`, and so on.
- Argument parsing: space-split with `"quoted"` args (`gameutils/ScriptMgr.cs:281+`).
- Lookup: exact match on `pars[0]`, otherwise a unique case-insensitive prefix match among commands at or below your plvl (`ScriptMgr.cs:109-126`). Commands are listed in `commands/playercommands/*.cs`.
- Unknown commands get the reply "No such command (...)".

### Dialogs, quests, training

**0x82 DialogResponse** (`DialogResponseHandler.cs:15-19`):
```
u16 BE data1  u16 BE data2  u16 BE data3  u8 dialogCode  u8 response (1 = yes/accept/ok, 0 = no)
```
- Echo data1-3 and the code from the server's Dialog packet: `[u8 0][u8 code][u16 d1][u16 d2][u16 d3][u16 d4][u8 type][u8 wrap][text][0]` (`packets/Server/PacketLib168.cs:1484-1530`).
- Codes (`IPacketLib.cs:543`): 0x03 GuildInvite (d1 = inviter session), 0x05 GroupInvite (d1 = leader session), 0x06 CustomDialog (requires d2 == 1; calls `CustomDialogCallback`), 0x08 GuildLeave, 0x14 HousePayRent, 0x19 MasterLevel, 0x1A KeepClaim, 0x20 BuyRespec, 0x64 QuestSubscribe (d1 = questId, d2 = NPC OID, d3 = 1 abort / else accept).

**0x40 QuestRewardChosen** (`QuestRewardChosenHandler.cs:14-31`):
```
u8 response (1 = confirm, else return)  u8 countChosen  u8 items[8]
u16 d2 u16 d3 u16 d4 (unk)  u16 BE questId  u16 BE questGiverOID
```

**0x53 TrainHandler**, trainer window commit (`PlayerTrainRequestHandler.cs:84-225`). Requires CanTrain: `ALLOW_TRAIN_ANYWHERE`, plvl > 1, or TargetObject is a GameTrainer for your class (`commands/playercommands/train.cs:141`). Fixed 264-byte payload:
```
+0   u32 BE code[8]       // indices into GetSpecList().Where(Trainable); 0xFFFFFFFF terminates
+32  u32 BE level[n]      // one per DISTINCT code before the terminator, in order; target level; only applied if > 1 and > current
+64  u32 BE raLevel[50]   // index = position in SkillBase.GetClassRealmAbilities(classId) excluding RR5; value = target level (>0)
```
**Simpler alternative for bots:** `&train <spec> <level>` via 0xAF, where `<spec>` is a prefix of the line's KeyName (`commands/playercommands/train.cs:57`), so `Light`, not the display name `Light Magic`.

**0x7C ChampionTrainHandler** (lines 19-24): `u32 x; u32 y; u8 idLine (>0); u8 unk; u8 row (1-based); u8 skillIndex (1-based)`.

**0x7B TrainWindowHandler**: no payload. The server sends the trainer window.

### World objects, region, doors

**0x90 PlayerRegionChangeRequest** (`RegionChangeRequestHandler.cs:23`): `u16 zonePointId` (**LE for ≥1126**, BE before).
- Looked up in DB `ZonePoint` by Id and realm (`Realm == player realm, 0, or null` for plvl 1).
- Results in `MoveTo`, followed by the region-change re-init flow above.

**0x99 DoorRequest** (`DoorRequestHandler.cs:18-20`): `u32 BE doorId; u8 doorState`.
- Door ID encoding: type = id/1e8 (7 keep, 9 house); zone = id/1e6.
- On ToA the zone part is rewritten to the current zone.
- Range `WORLD_PICKUP_DISTANCE*2`, or ×3 for border-keep doors.

**0xBE CreateObjectRequest** (`CreateObjectRequestHandler.cs:18-28`): `u16 OID` (**LE for ≥1126**). The server sends the create packet if the object is within 6000. Use it when you receive updates for unknown OIDs.

**0xD5 CreatePlayerRequest** (`PlayerCreationRequestHandler.cs:13-30`): `u16 sessionId` (**LE for ≥1126**). The server sends PlayerCreate and equipment for that player.

**0xA5 ObjectUpdateRequest**: ignored.

**0xDC ClientFilterSettings** (`ClientFilterSettingsHandler.cs:21-37`):
```
u8 chat[16]   // eChatType 0x10..0x1F; 0x00 = enabled, else disabled
u8 effectFilter   // eEffectFilter
3 unknown
```
Useful to suppress spell spam to the bot.

**0x48 ShowWarmapRequest** (`warmapshowrequesthandler.cs:10-12`): `u8 code (0 set page, 1 update, 2 teleport), u8 realmMap, u8 keepId`.

**0x11 MarketSearchRequest** (`PlayerMarketSearchRequestHandler.cs:19-55`): `u8 nameLen; 3 skip; char name[nameLen]; u8 slot; …` (see the file for the remaining fields). Low priority.

---

## 3. Gotchas for the bot implementation

1. **Endianness is mixed per field.**
   - Floats, and string length prefixes on login and create, are LE.
   - Nearly everything else is BE (ReadShort/ReadInt).
   - Exceptions that are **LE on ≥1126**: 0x90 zonePointId, 0xBE OID, 0xD5 sessionId, 0xFF creationModel (LE on all versions).
2. **0xA9 rules:** coordinates are absolute region coordinates, and the zoneId must be valid. Compute the zone from the region's zone table, using the zone offsets the server sends at world init.
   - Use the same heading in 0xA9, 0xBB, 0xBD and 0x71.
   - Never set the RIDING or FLYING state bits.
   - Stay under max speed ×1.15.
   - Send at least every 5 s.
3. **Many handlers ignore their payload IDs and use server-side `TargetObject`:** pickup, buy, sell, appraise, invite, disband, train. Always send 0xB0 first and wait one tick.
4. **TargetInView** comes from 0xB0 flags (0x6000), 0xA9 actionFlags (0x30) and spell/skill `flagSpeedData` (0xA000). A headless bot should assert LOS in all three, and should answer 0xD0 CheckLOS requests itself.
5. **Chat is commands:** `&say text`, `&send Name text`, and so on via 0xAF, NUL-terminated, with a 1-byte prefix on 1127.
6. **Skill and spell indices** are positional into the server's usable-skill lists. Mirror the order from the server's skill update packets (`SendUpdatePlayerSkills`), or use text commands where they exist.
7. **Handshake state gates:**
   - WorldInit needs CharScreen, so send 0xFC with a realm first.
   - GameOpen needs WorldEnter.
   - Position, UseSkill, UseSpell and UseSlot need Playing.
8. **Never send 0x37.** Avoid an oversized 0xF4. Name and class violations at character creation can autoban when `BAN_HACKERS` is on.