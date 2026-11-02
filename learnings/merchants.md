# Merchants

## Finding one

- **In view:** `sdk.findNearbyNpcs(/./).find(n => n.role === 'merchant')`. The role is guessed from the guild text: Weapon Merchant, Armor Merchant, Arrow Merchant, Smith, Dye Merchant, ...
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

## Better weapons

`weaponUpgrades(m, opts)` in `sdk/group/gear.ts` wears the best from the backpack (`wearWeapons`), then buys what still beats it (`buyWeapons`), for any realm and any bot, in a group (`m.actions`) or a party (`m.bot`). It returns log lines. Nothing is listed by class or weapon name:

- **The bot's trained line decides** (`weaponNeeds`): the highest of its weapon specs above 1, with the same object type → line map that style checks use (`WEAPON_LINES` in `sdk/group/styles.ts`). Off that line nothing counts: a level 1 Hammer swings at the bottom of the damage variance (spec 1 gives 0.75-1.25, Axe 20 against a level 20 target 1.20-1.70, `CalculateVarianceRange`) and has no styles. A Healer or Spiritmaster has no such line and neither walks nor buys.
- **Hands:** a class with a Shields line keeps a one-hander, even at Shields 1. A class with neither shields nor a left hand may take a two-hander, which goes in slot 12 and comes out by itself; the right hand and shield stay in their slots, unused. A line of nothing but two-handers (Polearm, Spear, Large Weapons, ...) always may. A trained Left Axe, Dual Wield, Celtic Dual or Hand to Hand also buys for the left hand, from what `hand` says fits it, unless a higher Shields line says otherwise. `MainHand` and `FitsLeft` both go in the right hand; a left axe there swings with Axe (`GamePlayer.cs:5416-5427`).
- **The window decides what's on offer:** `usable`, `price`, `objectType`, `hand`. The static merchant data only picks which sellers to walk to, and says the one thing the window doesn't: an item's realm.
- **A shop can sell what it won't let you wear:** 449 of 5,852 weapons on realm merchants are another realm's. In Midgard: steel, alloy and fine alloy great axes and war axes, whose templates are Albion's. `usable` is true, the purchase goes through, and equipping says "You cannot equip an item from another realm!" (Bragi, 66,240c). `buyWeapons` checks the template. `usable` only asks about the ability.
- **The delve decides what it's worth at this level.** Merchant windows have no quality, and `value1` ignores the cap. `parseWeaponDelve(lines)` reads the "Clamped DPS", speed, quality and condition, and `weaponValue` adds the slow weapon bonus and a two-hander's. The cap is `1.2 + 0.3 x level` (7.2 at level 20, `GamePlayer.cs:5624`), so at level 20 a fine alloy axe at 8.7 DPS is worth no more than the alloy one at 7.2, and costs three times as much. Scores within 1 % go to the cheapest.
- **Worth paying for:** 10 % over what's worn (`WEAPON_STEP`); from the backpack, 2 % (`WEAPON_SWAP`). Bonuses count through `statScore`, a stat point being 0.5 % of weapon skill, and move a score by at most 10 %.
- **Speed barely matters to damage per second:** swing damage scales with speed, so only the 0.3 % per 0.1 s bonus is left, and a style's growth doesn't scale with DPS at all (`StyleProcessor.cs:360-364`). Damage from styles comes from spec, speed and quality, so a bigger DPS number doesn't multiply a style-heavy fighter's total.
- **`InventoryItem.hand`** comes straight from the server's item data, so backpack items are judged the same way as window items.
- **`equipItem` refusals are immediate now:** "You have no skill in using this weapon type!", "You have no skill in wearing this armor type!" and "... can't go there!" give `refused`, not a 3 s `timeout`.

**Level 51 gear for 15,000c:** each capital has "Item Merchants" (`OrbsMidgardWeapons`, `OrbsAlbionArmor`, ...: Midgard Weapons in Jordheim, 32435, 29214) that are plain `GameMerchant`s taking copper: 10,000-20,000c for level 50-51 items with Level Requirement 45. The server sells them at any level. The requirement only gates the proc (`GameLiving.cs:853-855`) and any use charge (`GamePlayer.cs:7045`), the DPS clamps as usual, and the bonuses work up to the level's caps: Dragonmight is Strength +24, Axe +4, Body and Heat 9 %. `buyWeapons` and `wearWeapons` leave anything with a Level Requirement above the character's level alone unless told `{ overLevel: true }`. Armour, jewellery and the other realms' lists are there too, and not looked at here.

**Verified live (2026-11-02, Jordheim; numbers in `groups/midgard/lab_log.md` if you have that group):**

- Thorgrim (Axe 20) and Bragi (Axe 15) on training axes, 1.1 effective DPS. On a plain 6.1 and a looted 7.2 they hit 2-3 times as hard, the group's kills per hour about doubled, and the tank's hold and lowest health stayed where they were. No deaths in 13 hunts.
- Wearing from the backpack, a realm refusal followed by the next best, the 10 % step refusing a shop weapon at 7.95 over a worn 7.75, and a Healer, a Shaman and a Spiritmaster doing nothing.
- Buying and wielding in one call: only the two level 51 weapons, before the level rule. A plain weapon bought through the default pass hasn't been seen live.
- A slow weapon lands fewer styles (a 4.2 s axe about 5 a run, a 2.5 s one 13-20), so a tank taunts less often. Its damage covered that against single wolves. Harder fights and RvR are untried.
- Not tried live: the left hand and other realms (unit tests only), and a town script calling it.

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
- Not tried: vaults (`sdk.getVault()`), item repair at smiths, guard merchants, housing merchants.
