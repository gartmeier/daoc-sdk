# BUILD

Both tasks are done. The data build and setup script both ran for real, and `bun test data scripts` passes (23 tests); tsc reports no errors in `data/` or `scripts/` (the only errors are in `sdk/formatter.ts`, not mine). `setup-server` restarted the live gameserver (it was back in about 12 s); nothing reached it since.

**Files created**
- `C:/Users/joshu/Code/daoc-sdk/data/build.ts` — builders and the data shapes
- `C:/Users/joshu/Code/daoc-sdk/data/index.ts` — loaders and query helpers
- `C:/Users/joshu/Code/daoc-sdk/data/data.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/scripts/build-data.ts` — `bun run data:build [--force] [file...]`
- `C:/Users/joshu/Code/daoc-sdk/scripts/setup-server.ts` (plus `setup-server.test.ts`)
- `C:/Users/joshu/Code/daoc-sdk/docs/SERVER.md`
- `sql.ts` and `zones.ts` are unchanged.

**Generated data** (`data/generated/`, about 1.5 s for a full build; reruns skip files newer than their sources and say "up to date"):

| File | Size / entries | Notes |
|---|---|---|
| `npcs.json` | 11.8 MB, 97,737 spawns | Compact `{columns, rows}` |
| `items.json` | 3.3 MB, 34,545 | Compact `{columns, rows}` |
| `merchants.json` | 3.1 MB, 1,154 lists | Compact `{columns, lists}` instead of the object list in the spec; the loader returns objects |
| Others | small | zones 481, regions 354, zonepoints 169, bindpoints 207, teleports 71, startuplocations 183, spells 4,152, spelllines 167, styles 1,199, specializations 158, abilities 331, classes 62 |

**Public API** (all from `data/index.ts`, which also re-exports everything in `zones.ts`)
- **Loading:** `loadGenerated<T>(file)` reads a generated file, or builds and writes it if missing; I tested this with the folder deleted. Each dataset has a cached getter: `getNpcSpawns()`, `getItemTemplates()`, `getZonePoints()`, `getBindpoints()`, `getTeleports()`, `getStartupLocations()`, `getSpells()`, `getSpellLines()`, `getStyles()`, `getSpecializations()`, `getAbilities()`.
- **NPC spawns:** `findNpcSpawns({name?, guild?, classType?, regionId?, near?:{x,y}, radius?, levelRange?:[min,max], realm?, limit?}): (NpcSpawn & {distance: number|null})[]`. A string matches as a case-insensitive substring; a RegExp is tested. Results are sorted by 2D distance when `near` is given.
- **Places:**
  - `nearestBindpoint(regionId, x, y, realm?)` → bind point plus `distance`, or `undefined`.
  - `getZonePointsFrom(regionId)` and `getZonePoint(id)`.
  - `getTeleportsForRealm(realm)`.
  - `getStartupLocation({realm, raceId, classId, clientVersion=1127, clientRegionId=0})` mirrors `StartupLocations.cs:142`.
- **Items and merchants:** `getItemTemplate(id)` and `getMerchantItems(itemListId)` match ids case-insensitively, like the server's cache (`DataTableHandler.cs:196,211`). Merchant entries are `{page, slot, itemSlot = page*30+slot, itemTemplateId, name, level, price, model}`. Also `findItemTemplates(name, limit?)`.
- **Skills:** `getSpell(id)`, `getSpellLine(key)`, `getStylesFor(classId, spec?)`, `getSpecialization(key)`, `getAbility(key)`.
- **Height:** `estimateZ(regionId, x, y, fallback?, {radius=3000, k=8, exclude?})` returns `number | null`, or the fallback when nothing is nearby.
  - Inverse-distance weighting over nearby known ground heights (mob spawns, bind points, startup locations, teleports, zone points), on a 1024-unit grid.
  - Samples more than 400 units from the local median are dropped; flying mobs are ignored.
  - Leave-one-out error on mob spawns in regions 1, 100 and 200 is about 25 units median and about 200 units at p90. 10,000 calls take 56 ms.
