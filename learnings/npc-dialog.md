# NPC dialog

DAoC NPCs talk in text with **[keywords]** in brackets. You answer by whispering a keyword while the NPC is targeted. There are no option menus, apart from the 0x81 yes/no dialog box used for group invites and quest offers.

## talkTo, whisper, navigateDialog

```typescript
const t = await bot.talkTo('Master Graent');    // walk within 150, interact, collect the reply
// t.text, t.keywords, t.messages
const w = await bot.whisper('Master Graent', 'practice weapon');
const n = await bot.navigateDialog('Master Visur', ['towns', /prydwen/i]);   // talk, then whisper each in turn
```

- **Multi-line replies are merged:** `talkTo` collects every "<npc> says" line from the interaction. Master Graent answers in three separate lines, each with one keyword:
  ```
  Would you like to do some training?
  Do you require a [practice weapon]?
  Do you require a [training shield]?
  ```
  (`sdk.getNpcDialog()` keeps only the last line; use the `talkTo` result instead.)
- **Whisper range:** `whisper` targets the NPC first and walks within 300 (the server allows 512). It succeeds on new dialog text, a message from the NPC, a window, or an item. "You receive the X from Master Graent!" counted as evidence for the practice weapon.
- **RegExp keywords:** in `navigateDialog`, a RegExp picks the first matching [keyword] from the current dialog.
- **No answer:** some NPCs don't reply to interact at all (Licrin the crier gave `no_response`). Healers reply without keywords ("Greetings, Fighter. What can I do for you today?").
- **Whisper rate limits:** two server rules, both verified live.
  - Within 500 ms of the previous whisper the server answers "Slow down! Think before you say each word!" (`whisper.cs`).
  - Within 1500 ms of the last whisper an NPC accepted from you, every NPC ignores the whisper **silently** (`GameLiving.WhisperReceive`). Back-to-back `practice weapon` / `training shield` at Master Graent 1.1 s apart: the second got no answer.
  - `whisper` (and so `navigateDialog`) spaces its own whispers 1.6 s apart and resends once after "Slow down!"; a second refusal returns `rate_limited`.
  - Whispers from another script or a raw `sdk.sendWhisper` aren't tracked: leave 1.6 s after those yourself.
- **Trainer freebies:** Master Graent hands out `practice weapon` / `training shield` only while you carry none of his copies (`FighterTrainer.cs`); otherwise he stays silent (`no_response`).

## interactWith

`bot.interactWith(target)` is the general right-click. It returns `response`, one of `merchant`, `trainer`, `dialog`, `dialogBox`, `textWindow` or `message`, and fails when nothing answers within 4 s. `talkTo`, `openMerchant` and `trainSpec` are built on it.

## Trainers

- **Location:** your class trainer stands near the start point. Master Graent (Fighter Trainer) is 89 units from the Albion Fighter spawn. `nearestClassTrainer(player)` in `sdk/group/train.ts` finds the nearest by guild and realm: six rows have a `classType` that doesn't name their class (Hrut's `Trainer.RogueTrainer`).
- **Free gear:** whisper `practice weapon` / `training shield` to get the items.
- **Spending points:** `bot.trainBuild(trainer)` spends them by the character's own `bots/<name>/build.ts`, and `bun bots/examples/train-build.ts <bot>` does so where the character stands, which this server allows. [builds.md](builds.md) has the rule, what points come and what they cost.
- **One line by hand:**
  ```typescript
  const r = await bot.trainSpec('Master Graent', 'Crush', 1);   // r.fromLevel, r.toLevel, r.specPointsLeft
  ```
  It opens the trainer window, falling back to `/train <spec> <level>`, and observes the spec level rise. Verified live: Crush 1 → 2.
- **A line's names:** `trainSpec`, `sdk.findSpecialization`, `getStylesFor` and `getSpecialization` take any of them. Verified live on an Armsman, Mentalist, Eldritch, Runemaster and Shaman, on both training paths.
  | Key: `classes.json`, `getStylesFor`, `style.specName`, `bonus.spec` | Display: `getSkills()`, the trainer window, `r.spec`, chat | On items |
  |---|---|---|
  | Shields | Shield | Shields |
  | Light | Light Magic | Light Magic |
  | Mana | Mana Magic | Mana Magic |
  | Void | Void Magic | Void Magic |
  | Subterranean | Subterranean | Cave Magic |

  Other lines have one name, and items spell a few differently (Smiting, Throwing, Recurved Bow). Spell lines are something else again: the Runemaster's Darkness casts from Runes of Darkness, which `trainSpec` answers with `spec_not_found` and the list of real lines. `specKey(name)` and `specDisplayName(name)` in `data/index` convert.
  - **A script reading a line's level uses `sdk.findSpecialization(name)`:** `specs.find(s => s.name === name)` only knows the display name, so any other name finds nothing, with no message. It returns null for a line not learned yet too (a Paladin's Parry before 15), so compare `specKey(name)` with `getClass(cls).specializations` to tell a typo from that. `trainBuild` does all this itself.
  - **What the server wants:** the window trains by index, so no name reaches it. `/train` takes a key prefix: `/train Light Magic 5` gets "The provided skill could not be found" and `/train Light 5` trains, while `/train Shield 5` and `/train Shields 5` both work. `trainSpec` sends the key there.
