import type { ClassBuilds } from './types';

export default {
    className: 'Infiltrator',
    notes: 'Budget 722 at 24, 3706 at 50 (multiplier 25, ClassInfiltrator.cs:33). Free levels: Stealth (ClassInfiltrator.cs:27). Before promotion only Stealth, Slash, Thrust train (Rogue): the rule raises those a target lists and banks the rest. Opens later: Dual Wield at 5, Envenom at 5. sdk/API.md lists no stealth or poison action, so the assassin build needs SDK work first; the Dual Wield build gets by without.',
    builds: [
        {
            name: 'Critical Strike assassin',
            role: 'Stealth opener and poison damage on one target, mostly solo or in a stealth group.',
            why: 'Both target levels are in the sources: the level 24 base from a Thidranki thread and the level 50 end from the guide. Dual Wield takes what is left, which comes to 7 and 19 here. Reaches at 24: Critical Strike 21 Perforate Artery, Thrust 18 Tranquillize, Stealth 16 Detect Hidden; at 50: Thrust 50 Dragonfang, Critical Strike 44 Rib Separation, Stealth 25 Climb Walls.',
            order: 'Rogue levels: Thrust to 4. Critical Strike comes with promotion, and from level 6 stays at character level to 21: Backstab II at 10, Perforate Artery at 21. Thrust takes what is left and is at character level from level 9 to Tranquillize at 18. Envenom opens at 5: Envenom 8 by level 15, Envenom 15 by level 20 for Major Lethal Poison. Then Stealth, 6 of its levels free at 24: Detect Hidden at 16 by level 23, Stealth 19 by level 24. Dual Wield 7 by level 24. After 24 Thrust, at character level from 28 to Dragonfang at 50 by level 50. Critical Strike waits at 21 until then, and is at character level from 36 to Rib Separation at 44 by level 44. Stealth 36 by level 45, Envenom 36 by level 49, Dual Wield 19 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Critical Strike': 21, Thrust: 18, Envenom: 15, Stealth: 19, 'Dual Wield': 7 } },
                { level: 50, specs: { Thrust: 50, 'Critical Strike': 44, Stealth: 36, Envenom: 36, 'Dual Wield': 19 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=103&t=41756',
                    title: '24 Thid Infil Build (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'A level 24 base of 21 Critical Strike, 18 Thrust or Slash, 19 Stealth, 15 Envenom, rest Dual Wield.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: 21 Critical Strike, 18 Thrust or Slash, 19 Stealth, 15 Envenom, leftover in Dual Wield.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Thrust 50, Critical Strike 44, Stealth 36, Poison 36, rest Dual Wield.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Dual wield Mercfiltrator',
            role: 'Visible melee damage in a group, leaning on dual wield rather than stealth openers.',
            why: 'The levelling and group shape on Uthgard, where posters level on Dual Wield and name this build next to the crit one. The level 30 numbers in the source are 30 DW, 27 Thrust, 23 Envenom, and level 24 scales from there. Level 50 is the assassin build with Dual Wield and Critical Strike swapped, so those numbers are ours. Reaches at 24: Dual Wield 21 Penumbra, Thrust 21 Lunge, Envenom 15 Major Lethal Poison; at 50: Dual Wield 50 Dual Shadows, Thrust 44 Wyvernfang, Envenom 35 Major Lethal Venom.',
            order: 'Rogue levels: Thrust to 4. Dual Wield opens at 5, and from level 6 stays at character level to 50: Misty Gloom at 15, Penumbra at 21, Dual Shadows at 50. Thrust takes what is left and is at character level from level 9 to 21: Tranquillize at 18, Lunge at 21. Envenom gets the rest, Envenom 8 by level 15, Envenom 15 by level 22 for Major Lethal Poison. Stealth 11 by level 24, 6 of its levels free at 24, and Critical Strike 7 by level 24 (Kidney Rupture at 6). After 24 Thrust, at character level again from 29 to Wyvernfang at 44 by level 44. Envenom 36 by level 45, Stealth 36 by level 49, Critical Strike 19 by level 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { 'Dual Wield': 24, Thrust: 21, Envenom: 15, Stealth: 11, 'Critical Strike': 7 } },
                { level: 50, specs: { 'Dual Wield': 50, Thrust: 44, Envenom: 36, Stealth: 36, 'Critical Strike': 19 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=103&t=37156',
                    title: 'Spec progression while level! (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Progression of about 10 DW, 7 Thrust, 7 Envenom at 10 up to 30 DW, 27 Thrust, 23 Envenom at 30, then a respec into Critical Strike around 40.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: progression of Dual Wield, Thrust and Envenom at 10, 20 and 30, then a respec from Dual Wield to Critical Strike at 40. The exact numbers were not quoted.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=18673',
                    title: 'Infil 1.69 + Old RAs - Mercfiltrator or Crit Blade? (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'Weighs the Mercfiltrator against the crit build, with no fixed numbers in the excerpt. Posters advise against a full Mercfiltrator below about RR5, since it gives up Dragonfang.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: title says patch 1.69. Critblade better solo; Mercfiltrator advised only from about RR5.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
