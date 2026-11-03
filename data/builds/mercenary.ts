import type { ClassBuilds } from './types';

export default {
    className: 'Mercenary',
    notes: 'Budget 584 at 24, 2979 at 50 (multiplier 20, ClassMercenary.cs:33). Free levels: Slash, Thrust (ClassMercenary.cs:27). Before promotion only Crush, Slash, Thrust train (Fighter): the rule raises those a target lists and banks the rest. Opens later: Dual Wield at 5, Parry at 17. Swapping Slash for Thrust costs nothing; Crush costs 77 more.',
    builds: [
        {
            name: 'Dual wield with Slam',
            role: 'Group melee damage with a shield swap for a stun and a guard.',
            why: 'The common choice in all the Mercenary sources. The 77 free Slash points leave Parry 20 here, close to the 19 one source names. Level 50 numbers come from the sources; level 24 is fitted here. Reaches at 24: Dual Wield 21 Penumbra, Dual Wield 18 Obscure, Slash 18 Riposte; at 50: Dual Wield 50 Dual Shadows, Shields 42 Slam, Slash 34 Befuddler.',
            order: 'Fighter levels: Slash to 4. Dual Wield opens at promotion at 3, and from level 7 stays at character level to 50: Misty Gloom at 15, Obscure at 18, Penumbra at 21. Left-hand chance rises with it (AttackComponent.cs:2162-2170). Slash takes what is left, as the source advises for PvE: Slash 14 by level 15, Riposte at 18 by level 19. Then Shields: Engage at 7 by level 20, Disable at 13 by level 23, Guard III at 15 by level 24. Parry opens at 17 and gets 5 at 24. After 24 Slash again, Slash 36 by level 39, because the damage floor of a slash weapon reads it. Shields waits at 15 until then: Slam at 42 by level 48. Parry 20 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Dual Wield': 24, Slash: 18, Shields: 15, Parry: 5 } },
                { level: 50, specs: { 'Dual Wield': 50, Slash: 36, Shields: 42, Parry: 20 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Dual Wield 50, Shield 42, Slash 36, rest Parry; in PvE keep Dual Wield at character level with the rest in a weapon, then Shield and Parry.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=104&t=36280',
                    title: 'Mercenary Spec (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Compares 50 DW, 36 Slash, 42 Shield, 19 Parry with 50 DW, 50 Slash, 28 Parry; most prefer the Slam build.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: the Slam variant preferred over 50, 50, 28. The 19 Parry was not quoted; the excerpt says rest Parry.',
                },
            ],
        },
        {
            name: 'Pure damage',
            role: 'Damage first, with parry as the only defence and no shield tools.',
            why: 'The other build the sources weigh: more damage from Diamond Slash and a higher weapon floor, none of the shield utility. Sources name Parry 28 to 30; the free Slash points leave 31 here. Level 24 is fitted here. Reaches at 24: Dual Wield 21 Penumbra, Slash 21 Side Slicer; at 50: Dual Wield 50 Dual Shadows, Slash 50 Diamond Slash.',
            order: 'Fighter levels: Slash to 4. Dual Wield opens at promotion at 3, and from level 7 stays at character level to 50: Misty Gloom at 15, Penumbra at 21, Dual Shadows at 50. Slash takes what is left, Slash 14 by level 15, and from level 20 both fit at character level: Riposte at 18 by level 19, Side Slicer at 21 by level 21. Slash stops at 23 while Parry, open from 17, takes its 7 at 24. After 24 Slash runs one under character level and is at it from 36, so both reach 50 at 50. Parry trails: Parry 8 by level 40, Parry 31 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Dual Wield': 24, Slash: 23, Parry: 7 } },
                { level: 50, specs: { 'Dual Wield': 50, Slash: 50, Parry: 31 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=104&t=36280',
                    title: 'Mercenary Spec (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: '50 DW, 50 Slash, 28 Parry, argued as the stronger damage build by some and worse by others.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: the Slam variant preferred over 50, 50, 28. The 19 Parry was not quoted; the excerpt says rest Parry.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=104&t=37330',
                    title: 'Mercenary Templates (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'A Highlander template at 50 DW, 50 Slash, 30 Parry.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: Highlander template at 50 DW, 50 Slash, 30 Parry.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