- **From level 5 a base trainer's words change, and its training doesn't:** Master Graent says "You must now seek your training elsewhere" and lists [Armsman], [Paladin], [Mercenary] (FighterTrainer.cs:63-65), but his window and `/train` still spend on the base class's lines (GameTrainer.cs:112-115, 130-132). Promote first, or the points go to those lines ([builds.md](builds.md)).

## Promotion

With `start_as_base_class` on, an Armsman starts as a Fighter. At level 5 the advanced-class trainer promotes you (GameTrainer.cs:300-318 `CanPromotePlayer`: level ≥ 5, the matching base class, an eligible race and gender). Verified live for Albion Fighter → Armsman:

```typescript
await bot.whisper('Master Visur', 'Camelot');                     // region 10, City of Camelot
await sdk.waitForCondition(s => s.player?.regionId === 10, 20_000);
await bot.walkToObject('Captain Rion');                            // Armsman trainer
await bot.navigateDialog('Captain Rion', ['join the Defenders of Albion', 'slashing']);
// → class Armsman, "Here is your Sword of the Initiate." (ArmsmanTrainer.cs:96-125: slashing/crushing/thrusting/polearms)
await bot.trainSpec('Captain Rion', 'Slash', 1);                   // "Trained Slash 2 → 3"
await bot.navigateDialog('Master Visur', ['towns', /prydwen/i]);  // back to Prydwen Keep
```

- After promotion, `sdk.getSkills().styles` lists the new class's styles (Armsman: Ruby Slash at Slash 2). See [combat.md](combat.md).
- **Spend after promoting:** `bot.trainBuild(trainer)`, standing within 150 units of the trainer. `player.specPoints` lags behind the promotion, and `trainBuild` talks to a trainer in reach to get the real number. `bot.whisper` can promote from farther off, so walk in first ([builds.md](builds.md#what-the-server-does)).
- **Read the keyword with `bot.talkTo` first:** it differs by class and trainer. Live: `join the Church of Albion` for a Paladin or Cleric, `join the House of Tyr` for a Warrior, the class name for a Warden or Blademaster, `song` for a Bard. From the trainer scripts: `Temple of Arawn` for a Reaver, `Path of Affinity` for an Animist or Valewalker. Some bracketed words only give information, such as [Necromancers].

## Teleporters

Master Visur <Teleporter> stands about 1360 units from the Prydwen Keep start and also in the City of Camelot. Verified live at level 1, for free:

```typescript
await bot.whisper('Master Visur', 'Camelot');          // "I'm now teleporting you to Camelot." → region 10
await bot.whisper('Master Visur', 'Prydwen Keep');     // back to region 1 (the [towns] sub-list)
await bot.navigateDialog('Channeler Glasny', ['towns', /ardagh/i]);  // Hibernia, from Mag Mell: verified live; Uilliam, the Warden trainer, is 1,959 units from that landing
```

- **Destinations:** top-level keywords are Castle Sauvage, Snowdonia Fortress, Avalon Marsh, Gothwaite Harbor, Shrouded Isles, Camelot, Entrance, Housing, towns and Epic Dungeon. `towns` lists Cotswold Village, Prydwen Keep, Caer Ulfwych, Campacorentin Station, Adribard's Retreat and Yarley's Farm.
- **Waiting for arrival:** the teleport ends any walk with `region_changed`. Wait for it with `sdk.waitForCondition(s => s.player?.regionId !== before, 20_000)`.

## Dialog boxes (yes/no)

`sdk.getDialog()` is the open 0x81 box (`text`, `type` 1 = yes/no). Answer it with `bot.respondToDialog(true | false)`. Group invites have a helper, `bot.acceptGroupInvite()`, which was verified live. Quest offers are unverified.
