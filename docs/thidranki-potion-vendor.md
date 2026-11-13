# Thidranki potion vendor in Druim Ligen

Added 2026-11-13 at the user's request: a potion merchant in Hibernia's portal keep for Thidranki, Druim Ligen (region 200), selling endurance and power potions for levels 20-24. It lives only in the DB, so a DB reseed (`down -v` and a fresh import from `server/db`) loses it. To put it back, run the SQL below and restart the gameserver.

## What stands there

| | |
|---|---|
| NPC | **Eithne**, guild "Potion Merchant", `DOL.GS.GameMerchant`, realm 3 (Hibernia), level 34, peace flag |
| Mob_ID | `618385a9-71f5-44c1-9458-252881aea7b5` |
| Spot | region 200, (333330, 420620, 5184), heading 1536 (toward the bind stone) |
| Reach | 155 from the bind stone (333220, 420510) and 216 from Araisa, the medallion merchant. A player standing at the bind is inside the 192 interact range |
| Look | model 315 with equipment template `Yori`, copied from Yoria, the Hibernian potion merchant in region 27 |
| Item list | `ThidPotionsHib` (merchantitem ids `thid-potions-hib-0` to `-3`) |

| Slot | Item template | Name | Effect | Charges | Price |
|---|---|---|---|---|---|
| 0 | `Draught_of_Endurance3` | Draught of Endurance | instant: restores 40 endurance (spell 8056, 3 s use) | 9 | 80 s |
| 1 | `Draught_of_Invigoration3` | Draught of Invigoration | over time: endurance regen +2 for 20 min (spell 8079) | 9 | 1 g 20 s |
| 2 | `Draught_of_Power3` | Draught of Power | instant: restores 50 power (spell 8060, 3 s use) | 9 | 80 s |
| 3 | `Draught_of_Replenishment3` | Draught of Replenishment | over time: power regen +2 for 20 min (spell 8083) | 9 | 1 g 20 s |

### Why these four

- They are the Hibernian (`...3`) level-20 versions out of the DB's own `PotionMerchantHib` list. That list also has `Improved_` level-30 versions.
- A potion with no `LevelRequirement` needs the item's level (`GamePlayer.UseSlot`, `Math.Min(MAX_LEVEL, useItem.Level)`). Level-30 and level-40 potions are therefore useless at 20-24. That includes the true zero-cast "Elixir of Instant ..." and "Greater/Superior Elixir of Instant ..." items, which are all level 40.
- The DB has no level-20 potion that restores with no cast time. The "instant" ones here restore their whole amount at once, after the 3 s every Draught takes to use, and can't be drunk while swinging (`CantUseInCombat`). The "over time" ones are 20-minute regen buffs.
- Each instant/over-time pair is on its own shared potion timer (spells' `SharedTimerGroup` 3 and 4). So one of each can be drunk together, with a 60 s reuse each.
- Draughts carry 9 charges and Potions 6, both for the same 80 s. Elixirs carry 10 for 4 g 56 s.

## How it was put in live (no restart)

1. Insert the `merchantitem` rows (below). Merchant lists are read from the DB whenever a window opens (`MerchantTradeItems`), so they need no reload.
2. Set `gmlevel` to PrivLevel 3 and log it in. `/jump to 333330 420620 5184 200`, then `/mob create DOL.GS.GameMerchant 3`. That spawns a "New Mob" and saves it, which is where the Mob_ID comes from.
3. `UPDATE mob ...` (the values below), then in region 200 `/reload mob name New Mob`. That command reloads, from the DB, every mob in the region whose in-world name is exactly that. Only ours matched.
4. Check: `bot.openMerchant` on Eithne showed the four items at the prices above. Then jump `gmlevel` back to Thidranki, quit it and set it back to PrivLevel 1.

## Reapply after a reseed

```sql
INSERT INTO merchantitem (ItemListID, ItemTemplateID, PageNumber, SlotPosition, LastTimeRowUpdated, MerchantItem_ID) VALUES
 ('ThidPotionsHib', 'Draught_of_Endurance3',     0, 0, NOW(), 'thid-potions-hib-0'),
 ('ThidPotionsHib', 'Draught_of_Invigoration3',  0, 1, NOW(), 'thid-potions-hib-1'),
 ('ThidPotionsHib', 'Draught_of_Power3',         0, 2, NOW(), 'thid-potions-hib-2'),
 ('ThidPotionsHib', 'Draught_of_Replenishment3', 0, 3, NOW(), 'thid-potions-hib-3')
ON DUPLICATE KEY UPDATE ItemListID = VALUES(ItemListID);

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

Run it with `docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc < file.sql`, then `docker compose -f server/docker/docker-compose.yml restart gameserver`. Or spawn it live as described above, without the `mob` INSERT. To remove it: `DELETE FROM mob WHERE Mob_ID='618385a9-71f5-44c1-9458-252881aea7b5'; DELETE FROM merchantitem WHERE ItemListID='ThidPotionsHib';`, and it is gone after a restart.

## Not done

- Bots don't buy or drink these potions. That would be a follow-up in the class kits.
- Albion's and Midgard's portal keeps (Castle Sauvage, Svasud Faste) have no such vendor.
