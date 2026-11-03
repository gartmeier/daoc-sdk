# Merchants

## Finding one

- **In view:** `sdk.findNearbyNpcs(/./).find(n => n.role === 'merchant')`. The role is guessed from the guild text: Weapon Merchant, Armor Merchant, Arrow Merchant, Dye Merchant, ... A Smith has role `smith`: it buys and sells nothing.
- **From static data:** `bot.findNpcSpawn(/./, { guild: /merchant/i })` gives the nearest spawn point, then `bot.travelTo(spawn.name)`. `bots/examples/merchant-run.ts` does both.
- **Around the Albion Fighter start** (Prydwen Keep), within 600 units:
  - Torr Fletcher <Arrow Merchant>, 92 units from the start: 56 items, bolts from 19c.
  - Elvar Tambor, Alburn Hale and Barric Camber <Weapon Merchant>.
  - Ryce Scrydan <Shield Merchant>.
  - Farther out: Hugh Gallen and Karn Graem <Armor Merchant>, Gram Ironhand <Smith>, and the Dye Merchants.

## Buying and selling

```typescript
const shop = await bot.openMerchant('Torr Fletcher');        // shop.items: page, slot, name, level, price, usable, objectType, hand, damageType, value1, spdAbs
const d = await bot.delveMerchantItem('Eira', /long sword/);  // d.lines, d.bonuses, d.unknown: the same answer as delveItem, before buying
const buy = await bot.buyItem('Torr Fletcher', /rough blunt bolts/, 20);   // buy.count, buy.spent
const sale = await bot.sellItem('Alburn Hale', 'staff');                 // sale.earned
const all = await bot.sellItems('Alburn Hale', i => !/recall stone/i.test(i.name));   // all.sold, all.failed, all.earned
await bot.closeMerchant();
```

- **Judge items by the window, not their names** (verified live at Eira, Connla):
  - `objectType` is the template's Object_Type: compare with `ObjectType.Blades`, or `isWeapon` / `isArmor`.
  - `hand` is an `ItemHand`: `MainHand`, `TwoHanded` or `FitsLeft`. The left-hand slot itself checks Item_Type, which the window doesn't send (GamePlayerInventory.cs:822), so equipItem has the last word.
  - `value1` is DPS * 10 for a weapon (a long sword's 24 is 2.4), `spdAbs` is speed in 0.1 s (35 is 3.5 s). For armour they are AF and absorption; for ammunition `value1` is the pack size.
  - `usable` is the server's verdict for this character, today. Armour classes come with level: a Warden gets better armour at 10 and 20, a Hero at 15, a Druid at 10 and 20, a Paladin at 10 and 20, a Bard at 15, a Skald at 20 (`specxability.sql`, also in `specializations.json`).
  - **A shop item has no worn slot.** For armour, join the static list: `getMerchantItems(...)` and `getItemTemplate(e.itemTemplateId).itemType`, as `groups/camelot/town.ts` does.
- **Delve shows what the window can't:** bonuses, and the effective damage. A plain long sword reads "2.4 Base DPS", "2.4 Clamped DPS", "85% Quality", "Effective Damage: 2.0 DPS". 0xD8 type 4, object id `page * 30 + slot`, with the merchant targeted (DetailDisplayHandler.cs:311-318).
- **Range:** the methods walk within 150 of the merchant (the server allows 256), and target and open the window first.
- **Prices:** `price` is in copper for the whole purchase unit. 20 bolts cost 19c.
- **Sale price is 50 % of value** (`item_sell_ratio`). Bolts bought for 19c sold for 9c, and a looted staff or pair of cloth gloves sold for 1c each.
- **Refusals** come back with `success: false`:
  - Zero-value items: "X isn't interested in the practice sword." The starting gear and the Personal Bind Recall Stone are worth nothing.
  - Too little money: `insufficient_funds`. It is checked before sending; the server's own refusal is "You need ...".
  - A full backpack: `inventory_full`.
- **Selling stacks:** `sellItem` sells the whole stack in that slot.
- **Switching merchants:** `openMerchant` closes any other merchant's window first. Pages that arrive within 1 s of an earlier window get merged into it, and the wrong shop would be reported.
- **`closeMerchant` is client-side:** the server has no close packet. The snapshot taken right after a close can still show the window open. The next one doesn't.

## Merchant inventories offline

Merchant item lists are in the DB dump, so you can plan purchases without walking anywhere:

```typescript
import { findNpcSpawns, getMerchantItems } from '../../data/index';
const m = findNpcSpawns({ name: 'Torr Fletcher', regionId: 1 })[0];
const items = getMerchantItems(m.itemsListTemplateId);   // page, slot, itemSlot, itemTemplateId, name, level, price
```

## Verified live

- `openMerchant` across several merchants, and buying 20 bolts for 19c.
- `sellItem` and `sellItems`: Fortifying Cloth Gloves plus staff for 2c (`bots/examples/merchant-run.ts`, walking 2900 units back from the hound camp).
- The insufficient-funds refusal.
- Not tried: guard merchants, housing merchants. Smiths and the vault: [gear-care.md](gear-care.md).
