# Combat

## Picking a target

```typescript
const mob = bot.findKillableNpc();                                   // nearest green..yellow monster within 2500
const hounds = bot.findKillableNpcs({ pattern: /spirit hound/, radius: 3000 });
const harder = bot.findKillableNpc({ minCon: 0, maxCon: 1 });        // yellow..orange
const byLevel = bot.findKillableNpc({ maxLevelDiff: 1, minLevelDiff: -1 });
```

- **Alone at low level, hunt below your level.** The default reaches up to yellow, which is too high for a fresh melee. A Hibernian Warden at levels 1-6: 63 fights two levels below it with no death, 26 fights one below with 1, 2 fights at its own level with 1. A Blademaster lost 6 of 6 at its own level at level 3. In con terms that is `maxCon: -1`. Casters weren't measured, and a group is different ([group-coordination.md](group-coordination.md)).
- **Killable** means the NPC is attackable, has realm `'none'` (a monster, not a realm NPC), and its role isn't one of merchant, trainer, guard, healer, stablemaster, vault, teleporter or service. Roles are guessed from the name and guild text; check `npc.role`. A lowercase name is a monster whatever role it reads as, so a dergan enchanter (`service`) stays huntable. A capitalised monster with such a word in its name (Undead Guard, Keeper Rasa) is refused.
- **Engaged mobs are skipped:** ones already fighting someone else, and wounded ones not fighting us. `includeEngaged: true` keeps them.
- **Con levels** (`conLevel(playerLevel, npcLevel)`, a port of `ConLevelGrid.cs`): -3 grey (no XP), -2 green, -1 blue, 0 yellow, 1 orange, 2 red, 3 purple. `conColor(n)` gives the name. At level 1 a level-0 spirit hound is blue.
- `bot.getAttackers()` lists the NPCs fighting us, nearest first: their reported target is us, or their swing or spell landed on us in the last 6 s. Fight those first. `npc.targetObjectId` alone misses a caster or a running mob: the server sends it only for a mob in attack state, able to turn, standing within its attack range, and a mob starting a timed cast leaves attack state (`PacketLib168.cs:820-828`, `StandardMobBrain.cs:442-443`). Seen live: a moss sheerie's spell landed at 427 units with `targetObjectId` null and `inCombat` false, and it stayed null while the mob ran in; a dergan enchanter at 446 reported the same between spells. A hit briefly shows as its target until the mob's next update. A caster that hasn't landed anything yet isn't listed: a cast start doesn't name its target.

## killNpc

```typescript
const k = await bot.killNpc(mob);
// k.killed, k.xpGained, k.moneyGained, k.itemsGained, k.durationMs, k.levelsGained, k.reason
```

What it does:

