# OpenDAoC gameplay systems and local server setup for a headless bot client

Everything below was read from source in `C:/Users/joshu/Code/daoc-sdk/server/{core,db,buildnav}`. Nothing was modified. Endianness on the wire: `GSPacketIn.ReadShort/ReadInt` are **big-endian**, `Read*LowEndian` / `ReadFloatLowEndian` are little-endian.

## Most important points

- **Mobs will not attack GM accounts.** Accounts with PrivLevel > 1 are never attacked (`IsAttackable=false`), take no fall damage and skip the speed check. To keep real combat while still using a few GM commands, keep bots at PrivLevel 1 and grant single commands through the `singlepermission` table (§1.4).
- **The client must answer server line-of-sight requests.** The server sends 0xD0 CheckLOSRequest packets. If the client doesn't reply within 1500 ms:
  - its own spell casts fail;
  - mobs never aggro on it.
  
  The fix is to always reply `0x0100` (true), or turn off `check_los_during_player_cast` and `check_los_before_aggro`.
- **Position updates (0xA9) must keep coming.** Without one at least every 5 s the player goes soft link-dead. Heading packets (0xBA) don't reset that timer.
- **Melee needs three things:** the target set with view bits (0xB0 flags `0x6000`), the player facing it within a 120° cone, and 3D distance ≤ 128 (+32 if either side is moving). Z matters for range checks, but the server never validates Z.
- **Account creation is throttled per IP.** By default the server refuses a new account if another account from the same IP was created in the last 15 minutes. Set `time_between_account_creation_sameip=0`, or pre-insert accounts with SQL (§1.1).
- **Navmeshes:** the runtime format is standard Detour `MSET` built with 64-bit polyrefs. No `.nav` files ship except `Pathing/Detour/Test/zone078.nav`. Building them needs a retail DAoC install. The Docker image ships neither the native Detour library nor any navmeshes, so NPCs fall back to `NullPathfindingMgr`.
- **Bundleable world data:** the DB dump (~70 MB SQL) has 97,737 mob spawns with absolute region coordinates, 481 zones, 34,545 item templates and 52,341 merchant rows. It's usable as SDK data in the same way rs-sdk ships `collision-data.json`. It has **no terrain heights**.

---

## 1. Accounts, characters, GM privileges, commands

### 1.1 Account auto-creation
File: `GameServer/packets/Client/168/LoginRequestHandler.cs`.

**Both switches must be true:**
- `serverconfig.xml <AutoAccountCreation>` (Docker env `AUTO_ACCOUNT_CREATION`), read at `GameServerConfiguration.cs:154`;
- server property `allow_auto_account_creation` (default true, `ServerProperties.cs:2401`).

**Login checks, in order:**
1. Server status.
2. `IsAllowedToConnect`.
3. Account already logged in → `0x0b`, or link-death logout in progress → `0x11`.
4. Username must match `^[a-zA-Z0-9]*$` (otherwise `InvalidAccount 0x02`).
5. DB lookup by key = username.

**If the account doesn't exist (line 273):**
- An empty password → `0x02`.
- Any account with `LastLoginIP == ip` created less than `time_between_account_creation_sameip` minutes ago (default **15**) → `ServiceNotAvailable`.
- Accounts from that IP ≥ `total_accounts_allowed_sameip` (default 20) → denied.
- `time_between_account_creation` (default 0) is a global throttle.
- Otherwise a new `DbAccount` is created: `Realm=0`, `PrivLevel=1`, `Password=CryptPassword(pw)`.

**Existing account:**
- A stored password not starting with `##` is upgraded to the hash on the fly, so a plaintext password inserted by SQL works.
- Wrong password → `0x01`.
- If `queue_api_url` is set, a queue whitelist call is made (off by default).
- More than `max_players` (4000) clients → `0x0c`.

**`CryptPassword` (line 479), for a TS port:**
- Take each UTF-16 char as two bytes `[hi, lo]`.
- MD5 the result.
- Output `"##"` + each hash byte formatted with `ToString("X")`. That is uppercase hex **without zero padding**: `0x0A` → `"A"`, `0x00` → `"0"`.

**Pre-creating bot accounts by SQL:**
`INSERT INTO account (Name,Password,CreationDate,PrivLevel,Account_ID) VALUES ('bot1','secret',NOW(),1,UUID());` (a plaintext password gets hashed on first login).

**Other account properties:**
- `allow_dual_logins` (default true).
- `allow_all_realms` (default false). When false, an account is tied to one realm, so use one account per realm or set it to true.

### 1.2 Character creation
File: `GameServer/packets/Client/168/CharacterCreateRequestHandler.cs`, client opcode `0xFF`.

**Version 1.125+ layout, one character per packet** (`CreationCharacterData` ctor at line 263). Read order:

| Field | Encoding / notes |
|---|---|
| `CharacterSlot` | u8 |
| `CharName` | int-pascal string, little-endian length (`ReadIntPascalStringLowEndian`) |
| skip | 4 bytes |
| face fields | `CustomMode`, `EyeSize`, `LipSize`, `EyeColor`, `HairColor`, `FaceType`, `HairStyle`: u8 each |
| skip | 3 bytes |
| `MoodType` | u8 |
| skip | 9 bytes |
| `Operation` | u8: 1 = create, 2 = customize, 3 = delete (delete needs an empty name) |
| `CustomizeType` | u8: 1 = face, 2 = attributes, 3 = both |
| skip | 2 bytes |
| skip | 5 + 5 + 5 bytes (location, class and race strings) |
| `Class`, `Realm` | u8, u8. **Version 1.125 only:** a level byte comes before Class. |
| race/gender byte | `Race = b & 0x1F`, `Gender = (b >> 7) & 1` |
| `CreationModel` | u16 little-endian |
| (1.125 only) | `Region` u8 + 5 skipped bytes |
| stats | STR, DEX, CON, QUI, INT, PIE, EMP, CHR: u8 each |
| skip | 43 bytes |
| `NewConstitution` | u8 (used for customize) |

