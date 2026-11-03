import type { ClassBuilds } from './types';

export default {
    className: 'Skald',
    notes: 'Multiplier 15 (ClassSkald.cs:32), no autotrain: 437 at 24, 2223 at 50. Battlesongs is spec-only. Damage adds fall at Battlesongs 19 (Chant of the Battle), then 25, 35 and Battlesongs 46 (Chant of Blood); a forum claim that 43 gives the first red add does not match these tables. Hammer 15 (Provoke) is the cheap anytime style the guides name. Blackthorn also lists 50 Battlesongs, 43 Hammer, 1 Parry; Uthgard forum lists 46, 39, 26 Parry for solo. Role: support.',
    builds: [
        {
            name: 'Battlesongs first',
            role: 'Group support: songs, shouts and snares first, melee second.',
            why: 'Fits this budget to the point: 2223 of 2223. Battlesongs 50 (Battle Roar) is the last shout and last regen. Uthgard levels this way: Battlesongs at level, rest in Hammer.',
            order: 'Levels 2-4 buy Hammer 4 (Crushing Blow): a Viking has no Battlesongs. Battlesongs comes at 5, is at 3 there and at level from 8: Battlesongs 14 (Chant of the Charge) at 14, Battlesongs 19 (Chant of the Battle) at 19, Battlesongs 21 (Crippling Shout) at 21, Battlesongs 23 (Harmonic Song of Travel) at 23. Hammer takes the rest: Hammer 6 (Placate) at 11, Hammer 12 (Frost Hammer) at 19, Hammer 15 (Provoke) at 23, Hammer 16 at 24, with Parry 2 at 24. After 24 Battlesongs stays at level, Battlesongs 46 (Chant of Blood) at 46, Battlesongs 50 (Battle Roar) at 50. Hammer follows, Hammer 25 (Crumble) at 37, Hammer 39 (Lambast) at 48. Parry stays at 2 until 47, Parry 18 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Battlesongs: 24, Hammer: 16, Parry: 2 } },
                { level: 50, specs: { Battlesongs: 50, Hammer: 39, Parry: 18 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/skald-guide',
                    title: 'Blackthorn wiki: skald guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 Battlesongs, 39 Hammer, 18 Parry; better for solo than the 1 Parry version.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/skald-specs-01D18G36FG0PBCZAHE61C5EY9B',
                    title: 'Skald Specs',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Names 46/44/17 and 50/39/18 as the two common level 50 specs.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Levelling: Battlesongs at level, rest in Hammer.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Even songs and Hammer',
            role: 'Group support with clearly better melee damage.',
            why: 'The other common spec: Battlesongs 46 (Chant of Blood) is the top damage add, and 44 Hammer buys Hammer 44 (Sledgehammer). A Uthgard levelling path gives 15 Hammer, 18 Battlesongs at level 20, which this budget affords (289 of 303) and which leads to this level 24 target.',
            order: "Levels 2-4 buy Hammer 4 (Crushing Blow): a Viking has no Battlesongs. Battlesongs comes at 5, is at 3 there and at level from 8 up to Battlesongs 18 (Warshriek) at 18, where it stays through 20. Hammer takes the rest, and level 20 is the forum path's stop: Hammer 15 (Provoke) at 20 with Battlesongs 18. Then Battlesongs 22 (Compel Resignation) at 23, Hammer 18 (Demolish) at 24, Parry 5 at 24. After 24 the two take turns, and the stop at 41 is ours: Battlesongs at level from 28 to Battlesongs 35 (Chant of the War) at 35, Hammer 34 (Thor's Answer) at 41, Battlesongs 46 (Chant of Blood) at 46, Hammer 44 (Sledgehammer) at 49. Parry stays at 5 until 48, Parry 17 at 50.",
            basis: 'adapted',
            targets: [
                { level: 20, specs: { Battlesongs: 18, Hammer: 15 } },
                { level: 24, specs: { Battlesongs: 22, Hammer: 18, Parry: 5 } },
                { level: 41, specs: { Battlesongs: 35, Hammer: 34, Parry: 5 } },
                { level: 50, specs: { Battlesongs: 46, Hammer: 44, Parry: 17 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'RvR: 46 Battlesongs, 44 Hammer, 17 Parry.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/skald-guide',
                    title: 'Blackthorn wiki: skald guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '46 Battlesongs, 44 Hammer, 17 Parry listed.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=61&t=32090',
                    title: 'Starting a Skald',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary: levelling path with 15 Hammer, 18 Battlesongs at level 20, and holding Battlesongs at 18 or below for levels 12-19.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Hammer first',
            role: 'Melee-first Skald who still carries songs.',
            why: 'Blackthorn lists it without comment and names weapon versus shout damage as the key choice. Battlesongs 43 (War Howl) is the point where it stops; top add and last shouts are lost. At 24 it still has Battlesongs 14 (Chant of the Charge).',
            order: "Hammer at level from 2, since a Viking can train it: Hammer 21 (Revenge) at 21. Battlesongs comes at 5 and takes the rest: Battlesongs 5 (Chant of the Brawl) at 9, Battlesongs 14 (Chant of the Charge) at 21, Battlesongs 15 (Disabling Shout) at 23, Battlesongs 16 at 24, with Parry 2 at 24. After 24 Hammer stays at level to Hammer 50 (Mjolnir's Fury) at 50, and Battlesongs follows, Battlesongs 35 (Chant of the War) at 45, Battlesongs 43 (War Howl) at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Hammer: 24, Battlesongs: 16, Parry: 2 } },
                { level: 50, specs: { Hammer: 50, Battlesongs: 43, Parry: 2 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/skald-guide',
                    title: 'Blackthorn wiki: skald guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 weapon, 43 Battlesongs, 2 Parry, listed without its own description; the page names weapon versus shout damage as the key choice.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
