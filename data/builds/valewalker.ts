import type { ClassBuilds } from './types';

export default {
    className: 'Valewalker',
    notes: 'Budget 437 at 24, 2223 at 50 (ClassValewalker.cs:13, multiplier 15). No autotrain. Starts as Forester with only Arboreal Path; Scythe and Parry wait for promotion at 5. Its Arboreal spells are its own lines (Valewalker Arb Path Spec and Base, class hint 56, Specialization.cs:158-192), not the Animist bombers. Instant self-haste is Speed of Kudzu (3), Rushing (8), Alacrity (14), Haste (21), Pace (31), Celerity (38), Rampant Speed (48).',
    builds: [
        {
            name: 'Scythe first',
            role: 'Melee damage with procs, self-haste and absorb from Arboreal.',
            why: "Level 50 is disorder.dk verbatim and spends exactly 2223. Blackthorn's 50/43/2 is the alternative when Parry is not wanted: Arboreal 43 adds Barkcase. Level 24 is ours, from disorder's levelling rule (Scythe at level or one below, the rest in Arboreal). Scythe 24: Grasping Roots (21), Winter's Scythe (18), Thorny Shield (15), Stunning Blade (5 s side stun, 10). Arboreal 16: Banestrike (proc, 16), Moss Buffer (15), Alacrity of Kudzu (14), Barkcrust (13). At 50: Conflagration (50), Damaging Grasp (8 s back stun, 44), Celerity of Kudzu (38), Scourgestrike (36).",
            order: "Levels 2-4 buy Arboreal Path 4 (the Forester's only line; 3 Speed of Kudzu is castable only from promotion). From promotion Scythe at character level (from 8) to 50: 10 Stunning Blade, 15 Thorny Shield, 18 Winter's Scythe, 21 Grasping Roots. Arboreal takes the spare points from 9: 5 Moss Padding by 9, 7 Blightstrike by 12, 8 Rushing Kudzu by 13, 10 Moss Coat by 16, 13 Barkcrust by 20, 14 Alacrity of Kudzu by 21, 15 Moss Buffer by 23, 16 Banestrike at 24. After 24: Arboreal 19 Barkhusk by 28, 21 Haste of Kudzu by 31, 27 Rotstrike by 40, 31 Pace of Kudzu by 42, 36 Scourgestrike by 46, 38 Celerity of Kudzu by 47. Scythe keeps on: 25 Nature's Shield, 29 Blizzard Blade, 34 Arboreal Shield, 39 Flaming Scythe, 44 Damaging Grasp, 50 Conflagration. Parry takes what is left: 7 at 47, 20 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Scythe: 24, 'Arboreal Path': 16 } },
                { level: 50, specs: { Scythe: 50, 'Arboreal Path': 38, Parry: 20 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Good endgame spec is 50 Scythe, 38 Arboreal, 20 Parry. For levelling: Scythe at level or one below, the rest in Arboreal, leftovers in Parry.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/valewalker-guide',
                    title: 'Valewalker guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Option 50 Scythe, 43 Arboreal, 2 Parry for top weapon skill and the level 50 proc style, noted as thin on defence.',
                },
            ],
        },
        {
            name: 'Arboreal first',
            role: 'Favours haste and procs over style damage.',
            why: "Level 50 is Blackthorn verbatim: 48 Arboreal for Rampant Speed (39 % haste) and 44 Scythe for Damaging Grasp, without Conflagration. Level 24 is ours. Arboreal 21: Haste of Kudzu (25 %, 21), Moss Cover (20), Barkhusk (19), Banestrike (16). Scythe 18: Winter's Scythe. Parry 8.",
            order: "Levels 2-4 buy Arboreal Path 4 (the Forester's only line; 3 Speed of Kudzu is castable only from promotion). The first points after promotion buy Scythe 5 by 6. Then Arboreal catches up, at character level from 10 to 21: 8 Rushing Kudzu by 9, 14 Alacrity of Kudzu, 16 Banestrike, 19 Barkhusk, 20 Moss Cover, 21 Haste of Kudzu. Scythe takes what is left: 8 Arboreal Fire by 13, 10 Stunning Blade by 16, 12 Foxfire by 19, 15 Thorny Shield by 22, 18 Winter's Scythe by 23. Parry 8 at 24. After 24 Arboreal catches up again by 30 and stays at character level to 38: 27 Rotstrike by 28, 31 Pace of Kudzu, 36 Scourgestrike, 38 Celerity of Kudzu. Scythe stays at 18 to level 30, then 21 Grasping Roots by 33, 25 Nature's Shield by 39, 29 Blizzard Blade by 40, 34 Arboreal Shield by 42, 39 Flaming Scythe by 44, 44 Damaging Grasp by 46. Arboreal 43 Barkcase by 48, 46 Witherstrike by 49, 48 Rampant Speed at 50. Parry 10 last, at 50.",
            basis: 'adapted',
            targets: [
                { level: 6, specs: { Scythe: 5, 'Arboreal Path': 4 } },
                { level: 24, specs: { 'Arboreal Path': 21, Scythe: 18, Parry: 8 } },
                { level: 46, specs: { 'Arboreal Path': 38, Scythe: 44, Parry: 8 } },
                { level: 50, specs: { 'Arboreal Path': 48, Scythe: 44, Parry: 10 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/valewalker-guide',
                    title: 'Valewalker guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Option 48 Arboreal, 44 Scythe, 10 Parry, arguing that swing speed matters more than style damage for a proc class.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
