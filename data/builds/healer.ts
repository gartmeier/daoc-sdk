import type { ClassBuilds } from './types';

export default {
    className: 'Healer',
    notes: 'Multiplier 10 (ClassHealer.cs:31): 299 at 24, 1494 at 50. At multiplier 10 the budget at any level to 40 buys exactly one line at level (24 costs 299), so every extra point in a second line comes out of the first. The base lines follow character level whatever you train (Specialization.cs:163): at 24 that means base mez, stun, AF, Str, Con, Dex and small heals for free. Starts as Seer (Mending, Augmentation only). Spec spell lines need the promotion (Specialization.cs:154). Role: healer.',
    builds: [
        {
            name: 'Mending first',
            role: 'Main group healer with the biggest heals.',
            why: "Maximum healing. Mending 41 (Greater Reconstruction) and Mending 42 (Major Emendation) are both reached. Blackthorn warns it gives up resists and uses more power. At 24, Mending 23 (Greater Reparation) with Augmentation 5 (Ease of Movement) and Pacification 4 (Purity of Mind) uses 298. Pacification at 50 is leftover points so level 24's points stay useful.",
            order: "Mending at level from 2, since a Seer can train it: Mending 13 (Greater Purification) at 13, Mending 15 (Reception from Valhalla) at 15, Mending 16 (Favor of Battle) at 16, Mending 21 (Eir's Glorious Touch) at 21, Mending 23 (Greater Reparation) at 23. Level 24 buys Augmentation 5 (Ease of Movement) and Pacification 4 (Purity of Mind). After 24 Mending runs one behind level: Mending 39 (Ancestor's Favor) at 40, Mending 41 (Greater Reconstruction) at 42, Mending 42 (Major Emendation) at 42. Augmentation stays at 5 until 41, then takes the rest: Augmentation 18 (Celerity) at 45, Augmentation 33 (Gods' Vigor) at 50, with Pacification 7 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Mending: 23, Augmentation: 5, Pacification: 4 } },
                { level: 50, specs: { Mending: 42, Augmentation: 33, Pacification: 7 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/healer-guide',
                    title: 'Blackthorn wiki: healer guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '33 Augmentation, 42 Mending for maximum healing, at a cost in resists and power.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Augmentation healer',
            role: 'Backline healer who hastes and resist-buffs the melee.',
            why: "Augmentation 18 (Celerity) is group haste on this server, the reason every tri-spec stops at 18-19. Augmentation 37 (Storm Affinity) completes the yellow resists (33, 36, 37), as Blackthorn says. Level 24 is the path 14, 18, 4 from a Uthgard forum thread seen only as a search summary, with one more Mending, because Mending 15 (Reception from Valhalla) is the better resurrect, 30% health against 10% for the base line's Arrival from Valhalla at character level 10, and 16 points were spare.",
            order: "Augmentation at level from 2, since a Seer can train it, to Augmentation 18 (Celerity) at 18. Level 20 is the forum path's stop: Mending 7 (Cure Poison) at 20, Pacification 4 (Purity of Mind) at 20. Then Mending 15 (Reception from Valhalla) at 24. After 24 everything goes to Mending: Mending 26 (Boon of Battle) at 33, Mending 39 (Ancestor's Favor) at 43. Augmentation stays at 18 until 42, then Augmentation 26 (Enhanced Celerity) at 45, Augmentation 33 (Gods' Vigor) at 49, Augmentation 37 (Storm Affinity) at 50.",
            basis: 'adapted',
            targets: [
                { level: 20, specs: { Augmentation: 18, Mending: 7, Pacification: 4 } },
                { level: 24, specs: { Augmentation: 18, Mending: 15, Pacification: 4 } },
                { level: 50, specs: { Mending: 39, Augmentation: 37, Pacification: 4 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/healer-guide',
                    title: 'Blackthorn wiki: healer guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '39 Mending, 37 Augmentation: 37 gives full yellow spiritual resists.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=116&t=39367',
                    title: 'Leveling spec',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary, thread attribution not certain: 7 Mending, 18 Augmentation, 4 Pacification at 20, then 14, 18, 4 at 24.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Pacification tri-spec',
            role: 'Forward healer who controls crowds and heals second.',
            why: "Pacification 36 (Pacifying Glare) and Pacification 38 (Paralyzing Glare) are the instant area crowd control at 50; both exist at those levels here. At 24 the same budget cannot hold 18 Augmentation, so Celerity waits: Pacification 20 (Conciliate Area) with Mending 13 (Greater Purification) spends exactly 299. Blackthorn's numbers are 38, 33, 18; the 19th Augmentation is spare points that add Augmentation 19 (Asgard's Strength), and the only page giving 19 is a parked Phoenix thread. A pure version, 44 Pacification, 31 Mending, is in a Uthgard forum thread seen only as a search summary.",
            order: "Levels 2-4 buy Mending 4: a Seer has no Pacification. Pacification comes at 5, is at 3 there and runs one or two behind level: Pacification 15 (Purity of Thought) at 16, Pacification 20 (Conciliate Area) at 21. Mending stays at 4 until 20, then Mending 13 (Greater Purification) at 24. After 24 Augmentation goes first, Augmentation 18 (Celerity) at 31, Augmentation 19 (Asgard's Strength) at 31. Pacification stays at 20 until 31, then Pacification 29 (Pacifying Glance) at 38, Pacification 36 (Pacifying Glare) at 43, Pacification 38 (Paralyzing Glare) at 44. Mending stays at 13 until 43, then Mending 33 (Major Reconstruction) at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Pacification: 20, Mending: 13 } },
                { level: 50, specs: { Augmentation: 19, Pacification: 38, Mending: 33 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/healer-guide',
                    title: 'Blackthorn wiki: healer guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '38 Pacification, 33 Mending, 18 Augmentation with group Celerity and four instant crowd control spells.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://forum.playphoenix.online/realm/midgard/4636-healer-aug-and-pac-builds',
                    title: 'Healer Aug and Pac builds',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: '38 Pacification, 33 Mending, 19 Augmentation; another poster has 36, 35, 18 as the usual tri-spec.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=24011',
                    title: 'The Healer Guide to Uthgards World Domination ver 0.1',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary: full Pacification endgame spec of 44 Pacification, 31 Mending.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Full Augmentation solo',
            role: 'Solo healer who buffs up and melees.',
            why: "Uthgard gives the idea with no numbers. The numbers are ours: Augmentation at level, spending all 299 at 24; Augmentation 49 (Asgard's Might) at 50. Needs a weapon line this class does not train, so damage comes from buffs alone. Least suited to a bot group.",
            order: "Augmentation at level from 2, since a Seer can train it, all the way: Augmentation 19 (Asgard's Strength) at 19, Augmentation 22 (Intensified Blow) at 22, Augmentation 49 (Asgard's Might) at 49, where it stops. That takes every point until the half levels start at 40.5, so Mending stays at 1 until 40. Then Mending 7 (Cure Poison) at 42, Mending 15 (Reception from Valhalla) at 46, Mending 22 (Boon from Eir) at 50, with Pacification 5 at 50.",
            basis: 'derived',
            targets: [
                { level: 24, specs: { Augmentation: 24 } },
                { level: 50, specs: { Augmentation: 49, Mending: 22, Pacification: 5 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Solo: full Augmentation; the buffs let a healer chain mobs. No point numbers.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
