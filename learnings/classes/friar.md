# Friar

Albion's staff-fighting priest: Rejuvenation heals, Enhancement buffs, the Staff line, Parry and Evade, in leather. For every spell, style and level on this server run `bun data/class-sheet.ts Friar`; for what a build reaches and which behaviour casts it, `bun sdk/classes/reach.ts Friar "Group support"`. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/friar.ts` is a healer who uses what the healer list leaves:

```typescript
import { friar } from '../../sdk/classes/friar';
export default friar();
```

- **`react`: `groupHeal(3, 30)`** (the Druid's): Angelic Commendation, 33 to each member within 2000 of him, 3 s, 17 power, when three or more around him (him too) each miss most of it, above 30 % power. `heal` picks the cheapest single heal that covers one member, so without this nothing casts it. It sits below `heal`, so it only tops up while nobody is under the heal lines.
- **`react`: `reachHurt()`** (the Druid's): with nobody in his reach to heal, one leg toward the most hurt member 2000-3500 away, never with a melee on him. Brigid's "nothing to do" idle fell with it (druid.md).
- **`chores`: `song()`**: Saint's Vigor, his endurance chant (instant, free). No healer list plays a song, so without this it never plays. With no Paladin in the line-up it is the group's only endurance song, and styles stop silently below 15 % ([group-coordination.md](../group-coordination.md)).
- Options `groupHealMin`, `groupHealAbove`, `chant`.
- **Not in the kit:** the Cleric's `instantHealSave` and `stunPeel`, and the Healer's slow: their spell filters find nothing in his book. He has no crowd control, no instant heal and no spell stun at 24.

## At 24, Group support (Rejuvenation 15, Enhancement 18, Staff 15, Parry 7)

**Server code**, by `reach.ts`:

- **Heals:** single target, range 2000, 2.2-3.2 s, up to Revival (109, 19 power) and Major Revival (136, 3.2 s, 24 power). None is instant, so `castBlocked` skips every one while a melee is on him.
- **Group heal:** Angelic Commendation (above). No heal over time below Rejuvenation 24.
- **Rez:** Raise Fallen (30 % health, 4 s, range 1500), which `rez` casts.
- **Buffs on others** (concentration): Aura of Guarding AF 32, Holy Strength 26, Blessing of Fortitude con 29, Blessed Coordination dex 25, range 1000. **Self:** Shield of Justice (spec AF 29), Agility (dex/qui 36), Alacrity of the Angel (haste 19 %, 30 s, 180 s timer; `buff` slots it as `haste` but the healer's needs leave it out).
- **Unused:** Cure Poison (removes damage over time and style bleeds) and Cure Disease, 3.2 s, range 1500; Saint's Energy (-10 % endurance use, self); Tease (a taunt, monsters only).
- **Abilities from his class:** Evade IV at 22 (`specxability.sql`); `reach.ts` reads spec lines only and lists none.

**Staff styles at 15:** Defender's Fury (anytime, the target swings 19 % slower for 20 s), Quick Strike after it; Figure Eight after he evades, then Friar's Ally (a 3 s stun) or Double Strike (a bleed). A style stun shares the 60 s stun immunity with our Cleric's Stunning Flare (cleric.md).

**Concentration** (`buffs.ts`): base buffs go to the support first, then the first healer by member order. With a Cleric in the group whichever is listed first in `group.json` takes them; his four come to about 30 of a pool near 160.

## Arena

**Verified,** on the plain healer list before the kit:
- Round 122 (2026-11-10, against Midgard, lost 0 / 6), the only healer: 0 heals, 1 rez; targeted 41 %, in melee 45 %, idle 38 % on "nothing to do"; died once. The enemy reads a Friar as a healer (`class-read.ts`), so he is a focus.
- Round 124 (against Hibernia, lost 0 / 5), beside Nimue: 3 heals tried, 2 "That target is too far away!", 1 lost to an amnesia; idle 54 % on "nothing to do" (21 turns), 9 rez turns refused with Nimue under attack.

## Open

- Why "nothing to do" while the group died: nobody under the heal lines when he looked, members beyond 2000 (the kit's `reachHurt`), or another healer's claim. The next rounds' idle reasons say whether `reachHurt` moved it.
- Staff melee between heals (`assist({ melee: true })` while everyone is above the heal lines): Defender's Fury's slow on whoever is on our healer. It would pull him into the enemy's reach; not tried.
- Cure Poison against style bleeds in his idle turns.
- Which healer leads the buffs and the guard when he and a Cleric play together (camelot's `guardHealer` takes the first healer).
