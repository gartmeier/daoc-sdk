import type { ClassBuilds } from './types';

export default {
    className: 'Armsman',
    notes: "Budget 584 at 24, 2979 at 50 (multiplier 20, ClassArmsman.cs:33). Free levels: Slash, Thrust (ClassArmsman.cs:27). Before promotion only Crush, Slash, Thrust train (Fighter): the rule raises those a target lists and banks the rest. Opens later: Parry at 10, Two Handed at 10, Crossbows at 15. Free levels cost nothing up to floor(level/4), so 6 at 24 and 12 at 50, worth 20 and 77 points per line (GamePlayer.cs:4833-4845, 9966-9967; train.cs:115); they must still be trained, and the credit holds however high the line goes, so forum advice to stay on autotrain does not apply. Targets only rise from 24 to 50, so no respec is needed, and the forums' respec levels at 20 and 40 don't matter: /respec all is free at any level here (respec.cs:96, 153). Polearm and Two Handed weapons take their damage floor from the 1H line of their damage type (AttackComponent.cs:1182-1195; on by default, ServerProperties.cs:599-600, not changed in serverproperty.sql), so match the weapon to the 1H line. 44 Polearm, 34 Slash, 34 Thrust, 42 Shields, 10 Parry also uses every point (Uthgard t=46589, excerpt).",
    builds: [
        {
            name: 'Polearm hybrid',
            role: 'Front-line melee damage who can still guard and stun with a shield swap.',
            why: "The most repeated Armsman shape, in the same numbers across eras. On this server the big weapon line sets the ceiling and the 1H line sets the floor, as the sources describe (AttackComponent.cs:1182-1195, 2141). Level 50 numbers come from the sources; level 24 is fitted here. Reaches at 24: Polearm 21 Disabler, Polearm 18 Crippling Blow, Slash 18 Riposte; at 50: Polearm 50 Defender's Aegis, Shields 42 Slam, Slash 39 Back Slash.",
            order: "Fighter levels: Slash to 4. Polearm comes with promotion at 3, and from level 7 it stays at character level all the way to 50: Defender's Courage at 15, Crippling Blow at 18, Disabler at 21. Slash takes what is left, Slash 14 by level 15 and Riposte at 18 by level 19, because the damage floor of a polearm reads the 1H line of its damage type, so carry a slash polearm. Then Shields: Engage at 7 by level 20, Disable at 13 by level 23, Guard III at 15 by level 24. Parry opens at 10 and gets 5 at 24. After 24 Slash again, for the floor, Back Slash at 39 by level 41. Shields waits at 15 until then: Slam at 42 by level 50, with Parry 13 from the last points.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Polearm: 24, Slash: 18, Shields: 15, Parry: 5 } },
                { level: 50, specs: { Polearm: 50, Slash: 39, Shields: 42, Parry: 13 } },
            ],
            sources: [
                {
                    url: 'https://playphoenix.online/forum/realm/albion/armsman-templating-01E1TQEVBG7NYMR5ZF8YHEJ08Q',
                    title: 'Armsman templating.. (Phoenix forum)',
                    era: 'Phoenix, later than 1.65; excerpt',
                    says: '39 Slash, 50 Polearm, 42 Shield, 13 Parry, settled on for both PvE and RvR.',
                    checked: 'Domain parked: WebFetch shows a for-sale page. Search excerpt 2026-11-03: a Highlander Slash Armsman settling on 39 Slash, 50 Polearm, 42 Shield, 13 Parry for PvE raids and RvR.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Polearm or Two-Handed 50, Shield 42, weapon 30 to 39, rest Parry; level on the big weapon with leftovers in Shield and a 1H line.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Two-Handed hybrid',
            role: 'Same front-line job as the polearm build, with two-handed swords or maces.',
            why: 'The sources treat Two-Handed and Polearm as the same plan with a different weapon. It opens at level 10, so the first levels go on Slash. Level 50 numbers come from the sources; level 24 is fitted here. Reaches at 24: Two Handed 21 Bone Splitter, Two Handed 18 Fury, Slash 18 Riposte; at 50: Two Handed 50 Sun and Moon, Shields 42 Slam, Slash 39 Back Slash.',
            order: 'Slash at character level through level 9, and once it is capped the rest goes to Shields: Guard I at 5 by level 8, Engage at 7 by level 9. Two Handed opens at 10, goes to 6 at once, and from level 13 stays at character level to 50: Onslaught at 15, Fury at 18, Bone Splitter at 21. Slash waits at 9 until then and takes what is left: Riposte at 18 by level 20, the damage floor of a slash weapon. Then Shields again: Disable at 13 by level 23, Guard III at 15 by level 24. Parry opens at 10 and gets 5 at 24. After 24 Slash, Back Slash at 39 by level 41. Shields waits at 15 until then: Slam at 42 by level 50, with Parry 13 from the last points.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Two Handed': 24, Slash: 18, Shields: 15, Parry: 5 } },
                { level: 50, specs: { 'Two Handed': 50, Slash: 39, Shields: 42, Parry: 13 } },
            ],
            sources: [
                {
                    url: 'https://camelotherald.fandom.com/wiki/Armsman',
                    title: 'Armsman (Camelot Herald wiki)',
                    era: 'Herald wiki, live-era; excerpt',
                    says: 'Lists Two-Handed interchangeably with Polearm in the 50, 42, 39, 13 hybrid.',
                    checked: 'WebFetch HTTP 402. Search excerpt 2026-11-03: Hybrid is Polearm or Two-Handed 50, Shield 42, Weapon 39, Parry 13 (6 on Crush); Defensive is Shield 50, Weapon 50, Parry 31 (28 on Crush).',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-albion/',
                    title: 'Class guide, Albion (disorder.dk)',
                    era: 'Uthgard-era guide, 1.65-like; read in full',
                    says: 'Polearm or Two-Handed 50, Shield 42, weapon 30 to 39, rest Parry.',
                    checked: 'Read 2026-11-03 with WebFetch: opens and supports this.',
                },
            ],
        },
        {
            name: 'Crush and shield tank',
            role: 'Group tank who holds the front with block and parry and guards a caster.',
            why: 'The levelling advice on Uthgard: a 1H line below character level, Shield at level, Parry with the rest. The source then respecs into Polearm at 40; level 50 here is the Defensive spec on the wiki instead (Shield 50, Weapon 50, Parry 28 on Crush), so no respec is needed. Crush is not an autotrain line, so this build pays 77 more than the same one on Slash. Reaches at 24: Shields 23 Paralyze, Shields 15 Guard(3), Crush 18 Blackjack; at 50: Shields 50 Brutalize, Shields 42 Slam, Crush 50 Devastate.',
            order: "Fighter levels: Crush to 4. Shields comes with promotion at 3, Guard I at 5 by level 6, and from level 7 it stays at character level to 50: Engage at 7, Disable at 13, Guard III at 15, Incapacitate at 18, Paralyze at 23. Crush takes what is left, as far as the source's numbers at 19: Crush 15 by level 16. Parry, open from 10, then gets the rest: Parry 10 by level 19. Crush resumes, Blackjack at 18 by level 22 and Crush 19 by level 23, the source's level minus level/5 minus 1. Parry 13 by level 24. After 24 Crush closes on Shields, Crush 37 by level 40, and is at character level from 43. Parry holds at 13 until then and ends at Parry 28 by level 50.",
            basis: 'adapted',
            targets: [
                { level: 19, specs: { Shields: 19, Crush: 15, Parry: 10 } },
                { level: 24, specs: { Shields: 24, Crush: 19, Parry: 13 } },
                { level: 50, specs: { Shields: 50, Crush: 50, Parry: 28 } },
            ],
            sources: [
                {
                    url: 'https://www.uthgard.net/forum/viewtopic.php?f=99&t=44202',
                    title: 'Armsman leveling spec (Uthgard forum)',
                    era: 'Uthgard, 1.65-like; excerpt',
                    says: 'Sample build: 15 Crush, 19 Shield, 10 Parry at 19; 34 Crush, 37 Shield, 21 Parry at 39; then a respec of Parry into Polearm at 40. Avoids Polearm while levelling.',
                    checked: 'WebFetch HTTP 502. Search excerpt 2026-11-03: lvl 19: 15 Crush, 19 Shield, 10 Parry; lvl 39: 34, 37, 21; lvl 40 respec of Parry into Polearm. The crush formula is level minus (level/5 plus 1).',
                },
                {
                    url: 'https://camelotherald.fandom.com/wiki/Armsman',
                    title: 'Armsman (Camelot Herald wiki)',
                    era: 'Herald wiki, live-era; excerpt',
                    says: 'Defensive (Sword/Shield) spec: Shield 50, Weapon 50, Parry 31 on Slash or Thrust, 28 on Crush, for a second block tank in PvM.',
                    checked: 'WebFetch HTTP 402. Search excerpt 2026-11-03: Hybrid is Polearm or Two-Handed 50, Shield 42, Weapon 39, Parry 13 (6 on Crush); Defensive is Shield 50, Weapon 50, Parry 31 (28 on Crush).',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