- If `Realm > 0`, the server does `CharacterSlot -= (Realm-1)*10`.
- The stored `AccountSlot = slot + realm*100`.
- On success the server replies with `SendLoginGranted()` again, and the client should then re-request the character overview.

**Validation** (`IsCharacterValid`, line 920; `CharacterStatValidator.cs`):
- The name must match `^[A-Z][a-zA-Z]` and be at least 3 characters. Otherwise a plvl-1 account is disconnected (and banned if `ban_hackers`).
- Realm 1–3; level must be 1.
- Class must be in `GlobalConstants.STARTING_CLASSES_DICT[realm]` (`GlobalConstants.cs:938`), which allows both base and advanced classes.
- Race must be in `charClass.EligibleRaces`.
- Gender constraints: minotaurs male only; Valkyrie and Bainshee female only.
- `DISABLED_CLASSES` and `DISABLED_RACES` properties apply.
- `CreationModel` is **not validated**.

**Stat budget:**
- Per-race base stats come from `GlobalConstants.STARTING_STATS_DICT` (`GlobalConstants.cs:910`). Examples: Briton is 60 in all stats; Troll is STR 100, CON 70, DEX 35, QUI 35, rest 60.
- Cost per stat: let `above = stat - base`. Cost = `above + max(0, above-10) + max(0, above-15)`.
- The total over all 8 stats must be **exactly 30**.
- At level 1 the primary/secondary/tertiary class stats don't change anything.
- Example: Briton(1) Armsman(2) male, STR/DEX/CON 70, everything else 60.

**Race IDs:** Briton 1, Avalonian 2, Highlander 3, Saracen 4, Norseman 5, Troll 6, Dwarf 7, Kobold 8, Celt 9, Firbolg 10, Elf 11, Lurikeen 12, Inconnu 13, Valkyn 14, Sylvan 15 (16–21 are disabled).

