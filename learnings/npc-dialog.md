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

- **Location:** your class trainer stands near the start point. Master Graent (Fighter Trainer) is 89 units from the Albion Fighter spawn.
- **Free gear:** whisper `practice weapon` / `training shield` to get the items.
- **Training:**
  ```typescript
  const r = await bot.trainSpec('Master Graent', 'Crush', 1);   // r.fromLevel, r.toLevel, r.specPointsLeft
  ```
  It opens the trainer window, falling back to `/train <spec> <level>`, and observes the spec level rise. Verified live: Crush 1 → 2.
- **Spec points** come with levels (`player.specPoints`). The cost of each next level is in `sdk.getTrainer()?.specs` once the window is open.
  - **What comes:** levels 2-5 give their own number, and from 6 on each level gives the class's multiplier * level / 10, rounded down (`GamePlayer.cs:4705`). From level 40 half-levels add multiplier * level / 20. A multiplier of 15 gave 9 at level 6.
  - **What it costs:** each spec level costs its own number, so from 1 to N costs the sum of 2..N. Checked on a Blademaster's real points: 14 + 2 * (6..24) = 584 by level 24, against 573 for Blades 24, Celtic Dual 21 and Parry 9.
- **The base trainer stops at level 5:** from level 5 on, Master Graent only says "You must now seek your training elsewhere" and lists [Armsman], [Paladin], [Mercenary] (FighterTrainer.cs:63-65). Training continues at the advanced-class trainer after promotion.

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
