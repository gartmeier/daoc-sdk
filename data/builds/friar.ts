import type { ClassBuilds } from './types';

export default {
    className: 'Friar',
    notes: 'Budget 437 at 24, 2223 at 50 (multiplier 15, ClassFriar.cs:14). Before promotion only Rejuvenation, Enhancement train (Acolyte): the rule raises those a target lists and banks the rest. 44 Staff, 38 Enhancement, 25 Rejuvenation, 18 Parry uses every point and reaches Stunning Wrath; inside forum ranges, no single source for it.',
    builds: [
        {
            name: 'Group support',
            role: 'Group buffer and off-healer who fights with a staff.',
            why: 'The group RvR build in the guide with the rest in Parry. Rejuvenation 15 gets the rez early. Level 24 is fitted here. Reaches at 24: Enhancement 18 Agility, Enhancement 15 Alacrity of the Angel, Rejuvenation 15 Raise Fallen; at 50: Enhancement 45 Fluidity, Enhancement 44 Blessing of Dissipation, Rejuvenation 34 Holy Encouragement.',
            order: "Enhancement at character level to 18: Speed of the Angel at 5, Haste of the Angel at 10, Alacrity of the Angel at 15, Agility at 18. What is left goes to Rejuvenation first, Major Restoration at 5 by level 9. Staff, open from promotion, comes next so that a fighter's weapon isn't left at 1: Defender's Fury at 8 by level 15. After Agility Rejuvenation again: Cure Poison at 6 by level 16, Cure Disease at 7 by level 17, Raise Fallen at 15 by level 21. Double Strike at 15 by level 24, Parry 7 by level 24. After 24 Enhancement, at character level again from 33 to Fluidity at 45 by level 45. Holy Encouragement at 34 by level 46. Staff waits at 15 until then: Staff 29 by level 49. Parry 17 by level 50.",
            basis: 'adapted',
            targets: [
                { level: 15, specs: { Enhancement: 15, Rejuvenation: 5, Staff: 8 } },
                { level: 24, specs: { Enhancement: 18, Rejuvenation: 15, Staff: 15, Parry: 7 } },
                { level: 50, specs: { Enhancement: 45, Rejuvenation: 34, Staff: 29, Parry: 17 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Group RvR: Enhancement 45, Staff 29, Rejuvenation 34, rest Parry.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Solo staff',
            role: 'Solo or small-group melee with self buffs and basic heals.',
            why: "The solo build in the guide, and its PvE advice of Staff near character level with the rest in Enhancement. Level 24 is fitted here. Reaches at 24: Staff 21 Counter Evade, Staff 18 Friar's Friend, Enhancement 19 Annoy; at 50: Enhancement 45 Fluidity, Staff 39 Friar's Fury, Rejuvenation 25 Major Reviction.",
            order: "Acolyte levels: Enhancement to 4. Staff opens at promotion, and from level 8 it stays at character level to 21: Double Strike at 15, Friar's Friend at 18, Counter Evade at 21. Enhancement takes what is left, Enhancement 9 by level 15, then everything: Annoy at 19 by level 24. Rejuvenation 5 at 24. After 24 Staff again, as the source advises for PvE: at character level from 29 to Friar's Fury at 39 by level 39. Enhancement takes what is left until then and everything after: Speed of the Archangel at 23 by level 35, Fluidity at 45 by level 47. Then Rejuvenation 25 by level 50 and Parry 12 by level 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Staff: 21, Enhancement: 19, Rejuvenation: 5 } },
                { level: 50, specs: { Staff: 39, Enhancement: 45, Rejuvenation: 25, Parry: 12 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Solo RvR: Enhancement 45, Staff 39, Rejuvenation 25, rest Parry. PvE: Staff near character level, rest in Enhancement.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Haste buffer',
            role: 'Staff fighter who carries the best haste for tough fights, with little healing.',
            why: "A named balanced build from a Uthgard poster who ran it for the level 47 haste. Level 24 is fitted here. Reaches at 24: Enhancement 23 Speed of the Archangel, Enhancement 22 Saint's Stamina, Staff 15 Double Strike; at 50: Enhancement 47 Alacrity of the Heavenly Host, Staff 39 Friar's Fury, Rejuvenation 18 Major Resuscitation.",
            order: "Enhancement at character level from the first point to 23: Speed of the Angel at 5, Alacrity of the Angel at 15, Speed of the Archangel at 23 is the best haste at this level. Staff, open from promotion, takes what is left: Staff 9 by level 15, Double Strike at 15 by level 23. Rejuvenation 5 by level 24 and Parry 7 by level 24. After 24 Enhancement, at character level again from 26 to Alacrity of the Heavenly Host at 47 by level 47. Staff goes on behind it: Staff 26 by level 40, Friar's Fury at 39 by level 48. Then Rejuvenation 18 by level 49 and Parry 16 by level 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Enhancement: 23, Staff: 15, Rejuvenation: 5, Parry: 7 } },
                { level: 50, specs: { Enhancement: 47, Staff: 39, Rejuvenation: 18, Parry: 16 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=19734',
                    title: 'Friar spec (Uthgard forum, 2010)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: '39 Staff, 47 Enhancement, 18 Rejuvenation, 16 Parry, the haste at 47 being the reason.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: 39 Staff, 47 Enhancement, 18 Rejuvenation, 16 Parry, for the level 47 haste.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
