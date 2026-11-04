import type { ClassBuilds } from './types';

export default {
    className: 'Spiritmaster',
    notes: 'Multiplier 10 (ClassSpiritmaster.cs:31): 299 at 24, 1494 at 50. Starts as Mystic (Darkness, Suppression only). Blackthorn says 48 Suppression gives the best area damage; on this table the last tier is Suppression 49 (Soul Annihilation), so the bomb build uses 49, as Uthgard and Phoenix posts do according to search summaries only. Bots keep the pet up and send it at the focus by themselves (learnings/group-coordination.md), at 25 % of the pool a summon; nothing here has been run with one in a round. Role: nuker.',
    builds: [
        {
            name: 'Darkness caster',
            role: 'Ranged lifetap nuker with debuffs and an area mez.',
            why: "Blackthorn calls it the most common and Uthgard gives the same 47, 26; the Phoenix thread that adds 5 Summoning can't be read any more. Darkness 47 (Extinguish Lifeforce) is the top lifetap, Darkness 46 (Greater Curse of Blindness) the top Dex/Qui debuff. Summoning 5 is only the leftover points: Summoning 23 (Restore Spirit) is out of reach next to these lines. At 24 Darkness 23 (Silence Lifeforce) is the damage step.",
            order: "Darkness at level from 2, since a Mystic can train it: Darkness 10 (Mute Lifeforce) at 10, Darkness 17 (Suppress Lifeforce) at 17, Darkness 21 (Shroud of Gloom) at 21, Darkness 23 (Silence Lifeforce) at 23. Level 24 buys Suppression 6 (Attenuate Strength) and Summoning 2 (Spirit's Revenge). After 24 Darkness runs one behind level and is at level from 42: Darkness 46 (Greater Curse of Blindness) at 46, Darkness 47 (Extinguish Lifeforce) at 47, where it stops. Suppression stays at 6 until 41, then Suppression 25 (Impair Strength) at 50, Suppression 26 (Soul Explosion) at 50, with Summoning 5 (Valkyrie's Nimbleness) at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Darkness: 23, Suppression: 6, Summoning: 2 } },
                { level: 50, specs: { Darkness: 47, Suppression: 26, Summoning: 5 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'RvR: 47 Darkness, 26 Suppression.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/spiritmaster-guide',
                    title: 'Blackthorn wiki: spiritmaster guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '47 Darkness, 26 Suppression as the common caster-group spec.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/7755-sm-rvrpve-spec',
                    title: 'SM RVR/PVE Spec',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: '47, 26, 5 Summoning as a solo RvR spec.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Suppression bomber',
            role: 'Point-blank area damage and long mez, for camps or a bomb group.',
            why: "Uthgard names Suppression for group levelling because of the area damage. Suppression 20 (Soul Blast) is the area nuke at 24, and it is the one spec where the Spiritmaster hits many at once. 22 is all a second line can have at 49: Darkness 23 would make 1499. The Uthgard and Phoenix threads that give 49 can't be read any more; Blackthorn's readable version is 48, 24. Point-blank spells put the caster beside the mobs, and group nukes use area spells only when asked to (learnings/group-coordination.md:85), so this needs a strategy that allows it.",
            order: "Levels 2-7 buy Darkness only: Darkness 6 (Smother Lifeforce) at 6 is the ranged lifetap, then Darkness 7 (Dusk Wave) at 7. The target at 7 is what keeps Suppression out until then. Suppression follows two to five behind level: Suppression 8 (Soul Dissipation) at 11, Suppression 10 (Pin Spirit) at 13, Suppression 14 (Soul Dispersal) at 16, Suppression 15 (Lock Spirit) at 17, Suppression 20 (Soul Blast) at 22. Darkness stays at 7 until 21, then Darkness 13 (Stifle Lifeforce) at 24. After 24 Suppression alone: Suppression 26 (Soul Explosion) at 30, Suppression 41 (Soul Destruction) at 43, Suppression 49 (Soul Annihilation) at 49. Darkness stays at 13 until 44, then Darkness 22 (Dampen Health) at 50, with Summoning 5 (Valkyrie's Nimbleness) at 50.",
            basis: 'adapted',
            targets: [
                { level: 7, specs: { Darkness: 7 } },
                { level: 24, specs: { Suppression: 20, Darkness: 13 } },
                { level: 50, specs: { Suppression: 49, Darkness: 22, Summoning: 5 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Group levelling: Suppression for its area damage.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=123&t=41311',
                    title: 'how to spec bomb?',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary: 49 Suppression for the strongest area damage, rest in Darkness.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/7755-sm-rvrpve-spec',
                    title: 'SM RVR/PVE Spec',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: '22 in a second line is the most that fits next to 49 Suppression.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/spiritmaster-guide',
                    title: 'Blackthorn wiki: spiritmaster guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '48 Suppression, 24 Darkness for a Spiritmaster tanker; its 48 is one short of the last damage tier here.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Summoning pet',
            role: 'Solo PvE with a strong pet. Not for battlegrounds.',
            why: 'Uthgard says it levels cheaply and safely with pet pulls and a damage shield, and forum posters confirm it. They give no numbers, so these are ours: Summoning at level to Summoning 24 (Vitality of Valhalla), spending all 299. A Uthgard post calls it unplayable in battlegrounds, so a respec is needed for Thidranki or RvR. Bots send the pet at the focus and keep it up (sdk/group/pets.ts); pet pulls and its damage shield are not played.',
            order: "Levels 2-4 bank the points: the target at 24 lists only Summoning, which a Mystic doesn't have. Summoning 5 (Valkyrie's Nimbleness) at 5 and at level from then on: Summoning 12 (Zest of Valhalla) at 12, Summoning 19 (Valkyrie's Spirit) at 19, Summoning 21 (Spirit of Combat) at 21, Summoning 24 (Vitality of Valhalla) at 24, Summoning 50 (Spirit's Justification) at 50. That takes every point until the half levels start at 40.5, so Suppression stays at 1 until 40. Then Suppression 8 (Soul Dissipation) at 42, Suppression 20 (Soul Blast) at 50, with Darkness 4 at 50.",
            basis: 'derived',
            targets: [
                { level: 24, specs: { Summoning: 24 } },
                { level: 50, specs: { Summoning: 50, Suppression: 20, Darkness: 4 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Solo levelling: Summoning, with pet pulls and a damage shield. No numbers.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=61&t=32640',
                    title: 'Spiritmaster Levling suggestions',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary: full Summoning reached 48, 4-5 mobs per pull; respec at 50 for RvR.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
