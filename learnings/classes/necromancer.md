# Necromancer

Albion's pet caster. Its summon puts it in shade: nobody can attack it, it can't melee, and the servant is its body. Every spell it has is a PetSpell, cast in two halves, the owner's and the servant's. For every spell, level and cost on this server run `bun data/class-sheet.ts Necromancer`; `reach.ts` lists none of its spells as cast by a behaviour, as none of the list's are. This file holds what those don't say.

- **Verified:** measured live on this server.
- **Server code:** read from the server source or data, or worked out by the same `Spellbook` a member fights with.
- **Community, unverified:** other players' advice, written for other servers and patches.

## The kit

`sdk/classes/necromancer.ts` is a `nuker` (2026-11-12, night stint R8). Written offline from the data and [pets.md](../pets.md#shade); the live check is below. The group's pet behaviours leave a shade alone (`petControl` returns for `isShade`, and `SummonNecroPet` isn't automatic, `spells.ts`), and `assist` has nothing to cast (a PetSpell is no Spellbook nuke), so the kit does it all:

- **`raiseServant`** (urgent): the top Call ... Servant, a 20 s cast, only with nothing hostile and no enemy player within 2500, not in a retreat.
- **`fallBack`** (urgent): no servant, not a shade, an enemy within 2500: a 1500 step straight away from the nearest, so `raiseServant` can go. Out of shade the Necromancer is cloth, and after a servant's death at 10 % of its health ([pets.md](../pets.md#shade)).
- **`keepTether`** (urgent, above `position`): a shade with its servant past 1200 walks to within 700 of it. The server cuts the bond past 1500 for 10 s, at once past 2000 (`NecromancerPetBrain.cs:300-326`).
- **`servantRetreat`** (urgent, never takes the turn): in a retreat, passive and follow, as `petControl` does for other pets.
- **`servantFight`** (in place of `assist`): the servant at the focus (an attack order per new focus, 3 s apart), then the PetSpell `servantNuke` picks, at the focus, the owner walking into its range if need be (a shade can't be hit). An NPC focus waits for the tank's hold, a player none.
- **`servantHeal`** (react): its heal over time (Regenerate Muscle at 24: 27 every 3 s for 15 s) below 60 % in a fight, below 85 % between fights with 40 % power, not while its icon shows on the servant.
- **`servantBuffs`** (chores): between fights with 40 % power, the top rank of each kind of servant buff (Vigor of the Dead, Servant of the Grave, Instructing the Servant, ...) whose icon the window doesn't show.

**The two halves (server code, `spell.sql` via `data/`):** a PetSpell with no cast time of its own has a 3 s servant half: Vitality Theft (lifedrain 73, range 1500), Energy Vacuum (68 and power to us). One with the owner's 3 s has an instant servant half: Pain of the Dead (lifedrain 48, range 500), the Cackles (direct damage, range 500). A swing at the servant interrupts its 3 s half, and the queue goes with it ([pets.md](../pets.md#shade): three Vitality Thefts for 42 power, none landed). Nothing can interrupt a shade. So `servantNuke`: under a melee on the servant (`getPetAttackers`, or a contact on it within 400) one with an instant servant half first, else the hardest hit, a lifedrain ahead of an equal one with the servant below 70 %; never a DoT, never an area spell (Channeled, Billowing Death) unless `aoe`. A servant-half spell waits out the last one's 3 s plus 300.

Options: `necromancer({ saveBelow: 30, aoe: true })`.

## In a group: what the rest of it expects

The risky part (the brief). What the shared code does with a shade, as read, and what the kit leaves alone:

- **Heals.** The healers heal members by their health. A shade's own health doesn't move in a fight, as nobody can hit it; the servant's does, and no healer heals a pet. So the servant has only `servantHeal` and its lifedrains. After the servant's death the owner is at 10 % and out of shade: the healers see that and heal it, and `fallBack` takes it away to raise the next.
- **Positions.** `position` keeps a nuker 700-1400 from the focus, where the servant fights, so inside the tether; `keepTether` covers a chase. `flee` never fires in shade: no melee can reach it.
- **Deaths.** The servant's death is no member's death; the owner's comes only out of shade. So a fight read by deaths understates what a Necromancer lost: read `pet-down` in the report.
- **Threats and retreats.** Enemies on the servant read as `targetPet` the Necromancer's name, as for any pet. The group's retreat margin counts members, so a servant down to 10 % doesn't pull the group out.
- **Region changes and quits** take the servant at a stale percent ([pets.md](../pets.md#shade)): `releasePet` first. A group's jump to the battleground does that by itself only through its scripts' own release.

## Builds

`bots/<bot>/build.ts` starts as a copy from `data/builds/necromancer.ts` ([builds.md](../builds.md)). Levels the rule gives each build, lines in buying order:

| Character level | Points | Deathsight: Deathsight / Death Servant / Painworking | Sight and servant split: Death Servant / Deathsight / Painworking | Sight and pain: Deathsight / Painworking / Death Servant | Servant with a healer: Death Servant / Deathsight / Painworking |
|---|---|---|---|---|---|
| 10 | 54 | 10 / 1 / 1 | 1 / 10 / 1 | 10 / 1 / 1 | 10 / 1 / 1 |
| 20 | 209 | 20 / 1 / 1 | 8 / 18 / 1 | 20 / 1 / 1 | 20 / 1 / 1 |
| 24 | 299 | 24 / 1 / 1 | 15 / 18 / 4 | 20 / 12 / 4 | 23 / 6 / 1 |
| 30 | 464 | 30 / 1 / 1 | 23 / 18 / 4 | 27 / 12 / 4 | 29 / 6 / 1 |
| 40 | 819 | 40 / 1 / 1 | 35 / 18 / 4 | 37 / 12 / 4 | 39 / 6 / 1 |
| 50 | 1494 | 48 / 24 / 6 | 37 / 39 / 4 | 39 / 37 / 4 | 47 / 26 / 4 |

At 24 Deathsight reaches Pain of the Dead (23), the owner-cast lifedrain the kit takes under a melee, and Energy Vacuum (18). The servant itself comes with character level (Call Necroservant at 20), whatever the spec.

## What pets.md already measured

From [pets.md](../pets.md#shade): leaving shade sets health to min(current, max × the pet's %), at least 10 %; the release, the pet's death and a tether's cut do it, and a zone change or quit with a stale percent. A servant took a L17 wolf in 54.7 s for 31 % of its health buffed, an unbuffed one lost to a L19 in 22 s. Its rest is 0.19 % a second. In Thidranki a necroservant hit 117 per 3 s, and an L13 pet killed a L20 Necromancer out of shade in 4 hits.

## Live check

None yet: the character comes from the night's thirty (R6). What to read in the sortie logs: `summon` (raiseServant) only between fights, `petAttack` per focus, `nuke` naming Vitality Theft and Pain of the Dead, `petHeal` with Regenerate Muscle, `walk`/`move` for the tether, and how often the owner leaves shade (a `fallBack` line, a `pet-down`).

## Not seen live

- Every behaviour above. The owner's walk into 500 for Pain of the Dead, which a shade can make safely by the server code; whether the server measures that range from the owner or the servant wasn't read.
- What enemies do about a servant whose owner they can't touch.
