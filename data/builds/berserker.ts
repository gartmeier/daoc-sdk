import type { ClassBuilds } from './types';

export default {
    className: 'Berserker',
    notes: 'Multiplier 20 (ClassBerserker.cs:31), no autotrain: 584 points at 24, 2979 at 50. Starts as Viking, which trains only Axe, Hammer, Sword and Parry; Left Axe arrives at level 5 (classes.json levelAcquired 5, GamePlayer.cs:9933). Left-hand damage is 0.625 + 0.0034 per Left Axe level (AttackComponent.cs:2259), so that line has style breakpoints but no damage step. A source saying 50 Left Axe gives 85% (2003 forum thread) does not match this server: 79.5% here. Role in sdk/group/strategy.ts: melee.',
    builds: [
        {
            name: 'Left Axe, Hammer, high Parry',
            role: 'Melee damage dealer who also holds up when attacked directly, in a group or alone.',
            why: 'Blackthorn rates this the most rounded shape and treats 50 Left Axe as a given. Hammer has both positional openers, Hammer 12 (Frost Hammer) from the side and Hammer 29 (Conquer) from behind. Level 50 is verbatim; level 24 is fitted to the same priorities.',
            order: 'Levels 2-4 buy Hammer 4 (Crushing Blow): a Viking has no Left Axe. Left Axe comes at 5, is at 3 there and at level from 7, with Left Axe 15 (Frost Shadow) at 15 and Left Axe 21 (Scathing Blade) at 21. Hammer takes the rest: Hammer 15 (Provoke) at 16, Hammer 21 (Revenge) at 22. Parry 10 at 24 from what is left. After 24 Left Axe stays at level: Left Axe 29 (Snowsquall) at 29, Left Axe 39 (Frosty Gaze) at 39, Left Axe 50 (Aurora Borealis) at 50. Hammer follows two or three behind: Hammer 29 (Conquer) at 32, Hammer 39 (Lambast) at 41. Parry stays at 10 until 40, then takes what is left, Parry 42 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Left Axe': 24, Hammer: 21, Parry: 10 } },
                { level: 50, specs: { 'Left Axe': 50, Hammer: 39, Parry: 42 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/berserker-guide',
                    title: 'Blackthorn wiki: berserker guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 Left Axe, 42 Parry, 39 Hammer as the balanced group and solo spec. No level 24 numbers.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Left Axe, Hammer, low Parry',
            role: 'Pure melee damage with one weapon type, leaning on the group for defence.',
            why: 'Two readable sources land on this, Blackthorn and the Uthgard blog; a third, on the Phoenix forum, was seen only as a search summary. At 24 it is the Uthgard levelling rule applied to this budget: Left Axe at level, the rest in one weapon, leftovers in Parry. Blackthorn calls it worse one on one than the high Parry shape. It is the weakest of the three when focused only at 24 (Parry 4); at 50 the two weapons build has less Parry, 16 against 28.',
            order: "Levels 2-4 buy Hammer 4 (Crushing Blow): a Viking has no Left Axe. Left Axe comes at 5, is at 3 there and at level from 7, Hammer one or two behind it from 8: Left Axe 21 (Scathing Blade) at 21, Hammer 21 (Revenge) at 22, and Parry 4 at 24. After 24 both keep climbing, Hammer 39 (Lambast) at 40 and Hammer at level from 41, to Left Axe 50 (Aurora Borealis) at 50 and Hammer 50 (Mjolnir's Fury) at 50. Parry stays at 4 until 40, then takes what the climb leaves, Parry 28 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Left Axe': 24, Hammer: 23, Parry: 4 } },
                { level: 50, specs: { 'Left Axe': 50, Hammer: 50, Parry: 28 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Levelling rule: Left Axe at level, the rest in one weapon line, leftovers in Parry. RvR spec: 50 weapon, 50 Left Axe, 28 Parry.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/berserker-guide',
                    title: 'Blackthorn wiki: berserker guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: 'Same 50/50/28 for players who do not want to swap weapons; weaker in one-on-one fights.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/which-berserker-spec-is-better-01D2MX4XN8HF1CGFQQR4YC0MED',
                    title: 'Which Berserker spec is better?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'A poster ends on Hammer 50, Left Axe 50, Parry 28.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Left Axe, two weapons',
            role: "Melee damage that changes damage type to suit the target's armour.",
            why: 'Only worth it with a script that swaps weapons by target, and sdk/group has no such logic. Listed because two sources give it, not as a default. Second weapon is Sword here; Axe works the same way.',
            order: "Levels 2-4 buy Hammer 4 (Crushing Blow): a Viking has no Left Axe. Left Axe comes at 5, is at 3 there and at level from 7. The weapons take turns, and the stops at 16 and 38 are ours, to keep them within 13 levels of each other: Hammer 11 at 13, Sword 10 (Assault) at 16, Hammer 15 (Provoke) at 19, Sword 15 (Aurora) at 22, then Parry 9 at 24. After 24 Hammer 25 (Crumble) at 32, Sword 25 (Ice Storm) at 38, Hammer 39 (Lambast) at 45, Sword 39 (Niord's Fury) at 49, with Left Axe 50 (Aurora Borealis) at 50 and Parry 16 at 50.",
            basis: 'adapted',
            targets: [
                { level: 16, specs: { 'Left Axe': 16, Hammer: 11, Sword: 10 } },
                { level: 24, specs: { 'Left Axe': 24, Hammer: 15, Sword: 15, Parry: 9 } },
                { level: 38, specs: { 'Left Axe': 38, Hammer: 25, Sword: 25, Parry: 9 } },
                { level: 50, specs: { 'Left Axe': 50, Hammer: 39, Sword: 39, Parry: 16 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/berserker-guide',
                    title: 'Blackthorn wiki: berserker guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 Left Axe, 39 Hammer, 39 Sword or Axe, 16 Parry for switching damage type by target.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: '50 Left Axe, 39 Hammer, 39 second weapon, rest Parry.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
