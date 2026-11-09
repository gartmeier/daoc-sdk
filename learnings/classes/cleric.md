# Cleric

Albion's healer and buffer: heals from Rejuvenation, every stat buff from Enhancement, and from Smite a nuke and a stun. For every spell, level and cost on this server run `bun data/class-sheet.ts Cleric`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Cleric "Healer"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/cleric.ts` is a healer that casts Smite on the focus when nobody needs healing, above a floor of power:

```typescript
import { cleric } from '../../sdk/classes/cleric';
export default cleric();                       // or cleric({ saveBelow: 30 })
```

**Why, verified:** she was idle 51 % of fights, "nothing to do" 820 times, and has no mezz or root to fill it. Ulfgar's 0 damage in 46 minutes is the same list ([shaman.md](shaman.md)).

**What changes, server code:** `assist` goes above `position` (in the wolf pack, above `shedLoad`), below `heal`. At Smite 1 it casts Minor Judgement: 54, 3 s, 15 power. Below 50 % power she leaves it. The floor is a guess, picked because Greater Revival costs 52 power; the 40 % on the Sorcerer and Theurgist was measured on nukers, and nothing was on a healer.

**The cost:** `assist` can't be interrupted, so someone who drops just after she starts waits up to 3 s for the heal. And when she can't see the focus outside the wolf pack, `assist` walks her toward it.

**Not played.** To look for: her nukes and damage a minute, and whether her heals, `no power` and the group's deaths get worse. In PvE, Camelot's `memberBehaviors` don't name her, so it applies there too.

## Stun peel, and no Smite at players below 75 % (kit, arena round 6 on, 2026-11-09)

**Verified, arena round 5** (Camelot won 10 kills / 5 deaths, `groups/camelot/runs/20261109-210152.md`): Nimue cast 16 nukes against 12 heals, idled 21 times on "saving power (< 50 %)", and the group waited in `recover` for her power. Each Smite was about 36 damage for 15 power. In round 3 she landed 2 heals in a whole round and died twice, once in Greater Revival's cast.

**The change** (`sdk/classes/cleric.ts`):
- `stunPeel` casts Stunning Flare (baseline Smite, 1500, 2.5 s, 9 power, 5 s stun; **server code**) on an enemy player in melee on one of our non-tanks, the healer first. With no such player, it stuns the enemy healer while our focus is at 60 % or less. It never stuns a mezzed or stun-immune target. It casts from where she stands, and only above 15 % power. It sits below `heal`, so a heal always comes first. A stun on the focus isn't marked as crowd control, because a stun doesn't break on damage and the nukers keep hitting. Whatever it lands on is marked stun-immune for 5 + 60 s.
- Her kit's own Smite (50-75 % power) no longer goes at players. The RvR list's `spareNuke` still smites above 75 %. In PvE nothing changes.

**Arena round 6** (camelot vs midgard, the first round with the kit): 15 heals, 7 nukes (`spareNuke`), and `stunPeel` twice: once interrupted, once `must_wait`. She was in melee 32 % of fight time herself, so heal and flee took most turns. 148 idle turns read "no smite at players below spareNuke's floor": those are turns with nothing to heal and no one to stun. The Midgard class session's Healer kit now uses `stunPeel` too (2a3e7ca), so keep its interface stable.

**After round 6:** with no enemy healer in reach and the focus at 60 % or less, she stuns the focus itself, so it can't heal itself, cast or run while the nukes land. The Smite floor stays. The 148 "no smite at players" skips came at any power, since that check runs before the power floor, so they don't show power held back. A 9-power stun is a better use of those turns than a 15-power, 36-damage Smite.

**Arena round 8** (Midgard wiped Camelot in 5.2 min, 0 kills / 5 deaths, `groups/camelot/runs/20261109-213756.md`): Midgard's Spiritmaster pet ("The spirit warrior attacks you and your spell is interrupted!") broke Morgana's and Taliesin's casts before they died. Nimue cast 5 heals and 1 stun, with 128 idle turns. The peel case now also takes an enemy pet in melee on one of our non-tanks. The healer and focus cases stay players only.

**Arena round 10** (Camelot wiped Hibernia 5/0 in 4.6 min, `groups/camelot/runs/20261109-215403.md`): `stun` 4 with no failure, 4 heals. She was never targeted and never in melee, and nobody died.

**To look for:** `stun` results in her report line, `heal` count against round 5's 12, and deaths of Merlin and Taliesin, who were in melee 19 % and 31 % of fight time.

