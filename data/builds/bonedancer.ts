import type { ClassBuilds } from './types';

export default {
    className: 'Bonedancer',
    notes: 'Multiplier 10 (ClassBonedancer.cs:30): 299 at 24, 1494 at 50. Starts as Mystic (Darkness, Suppression only). The commander pet comes from the base Bone Army line by character level (1, 15, 30, 45), holding 0, 1, 2 and 3 subpets (spell text; CommanderPet.cs:84-102 with npctemplate 49-52). Subpets need 15 in a line, each its own kind: Bone Army 18 (Summon Bonesmasher), Darkness 15 (Summon Bonemage), Suppression 18 (Summon Bonepatcher) is the first healer. Blackthorn only says Bonedancers are often called borderline oppressive on 1.65-style servers; it does not say how its shard differs, so its strength claims may not carry over. Bots keep the commander up and send it at the focus by themselves (learnings/group-coordination.md); subpets and tactics of its own are not played. A Phoenix post, seen only as a search summary, reports a 30-40% pet damage nerf on that server, so its pet numbers may not carry over. Role: nuker.',
    builds: [
        {
            name: 'Suppression lifetap',
            role: 'Self-sustaining caster with instant lifetap and healer subpets.',
            why: 'The Uthgard blog gives 47 Suppression, 26 Darkness, and 5 Bone Army takes the leftovers, 1491 of 1494. The level 24 spec, 298 of 299, comes from a Phoenix thread that is now a parked domain, seen only as a search summary. Suppression 22 (Crunch Skeleton) is the level 24 lifetap, Suppression 47 (Pulverize Skeleton) the top one.',
            order: 'Suppression at level from 2, since a Mystic can train it: Suppression 18 (Summon Bonepatcher) at 18, Suppression 21 (Summon Bone Sentry) at 21, Suppression 22 (Crunch Skeleton) at 22. Then Darkness 9 (Stiffen Skeleton) at 24, Bone Army 2 at 24. After 24 Suppression runs one or two behind level and is at level from 43: Suppression 37 (Disintegrate Skeleton) at 39, Suppression 47 (Pulverize Skeleton) at 47, where it stops. Darkness stays at 9 until 42, then Darkness 22 (Boost Bonecaster) at 49, Darkness 26 at 50, with Bone Army 5 (Liquify Bones) at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Suppression: 22, Darkness: 9, 'Bone Army': 2 } },
                { level: 50, specs: { Suppression: 47, Darkness: 26, 'Bone Army': 5 } },
            ],
            sources: [
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/11821-need-suggestions-for-a-thid-bonedancer-spec-',
                    title: 'Need Suggestions for a Thid Bonedancer Spec?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'November 2019: 22 Suppression, 9 Darkness, 2 Bone Army for solo or group at Thidranki.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=38851',
                    title: 'Bonedancer Guide by Sheena (BD Teamlead)',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary, thread attribution not certain: TapDancer template of 47 Suppression, 26 Darkness, 5 Bone Army.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'RvR: 47 Suppression, 26 Darkness; lifetap gives a caster survivability.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Bone Army',
            role: 'Pet-heavy caster for PvE and holding keeps, with area damage over time.',
            why: 'Numbers unconfirmed: the Phoenix thread is a parked domain, the Uthgard thread answers 502, and both were seen only as search summaries (298 of 299 and 1494 of 1494). Blackthorn describes a Bone Army spec but gives no totals. Bone Army 20 (Cloud of Rot) is the area damage over time at 24, Bone Army 47 (Cloud of Dessication) the last. Posters also level this way up to 18-20 before moving to Suppression; a keep role is what the Thid poster suggests it for. It needs pet control beyond sending the commander at the focus to shine (sdk/group/pets.ts stops there).',
            order: 'Levels 2-4 buy Suppression 4 (Dissolve Skeleton): a Mystic has no Bone Army. Bone Army comes at 5, is at 3 there and runs one or two behind level: Bone Army 4 (Bone Spurs) at 6, Bone Army 15 (Summon Bone Dart) at 16, Bone Army 18 (Summon Bonesmasher) at 19, Bone Army 20 (Cloud of Rot) at 21, Bone Army 22 (Disperse Skeleton) at 23. Then Suppression 9 (Crush Skeleton) at 24, Darkness 2 at 24. After 24 Bone Army stays one or two behind and is at level from 43: Bone Army 47 (Cloud of Dessication) at 47, Bone Army 48 (Summon Bonerazer) at 48, where it stops. Suppression stays at 9 until 42, then Suppression 24 (Summon Bonefixer) at 50, with Darkness 6 at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { 'Bone Army': 22, Suppression: 9, Darkness: 2 } },
                { level: 50, specs: { 'Bone Army': 48, Suppression: 24, Darkness: 6 } },
            ],
            sources: [
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/11821-need-suggestions-for-a-thid-bonedancer-spec-',
                    title: 'Need Suggestions for a Thid Bonedancer Spec?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: '22 Bone Army, 9 Suppression, 2 Darkness for group keep defence at Thidranki.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?t=38851',
                    title: 'Bonedancer Guide by Sheena (BD Teamlead)',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary, thread attribution not certain: KeepDancer template of 48 Bone Army, 24 Suppression, 6 Darkness for defence.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
            ],
        },
        {
            name: 'Split Darkness and Suppression',
            role: 'All-round group caster with a lifetap, debuff and subpets from both lines, one at a time below level 30.',
            why: 'Blackthorn calls it the most common build and says it usually does the best damage across specs; costs exactly 1494. Level 24 is fitted to reach the two subpet steps: Suppression 18 (Summon Bonepatcher) and Darkness 15 (Summon Bonemage). The commander at 24 holds one subpet (skeletal commander, CommanderPet.cs:84-85; a second slot comes at level 30), so these are a choice, not a pair.',
            order: 'Suppression at level from 2, since a Mystic can train it, to Suppression 18 (Summon Bonepatcher) at 18. Darkness stays at 1 until 18, then Darkness 15 (Summon Bonemage) at 24, with Bone Army 4 (Bone Spurs) at 24. After 24 the two take turns, at most ten levels apart, and the stop at 40 is ours: Darkness 22 (Boost Bonecaster) at 29, Darkness 28 at 34, Suppression 22 (Crunch Skeleton) at 37, Suppression 28 at 40, Darkness 34 (Support Bonecaster) at 44, Darkness 38 at 46, Suppression 37 (Disintegrate Skeleton) at 50, Suppression 38 at 50. Bone Army 5 (Liquify Bones) at 50 with the last points.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Suppression: 18, Darkness: 15, 'Bone Army': 4 } },
                { level: 40, specs: { Darkness: 28, Suppression: 28, 'Bone Army': 4 } },
                { level: 50, specs: { Darkness: 38, Suppression: 38, 'Bone Army': 5 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/bonedancer-guide',
                    title: 'Blackthorn wiki: bonedancer guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: '38 Darkness, 38 Suppression as the most common build; 5 Bone Army here is the 14 leftover points. Also 48 Suppression, 24 Darkness and 46 Darkness, 27 Suppression.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
