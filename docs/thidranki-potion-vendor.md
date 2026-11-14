# Thidranki vendors and healers in the portal keeps

Added 2026-11-13 at the user's request, in two steps:

1. A potion vendor in Druim Ligen, Hibernia's portal keep outside Thidranki, spawned live.
2. In each of Thidranki's three portal keeps (inside the battleground, region 252): a healer, a potion merchant and a poison merchant. The training dummies there went away. The point: "so no one has to leave the battleground".

All of it lives only in the DB, so a DB reseed (`down -v` and a fresh import from `server/db`) loses it. Two files put it back:

| File | What it does |
|---|---|
| [thidranki-portal-keep-npcs.sql](thidranki-portal-keep-npcs.sql) | The six merchant lists, the nine NPCs in the battleground's portal keeps, and the dummies' removal. Rerunnable |
| [thidranki-pk-dummies.sql](thidranki-pk-dummies.sql) | The 15 deleted dummy rows, to put them back |

```bash
docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < docs/thidranki-portal-keep-npcs.sql
```

Then restart the gameserver, or wait for the next restart. New `mob` rows load only at start. Eithne in Druim Ligen needs her own `INSERT`, given below.

Checked live on 2026-11-14 after the 00:30 restart, with the GM bot. In all three keeps the healer stands at the centre, the potion merchant sells the 4 Draughts and the poison merchant sells 32 poisons, and no dummies are left. Eithne sells the 4 Draughts.

## What the potion merchants sell

Each realm gets its own version of the same four level-20 Draughts (`Draught_of_...`, with suffix `''` for Albion, `2` for Midgard, `3` for Hibernia). Lists: `ThidPotionsAlb`, `ThidPotionsMid`, `ThidPotionsHib`.

| Slot | Potion | Effect | Charges | Price |
|---|---|---|---|---|
| 0 | Draught of Endurance | instant: restores 40 endurance (spell 8056) | 9 | 80 s |
| 1 | Draught of Invigoration | over time: endurance regen +2 for 20 min (spell 8079) | 9 | 1 g 20 s |
| 2 | Draught of Power | instant: restores 50 power (spell 8060) | 9 | 80 s |
| 3 | Draught of Replenishment | over time: power regen +2 for 20 min (spell 8083) | 9 | 1 g 20 s |

Why these four:

- **Item level.** A potion with no `LevelRequirement` needs the item's own level (`GamePlayer.UseSlot`, `Math.Min(MAX_LEVEL, useItem.Level)`). So the level-30 `Improved_` and level-40 `Strong_` versions are no use at 20-24.
  - That rules out the true zero-cast potions as well. "Elixir of Instant ..." and "Greater/Superior Elixir of Instant ..." are all level 40.
- **No zero-cast potion at level 20.** The DB has none. The "instant" ones here restore their whole amount at once, after the 3 s every Draught takes to use, and can't be drunk while swinging (`CantUseInCombat`).
- **Separate timers.** The instant and the over-time potion are on different shared potion timers (`SharedTimerGroup` 3 and 4). So one of each can be drunk together, with a 60 s reuse each.
- **Charges for the price.** Draughts carry 9 charges and Potions 6, both for the same 80 s. Elixirs carry 10 for 4 g 56 s.

## What the poison merchants sell

Lists `ThidPoisonsAlb`, `ThidPoisonsMid`, `ThidPoisonsHib`: every poison the realms' poison merchants sell, 32 in all, in that realm's own version.

- **Page 0:** levels 1-22 (lethal, weakening, imbalancing, infectious, up to minor enervating).
- **Page 1:** levels 23-50 (crippling, venoms, serums, enervating, lifebane).

The order follows `HibPoison2`, the one list that has both pages. Albion splits them over Onyg and Melannon, Midgard over Svewn/Sissel. Riber in Druim Ligen sells the Albion (`''`) versions; the new Hibernian list uses the `3` ones. An assassin uses up to its own level and its Envenom level with items (sdk/classes/poison.ts). At 20-24 the useful poisons run up to minor crippling poison, level 23. Poison goes straight onto the weapon (`/use` the poison with the weapon), so no other item is needed.

## The NPCs in Thidranki's portal keeps

Copies of each realm's own NPCs: the realm's portal-keep healer (`DOL.GS.GameHealer`, which removes resurrection sickness and buys back lost constitution), a potion merchant's look from region 165, and the realm's portal-keep poison merchant. Each stands 170 from the keep's centre and faces it. The centre is where a release in the battleground lands (`GamePlayer.Release`, `eReleaseType.Battleground`: `keep.X/Y/Z`), so all three are inside the 192 interact range from there. All carry the peace flag (16).