- **Classes and races** (ids parsed from the C# enums and `playerclasses/*.cs`):
  - Lookups: `getClasses()`, `getRaces()`, `getClass(idOrKeyOrName, realm?)`, `getRace(idOrName)`.
  - Lists: `getStartingClasses(realm)`, `getRacesForClass(cls, realm?)`, `getRacesForRealm(realm)`.
  - Validation: `validateCharacter({realm, class, race, gender?, stats?})` → `{valid, errors, realmId, classInfo, raceInfo}`. It mirrors `IsCharacterValid` (`CharacterCreateRequestHandler.cs:920`).
  - Stats: `getStartingStats(race)`, `statPointCost(stats, race)`, `defaultStats(cls, race, realm?)` (+10 to primary, secondary and tertiary, exactly 30 points; checked for every creatable class/race pair), `toStats()` → the SDK's `Stats` type.
  - Helpers: `realmId()`, `realmName()`, `STAT_ORDER`.

**`server:setup`**
- Flags: `--dry-run`, `--xp=N` (default 3), `--set key=value`, `--gm=acct[:lvl]`, `--ungm=acct`, `--restart` / `--no-restart`, `--timeout`.
- Each key and value type is checked against all 451 `[ServerProperty]` attributes in the C# source, and every parsed default matches the DB.
- It updates the row, or inserts it if missing, then restarts only the gameserver. It waits for a real 0xF4 → 0x22 handshake, because Docker's port proxy accepts TCP before the server is listening.
- **Live run:** three values changed (`allow_all_realms=True`, `disable_quit_timer=True`, `xp_rate=3`). The other bot properties (account limits, idle kick, `ban_hackers`, dual logins, auto account creation) were already set and stayed so.
  - SQL confirmed the new values, and the gameserver log shows it loading them (e.g. "Loading xp_rate Value is 3").
  - The handshake succeeded 12 s after the restart.
  - A second run changed nothing and did not restart.
- Not tested live: the `--gm` flag on an existing account (the `account` table was empty) and the insert path for a missing property.

**For other modules**
- **Client:** the 0xF4 frame and checksum in `setup-server.ts` match the golden bytes in `docs/research/critic.md`, and the server answered it.
- **Character creation:**
  - Valkyrie, Heretic, Warlock, Vampiir and the Maulers cannot be created. Valkyrie is in the starting list but has no eligible races; check `getStartingClasses()`.
  - Names like "Rogue" and "Mauler" exist in more than one realm, so `getClass` needs the realm, or the key ("AlbionRogue").
  - With `start_as_base_class` on, an Armsman is created as a Fighter.
- **Merchants:** list rows whose item template doesn't exist are dropped, as the server does.
- **`bun run test` skips my setup tests:** it covers only `sdk client gateway mcp data`, and `package.json` isn't mine. Run `bun test scripts` for them.
- **Rebuild after DB changes:** the lazy loaders only check that a generated file exists, not that it is current. Run `bun run data:build` after the dumps change.
- **Gaps:** `/app/scripts` (runtime C# scripts) is not mounted in the compose file. There are no terrain heights or LoS data anywhere.

# REVIEW

Review of the data, scripts, Docker and SERVER.md work is complete. I found and fixed 5 real bugs, plus one problem I flagged with a warning rather than a fix. `bun test data scripts` passes (28 tests, up from 23), `bun run data:build` rebuilds cleanly, and tsc reports no errors in `data/` or `scripts/`. I did not restart or rebuild the server containers.

**Bugs found and fixed**
1. **Bainshee was wrongly creatable** (`data/build.ts:517`, in `parseClassFile`). `ClassBainshee.cs:169` declares its races as `EligibleRaces => new() { /* all commented out */ }`. The parser only recognised `new List<PlayerRace>()`, so Bainshee silently inherited Magician's races (Celt, Elf, Lurikeen). The server rejects every Bainshee. The parser now accepts both forms and throws if a class overrides `EligibleRaces` in a form it can't read. The old test that asserted "female Elf Bainshee is valid" was wrong and is replaced.
2. **Merchant lists were split by case and had duplicate slots** (`data/build.ts:406`, `buildMerchants`).
   - The dump has `Alb1HStaff`/`Alb1hStaff`, `SpecialPotions`/`specialpotions` and `AlbTwoHandedChains`/`AlbTwohandedChains`. The server's SQL lookup is case-insensitive, so each pair is one list. The old loader lower-cased the keys and one list overwrote the other.
   - 1,477 page/slot positions hold more than one row. The server keeps the first row with a valid template, in `MerchantItem_ID` order (`MerchantTradeItems.cs:146-160`; I confirmed that order with a live query).
   - The builder now merges lists case-insensitively and keeps one item per slot. It produces 1,151 lists; the live DB has 1,152, and the only difference is a row with an empty `ItemListID`.
3. **`--set` checked values against the wrong type** (`scripts/setup-server.ts`, in `normaliseValue` and `parseServerProperties`).
   - `ServerProperties.Load` converts the DB string to the type of the default value as written in the attribute, not the field's type (`ServerProperties.cs:2632`).
   - So `double lord_autoset_con_multiplier` with default `0` only accepts integers; `1.5` used to pass the script and then fail silently in the server.
   - Added `literalType()` and a `PropertyDef.loadType` field. Validation now uses that type, with range checks for byte, short, ushort, int and uint.
4. **Gender handling in `validateCharacter` was inconsistent** (`data/index.ts`). With no gender given it errored for female-only classes but not for male-only races. It now fills in a missing gender from the constraints (else male) and returns it in a new `gender` field on the result, so the client knows what to send.
5. **Stale generated files were never rebuilt** (`data/index.ts`, `loadGenerated`). The loader only checked that a file existed. It now also rebuilds when the file is older than its sources; I tested this by touching `build.ts`.

**Flagged with a warning (no data fix possible)**
- Inconnu Acolyte and Saracen Disciple pass the server's validation, but there is no `startuplocation` row for them, so the character would spawn at 0,0,0. `validateCharacter` now returns a `warnings: string[]` field that says so.

**Tests added**
- Bainshee, Valkyrie and gender cases.
- `EligibleRaces` spot checks against the C#, plus a check that every creatable race belongs to its class's realm.
- Startup-location coverage (exactly those 2 pairs are missing).
- Merchant case-merge and slot dedupe.
- `literalType`, the `lord_autoset` case and integer ranges; every one of the 451 property defaults also passes the new validation.

**Verification performed**
- **Counts** match the live DB for mobs (97,737), items (34,545), zone points (169), bind points (207), teleports (71), spells (4,152), spell lines (167), styles (1,199), specializations (158), abilities (331), zones (481) and regions (354). Merchants match after fix 2 (49,199 rows).
- **Classes and races:** all 62 class ids and 21 race ids checked against `eCharacterClass`/`eRace`, `STARTING_CLASSES_DICT`, `STARTING_STATS_DICT` (Half Ogre, Frostalf, Shar and the Minotaurs are correctly not creatable), the gender constraints, and `IsCharacterValid`/`CharacterStatValidator` (the cost formula is correct).
- **Server properties:**
  - All 9 keys exist in the C# with the right types, and their usage in `LoginRequestHandler.cs`, `AbstractServerRules.cs`, `NormalServerRules.cs` and `GamePlayer.cs` matches what SERVER.md says they do.
  - A live SQL query shows all 9 values applied, and the gameserver log shows them loaded at 08:41 (`xp_rate` 3, the per-IP limits 0 and 1000).
  - `--dry-run` shows nothing to change, and `--set lord_autoset_con_multiplier=1.5` is now rejected.
- **`estimateZ`:**
  - Speed: the first call takes about 86 ms (index build); 10,000 calls take 24 ms in Camelot Hills and 91 ms in Camelot city.
  - Accuracy: leave-one-out over startup and bind points gives median 1, p90 50, max 5,474 (dungeon or housing outliers).
- **SERVER.md citations** checked: `GamePlayer.cs:41` and `:260`, `0x11 AccountIsInLogoutProcedure`, the `singlepermission` columns and command name, and `/serverproperties refresh`.
- **Startup location order:** `StartupLocations` registers its creation handler before `StartAsBaseClass` does, so `getStartupLocation` should use the class id sent at creation. Every DB row sets `ClassID`, so this matters. I read this from the source and did not test it live.

**Remaining known gaps**
- `--gm` and the insert path for a missing property are still untested live.
- `/app/scripts` is not mounted.
- There is no terrain or line-of-sight data.
- Because every `startuplocation` row has a `ClassID`, spawn points differ slightly between an advanced class and its base class.
- `getRace` does not accept the `AlbionMinotaur` alias names.
- `bun run test` still skips `scripts/`, because `package.json` isn't in my directories.

**For other modules**
- `validateCharacter()` now returns `gender: 'male' | 'female'` and `warnings: string[]` (additive). The client should send `result.gender`.
- Bainshee is no longer in `getStartingClasses('hibernia')`.
- Merchant lists have unique `itemSlot`s, and `getMerchantItems` matches list ids case-insensitively.
- `PropertyDef` has a new `loadType` field, and `literalType(raw, fallback)` is exported from `scripts/setup-server.ts`.
- SERVER.md is updated: Bainshee and the non-creatable races added to the gotchas, and a note on the `--set` value types.

Files changed:
- `C:/Users/joshu/Code/daoc-sdk/data/build.ts`
- `C:/Users/joshu/Code/daoc-sdk/data/index.ts`
- `C:/Users/joshu/Code/daoc-sdk/data/data.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/scripts/setup-server.ts`
- `C:/Users/joshu/Code/daoc-sdk/scripts/setup-server.test.ts`
- `C:/Users/joshu/Code/daoc-sdk/docs/SERVER.md`
- `C:/Users/joshu/Code/daoc-sdk/data/generated/*` (rebuilt)