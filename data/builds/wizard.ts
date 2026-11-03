import type { ClassBuilds } from './types';

export default {
    className: 'Wizard',
    notes: 'Budget 299 at 24, 1494 at 50 (multiplier 10, ClassWizard.cs:31). Before promotion only Earth Magic, Cold Magic train (Elementalist): the rule raises those a target lists and banks the rest. Fire and Cold have baseline nukes, the Earth baseline is buffs. An off-line nuke stays castable but its lower damage bound falls with spec in that line (SpellHandler.cs:2748-2763, 2813). Sources call Earth weak; spells.json gives it the biggest level 24 single hit. Not tested live.',
    builds: [
        {
            name: 'Fire',
            role: 'Direct damage nuker with bolts and area spells, also for solo levelling.',
            why: 'Sources recommend Fire for solo and low levels. At 24 every point fits exactly in one line. Level 50 numbers come from the source; level 24 is the full line. Reaches at 24: Fire Magic 24 Concussive Blast, Fire Magic 23 Lesser Conflagration, Fire Magic 19 Flame Streak; at 50: Fire Magic 50 Flame Spear, Fire Magic 47 Major Conflagration, Earth Magic 18 Earth Eddies.',
            order: 'Fire opens at promotion, so the Elementalist levels bank their 9 points and promotion buys Fire 5 at once. Then every point, at character level to 50: Minor Flame Streak at 14, Minor Conflagration at 17, Flame Streak at 19, Lesser Conflagration at 23, Concussive Blast at 24. At 25 Minor Incendiary Lance is one step away, out of reach in Thidranki. Only the half levels are left over, from 40.5: Earth Eddies at 18 by level 48, Earth 19 by level 49, Burst of Steam (Minor) at 7 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Fire Magic': 24 } },
                { level: 50, specs: { 'Fire Magic': 50, 'Earth Magic': 19, 'Cold Magic': 7 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=112&t=41544',
                    title: 'Wizard Specs in Uthgard 1.65 (Uthgard forum, 2017)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Fire spec at 50 Fire, 19 Earth, 7 Ice; a moderator reply says to go Ice or Fire at this patch.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: February 2017 post listing the four builds; a moderator says go Ice or Fire, Earth is not good at this patch.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Ice for group levelling, Fire for solo; Fire the only PvP line.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Ice',
            role: 'Group nuker with single-target hits that debuff cold resist, and a close-range area nuke.',
            why: 'The group levelling line in the sources. On this server Steaming Blast at 20 is a point-blank area nuke (range 0, radius 300), so it needs the caster in the pack. Level 50 numbers come from the source with 4 Fire from the rest; level 24 is the full line. Reaches at 24: Cold Magic 24 Entangling Haze (Minor), Cold Magic 22 Sweltering Cloud, Cold Magic 21 Searing Gust; at 50: Cold Magic 50 Entangling Haze (Potent), Cold Magic 48 Steaming Wind (Major), Earth Magic 20 Molten Puddle.',
            order: 'An Elementalist can train Cold from the start, and its spec spells switch on at promotion. Every point here, at character level to 50: Searing Wind at 12, Steaming Blast (Minor) at 15, Steaming Blast at 20, Searing Gust at 21, Sweltering Cloud at 22, Entangling Haze (Minor) at 24. Only the half levels are left over, from 40.5: Molten Puddle at 20 by level 50, and Fire 4 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Cold Magic': 24 } },
                { level: 50, specs: { 'Cold Magic': 50, 'Earth Magic': 20, 'Fire Magic': 4 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=112&t=41544',
                    title: 'Wizard Specs in Uthgard 1.65 (Uthgard forum, 2017)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Ice spec at 50 Ice, 20 Earth.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: February 2017 post listing the four builds; a moderator says go Ice or Fire, Earth is not good at this patch.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Ice for group levelling.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Earth',
            role: 'Bolt and damage-over-time caster who also snares groups.',
            why: "The source calls Earth weak at 1.65, so treat this as the riskier pick. The data here does give it the biggest single hit at level 24: Lava Force (Enhanced), a 162 bolt with a 20 second recast. Level 50 numbers come from the source; level 24 is the full line. Reaches at 24: Earth Magic 24 Lava Force (Enhanced), Earth Magic 23 Greater Molten Blanket, Earth Magic 20 Molten Puddle; at 50: Earth Magic 48 Greater Sheet of Magma, Earth Magic 46 Lava's Fury, Fire Magic 23 Lesser Conflagration.",
            order: 'An Elementalist can train Earth from the start, and its spec spells switch on at promotion. Every point here, at character level to 48: Lava Strike at 7, Lava Field at 11, Trembling Earth at 13, Lava Force at 17, Earth Eddies at 18, Molten Puddle at 20, Greater Molten Blanket at 23, Lava Force (Enhanced) at 24, Greater Sheet of Magma at 48. From 40.5 the half levels are more than it can use, so they go to Fire, Fire 14 by level 45. After Earth stops everything does: Lesser Conflagration at 23 by level 50, and Cold 7 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Earth Magic': 24 } },
                { level: 50, specs: { 'Earth Magic': 48, 'Fire Magic': 23, 'Cold Magic': 7 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=112&t=41544',
                    title: 'Wizard Specs in Uthgard 1.65 (Uthgard forum, 2017)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Earth spec at 48 Earth, 23 Fire, 7 Ice; replies advise against it at this patch and for levelling.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: February 2017 post listing the four builds; a moderator says go Ice or Fire, Earth is not good at this patch.',
                },
            ],
        },
        {
            name: 'Tri-bolt',
            role: 'Burst caster with three separate bolts and earth tools.',
            why: 'Named in the same thread as the other three. Bolts in Earth, Fire and the Fire baseline run on separate lines. Level 50 numbers come from the source; 25 points stay free there. Level 24 is fitted here. Reaches at 24: Earth Magic 17 Lava Force, Earth Magic 13 Trembling Earth, Fire Magic 14 Minor Flame Streak; at 50: Earth Magic 38 Lava Streak (Enhanced), Fire Magic 33 Incendiary Lance, Fire Magic 37 Greater Conflagration.',
            order: 'Earth at character level from the first point to 17: Trembling Earth at 13, Lava Force at 17. Then Cold: Searing Wind (Lesser) at 6 and Burst of Steam (Minor) at 7 by level 19. Fire, open from promotion, takes the rest: Minor Flame Streak at 14 by level 24, Fire 15 by level 24. Flaming Rocks (Minor) arrives with character level at 22. After 24 they take turns to stay in step: Molten Pool at 28 by level 33, Minor Incendiary Lance at 25 by level 39, Fire 27 by level 40, Lava Streak (Enhanced) at 38 by level 46, Greater Conflagration at 37 by level 50. 25 points stay free.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Earth Magic': 17, 'Cold Magic': 7, 'Fire Magic': 15 } },
                { level: 40, specs: { 'Earth Magic': 28, 'Fire Magic': 27, 'Cold Magic': 7 } },
                { level: 50, specs: { 'Earth Magic': 38, 'Fire Magic': 37, 'Cold Magic': 7 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=112&t=41544',
                    title: 'Wizard Specs in Uthgard 1.65 (Uthgard forum, 2017)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Tri-Bolt at 38 Earth, 37 Fire, 7 Ice: three bolts plus earth tools.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: February 2017 post listing the four builds; a moderator says go Ice or Fire, Earth is not good at this patch.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
