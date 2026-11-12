# A gear template at a level's caps

`bun groups/<group>/gear-template.ts [--only=bot,bot]` puts every member in a template of custom items. Code in `sdk/group/gear-template.ts`, rows per group in `groups/<group>/gear-template.sql`. Run on 2026-11-03 on the 15 level-24 RvR bots in Thidranki; all 15 ended with every piece on and every total at its cap.

## What counts at a level

The server caps the sum over everything worn. `levelCaps(level)`. C# refs relative to `server/core/GameServer/`.

| Bonus | Formula | At 24 | Where |
|---|---|---|---|
| A stat | `level x 1.5` | 36 | `propertycalc/StatCalculator.cs:129-132` |
| Hits | `level x 4` | 96 | `MaxHealthCalculator.cs:128-131` |
| A resist | `level / 2 + 1` | 13 | `ResistCalculator.cs:103` |
| A skill line | `level / 5 + 1`, with "All ..." bonuses in the same sum | 5 | `SkillLevelCalculator.cs:35` |
| Power | `level / 2 + 1` | 13 | `MaxManaCalculator.cs:48` |
| Power pool | `level / 2` | 12 | `MaxManaCalculator.cs:49` |
| AF bonus | `level` | 24 | `ArmorFactorCalculator.cs:46` |
| Armour's AF | `level x 2`, cloth `level`, before quality | 48, 24 | `GamePlayer.cs:5515-5530` |
| Weapon DPS | `1.2 + 0.3 x level`, before quality | 8.4 | `GamePlayer.cs:5624-5631` |
| Focus | 50, and useful only up to the spell's level | 24 | `FocusLevelCalculator.cs:34`, `SpellHandler.cs:1204-1222` |

No level gate exists beyond these. A bonus works from the moment an item is on, at any level; `BonusLevel` is display only, and a Level Requirement gates only spells and procs. A character's Realm Level over 39 adds 1 to the AF cap's level and 0.3 DPS, which no level-24 bot has.

Left out on purpose: casting speed (cap 10 %), melee speed (10 %), fatigue, spell damage and the other ToA bonuses, so that the template changes what the caps reach and not how fights run. To add one, `deal` it in `templateFor`.

## What a template holds

