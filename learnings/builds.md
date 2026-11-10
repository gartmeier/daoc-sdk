# Builds: what a character spends its spec points on

Every character owns its build: `bots/<name>/build.ts`, targets by level, lines by KeyName. It starts as a copy from the catalogue in `data/builds/`, chosen before the bot starts.

```sh
bun bots/examples/train-build.ts <bot> [--respec] [--radius=<units>]   # spend by build.ts where it stands
bun groups/<group>/train.ts [--respec] [--radius=<units>]              # the same for every member
```

Run one after levelling, anywhere: this server trains with no trainer, because `allow_train_anywhere` is on (train.cs:143). Only a respec needs one. `--respec`, when lines are over the current target, walks to the nearest trainer of the class in the region, takes every point back and spends it again. A trainer past 8000 units (`TRAINER_RADIUS`, or `--radius`) stops that with the distance and `too_far`, and a region with none with `no_trainer`, and nothing is spent either way. A server with the property off answers "You must select a valid trainer for your class.", and the scripts then walk for training too.

In a script: `await bot.trainBuild(trainer)` at a trainer, or `await bot.trainBuild(null)` where it stands. `done` and `waiting` are both `success: true`, and `message` says what rose and why it stopped: "Mana 12 → 15, saving for Mana 16: 3/16 points". With `null` on a server that wants a trainer the reason is `needs_trainer`.

A town script with its own trainers and teleports uses `trainingDue(sdk, build)` to decide on the trip and `trainAtTrainer(bot, trainer, { respec })` once there, both from `sdk/group`.

## How a build works

A target says where the lines should be by a level. `nextBuildStep` in `data/builds/rule.ts` is the whole rule:

1. The current target is the first whose level is at or above the character's, else the last.
2. Take its lines in the listed order, skipping any the character doesn't have yet (a base class, or a line acquired later).
3. The first line under its number and under the character's level rises as far as the points reach.
4. When the points don't reach its next level they stay banked for it (`waiting`), and the lines after it wait too.
5. With no such line the build is `done` for this level.

What follows from it:

- **Listed order is buying order.** The first line takes every point until it reaches its number or the character's level. For a multiplier 10 caster a line at level costs exactly what the levels earn, L(L+1)/2 - 1 either way, so one line at level means nothing else until 40.5.
- **A stop is a target in between.** The rule sees only the current target, so a plan that alternates between lines needs a target per turn: Cleric Buffer's `{ level: 14, specs: { Enhancement: 7, Rejuvenation: 11 } }` buys the first instant heal before Enhancement runs on to 21 by 24. An empty target, `{ level: 4, specs: {} }`, banks the points for promotion at 5.
- **Promote before training at level 5.** From 5 on a base class spends on the lines it has, because its trainer goes on training it, and the plan counted on promotion. Live: a level 5 Magician on Pet buffer put its 14 points in Light 5; `bot.respec` gave them back, and after promotion they went to Enchantments 5. The train scripts say so first.
- **A line outside the current target stays where it is,** free levels included.
- **Free levels wait their turn.** They cost nothing, but they rise only when their line comes up: Scout Melee slash has Longbows 1 at level 20 and 6 only by 24. List the line first to have them early.

## Choose one

```sh
bun bots/create-bot.ts --builds              # every class and its builds
bun bots/create-bot.ts --builds=Enchanter    # one class: each build's role, basis and targets
bun data/skills.ts Enchanter Mana            # what a line gives, by spec level (bun data/skills.ts Enchanter: all its lines)
```

Then read `data/builds/<class>.ts`: the class's `notes`, and each build's `why` (whose numbers, which spells and styles they reach), `order` (the buying plan in words) and `sources`. Bots fight with melee and spells today: the SDK has no bow attack and no stealth, so archer builds and stealth openers wait for those.

```sh
bun bots/create-bot.ts <name> --class=Enchanter --build="Mana nuker"   # a new bot
bun bots/choose-build.ts <bot> "Mana nuker" [--force]                  # a bot that exists; --force replaces its build.ts
bun bots/choose-build.ts <bot> "Polearm hybrid" --class=Armsman        # a bot created as a base class, before or after it promotes: bot.env keeps the base class
```

Name the advanced class at creation, so `create-bot` picks a race it takes. A base class takes races its advanced classes refuse, and `choose-build` refuses a class the bot's race can't become ([classes-and-races.md](classes-and-races.md)).

## Write or change one

`bots/<name>/build.ts` is the character's own: change it freely.

