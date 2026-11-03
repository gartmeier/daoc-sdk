import type { ClassBuilds } from './types';

export default {
    className: 'Hunter',
    notes: 'Multiplier 20 (ClassHunter.cs:15): 584 at 24, 2979 at 50. No autotrain on this server: ClassHunter.cs:9 declares the list but the override is commented out (:23-26). Starts as Rogue, which trains only Stealth and Sword. Spear uses (STR+DEX)/2 (GamePlayer.cs:5505-5509) while Sword uses STR, so with DEX primary Spear is the default melee line. Bots cannot use the bow yet: sdk/index.ts and sdk/actions.ts have no ranged attack, no bot stealths (learnings/rvr.md:120), and there are no pet commands (learnings/rvr.md:119). Beastcraft self-buffs still work as spells. Role: melee.',
    builds: [
        {
            name: 'Spear and Beastcraft',
            role: 'Melee damage with strong self-buffs. The only shape bots can fully play today.',
            why: 'The Uthgard melee route. At 24 it is the levelling rule on this budget: Spear at level, rest Beastcraft. Beastcraft 50 (Heart of the Lynx) is the top Dex/Qui here. The Uthgard text calls Hunter one of the weakest classes.',
            order: "Levels 2-4 bank the points: the target at 5 lists only Spear, which a Rogue doesn't have. Spear 5 at 5 and at level through 24: Spear 21 (Perforate) at 21. Beastcraft takes the rest, one to three behind: Beastcraft 5 (Nimbleness of the Lynx) at 8, Beastcraft 21 (Dexterity of the Lynx) at 22, Beastcraft 23 (Drake's Hide) at 24, with Stealth 4 at 24. After 24 Beastcraft goes first and is at level from 25: Beastcraft 40 (Alacrity of the Lynx) at 40, Beastcraft 50 (Heart of the Lynx) at 50. Spear follows one behind to Spear 39 (Razor Edge) at 40, then Spear 44 (Odin's Wrath) at 44, where it stops. Stealth stays at 4 until 40, then Stealth 36 at 50, with Composite Bow 9 at 50.",
            basis: 'adapted',
            targets: [
                { level: 5, specs: { Spear: 5 } },
                { level: 24, specs: { Spear: 24, Beastcraft: 23, Stealth: 4 } },
                { level: 50, specs: { Beastcraft: 50, Spear: 44, Stealth: 36, 'Composite Bow': 9 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Levelling: weapon at level (Sword or Spear), rest Beastcraft. RvR melee: 50 Beastcraft, 44 Spear, 36 Stealth, rest Bow.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Hybrid bow and Spear',
            role: 'The classic Hunter: opens with the bow, finishes in melee. Needs bow support first.',
            why: "Composite Bow 35 (Rapid Fire) is where the guide and forum posters stop; posters report little gain past it. The Uthgard forum guide gives 40 Beastcraft, 35 Stealth, 39 Spear, 35 Bow; the leftover 123 points here take Spear to 42, matching the blog's rest in Spear. The blog names no Stealth number: Stealth 35 and the level 35 ladder come from that forum guide, which answers 502 and was seen only as a search summary. A forum 43 Beastcraft version is 3 points over this budget. Level 24 fitted to the guide's level 35 proportions. The targets at 35 and 43 are that ladder's rungs, so they rest on the same search summary.",
            order: "Levels 2-4 buy Stealth 4, the only listed line a Rogue has. Beastcraft comes at 5, is at 3 there and at level from 7 to Beastcraft 21 (Dexterity of the Lynx) at 21. Spear takes the rest, Spear 18 (Stab) at 20. Then Composite Bow 15 (Critical Shot V) at 23 and Stealth 11 at 24. From there it climbs the forum guide's ladder, whose rungs at 35 and 43 are targets here. Rung 35: Beastcraft 32 (Hunter's Avatar) at 32, Composite Bow 24 (Critical Shot VIII) at 33, Spear 20 at 33, Stealth 20 at 35. Rung 43: Beastcraft 40 (Alacrity of the Lynx) at 40, Composite Bow 30 (Penetrating Arrow I) at 41, Spear 27 at 42, Stealth 25 at 43. Then Composite Bow 35 (Rapid Fire I) at 45, Stealth 35 at 47, and Spear last, Spear 42 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Beastcraft: 21, Spear: 18, 'Composite Bow': 15, Stealth: 11 } },
                { level: 35, specs: { Beastcraft: 32, 'Composite Bow': 24, Spear: 20, Stealth: 20 } },
                { level: 43, specs: { Beastcraft: 40, 'Composite Bow': 30, Spear: 27, Stealth: 25 } },
                { level: 50, specs: { Beastcraft: 40, 'Composite Bow': 35, Stealth: 35, Spear: 42 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: '40 Beastcraft, 35 Bow, rest Spear for bow damage.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=61&t=30564',
                    title: '[Need updates] Hunter Guide',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary: spec ladder of 32/20/20/24 at 35, 40/25/27/30 at 43, 40/35/39/35 near 50 (Beastcraft, Stealth, Spear, Bow).',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Stealth archer',
            role: 'Battleground archer who shoots from stealth. Needs bow and stealth support first.',
            why: 'Numbers unconfirmed: both Phoenix pages are now a parked domain, so this rests on search summaries nobody can re-read. The one Midgard Hunter number found written for Thidranki: 20 Stealth, 24 Bow, rest Spear, with item bonuses on top. Here "rest" is Spear 11, and Beastcraft 4 takes the leftovers. The level 50 source spec, 39 Stealth, 35 Bow, 32 Beastcraft, 46 Spear, costs 3015 and is 36 over this budget, so Spear drops to 45.',
            order: "Levels 2-4 buy Stealth 4, the only listed line a Rogue has. Composite Bow comes at 5, is at 3 there and at level from 7: Composite Bow 15 (Critical Shot V) at 15, Composite Bow 24 (Critical Shot VIII) at 24. Stealth takes the rest, Stealth 20 at 21. Then Spear 11 at 24 and Beastcraft 4 at 24. After 24 Stealth goes first and is at level from 28, to Stealth 39 at 39. Composite Bow stays at 24 until 28, then Composite Bow 35 (Rapid Fire I) at 38. Beastcraft stays at 4 until 37, then Beastcraft 32 (Hunter's Avatar) at 44. Spear stays at 11 until 43, then takes the rest, Spear 45 at 50.",
            basis: 'derived',
            targets: [
                { level: 24, specs: { 'Composite Bow': 24, Stealth: 20, Spear: 11, Beastcraft: 4 } },
                { level: 50, specs: { Stealth: 39, 'Composite Bow': 35, Beastcraft: 32, Spear: 45 } },
            ],
            sources: [
                {
                    url: 'https://forum.playphoenix.online/realm/midgard/8327-new-hunter-specs-with-pot-changes?page=11',
                    title: 'New Hunter Specs with POT Changes?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Thidranki spec with 20 Stealth, 24 Archery, rest Spear, each plus 5 from items.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/hunter-specs-01D34N1QSRKTA779M5PF68R548',
                    title: 'Hunter Specs',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Fresh level 50 spec of 39 Stealth, 35 Archery, 32 Beastcraft, 46 Spear, moving points from Stealth to Spear as realm rank rises.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
