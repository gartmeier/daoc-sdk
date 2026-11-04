import type { ClassBuilds } from './types';

export default {
    className: 'Cleric',
    notes: 'Budget 299 at 24, 1494 at 50 (multiplier 10, ClassCleric.cs:31). Before promotion only Rejuvenation, Enhancement train (Acolyte): the rule raises those a target lists and banks the rest. A 50 Enhancement, 19 Rejuvenation, 7 Smite build also fits, but a second search could not find its source again, so it is left out.',
    builds: [
        {
            name: 'Buffer',
            role: 'Group buffer first and second healer.',
            why: 'The standard Cleric in three sources. Level 50 numbers come from them, including 7 Smite; level 24 follows the level 20 and 30 benchmarks of a Uthgard post. Reaches at 24: Enhancement 21 Regeneration, Enhancement 20 Angelic Coordination, Enhancement 11 Acuity of the Seer; at 50: Enhancement 42 Acuity of the Magi, Enhancement 39 Mercybringer, Rejuvenation 33 Major Refection.',
            order: "Enhancement at character level to 7: Angelic Strength at 5, Angelic Dexterity at 7. Then Rejuvenation to Gift of the Heavens at 11 by level 14, the first instant heal. Then Enhancement again: Acuity of the Seer at 11 by level 16, Archangel's Strength at 19 and Angelic Coordination at 20 by level 23, Regeneration at 21 by level 24. After 24 Enhancement 26 by level 29 and Rejuvenation 14 by level 30, the source's benchmark at 30, and on to Beautified Remedy at 23 by level 35, the group instant. Then Acuity of the Magi at 42 by level 46 and Rejuvenation 33 by level 50. Smite only opens at promotion, and gets 7 at 50.",
            basis: 'adapted',
            targets: [
                { level: 14, specs: { Enhancement: 7, Rejuvenation: 11 } },
                { level: 24, specs: { Enhancement: 21, Rejuvenation: 11 } },
                { level: 35, specs: { Enhancement: 26, Rejuvenation: 23 } },
                { level: 50, specs: { Enhancement: 42, Rejuvenation: 33, Smite: 7 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'RvR: Enhance 42, Rejuvenation 33. PvE: Enhance first with a little Rejuvenation.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=36900',
                    title: 'Cleric spec questions for Necro level duo (Uthgard forum, 2016)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Benchmarks of 8 and 5 at 10, 18 and 8 at 20, 26 and 14 at 30, Enhancement then Rejuvenation; the poster prefers 42, 33, 7 Smite at the end.',
                    checked: "Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: a 2016 thread; 40/36 or 42/33/7, the poster prefers 42, 33, 7 Smite. The level benchmarks are confirmed as the poster's path but were not quoted number by number.",
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=30497',
                    title: 'Leveling duo : cleric and sorcerer, how to spec ? (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'Most common final specs are 40 and 36, or 42 and 33, leaving damage to a caster.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 40/36 or 42/33 most common; the 3/4, 7/7, 11/10, 14/14 Enhancement and Smite steps match a post in this result set.',
                },
            ],
        },
        {
            name: 'Healer',
            role: 'Main group healer, with fewer buffs.',
            why: "A Phoenix post seen only in a search summary pairs two Clerics in a full group, one of them at these numbers; 40 and 36 on Uthgard is the same idea with less Rejuvenation. On this server Rejuvenation 19 gets Greater Revival, a 263 heal, against 197 at 14 and 145 at 11. Level 24 is fitted here. Reaches at 24: Rejuvenation 19 Greater Revival, Rejuvenation 15 Heaven's Commendation, Rejuvenation 15 Raise Fallen; at 50: Rejuvenation 41 Greater Refection, Rejuvenation 40 Resurrection, Enhancement 34 Holy Guard.",
            order: "Enhancement at character level to 7: Angelic Strength at 5, Angelic Dexterity at 7. Then Rejuvenation: Greater Recuperation at 10 by level 13, Gift of the Heavens at 11 by level 14 for the first instant, Greater Renewal at 14 by level 16, Heaven's Commendation at 15 and Raise Fallen at 15 by level 17, Greater Revival at 19 by level 21. Enhancement 14 by level 24 with the rest. After 24 Rejuvenation: Greater Resuscitation at 25 by level 29, Greater Reviction at 32 by level 36, Greater Refection at 41 by level 43. Then Enhancement 35 by level 50, and Smite 3 at 50.",
            basis: 'adapted',
            targets: [
                { level: 14, specs: { Enhancement: 7, Rejuvenation: 11 } },
                { level: 24, specs: { Rejuvenation: 19, Enhancement: 14 } },
                { level: 50, specs: { Rejuvenation: 41, Enhancement: 35, Smite: 3 } },
            ],
            sources: [
                {
                    url: 'https://forum.playphoenix.online/realm/albion/13959-cleric-spec',
                    title: 'Cleric spec... (Phoenix forum)',
                    era: 'Phoenix, later than 1.65; excerpt',
                    says: 'A move from 42 and 33 to 40 and 35 Enhancement and Rejuvenation. The 40/35 with 35/41 pairing could not be tied to this thread.',
                    checked: 'Domain parked: WebFetch shows a for-sale page. Search lists the thread, but its excerpt shows only a move from 42/33 to 40/35. The 40/35 with 35/41 pairing appeared once in a search summary that did not list this URL (probably Most desired Cleric spec(s), 01DNFQDHZRND9YGEAXFFD56VN2), and another Phoenix post says almost no group runs two Clerics. Not confirmed here.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=30497',
                    title: 'Leveling duo : cleric and sorcerer, how to spec ? (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'Most common final specs are 40 and 36, or 42 and 33, leaving damage to a caster.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 40/36 or 42/33 most common; the 3/4, 7/7, 11/10, 14/14 Enhancement and Smite steps match a post in this result set.',
                },
            ],
        },
        {
            name: 'Smite',
            role: 'Damage caster who still heals and buffs, for small groups and battlegrounds.',
            why: 'A real if minority build: the poster reports it working in PvE and battlegrounds and uses every point here, while others call it weak for a healer slot. Level 24 extends the progression in the source. Reaches at 24: Smite 18 Hammer of Justice, Smite 16 Greater Holy Rage, Smite 15 Heavenly Mirage; at 50: Smite 44 Theophany, Smite 43 Greater Holy Fury, Rejuvenation 23 Beautified Remedy.',
            order: "Acolyte levels: Enhancement to 4. Smite opens at promotion, and the source's stops set the pace from there: Smite 7 by level 9, Enhancement 7 by level 10, Smite 10 by level 13, Enhancement 11 by level 15 for Acuity of the Seer at 11, Enhancement 14 by level 18, Smite 14 by level 20. Then Smite alone: Heavenly Mirage at 15 by level 21, Greater Holy Rage at 16 by level 22, Repulse Evil at 17 and Hammer of Justice at 18 by level 23. Rejuvenation 6 by level 24 for Cure Poison at 6. After 24 Smite, Theophany at 44 by level 45, then Rejuvenation 23 by level 49 and Enhancement 21 by level 50.",
            basis: 'adapted',
            targets: [
                { level: 10, specs: { Smite: 7, Enhancement: 7 } },
                { level: 15, specs: { Smite: 10, Enhancement: 11 } },
                { level: 24, specs: { Enhancement: 14, Smite: 18, Rejuvenation: 6 } },
                { level: 50, specs: { Smite: 44, Rejuvenation: 23, Enhancement: 21 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=30809',
                    title: 'Smite Cleric? (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: '44 Smite, 23 Rejuvenation, 21 Enhancement, fun in PvE and good in battlegrounds, doubtful in open RvR.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: 44 smite, 23 rejuv, 21 enhance, works in PvE and battlegrounds, weak in group RvR.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=30497',
                    title: 'Leveling duo : cleric and sorcerer, how to spec ? (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'Sample progression of 3 and 4 at 5, 7 and 7 at 10, 11 and 10 at 15, 14 and 14 at 20 in Enhancement and Smite; attribution to this thread is from a search result set.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 40/36 or 42/33 most common; the 3/4, 7/7, 11/10, 14/14 Enhancement and Smite steps match a post in this result set.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
