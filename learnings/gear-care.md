# Gear care: wear, repairs and the vault

## What wears

Use lowers an item's **condition**. Its **quality** is fixed when it's made and never changes, and a repair doesn't touch it. Damage, armour factor and block chance all multiply by both.

| Item | Rolls for wear when | Doesn't wear when |
|---|---|---|
| Weapon | it swings: hit, style, miss, block, parry, fumble (`AttackComponent.cs:837-850`) | the target evades; the swing never starts |
| Weapon held by a caster | a hostile spell finishes (`SpellHandler.cs:1315-1320`) | heals, buffs and other friendly spells; interrupted casts |
| Armour | a weapon or arrow hits that piece: torso 40 %, legs 25 %, arms 15 %, head 10 %, hands and feet 5 % each | spells, misses, evades, parries |
| Shield | it blocks a weapon or arrow (`WeaponAction.cs:522-523`), or swings in a shield style | it blocks a spell |
| Instrument | a hostile song finishes: only mez | group songs and their pulses |
| **Jewellery, cloaks, belts, necks, rings, bracers** | **never** | no code path reaches them, and none of those worn in the DB had lost any |

Nothing else lowers it: no death penalty, no timer, nothing in the vault.

- **The roll:** 5 % per event (`item_condition_loss_chance`), only while the reading is above 70 (`GameInventoryItem.cs:259`). So gear stops at about 70 %, and worn gear keeps working there.
- **The amount:** the item's con to the character plus 4, doubled at a reading under 91. It uses the same table as a mob's con, with the item's `Level`, not its Level Requirement.

| Con | Grey | Green | Blue | Yellow | Orange | Red | Purple |
|---|---|---|---|---|---|---|---|
| Points per event | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| Events from 100 to 70 (50,000 pool) | 10,000 | 5,000 | 3,333 | 2,500 | 2,000 | 1,667 | 1,429 |
| Swings or hits from 100 to 70 | 200,000 | 100,000 | 66,667 | 50,000 | 40,000 | 33,333 | 28,571 |

**A higher item wears faster, up to a limit.** Purple is the top of the table, so a level 51 item at level 22 loses 7, the same as a level 29 item, and only 1.75x a same-level one. For generated loot the difference shrinks further, because its pool grows with its level (`level x 2000`, `GeneratedUniqueItem.cs:153`): at level 22, the worst case is a level 29 piece at 1.33x a level 22 one, and from level 39 up it's no faster at all. What loses percent fastest is very low-level loot on a much higher character: a level 1 piece at level 22 goes 5.5x as fast as a level 22 one.

**In practice wear is slow.** Measured on 2026-11-03, before this page's test characters: of 942 worn items in the DB, 160 had lost anything and the worst was at 98.31 %, on a character with 46 played hours. Bots mostly outgrow gear before it needs a smith.

**A few items have almost no pool.** 47 gear templates have `MaxCondition` 1, so one landed event takes them to 0, and a weapon at 0 does no damage. 8 have 0 and read 0 from the start. Comparisons count condition at durability 0, so those lose by themselves. A weapon's delve has no Condition line at 0 (`GameInventoryItem.cs:1182`), which `parseWeaponDelve` reads as 0. A `MaxCondition` 1 piece with Durability left still counts as whole. Of the weapons, that's 9 templates, each costing at most 17c to repair, but it reads 0 again after its next wear event.

**What the bot sees:** `item.condition` and `item.durability` are percents rounded up, so 100 can hide up to 1 % of wear (`DbInventoryItem.cs:770-771`). The server uses that same rounded number in combat. A chat line comes at exactly 90 ("could use repairs"), 80 ("in need of") and 70 ("in dire need of").

## Repairing

```typescript
const r = await bot.repairItem('Judan Hammerfel', sdk.getEquipmentItem(10)!, { maxCost: 5000 });   // r.cost, r.repaired.condition, r.repaired.durability
const all = await bot.repairAll('Judan Hammerfel');                                                // r.cost; cost 0 when nothing needed it
```

