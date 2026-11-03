# Classes and races

## Choosing at creation

```sh
bun bots/create-bot.ts --list                                    # starting classes and their races, per realm
bun bots/create-bot.ts mybot --realm=midgard --class=Viking --race=Troll
bun bots/create-bot.ts mymage --class=Mage                       # realm inferred when the class name is unique
```

`create-bot.ts` checks the choice with `validateCharacter` from `data/index.ts`, which mirrors the server's `IsCharacterValid`. It then writes `REALM`, `CLASS`, `RACE`, `GENDER` and `CHAR_NAME` to bot.env. The headless client creates the character on first login if the account has none.

- **Defaults:** Albion Fighter/Briton, Midgard Viking/Norseman, Hibernia Naturalist/Celt: melee base classes that start with weapon, shield and full armour. When only `--class` is given, the realm's default race is used if eligible, else the first eligible race that has a start location.
- **`start_as_base_class` is on,** so advanced classes start as their base class:
  - In Albion: Armsman, Paladin, Mercenary and Reaver → Fighter; Wizard and Theurgist → Elementalist; Sorcerer and Cabalist → Mage; Cleric and Friar → Acolyte; Scout, Minstrel and Infiltrator → Rogue; Necromancer → Disciple.
  - `getClass(name, realm).baseClassName` gives the base class for any realm.
  - An advanced class gets its base class's start point and gear. Only its starting stats (`defaultStats`) are its own, so pick the base class directly unless you want those.
  - Promotion at level 5 is verified for Fighter → Armsman: see [npc-dialog.md](npc-dialog.md#promotion). Base classes have no styles until then ([combat.md](combat.md)).
- **Not creatable on this server:**
  - Classes: Valkyrie and Bainshee (no eligible races), and Heretic, Warlock, Vampiir and the Maulers (not starting classes).
  - Races: Half Ogre, Frostalf, Shar and the Minotaurs.
  - Inconnu Acolyte, Saracen Disciple and Saracen Necromancer (which starts as a Disciple) pass the server's checks but have no start location. create-bot refuses them, and `--list` leaves them out (`getPlayableRacesForClass`).
  - Verified live on all three: the server logs "startup location not found", the row stays at 0,0,0 in region 0, and the client times out entering the world (loading the character throws in `GuildMgr`). A second login of the Necromancer failed the same way. With `start_as_base_class` off a Saracen Necromancer starts normally (Isle of Glass), and a Saracen Disciple still doesn't.
- **Names:**
  - The character name defaults to the account name with digits mapped to letters (`ux1` → `Uxb`, `bot12` → `Botbc`).
  - Names must be letters only, at least 3, start with a capital, and be unique on the server. Override with `--char=Name` or `CHAR_NAME=`.
  - create-bot refuses a name another `bots/*/bot.env` already uses (`bot1` and `botb` both map to `Botb`). It can't see characters made outside this checkout. A name taken on the server only fails when the client tries to create the character.
- **Stats:** +10 each to the class's primary, secondary and tertiary stats (30 points), from `defaultStats`.

```typescript
import { getStartingClasses, getRacesForClass, validateCharacter } from '../../data/index';
validateCharacter({ realm: 'hibernia', class: 'Magician', race: 'Elf' });   // { valid, errors, warnings, gender, classInfo, raceInfo }
```

## Looks

Every character gets its own face, hair, colours and size, picked from its name (`lookFor`, client/model/look.ts), so the same name always gives the same look. New characters get it at creation. A character whose face bytes are all zero gets one at its next login, through a face-only customize; its stats stay. Verified live on a throwaway Viking: the values land in the database and it enters the world. How they render in the real client is unverified.

- **Ranges** come from the client's tables in gamedata.mpk: morphs 0..8 (we use 1..7), 8 eye colours, 8 skin tones, 16 hair colours, 7 faces (we send 1..5), and hair styles per race and gender (`fig3descriptions.csv`).
- **The model carries the look too:** the low 11 bits depend on the hair style (`fig3tofigmain.csv`), and bits 11-12 are the size (1 short, 2 average, 3 tall). A customize with size 0 can get the account banned (CharacterCreateRequestHandler.cs:802), so `lookFor` never sends it.
- **Open:** whether the wire's face and hair numbers count from 0 or 1. The ranges we send are valid either way.

## Start points and the first monsters

From `getStartupLocation` and `findNpcSpawns` (levels 0–1, realm 0, not peaceful). Rows marked *live* were confirmed in game; the rest are data only.

| Realm / class | Start (region, x, y) | Nearest easy mobs |
|---|---|---|
| Albion Fighter, Acolyte *(live: Fighter)* | 1 Camelot Hills, Prydwen Keep, 574797, 530161 | spirit hound (L0) ~2300–2500 |
| Albion Mage *(live)* | 1 Camelot Hills, 559975, 513748 | puny skeleton (L1) ~3900 |
| Albion Elementalist *(live)* | 1 Camelot Hills, 561899, 512367 | puny skeleton / spirit hound ~3400 |
| Albion Rogue | 1 Camelot Hills, 559652, 511251 | none within 5000 |
| Midgard Viking, Seer | 100 East Svealand, 774696, 753782 | sveawolf cub, soft-shelled crab ~2000–2600 |
| Midgard Mystic (Kobold) | 100 Gotar, 749110, 814677 | vein spiderling ~4300 |
| Hibernia Guardian *(live)* | 200 Shannon Estuary, 296516, 641415 | badger cub, large frog ~2400 |
| Hibernia Naturalist *(live)* | 200 Shannon Estuary, 294768, 641635 | large frog (L1) ~2700, badger cub (L0) ~3100 |
| Hibernia Magician (Elf) *(live)* | 200 Lough Derg, 346073, 490855 | annoying lucradan ~2100 |

- **Start points depend on the class the server looks up,** and also on the race. With `start_as_base_class` on, the class is already reverted by then, because the server's handler chain runs the newest handler first and `StartAsBaseClass` registers after `StartupLocations`. So a Briton Sorcerer starts on the Briton Mage row. `getStartupLocation` takes the class you create and follows this; pass `startAsBaseClass: false` for a server with the property off.
- **The template script walks for you:** when no monster is in view, `bots/_template/script.ts` and `bots/examples/caster.ts` walk to the nearest easy spawn point from the data.

## Class notes

- **Melee (Fighter, Viking, Naturalist):**
  - They start with weapon, shield and a full armour set equipped; `killNpc` works from the first second.
  - The Fighter has Crush/Slash/Thrust at 1, Sprint, and no styles until promotion.
  - Live, a fresh Naturalist killed three badger cubs (L0–L1, +17/+35/+35 XP, level 1 → 2), taking 1–4 per hit. An L1 large frog, the template's first pick, killed it at 16 % frog health.
- **Guardian's starter armour is a fix in our fork** (it also covers Blademaster, Hero and Champion, which start as Guardian):
  - In upstream's dump, rows 13, 14, 76, 77, 78 and 109 (class list `52;44;43;45;`) name `leaf_tacuil_{vest,helm,boots,gauntlets,sleeves,leggings}`. Only the `leaf_tacuil_*3` templates exist, so the server skips those rows with "Cannot Find Item Template" at startup (StartupEquipment.cs:58, :82-86) and a Guardian gets only the training sword and shield. An L1 badger cub hit such a Guardian for 10–11 and killed it; the same mob hit the armoured Naturalist for 1–4.
  - The fork points those rows at the `*3` templates for class 52 only (docs/SERVER.md). Rows 125-130 already give classes 43, 44 and 45 the same set, which only comes into play with start_as_base_class off. Keeping those classes in both hands them a second set in the backpack (seen on a test server: 6 worn, 6 in bags).
  - Verified 2026-11-03 on a server seeded from the fork: new Guardians, Heroes, Blademasters and Champions start with six pieces worn and none in bags, with start_as_base_class on and off.
  - `getStarterArmour(cls)` in data shows a class's set, and create-bot warns about a class with none (`[no starter armour]` in `--list`). Both read the dump checked out in `server/db`, not the DB, so they say nothing on a DB seeded before the fix (docs/SERVER.md). Characters made earlier keep their inventory.
- **Casters (Mage, Elementalist, Magician, Mystic, ...):**
  - Tiny mana at level 1: a Mage has 10 power.
  - Interrupted by melee. See [spells.md](spells.md).
- **Acolyte (Cleric line):** heals live in the skills list (hybrid `skillIndex` path). `castSpell` handles it.
