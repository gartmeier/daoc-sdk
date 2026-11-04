import type { ClassBuilds } from './types';

export default {
    className: 'Ranger',
    notes: "Budget 584 at 24, 2979 at 50 (ClassRanger.cs:15, multiplier 20). Recurve Bow autotrains: spec levels up to character level / 4 are free, 6 at 24 and 12 at 50, once trained (ClassRanger.cs:9, train.cs:115). The class also lists Archery for autotrain, which is not one of its lines. Celtic Dual is acquired only at level 10 (classxspecialization; classes.json). Starts as Stalker with Stealth, Blades, Piercing. Pathfinding holds all the self buffs here and is a spec line (hint 50 in spelllines.json), so Eden specs that skip it do not apply: that is why Eden's numbers were adapted. On this server the Stealth line gives a Ranger none of the Distraction, Danger Sense or Safe Fall abilities (specializations.json lists classes 4, 9, 23, 49 only). Ice Storm's stun at Celtic Dual 18 is Blademaster-only here (stylexspell.sql:198), against what the Blackthorn Ranger page says. Caveat for bots: sdk/API.md has no helper for bow attacks or stealth; the bow builds need that written first. Piercing is the sourced weapon; Blades costs the same.",
    builds: [
        {
            name: 'Melee Celtic Dual',
            role: 'Stealth-capable dual-wielder that fights in melee with self buffs and a free bow.',
            why: "Level 50 is disorder.dk verbatim and spends exactly 2979 because Recurve Bow 12 is free. Level 24 is ours, from disorder's levelling rule (Pathfinding 1-3 under level, then weapon, leftovers in Celtic Dual). Pathfinding 23: Steel Mind (AF 33, 23), Sharpened Strike (damage add 4.2, 21), Focus of Will (20), Enhanced Senses (Dex/Qui 37, 19), Greater Forest Shadow (16). Piercing 21: Copperhead (side snare). Celtic Dual 12: Blizzard. Recurve Bow 6: Critical Shot 2, free. At 50: Superior Coordination (40), Solar Flare (39).",
            order: "Levels 2-4 buy Piercing 4. Piercing stays at character level to 21 Copperhead at 21 (10 Scorpion, 15 Tarantula, 18 Sidewinder). Pathfinding takes the spare points from promotion, about two levels behind: 5 Piercing Strike and 6 Sharpened Senses by 8, 9 Forest Shadow by 11, 10 Incisive Strike by 13, 12 Keen Sight by 14, 15 Cutting Strike by 17, 19 Enhanced Senses by 21, 21 Sharpened Strike by 22, 23 Steel Mind at 23. Celtic Dual from its level 10: 4 Blinding Rain by 12, 12 Blizzard at 24. Recurve Bow is last in line, so even its free levels wait: 1 until 24, then 6 at no cost. After 24 Celtic Dual first: 18 Ice Storm by 26, 21 Hurricane by 27, 25 Tornado by 29, 29 Tempest by 31. Piercing 25 Diamondback by 32. Pathfinding 25 Forest Spirit by 33, 29 Honed Reflexes at 35. Celtic Dual 34 Meteor Shower by 37, 39 Solar Flare at 39, 42 at 42. Piercing 29 Viper's Bite by 41, 35 by 43. Pathfinding 36 Unerring Strike by 45, 40 Superior Coordination by 46. Stealth 35 and Recurve Bow 12, free, last at 50.",
            basis: 'adapted',
            targets: [
                { level: 12, specs: { Piercing: 12, Pathfinding: 9, 'Celtic Dual': 4 } },
                { level: 24, specs: { Piercing: 21, Pathfinding: 23, 'Celtic Dual': 12, 'Recurve Bow': 6 } },
                { level: 35, specs: { 'Celtic Dual': 29, Piercing: 25, Pathfinding: 29, 'Recurve Bow': 6 } },
                { level: 50, specs: { 'Celtic Dual': 42, Piercing: 35, Pathfinding: 40, Stealth: 35, 'Recurve Bow': 12 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Melee-range spec 42 Celtic Dual, 40 Pathfinding, 35 Pierce, 35 Stealth, 12 Bow. For levelling: Pathfinding 1-3 under level, the rest in weapon, leftovers in Celtic Dual or Stealth, Bow left to autotrain.',
                },
            ],
        },
        {
            name: 'Hybrid bow',
            role: 'Opens at range, then finishes with Piercing and some Celtic Dual.',
            why: "Level 50 is disorder.dk verbatim (2949 of 2979 once the free 12 bow levels count). Level 24 is ours. Recurve Bow 21: Critical Shot 7. Pathfinding 21 as above, without Steel Mind. Piercing 12: Black Widow, Scorpion (10). Stealth 9. Celtic Dual 4: Blinding Rain. At 50: Rapid Fire 1 (Bow 35), Penetrating Arrow 1 (Bow 30), Cobra's Bite (Piercing 39).",
            order: "Levels 2-4 buy Piercing 4. From promotion Pathfinding at character level to 15 Cutting Strike (5 Piercing Strike, 9 Forest Shadow, 12 Keen Sight). Recurve Bow takes the spare points two or three levels behind, with level/4 of its levels free: Critical Shot stops at 3 by 8, 6 by 9, 9 by 11, 12 by 14, 15 by 16. Levels 16-18 buy Piercing 12 Black Widow. Pathfinding 20 Focus of Will at 20 and 21 Sharpened Strike at 21, Recurve Bow 18 by 22 and 21 by 23. Stealth 9 and Celtic Dual 4 Blinding Rain at 24, with 14 points banked. After 24 Recurve Bow leads: 27 at 27, 30 Penetrating Arrow I at 30, 35 Rapid Fire I at 35. Pathfinding takes the rest: 23 Steel Mind by 28, 29 Honed Reflexes by 33, 40 Superior Coordination at 40. Piercing stays at 12 to level 38, then 18 Sidewinder at 40, 29 Viper's Bite by 43, 39 Cobra's Bite by 45. Stealth 35 by 49, Celtic Dual 18 last, at 50, with 30 points over.",
            basis: 'adapted',
            targets: [
                { level: 18, specs: { Pathfinding: 15, 'Recurve Bow': 15, Piercing: 12 } },
                { level: 24, specs: { Pathfinding: 21, 'Recurve Bow': 21, Piercing: 12, Stealth: 9, 'Celtic Dual': 4 } },
                { level: 50, specs: { 'Recurve Bow': 35, Pathfinding: 40, Piercing: 39, Stealth: 35, 'Celtic Dual': 18 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'More hybrid bow spec: 40 Pathfinding, 39 Pierce, 35 Bow, 35 Stealth, 18 Celtic Dual.',
                },
            ],
        },
        {
            name: 'Sniper',
            role: 'Maximum bow damage from stealth, little melee.',
            why: 'Idea and the 50 Bow come from an Eden post (50 Bow, 30 Weapon, 35 Celtic Dual, 36 Stealth, read through a search summary). That spec has no Pathfinding, which here holds every self buff, so the rest was refitted and is ours. Recurve Bow 24: Critical Shot 8. Pathfinding 19: Enhanced Senses, Devotion (18). Piercing 10, Stealth 10. At 50: Penetrating Arrow 3 (50), Rapid Fire 2 (45), Superior Coordination (40). Spends exactly 2979.',
            order: 'Levels 2-4 buy Piercing 4. From promotion Recurve Bow at character level (from 7) to 50, with Critical Shot stops at 3, 6, 9, 12, 15, 18, 21, 24. Pathfinding takes the spare points from 7, one to three levels behind from 8: 5 Piercing Strike by 8, 9 Forest Shadow by 11, 15 Cutting Strike by 16, 18 Devotion by 19, 19 Enhanced Senses at 20. Levels 20-22 buy Piercing 10 Scorpion, levels 22-24 Stealth 10, with 8 points banked. After 24 the Bow goes on: 27, 30 Penetrating Arrow I, 35 Rapid Fire I, 40 Penetrating Arrow II, 45 Rapid Fire II, 50 Penetrating Arrow III. Pathfinding takes the spare points: 23 Steel Mind by 27, 29 Honed Reflexes by 32, 34 Greater Forest Spirit by 37, 40 Superior Coordination by 41. Stealth 35 by 48, Piercing 24 and Celtic Dual 8 last, at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { 'Recurve Bow': 24, Pathfinding: 19, Piercing: 10, Stealth: 10 } },
                { level: 50, specs: { 'Recurve Bow': 50, Pathfinding: 40, Stealth: 35, Piercing: 24, 'Celtic Dual': 8 } },
            ],
            sources: [
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=4374',
                    title: 'Best spec for the ranger (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'Sniper spec at 50 Bow, 30 Weapon, 35 Celtic Dual, 36 Stealth, and a hybrid at 46 Bow, 44 Celtic Dual, 36 Stealth, 24 Weapon. Neither has Pathfinding.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
