# Hero

Hibernia's tank: a large shield with blades, or a two-hander or spear in the other builds. For every style and level on this server run `bun data/class-sheet.ts Hero`; for what a build reaches, `bun sdk/classes/reach.ts Hero "Sword and board tank"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/hero.ts` is the tank's list with its own style pick, `heroStyle` (tested in `sdk/classes/hero.test.ts`):

```typescript
import { hero } from '../../sdk/classes/hero';
export default hero();
```

**Against a player, a stun once per immunity (2026-11-09, arena round 5 onwards).** The queue for his next swing:

| What just happened | Queue (first, backup) |
|---|---|
| His last block was the foe's last swing at him | Incapacitate (5 s, 20 end), Numb |
| Anything else | Disable (side, 4 s), Numb (any time, 2 s) |
| Our stun landed on it < stun + 60 s ago | the reacting tank's pick: reactions, then Fire Blade |

- **Why a backup stun, server code.** The choice goes in right after his own swing, for the next one (`actions.ts` style resend), and the server checks the opening when that swing comes (`PlayerStyleComponent.GetStyleToUse`). A block reaction needs the foe's *last* swing at him to be the block (`StyleProcessor.CanUseStyle`, Defensive), so a foe that swings again first spoils it, and the old kit's reactions never landed (rounds 43-48, s14). Numb behind it fires anywhere, so the swing stuns all the same. Without a backup the server swings the failing style anyway.
- **Why stuns, server code.** A stun stops the target's cast at once (`AbstractCrowdControlECSEffect.OnHardCCStart`: `StopCurrentSpellcast`), where a plain hit past a cast's half way doesn't, and Hibernia's focus is mostly their back line. Style stuns give players the flat 60 s immunity (`immunity_timer_flat_length`, from the stun's end), so the kit keeps its own log of what it stunned and when; a style stun isn't marked on the board, so the group's `cc` and `ccHolds` don't stop the nukers.
- **Endurance:** a stun is queued only if he can pay it (Numb and Disable 15, Incapacitate 20); Horizon Blade (5) is the block reaction left when he can't.
- **Monsters:** the old pick, unchanged.

**To look for:** "You perform your Numb/Disable perfectly" in the fight log, `Styles landed` in the report, the focus's casts cut short, and his endurance.

**Verified, arena round 9** (2026-11-09, against Midgard, won 7 kills to 4, 2 fights): the kit's first round. Styles landed Fire Blade 6, Numb 3, no Disable or Incapacitate; 1,135 damage, 1 death. The stuns land; from the side or after a block they haven't yet.

**Community, unverified:** DAoC RvR basics put stuns, mezzes and roots first among what turns a fight, and warn against breaking crowd control early ([Demise RvR basics](https://sites.google.com/view/demise-s3/rvr/the-basics)). No Hero-specific stun guide turned up in a search on 2026-11-09.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/hero.ts` ([builds.md](../builds.md)). Multiplier 20, so 584 points by 24. Levels the rule gives each build, lines in buying order:

| Character level | Points | Sword and board tank: Blades / Shields / Parry | Large Weapons and Slam: Large Weapons / Shields / Parry / Blades | Celtic Spear and Slam: Celtic Spear / Shields / Parry / Blades | Shield-heavy: Large Weapons / Shields / Parry / Blades |
|---|---|---|---|---|---|
| 10 | 94 | 10 / 8 / 1 | 10 / 7 / 1 / 4 | 10 / 7 / 4 / 1 | 7 / 10 / 1 / 4 |
| 20 | 404 | 20 / 18 / 6 | 20 / 15 / 6 / 10 | 20 / 15 / 11 / 1 | 18 / 20 / 1 / 4 |
| 24 | 584 | 24 / 18 / 14 | 24 / 15 / 14 / 10 | 24 / 15 / 14 / 10 | 21 / 23 / 6 / 10 |
| 30 | 914 | 30 / 25 / 14 | 30 / 23 / 14 / 10 | 30 / 23 / 14 / 10 | 30 / 26 / 6 / 10 |
| 40 | 1624 | 40 / 36 / 14 | 40 / 35 / 14 / 10 | 40 / 35 / 14 / 10 | 40 / 37 / 6 / 10 |
| 50 | 2979 | 50 / 50 / 28 | 50 / 42 / 38 / 10 | 50 / 42 / 38 / 10 | 50 / 50 / 27 / 10 |

Cuchulainn plays Sword and board tank, whose numbers are ours. **Community, unverified:** Large Weapons and Slam is Blackthorn's most common spec at 50, and Shield-heavy its second; both are for a two-hander, which the `tank` behaviour doesn't switch to. Only Sword and board has been played.

The lines' KeyName is `Shields`, which the client and the trainer show as Shield ([npc-dialog.md](../npc-dialog.md)). Promotion at 5: whisper `hero` at the trainer (Searlas in Mag Mell; verified). A Guardian seeded before the fork's fix has no starter armour ([classes-and-races.md](../classes-and-races.md)). Better armour comes at 15 ([merchants.md](../merchants.md)).

## Which style

**Verified: the name doesn't tell you the threat.** Cuchulainn's anytime styles at Blades 8 are Enervating Blade, Taunting Blade, Numb and Shining Blade, and Enervating Blade is a detaunt (spell 20001: -0.9 times the hit's threat). An old name match took it for his damage style, so for the whole levelling campaign he shed threat on every hit after the 6 s `tauntOpenMs`. Hold still came to 97-100 %, carried by the opener: 1,466 of 1,476 opener notes were Taunting Blade. `tankStyles` now reads the proc from the server. [group-coordination.md](../group-coordination.md) has the threat numbers.

**Verified,** at 24 his damage style is Fire Blade (Blades 18, anytime, 15 endurance): 64 landed in 33 minutes of RvR, against 1 Taunting Blade. Against players the `tank` behaviour swings the damage style every time, since taunts move no threat on them.

**Server code.** Blades 24 and Shields 18 reach, and the plain `tank` doesn't use:

| Style | When | Does |
|---|---|---|
| Horizon Blade (Blades 21) | after a block | 4 s stun |
| Incapacitate (Shields 18) | after a block | 5 s stun |
| Stun (Shields 8) | after a block | 3 s stun |
| Disable (Shields 13) | from the side | 4 s stun |
| Glowing Blade (Blades 10) | from the side | 60 % snare, 14 s |
| Numb (Shields 3) | any time | 2 s stun |

Numb is an anytime style, and `tankStyles` skips it once Fire Blade is worth more per endurance. The stuns are what a Hero has that a healer behind him would want, and the kit is what swings them.

Slam, the 9 s anytime stun, is Shields 42, past level 40 in this build, so it doesn't help in Thidranki.

## Shield and Guard

- **Block** rises 0.5 % per Shields level (`BlockChanceCalculator.cs:15`). Guard I, II and III come at Shields 5, 10 and 15, so Shields 18 has them all.
- **Guard** blocks for its target only within 256 of him (`GuardAbilityHandler.GUARD_DISTANCE`). The healer's `combatRange` is 500-1600, so in a fight she's usually out of it. Nothing measures how often it fires.
- **Group setting:** Hibernia's strategy has `guard: { guard: 'healer', protect: 'Ciaran' }`, because Ciaran's burst drew aggro in runs 064822 and 071838. Protect has no shield: it moves 10 % per level of a member's threat to the tank, which does nothing against players.

**Verified,** PvE: "Brigid guarded by Cuchulainn" and "Ciaran protected by Cuchulainn" show in his effects; run 193919 had tank hold 95 % against 88 %, with taunt, peel and guard all new in it and no adds to test peel on.

## What the reports show

**Verified,** three Hibernian RvR rounds at level 24, 33 minutes, to 2026-11-03 21:17, against the other two tanks over 46 minutes:

| Tank | Build at 24 | Damage a minute | Deaths per 10 minutes | Targeted | Main failures |
|---|---|---|---|---|---|
| Cuchulainn, Hero | Blades 24 | 274 | 0.6 | 34 % | `kill:crowd_controlled` 10, `kill:timeout` 9, `retreat:stuck` 8 |
| Thorgrim, Warrior | Axe 24 | 232 | 1.1 | 18 % | `kill:out_of_reach` 121, `kill:timeout` 11 |
| Galahad, Paladin | Slash 18 | 140 | 0.7 | 22 % | `kill:out_of_reach` 15, `kill:timeout` 13 |

- He's the group's damage in RvR: 8972 against Ciaran's 4060 and Niamh's 2518. Few runs, and the other two groups had the same long brawl.
- He's the one most targeted, and with Ciaran he died least of his group: 2 deaths against 5, 5 and 12.
- Template health is 677. The group's hold figure doesn't apply on players, who have no threat to hold.

## Not supported yet

- **Stuns held for a cast:** the kit stuns the focus as soon as it can, not when the focus starts a heal. The style choice comes a swing ahead, so holding it would need the cast seen before our swing.
- **Engage** (Shields 7): no behaviour uses it.
- **Guard in a fight:** `guard` runs only out of fights, so a Guard lost to a death stays down until the next quiet moment.

**Verified, arena round 12** (against Albion, won 7 kills to 0, no deaths): Numb landed 6, Fire Blade 1; 1,261 damage. Still no Disable (side) or Incapacitate (block). Fire Blade fell from 6-12 a round to 1: the stun takes the swing whenever a target is off immunity, and Numb's 15 endurance each leaves less for it. Watch his endurance before adding more stuns.

**Arena round 13** (lost 1-4 to Midgard): 36 damage, no style landed. Mezzed at 6 s; after it, the group's peel orders switched his target every 1-3 s ("peel #494 off Oisin", "#492", "#495", "#493"), so he swung at nobody long enough to land a hit. That is the group's peel, not the kit (raised with the Hibernia group session).