| Mob_ID | Name | Guild | Realm | Spot (region 252) | Heading | List |
|---|---|---|---|---|---|---|
| `thid-pk-alb-healer` | Sister Ellayne | Healer | 1 | 37131, 52362, 3946 | 3072 | |
| `thid-pk-alb-potions` | Sabine | Potion Merchant | 1 | 37301, 52532, 3946 | 2048 | ThidPotionsAlb |
| `thid-pk-alb-poisons` | Onyg | Poison Merchant | 1 | 37471, 52362, 3946 | 1024 | ThidPoisonsAlb |
| `thid-pk-mid-healer` | Hagdar | Healer | 2 | 53883, 24680, 4323 | 3072 | |
| `thid-pk-mid-potions` | Salazo | Potion Merchant | 2 | 54053, 24850, 4323 | 2048 | ThidPotionsMid |
| `thid-pk-mid-poisons` | Svewn | Poison Merchant | 2 | 54223, 24680, 4323 | 1024 | ThidPoisonsMid |
| `thid-pk-hib-healer` | Ilyana | Healer | 3 | 17730, 18884, 4323 | 2500 | |
| `thid-pk-hib-potions` | Yoria | Potion Merchant | 3 | 17901, 18994, 4326 | 2443 | ThidPotionsHib |
| `thid-pk-hib-poisons` | Riber | Poison Merchant | 3 | 18100, 19120, 4323 | 2048 | ThidPoisonsHib |

**Moved to the wall (2026-11-14).** In the middle of the yard they were in the way, so they go along the wall the way Druim Ligen's merchants stand. There, Ilyana, Lonrah, Fyr, Araisa, Eithne and Seoltoir stand 55-180 from the wall (most 55-120) and 130-240 apart, measured with the zone's occluders (sdk/occluders.ts). Hibernia's three keep NPCs were moved first, live (`UPDATE mob`, then `/reload mob name <name>` in the region):

- **Yoria:** where the user's Niamh stood, 145 from the north-west wall's inner face, facing the way Niamh faced.
- **Ilyana:** 200 south-west along the same wall, 86 from it.
- **Riber:** round the corner on the north wall, 105 from it, facing south.

All three are seen from the keep's centre, about 800-900 from it. Albion and Midgard still stand round the centre.

Keep centres: Albion (37301, 52362), Midgard (54053, 24680), Hibernia (18362, 18257). The navmesh is flat open ground within 300 of each: z 3946, 4323 and 4323.

The 15 training dummies (3 `DOL.GS.DPSDummy` and 2 `DOL.GS.HitbackDummy` per keep) are deleted. Their rows are in `thidranki-pk-dummies.sql`. The keeps outside the battleground (Castle Sauvage, Svasud Faste, Druim Ligen) keep their own dummies. They already had a healer and poison merchants, so nothing was added there apart from Eithne.

## Eithne in Druim Ligen

| | |
|---|---|
| NPC | **Eithne**, "Potion Merchant", `DOL.GS.GameMerchant`, realm 3, level 34, peace flag, model 315 with equipment `Yori` |
| Mob_ID | `618385a9-71f5-44c1-9458-252881aea7b5` |
| Spot | region 200, (333330, 420620, 5184), heading 1536, facing the bind stone 155 away. A player at the bind is inside the interact range |
| List | `ThidPotionsHib` (the list above) |

She was spawned live, with no restart:

1. Set `gmlevel` to PrivLevel 3 and log it in.
2. `/jump to 333330 420620 5184 200`, then `/mob create DOL.GS.GameMerchant 3`. That spawns a "New Mob" and saves it, which is where the Mob_ID comes from.
3. `UPDATE mob` (the values below), then `/reload mob name New Mob` in the region. That reloads every in-world mob of exactly that name from the DB.
4. Jump `gmlevel` back, quit it and set it back to PrivLevel 1.

Merchant lists are read from the DB whenever a window opens (`MerchantTradeItems`), so a new list needs no reload.

```sql
INSERT INTO mob (Mob_ID, ClassType, TranslationId, Name, Suffix, Guild, ExamineArticle, MessageArticle,
  X, Y, Z, Speed, Heading, Region, Model, Size,
  Strength, Constitution, Dexterity, Quickness, Intelligence, Piety, Empathy, Charisma,
  Level, Realm, EquipmentTemplateID, ItemsListTemplateID, NPCTemplateID, Race, Flags,
  AggroLevel, AggroRange, MeleeDamageType, RespawnInterval, FactionID, BodyType, HouseNumber,
  Brain, PathID, OwnerID, RoamingRange, IsCloakHoodUp, Gender, PackageID, VisibleWeaponSlots, LastTimeRowUpdated)
VALUES ('618385a9-71f5-44c1-9458-252881aea7b5', 'DOL.GS.GameMerchant', '', 'Eithne', '', 'Potion Merchant', '', '',
  333330, 420620, 5184, 200, 1536, 200, 315, 50,
  30, 30, 30, 30, 30, 30, 30, 30,
  34, 3, 'Yori', 'ThidPotionsHib', -1, 0, 16,
  0, 0, 2, -1, 0, 0, 0,
  '', '', '', 0, 0, 0, NULL, 0, NOW())
ON DUPLICATE KEY UPDATE Name = VALUES(Name);
```

## Removing it all

```sql
DELETE FROM mob WHERE Mob_ID LIKE 'thid-pk-%' OR Mob_ID = '618385a9-71f5-44c1-9458-252881aea7b5';
DELETE FROM merchantitem WHERE ItemListID LIKE 'ThidPo%';
```

Then run `thidranki-pk-dummies.sql` and restart the gameserver.

## Not done

- Bots don't drink potions, buy at the new vendors, or use the healers. sdk/classes/poison.ts still sends a solo assassin out of the battleground to Onyg, Riber or Gwaell (Audliten) to restock. The portal keep's own poison merchant inside Thidranki would save that trip.
