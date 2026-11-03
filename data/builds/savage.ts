import type { ClassBuilds } from './types';

export default {
    className: 'Savage',
    notes: 'Multiplier 15 (ClassSavage.cs:32), no autotrain: 437 points at 24, 2223 at 50. Starts as Viking; Hand to Hand and Savagery only after promotion at 5. Multi-hit chance rises linearly, double 0.5% per Hand to Hand level, triple half of that, quad a quarter of triple (AttackComponent.cs:2235-2248), so 24 gives 12/6/1.5% with no step. Savagery self-buffs cost health per the Uthgard guide; whether the group buff logic casts them is unverified. Role: melee.',
    builds: [
        {
            name: 'Hand to Hand first',
            role: 'Melee damage dealer, most swings and best multi-hit.',
            why: "Blackthorn's damage spec; the Uthgard levelling rule (Hand to Hand at level, rest Savagery) gives the same level 24 shape. A Phoenix poster notes nobody has shown 50 quads more, but this server's formula does scale with spec. It misses the last Savagery tier: stops short of Savagery 48 (Zeal of Kelgor).",
            order: "Level 2 buys Parry 2, the only listed line a Viking has, and the rest stays banked. Hand to Hand comes at 5, is at 4 there and at level from 6: Hand to Hand 21 (Totemic Fear) at 21. Savagery takes the rest: Savagery 11 (Drive of Kelgor) at 18, Savagery 12 (Fierce Blows) at 19, Savagery 16 at 24. After 24 Hand to Hand stays at level, Hand to Hand 44 (Kelgor's Wrath) at 44, Hand to Hand 50 (Totemic Sacrifice) at 50. Savagery follows, Savagery 30 (Feral Blows) at 42, Savagery 42 (Weather Punctures) at 50. Parry stays at 2 until 49, Parry 9 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Hand to Hand': 24, Savagery: 16, Parry: 2 } },
                { level: 50, specs: { 'Hand to Hand': 50, Savagery: 42, Parry: 9 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/savage-guide',
                    title: 'Blackthorn wiki: savage guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '50 Hand to Hand, 42 Savagery, 9 Parry for damage and multi-hit, giving up the last self-buff tier.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Levelling: Hand to Hand at level, rest in Savagery.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://forum.playphoenix.online/realm/midgard/7922-savage-rvrpve-spec1',
                    title: 'Savage RVR/PVE Spec#1',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Gives 44/49/rest Parry or 50/40/rest Parry and says no data shows 50 Hand to Hand gives more quads.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Savagery first',
            role: 'Melee damage dealer with the best self-buffs.',
            why: 'Named by the Uthgard blog and Blackthorn, and by a Uthgard forum thread seen only as a search summary; Savagery 49 (Savage Blows) and Savagery 48 (Zeal of Kelgor) are the top buffs here too. At 24 the fit favours buff tiers, Savagery 21 (Relentless Blows), over the last Hand to Hand levels, and leaves 9 points that buy nothing useful.',
            order: "Levels 2-4 bank the points: a Viking has neither line the target at 14 lists. Hand to Hand 5 at 5 and at level to Hand to Hand 11 at 11, Savagery behind it. Then Savagery catches up and is at level from 17: Savagery 11 (Drive of Kelgor) at 14, Savagery 12 (Fierce Blows) at 15, Savagery 20 (Kelgor's Gift) at 20, Savagery 21 (Relentless Blows) at 21. Hand to Hand stays at 11 until 18, then Hand to Hand 18 (Clan's Might) at 23, Hand to Hand 19 at 24, with Parry 4 at 24. After 24 Savagery pulls ahead and is at level from 29: Savagery 48 (Zeal of Kelgor) at 48, Savagery 49 (Savage Blows) at 49. Hand to Hand follows, Hand to Hand 21 (Totemic Fear) at 32, Hand to Hand 44 (Kelgor's Wrath) at 50. The stop at 14 is ours.",
            basis: 'adapted',
            targets: [
                { level: 14, specs: { 'Hand to Hand': 11, Savagery: 11 } },
                { level: 24, specs: { Savagery: 21, 'Hand to Hand': 19, Parry: 4 } },
                { level: 50, specs: { Savagery: 49, 'Hand to Hand': 44, Parry: 4 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'RvR: 49 Savagery, 44 Hand to Hand, rest Parry. Warns that shields block these swings more often.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/savage-guide',
                    title: 'Blackthorn wiki: savage guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '49 Savagery, 44 Hand to Hand, 4 Parry for the strongest self-buffs.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=119&t=37345',
                    title: 'Savage Templates',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary, thread attribution not certain: 49 Savagery, 44 Hand to Hand, rest Parry as the common build for Uthgard 2.0.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Two-handed solo',
            role: 'Solo melee with a two-handed Sword, hard to hit one on one.',
            why: "Blackthorn's solo spec: 45 Savagery with 19 Parry brings parry and evade near their caps, through Savagery 45 (Evasion of Kelgor). It names Sword or Axe; Sword chosen here, use Axe by swapping the line. Blackthorn lists it for solo only.",
            order: "Sword at level from 2, since a Viking can train it: Sword 21 (Reinforcement) at 21, Sword 44 (Sif's Revenge) at 44, where it stops. Savagery comes at 5 and takes the rest, Savagery 15 (Bear Punctures) at 23, Savagery 25 (Mania of Kelgor) at 38, with Parry 5 at 24. From 44 Savagery catches up: Savagery 45 (Evasion of Kelgor) at 49. Parry stays at 5 until 48, Parry 19 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Sword: 24, Savagery: 15, Parry: 5 } },
                { level: 50, specs: { Sword: 44, Savagery: 45, Parry: 19 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/savage-guide',
                    title: 'Blackthorn wiki: savage guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '45 Savagery, 44 two-handed weapon line (Sword or Axe), 19 Parry for solo.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=119&t=40054',
                    title: 'Savage, Leveling Spec',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary: a poster levels on a two-handed sword to about 20 before moving to Hand to Hand, keeping weapon near level.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
