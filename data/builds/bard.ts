import type { ClassBuilds } from './types';

export default {
    className: 'Bard',
    notes: "Budget 437 at 24, 2223 at 50 (ClassBard.cs:31, multiplier 15). No autotrain. Starts as Naturalist with only Regrowth and Nurture, so Music and Blades wait for promotion at 5. Baseline mez comes with character level (Paralyzing Melody 10, Facinating Melody 16, Mesmerizing Hymn 21), and baseline heals outclass the spec heals at low Regrowth, so a small Regrowth buys cures and regen chants, not heal size. Blunt is the 1:1 swap for Blades (Side Bash 10 instead of Glowing Blade 10). Blackthorn's 38 Music buys only a Confusing Ballad here: the first AoE instant mez is 37.",
    builds: [
        {
            name: 'Music crowd control',
            role: 'Group mezzer: AoE and instant mez first, with speed and power song kept behind.',
            why: 'Level 50 is the Blackthorn group spec verbatim (disorder.dk has 47/43/16 without Blades). Level 24 is ours. Music 21 reaches Captivate Swarms (AoE mez, 21), Mystifying Cadence (20) and Concussive Scream (18). Nurture 13: Clear Trail speed (13), Rhythm of Earth (12), Rhyme of Earth power song (10). Regrowth 9: Cure Disease (7), Cure Poison (9), Chant of Healing (6). Blades 10: Glowing Blade, side snare. 19 points stay banked for level 25. At 50: Entrancing Harmony (AoE instant mez, 47), Clear Horizon (43).',
            order: 'Levels 2-4 buy Nurture 4 (3 Clear Path, castable only from promotion). From promotion Music to 10 Captivate Audience at 10, then Nurture 10 Rhyme of Earth by 13 and Regrowth 9 (7 Cure Disease, 9 Cure Poison) by 15. Music 16 Captivate Crowd by 18, Nurture 13 Clear Trail by 19, Blades 10 Glowing Blade by 21, Music 21 Captivate Swarms at 24, with 19 points banked. After 24: Music 29 Hypnotic Harmony at 29, Nurture 23 Clear Road by 33, then Music 37 Deluding Harmony by 38, 43 Captivate Legions at 43 and 47 Entrancing Harmony at 47. Nurture takes the spare points on the way: 33 Clear Field by 46, 43 Clear Horizon at 50. Regrowth 13 last, at 50.',
            basis: 'adapted',
            targets: [
                { level: 15, specs: { Music: 10, Nurture: 10, Regrowth: 9 } },
                { level: 19, specs: { Music: 16, Nurture: 13, Regrowth: 9 } },
                { level: 24, specs: { Blades: 10, Music: 21, Nurture: 13, Regrowth: 9 } },
                { level: 33, specs: { Music: 29, Nurture: 23, Regrowth: 9, Blades: 10 } },
                { level: 50, specs: { Music: 47, Nurture: 43, Regrowth: 13, Blades: 10 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/bard-guide',
                    title: 'Bard guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Group option 47 Music, 43 Nurture, 13 Regrowth, 10 Blades: the best AoE and instant AoE mez, top speed at 43 Nurture, Blades 10 for the side snare.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Lists 47 Music, 43 Nurture, 16 Regrowth as a common PvP spec; in PvE keeps Nurture at level with the rest in Regrowth and adds Music later.',
                },
            ],
        },
        {
            name: 'Nurture support',
            role: 'Speed, power and endurance songs plus backup healing, with enough Music for AoE mez.',
            why: "Level 50 is disorder.dk's 43 Nurture, 37 Music, 33 Regrowth verbatim, with the 16 leftover points in Blades 5. The three sourced numbers hit breakpoints here (Clear Horizon 43, Deluding Harmony 37, Major Renascence 33); Blades 5 does not (styles at 4 and 6, and 6 costs 20). Blackthorn's 43/38/27/10 is the close alternative. Level 24 is ours and follows disorder's levelling advice. Nurture 23: Clear Road (23), Rhythm of Nature (22), Rhyme of Nature (21). Regrowth 14: Song of Healing (14), Major Regeneration (11), cures. Music 10: Captivate Audience.",
            order: 'Nurture at character level from level 2 to 13 Clear Trail, with the spare points from level 6 in Regrowth: 9 Cure Poison by 14. Music 10 Captivate Audience by 16. Then Nurture back up to character level by 21: 21 Rhyme of Nature, 22 Rhythm of Nature, 23 Clear Road at 23. Regrowth 14 Song of Healing at 24. After 24: Nurture at character level to 33 Clear Field at 33, Regrowth with the rest to 27 Notes of Health by 37. Then Music: 29 Hypnotic Harmony by 42, 37 Deluding Harmony by 45. Regrowth 33 Major Renascence by 47, Nurture 43 Clear Horizon at 50, Blades 5 last.',
            basis: 'adapted',
            targets: [
                { level: 16, specs: { Nurture: 13, Regrowth: 9, Music: 10 } },
                { level: 24, specs: { Nurture: 23, Regrowth: 14, Music: 10 } },
                { level: 37, specs: { Nurture: 33, Regrowth: 27, Music: 10 } },
                { level: 50, specs: { Music: 37, Regrowth: 33, Nurture: 43, Blades: 5 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Lists 43 Nurture, 37 Music, 33 Regrowth as a common PvP spec. For levelling it keeps Nurture at level and puts the rest in Regrowth, with Music coming later for mez.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/bard-guide',
                    title: 'Bard guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Well-rounded option 43 Nurture, 38 Music, 27 Regrowth, 10 Blades.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
