# Looting

## Autoloot does most of it

Autoloot is on by default for every character. When a mob dies, the server hands its money and items to whoever earned them, so usually nothing is left on the ground. The messages, verified live:

```
The spirit hound drops a bag of coins.
You pick up 2 copper.
You get a staff and put it in your backpack.
```

In a group, money is split: "Your share of the loot is 1 copper."

`killNpc` already reports what autoloot gave: `kill.moneyGained` and `kill.itemsGained` are inventory and purse deltas measured across the fight.

## lootNearby

Use it when something is left on the ground: autoloot off, a full backpack at kill time, an item you dropped, or loot that belongs to the group.

```typescript
const loot = await bot.lootNearby({ radius: 500 });
// loot.picked (names), loot.itemsGained, loot.moneyGained, loot.skipped [{ name, reason }]
```

- **Order:** it waits `settleMs` (800) so autoloot can finish, then walks to each loot object within `radius`, nearest first, and picks it up.
- **Pickup range is 256 and ignores z.** `lootNearby` walks within 150.
- **Refusals** go into `skipped` with the server's text, for example "That loot doesn't belong to you" or "Your backpack is full".
- **Nothing there** gives `success: true` with "Nothing to loot". `grind()` calls it after every kill (`loot: false` turns that off).
- **Verified live:** a dropped item was picked back up.

## Which ground objects count as loot

The client marks an object as loot (`NearbyObject.isLoot`) when:

- the server says it belongs to us (`ownedByUs`), or
- it is named coins, bag or pouch, or
- it appeared within 5 s and 400 units of an NPC death.

This is a heuristic. `sdk.getNearbyLoot()` returns these objects, nearest first. For anything else, use `sdk.findNearbyObject(name)` and `sdk.sendPickup(objectId)`, then check the backpack.

## The backpack

```typescript
sdk.getFreeInventorySlots();              // of 40
bot.freeBackpackSlots();
sdk.findInventoryItem(/gloves/);          // shortest name match
sdk.countInventoryItems(/bolts/);         // total quantity across stacks
```

- **Starting backpack:** a fresh character has only a Personal Bind Recall Stone (slot 40) in the backpack. The class's starting gear is already equipped (slots 10–28).
- **Getting rid of items:** sell junk to a merchant (see [merchants.md](merchants.md)), or `bot.dropItem` / `bot.destroyItem`.
- **Equipping:** `bot.equipItem(item)` lets the server pick the slot (paper-doll slot 100); `bot.equipItem(item, { slot })` names it.

## Cloaks and jewellery

