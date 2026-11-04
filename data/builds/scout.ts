import type { ClassBuilds } from './types';

export default {
    className: 'Scout',
    notes: 'Budget 584 at 24, 2979 at 50 (multiplier 20, ClassScout.cs:15). Free levels: Longbows (ClassScout.cs:9). Before promotion only Stealth, Slash, Thrust train (Rogue): the rule raises those a target lists and banks the rest. Archery is on the autotrain list but is no Scout line here. specializations.json gives Scout no Stealth abilities such as Climb Walls. sdk/API.md lists no ranged attack or stealth action, so Archer needs SDK work; Melee slash does not.',
    builds: [
        {
            name: 'Archer',
            role: 'Ranged damage and interrupts from stealth, with a shield for when caught.',
            why: 'The most common Scout template across eras. Level 50 numbers come from the sources, with the rest in Thrust coming to 21 here; level 24 is fitted here. It needs a bow attack the SDK does not offer yet. Reaches at 24: Longbows 24 Critical Shot(8), Shields 13 Disable, Thrust 12 Bloody Dance; at 50: Longbows 50 Penetrating Arrow(3), Longbows 45 Rapid Fire(2), Shields 42 Slam.',
            order: 'Rogue levels: Stealth to 4. Longbows comes with promotion at 3, and from level 7 stays at character level to 50, 6 of its levels free at 24: Critical Shot rises every 3 levels and reaches rank 8 at 24, Rapid Fire I at 35, Rapid Fire II at 45. Stealth takes what is left, Stealth 14 by level 15, Stealth 16 by level 17 for hiding, since a shot nocked in stealth keeps it with chance Stealth/level (AttackComponent.cs:608-609). Then Disable at 13 by level 21, and Thrust 12 by level 24. After 24 Shields again: Slam at 42 by level 44. Stealth waits at 16 until then: Stealth 35 by level 49. Thrust 21 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Longbows: 24, Stealth: 16, Shields: 13, Thrust: 12 } },
                { level: 50, specs: { Longbows: 50, Shields: 42, Stealth: 35, Thrust: 21 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Bow 50, Shield 42, Stealth 35, rest weapon, autotraining the bow until 48.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=16466',
                    title: 'Scout Spec (Uthgard forum, 2010 posts)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'The same 50 bow build as the popular one, with 18 Thrust, or 21 with autotrain to 48. The 28 and 56 cap gains from 35 to 50 bow are a former GM chart that a search summary places in a 2013 thread, so tying them to this thread is unconfirmed.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: lists 45 bow, 42 shield, 35 stealth, rest weapon as common; 50, 42, 35, 18 as a popular older build; autotrain to 48 gives 21 Thrust.',
                },
            ],
        },
        {
            name: 'Melee slash',
            role: 'Melee first with a shield, keeping the bow as a side tool.',
            why: 'Both target levels are in the sources, and level 50 uses every point. It works with what the SDK does today, since it does not depend on the bow. Reaches at 24: Slash 21 Side Slicer, Slash 18 Riposte, Shields 18 Incapacitate; at 50: Slash 39 Back Slash, Shields 42 Slam, Longbows 35 Rapid Fire(1).',
            order: 'Slash at character level from the first point to 21: Riposte at 18, Side Slicer at 21. Shields comes with promotion and takes what is left: Guard I at 5 by level 8, Engage at 7 by level 9, Disable at 13 by level 14, Guard III at 15 by level 16, Incapacitate at 18 by level 19. Then Stealth 18 by level 24. Longbows is listed last and gets its 6 levels at 24, when they are all free. After 24 Shields, at character level from 29 to Slam at 42 by level 42. Slash waits at 21 until level 30 and takes what is left: Slash 35 by level 40, Slash 41 by level 43. Stealth 36 by level 47, and Rapid Fire I at 35 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Slash: 21, Shields: 18, Stealth: 18, Longbows: 6 } },
                { level: 50, specs: { Shields: 42, Slash: 41, Stealth: 36, Longbows: 35 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=109&t=38956',
                    title: 'Noob scout questions (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'For 24 with autotrain continuing: 18 Stealth, 21 Slash, 18 Shield, 6 Bow.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: the poster has Stealth 16, Thrust 18, Shield 23, Longbow 6 at 24; the reply says 18 Stealth, 21 Slash, 18 Shield, 6 Bow and prefers Slash.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Melee focus: Shield 42, Slash 41, Stealth 36, Bow 35.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Thrust and shield',
            role: 'Shield-heavy Scout on a thrust weapon with a detaunt, moving to the bow later.',
            why: 'Level 24 is the plan a poster asks about, and level 50 is the 45 bow option from a list of common specs, with the rest in Thrust coming to 30 here. Reaches at 24: Shields 23 Paralyze, Thrust 18 Tranquillize, Longbows 6 Critical Shot(2); at 50: Longbows 45 Rapid Fire(2), Shields 42 Slam, Thrust 29 Pierce.',
            order: 'Rogue levels: Thrust to 4. Shields comes with promotion at 3, and from level 7 stays at character level to 23: Disable at 13, Incapacitate at 18, Paralyze at 23. Thrust takes what is left, Thrust 14 by level 15, Tranquillize at 18 by level 19. Then Stealth 16 by level 24. Longbows is listed last and gets its 6 levels at 24, when they are all free. After 24 Shields, at character level from 25 to Slam at 42 by level 42. Longbows takes what is left: Longbows 32 by level 40, Rapid Fire II at 45 by level 45. Then Stealth 35 by level 48, and Thrust, waiting at 18 until then, Thrust 30 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Shields: 23, Thrust: 18, Stealth: 16, Longbows: 6 } },
                { level: 50, specs: { Shields: 42, Longbows: 45, Stealth: 35, Thrust: 30 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=109&t=38956',
                    title: 'Noob scout questions (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'A level 24 plan of 16 Stealth, 18 Thrust, 23 Shield, 6 Bow on autotrain; the reply prefers Slash for Highlanders.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: the poster has Stealth 16, Thrust 18, Shield 23, Longbow 6 at 24; the reply says 18 Stealth, 21 Slash, 18 Shield, 6 Bow and prefers Slash.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=16466',
                    title: 'Scout Spec (Uthgard forum, 2010 posts)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'Lists 45 bow, 42 shield, 35 stealth, rest weapon among common builds.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: lists 45 bow, 42 shield, 35 stealth, rest weapon as common; 50, 42, 35, 18 as a popular older build; autotrain to 48 gives 21 Thrust.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
