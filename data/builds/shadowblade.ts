import type { ClassBuilds } from './types';

export default {
    className: 'Shadowblade',
    notes: 'Multiplier 22 (ClassShadowblade.cs:33): 633 at 24, 3253 at 50. Autotrain on Stealth (ClassShadowblade.cs:27,50-53): free to 6 at 24 and 12 at 50. Starts as Rogue (Stealth, Sword only); Left Axe arrives at 5. Stealth openers: damage here is fixed by Critical Strike level, Critical Strike 10 (Backstab II) and Critical Strike 21 (Perforate Artery) (StyleProcessor.cs:332-341), so at 21 Perforate Artery beats Backstab II; a Phoenix warning about a low-level Perforate bug was not checked here. Bots do not stealth or use stealth styles yet (learnings/rvr.md:120, sdk/group/styles.ts:32,94); poison application is untested. Envenom has no window entries: its stops are poison levels from the item templates, and a poison needs its level in Envenom (GamePlayer.cs:7256). Role: melee.',
    builds: [
        {
            name: 'Shadowzerk',
            role: 'Stealth melee who keeps hitting after the opener: a Berserker from stealth.',
            why: 'The level 50 spec is on the Uthgard blog. The level 24 spec comes from a Phoenix thread that is now a parked domain, seen only as a search summary; it costs 631 of 633 here. Uthgard recommends the level 50 spec at low realm ranks. Axe is the Left Axe partner; a Sword main hand works the same. Critical Strike is the rest in the source, computed here as 13.',
            order: "Levels 2-4 bank the points: the target at 5 lists only Axe, which a Rogue doesn't have. Axe 5 at 5 and at level to Axe 19 at 19. Stealth takes the rest and is at level from 12: Stealth 16 (Detect Hidden) at 16, Stealth 19 at 19. Then Envenom 15 (Major Lethal Poison) at 21, Envenom 17 (Greater Weakening Poison) at 22. Left Axe stays at 1 until 21, then Left Axe 15 (Frost Shadow) at 24, with Critical Strike 2 at 24. After 24 Left Axe goes first and is at level from 30, Left Axe 50 (Aurora Borealis) at 50. Axe is next, so that the main hand doesn't wait for the rest: Axe stays at 19 until 29, then Axe 34 (Midnight Sun) at 39, Axe 35 at 40. Stealth stays at 19 until 39, then Stealth 36 at 45. Envenom stays at 17 until 44, then Envenom 35 (Major Lethal Venom) at 49, Envenom 36 at 50, with Critical Strike 13 at 50.",
            basis: 'adapted',
            targets: [
                { level: 5, specs: { Axe: 5 } },
                { level: 24, specs: { Axe: 19, Stealth: 19, Envenom: 17, 'Left Axe': 15, 'Critical Strike': 2 } },
                { level: 50, specs: { 'Left Axe': 50, Axe: 35, Stealth: 36, Envenom: 36, 'Critical Strike': 13 } },
            ],
            sources: [
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/thidranki-lvl24-shadowblade-specs-01DGMJQH5GX4VRH0B4M1PX2ZZS',
                    title: '[Thidranki] LvL24 Shadowblade Specs?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Level 24 zerk spec: 19 Stealth, 19 Axe, 15 Left Axe, 17 Envenom, 2 Critical Strike. Also argues a composite weapon at level is not needed at Thidranki and prefers Backstab 2 to Perforate Artery there.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'RvR Shadowzerk: 50 Left Axe, 35 weapon, 36 Stealth, 36 Envenom, rest Critical Strike.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Left Axe leveller, no Stealth spend',
            role: 'Open-ground melee while levelling, for a bot that never stealths.',
            why: 'The Uthgard levelling rule: Left Axe at level, Envenom within 5 of level, leftovers in a weapon, Stealth left on autotrain until 44 or so. It suits a bot because no point goes to a skill it does not use. Same level 50 target as Shadowzerk, reached by raising Stealth last.',
            order: "Levels 2-4 bank the points: the target at 14 lists no line a Rogue has. Left Axe 5 at 5 and at level all the way: Left Axe 21 (Scathing Blade) at 21, Left Axe 50 (Aurora Borealis) at 50. Envenom stays within 5 of level until it stops at 36: Envenom 15 (Major Lethal Poison) at 18, Envenom 19 (Toxic Poison) at 21, Envenom 30 (Lesser Lethal Venom) at 33, Envenom 35 (Major Lethal Venom) at 39, Envenom 36 at 40. Axe has the leftovers: Axe 10 (Pillager) at 14, Axe 15 (Evernight) at 24, Axe 21 (Valkyrie's Shield) at 35, Axe 35 at 44. The stops at 14 and 35 are ours, to hold Envenom back that far and give Axe the difference. Stealth costs nothing until 44, its levels being free: Stealth stays at 6 until 44, then Stealth 36 at 50. Critical Strike 4 at 24, Critical Strike 13 at 45.",
            basis: 'adapted',
            targets: [
                { level: 14, specs: { 'Left Axe': 14, Envenom: 9, Axe: 10 } },
                { level: 24, specs: { 'Left Axe': 24, Envenom: 19, Axe: 16, Stealth: 6, 'Critical Strike': 4 } },
                { level: 35, specs: { 'Left Axe': 35, Envenom: 30, Axe: 22, 'Critical Strike': 4 } },
                { level: 50, specs: { 'Left Axe': 50, Envenom: 36, Axe: 35, 'Critical Strike': 13, Stealth: 36 } },
            ],
            sources: [
                {
                    url: 'https://uthgard.blogspot.com/p/midgard-class-guide.html',
                    title: 'Uthgard DAOC: Midgard Class Guide',
                    era: 'Uthgard freeshard, classic Old Frontiers rules; undated',
                    says: 'Levelling: Left Axe even with level, Envenom within 5, leftovers in Sword or Axe, Stealth on autotrain until 44+.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
        {
            name: 'Critical Strike, five lines',
            role: 'Stealth assassin who wins on the opener and chain.',
            why: 'Spends on Critical Strike 21 (Perforate Artery) by 24 and Critical Strike 34 (Creeping Death) by 50. Numbers unconfirmed: the level 24 spec is from a parked Phoenix thread, the level 50 five-line spec from a Uthgard forum thread that answers 502, both seen only as search summaries. It fits at 3220 of 3253. Blackthorn describes a higher-crit version with no numbers. Needs stealth and stealth styles in the bot before it plays as meant.',
            order: 'Levels 2-4 buy Stealth 4, the only listed line a Rogue has. Critical Strike comes at 5, is at 3 there and at level from 7 to Critical Strike 10 (Backstab II) at 10. The stop at 12 is ours, to give the weapon some levels: Axe 9 at 11, Stealth 8 at 12, Envenom 5 at 12. Critical Strike then goes on at level from 13 to Critical Strike 21 (Perforate Artery) at 21, with Stealth 19 at 21. Then Envenom 17 (Greater Weakening Poison) at 24, Axe 12 at 24, Left Axe 3 at 24. After 24 Left Axe catches up and is at level from 33 to Left Axe 39 (Frosty Gaze) at 39. Axe stays at 12 until 32, then Axe 34 (Midnight Sun) at 41. Critical Strike stays at 21 until 41, then Critical Strike 34 (Creeping Death) at 44. Stealth 36 at 47, Envenom 35 (Major Lethal Venom) at 50, Envenom 36 at 50.',
            basis: 'derived',
            targets: [
                { level: 12, specs: { 'Critical Strike': 10, Axe: 9, Stealth: 8, Envenom: 5 } },
                { level: 24, specs: { 'Critical Strike': 21, Stealth: 19, Envenom: 17, Axe: 12, 'Left Axe': 3 } },
                { level: 50, specs: { 'Left Axe': 39, Axe: 34, 'Critical Strike': 34, Stealth: 36, Envenom: 36 } },
            ],
            sources: [
                {
                    url: 'https://playphoenix.online/forum/realm/midgard/thidranki-lvl24-shadowblade-specs-01DGMJQH5GX4VRH0B4M1PX2ZZS',
                    title: '[Thidranki] LvL24 Shadowblade Specs?',
                    era: 'Phoenix freeshard, classic-based, c.2018-2020; read via search summary only (site parked)',
                    says: 'Proposes testing 21 Critical Strike, 17 Envenom, 12 Axe; thread keeps Stealth near 19-20. Left Axe 3 here is leftover points.',
                    checked: 'Fetched 2026-11-03: parked domain, "This domain is for sale". Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://uthgard.net/forum/viewtopic.php?t=33907',
                    title: 'Uthgard 2.0 low RR shadowblade specs',
                    era: 'Uthgard forum, c.2011-2018; read via search summary only (forum 502)',
                    says: 'Search summary, exact thread not certain: five-line spec of 34 main hand, 39 Left Axe, 34 Critical Strike, 36 Stealth, 36 Envenom, viable from about realm rank 4; Shadowzerk is better earlier.',
                    checked: 'Fetched 2026-11-03: HTTP 502. Numbers could not be read; only a search summary ever showed them.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/shadowblade-guide',
                    title: 'Blackthorn wiki: shadowblade guide',
                    era: 'Blackthorn freeshard, classic-style with own changes; undated',
                    says: 'Describes Critblade and Shadowzerk; no point totals.',
                    checked: 'Read 2026-11-03: page opens and supports this.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
