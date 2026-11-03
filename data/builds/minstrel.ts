import type { ClassBuilds } from './types';

export default {
    className: 'Minstrel',
    notes: 'Budget 437 at 24, 2223 at 50 (multiplier 15, ClassMinstrel.cs:33). Free levels: Instruments (ClassMinstrel.cs:27). Before promotion only Stealth, Slash, Thrust train (Rogue): the rule raises those a target lists and banks the rest. Sources disagree on the first charm; the data says Instruments 5, Captivating Melodies. sdk/API.md lists no stealth action.',
    builds: [
        {
            name: 'Group thrust',
            role: 'Visible group support: speed, power and health songs, crowd control and melee.',
            why: 'The full group build in the guide, which ignores stealth. Source forums say it needs autotrain until 48; on this server the free Instruments points always apply, so it fits with 8 Stealth left over. Level 24 is fitted here. Reaches at 24: Instruments 21 Pacifying Lullaby, Instruments 21 Song of Energy, Instruments 20 Attracting Melodies; at 50: Instruments 50 Wall of Song, Instruments 50 Song of Empowering, Thrust 44 Wyvernfang.',
            order: 'Rogue levels: Thrust to 4. Instruments comes with promotion at 3, Captivating Melodies at 5 by level 6, and from level 8 stays at character level to 21: Enchanting Melodies at 13, Song of Healing at 19, Attracting Melodies at 20, Song of Energy at 21, Pacifying Lullaby at 21. Thrust takes what is left, Thrust 10 by level 15, then everything: Tranquillize at 18 by level 23, Thrust 20 by level 24. Stealth 5 at 24 for Distraction. After 24 Instruments, at character level again from 29 to 50. Thrust goes on behind it: Thrust 29 by level 40, Thrust 44 by level 50. Stealth 8 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Instruments: 21, Thrust: 20, Stealth: 5 } },
                { level: 50, specs: { Instruments: 50, Thrust: 44, Stealth: 8 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Full group: Instruments 50, Thrust 44, ignoring Stealth.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=28958',
                    title: 'Ministrel: Need Advice for Thid spec (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'In Thidranki a charmed pet is the strongest tool, and it needs Instruments to hold.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: a 2013 thread. Charmed beetle in Thidranki needs Instruments; 25 Stealth for climbing; most cited is 49 Instruments, 29 Slash, 33 Stealth.',
                },
            ],
        },
        {
            name: 'Stealth',
            role: 'Stealth-group support with charm and mez, light on melee.',
            why: 'The stealth group build in the guide. It needs stealth handling the SDK does not offer yet. Level 24 is fitted here. Reaches at 24: Instruments 21 Pacifying Lullaby, Slash 15 Opal Slash, Stealth 10 Safe Fall(1); at 50: Instruments 50 Wall of Song, Stealth 25 Climb Walls, Slash 29 Amethyst Slash.',
            order: 'Rogue levels: Stealth to 4. Instruments comes with promotion at 3, Captivating Melodies at 5 by level 6, and from level 8 stays at character level to 21: Enchanting Melodies at 13, Attracting Melodies at 20, Pacifying Lullaby at 21. Stealth takes what is left: Distraction at 5 by level 9, Danger Sense at 8 by level 12, Safe Fall at 10 by level 15, Stealth 13 by level 19. Slash stays at 1 until then, since this build is light on melee: Opal Slash at 15 by level 24, Slash 16 by level 24. After 24 Instruments, at character level again from 29 to 50. Stealth goes on behind it: Climb Walls at 25 by level 41, Stealth 33 by level 45. Then Slash 30 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Instruments: 21, Stealth: 13, Slash: 16 } },
                { level: 50, specs: { Instruments: 50, Stealth: 33, Slash: 30 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Stealth group: Instruments 50, Stealth 33, Weapon 30.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://camelotherald.fandom.com/wiki/Minstrel',
                    title: 'Minstrel (Camelot Herald wiki)',
                    era: 'Herald wiki, live-era; excerpt',
                    says: '29 weapon with 33 Stealth is called the most common stealth spec.',
                    checked: 'WebFetch HTTP 402. Search excerpt 2026-11-03: 50 Instruments, 29 Slash or Thrust, 33 Stealth called the most common stealth spec.',
                },
            ],
        },
        {
            name: 'Small group',
            role: 'Small-group all-rounder with melee, songs and just enough stealth to climb.',
            why: 'The small group build in the guide, which uses every point here. Stealth 25 is the Climb Walls breakpoint that posters call the practical minimum. Level 24 is fitted here. Reaches at 24: Instruments 21 Song of Energy, Slash 18 Riposte, Stealth 10 Safe Fall(1); at 50: Instruments 50 Deafening Cacophony, Slash 34 Befuddler, Stealth 25 Climb Walls.',
            order: 'Rogue levels: Slash to 4. Instruments comes with promotion at 3, Captivating Melodies at 5 by level 6, and from level 8 stays at character level to 21: Enchanting Melodies at 13, Song of Energy at 21. Slash takes what is left, Slash 10 by level 15, then everything: Riposte at 18 by level 23. Safe Fall at 10 by level 24. After 24 Instruments, at character level again from 29 to 50. Slash goes on behind it: Slash 27 by level 40, Slash 37 by level 46. Then Stealth, Climb Walls at 25 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Instruments: 21, Slash: 18, Stealth: 10 } },
                { level: 50, specs: { Instruments: 50, Slash: 37, Stealth: 25 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Small group: Instruments 50, Weapon 37, Stealth 25.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=28958',
                    title: 'Ministrel: Need Advice for Thid spec (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'About 25 Stealth for Climb Walls; another poster finds stealth useless for solo Thidranki.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: a 2013 thread. Charmed beetle in Thidranki needs Instruments; 25 Stealth for climbing; most cited is 49 Instruments, 29 Slash, 33 Stealth.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