```typescript
import type { Build } from '../../data/builds';

export default {
    className: 'Enchanter',
    name: 'Mana nuker',
    targets: [
        { level: 24, specs: { Mana: 24 } },
        { level: 50, specs: { Mana: 49, Light: 22, Enchantments: 5 } },
    ],
} satisfies Build;
```

- **Lines go by KeyName,** as in `getClass(className).specializations`: Shields, Light, Mana, Void, not Shield or Light Magic.
- **Targets ascend in level, and a later one keeps every earlier line at its number or higher.** A line left out counts as lowered to 1, or on an autotrain line to its free levels at the first level that target governs: Slash 6 at 20 with a next target at 24 is lowered, because level 21 has 5 free.
- **A bad file fails loudly.** `loadBuild`, and so `trainBuild` and the train scripts, throws the file's path and each problem, such as `Shield: use the KeyName Shields` or `Target 24 costs 588 points, and Armsman has 584 by level 24`. Check a change first, and read what it buys level by level:
  ```sh
  bun -e "import b from './bots/<name>/build'; import { buildProblems, buildPath } from './data/builds'; console.log(buildProblems(b)); for (const r of buildPath(b)) console.log(r.level, r.points, JSON.stringify(r.specs))"
  ```
- **Let `bot.trainBuild(trainer)` load the file.** A `build.ts` imported and passed as a `Build` fails the typecheck (TS2322), because `satisfies` widens targets with different lines to `Parry?: undefined`.
- **Points already above a lowered number** show in the result's `over`, and only a [respec](#respec) gets them back.

## Add a researched build

Add a `CatalogBuild` to `builds` in `data/builds/<class>.ts` (fields: `data/builds/types.ts`).

- **`basis`** is `adapted` when a guide gives the build's numbers or shape, fitted to this server's breakpoints and budget, and `derived` when a guide describes the play style at most and the numbers are ours. `why` says which numbers are whose and names the spells and styles they reach; confirm each with `bun data/skills.ts <class> <line>`.
- **`targets`** are 24 and 50, plus a stop wherever `order` alternates between lines.
- **`order`** is the plan in words. Walk it against `buildPath` until they agree, and change it whenever `targets` change: no test compares them.
- **`sources`** each carry what the guide says and its `era`. End `era` with "excerpt" when the numbers were seen only in a search excerpt.
- **Check:** `bun test data/builds`, which holds every catalogue build to what the next section lists, starting as the base class and not, plus its fields and prose.

## What the numbers rest on

- **Checked by `bun test data/builds`, on all 118 builds:** every key is a trainable line of its class, no target is over budget, no line is above character level, no later target lowers a line, and the rule reaches every target at its level, with autotrain priced as the server does.
- **Checked on a real server:** 252 points at level 22 and 1494 at level 50 for a multiplier 10 caster, with Mana 49, Light 22, Enchantments 5 leaving 4 of the 1494. A Blademaster's 584 by level 24, against 573 for Blades 24, Celtic Dual 21 and Parry 9. An Armsman's Slash 1 to 15 at level 50 cost 42, the first 12 levels being free.
- **Checked once, by scripts not in the repo:** each `order` against `buildPath`, when the stops went in. 51 builds carry stops for that.
- **Not tested:** no build has been played. Named spells and styles come from the DB dump, and which of them a bot can use well needs a run.
- **adapted** (96), **derived** (22). No guide covers level 24 and the stops are ours, so no build is one guide's whole build. Level 50 numbers often are verbatim, and each `why` says which.
- **Sources are thin.** The guides are for freeshards, most of them aimed at 1.65, as OpenDAoC is (server/core/README.md:10). Phoenix is parked, and Uthgard's forum and Eden's threads don't open, so 54 of the 213 sources were seen only as search excerpts. disorder.dk, Blackthorn's wiki, Gameswelt, Freddyshouse and the Uthgard blog opened, though through a page summary.

## Static data and the trainer window

Static data answers everything about specs and spells a character has not trained. It works before a bot exists, and it holds what the window lacks: KeyNames, baseline spells, lines not yet acquired, and anything for a base class, whose window is empty until promotion.

