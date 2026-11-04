import type { ClassBuilds } from './types';

export default {
    className: 'Animist',
    notes: 'Budget 299 at 24, 1494 at 50 (ClassAnimist.cs:30, multiplier 10). No autotrain. Starts as Forester, whose only line is Arboreal Path (classes.json), so Creeping and Verdant wait for promotion at 5. A line kept at character level eats every point up to 40; the 220 half-level points from 40.5 on are what pay for a second line. All three lines have baselines that come with level. No source gave level-24 numbers. Caveat for bots: turrets stay out of the automatic pet behaviours of a group (sdk/group/pets.ts), so a routine in a character file has to place them, through bot.summonPet.',
    builds: [
        {
            name: 'Arboreal group',
            role: 'Group damage from a controllable pet, bombers and tanglers, with a little crowd control at 50.',
            why: "The level-50 numbers are the Blackthorn group spec verbatim. Level 24 is ours: all 299 points in the main line. Arboreal Mastery at 24 reaches Forest's Sentry (pet, 24), Spirit of Wrath (bomber, 22), Circle of Enmity (AoE bomber, 20) and Tangler Youngling (21). At 50: Circle of Vengeance (50), Elder Tangler (49), Spirit of Hatred (48), Creeping 18 Entangling Spirit (root bomber), Verdant 7 Woodspirit Sheath.",
            order: "Arboreal Path at character level from level 2 (the only line a Forester can train), which uses every point through 40, with pet stops at 5 Forest's Servant, 11 Forest's Compatriot, 18 Forest's Aid, 24 Forest's Sentry, 35 Forest's Bulwark and 44 Forest's Protector. From 40.5 the half-level points buy Creeping Path while Arboreal keeps pace to 50: 18 Entangling Spirit by 48, 19 Spore Vent by 49. Verdant Path 7 Woodspirit Sheath last, at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Arboreal Path': 24 } },
                { level: 50, specs: { 'Arboreal Path': 50, 'Creeping Path': 19, 'Verdant Path': 7 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/animist-guide',
                    title: 'Animist guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Gives 50 Arboreal, 19 Creeping, 7 Verdant as its group spec, for the best tanglers and bombers plus the green AoE root from Creeping.',
                },
            ],
        },
        {
            name: 'Creeping turret farm',
            role: 'Solo and small-group PvE: a field of fire-and-forget turrets that kill what is pulled into them.',
            why: "Blackthorn and disorder.dk name this as the PvE shape but give no numbers, so all numbers here are ours, shaped like the group spec. Creeping Path Spec at 24 reaches Dancing Flame (24), Grove's Agent (pet, 22), Spore Vent (19), Entangling Spirit (18), Sporespawn Youngling (15). At 50: Elder Sporespawn (50), Spore Cannon (46), Grove's Assassin (45).",
            order: "Levels 2-4 bank everything, since a Forester has no Creeping Path. At promotion the 14 points buy Creeping Path 5 Dancing Spark, and it stays at character level to 50, which uses every point through 40: 15 Sporespawn Youngling, 18 Entangling Spirit, 19 Spore Vent, 22 Grove's Agent, 24 Dancing Flame. From 40.5 the half levels buy Arboreal Path: 16 Spirit of Rage by 47, 18 Forest's Aid by 48. Verdant Path 9 Briar Cloud last, at 50.",
            basis: 'derived',
            targets: [
                { level: 24, specs: { 'Creeping Path': 24 } },
                { level: 50, specs: { 'Creeping Path': 50, 'Arboreal Path': 18, 'Verdant Path': 9 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/animist-guide',
                    title: 'Animist guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Describes a Creeping PvE style built on a large stack of fire-and-forget shrooms that mobs are dragged into. No spec numbers.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Names Creeping with large shroom farms as the PvE choice, and warns that the farm costs mana. No spec numbers.',
                },
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=93',
                    title: 'Animist solo pve spec (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'A reply recommends Creeping for solo levelling with fire-and-forget turrets and Verdant for groups. No numbers seen.',
                },
            ],
        },
        {
            name: 'Verdant bomber core',
            role: 'Group PvE: one main shroom holds the pull while PBAoE turret spells hit the pile.',
            why: "Idea from Blackthorn, no numbers there, all numbers ours. Verdant Path Spec at 23 reaches Briar Barrage (TurretPBAoE, 102 damage, 22), Battle Harbinger (pet, 23), Woodspirit Barrier (21), Ligneous Shield (18). 24 adds nothing over 23, so the rest goes to Arboreal 6 for Forest's Servant (5) and Spirit of Outrage (6). At 50: Briar Storm (225, 48), War Herald (49), Ligneous Seal (50).",
            order: "Levels 2-4 bank everything: the first target is empty. At promotion the 14 points buy Verdant Path 5, and it stays at character level to 23, which uses every point: 9 Briar Cloud, 13 Briar Discharge, 17 Briar Eruption, 22 Briar Barrage, 23 Battle Harbinger. Level 24 buys Arboreal Path 6 instead (5 Forest's Servant, 6 Spirit of Outrage). After 24 Verdant runs one level behind to 40: 29 Briar Explosion by 30, 39 Briar Detonation by 40. From 40.5 the half levels bring it back to character level (48 Briar Storm, 49 War Herald, 50 Ligneous Seal) and buy Arboreal 18 Forest's Aid by 48. Creeping Path 9 last, at 50.",
            basis: 'derived',
            targets: [
                { level: 4, specs: {} },
                { level: 24, specs: { 'Verdant Path': 23, 'Arboreal Path': 6 } },
                { level: 50, specs: { 'Verdant Path': 50, 'Arboreal Path': 18, 'Creeping Path': 9 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/animist-guide',
                    title: 'Animist guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Describes a Verdant PvE style: place a main shroom as the anchor, cast ABS on it and spam PBAoE bombers. No spec numbers.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