- **Who:** an NPC with the guild `Smith`, class `Blacksmith`: 78 in the DB, role `smith` in view. `findNpcSpawns({ classType: /^Blacksmith$/ })` finds them. "Weaponsmiths Master" and "Armorsmiths Master" are something else.
- **Hand-over:** `0xDD` to slot `1000 + objectId`, within 128 units in 3D, from the backpack or an equipment slot. `repairItem` walks there. It needs no target.
- **Price:** `(MaxCondition - Condition) x Price / MaxCondition`, truncated. The yes/no box says it, and a price over `maxCost` or the purse gets a no. Starter weapons and shields are free, and starter armour costs a few copper: a level 2 helm from 90 % cost 6c. A level 19 sword (47,520c new) at 80 % cost 9,504c.
- **Durability pays for it:** a repair spends as much Durability as it restores condition, and wear never lowers it. At 0 the smith says "I can't repair that." for good, and the item goes on working at the condition it has.
- **The last repair overcharges:** the price ignores Durability, so with too little left you pay in full for part of a repair. 242 gear templates, 164 of them sold by five Hibernian merchants near Connla (Erwana, Kiara, Glyn, Gavina, Sorcha), have `MaxDurability` 100 with `MaxCondition` 50,000: their first repair restores 100 points for the full price, and then never again. A new one reads 100 % like any other, so the bot can't tell. No bot wears one today.
- **What a smith refuses:** jewellery, instruments, poison, generic items and stacks, with "I can't repair that." or "doesn't want stacked items".
- **"repair all":** a whisper, for 20 % more, and it repairs everything worn down in the equipment, backpack and vault, of any type. It's the only way to repair an instrument. `bot.repairAll` checks `maxCost` against the whole bill.
- **Wait for each box:** a second hand-over while one is open makes the smith forget the item (`Blacksmith.cs:138`), so `repairItem` answers before it returns. It only answers a box that opened after its hand-over and names a repair.
- **`/repair`:** a crafter's route. Every bot's crafting skills are at 1, which gives 0 % chance.

## The vault

```typescript
const v = await bot.openVault('Lord Urqhart');          // v.items; sdk.getVault() is empty until this, per client session
await bot.depositItem('Lord Urqhart', 'Dragonmight');   // reason vault_full
await bot.withdrawItem('Lord Urqhart', /Dragon/);       // reason inventory_full
```

- **Whose:** the character's own, 40 slots (110-149). Each bot has its own account, so bots share nothing here. The Account Vault Keeper has a different store, 200 slots per account and realm, which the SDK doesn't handle.
- **Moves:** with slot 601 the server picks the empty slot on the other side. An explicit vault slot swaps with what's there, so a bot that picked "free" slot 110 without opening the vault could pull an old item into its bag and sell it. A full vault fails without a word, so `depositItem` checks first.
- **What it does:** no wear, no weight, no bonuses. `repairAll` still charges for what's worn in there.
- **Not saved at once:** a move stays in memory until the next save (every 10 minutes, on quit, or on level-up). A restart of the gameserver could put an item back in the bag, which is one more reason `keepForLater` guards the sale.
- **The server doesn't check you're near a keeper:** a client could move items from anywhere. These methods walk there, as a player must. Only reading the contents needs the keeper.

**Where they stand:** smiths are near most towns, keepers aren't. Of the hubs the group scripts use, most have a smith within 2,500, Tir na mBeo's is 2,835 away and Ardagh's 25,849. None has a keeper within 14,000: Fort Atla's is 54,756 away, Prydwen Keep's 51,871, Connla's 14,176. Thidranki has neither. These teleport destinations have a keeper within `CARE_RADIUS` (distance from the landing; `getTeleportsForRealm` and `nearestVaultKeeper` find the rest, 24 in all, most of them in the Shrouded Isles):

