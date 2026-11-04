import type { ClassBuilds } from './types';

export default {
    className: 'Nightshade',
    notes: "Budget 633 at 24, 3253 at 50 (ClassNightshade.cs:33, multiplier 22). Stealth autotrains: spec levels up to character level / 4 are free, 6 at 24 and 12 at 50 (ClassNightshade.cs:27, train.cs:115). It must still be trained: nothing raises it automatically on this server (train.cs:115, GamePlayer.cs:9962 comment). Nightshade Magic is not trainable: its DB implementation is LiveCareerSpecialization (specialization.sql:93), and its spells come with character level with fixed variance (SpellHandler.cs:2780-2787). A source listing points in it would not apply. Starts as Stalker with Stealth, Blades, Piercing; Celtic Dual from 5, others after promotion. Blades or Piercing is a free swap. Ice Storm's stun is Blademaster-only here (stylexspell.sql:198), so Celtic Dual 18 is not a stun for this class. Caveat for bots: sdk/API.md has no helper for stealth or applying poisons, so Critical Strike openers and Envenom need that written first.",
    builds: [
        {
            name: 'Stealth assassin',
            role: 'Opens from stealth with Critical Strike and leans on poisons.',
            why: 'Level 50 is disorder.dk verbatim, with its Weapon as Piercing, and leaves 94 points over. Critical Strike 44: Rib Separation, Creeping Death (7 s stun, 34). Envenom 35: Major Lethal Venom. Celtic Dual 25: Tornado. Level 24 is ours and goes against both cited levelling rules: disorder.dk keeps weapon and poison at level, and the Eden summary keeps Critical Strike and weapon near 3/4 of level, Envenom as high as possible, and warns against a Critical Strike build before 50. Critical Strike 21: Perforate Artery (21), Garrote (18), Hamstring (12), Backstab II (10). Piercing 17: Tarantula (15). Stealth 16: Detect Hidden (16), Safe Fall 1, Danger Sense. Envenom 15: Major Lethal Poison, Lesser Toxic Poison Proc (14). Celtic Dual 4: Blinding Rain.',
            order: "Levels 2-4 buy Piercing 4. From promotion Critical Strike at character level to 10 Backstab II, with the spare points in Piercing to 9. Envenom 5 and Stealth 8 Danger Sense by 12. Piercing 12 Black Widow by 13 and 15 Tarantula at 15, Critical Strike 12 Hamstring by 15 and 15 Thigh Cut by 17. Envenom 10 by 18, Stealth 16 Detect Hidden at 20. Critical Strike 18 Garrote by 21 and 21 Perforate Artery by 22, Piercing 17 by 23, Envenom 15 and Celtic Dual 4 Blinding Rain at 24, with 8 points banked. After 24 Envenom leads: 30 at 30. Critical Strike 25 Achilles Heel by 31 and 29 Leaper by 33, Piercing 21 Copperhead by 34 and 25 Diamondback at 35. Envenom 35 by 37, Critical Strike 34 Creeping Death by 39, 39 Stunning Stab by 41, 44 Rib Separation at 44. Piercing 29 Viper's Bite by 43, 34 Asp's Bite by 44, 36 by 45. Stealth 25 Climb Walls by 46 and 35 by 48, Celtic Dual 25 Tornado last, at 50, with 94 points over.",
            basis: 'adapted',
            targets: [
                { level: 12, specs: { 'Critical Strike': 10, Piercing: 9, Envenom: 5, Stealth: 8 } },
                { level: 20, specs: { Piercing: 15, 'Critical Strike': 15, Envenom: 10, Stealth: 16 } },
                { level: 24, specs: { 'Critical Strike': 21, Piercing: 17, Envenom: 15, Stealth: 16, 'Celtic Dual': 4 } },
                { level: 35, specs: { Envenom: 30, 'Critical Strike': 29, Piercing: 25, Stealth: 16, 'Celtic Dual': 4 } },
                { level: 50, specs: { Envenom: 35, 'Critical Strike': 44, Piercing: 36, Stealth: 35, 'Celtic Dual': 25 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Good endgame spec: 44 Critical Strike, 36 Weapon, 35 Stealth, 35 Poison, 25 Celtic Dual. For levelling: weapon and poison at level, leftovers in Celtic Dual, Stealth autotrained.',
                },
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=4369',
                    title: 'Nightshade leveling build (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'Keeps Piercing and Critical Strike around 3/4 of level with Envenom as high as possible, and warns against early Celtic Dual and against a Critical Strike build before 50.',
                },
            ],
        },
        {
            name: 'Dual-wield damage',
            role: 'Sustained melee: Piercing and poisons while levelling, then high Celtic Dual for offhand swings.',
            why: "Level 50 is the Eden RR7 split, which fits this budget at 3220 of 3253; that post was read only through a search summary, and it ties these numbers to realm rank 7, which was not checked against this server. Level 24 is ours from disorder's rule (weapon and poison at level) and Eden's warning about early Celtic Dual. Piercing 24: Copperhead (side snare, 21), Sidewinder (18), Tarantula (15). Envenom 20: Greater Lethal Poison, Toxic Poison Proc (19), Greater Imbalancing Poison (18). Critical Strike 10: Backstab II. Celtic Dual 10: Gale. Stealth 8: Danger Sense. At 50: Twin Star (44), Asp's Bite (34), Creeping Death (34).",
            order: "Levels 2-4 buy Piercing 4, and Piercing stays at character level to 24: 10 Scorpion, 15 Tarantula, 18 Sidewinder, 21 Copperhead. Envenom takes the spare points from promotion: 5 by 7, 10 by 11, 15 at 15, 20 at 20. Critical Strike 10 Backstab II by 22, Celtic Dual 4 Blinding Rain by 22 and 10 Gale at 24, Stealth 8 Danger Sense at 24, with 2 points banked. After 24 Celtic Dual first: 12 Blizzard at 25, 21 Hurricane by 28, 25 Tornado by 29, 29 Tempest by 31, 34 Meteor Shower at 34. On the way Piercing 25 Diamondback by 32 and 29 Viper's Bite by 35, then Envenom 25 by 36 and Critical Strike 25 Achilles Heel by 39. From 40: Celtic Dual 39 Solar Flare by 41, 44 Twin Star at 44, Envenom 33 by 44, Critical Strike 29 Leaper by 45, 34 Creeping Death by 46, Piercing 34 Asp's Bite by 47. Stealth 33 last, at 50, with 33 points over.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Piercing: 24, Envenom: 20, 'Critical Strike': 10, 'Celtic Dual': 10, Stealth: 8 } },
                { level: 39, specs: { 'Celtic Dual': 34, Piercing: 29, Envenom: 25, 'Critical Strike': 25, Stealth: 8 } },
                { level: 50, specs: { 'Celtic Dual': 44, Envenom: 33, 'Critical Strike': 34, Piercing: 34, Stealth: 33 } },
            ],
            sources: [
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=5787',
                    title: 'Nightshade & Recorder (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'At RR7, 33 Stealth, 33 Envenom, 34 Critical Strike, 34 Piercing, 44 Celtic Dual, and argues Piercing over Slash.',
                },
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=1791',
                    title: 'Nightshade Templates (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'A tester compared 44 Piercing, 34 Celtic Dual with the reverse and found more damage from the higher Celtic Dual. A single test.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'For levelling: weapon and poison at level, leftovers in Celtic Dual.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