- **Skills:** `getClassSkills(class, { characterLevel? })` gives every line with its spells, songs, styles and abilities by spec level, the same content as the window. `getBaselineSkills(class)` gives the baseline spells. `getTrainableLines(class)` gives the lines and when they come.
- **Ids:** a skill's `id` is the window's id (a spell's tooltip id), unique only inside a class. Its `dataId` is what `getSpell` takes.
- **What can be cast now** is `sdk.getSkills()`: on hybrid lines the server keeps only the best tiers of a spell group (LiveSpellHybridSpecialization.cs:83-98), and the data lists them all.

What stays live:

- **Levels and points:** `sdk.getSkills().specializations` and `player.specPoints`, with no window needed.
- **Points above 255:** read `player.specPoints`. The window's points byte wraps at 256 (PacketLib1105.cs:43), and `sdk.getTrainer()?.specPoints` and the state summary's Trainer heading show that byte.
- **The line index for training:** the window's, which `trainSpec` reads itself.

**Verified live:** real 0x7B windows of all 54 creatable classes matched the data on all 216 lines and 3539 skills: order, kind, level, name, id, song flag and autotrain flag. `data/skills.test.ts` holds the data against that capture (`data/fixtures/trainer-windows.json`) on every test run. The lists didn't move with character level or spec (Armsman, Enchanter and Blademaster at levels 1, 30 and 50, before and after training), and two real promotions landed on the lists of direct creation.

**Recapture** with `bun scripts/capture-trainer-windows.ts` after `server/core` or `server/db` moves, rebuilding the image first if `server/core` did. Then run `bun test data/skills.test.ts`: a difference means `data/skills.ts` has to follow the server, because the C# rules it mirrors are checked only by a capture.

**Not verified:** the 8 classes that can't be created (Heretic, Valkyrie, Bainshee, Vampiir, Warlock, the 3 Maulers), more than one race per class, levels earned by play rather than set by SQL, and master level and champion lines. Realm abilities aren't in the data at all.

## What the server does

C# refs are relative to `server/core/GameServer`. `earnedSpecPoints`, `specCost` and `freeLevels` in `data/builds/rule.ts` compute this.

- **Points:** levels 2-5 give their own number, and from 6 on each level gives multiplier * level / 10, rounded down. Half levels 40.5 to 49.5 add multiplier * level / 20 for the level they are in (GamePlayer.cs:4703-4708, 4795, 9949-9960). `getClass(name).specializationMultiplier` is the number of the class the character is now, and promotion prices every level again: a Fighter (10) at level 12 has 77 points in all, and as an Armsman (20) 140.
  | Multiplier | 10 | 15 | 20 | 22 | 25 |
  |---|---:|---:|---:|---:|---:|
  | By level 24 | 299 | 437 | 584 | 633 | 722 |
  | By level 50 | 1494 | 2223 | 2979 | 3253 | 3706 |
- **Cost:** each spec level costs its own number, so 1 to N costs the sum of 2..N, and no line goes above character level (train.cs:82, :104-113).
- **Autotrain is a price, not a raise:** on a line in `getClass(name).autotrainSpecs`, level N is free when N <= character level / 4 (train.cs:115, GamePlayer.cs:4833), and it still has to be trained. Spent points are recomputed on every read (GamePlayer.cs:3510-3513, 9963-9968), so a level paid early comes back once the free levels pass it.
- **What a line follows:** a baseline spell line follows character level, a spec line follows spec (Specialization.cs:163-190), and a class-hinted line replaces the generic one. Career lines aren't trainable (PacketLib1105.cs:36).
- **A cheap baseline is not a full baseline:** spell damage's minimum follows spec against target level, 20.8 % at spec 1 and near 100 % at spec equal to level (SpellHandler.cs:2748-2763). A heal's minimum is 0.25 + (spec - 1) / spell level (HealSpellHandler.cs:253-262).
- **Promotion:** spec lines give a base class no spells (Specialization.cs:154). Points can go in before 5, and a spec-line spell can be cast only after promotion.
- **After a promotion above level 5, `player.specPoints` is too low** until the server next sends points, because promotion sends none (GameTrainer.cs:333-365). Talking to the trainer sends them (GameTrainer.cs:134), a kill or a raise does too, and the window request doesn't (PlayerTrainWindowHandler). So when `trainBuild` would say `waiting` with nothing raised, it talks once to a trainer within 150 units and reads again. Live: a level 8 Fighter with none left read 0 as an Armsman, `trainBuild` found the real 23 and spent 20 on Polearm 1 → 6. A real wait costs that one talk and about a second.
- **After a GM's `/player class`, the skill list keeps the old levels for the rest of the session.** The command makes new spec objects at level 1, and the server's cached skill list replaces an entry only when `!=` says it changed, but `Skill`'s `!=` compares IDs (GamePlayerUtils.cs:650, Skill.cs:97-118). So every 0x16 skill list carries each carried-over line at its level from before, and never shows a raise of it, while the trainer window reads the live levels (PacketLib1105.cs:36-52). A relog clears it. New lines of the new class are fine. A real promotion at a trainer keeps the spec objects and isn't affected. This was the "No training observed" on fresh characters: a Viking made a Warrior at 24 trained Parry 1 → 16, and the list still read Parry 1. It also made `trainBuild` say "On target" with every point unspent, because the list read Nurture 20, Regrowth 13 on a Druid whose lines were back at 1.
  - **What `trainBuild` does about it:** it reads the levels from a trainer window that came during the call, and asks for one where it stands before its first raise. It also asks before stopping when the levels shown plus the points left cost more than the class has earned by its level, and otherwise `done` sends nothing. `trainSpec` counts levels from the fresh window and takes a later window as proof of the raise.
  - **Still on the list's levels:** `sdk.getSkills()`, `sdk.findSpecialization`, `respec`'s `no_need` check and `trainingDue` (sdk/group/train.ts). After a GM class change, relog before reading them, or read `sdk.getState().trainer` after `sdk.sendOpenTrainer()`.
  - **A server fix is drafted, not yet in the image:** `UpdateAt` compares by reference ([docs/upstream/core-usable-skills-stale-specs.md](../docs/upstream/core-usable-skills-stale-specs.md)). Live on a throwaway stack on 2026-11-10, the same Viking → Warrior at 24 then trained gave a skill list of Hammer 24, Parry 16, Shield 18, equal to the trainer window, and a second `/player class` dropped both to 1 together.
- **That wait can still be false farther off.** Beyond 150 units it talks to nobody and walks nowhere, and `trainingDue` reads the same number. Live: promoted by `bot.whisper` from 250 units, `trainBuild` and `trainAtClassTrainer` both said `Saving for Polearm 2: 0/2 points`, and after walking in, `trainBuild` spent the real points.

## Respec

`bot.respec(trainer)` takes every line's points back, and `bot.respec(trainer, 'Mana')` one line's, by any of its names. It is free at any level, any number of times: tested at levels 4, 20, 22 and 50 with no stones, three times on one character, surviving a relog, and every point came back. The stone check only runs when `TimeSpan.FromSeconds(PlayedTimeSinceLevel).Hours > 24` (respec.cs:96, 153), and `.Hours` never exceeds 23. Following a build never needs one, because its targets only rise: it is for a changed build or a new one, whose `over` lists what to take back.

- **`--respec` and `trainAtTrainer` with `respec` take every line back, not only those in `over`.** A line under its target falls too, and its spells go until the points buy them again. Live, on a level 20 Sorcerer with Matter 6, Body 16, Mind 10 and 0 points, by a build with Mind 16, Body 17, Matter 4: every line back gave Mind 16, Body 11, Matter 1, and `bot.respec(trainer, 'Matter Magic')` then `trainBuild` gave Mind 11, Body 16, Matter 1, each with 9 left. A one-line respec needs the care of the last point below.
- **It needs a trainer of the class.** `bot.respec` walks there and targets it. Without one the server's "You must be speaking with your trainer to respec." comes back as `refused`.
- **A line falls to 1, an autotrain line to its free levels** from character level 8 on (GamePlayer.cs:3052-3055). A line already there is `no_need`, with nothing sent.
- **It ends the character's own buffs and kills its pet** (respec.cs:247): rebuff and resummon after it.
- **Use `bot.respec` over a raw `/respec`.** The server takes only the KeyName (`/respec Mana Magic` gets "No line with name 'Mana Magic' found."), and `bot.respec` also waits for the fresh window `trainSpec` counts levels from.
- **A declined `/respec all` stays armed** (respec.cs:188 returns before clearing it): the next yes to any respec box takes every line back. Seen live: a yes to a one-line respec after a declined `all` dropped two lines. Read the result's `specs` to see what fell.

## Open questions in the numbers

- **Druid, Heal druid:** its level 50 target is really the guide's Buff Druid (Nurture above Regrowth), so the name may need changing.
- **Enchanter, Light nuker:** Mana 28 buys no spell here. Mana 27 with Enchantments 8 fits, 1492 of 1494.
- **Nightshade, Stealth assassin:** its level 24 target goes against both levelling rules it cites.
- **Warrior:** Axe, Hammer and Sword cost the same and have styles at the same levels up to 24, so a build's Hammer can become Axe for a bot that carries one. Each of the three has free levels up to level / 4 that a build raises only by listing the line.
- **Left out:** Blackthorn's Shaman 42/27/20 and Thane 46/44/42.

## Verified live

On a throwaway stack, with class, level, specs and position set by SQL:

- **`bot.trainBuild`:** a female Enchanter (the wire says Enchantress) through several lines, a run ending in `waiting`, `over`, `wrong_class`, a Fighter on an Armsman build skipping Polearm, and an Armsman with free levels at 5 paying 6 for Slash 1 to 6.
- **`bot.respec`:** by display name, sent as `/respec Mana`, and all, with `trainBuild` straight after reaching the exact levels; `refused` away from a trainer; an Armsman's floor (Slash 7 fell to 5 for 13 points, Thrust 5 was `no_need`).
- **The train scripts, when every run walked to a trainer first:** a 2590-unit walk, then training; `too_far` at 11090 units; `no_trainer` for a Fighter in Camelot; a Midgard Rogue training at Hrut, whose row says `Trainer.RogueTrainer`; one group member training while another reports `no_build`; `Mana Magic` in a `build.ts` stopping the run before anyone moved. Through the real MCP server, `script` mode of both, `args` included.
- **Training where it stands:** 17 characters cloned with their real class, level and specs, 15 of them in Thidranki, which has no trainer. `train.ts` with no flags spent on every row as the rule says, and nobody moved. An Armsman level 24 there reached Polearm 24, Slash 18, Shields 15, Parry 5 with 2 left. `--respec` there gave `no_trainer` to the four Hibernians over target, with nothing spent, and the fifth trained.
- **`--respec` from the capital landings, 15 of 15 as the rule says:** without `--radius`, Thorgrim (8630 units) and Hrafna (8678) stopped at `too_far` with nothing spent. `--radius=9000` walked them, and `--radius=12000` walked Niamh (11809) and Ciaran (10250). `town.ts --force --respec` from the hubs: 15 of 15.
- **`allow_train_anywhere` off:** an Armsman at Camelot's landing heard "You must select a valid trainer for your class.", walked 5346 units and trained. One in Thidranki got `no_trainer`.
- **A window from before a promotion:** a level 8 Seer trained at Korgan and promoted there with the window still open. `trainBuild` then raised Augmentation 2 → 5, where the old window's index would have raised Subterranean.
- **A class name two realms share:** a level 4 Midgard Rogue on a build named Rogue, passed in and as its own file, raised Sword, and one named Infiltrator got `wrong_class`.
- **A folder and a username that differ:** `train-build.ts alias`, whose `bot.env` has another `BOT_USERNAME`, read that folder's `build.ts`.
- **Real promotions, then `trainBuild` by the bot's own `build.ts`:** Magician to Enchanter at level 5, Fighter to Armsman at levels 8 and 12, with the new lines and free levels priced as the rule says.
- **Stale points after a promotion:** level 8 Fighters with none left read 0 as Armsmen. Beside the trainer, `trainBuild` and `bun bots/examples/train-build.ts` each spent the real 23 (Polearm 1 → 6, 3 left). A real wait after that: one talk, 1 s, nothing raised. 545 units off: nothing sent.
- **A GM's `/player class`, then `/player level 24`, then `trainBuild` (2026-11-10):** a Viking made a Warrior trained Hammer 1 → 24, Shields 1 → 18, Parry 1 → 16 (584 points, 0 left), a Naturalist made a Druid Nurture 1 → 20 and Regrowth 1 → 13 (299, 0 left), a Seer made a Healer Mending 1 → 23 and Augmentation 1 → 5, and a Fighter made an Armsman at Master Graent Slash 1 → 18, each with the skill list still showing old levels. Before the fix the Warrior stopped at "No training observed for Parry", and the other three stopped "on target" with points unspent: the Druid 299, the Healer 290, the Armsman 152. Unpromoted at 24, base classes trained as before.
- **`trainAtTrainer` and `trainingDue`:** with `respec` and a build passed in, a wait, then Slash 8 → 2 and Polearm 6 → 1 for 53 points, then Polearm 1 → 8. `trainingDue` said no on the finished build with 21 points banked.

**Not verified:** levels earned by play, walks over navmeshes or longer than 11809 units, a region with only a `Master Trainer` (`Scripts.AtlasTrainer`, which the scripts pass over and report as `no_trainer`), and the end of buffs and pet, read from respec.cs:247 and not observed.
