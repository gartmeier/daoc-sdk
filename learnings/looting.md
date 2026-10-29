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
- **Equipping:** `bot.equipItem(item)` lets the server pick the slot (paper-doll slot 100).