**Community, unverified** (the research agent's notes; web sources were thin, the server-code points are checked): stand at the back inside heal range (about 2000). Don't Smite at low Smite spec, except to finish a near-dead enemy when nobody needs heals. Heal the enemy's target first, then yourself. Buff Str/Con and Dex/Qui on the melee members first, then AF. Rez after the fight. **Server code:** instant spells skip the interrupt check (SpellHandler.cs:597, :603). A player is immune to spell stuns for 60 s after one ends (ECSGameEffect.cs:54).

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/cleric.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Healer: Rejuvenation / Enhancement / Smite | Buffer: Enhancement / Rejuvenation / Smite | Smite: Smite / Rejuvenation / Enhancement |
|---|---|---|---|---|
| 10 | 54 | 7 / 7 / 1 | 7 / 7 / 1 | 7 / 1 / 7 |
| 20 | 209 | 18 / 7 / 1 | 16 / 11 / 1 | 14 / 1 / 14 |
| 24 | 299 | 19 / 14 / 1 | 21 / 11 / 1 | 18 / 6 / 14 |
| 30 | 464 | 26 / 14 / 1 | 26 / 14 / 1 | 25 / 6 / 14 |
| 40 | 819 | 37 / 14 / 1 | 32 / 23 / 1 | 36 / 6 / 14 |
| 50 | 1494 | 41 / 35 / 3 | 42 / 33 / 7 | 44 / 23 / 21 |

Nimue plays Healer. **Server code:** Rejuvenation 19 is Greater Revival (263) against 197 at 14 and 145 at 11. **Community, unverified:** Buffer is the standard Cleric in three sources. Healer's numbers come from a post about two Clerics in one group, and the group here has one.

A Cleric's heals live in the skills list, the hybrid path: `castSpell` handles it ([spells.md](../spells.md)). Promotion at 5: `join the Church of Albion` (**verified**, Lady Winchell). Studded from 10 ([merchants.md](../merchants.md)).

## Healer at 24 in Thidranki

**Server code,** Rejuvenation 19, Enhancement 14, Smite 1:

- **Heals:** the cheapest that covers, up to Greater Revival (263, 3.4 s, 52 power). Greater Recuperation stands out at 145 for 15 power, against 172 for 30, and it takes 3.6 s.
- **Her instant is rarely picked.** Gift of the Heavens is 40 % of her health, 230 on her template's 575, and a heal on a timer waits until nothing else covers. Greater Revival covers more, and past 263 `pickHeal` falls back to whatever restores most. So it goes off only when she's too short of power for anything bigger. A Healer's and Druid's 55 % does go off ([healer.md](healer.md)).
- **No crowd control.** Heavenly Visions, her only mezz, is point-blank, so she doesn't count as a mezzer (**verified:** rounds on 2026-11-01). The group's control is the Sorcerer's mezz and two roots.
- **Rez:** Raise Fallen, at Rejuvenation 15.
- **Reached, and no behaviour casts it:** Stunning Flare (stun, 2.5 s, 5 s), Heaven's Commendation and the other group heals, the cures. Minor Judgement (54, 3 s, 15 power) is in reach of `assist`, which the kit adds; `spareNuke` in the RvR healer list also casts it, above 75 % power. At Smite 1 its minimum is low ([mentalist.md](mentalist.md)).

## More buffs than she can hold

**Server code.** She's the only provider of almost everything in a group with no Bard, so her plan is the largest of any character here: 32 buffs for 232 concentration. Piety 89 and the template's 36 make a pool of 210 ([druid.md](druid.md)). Walking the plan in its order, 5 don't fit: Blessed Coordination on the tank and all four Renewals. Those are the least of it, as `BUFF_NEEDS` wants them, so the pool is about right.

- **Renewal shares a slot:** it's a health regen, and `slotOf` puts every regen in `regen`, so she stands in the plan for Merlin's power regen on Morgana and Taliesin ([sorcerer.md](sorcerer.md)).
- **Buffer's Enhancement 21** would buy rank upgrades, not more of them: each costs more concentration, so a Buffer would drop more than this.

**Verified, weight:** 90 % load after the template, the second heaviest of the 15.

## What the reports show

**Verified,** six Camelot RvR rounds at level 24, 46 minutes, to 2026-11-03 21:48:

| Deaths | Heals | Rez | `heal:crowd_controlled` | `heal:interrupted` | Targeted | In melee | Moving in fights | Idle in fights |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 4 | 47 | 1 | 29 | 14 | 12 % | 6 % | 28 % | 51 % |

- **She's the least targeted healer of the three realms** (12 % against 20-24 %), and the most idle: "nothing to do" 820 times. With no mezz or root she has nothing but heals to cast, and 43 were refused or interrupted against 47 that landed.
- **Nearly no rezzes:** 1 in 46 minutes, with every death walking 17-23k back from the portal keep (Camelot's log). `rez` needs a quiet moment and no enemy near ([group-coordination.md](../group-coordination.md)).

## Not supported yet

- **Stunning Flare on an enemy healer:** asked for in the group's log since the first RvR rounds. Nothing picks a stun for a target.
- **The idle time, outside RvR:** `spareNuke` is in the RvR list only ([rvr.md](../rvr.md)). At Smite 1 Minor Judgement's minimum is low ([mentalist.md](mentalist.md)), and about 40 a cast is what it did live.
- **Group heals** and **cures,** as for the Healer.
