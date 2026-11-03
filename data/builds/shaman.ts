import type { ClassBuilds } from './types';

export default {
    className: 'Shaman',
    notes: 'Multiplier 10 (ClassShaman.cs:31): 299 at 24, 1494 at 50. The key is Subterranean; sources and items say Cave (data/spec-names.ts). Starts as Seer (Mending, Augmentation only). Subterranean 27 (Mold Cloud) sits outside the level 24 cap but is in every level 50 spec: the instant area disease all the guides stop for. A Uthgard forum spec of 46 Cave, 26 Aug, 10 Mend for clearing camps, with Subterranean 46 (Spore Whirlwind), also fits. Role in sdk/group/strategy.ts: healer. The Cave nuker needs a nuker role override in group.json (learnings/group-coordination.md:18).',
    builds: [
        {
            name: 'Augmentation buffer',
            role: 'Group buffer: Str/Con, Dex/Qui, endurance, debuffs and only light healing.',
            why: "Uthgard calls this pretty standard. Blackthorn lists it for Mid tanker setups and leads with 42, 27, 20; the Phoenix thread can't be read any more. Augmentation 46 (Power of the Deep) is the top Str/Con and Subterranean 27 (Mold Cloud) the area disease. At 24 the goal is Augmentation 22 (Earth Invigoration) and Augmentation 22 (Wisdom of the Deep). Budget: 1492 of 1494.",
            order: "Augmentation at level from 2, since a Seer can train it: Augmentation 19 (Might of the Deep) at 19, Augmentation 21 (Murk's Wisdom) at 21, Augmentation 22 (Earth Invigoration) at 22. Then Mending 8 (Major Amelioration) at 24, Subterranean 4 (Fungal Burr) at 24. After 24 Subterranean goes first: Subterranean 17 (Spore Cloud) at 30, Subterranean 27 (Mold Cloud) at 36. Augmentation stays at 22 until 36, then Augmentation 36 (Fortification of the Deep) at 45, Augmentation 42 (Superior Earth Invigoration) at 48, Augmentation 46 (Power of the Deep) at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Augmentation: 22, Mending: 8, Subterranean: 4 } },
                { level: 50, specs: { Subterranean: 27, Augmentation: 46, Mending: 8 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'RvR standard: 46 Augmentation, 27 Cave, 8 Mend. Group levelling: high Augmentation.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/shaman-guide',
                    title: 'Blackthorn wiki: shaman guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '46 Augmentation, 27 Subterranean, 8 Mending: strongest buffs except Dex/Qui, very weak healing.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://forum.playphoenix.online/realm/midgard/7757-shaman-rvrpve-spec',
                    title: 'Shaman RVR/PVE Spec',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: '46, 27, 8 named as the most common group recommendation.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Buffer healer',
            role: 'Second healer who keeps most group buffs.',
            why: "Blackthorn trades Augmentation for Mending and still keeps Augmentation 36 (Fortification of the Deep) and Augmentation 37 (Shadow's Wisdom). Mending 26 (Fungal Rejuvenation) is the group regen. Blackthorn's first-listed spec, 42, 27, 20, also fits (1488) and adds Augmentation 42 (Superior Earth Invigoration). Choose this when the bot group has one healer and the Shaman backs it up, which matches its healer role in strategy.ts.",
            order: "Augmentation at level from 2, since a Seer can train it, to Augmentation 14 (Murk's Guide) at 14, Augmentation 19 (Might of the Deep) at 19. Mending stays at 1 until 19, then Mending 7 (Cure Poison) at 21, Mending 14 (Major Recovery) at 24, with Subterranean 3 at 24. After 24 Subterranean goes first, Subterranean 27 (Mold Cloud) at 37. Mending stays at 14 until 36, then Mending 26 (Fungal Rejuvenation) at 42, Mending 28 at 43. Augmentation stays at 19 until 42, then Augmentation 37 (Shadow's Wisdom) at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Augmentation: 19, Mending: 14, Subterranean: 3 } },
                { level: 50, specs: { Subterranean: 27, Mending: 28, Augmentation: 37 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/shaman-guide',
                    title: 'Blackthorn wiki: shaman guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '37 Augmentation, 27 Subterranean, 28 Mending for yellow buffs and better healing; also 42, 27, 20.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Cave nuker',
            role: 'Ranged damage and damage over time, solo or small group, with buffs on the side.',
            why: 'Subterranean 41 (Fungal Mucus) is the last direct damage spell. The numbers are from a Uthgard forum thread that answers 502, seen only as a search summary: 32-34 Augmentation, of which 34 is what fits, 1481 of 1494. The one readable cave spec, on Freddyshouse, is 41 Augmentation, 35 Cave, 3 Mending: buffs first, not this shape. At 24, Subterranean 20 (Fungal Ooze) with Augmentation 13 (Vitality of the Deep) spends exactly 299, and heals and cures wait: only the base Mending line until after 24.',
            order: 'Levels 2-4 buy Augmentation 4 (Lesser Force of the Deep): a Seer has no Subterranean. Subterranean comes at 5, is at 3 there and runs one or two behind level: Subterranean 15 (Fungal Slime) at 16, Subterranean 17 (Spore Cloud) at 18, Subterranean 20 (Fungal Ooze) at 21. Augmentation stays at 4 until 20, then Augmentation 12 (Sight of the Deep) at 24, Augmentation 13 (Vitality of the Deep) at 24. After 24 Mending comes first, for the cures: Mending 6 (Cure Disease) at 25, Mending 7 (Cure Poison) at 26. Then Subterranean 25 (Fungal Sludge) at 30, Subterranean 27 (Mold Cloud) at 31, Subterranean 35 (Fungal Scum) at 39, Subterranean 41 (Fungal Mucus) at 43. Augmentation stays at 13 until 42, then Augmentation 34 (Supreme Force of the Deep) at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Subterranean: 20, Augmentation: 13 } },
                { level: 50, specs: { Mending: 7, Subterranean: 41, Augmentation: 34 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=61&t=25832',
                    title: 'Newb here - Cave Shaman',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary: 41 Cave, 32-34 Augmentation, 7 Mending for solo or small groups.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://forums.freddyshouse.com/threads/cave-shaman-template-spec-line.242432/',
                    title: 'CAVE SHAMAN template + spec line',
                    era: 'Live servers, thread dated August 2010',
                    says: '41 Augmentation, 35 Cave, 3 Mending on a Frostalf: keeps buffs and adds offence. Costs exactly 1494 here.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
