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

`sdk/group/gear.ts` handles them for all three realms: `wearAccessories(m)` (called by every town script's `equipUpgrades`) and `buyCloak(m)`. **Seen live (2026-11-01):** a girdle, bracers and a ring worn from loot by Bragi, Hrafna and Ulfgar; a hooded cloak bought and worn by a level 5 test bot at Dyemaster Arthw, then an explicit `{ slot: 26 }` swap to a plain cloak, the old one going back to the backpack. Not yet seen live: a higher-level item replacing a worn one in a ring or bracer pair.

| Slot | Holds | Loot base names |
|---|---|---|
| 24 | Jewel | Gem, Jewel |
| 26 | Cloak | Cloak, Mantle |
| 29 | Neck | Choker, Pendant |
| 32 | Belt | Belt, Girdle |
| 33, 34 | Bracers | Bracelet, Bracer |
| 35, 36 | Rings | Ring, Wrap |

- **Recognising one (`accessorySlots`):** object type 41 (Magical) only, which also covers potions, mounts, saddles, barding, saddlebags and medallions. The inventory has no item type, so the item template of that exact name decides ("Cunnart Gem" is a potion, "Enchanter Belt" fits no slot). Random loot has no template, so its name decides: `GeneratedUniqueItem.cs` names it `<prefix> <base>` or a lowercase `<base>` ("Edgebender Cloak", "ring"), with the base always last. Medallions stay with `sdk/group/battleground.ts`.
- **Level is the score:** an accessory's `value1` is 0 and the SDK has no delve, so loot stats can't be read. An empty slot is always filled; a worn accessory is replaced only by a strictly higher level, and in a pair the lower one goes. A plain merchant cloak is level 0, so any looted cloak replaces it. Of two items of one level the first stays, even if the other has better bonuses.
- **Paper doll left/right:** `bot.equipItem(item)` (slot 100) puts bracers and rings on the left if that is empty, otherwise on the right (`PlayerMoveItemRequestHandler.cs` `ConvertPaperDollDestinationSlot`), so a third ring always lands on the right even when the left is the weaker. `bot.equipItem(item, { slot })` names the slot, and the server takes a wrist or finger item on either side (`GamePlayerInventory.cs` `CheckItemSlotRestriction`). Without `slot`, success only means some equipped item has that name, which a second ring of one name fakes.
- **Plain cloaks:** templates `cloak`, `cloak2`, `cloak3` (100c) and `hooded_cloak` (50c), realm 0, no bonuses, sold by armour and dye merchants. `buyCloak` walks up to 6,000 (`{ radius }` changes that: `cloakTrip` uses 12,000 in a capital) to the nearest seller, around nothing dangerous, so after a teleport that can fail pass `{ town }` (its landing point) and it buys only within 5,000 of it. The town scripts sell everything but `KEEP`, so buy, then wear, then sell.
- **Where (static data):** Camelot (region 10), Fort Atla, Tir na mBeo and Ardagh have sellers; Connla, Howth, Caer Ulfwych and Huginfell have none within 6,000. Thidranki has no merchants.
- **`shedLoad` can still drop a spare accessory** near the carry limit (heaviest item first); it doesn't wear anything.