- **Armour (six pieces):** the class's best armour, AF at the cap, quality 100, Hits split evenly, and the nine resists at 13 each across them.
- **Accessories (eight pieces):** the stats that matter to the class, each 18 + 18 on two pieces, 5 on each line the build trains above 1, the AF bonus, and for a class with power 13 power and 12 pool.
- **Stats by class:** melee STR DEX CON QUI, plus its power stat for a Paladin or Skald; everyone else its power stat, DEX and CON. `CLASS_KITS` holds it. A character's stat line then reads base plus exactly 36.
- **Weapons:** DPS 84 and quality 100 on the class's own type. Warrior, Paladin and Hero one-hander and large shield; Skald axe, small shield and greataxe (held, as before); Cleric mace and medium shield; Healer and Shaman hammer and small shield; Druid and Bard club and small shield.
- **The bench classes (2026-11-10, not yet worn live):** armour is the best the class's AlbArmor/HibArmor/MidArmor ability reaches by 24 (`data/generated/specializations.json`), shield sizes from its Shield ability.
  - Armsman: plate, a slash halberd held (a polearm's damage floor reads the 1H line of its damage type, `data/builds/armsman.ts`), with a sword and large shield.
  - Friar: leather, a staff with no focus bonus (`focus: false`: he swings it), stats STR DEX CON QUI PIE.
  - Blademaster: reinforced, blade and an off-hand blade, no shield: Celtic Dual 21 is the build's damage and its Shields 13 has no Slam yet.
  - Warden: scale, blade and medium shield. Thane: chain, hammer and medium shield, stats with PIE.
  - Berserker: studded, hammer and a left axe.
  - Wizard, Eldritch, Runemaster: cloth and a focus staff.
  - An off-hand weapon (`offHand`) goes in the left hand with Hand 2, so a kit has either it or a shield.
  - A female character's class name (Armswoman) finds the kit by the class.
- **The nine new classes (2026-11-12, worn and audited at every cap, not yet in a fight):** armour from the same abilities. Mercenary chain, two swords (an off-hand sword, Hand 2). Minstrel chain, dirk, small shield and a **template lute**: a Rogue promoted by GM has no instrument, any instrument plays any song since patch 1.97 (`SpellHandler.cs` `CheckInstrument`, its DPS_AF is the kind, not damage), and in the two-hand slot it is held last (`instrument` in the kit; Song of Energy played live). Reaver chain, flail and large shield (Shield 3 at 17). Champion scale (HibArmor 4 at 20), a Large Weapons greatsword. Valewalker cloth and a scythe. Savage studded and a claw in each hand: every Hand to Hand weapon in the DB is a left-hand item (Item_Type 11, Hand 2), and the right-hand slot takes left-hand items too (`GamePlayerInventory.cs` RightHandWeapon check), so the template's right claw is a plain right-hand piece. Necromancer, Animist and Bonedancer cloth and a focus staff.
- **Focus casters:** a staff with ALL Spell Lines 24, no shield or right hand: they don't have the skill.
- **No bonuses on weapons but the focus:** so the totals don't depend on which weapon is out.
- **The Bard keeps Bard Initiate Lute.** A song only needs an instrument out (`SpellHandler.cs` `CheckInstrument`). Wearing the club puts it away, and `bot.takeMeleeSlot`, the SDK's weapon switch, only takes melee weapons in hand, so the script takes the lute off and puts it on again last.
- **Weight:** about half of real pieces, because the replaced set stays in the backpack. See "After it" below.

## Where the items come from

`ItemTemplate` rows, id `t24_<class>_<slot>`, name `Thidranki <Class> <Piece>`, package `thidranki24`. The rows are ours, so a re-run updates only them; no existing row changes. Nothing in the DB reaches these numbers on one set, and the loot generator doesn't let them be chosen.

- **`ItemTemplate` is precached, and `FindObjectByKey` reads only the cache** (`ObjectDatabase.cs:738-739`). A new row gets "not found" from `/item create` until a restart, or until a GM runs `/item loadpackage <PackageID>` (`commands/gmcommands/item.cs`), which puts rows in without one.
- **`AllowedClasses` has no default,** so an INSERT must give it. The empty string means any class.
- **A GM can trade across realms** (`NormalServerRules.cs:158-168`: PrivLevel above 1 skips the realm check), so an Albion GM hands a Hibernian its pieces. `/jump to x y z region` puts him beside the member, in view, and two windows of ten carry a set.
- **The items are ordinary inventory rows** afterwards. Only the rows' existence depends on the DB, and a dump restored without them would lose them on the next load.

## Running it

A member wearing its set is left alone, and a run with nothing to make needs no GM. When something is missing the GM's client must be in game:

```bash
docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc -e 'update account set PrivLevel=3 where Name="gmlevel"'
```

```bash
bun client/runner.ts gmlevel
```

```bash
bun groups/<group>/gear-template.ts
```

```bash
bun client/dev/swarm-check.ts gmlevel --seconds=0 --quit
```

```bash
docker compose -f server/docker/docker-compose.yml exec -T db mariadb -uroot -pdaoc-sdk opendaoc -e 'update account set PrivLevel=1 where Name="gmlevel"'
```

It needs nobody else controlling the members, and aborts a group run if one is going. A dead member releases first. The result is checked by delving every piece: totals against the caps, `Clamped Factor`, `Clamped DPS`. Anything off lands in the table's last column.

## Living with it

- **The gear passes leave a template alone:** `isTemplatePiece` (the name's prefix) stops `upgradeGains`, `nextAccessory`, `wearWeapons`, `buyWeapons` and `wearFocusStaff` replacing it, and `keepForLater` keeps a spare piece from a sale or from `shedLoad`'s first choice. Merchant armour can't pay for itself against it either: nothing beats the cap by `UPGRADE_MARGIN`.
- **One-off scripts aren't covered:** `groups/midgard/weapons.ts`, `weapon-arm.ts` and `staff-arm.ts` pick weapons by their own rule. Don't run them on a member in its template.
- **After it:** what came off stays in the backpack, since Thidranki has no merchant. On 2026-11-03 the heaviest load was the Bard's 97 %, then the Cleric's 90 % and the Healer's 86 %. In a run `shedLoad` drops the heaviest of it at 95 %, and the next capital visit sells the rest.
- **A level above:** the template is a level's. At 25 the caps rise and every piece's total falls a little short. Change the level, re-run: new ids, new set.