`sdk/group/gear.ts` handles them for all three realms: `wearAccessories(m)` (called by every town script's `equipUpgrades`) and `buyCloak(m)`. **Seen live (2026-11-01):** a girdle, bracers and a ring worn from loot by Bragi, Hrafna and Ulfgar; a hooded cloak bought and worn by a level 5 test bot at Dyemaster Arthw, then an explicit `{ slot: 26 }` swap to a plain cloak, the old one going back to the backpack, all by the level rule below, before delve. Not yet seen live: a better item replacing a worn one in a ring or bracer pair, and anything chosen by delved score.

| Slot | Holds | Loot base names |
|---|---|---|
| 24 | Jewel | Gem, Jewel |
| 26 | Cloak | Cloak, Mantle |
| 29 | Neck | Choker, Pendant |
| 32 | Belt | Belt, Girdle |
| 33, 34 | Bracers | Bracelet, Bracer |
| 35, 36 | Rings | Ring, Wrap |

- **Recognising one (`accessorySlots`):** object type 41 (Magical) only, which also covers potions, mounts, saddles, barding, saddlebags and medallions. The inventory has no item type, so the item template of that exact name decides ("Cunnart Gem" is a potion, "Enchanter Belt" fits no slot). Random loot has no template, so its name decides: `GeneratedUniqueItem.cs` names it `<prefix> <base>` or a lowercase `<base>` ("Edgebender Cloak", "ring"), with the base always last. Medallions stay with `sdk/group/battleground.ts`.
- **Choosing by bonuses:** `wearAccessories` delves the candidates and what they would replace, and scores them for the class (see Delve below). An empty slot is filled with anything but a net negative, so a caster does put a strength ring on an empty finger; a worn accessory is replaced only by a strictly higher score, and in a pair the lower one goes. A plain cloak scores 0, so a looted cloak replaces it only if its bonuses are of use to this class.
- **Level is the fallback:** a comparison where either side has no score (a failed delve, a client without delve, past 24 delves in a call) goes by level as before: an accessory's `value1` is 0, and `GeneratedUniqueItem` scales bonuses with level. The report says so ("delve ...: no_response ...; old rule for it"), and three failures in a row end the delving for that call. What a swap took off isn't worn again in the same call.
- **Paper doll left/right:** `bot.equipItem(item)` (slot 100) puts bracers and rings on the left if that is empty, otherwise on the right (`PlayerMoveItemRequestHandler.cs` `ConvertPaperDollDestinationSlot`), so a third ring always lands on the right even when the left is the weaker. `bot.equipItem(item, { slot })` names the slot, and the server takes a wrist or finger item on either side (`GamePlayerInventory.cs` `CheckItemSlotRestriction`). Without `slot`, success only means some equipped item has that name, which a second ring of one name fakes.
- **Plain cloaks:** templates `cloak`, `cloak2`, `cloak3` (100c) and `hooded_cloak` (50c), realm 0, no bonuses, sold by armour and dye merchants. `buyCloak` walks up to 6,000 (`{ radius }` changes that: `cloakTrip` uses 12,000 in a capital) to the nearest seller, around nothing dangerous, so after a teleport that can fail pass `{ town }` (its landing point) and it buys only within 5,000 of it. The town scripts sell everything but `KEEP`, so buy, then wear, then sell.
- **Where (static data):** Camelot (region 10), Fort Atla, Tir na mBeo and Ardagh have sellers; Connla, Howth, Caer Ulfwych and Huginfell have none within 6,000. Thidranki has no merchants.
- **`shedLoad` can still drop a spare accessory** near the carry limit (heaviest item first); it doesn't wear anything.

## Delve

`bot.delveItem(item | name | slot)` reads an item's real bonuses, backpack or worn. **Verified live (2026-11-01):** all 15 group bots delved everything they wear and carry, 213 items, and every one answered in about 50 ms; an empty slot gives `empty_slot`. The lines parsed as described below. On loot the only `unknown` lines are its description ("Atlas ROG | Skald", the class it was generated for, which limits nothing) and task item text. The real `equipUpgrades` then ran on all 15: three swaps by Bragi and one by Hrafna, a second pass changed nothing, and a caster's refused armour costs 3 s a piece as it did before delve.

```typescript
const d = await bot.delveItem(/Heatbender/);
// d.success, d.reason, d.item, d.lines (raw), d.bonuses, d.unknown, d.bonusLevel, d.levelRequirement
// d.bonuses[0] → { category: 'resist', name: 'Heat', value: 3, unit: '%', text: '6.00 | Heat: 3 %' }
```

- **Protocol:** 0xD8 DetailRequest, type 1, object id = slot (`DetailDisplayHandler.cs:28-30`). The answer is a 0xC4 text window captioned with the item's name, which is also what NPC text and commands use, so only a window of that caption arriving after the request counts. An empty slot gets no answer: reason `empty_slot`, without asking. A name nothing matches is `not_found`, no window in 3 s `no_response`. A plain cloak still answers ("Total utility: 0.00").
- **The real format is not the one the handler's comments show.** `GamePlayer.DelveItem` always answers, so the handler's own bonus writer is dead code for items and the lines come from `GameInventoryItem.cs:855-905`:

| Line | Category |
|---|---|
| `4.67 \| Strength: 7 pts`, `-3.33 \| Strength: -5 pts` | stat (Acuity too) |
| `5.00 \| Hits: 20 pts`, `6.00 \| Power: 3 pts`, `0.00 \| Fatigue: 8 pts` | hits, power, fatigue |
| `6.00 \| Heat: 3 %`, `0.00 \| Essence: 4 pts` | resist |
| `0.00 \| Power Pool: 6 % of power pool.` | powerPool |
| `10.00 \| Crush: 2 pts` (a resist if `%`), `5.00 \| ALL Magic Skills: 1 pts` | skill, skillGroup |
| `0.00 \| Bonus to casting speed: 2 pts`, `0.00 \| Bonus to armor factor (AF): 18 pts` | castingSpeed, armorFactor |
| `- Body Magic Focus: 4 lvls`, `- ALL Spell Lines: 4 lvls` | focus |
| `- Defensive Bonus: 5% (PvE Only)` | pve |
| `0.00 \| Evade chance: 5 pts` and about 60 others | other |

- **Parser (`sdk/delve.ts`):** the old handler's `- Strength: 15 pts` is understood too, inside a "Magical Bonuses:" or "Focus Bonuses:" section. A name or unit that fits none of these goes to `unknown`, as does spell text. Armour, weapon and shield stats, requirements and "Cannot be ..." are layout, not bonuses.
- **Levels:** a bonus applies from the moment the item is worn, at any level (`GamePlayer.cs:8910`); "Bonus Level" gates nothing and "Level Requirement" gates only the item's spells. The server caps the sum worn: stat 1.5x level, hits 4x, resist level/2+1, skill level/5+1, flat power level/2+1, power pool level/2, AF 1x, casting speed 10, fatigue 15. At level 20: 30, 80, 11, 5, 11, 10, 20. So a +15 stat is worth 7 at level 5. `statScore` clamps each item to these and doesn't add up what is already worn.

### Scoring (`sdk/group/gear-score.ts`)

`statScore(bonuses, classInfo, level)`. These weights are a judgement, not a fact, on the scale of the server's `ItemUtilityCalculator.cs`:

| Bonus | Per point | Who |
|---|---|---|
| Primary / secondary / tertiary stat (classes.json) | 1 / 0.6 / 0.3 | That class; base classes by their advanced classes |
| Mana stat, Acuity | 0.8 (or its role if higher) | The class's own: a Fighter has none until promoted. Acuity not for Scout, Hunter, Ranger, Nightshade |
| CON outside its role | BaseHP x level / 10000 x 0.25 | Everyone: it gives hits |
| DEX, QUI outside a role | 0.15 | DEX for a mana stat (casts), QUI for non list casters, Valewalker and Vampiir (swings) |
| Any other stat | 0 | A caster's strength |
| Hits | 0.25 | Everyone |
| Resist | 2 | Everyone |
| AF / absorption | 1 / 2 | Everyone |
| Skill, "ALL" skills | 5 | A spec the class has at this level: Parry from 15 for a Paladin |
| Flat power / power pool / casting speed | 2 / 1 / 2 | Classes with a mana stat |
| Fatigue | 0.5 | Non list casters, Valewalker and Vampiir |
| Focus | 0.25 | That line, for focus casters (Disciple, Elementalist, Forester, Mage, Magician, Mystic and their subclasses, not Valewalker): it lowers power cost |
| `other`, `pve` | 0 | Not weighed yet |

**Armour:** the town scripts' `equipUpgrades` compare `armorValue` (AF and absorb, one formula for Camelot and Hibernia now: Camelot's, with its base of 10) and add the bonuses: 0.25 armour value per score point, at most 10 % of the better piece's value. A caster gives up at most 3 AF of cloth at level 20, a tank under 5 of plate. A piece that can't win even so isn't delved; a failed delve leaves AF and absorb to decide. Weapons and shields still go by DPS and block alone.

A client started before delve existed must be restarted to answer it: it refuses with `unknown_action`, and the level rule stands.
