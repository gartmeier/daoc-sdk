import type { ClassBuilds } from './types';

export default {
    className: 'Reaver',
    notes: 'Budget 584 at 24, 2979 at 50 (multiplier 20, ClassReaver.cs:33). Free levels: Slash, Flexible (ClassReaver.cs:27). Before promotion only Crush, Slash, Thrust train (Fighter): the rule raises those a target lists and banks the rest. Opens later: Parry at 5. Uthgard levels on Crush and respecs at 40 or later; these builds stay on Flexible instead.',
    builds: [
        {
            name: 'Flex, shield and tap',
            role: 'Melee hybrid with a flexible weapon, a lifetap and an armour-absorb debuff, with a shield swap.',
            why: 'The Reaver build with full free levels, which on this server is always the case: both the guide and the forum land on these exact numbers, using every point. Level 24 is fitted here, starting from the note that 18 Flexible gives a strong side style. Reaches at 24: Flexible 21 Boomslang, Soulrending 22 Surge of Maiming, Soulrending 21 Credit to Arawn; at 50: Flexible 50 Leviathan, Soulrending 41 Life Siphon, Shields 42 Slam.',
            order: 'Fighter levels: Slash to 4, because its first levels end up free: the 9 points come back by 16, as the free levels pass them, and the target at 24 lists Slash 4 so that those levels never read as over target. Crush would need a respec: this build spends all 2979 points at 50. Flexible comes with promotion at 3, has free levels too, and from level 7 stays at character level to 21: Indigosnake at 18, Boomslang at 21. Soulrending takes what is left, Soulrending 14 by level 15: Vitality Siphon at 19 and Cramping Curse at 20 by level 20, Credit to Arawn at 21 by level 21, Surge of Maiming at 22 by level 22. Then Disable at 13 by level 24, Parry 6 at 24. After 24 Flexible, at character level again from 27 to Leviathan at 50 by level 50. Shields takes what is left: Slam at 42 by level 44. Soulrending waits at 22 until then: Life Siphon at 41 by level 50. Parry stays at 6.',
            basis: 'adapted',
            targets: [
                { level: 4, specs: { Slash: 4 } },
                { level: 24, specs: { Flexible: 21, Soulrending: 22, Shields: 13, Parry: 6, Slash: 4 } },
                { level: 50, specs: { Flexible: 50, Shields: 42, Soulrending: 41, Parry: 6 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Flexible 50, Shield 42, Soulrending 41, Parry 6 through autotraining; Crush or Thrust advised for levelling.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=38821',
                    title: 'Reaver questions (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'About 18 Flexible gives a strong side style in groups; levels with Crush.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 18 points in Flexible gives a very powerful side style in groups; Crush to level.',
                },
            ],
        },
        {
            name: 'Double fifty',
            role: 'Highest melee and spell damage, weak on shield tools and defence.',
            why: 'The wiki calls this the top damage group spec. Source shield and parry numbers are for a Slash build; on Flexible the free points land at 29 Shield and 11 Parry. Level 24 is fitted here. Reaches at 24: Soulrending 23 Soul Toxin, Soulrending 22 Surge of Maiming, Flexible 21 Boomslang; at 50: Soulrending 50 Soul Siphon, Soulrending 50 Murder Aura, Flexible 50 Leviathan.',
            order: 'The target lists no Fighter line, so the Fighter levels bank their 9 points and promotion buys Soulrending 5 at once. It stays at character level to 50: Soul Toxin at 23, Soul Siphon at 50. Flexible takes what is left, Flexible 14 by level 15, Boomslang at 21 by level 21. Then Guard II at 10 by level 24, Parry 4 at 24. After 24 Flexible, Flexible 39 by level 40, at character level from 41. From there the half levels pay for Shields: Bash at 29 by level 49. Parry 11 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Soulrending: 24, Flexible: 21, Shields: 10, Parry: 4 } },
                { level: 50, specs: { Soulrending: 50, Flexible: 50, Shields: 29, Parry: 11 } },
            ],
            sources: [
                {
                    url: 'https://camelotherald.fandom.com/wiki/Reaver',
                    title: 'Reaver (Camelot Herald wiki)',
                    era: 'Herald wiki, live-era; excerpt',
                    says: '50 Soulrending and 50 Flexible is regarded as the highest damage group spec.',
                    checked: 'WebFetch HTTP 402. Search excerpt 2026-11-03: 50 Soulrending and 50 Flexible called the highest damage group spec.',
                },
                {
                    url: 'https://uthgard.net/forum/viewtopic.php?f=15&t=5566',
                    title: '(Split)Reaver build (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: 'An early plan at 50 Slash, 50 Soulrending, 29 Shields, 9 Parry.',
                    checked: 'Not fetched: same host, 14 of 14 fetches gave HTTP 502. Search excerpt 2026-11-03: 50 Slash, 50 Soulrending, 29 Shields, 9 Parry, and a reply says it needs autotrain. A later French post, t=31901, has 50 Flexible, 50 Soulrending, 29 Shields, 11 Parry, the numbers used here.',
                },
            ],
        },
        {
            name: 'Parry heavy',
            role: 'Solo and small-group Reaver who gives up tap strength for more parry.',
            why: 'The trade a poster describes: 23 less tap damage for much more parry. Source says 16 Parry without autotrain; the free Flexible levels make it 20 here. Level 24 is fitted here. Reaches at 24: Flexible 21 Boomslang, Soulrending 18 Spirit Decay, Shields 13 Disable; at 50: Flexible 50 Leviathan, Soulrending 36 Surge of Wrecking, Shields 42 Slam.',
            order: 'The target lists no Fighter line, so the Fighter levels bank their 9 points and promotion buys Flexible 5 at once. It stays at character level to 50: Boomslang at 21, Leviathan at 50. Soulrending takes what is left, Soulrending 14 by level 15, Spirit Decay at 18 by level 19. Then Disable at 13 by level 23, Parry 8 by level 24. After 24 Shields again: Slam at 42 by level 43. Soulrending waits at 18 until then: Surge of Wrecking at 36 by level 49. Parry 20 by level 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Flexible: 24, Soulrending: 18, Shields: 13, Parry: 8 } },
                { level: 50, specs: { Flexible: 50, Shields: 42, Soulrending: 36, Parry: 20 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=60&t=23586',
                    title: 'reaver spec + RAs (Uthgard forum)',
                    era: 'Uthgard before its 1.65 relaunch, older patch (up to 1.69), by thread number; excerpt',
                    says: '50 Flex, 42 Shield, 36 Soulrending, 16 Parry without autotrain, suited to solo and duo.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: without autotrain 50, 42, 36, 16 Parry; with full autotrain 50, 42, 41, 6 Parry.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
