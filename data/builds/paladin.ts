import type { ClassBuilds } from './types';

export default {
    className: 'Paladin',
    notes: 'Budget 584 at 24, 2979 at 50 (multiplier 20, ClassPaladin.cs:15). Free levels: Slash, Chants (ClassPaladin.cs:9). Before promotion only Crush, Slash, Thrust train (Fighter): the rule raises those a target lists and banks the rest. Opens later: Two Handed at 5, Parry at 15. A two-handed weapon reads the 1H line of its damage type for its floor (AttackComponent.cs:1182-1195). Uthgard levels on Crush and respecs to Slash at 40; not used here.',
    builds: [
        {
            name: 'Chants and sword',
            role: 'Group tank who carries endurance, armour and heal chants while guarding.',
            why: "The PvE build from Uthgard, with Chants first. Slash and Chants both have free levels here. The source asks to stay on autotrain until 20 and 40; on this server the free points come regardless, so that limit is dropped. Level 24 is fitted here. Reaches at 24: Chants 24 Aura of Indestructability, Chants 23 Crusader's Defense, Chants 22 Chant of Persistence; at 50: Chants 48 Crusader's Mantle, Chants 46 Greater Battle Zeal, Shields 42 Slam.",
            order: "Fighter levels: Slash to 4. Chants comes with promotion at 3, and from level 7 stays at character level to 48: Refreshment at 8, Crusader's Refreshment at 20, Battle Fury at 21, Chant of Persistence at 22, Aura of Indestructability at 24, Crusader's Mantle at 48. Slash takes what is left, Slash 14 by level 15, Riposte at 18 by level 18. Then Shields: Engage at 7 by level 20, Guard III at 15 by level 23. Parry opens at 15 and gets 8 at 24. After 24 Shields again, Slam at 42 by level 43, with Slash waiting at 18 until then. Then Back Slash at 39 by level 49, and Parry 23 by level 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Chants: 24, Slash: 18, Shields: 15, Parry: 8 } },
                { level: 50, specs: { Chants: 48, Shields: 42, Slash: 39, Parry: 23 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=39049',
                    title: 'PvE Paladin (Uthgard forum, 2017)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: '48 Chants, 42 Shield, 39 Slash, rest Parry, or 50 Shield, 43 Chants, 37 Slash, rest Parry; notes it lacks a snare for peeling.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: January 2017, Saracen; 48 chants, 42 shield, 39 slash, rest parry, or 50 shield, 43 chants, 37 slash; autotrain chants to 20 and slash to 40; no snare, so peeling is hard; a poster suggests 42 shield, 44 thrust instead.',
                },
            ],
        },
        {
            name: 'Two-Handed hybrid',
            role: 'Group hybrid who protects allies with the shield and swaps to a big weapon for damage.',
            why: "The hybrid for group RvR in the source, and the exact numbers of one level 50 Paladin there. The damage floor of a slash two-hander reads Slash. Level 24 is fitted here. Reaches at 24: Two Handed 21 Bone Splitter, Chants 20 Crusader's Refreshment, Slash 15 Opal Slash; at 50: Chants 43 Aura of Salvation, Two Handed 39 Doubler, Shields 42 Slam.",
            order: "Fighter levels: Slash to 4. Two Handed opens at promotion at 3, and from level 7 stays at character level to 21: Fury at 18, Bone Splitter at 21. Chants takes what is left first, Refreshment at 8 by level 10, Chants 10 by level 12. Then Slash 10 by level 15, because Slash is the damage floor of a slash two-hander and 4 would leave it far under the weapon. Chants again: Crusader's Refreshment at 20 by level 22. Then Shields: Engage at 7 and Guard II at 10 by level 23. Slash 15 by level 24, Parry 4 at 24. After 24 Chants, at character level from 28 to Aura of Salvation at 43 by level 43. Shields takes what is left: Slam at 42 by level 44. Two Handed waits at 21 and Slash at 15 until then: Doubler at 39 by level 48, Slash 31 by level 50.",
            basis: 'adapted',
            targets: [
                { level: 15, specs: { 'Two Handed': 15, Chants: 10, Slash: 10 } },
                { level: 24, specs: { 'Two Handed': 21, Chants: 20, Shields: 10, Slash: 15, Parry: 4 } },
                { level: 50, specs: { Chants: 43, Shields: 42, 'Two Handed': 39, Slash: 31, Parry: 4 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=46177',
                    title: 'Paladin 1h spec (Uthgard forum, 2018)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'A level 50 at 43 Chants, 42 Shield, 39 Two-Handed, 31 Slash, 4 Parry; the common group RvR shape is about 39, 42, 21 and up, 42 and up, 1 and up.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: a 2018 post of a level 50 at 43 chants, 42 shield, 39 two-handed, 31 slash, 4 parry. The group RvR shape was not quoted.',
                },
            ],
        },
        {
            name: 'Thrust and chants',
            role: 'Group tank on a thrust weapon, with a detaunt style.',
            why: 'A named RvR build. Thrust has no free levels on a Paladin, Slash does, so this costs 77 more than the same plan on Slash. Level 24 is fitted here. Reaches at 24: Thrust 21 Lunge, Thrust 18 Tranquillize, Chants 21 Battle Fury; at 50: Chants 46 Greater Battle Zeal, Thrust 44 Wyvernfang, Shields 42 Slam.',
            order: 'Fighter levels: Thrust to 4. Chants comes with promotion at 3, and from level 7 stays at character level to 21. Thrust takes what is left, Thrust 14 by level 15, and catches up at 20: Tranquillize at 18 by level 19, Lunge at 21 by level 21, Battle Fury at 21 by level 21. Shields stays at 1 until then: Engage at 7 by level 22, Guard III at 15 by level 24. Parry opens at 15 and gets 5 at 24. After 24 Shields, at character level from 30 to Slam at 42 by level 42. Thrust takes what is left, Thrust 34 by level 40, Wyvernfang at 44 by level 44. Chants waits at 21 until then: Greater Battle Zeal at 46 by level 50. Parry 12 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Chants: 21, Thrust: 21, Shields: 15, Parry: 5 } },
                { level: 50, specs: { Shields: 42, Thrust: 44, Chants: 46, Parry: 12 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Chants 46, Thrust 44, Shield 42, rest Parry for RvR; in PvE a weapon near character level with Shield and Chants.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=39049',
                    title: 'PvE Paladin (Uthgard forum, 2017)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'A reply prefers 44 Thrust and 42 Shield for group RvR.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: January 2017, Saracen; 48 chants, 42 shield, 39 slash, rest parry, or 50 shield, 43 chants, 37 slash; autotrain chants to 20 and slash to 40; no snare, so peeling is hard; a poster suggests 42 shield, 44 thrust instead.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