| Realm | Destination | Keeper | Smith |
|---|---|---|---|
| Albion | Camelot (medallion landing) | Lord Urqhart, 564 | Judan Hammerfel, 2,157 |
| Albion | Castle Sauvage | Earl Grael, 1,466, on the tower | Fial Bronzearm, 298 |
| Albion | Adribard's Retreat | Trulion Vrundon, 2,019 | none |
| Midgard | Jordheim (medallion landing) | Jarl Yuliwyf, 888 | Kiarr, 5,732 |
| Midgard | Svasud Faste | Hralyvar, 1,496, on the tower | Kay-En, 2,028 |
| Hibernia | Tir na Nog (medallion landing) | Bhreagar Hylvian, 1,322 | Jezza Blackfingers, 4,341 |
| Hibernia | Druim Ligen | Yralun Trallae, 1,518, on the tower | Lonrah, 1,068 |
| Hibernia | Innis Carthaig | Blanchefleur, 961 | Siobhan, 1,000 |
| Hibernia | Shannon Estuary | Ghearic Chauclon, 280 | none |

**Getting back from a frontier keep:** the NPC there with the realm's usual teleporter name (Glasny, Stor Gothi Annark, Master Visur) is an `OFTeleporter` and ignores town keywords. Young Seoltoir, Young Gothi and Young Elementalist are `InlandTeleporter`s and answer them (the first two seen live), so look a teleporter up by `classType: /LiveTeleporter|InlandTeleporter/`. If the teleport home fails, don't bind: the keep's stone is in reach, and every later death would land there.

**A keeper may speak first:** Jarl Yuliwyf says a line on every interact, before the window. `openVault` waits for the window whatever comes first, but a plain `interactWith` reports `dialog` for him.

## In a town visit: `sdk/group/gear-care.ts`

```typescript
import { keepForLater, needsRepair, repairGear, stashInVault, takeFromVault } from '../../sdk/group/gear-care';

r.push(...await takeFromVault(m));      // what it has grown into: before the gear pass judges it
r.push(...await equipUpgrades(m));      // the group's own gear pass
r.push(...await weaponUpgrades(m));     // weapons (sdk/group/gear.ts): wears the best in the bag, buys what beats it
r.push(...await stashInVault(m));       // what's too high: after the passes, which may take something off
r.push(await sell(m));                  // with keepForLater(item, player) in its keep test
r.push(...await repairGear(m));         // what's worn below 93 %, worst first: last, with what the sale brought
```

All of them take a group member (`m.actions`) or a party member (`m.bot`), return log lines, and walk only as far as `CARE_RADIUS` (6,000). Pass `{ town }` when a teleport can fail. `bun bots/examples/gear-care.ts <bot>` runs them for one bot. A group made since has `bun groups/<group>/gear-care.ts`, and an older one can copy it from `groups/_template/`. Neither script has an armour or weapon pass, so what comes out of the vault waits in the backpack for the bot's own.

