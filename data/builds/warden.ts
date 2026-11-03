import type { ClassBuilds } from './types';

export default {
    className: 'Warden',
    notes: "Budget 437 at 24, 2223 at 50 (ClassWarden.cs:31, multiplier 15; a comment on that line reads 18). No autotrain. Starts as Naturalist with Regrowth and Nurture; Blades, Blunt and Parry wait for promotion at 5. No Shields line on this server (classxspecialization.sql:396-403), so the Eden builds with 35 or 42 Shield were not usable; it does get the Shield ability at 5 through WardenCareer (specializations.json), with no line to raise. Baseline heals come with level; spec sets their variance (HealSpellHandler.cs:253-262). Blunt is the 1:1 swap for Blades. A live Warden plays the first build's level-24 table.",
    builds: [
        {
            name: 'Support',
            role: 'Group support: pulsing bladeturn, haste, damage add and resists, with secondary heals.',
            why: "Level 24 is the table a live Warden plays, verbatim. Level 50 is Blackthorn's standard support spec verbatim, and 8 points stay over. Nurture 24: Protector's Encouragement (24), Warden's Courage (23), Bolster Health (22), Anger of Nature (self-only haste 25 %, 21), Nature's Retaliation (19), Nature's Shield (group bladeturn, not pulsing, 18; pulsing starts with Nature's Guard at 26). Regrowth 12: Attack Unfading, Major Regeneration (11). Blades 10: Glowing Blade. At 50: Reckoning of Nature (47), Nature's Wall (instant bubble, 45), Defy Lightning (49), Major Apotheosis (42).",
            order: "Nurture at character level from level 2 to 49, always bought first: 13 Fury of Nature, 18 Nature's Shield, 21 Anger of Nature, 24 Protector's Encouragement. The rest follows the live table: Blades 5 by 9, Regrowth 1 to level 10, Regrowth 7 and Blades 6 by 15, Regrowth 10 by 18, Blades 8 at 20, Regrowth 12 Attack Unfading by 22, Blades 10 Glowing Blade at 24, with 7 points banked. After 24 Nurture goes on: 26 Nature's Guard (the first pulsing bubble, instant), 36 Nature's Barrier, 45 Nature's Wall, 49 Defy Lightning. Regrowth takes the rest: 20 Major Restoration by 33, 26 Major Resuscitation by 41, 33 Major Renascence by 45, 42 Major Apotheosis at 50. Parry 8 last, at 50.",
            basis: 'adapted',
            targets: [
                { level: 10, specs: { Nurture: 10, Blades: 5 } },
                { level: 15, specs: { Nurture: 15, Regrowth: 7, Blades: 6 } },
                { level: 20, specs: { Nurture: 20, Regrowth: 10, Blades: 8 } },
                { level: 24, specs: { Nurture: 24, Regrowth: 12, Blades: 10 } },
                { level: 50, specs: { Nurture: 49, Regrowth: 42, Blades: 10, Parry: 8 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/warden-guide',
                    title: 'Warden guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Standard support spec 49 Nurture, 42 Regrowth, 10 Blades, 8 Parry. Blades 10 for the side snare; Regrowth 33 with more Parry is its lower-mana variant.',
                },
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=98',
                    title: 'Warden - Heal and leveling guid (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'Replies treat 10 Blades as required on a support Warden for the side snare. Its Shield numbers do not apply here.',
                },
            ],
        },
        {
            name: 'Melee support',
            role: 'Support who also adds real melee damage and interrupts.',
            why: "Level 50 is disorder.dk verbatim (49 Nurture, 33 Regrowth, 25 Blades, 14 Parry). Blackthorn offers 49/33/27/8 for more damage and 49/33/27 Parry/10 for more defence. Level 24 is ours. Nurture 21: Anger of Nature (25 %), Nature's Shield. Blades 15: Auroric Blade. Regrowth 8: Major Revival (82), Solar Conversion (6). Parry 9. At 50: Nature's Wall, Major Renascence (33), Kinetic Blade (25).",
            order: "Nurture at character level from level 2 to 13 Fury of Nature, with the spare points from promotion in Blades: 4 Return Blade by 8, 6 Taunting Blade by 11, 10 Glowing Blade by 14. Regrowth 5 Major Resurgance by 15 and 8 Major Revival by 16. Nurture back up: 15 Benefactor's Encouragement by 17, 18 Nature's Shield by 19, 21 Anger of Nature at 21. Blades 15 Auroric Blade by 23, Parry 9 at 24, with 9 points banked. After 24 Nurture climbs back to character level by 30: 26 Nature's Guard by 27, 30 Hostility of Nature, 36 Nature's Barrier, 38 Aggression of Nature. The spare points buy Blades 18 Fire Blade by 32, then Regrowth 12 Attack Unfading by 35 and 20 Major Restoration at 40. From 41 Nurture on to 49 (45 Nature's Wall, 47 Reckoning of Nature, 49 Defy Lightning), Blades 21 Horizon Blade by 42 and 25 Kinetic Blade by 44, Regrowth 26 Major Resuscitation by 47 and 33 Major Renascence at 50. Parry 14 last, at 50.",
            basis: 'adapted',
            targets: [
                { level: 16, specs: { Nurture: 13, Blades: 10, Regrowth: 8 } },
                { level: 24, specs: { Nurture: 21, Blades: 15, Regrowth: 8, Parry: 9 } },
                { level: 40, specs: { Nurture: 38, Blades: 18, Regrowth: 20, Parry: 9 } },
                { level: 50, specs: { Nurture: 49, Blades: 25, Regrowth: 33, Parry: 14 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Good support spec: 49 Nurture, 33 Regrowth, 25 Blades, 14 Parry, for buffs, resists, pulsing blade turn and interrupts.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/warden-guide',
                    title: 'Warden guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Variants at 49 Nurture, 33 Regrowth with 27 Blades, 8 Parry or 27 Parry, 10 Blades.',
                },
            ],
        },
        {
            name: 'Solo melee',
            role: 'Solo PvE levelling: weapon at level with self buffs from Nurture.',
            why: "Rule from disorder.dk (weapon at or one below level, the rest in Nurture); numbers ours. Blades 24: Horizon Blade (21) opens only after a block. Fire Blade (18) is the only one with no opening; Glowing Blade (10) needs the side, Auroric Blade (15) follows Glowing Blade, and Lunging Blade (12) follows Return Blade (4), which needs a parry while Parry stays at 1 here. Nurture 15: Benefactor's Encouragement, Nature's Vengeance (14), Fury of Nature (21 %, 13), Nature's Fend (10). Regrowth 5: Major Resurgance. Level 50 spends exactly 2223: Brilliant Blade (50), Aggression of Nature (34 %, 38), Major Restoration and Cure Nearsight I (Regrowth 20). Not a group spec; a free /respec all moves it to Support at any level.",
            order: "Levels 2-4 buy Nurture 4. From promotion Blades at character level (from 8) to 50: 10 Glowing Blade, 15 Auroric Blade, 18 Fire Blade, 21 Horizon Blade, 25 Kinetic Blade, 50 Brilliant Blade. Nurture takes the spare points from 9: 5 Nature's Revenge by 9, 8 Rage of Nature by 13, 10 Nature's Fend by 16, 13 Fury of Nature by 20, 14 Nature's Vengeance by 21, 15 Benefactor's Encouragement by 23. Regrowth 5 Major Resurgance at 24. After 24: Nurture 21 Anger of Nature by 32, 26 Nature's Guard by 39, 30 Hostility of Nature by 42, 38 Aggression of Nature by 47. Regrowth 20 Major Restoration last, at 50.",
            basis: 'derived',
            targets: [
                { level: 24, specs: { Blades: 24, Nurture: 15, Regrowth: 5 } },
                { level: 50, specs: { Blades: 50, Nurture: 38, Regrowth: 20 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Solo: weapon skill at or one below level, the rest in Nurture. Group option is Nurture-focused.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