1. Walks within 90 units (3D, adopting the mob's z).
2. Targets the mob, faces it, and turns auto-attack on.
3. Re-approaches when the mob moves beyond 118, and chases up to `maxChaseDistance` (2500) from where the fight began.
4. Finishes when the server reports the death ("The X dies!"). The XP, money and loot messages arrive within about 0.5 s afterwards.

| Reason | Meaning |
|---|---|
| `died` | we died; see [death-and-rest.md](death-and-rest.md) |
| `timeout` | over `timeout` (60 s); attack and chase are stopped |
| `target_lost` | the mob vanished above 20 % health |
| `out_of_reach` | it ran beyond `maxChaseDistance` |
| `not_attackable` | `isKillable` said no; `force: true` overrides |
| `refused` | the server refused the attack (message in `k.message`) |

`bot.attack(npc)` only starts melee: it approaches, targets, faces and swings, then returns. Use it when you want to manage the fight yourself.

## Grinding

```typescript
const g = await bot.grind({
    durationMs: 120_000, radius: 3000, respawn: true,
    restBelowHealth: 50, restToHealth: 95,
    onKill: (kill, stats) => console.log(stats.kills, kill.npc?.name, kill.xpGained),
});
// g.kills, g.deaths, g.failures, g.xpGained, g.moneyGained, g.levelsGained, g.stopReason, g.reason, g.message
```

Each pass of the loop:

1. Attackers come first.
2. Otherwise rest when low on health (or mana with `restBelowMana`).
3. Walk back when farther than `radius` from the anchor.
4. Kill the best killable target, then loot.

A mob that failed is avoided for 60 s. A death stops the grind unless `respawn: true`, which releases and walks back to the anchor. Deaths the server auto-released are counted too. `onKill` returning `false` stops the run. The ready-made script is `bots/examples/grinder.ts`.

- **`stopReason`:** `duration`, `maxKills`, `died`, `onKill`, `no_targets` or `error`.
- **Nothing to fight:** after `noTargetTimeoutMs` (default 60 s; `0` or `Infinity` turns it off) idle near the anchor with no candidate, grind stops with `no_targets`. Its message names the con window and your level. Resting resets the count. Widen `maxCon`/`radius`, or move to a better spawn (`findNpcSpawns`).
- **The last fight runs past `durationMs`:** grind finishes the kill it started, so a 120 s grind can take 140 s. A death in that last fight is counted (`stopReason: 'died'` without `respawn`), but with `respawn: true` the bot can be left dead when grind returns. Check `bot.isDead()` afterwards.

## Numbers from live runs (xp_rate 3)

- **Albion Fighter at Prydwen Keep (level 1–3):**
  - Spirit hounds (level 0) give 16–17 XP each at level 1 ("You get 17 experience points. (2 camp bonus)").
  - A kill takes 4–20 s plus the walk.
  - The hounds live about 2400 units from the start point (x≈576100, y≈528300, z≈2200).
  - 3-minute grind: 14 kills, level 1 → 3, 0 deaths.
  - 90-second grind: 5 kills, level 1 → 2. Drops seen: Fortifying Cloth Gloves, staff, Sturdy Cloth Pants, 2–3 copper per kill.
- **Grouped:** two level-1/2 Fighters share XP. Each got 10 instead of 16–17, and money was split ("Your share of the loot is 1 copper"). See `bots/examples/duo.ts`.
- **Wild sows (level 2), small bears (level 4) and large skeletons (level 5)** live farther from Prydwen. Look before you pick, with `bun bots/examples/explorer.ts <bot>`.

## Styles

- `bot.useStyle(name)` queues a style for the next swing and is confirmed by "You prepare to perform a ...".
- `killNpc(mob, { styles: ['Name1', 'Name2'] })` rotates styles, one per swing while endurance is at least 15 %.
- `useStyle: ({ npc, player, styles }) => name | [name, backup] | null` chooses per swing instead. Choosing goes right after each swing the bot sees (or after 5 s without one).
- **The server keeps two styles: a first and a backup.** The first style sent becomes the first, a different one the backup ("You are now preparing to perform a Taunting Blade style as a backup for Return Blade!"), and anything more gets "You have already selected your styles for this round!". A swing empties both (`PlayerAttackAction.FinalizeMeleeAttack`).
  - **It decides when the swing happens, not when you send** (`PlayerStyleComponent.GetStyleToUse`): the first if its opening is met right then, else the backup. So don't guess whether a reaction will be open: queue `[reaction, anytime]` every swing. Verified live: `[Return Blade, Taunting Blade]` landed Taunting Blade 14 times and Return Blade once in 6 fights, with no failures.
  - **A first style with no backup and its opening unmet still costs its endurance** and does no style damage ("You fail to execute your X perfectly!"; `StyleProcessor.ExecuteStyle`). A conditional style alone is worth sending only when it's certain.
  - Positional styles are checked the same way, so `[positional, anytime]` is safe from anywhere.
  - `/cancelstyle` toggles what sending the first style again does: off (the default), "You are already preparing"; on, it cancels both. Leave it off: the SDK resends. `/backupstyle` sets a permanent backup, but `allow_auto_backup_styles` is off on this server. `auto_select_opening_style` is off too, so a follow-up never runs its opener for you.
- Any weapon style still rolls for the offhand (`WeaponAction.CalculateExtraSwings` doesn't look at the style), so a Blademaster's Blades styles don't give up Celtic Dual's swings.
- A proc says what it does to threat in the server's words, in `style.details.procSpell.description`: "Taunts the target, increasing your threat against it by 17." and "Detaunts the target, decreases your threat against it by 19." (`StyleTaunt.cs`; both read live). Note the different verb forms. Names don't tell: a Hunter's Taunting Call detaunts. `raisesThreat` and `shedsThreat` in `sdk/group/styles.ts` read them, and `procUnknown` says the server hasn't described the proc yet.
- **Which style, for any fighter** (`sdk/group/styles.ts`): `canWield(style, equipment)` checks the weapon, `lastStyleLanded` and `foeLastResult` read what just happened, and `fighterStyle()` queues what has an opening first and the best plain style behind it. `assist({ melee: true, style: fighterStyle() })` on the default melee lists; `tank()` takes one through a character, and otherwise uses `tankStyles`. Its numbers (`STYLE_RULES`, overridable) are starting values from one Blademaster, whose few fights showed endurance more clearly than damage: with Misty Gloom (growth 7 for 15) 25 % endurance left, on reactions only 95 %. A Skald on `fighterStyle`, joining at once and with its damage song dealt 3.2-4.1 damage per fight second against 1.7-2.4 before, in alternating runs (9 and 11 fights, black wolves); its styles weren't measured apart from the other two.
- **`style.details` says what a style does**, from the 0xD8 tooltip the server pushes after the skills list: `fatigue`, `attackMod`, `defensiveMod`, `openingDamage` (damage growth), `opening` with `result` and `position`, `openingStyle`, `followUps` (learned or not), `weapon`, and `procSpell`. A combat event doesn't name the style; the last one is in "You perform your X perfectly!". Verified live at Celtic Dual 4:
  - Misty Gloom: `fatigue` 15, `openingDamage` 7, anytime.
  - Blinding Rain: `fatigue` 5, `attackMod` 10, `openingDamage` 175, `opening` defensive, `result` evade, `followUps` Blizzard, and a bleed of 3 body damage every 4 s for 20 s.
- **`style.prerequisite`** is the same rule as a code (PacketLib1112.cs:125-146): 0x100 anytime, 100 + result a reaction, 200 + position positional, or result with 100 + the opener's skillIndex in the high byte.
- **Base classes have no styles; promotion brings them** (verified live):
  - Style rows are keyed by class (`style.ClassId`; SkillBase.cs:600-625, Specialization.cs:374-381). `getStylesFor(14)` (Fighter), `getStylesFor(35)` (Viking) and `getStylesFor(52)` (Guardian) are empty; Armsman (2) has 84.
  - Training a weapon spec on a base class unlocks nothing: a Fighter trained Slash 1 → 2 and still had 0 styles at level 4.
  - After promotion at level 5 the styles of the new class appear in `sdk.getSkills().styles`. An Armsman with Slash 2 has Ruby Slash, and `killNpc(mob, { styles: ['Ruby Slash'] })` killed a snake with 4 styles used ("You perform your Ruby Slash perfectly!").
  - The promotion steps are in [npc-dialog.md](npc-dialog.md#promotion).

## Gotchas

- **Melee range is 128 in 3D,** plus 32 for each side that is moving. A wrong z breaks melee; `killNpc` adopts the mob's z, but raw `sdk.sendAttack` doesn't.
- **Facing:** a swing needs the target within a 120° arc in front of you. `killNpc` re-faces automatically. `bot.face(n)` with a bare number always turns to heading `n`; face an object by passing the object, a name pattern or `{ objectId }`.
- **"IN COMBAT"** in the state summary right after a kill is normal. The server's in-combat flag lingers for a few seconds.
- **Guards and other realm NPCs are never killable targets:** `isKillable` rejects any NPC whose realm isn't `'none'`. `force: true` skips that check, but the server still decides whether the attack is allowed.