- **The level limit:** `tooHighLevel(item, level)` is red or purple (con above `GEAR_MAX_CON`, orange) and at least `GEAR_MIN_GAP` (4) levels up. At low levels a level or two is already red, and a bot gets there within the hour. So at level 10 the limit starts at 14, at 20 it's 24, at 22 it's 26, at 30 it's 34, at 40 it's 46, and at 50 it's 56. It's a judgement, and `{ maxCon }` moves it. On 2026-11-03 it affected nothing worn by the regular bots: everything they wore above their level was orange.
- **Who it stops:** `upgradeGains` no longer offers anything too high, so a town script's armour pass that goes through it obeys the limit, and neither `wearWeapons` nor `buyWeapons` takes a weapon above it unless told `{ overLevel: true }`. A bot script with a pass of its own has to ask `tooHighLevel` itself. A piece already worn stays worn: it's only ever going to fit better.
- **Who it doesn't stop:** `wearAccessories`. Jewellery doesn't wear, so a level 50 ring goes on at level 22 if its bonuses win, up to the level's caps. What isn't worn goes in the vault.
- **Above the limit is also worth less:** DPS is capped at `1.2 + 0.3 x level` and item AF at `2 x level` (cloth `1 x level`), before quality and condition, and procs and charges wait for the Level Requirement. Bonuses work up to the level's caps.
- **Repair at 93:** `REPAIR_BELOW`. Below 91 wear doubles, so repairing before that gets twice the fighting out of the same Durability.
- **What counts as worn in a comparison:** `armorValue` treats a piece a smith can restore as whole, so a worn one doesn't lose to a weaker one, or to a shop copy, over a few silver. The weapon pass does the same through `asRepaired`, for what's held and what's in the backpack: the delve gives the condition and the inventory row the Durability. Without it, an identical shop copy clears `WEAPON_STEP` at about 90 %, and the level 19 sword above would cost 47,520c instead of 9,504c. With durability 0 both count what's left, as the server does. A focus staff's score has no condition in it.
- **Starting a trip for it:** `careDue(m)` says a visit is due, and `vaultDue(m)` that it has to reach a keeper. The table above says where. A client knows the vault only once it has opened it, so gear that has come to fit starts no trip after a restart: it comes out at the next visit to a keeper, whatever brought the bot there.
- **What comes out needs a pass to judge it:** a town visit's armour pass skips a weapon its class has no entry for, so unless the visit also runs `weaponUpgrades`, out of the vault it would only meet the next sale. `{ judged }` on `takeFromVault`, `vaultDue` and `careDue` leaves the rest in the vault, and it starts no trip. A visit that runs the pass also says yes to what the pass judges: a weapon `weaponSlots` finds a slot for under `weaponNeeds`, or a focus caster's staff. A weapon off the trained line stays in, and so does a shield unless the armour pass takes shields.
- **What the weapon pass declines** stays in the backpack, and the next sale takes it unless `keepForLater` still applies. A stop with no sale, like Svasud Faste or Druim Ligen in the group visits, leaves it there until the next one.
- **Two judges of one weapon:** a class the armour pass has a weapon entry for gets both passes. The armour pass goes by DPS and quality, the weapon pass by its score, in which anything off the trained line counts 0. The weapon pass runs later and wins the visit, but where no sale follows, the loser stays in the bag and the next `equipUpgrades` can put it back on.
- **Where the weapon pass can buy:** nobody within `WEAPON_RADIUS` of Svasud Faste or Druim Ligen sells a weapon of a line the groups train (they have poison, siege gear and arrows, and Svasud Faste throwing weapons), so there it only wears. Fort Atla has every Midgard line within 2,100 of the landing. In Camelot pass `{ radius: CAPITAL_RADIUS }`, not `{ town }`: Lord Prydwen stands 5,152 from the landing, beyond `CLOAK_TOWN_RANGE`, and from him the default radius reaches only Tait Nerian and Fenris Blakely, not Landry Woden's fine alloy.
- **Selling:** `sellItems` sells what its filter says. A filter that sells by name needs `!keepForLater(item, player)` in it, because a keeper isn't always in reach and a restart can undo a move.
- **Only what the class could use:** `keepForLater` asks `classCouldUse` first, from the class's abilities at any level, with a base class's advanced classes. Chain on a Spiritmaster isn't kept: it sells.
- **Kept gear is weight until it reaches a keeper:** a hunt's `shedLoad` at 95 % load drops everything else first, and kept gear only when nothing else is left outside the group's `keepItems`, because an overloaded character can't move at all.

## Verified live (2026-11-03, Gearcare, a throwaway level 22 Albion Fighter)

Wear was set by SQL while it was logged out.

- `repairItem` in Camelot from 80 %, 90 % and 92 %: prices as the formula (9,504c, 6c, 8c), Durability down by what was restored, and a walk to 73 units with no navmesh.
- `repairAll` for a drum at 80 % and a spare sword at 90 %: 7,311c, which is (1,341 + 4,752) x 1.2, truncated.
- Refusals: `no_need` on a whole item, `not_repairable` on a Magical item, `no_response` from a merchant, `not_a_vault_keeper` from a smith. `repairAll` with nothing to do says cost 0.
- `too_expensive`: 9,504c asked, 1c allowed: declined, purse unchanged, and the next hand-over went through.
- Running out: a helm at 80 % with 100 Durability left paid the full 12c, reached 81 %, read durability 0 and got "rather old". The next try was `not_repairable`, and `needsRepair` no longer named it.
- `depositItem`: an axe and rings through slot 601, then a relog: still in the vault, read from the DB at slots 110-113. At level 46 `takeFromVault` took them out, and `wearAccessories` wore two rings.
- `merchant-run` at level 22 sold the level 24 breastplate and level 19 sword, and left the level 51 axe and level 45 ring alone. This was before the class check, which is unit-tested.
- At Castle Sauvage: the walk up to Earl Grael on the tower, 768 units above the landing, then down to Fial Bronzearm.
- Gearmid, a throwaway level 22 Midgard Viking: Jarl Yuliwyf's vault despite his line, Kiarr 4,870 from him with no navmesh, then Hralyvar on the tower at Svasud Faste, 832 up, and Kay-En. The DB showed both axes at slots 110-111 after the quit.

