import type { ClassBuilds } from './types';

export default {
    className: 'Blademaster',
    notes: "Budget 584 at 24, 2979 at 50 (ClassBlademaster.cs:31, multiplier 20). No autotrain. Starts as Guardian with Blades, Blunt, Piercing, Parry; Shields waits for promotion and Celtic Dual is acquired at 5 (classes.json). Weapon line is a free choice: Piercing and Blunt cost the same as Blades. Style stops differ: Blades 21 Horizon Blade needs a block, Piercing 21 Copperhead is a side snare and 25 Diamondback is an after-evade stun, Blunt 21 Unstoppable Force snares. Ice Storm's 4 s stun (Celtic Dual 18) is class-limited to Blademaster in this DB (stylexspell.sql:198). A live Blademaster plays the first build's level-24 goal.",
    builds: [
        {
            name: 'Weapon at level, dual-wield',
            role: 'Solo and PvE melee damage: steady main-hand hits with an offhand that swings often.',
            why: "Level 24 is the goal a live Blademaster plays, and it follows disorder.dk's rule (weapon at level, leftovers in Celtic Dual). 573 of 584 points, confirmed in learnings/npc-dialog.md:58. Blades 24: Fire Blade (18), Glowing Blade (10); Horizon Blade (21) needs a block, which needs a shield (GameLiving.cs:1167), so it does not open in this dual-wield build. Celtic Dual 21: Hurricane (21), Ice Storm side stun (18), Blizzard (12). Level 50 is ours from the same rule: Brilliant Blade (50), Twin Star (44), rest in Parry. No source gave those numbers.",
            order: 'Blades at character level from level 2 to 50. Celtic Dual takes the spare points from promotion, one to three levels behind: 4 Blinding Rain by 7, 8 Snow Shower by 10, 12 Blizzard by 14, 18 Ice Storm by 19, 21 Hurricane by 22. Parry stays at 1 until then; levels 22-24 buy Parry 9. After 24 Celtic Dual runs two or three levels behind: 25 Tornado by 28, 29 Tempest by 31, 34 Meteor Shower by 36, 39 Solar Flare by 41, 44 Twin Star at 44. Parry takes everything after that: 21 by 45, 37 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Blades: 24, 'Celtic Dual': 21, Parry: 9 } },
                { level: 50, specs: { Blades: 50, 'Celtic Dual': 44, Parry: 37 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'For levelling: weapon skill at character level, leftover points in Celtic Dual for offhand hit chance. No level-specific numbers.',
                },
            ],
        },
        {
            name: 'Group damage with Slam',
            role: 'Assist-train damage in a group, adding a 9 s stun at 42 Shields.',
            why: 'Level 50 is the Blackthorn group spec verbatim (the Eden thread agrees), and 24 leftover points go to Parry 6. 42 Shields is Slam, a 9 s stun with no opening requirement, here too. Level 24 is ours. Celtic Dual 21 and Blades 21 as above; Shields 13 gives Disable (4 s side stun), Numb (3), Stun (8, after block) and Guard 2. 14 points stay banked. Note that Celtic Dual styles and a shield do not go together, so this build carries both a dual-wield and a shield setup.',
            order: 'Levels 2-4 buy Blades 4. Promotion buys Shields first: 3 Numb at 5, 5 Guard I at 6. Then Blades at character level to 18 Fire Blade, with Celtic Dual two to five levels behind on the spare points: 4 Blinding Rain by 9, 8 Snow Shower by 11, 12 Blizzard by 15, 18 Ice Storm by 19. Levels 20-22 buy Parry 6 and Shields 13 (10 Guard II, 13 Disable). Celtic Dual 21 Hurricane by 23, Blades 21 at 24, with 14 points banked. After 24 Celtic Dual at character level to 50: 25 Tornado by 26, 29 Tempest at 29, 34 Meteor Shower at 34, 44 Twin Star at 44, 50 Supernova at 50. The spare points go to Blades 29 Dancing Blade by 33, then from 35 to Shields: 15 Guard III at 35, 23 Paralyze by 39, 29 Bash by 42, 35 Mangle by 44, 42 Slam by 47. Blades 39 Spectrum Blade last, at 50.',
            basis: 'adapted',
            targets: [
                { level: 19, specs: { Shields: 5, Blades: 18, 'Celtic Dual': 18 } },
                { level: 24, specs: { Parry: 6, Shields: 13, 'Celtic Dual': 21, Blades: 21 } },
                { level: 34, specs: { 'Celtic Dual': 34, Blades: 29, Shields: 13, Parry: 6 } },
                { level: 50, specs: { 'Celtic Dual': 50, Shields: 42, Blades: 39, Parry: 6 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/blademaster-guide',
                    title: 'Blademaster guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Calls 50 Celtic Dual, 42 Shield, 39 weapon the most common spec; the weapon may be Blades, Pierce or Blunt.',
                },
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=688',
                    title: 'List of General specs for each class? (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'A search summary quotes the original poster: Celtic Dual 50, 39 Blade or Pierce, 42 Shield, the rest in Parry. The same poster says they were unsure about much of the list.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
