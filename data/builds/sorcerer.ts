import type { ClassBuilds } from './types';

export default {
    className: 'Sorcerer',
    notes: 'Budget 299 at 24, 1494 at 50 (multiplier 10, ClassSorcerer.cs:31). Before promotion only Matter Magic, Body Magic train (Mage): the rule raises those a target lists and banks the rest. Charm spells in the data: Compel Will 12, Control Will 20, Wrest Will 32. Whether Mind limits pet level beyond the spell is disputed and not checked here.',
    builds: [
        {
            name: 'Balanced body and mind',
            role: 'Group crowd control and nuker, with a bit of everything.',
            why: 'The standard Sorcerer in two sources. Level 50 numbers come from them with 4 Matter from the rest. Level 24 is fitted here. Reaches at 24: Body Magic 16 Lesser Mind Scream, Body Magic 15 Imbalance, Mind Magic 14 Blanket of Senility; at 50: Body Magic 39 Greater Body Lock, Body Magic 35 Mind Shriek, Mind Magic 34 Veil of Senility.',
            order: 'Body at character level from the first point to 8, for Lesser Mind Blast at 8. Mind opens at promotion and then takes every point: Fog of Senility at 4 by level 9, Coerce Will at 7 by level 11, Compel Will at 12 by level 15, Blanket of Senility at 14 by level 17, Perception of Power at 15 by level 18, Mind 16 by level 18. Then Body again: Mind Blast at 12 by level 21, Imbalance at 15 and Lesser Mind Scream at 16 by level 23, Body 17 by level 24. Matter 4 at 24. After 24 they take turns to stay in step: Mind Scream at 22 by level 28, Lesser Mind Shriek at 28 by level 33, Cloud of Senility at 24 by level 38, Mind 28 by level 40, Greater Body Lock at 39 by level 46, Mind 37 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 15, specs: { 'Body Magic': 8, 'Mind Magic': 12 } },
                { level: 24, specs: { 'Mind Magic': 16, 'Body Magic': 17, 'Matter Magic': 4 } },
                { level: 40, specs: { 'Body Magic': 28, 'Mind Magic': 28, 'Matter Magic': 4 } },
                { level: 50, specs: { 'Body Magic': 39, 'Mind Magic': 37, 'Matter Magic': 4 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'RvR: Body 39, Mind 37.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=37922',
                    title: 'Sorc Spec for RvR (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Split spec of 39 and 37 called the standard at lower realm ranks.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: 39 Body, 37 Mind for lower ranks; 44 Mind, 31 Body at higher ranks.',
                },
            ],
        },
        {
            name: 'Mind crowd control',
            role: 'Dedicated crowd control for large fights, with the strongest area mez.',
            why: 'The higher realm rank standard on Uthgard, for the Mind 44 mez. A level 24 Sorcerer can reach Cloud of Senility only with every point in Mind, which also matches the advice to stay full Mind if grouping all the way up. Level 50 numbers come from the source with 4 Matter from the rest. Reaches at 24: Mind Magic 24 Cloud of Senility, Mind Magic 20 Control Will, Mind Magic 15 Perception of Power; at 50: Mind Magic 44 Shroud of Senility, Mind Magic 43 Banish Hope, Body Magic 30 Body Lock.',
            order: 'Mind opens at promotion, so the Mage levels bank their 9 points and promotion buys Mind 5 at once: Fog of Senility at 4, Comprehension of Power at 5. Then every point, at character level to 44: Blanket of Senility at 14, Perception of Power at 15, Control Will at 20, Cloud of Senility at 24, Shroud of Senility at 44. From 40.5 the half levels are more than it can use, so they go to Body, Body 12 by level 44. After Mind stops everything does: Body Lock at 30 by level 50, Body 31 by level 50, and Matter 4 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Mind Magic': 24 } },
                { level: 50, specs: { 'Mind Magic': 44, 'Body Magic': 31, 'Matter Magic': 4 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=37922',
                    title: 'Sorc Spec for RvR (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: '44 Mind, 31 Body for the top area mez, used at higher ranks once Body is enough for damage.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: 39 Body, 37 Mind for lower ranks; 44 Mind, 31 Body at higher ranks.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=32188',
                    title: 'mind/body or mind/matter as a leveling sorc? (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'Stay full Mind when grouping all the way up.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: stay full Mind when grouping all the way up.',
                },
            ],
        },
        {
            name: 'Body nuker',
            role: 'Nuker with direct damage and root, with only a lower area mez.',
            why: "The guide's higher Body option, trading mez strength for Body direct damage. Level 50 numbers come from it with the rest in Matter. Level 24 is fitted here. Reaches at 24: Body Magic 22 Mind Scream, Body Magic 20 Lesser Body Lock, Mind Magic 7 Coerce Will; at 50: Body Magic 45 Mind Flay, Mind Magic 24 Cloud of Senility, Matter Magic 17 Lesser Constricting Jolt.",
            order: 'Body at character level from the first point to 22: Lesser Mind Blast at 8, Mind Blast at 12, Lesser Mind Scream at 16, Lesser Body Lock at 20, Greater Imbalance at 21, Mind Scream at 22. Mind, open from promotion, has to wait for that: Comprehension of Power at 5 by level 23, Coerce Will at 7 by level 24, Mind 8 by level 24. Matter 4 at 24. After 24 Body again, two under character level at first, and at it from 43 to Mind Flay at 45 by level 45. Then Mind, Cloud of Senility at 24 by level 48, and Matter, Lesser Constricting Jolt at 17 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Body Magic': 22, 'Mind Magic': 8, 'Matter Magic': 4 } },
                { level: 50, specs: { 'Body Magic': 45, 'Mind Magic': 24, 'Matter Magic': 17 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Body 45 and up with Mind 24 and up: higher Body nuke, lower area mez.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Mind and matter charmer',
            role: 'Solo levelling with a charmed pet and damage over time.',
            why: "The Uthgard levelling guide: Mind at charm and power-regen levels, Matter otherwise. The guide stops at 40 and respecs to Body and Mind; level 50 here stays on the same lines, with Mind at the top charm, so those numbers are ours. Level 24 applies the guide's stops to the 299 points. Reaches at 24: Mind Magic 15 Perception of Power, Mind Magic 12 Compel Will, Matter Magic 17 Lesser Constricting Jolt; at 50: Mind Magic 32 Wrest Will, Matter Magic 40 Constricting Force, Body Magic 16 Lesser Mind Scream.",
            order: "The Mage levels bank their 9 points, and promotion buys Mind 5 at once for Comprehension of Power at 5. Then Matter: Matter 8 by level 10, Lesser Constricting Jolt at 17 by level 18. Mind at the source's charm and power stops: Coerce Will at 7 by level 19, Compel Will at 12 by level 21, Perception of Power at 15 by level 23. Matter 18 by level 24, and Body 4 with the rest. After 24 the source's next two stops: Constricting Jolt at 24 by level 29, Control Will at 20 by level 32. Then Wrest Will at 32 by level 41, Constricting Force at 40 by level 49, and Body 16 by level 50.",
            basis: 'derived',
            targets: [
                { level: 5, specs: { 'Mind Magic': 5 } },
                { level: 19, specs: { 'Matter Magic': 17, 'Mind Magic': 7 } },
                { level: 24, specs: { 'Mind Magic': 15, 'Matter Magic': 18, 'Body Magic': 4 } },
                { level: 32, specs: { 'Matter Magic': 24, 'Mind Magic': 20, 'Body Magic': 4 } },
                { level: 50, specs: { 'Mind Magic': 32, 'Matter Magic': 40, 'Body Magic': 16 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=110&t=36619',
                    title: 'Sorc Leveling spec guide (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Stops of Mind 5, Matter 1 at 5; Mind 7, Matter 17 at 19; Mind 15, Matter 24 at 29; Mind 20, Matter 24 at 32; Matter to 40, then a respec to Body and Mind.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: the same stops of Mind and Matter through 32, Matter to 40, then a respec.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'PvE: enough Mind to charm top pets and enough Matter to lower damage-over-time variance; refers to the Mind and Matter guide.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