- Each realm's town visit, on these characters and Gearhib, a throwaway level 22 Hibernian Guardian:
  - Hibernia through Druim Ligen: the sale took a level 20 blade and left the level 45 one, Yralun Trallae's vault took it, Lonrah repaired 88 % to 100 % for 2,213c, Young Seoltoir sent it home, and it bound at Ardagh.
  - Midgard through Svasud Faste: two level 51 axes went in, level 20 leggings came out and went on, and it bound at Mularn.
  - Camelot: a level 45 sword stayed off and went in the vault, while a level 20 sword came out and went on. The sale took a robe, and the worn vest was repaired.
- A teleport home that couldn't happen, 63,469 from a teleporter: "not at Ardagh: not binding", with the bind point unchanged in the DB.
- A group's `gear-care.ts`, a one-member group at Svasud Faste with the visit's `judged`: level 20 sleeves came out and went on, a level 20 axe stayed in the vault, and a jerkin was repaired for 22c.
- The weapon pass in each realm's visit, on a disposable stack with its own DB, levels raised by SQL while logged out. Each time a level 26 weapon in the bag at level 22 went in the vault, came out at level 26 and went on:
  - Midgard, a Warrior at Axe 22, through Svasud Faste: "score 8.15 over 6.52". A level 35 axe stayed in, and so did a level 20 sword, off the line. A level 5 axe came out and lost, and the sale at Fort Atla took it for 225c. With the starter axe in hand, Yop sold a level 16 axe for 18,960c, "score 5.16 over 1.1".
  - Hibernia, a Hero at Blunt 22, through Druim Ligen: 7.97 over 7.46, after a level 20 mace at 7.28 over 0. The sale at Howth took what had lost, and at level 22 had left the level 26 and 35 maces alone. Gaenor there sold it, at Piercing 22, a curved dagger for 425c.
  - Camelot, a Paladin at Slash 18: the armour pass wore the sword before the weapon pass saw it, the sale took the one it replaced, and a war hammer, off the line, stayed in. At level 22 the shops answered "no weapon step: best 6.51, worn 7.62".
  - A Mentalist and a Cabalist at level 22: a focus staff came out and went on (1.09 and 1.06 over 0), a level 30 and a level 28 staff went in, and a sword stayed in the vault.
  - A one-member group's `gear-care.ts` with these `judges` and `wearWeapons`, at Svasud Faste: a level 28 axe came out and went on, 9.94 over 8.15.
- Both hands, on a disposable stack: Gearblade, a throwaway level 15 Blademaster at Blades 15, Celtic Dual 12, with a real Blademaster's blades copied over by SQL while logged out.
  - From his bag, a level 14 sword went in the right hand, 5.49 over 3.35. The left kept its level 7 sword. A worse blade, a level 24 blade, a stiletto (off the line) and a shield stayed out, and a second pass did nothing.
  - What came off the right hand went left in the same pass: 5.8 over 5.45, then 5.45 over 3.53, and the old left blade ended in the bag.
  - A blade with `hand` 2 and Item_Type 10 got "can't go there!" in the left, and the next best went in, 4.82 over 3.53. A right-only blade that beat the left stayed out, and a shield in the left gave way to a blade.
  - A sale that keeps the 4 highest items, with four higher in the bag: the pass ran first, so the level 14 sword went in hand instead of to the merchant.
  - A one-member group's `gear-care.ts` with `judged` counting blades: the level 14 sword came out at Druim Ligen and went on, a level 24 one went in, and a level 30 one stayed in.

**Not tried live:** a full vault. The wear numbers come from the code and the DB, not from watching an item fall.