**Post-create scripts** (all hook `DatabaseEvent.CharacterCreated`):
- `scripts/startup/script/StartAsBaseClass.cs`: `start_as_base_class` (default **true**), e.g. Armsman becomes Fighter(14). Promotion happens later at a trainer.
- `CharacterCreationSettings.cs`: `starting_level` (default 1; applied after validation, so it's safe), `starting_money` (copper), `starting_bps`, `starting_realm_level`.
- `StartupEquipment.cs`: reads the `starterequipment` table.
- `CharacterCreationCraft.cs`.
- `scripts/gameevents/StartupLocations.cs`: picks the first `startuplocation` row matching `MinVersion<=ver`, `ClassID` (0 or exact), `RaceID`, `RealmID`, `ClientRegionID` (0 or `ch.Region`), ordered by specificity. It also binds the character there.
- The DB has 183 rows, none of them tutorial (region 27). Albion starts in region 1 or 51, Midgard in 100 or 151, Hibernia in 200 or 181. Example: Briton Armsman → (574123, 530520, 2933), heading 3077, region 1 (Camelot Hills).

### 1.3 Character select and in-game
- On character selection, `StartupLocations.CharacterSelection` repairs a character with XYZ = 0.
- `disable_quit_timer` (default false). GM accounts can always quit instantly.

### 1.4 GM privileges
**PrivLevel values:** 1 = Player, 2 = GM, 3 = Admin.
- Set by SQL: `UPDATE account SET PrivLevel=3 WHERE Name='bot1';` then reconnect. In-game: `/plvl <n> <player>` (admin only).

**Side effects of PrivLevel > 1:**
- Can't be attacked: `AbstractServerRules.cs:387`, `GamePlayer.IsAttackable` at line 260.
- No fall damage (`AbstractServerRules.cs:564`).
- Exempt from the speed check (`PlayerMovementMonitor`, `PrivLevel <= Player`).
- Can equip anything; interacts without the distance check (`GameObject.Interact`, line 843).
- Can pick up loot it doesn't own; no potion or item cooldowns; no idle kick; no news.
- Not suitable for testing real PvE bot behaviour.

**Single-command grants without GM (recommended):**
- `ScriptMgr.HandleCommand` (`gameutils/ScriptMgr.cs:255`) allows a command if `Account.PrivLevel >= cmd.lvl` **or** `SinglePermission.HasPermission(player, cmdNameWithout&)`.
- Table `singlepermission(PlayerID, Command, SinglePermission_ID)`. `PlayerID` is either the character ObjectId or the **account name**; `Command` is the name without the prefix, e.g. `jump`, `player`, `item`.
- Example: `INSERT INTO singlepermission (PlayerID,Command,SinglePermission_ID) VALUES ('bot1','jump',UUID());`
- Partial command names only resolve up to your plvl, so send full command names.

### 1.5 Command system
- Client packet `0xAF` (`PlayerCommandHandler.cs`): skip 1 byte; **before version 1.127** skip 7 more; then `ReadString(255)` (null-terminated or fixed). The client sends `&cmd args`; `/` is translated to `&`.
- Unknown commands get `"No such command (/x)"` as a `CT_System` message.
- Parsing: whitespace-separated, `"quoted strings"` supported, exact match first then unique prefix.
- `command_spam_delay` (1500 ms) applies to commands that call `IsSpammingCommand`; `/whisper` uses 500 ms.

**Player commands** (`GameServer/commands/playercommands/`, ~150 files). Bot-relevant ones:
- `/stuck` (warp to the last safe position), `/target <playerName>`, `/assist [name]`, `/faceloc x y` (zone coordinates), `/facegloc`, `/gloc`, `/where <npc>`.
- `/release [city|bind|house]` (allowed 10 s after death; automatic after 900 s).
- `/sit` (`/rest`), `/stand`, `/sprint`, `/bind`, `/autoloot on|off`.
- `/train` (`/trainline`, `/trainskill`) `<line> <amount>`, `/respec`, `/level` (instant level 20 if the account has a level 50), `/xp`, `/stats`, `/quit`.
- `/whisper` (`/whis`): this is **how NPC dialogs, trainers, teleporters and quests work**. Target the NPC and whisper the `[keyword]` shown in its text.
- `/say`, `/group`, `/invite`, `/disband`, `/makeleader`, `/buff`, `/backupstyle`, `/cancelstyle`, `/range`, `/time`, `/region`.

**`/stick`, `/follow` and `/face` do not exist on the server.** They are client-side in the retail client, so the SDK has to implement them (by sending heading and position).

**GM commands** (`commands/gmcommands/`):
- `/jump to <x> <y> <z> [region]`, `/jump to <name>`, `/jump rel x y z`, `/jump push|pop`.
- `/player level <n>|levelup|xp <n>|money <type> <n>|rez|kill|class ...`, `/item create <id_nb> [count]`, `/speed`, `/heal`, `/harm`, `/cast`, `/mob`, `/npc`, `/zone info`, `/debug`, `/teleport`, `/area`, `/kick`, `/clientlist`.

**Admin commands** (`commands/admincommands/`):
- `/serverproperties refresh|cleanup` (re-reads the DB; it can't set values).
- `/speedhack <prop> <value>` changes `PlayerMovementMonitor` statics, not persisted.
- `/reload mob|object|specs|spells|teleports`, `/plvl`, `/account`, `/shutdown`, `/fixnpcspawn` (needs navmesh), `/freeze`, `/code`.

---

## 2. Server properties useful for bots

- **Storage:** table `serverproperty(Category, Key PK, Description, DefaultValue, Value, ...)`. In the DB dump it is **empty**. On first boot `ServerProperties.Load` inserts every `[ServerProperty]` with its default (`ServerProperties.cs` ~2560–2650).
- **Changing a value:** `UPDATE serverproperty SET Value='0' WHERE `Key`='...';`, then `/serverproperties refresh` (admin) or a restart. Values are parsed with en-US culture into the default value's type. Some keys contain spaces.

| Key | Default | Relevance |
|---|---|---|
| `allow_auto_account_creation` | true | also needs serverconfig `AutoAccountCreation` |
| `time_between_account_creation_sameip` | **15** (minutes) | **set to 0** for many bots |
| `total_accounts_allowed_sameip` | 20 | raise |
| `time_between_account_creation` | 0 | global throttle |
| `allow_dual_logins` | true | |
| `allow_all_realms` | false | one account across realms |
| `max_players` | 4000 | |
| `staff_login` / `tester_login` | false | |
| `client_version_min` / `client_version_max` / `client_type_max` | -1 | |
| `client_enable_encryption_rc4` | false | keep false (no RC4) |
| `ban_hackers` | false | keep false: forged flags are then stripped or kicked instead of banned |
| `xp_rate`, `cl_xp_rate`, `rvr_zones_xp_rate` | 1.0 | |
| `XP_Cap_Percent` | 125 | per-kill XP cap, % of level |
| `rp_rate`, `bp_rate`, `money_drop` | 1.0 | |
| `pve_melee_damage`, `pve_spell_damage` | 1.0 | |
| `pve_mob_damage_f1` / `pve_mob_damage_f2` | 2.5 / 120.0 | lower = mobs hit harder |
| `health_regen_amount_modifier`, `endurance_regen_amount_modifier`, `mana_regen_amount_modifier` | 1.0 | faster bot cycles |
| `npc_min_respawn_interval` | 5 (minutes) | |
| `starting_level`, `starting_money`, `starting_bps`, `starting_realm_level` | 1 / 0 / 0 / 0 | |
| `start_as_base_class` | true | |
| `disable_tutorial` | false | |
| `free_respec`, `custom_train` | false / true | |
| `enable_pve_speed` | false | +25% speed out of combat in PvE |
| `enable_encumberance_speed_loss` | true | |
| `check_los_before_aggro` | **true** | mobs need a client LoS reply to aggro |
| `check_los_during_player_cast` | **true** | caster must answer LoS |
| `check_los_before_aggro_fnf`, `check_los_during_npc_cast`, `check_los_during_npc_ranged_attack` | false | |
| `los_check_timeout` | 1500 ms | |
| `world_pickup_distance` | 256 | loot and merchant range |
| `world_item_decay_time` | 180000 ms | |
| `world_npc_update_interval` | 5000 ms | NPC re-broadcast |
| `world_player_update_interval` | 1000 ms | |
| `world_object_update_interval` | 30000 ms | |
| `player idle kick` / `minutes to kick` | false / 60 | |
| `disable_quit_timer` | false | |
| `pve_exp_loss_level`, `pve_con_loss_level` | 6 | death penalties |
| `game_loop_tick_rate` | 30 | ~33 ms tick |
| `debug_load_regions` | "" | `;`-list of regions to load (faster boot) |
| `disabled_regions`, `disabled_expansions`, `disabled_commands` | "" | |
| `log_all_gm_commands`, `enable_audit_log` | false | |
| `atlas_api` | false | HTTP API on :5000 (`GameServer/API/ApiHost.cs`): `/player/{name}`, `/player/getAll`, `/stats`, ... |
| `allow_auto_backup_styles`, `auto_select_opening_style` | false | |
| `allow_vault_command` | false | |
| `motd`, `starting_msg` | | |

---

## 3. Movement validation (what the client must send)

### 3.1 Position update, client opcode 0xA9
`PlayerPositionUpdateHandler.cs:61`, version ≥ 1.124. This is a TCP handler, and the same opcode can also arrive over UDP.

| Field | Encoding / notes |
|---|---|
| x, y, z | f32 little-endian each. Absolute region coordinates. |
| speed | f32 LE. Becomes `CurrentSpeed` (forced to 0 if crowd-controlled). `IsMoving = CurrentSpeed != 0`. |
| zSpeed | f32 LE. Becomes `FallSpeed`. |
| sessionId | u16, skipped |
| objectId | u16, version ≥ 1.127 only, skipped |
| zoneId | u16 BE. **Must be a valid zone**, otherwise the client is kicked to the character screen. Only drives zone-enter messages and areas. |
| stateFlags | u8, see below |
| unknown | u8 |
| fallingDamage | u16 BE. Bit 15 = on ground. |
| heading | u16 BE. 0..4095 in the low 12 bits (`Heading & 0xFFF`); upper bits kept as `RawHeading`. |
| actionFlags | u8, see below |
| unknown | 2 bytes |
| health | 1 byte |
| trailing | 2 bytes (+2 more for 1.127+) |

**stateFlags:**
- `0x80` strafe right, `0x40` strafe left, `0x20` strafe full speed, `0x10` sitting, `0x08` jumping, `0x04` swimming.
- Combinations: DEAD = `0x14`, RIDING = `0x18`, FLYING = `0x0C`, CLIMBING = `0x1C`.
- RIDING while not riding, and FLYING without `/debug` or allow-fly, are stripped (or banned if `ban_hackers`). DEAD is stripped while HP > 0.

**actionFlags:**
- `0x80` torch, `0x40` teleport (not trusted).
- **`0x30` TARGET_IN_VIEW.** Both bits are tested together, so set `0x30` whenever the target is visible.
- `0x08` ground target in view, `0x04` pet in view, `0x02` diving, `0x01` wireframe.

### 3.2 Heading update, client opcode 0xBA
`PlayerHeadingUpdateHandler.cs`:
- sessionId u16, then target u16 (1.127+), heading u16, unknown u8, actionFlags u8, steed slot u8, then a state byte. The state byte uses position-update stateFlags shifted right by 2, without strafe bits.
- It does **not** update `LastPositionUpdatePacketReceivedTime`.

### 3.3 Timeouts
- **Soft link-death** (`ECS-Components/PlayerMovementComponent.cs:15,54`): with no 0xA9 (or 0xBB, 0x71 or 0x7D, which carry a position) for **5000 ms**, `OnLinkDeath(true)` runs. The next position packet is swallowed: `IsPositionUpdateFromPacketAllowed` moves the player back to the link-death location and returns false.
- **Hard timeout** (`ECS-Services/ClientService.cs:18,741`): disconnect if `PingTime` is older than 150000 ms. `PingTime` is refreshed by 0xA3 PingRequest. Send a ping about every 5–10 s.
- **UDP:** `UdpConfirm` resets after 70 s without 0xF2 UDPPingRequest. Server-to-client UDP packets then fall back to TCP (`PacketProcessor.cs:240`), **so a headless client can skip UDP completely**.
- **Recommended cadence:** 0xA9 every 200 ms while moving (the server broadcasts at most every 200 ms) and every 1–2 s while idle; ping every 10 s.

### 3.4 Speed-hack detection
`gameutils/PlayerMovementMonitor.cs`.

**How samples are taken:**
- A sample is recorded only when **XY** changes (`UpdatePosition`; Z is ignored).
- Each sample stores the processing timestamp and `maxSpeed = Steed?.MaxSpeed ?? MaxSpeed`.
- `PLAYER_BASE_SPEED = 191` (`GamePlayer.cs:8133`). The server tells the client its max speed through the max-speed update packet.
- Two samples in the same game-loop tick: the later one overwrites the earlier.

**The check (`ValidateMovement`):**
- `dt = (cur.ts - prev.ts) + tickDuration` (~33 ms).
- Allowed distance = `allowedSpeed * MaxSpeedToleranceFactor(1.15) * dt/1000`.
- Distance is 2D, comparing squared values.
- After a speed decrease, the old max speed stays valid for `LatencyBuffer` (750 ms).

**What happens on violations:**
- `ViolationThreshold` (6) violations within `ViolationValidityDuration` (1500 ms, plus accumulated pause time) → teleport back to the sample before the first violation.
- After `TeleportThreshold` (5) consecutive teleports → kick.
- Exempt: accounts with PrivLevel > 1 and `IsAllowedToFly`.
- `ForceUpdatePosition` (server-side teleport or MoveTo) pauses recording for 750 ms.

**What this means for the bot:**
- Compute positions from real elapsed time × (maxSpeed × 0.95) and send at a steady cadence.
- A single large jump counts as only one violation, so isolated warps are not caught. That is an exploit; prefer GM `/jump`.
- There is no explicit teleport, Z or wall check.

**Safe position for `/stuck`:** sampled every 1500 ms; the saved spot is replaced once the player has moved more than 125 units.

### 3.5 Z and fall damage
- Z is **not validated**.
- Fall damage applies only if bit 15 of `fallingDamage` (on ground) is set **and** `-zSpeed - 100*SafeFall > 500`, so sending `zSpeed=0` means no damage. `MaxLastZ` resets on region change.
- Z still matters for gameplay:
  - all `IsWithinRadius` checks are **3D** (`world/Point3D.cs:126`) except loot pickup;
  - melee range is 128;
  - interact is 192;
  - mob aggro range;
  - what other players see.
- Where the client can get Z from:
  - server object-create and position updates for nearby NPCs and players;
  - the DB spawn `Z` column;
  - navmesh `FindClosestPoint` (§5);
  - `/gloc`;
  - `startuplocation.ZPos`.

### 3.6 Heading math
`world/Point2D.cs:102`:
- `heading = atan2(-dx, dy) * 4096/(2π)`, plus 4096 if negative. 0 points toward +Y (south) and the value increases clockwise.
- A point at a given heading and distance: `(x - sin(a)*d, y + cos(a)*d)`.
- `IsObjectInFront(target, arcDeg, alwaysTrueRange=32)` is `GameObject.cs:167`.

---

## 4. Server-side flows for combat, spells, loot and merchants

Client opcodes are listed in `packets/Server/IPacketLib.cs` (`enum eClientPackets`).

### 4.1 Targeting, client opcode 0xB0
`PlayerTargetHandler.cs`:
- `targetId u16, flags u16`.
- Flags: `0x8000` examine (the server sends examine text), `0x4000 | 0x2000` = in view (either bit counts), `0x0001` attack mode.
- A target farther than `VISIBILITY_DISTANCE` (6000) → the server sends an object delete.
- Missing view bits → the server says "Target is not in view." and sets `TargetInView=false`.
- `GamePlayer.TargetInView` (line 126) is always true within 64 units (100 if the target is a moving player).

### 4.2 Melee, client opcode 0x74
`PlayerAttackRequestHandler.cs`:
- `start u8 (≠0 = start), userAction u8 (0 = user pressed)`.
- Refused if the active weapon slot is ranged.
- Each swing (`ECS-Components/Actions/WeaponAction.cs:387`) needs:
  - `IsObjectInFront(target, 120)` and `TargetInView`, otherwise `TargetNotVisible`;
  - range `AttackRange`: player melee = 128, +32 if the target moves, +32 if self moves, +150 against keep components (`GamePlayer.cs:5277`);
  - bows: long 1760, recurve 1680, composite 1600, thrown 1160 (1450 for "weighted"), other 1200. Modified by the ArcheryRange property and ammo, plus `ΔZ/2` (`AttackComponent.cs:148`).
- Results arrive as chat messages (`CT_YouHit`, ...) plus combat animation packets.

### 4.3 Styles, spells and abilities
**0xBB UseSkill** (`UseSkillHandler.cs`), version ≥ 1.124:
- `x, y, z f32 LE, speed f32 LE, heading u16`; applied as a position update.
- `flagSpeedData u16`: `0xA000` = target in view (either bit), `0x1000` = ground target in view, `0x4000` = strafing.
- `index u8, type u8`. The index points into `player.GetAllUsableSkills()`. If `type > 0`, the index is offset past the specializations.
- **The SDK must mirror the order of the skill-list update packet.**
- Dispatch: specialization → spec action; ability → `RequestUseAbility`; spell → cast; style → `ExecuteWeaponStyle` (or set the backup style).

**0x7D UseSpell** (`UseSpellHandler.cs`):
- Same position prefix, then `flagSpeedData u16, spellLevel u8, spellLineIndex u8`.
- Resolution: `GetAllUsableListSpells()[lineIndex]`, first entry whose `spell.Level == spellLevel` (styles and abilities match on `SpecLevelRequirement`).

**0x71 UseSlot** (`UseSlotHandler.cs`): same prefix, then `flagSpeedData u16, slot u8, type u8`, passed to `GamePlayer.UseSlot`. Used for quickbar items, potions and switching weapon slots.

**Casting rules** (`spells/SpellHandler.cs`):
- Any XY change calls `OnPlayerMove`, which interrupts casting (`CasterMoves`), stands the player up, and interrupts realm abilities and crafting (`GamePlayer.cs:~8580`). **Stop sending XY changes for the whole cast time.**
- Initial `HasLos = TargetInView` (line 487). With `check_los_during_player_cast`, the server sends CheckLOSRequest and only a `True` reply keeps LoS (`CastingComponent.cs:515`). A timeout counts as no LoS.
- The target must be in front within 180° (lines 745, 960) and within `Spell.Range`.

**LoS protocol** (`gameutils/LosCheckHandler.cs`):
- Server → client: `CheckLOSRequest` = `u16 sourceOid, u16 targetOid, u16 0, u16 0`.
- Client → server: 0xD0 = `u16 sourceOid, u16 targetOid, u16 flags` (`flags & 0x100` = true).
- Replies are cached for 5 s per (source, target) pair until either side moves.
- Mobs aggroing on a player send this request **to that player** (`StandardMobBrain.cs:105,164,472`), and pet-related checks go to the owner. **Reply true for every request**, or ray-cast against the navmesh.

### 4.4 Sitting and death
- 0xC7: `u8 status` (≠0 = sit).
- After death: `/release` (minimum 10 s; automatic at 900 s; `GamePlayer.cs:1360`). The server then moves the player to the bind point.

### 4.5 Loot
- **Autoloot is on by default** (`DbCoreCharacter.cs:202 m_autoloot=true`).
- `AbstractServerRules.DropLoot` (line 1209): for each item owner (from damage dealt), `TryAutoPickUp` picks up items and money for the battlegroup, group or player. Usually no packets are needed.
- Manual pickup, 0xB5 (`PlayerPickUpRequestHandler.cs`):
  - `u32 x, u32 y, u16 id, u16 obj`. These fields are ignored; the server uses `TargetObject`. **Target the floor item with 0xB0 first.**
  - Range is `world_pickup_distance` (256), **ignoring Z**.
  - The player must be an owner (unless PrivLevel > 1), and the pickup timer must have expired (`GamePlayer.PickupObject`, line 9555).
- Loot tables in the DB: `mobxloottemplate(MobName → LootTemplateName, DropCount)`, `loottemplate(TemplateName, ItemTemplateID, Chance, Count)`, `lootgenerator`, `loototd`, and the generated random-object (ROG) property settings.

### 4.6 NPC interaction and merchants
- **Interact 0x7A** (`ObjectInteractRequestHandler.cs`): `u32 x, u32 y, u16 sessionId, u16 targetOid`. The object must be within 6000. `GameObject.Interact` then requires ≤ `INTERACT_DISTANCE` (192, 3D) for PrivLevel 1.
  - A merchant replies with the merchant window.
  - Trainers, teleporters and quest NPCs reply with text containing `[keywords]`. Answer with `&whisper keyword` while the NPC is targeted.
- **Buy 0x78** (`PlayerBuyRequestHandler.cs`):
  - `u32 x, u32 y, u16 id, u16 itemSlot, u8 count, u8 menuId`.
  - Normal merchant: `itemSlot = page*30 + slot` (`MerchantTradeItems.cs:34`; max 5 pages).
  - `TargetObject` must be a `GameMerchant`, `GameGuardMerchant`, currency guard merchant or lot marker.
  - Housing `menuId` values route to `HouseMgr`.
  - Range ≤ `world_pickup_distance` (256) (`GameMerchant.cs:114`). Needs money and backpack space.
- **Sell 0x79:** `u32 x, u32 y, u16 id, u16 inventorySlot`. Target the merchant; the sale price is `item_sell_ratio` (50%) of value.
- **Move, equip or drop 0xDD** (`PlayerMoveItemRequestHandler.cs`): `u16 ?, u16 toSlot, u16 fromSlot, u16 count`.
  - `toSlot > 1000` moves to the target object.
  - Paper-doll slots are converted automatically.
  - Ground = drop.
  - `GeneralVault` = vault.
  - Valid ranges: Ground..LastBackpack, vault and horse bags (see `eInventorySlot`).
- **Trading** (0xEB `ModifyTrade`, the `/trade` command) is closed if the partner is farther than `GIVE_ITEM_DISTANCE` (128).
- **Distance constants** (`world/WorldMgr.cs:28–64`): whisper / say / info 512, yell 1024, give item 128, interact 192, visibility 6000.

---

## 5. Pathing and navmeshes

**Server side** (`GameServer/world/Pathfinding/LocalPathfindingMgr.cs`):
- Loads `navmesh/zone{ID:D3}.nav`, falling back to `pathing/zone{ID:D3}.nav`, relative to the working directory, in parallel for all zones.
- Needs the native library `lib/Detour.dll` (Windows) or `lib/libDetour.so` / `lib/Detour.so` (`Pathing/Detour.Managed/DetourNativeLibrary.cs`).
- If missing, `PathfindingProvider` uses `NullPathfindingMgr` (NPCs walk straight lines; `/fixnpcspawn` does nothing).
- Doors register their nearby polygons and toggle the `BlockingDoor` flag.

**Native API** (`Pathing/Detour/Include/DetourInterface.hpp`, `extern "C"`; loadable from Bun FFI):
- `LoadNavMesh(path, dtNavMesh**)`, `FreeNavMesh`, `CreateNavMeshQuery(mesh, query**)` (MAX_NODES 4096), `FreeNavMeshQuery`.
- `PathStraight(query, start[3], end[3], polyPickExt[3], filter[2]{include, exclude}, options, int* count, float* pts, flags*)`.
- `MoveAlongSurface`, `FindRandomPointAroundCircle`, `FindClosestPoint`, `FindClosestPointInBox`, `HasLineOfSight(..., bool* hasLos, float* hit)`, `UpdateFlags`, `GetPolyAt`, `GetPolysInBox`.
- All return `dtStatus`.

**Build:** CMake in `Pathing/Detour`, `RECASTNAVIGATION_DT_POLYREF64=ON` by default. **Navmeshes must be 64-bit-polyref builds**, so stock 32-bit recast WASM ports (e.g. recast-navigation-js) will likely fail on these tiles because `dtLink` size changes.

**File format** (`DetourInterface.cpp:24–83`):
- `dtNavMeshSetHeader { i32 magic=0x4d534554 ('MSET'), i32 version=1, i32 numTiles, dtNavMeshParams{ float orig[3], tileWidth, tileHeight; i32 maxTiles, maxPolys } }`.
- Then numTiles × `{ u64 tileRef; i32 size; (4 bytes padding with 64-bit polyrefs) }` followed by `size` bytes of standard Detour tile data (`DNAV`).

**Coordinates** (`Pathing/Detour.Managed/RecastCoords.cs`):
- recast = `(X/32, Z/32, Y/32)`; game = `(rx*32, rz*32, ry*32)`.
- Default pick extents in game units `(32, 32, 64)`.
- Poly flags: Walk `0x01`, Swim `0x02`, Door `0x04`, Jump `0x08`, Disabled `0x10`, runtime BlockingDoor `0x20` (`DetourEnums.cs`).

**Getting `.nav` files:**
- `server/buildnav` (README) runs `OpenDAoC-BuildNav.exe --daoc=<retail game dir> --all=true` (or `--zones=` / `--regions=`). It is Windows-only in practice; it needs a 64-bit build, `base/RecastDemo.exe` (included) and `base/lib/Detour.dll`.
- It reads **retail client assets**: `zones/zones.mpk/zones.dat`, `zones/zoneNNN/csvNNN.mpk` (bound.csv, nifs.csv, fixtures.csv, nifproxy.csv), terrain/heightmap and water maps, `.nif`/`.npk` models, city and dungeon chunks.
- Output: `.obj` / `.gset` / `.ladders.json`, then RecastDemo produces `zoneNNN.nav`. Copy them into the server's `navmesh/` folder.
- **No navmeshes ship in any repo** (except the test `zone078.nav`, 602 KB). They can't be legally redistributed in the SDK; users must generate them from their own DAoC install.
- The same tool's intermediate heightmap/obj output could also provide a client-side Z lookup.

**SDK options:**
- (a) Bun FFI to a self-built `Detour.dll` / `libDetour.so` plus user-generated `.nav` files: full parity with the server, including `HasLineOfSight` to answer LoS honestly.
- (b) No navmesh: straight-line movement, Z taken from nearby entity updates, spawn data or `/gloc`, and LoS always answered true.
- (c) A server mod exposing pathfinding through a command or HTTP: `LocalPathfindingMgr` already has the queries.

---

## 6. Local setup

### 6.1 Docker Compose as shipped
File: `server/core/docker-compose.yml`.

- **`db`:** `mariadb:10.6`, `MYSQL_DATABASE=opendaoc`, root password `my-secret-pw`.
  - Flags: `--lower_case_table_names=1`, utf8mb3. The `--innodb_large_prefix` and `--innodb_file_format` flags are removed in 10.6 and may log warnings or errors.
  - Volume `base-db` is mounted at `/docker-entrypoint-initdb.d`. **Port 3306 is not published**; add `"3306:3306"` for SDK and SQL access.
- **`gameserver`:** `ghcr.io/opendaoc/opendaoc-core:latest`, ports `10300:10300` (TCP) and `10400:10400` (**TCP only; UDP isn't published**, which is fine given the TCP fallback in §3.3).
  - Env vars are turned into `/app/config/serverconfig.xml` by `entrypoint.sh` on every start. Keys: Port, IP, RegionIP, RegionPort, UdpIP, UdpPort, EnableUPnP, DetectRegionIP, ServerName, ServerNameShort, LogConfigFile, ScriptCompilationTarget, ScriptAssemblies, EnableCompilation, AutoAccountCreation, GameType, CheatLoggerName, GMActionLoggerName, InvalidNamesFile, DBType, DBConnectionString, DBAutosave, DBAutosaveInterval, CpuUse.
  - Then it runs `su-exec appuser dotnet CoreServer.dll` from `/app`.
- **How the DB gets seeded:** the image contains `/tmp/opendaoc-db/combined.sql` (`cat *.sql` of the DB repo cloned at build time). The gameserver mounts the same empty `base-db` volume at `/tmp/opendaoc-db`, so Docker's volume copy-up places `combined.sql` there, and MariaDB runs it on **first** init.
- **Gotchas:**
  1. This depends on the gameserver container being created before MariaDB's init runs. If the DB comes up empty, run `docker compose down -v` and retry, or use the bind mount below.
  2. Importing ~70 MB takes minutes, and the init server doesn't listen on the network meanwhile. `depends_on` doesn't wait for health and gameserver has **no restart policy**, so it can crash on DB connect. Add a healthcheck plus `condition: service_healthy`, or `restart: unless-stopped`.
  3. The server auto-creates and alters tables (`GameServer.InitDB`, line 1185, which registers every `[DataTable]`). Against an empty DB it starts with an empty world.
  4. `account`, `serverproperty` and `singlepermission` are empty after import.
  5. The `regions` table has IP `127.0.0.1` per region, but the region list sent to clients uses `Configuration.RegionIP/RegionPort` (`WorldMgr.cs:554`). A headless client can stay on the single TCP connection to 10300.
- **Recommended:** bind-mount the local submodule `- ../db/opendaoc-db-core:/docker-entrypoint-initdb.d:ro`. MariaDB runs the `*.sql` files alphabetically, and each one does its own `CREATE TABLE IF NOT EXISTS` plus `REPLACE INTO`. This removes the copy-up race and the git clone.

### 6.2 Building from local source (for server mods)
File: `server/core/Dockerfile`.

- Stage 1 (`dotnet/sdk:10.0`) does `COPY . .`, installs git, and **git-clones OpenDAoC-Database from GitHub** (needs network; `sslVerify false`). Then `cat *.sql > combined.sql`, copy `serverconfig.example.xml` → `serverconfig.xml`, `dotnet build DOLLinux.sln -c Release` (output in `/build/Release`, per `OutputPath ..\Release\`, GameServer in `..\Release\lib\`).
- Stage 2 (`aspnet:10.0-alpine`) adds icu-libs and su-exec, copies `/build/Release` → `/app`, copies `combined.sql`, then the entrypoint.
- **So yes**: `docker build -t opendaoc-local server/core`, then point the compose `image:` at it (or use `build: .`) and local C# changes go in. No `.dockerignore` exists.
- **Detour:** not built, and the image is Alpine/musl, so a `libDetour.so` must be compiled in a musl stage (CMake). Navmeshes go to `/app/navmesh/`.
- **To use the local DB instead of the clone:** pass a second build context (`docker buildx build --build-context db=../db ...`) or just use the bind mount from §6.1.
- **Hot mods without rebuilding:** `EnableCompilation=True` compiles every `*.cs` under `/app/scripts` (`GameServer.cs:653`; `ScriptMgr.CompileScripts`) into `ScriptCompilationTarget` (`./lib/GameServerScripts.dll`) at startup. Bind-mount a host folder to `/app/scripts` to add custom `[Cmd("&botapi",...)]` commands, `[ServerProperty]` fields, event hooks or packet handlers. The built-in `GameServer/scripts` code is compiled into `GameServer.dll`.

### 6.3 Running without Docker
- `dotnet build DOLLinux.sln -c Release`, then run `Release/CoreServer.dll` with `Release/config/serverconfig.xml` (template in `CoreServer/config/serverconfig.example.xml`).
- Example connection string: `Server=localhost;Port=3306;Database=opendaoc;UserId=root;Password=...;TreatTinyAsBoolean=true`.
- `DBType` can be `MYSQL` or `SQLITE`, but the dump is MySQL syntax.
- Set `EnableUPnP` to false.

### 6.4 Post-boot SQL for bots
```sql
UPDATE serverproperty SET Value='0'    WHERE `Key`='time_between_account_creation_sameip';
UPDATE serverproperty SET Value='1000' WHERE `Key`='total_accounts_allowed_sameip';
UPDATE serverproperty SET Value='True' WHERE `Key`='allow_all_realms';
-- optional: xp_rate, check_los_before_aggro/check_los_during_player_cast=False, disable_quit_timer=True
```
Rows only exist after the first boot. Afterwards restart, or run `/serverproperties refresh` as admin. Under Docker Desktop every bot appears from the same source IP (the docker gateway), so the per-IP limits always apply.

---

## 7. Static world data for the SDK

All files are in `server/db/opendaoc-db-core/*.sql`, one table per file: `CREATE TABLE IF NOT EXISTS` plus `REPLACE INTO ... VALUES` followed by rows starting `\t(`. The column order is given explicitly in each `REPLACE INTO`. These can be parsed offline into JSON.

| Table (rows) | Key columns | Notes |
|---|---|---|
| `mob` (97,737; 29.8 MB) | ClassType, Name, Guild, **X, Y, Z (absolute region coordinates)**, Speed, Heading, Region, Model, Size, Level, Realm, EquipmentTemplateID, ItemsListTemplateID (merchant list), NPCTemplateID, Race, Flags, AggroLevel, AggroRange, RespawnInterval, FactionID, BodyType, Brain, PathID, RoamingRange, PackageID, Mob_ID (PK) | ClassType counts: GameNPC 90,364; GameMerchant 1,218; GameGuard 981; GameEpicNPC 976; GameHastener 213; GameStableMaster 126; GameHealer 79; Blacksmith 78; trainers, teleporters, ... NPC flags: GHOST 0x01, STEALTH 0x02, DONTSHOWNAME 0x04, CANTTARGET 0x08, PEACE 0x10, ... |
| `npctemplate` (12,933) | TemplateId, Name, ClassType, Model (text, may be a list), Size, Level (text, may be a range), MaxSpeed, Flags, Spells, Styles, stats, AggroLevel, AggroRange, Race, BodyType, TetherRange | |
| `npcequipment` (55,592) | | visible gear |
| `itemtemplate` (34,545; 14 MB) | Id_nb (key used by `/item create` and merchant lists), Name, Level, Price, Object_Type, Item_Type, DPS_AF, SPD_ABS, bonuses, ... | |
| `merchantitem` (52,341) | ItemListID (= mob.ItemsListTemplateID), ItemTemplateID, PageNumber, SlotPosition | buy `itemSlot = Page*30 + Slot` |
| `zones` (481) | ZoneID, RegionID, Name, IsLava, DivingFlag, WaterLevel, **OffsetY, OffsetX, Width, Height in 8192-unit blocks** (`WorldMgr.cs:608`), Experience, Realmpoints, Bountypoints, Coin, Realm | Example: Camelot Hills = zone 0, region 1, OffX 67, OffY 59, 8×8 blocks → X 548864–614400. Converts absolute ↔ zone-local coordinates and gives the zoneId for 0xA9. |
| `regions` (354) | RegionID, Name, Description, Expansion, HousingEnabled, DivingEnabled, WaterLevel, ClassType, IsFrontier | |
| `zonepoint` (169) | Id, Target XYZ/Region/Heading, Source XYZ/Region, Realm, ClassType | region-change portals; the client sends 0x90 RegionChange with the zone-point ID |
| `bindpoint` (207) | X, Y, Z, Radius, Region, Realm | |
| `startuplocation` (183) | | §1.2 |
| `teleport` (71) | Type, TeleportID (whisper keyword), Realm, RegionID, X, Y, Z, Heading | |
| `door` (432) | InternalID encodes zone (`zone*1000000 + ...`), X, Y, Z, Heading, Type, Realm, Locked, State | |
| `worldobject` (799) | | |
| `area` (73) | | |
| `keep` (79), `keepcomponent`, `keepposition` | | |
| `path` (459), `pathpoints` (19,782) | | NPC patrol routes |
| `loottemplate` (1,792), `mobxloottemplate` (3,219), `lootgenerator`, `loototd` | | |
| `spell` (4,152), `spellline` (167), `linexspell` (3,718), `style` (1,199), `stylexspell`, `specialization` (158), `specxability`, `ability` (331), `classxspecialization` (396), `classxrealmability_atlas` | | skill and spell metadata for decoding 0x16 skill lists and planning rotations |
| `dataquest` (238), `quest`, `task` | | |
| `faction`, `linkedfaction`, `factionaggrolevel` | | |
| `starterequipment`, `salvage`, `salvageyield`, `craftedxitem` / `crafteditem` | | |

- **Not in the DB:** terrain heights, collision geometry, water polygons beyond zone or region water levels.
- **Comparison with rs-sdk:** rs-sdk bundles `sdk/collision-data.json` (27.5 MB, tile flags; refreshed by `sdk/fetch-collision-data.ts`, imported by `sdk/pathfinding.ts`). The DAoC equivalent is DB-derived JSON (spawns, NPCs, merchants, zones, zonepoints, items, spells) that can be redistributed under GPL-3, plus **optional user-generated navmeshes** for geometry.