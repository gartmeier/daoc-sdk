import type { ClassBuilds } from './types';

export default {
    className: 'Theurgist',
    notes: 'Budget 299 at 24, 1494 at 50 (multiplier 10, ClassTheurgist.cs:12). Before promotion only Earth Magic, Cold Magic train (Elementalist): the rule raises those a target lists and banks the rest. Pet duration in the data: ice 25 s, air 20 s, earth 30 s, 60 s from Earth 32. 35 Earth, 25 Ice, 32 Wind from Eden also fits (1480). Air in a source is the key Wind Magic.',
    builds: [
        {
            name: 'Ice and earth',
            role: 'Pet caster who levels on ice pets and snares, then adds earth bladeturn and pets.',
            why: "A poster's tested solo and group route, and its end numbers use every point. Level 24 follows the route: Cold stops at 18, the rest goes to Earth. A pure Cold 24 also fits (299) and is what the guide advises for PvE, but it would have to drop later. Reaches at 24: Cold Magic 18 Summon Aged Ice Spirit, Cold Magic 17 Ice Blast, Cold Magic 16 Field of Snow; at 50: Cold Magic 41 Hibernal Blast, Cold Magic 40 Summon Aged Ice Elemental, Earth Magic 35 Skin of Stone.",
            order: 'Cold at character level from the first point to 18: Summon Ice Spirit at 13, Field of Snow at 16, Ice Blast at 17, Summon Aged Ice Spirit at 18. Then Earth: Skin of Sand at 10 by level 21, Call Earth Elemental at 12 by level 22, Friction at 14 by level 23, Earth 15 by level 24. Wind, open from promotion, gets 3 at 24. After 24 Earth again: Skin of Rock at 26 by level 32 is the pulsing group bladeturn, Call Mighty Earth Elemental at 32 by level 37 lasts 60 seconds, Skin of Stone at 35 by level 40. Cold waits at 18 until then and takes everything after: Hibernal Blast at 41 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Cold Magic': 18, 'Earth Magic': 15, 'Wind Magic': 3 } },
                { level: 50, specs: { 'Earth Magic': 35, 'Cold Magic': 41, 'Wind Magic': 3 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=111&t=41804',
                    title: 'My Ice/Earth Theurgist progression (Uthgard forum, February 2017)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Ice to 18, Earth 19 to 32 with the pulsing bladeturn at 26, Ice 33 to 39, a respec at 40, ending at Ice 41, Earth 35. The route here skips that respec.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: posted February 28 2017. Ice to 18, Earth 19 to 32, Ice 33 to 39, respec at 40, final Ice 41, Earth 35.',
                },
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=1869',
                    title: 'Theurg spec? (Eden forum)',
                    era: 'Eden, later than 1.65; excerpt',
                    says: '41 Ice, 35 Earth, 3 Wind as the second-best pet and snare build, 35 Earth and 41 Ice as solid PvE.',
                    checked: 'WebFetch HTTP 403. Search excerpt 2026-11-03: 41 Ice, 35 Earth, 3 Wind; 45 Wind, 25 Ice, 16 Earth; 35 Earth, 25 Ice, 32 Wind.',
                },
            ],
        },
        {
            name: 'Earth and wind',
            role: 'Group Theurgist: earth pets to interrupt, pulsing bladeturn, and wind nukes and mez.',
            why: 'The most common level 50 Theurgist in two sources. Level 24 is fitted here, on the same idea. Reaches at 24: Earth Magic 20 Call Potent Earth Elemental, Earth Magic 18 Skin of Earth, Wind Magic 12 Call Air Sprite; at 50: Earth Magic 40 Call Supreme Earth Elemental, Earth Magic 35 Skin of Stone, Wind Magic 35 Blasting Tempest.',
            order: 'Earth at character level from the first point to 20: Call Earth Elemental at 12, Friction at 14, Skin of Earth at 18, Call Potent Earth Elemental at 20. Then Wind, open from promotion: Blasting Gale at 11 by level 23, Call Air Sprite at 12 by level 24. Cold 4 at 24. After 24 Earth again: Skin of Rock at 26 by level 30, Call Mighty Earth Elemental at 32 by level 35. Wind waits at 12 until then: Blasting Tempest at 35 by level 46, Wind 36 by level 46. Then Earth once more: Call Supreme Earth Elemental at 40 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Earth Magic': 20, 'Wind Magic': 12, 'Cold Magic': 4 } },
                { level: 35, specs: { 'Earth Magic': 32, 'Wind Magic': 12, 'Cold Magic': 4 } },
                { level: 50, specs: { 'Wind Magic': 36, 'Earth Magic': 40, 'Cold Magic': 4 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'RvR: Earth 40, Air 36.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=18893',
                    title: 'Best Theurgist spec for leveling? (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: '40 Earth, 36 Wind is what most level 50 Theurgists use.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 40 Earth, 36 Wind called the usual level 50 build.',
                },
            ],
        },
        {
            name: 'Wind nuker',
            role: 'Best damage Theurgist, with direct nukes and area mez, poor for group play.',
            why: 'Named the top damage spec by one write-up, which adds that it lacks a group bladeturn. The Eden numbers use every point here. The Wind spec line is the plain direct damage of the class: 102 at 22 against 88 for Cold at 24. Level 24 is fitted here. Reaches at 24: Wind Magic 22 Blasting Storm, Wind Magic 21 Confusing Gust (Major), Wind Magic 20 Call Potent Air Sprite; at 50: Wind Magic 45 Blasting Maelstrom, Cold Magic 25 Summon Elder Ice Spirit, Earth Magic 12 Call Earth Elemental.',
            order: 'Elementalist levels: Cold to 4. Wind opens at promotion at 3, and from level 9 stays one under character level: Blasting Squall at 16 by level 17, Call Potent Air Sprite at 20 by level 21, Confusing Gust (Major) at 21 by level 22, Blasting Storm at 22 by level 23. Cold 8 by level 24 and Earth 4 at 24. After 24 Wind again, two under character level at first, and at it from 43 to Blasting Maelstrom at 45 by level 45. Then Cold, Summon Elder Ice Spirit at 25 by level 49, and Earth 16 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Wind Magic': 22, 'Cold Magic': 8, 'Earth Magic': 4 } },
                { level: 50, specs: { 'Wind Magic': 45, 'Cold Magic': 25, 'Earth Magic': 16 } },
            ],
            sources: [
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=1869',
                    title: 'Theurg spec? (Eden forum)',
                    era: 'Eden, later than 1.65; excerpt',
                    says: 'A poster respecced to 45 Wind, 25 Ice, 16 Earth.',
                    checked: 'WebFetch HTTP 403. Search excerpt 2026-11-03: 41 Ice, 35 Earth, 3 Wind; 45 Wind, 25 Ice, 16 Earth; 35 Earth, 25 Ice, 32 Wind.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=111&t=36641&start=30',
                    title: 'Theurgist spec ideas? (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: '45 Wind, 25 Ice rated the best damage, weak for PvE groups for lack of group bladeturn.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 45 Wind, 25 Ice is the top damage build, little used in group PvE for lack of a group bladeturn.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
