import type { ClassBuilds } from './types';

export default {
    className: 'Mentalist',
    notes: "Budget 299 at 24, 1494 at 50 (ClassMentalist.cs:31, multiplier 10). No autotrain. Starts as Magician with Light and Mana; Mentalism waits for promotion at 5. Sources say Light Magic and Mana Magic; the keys are Light and Mana. On this server Illusions has nothing above 45, Mentalism nothing between 28 and 31, so the sources' 46 Light and 29 Mentalism buy no spell here and the numbers were adapted. /respec all is free at any level here (respec.cs:96, 153), so a Mana-levelled Mentalist can move to the Light build at any time.",
    builds: [
        {
            name: 'Light nuker',
            role: 'Damage in caster groups with charm, plus demez from Mentalism at 50.',
            why: "Level 50 adapts disorder.dk's 46/28/4 and Blackthorn's 45/29. Light 45: Coruscating Visions (209), Cataclysm of Illusion (AoE, 44), Dream Enemy (charm, 42). Mentalism 28: Mental Purification (the demez, 28), Major Somatic Rehabilitation (25), Paralyze Mind (23). The points this frees go to Mana 10: Curative Trance (10) and Empowering Unity (4). Level 24 is ours. Light 22: Glittering Visions (102), Rush of Illusion (AoE 72, 19), Imaginary Enemy (charm, 17). Mentalism 9: Cripple Mind (mez, 5), Delirium (8), Major Somatic Relief (91, 9).",
            order: 'Light at character level from level 2 to 22 Glittering Visions (17 Imaginary Enemy, 19 Rush of Illusion), which uses every point. Levels 23-24 buy Mentalism 9 (5 Cripple Mind, 8 Delirium, 9 Major Somatic Relief). After 24 Light runs two levels behind: 25 Phantom Enemy by 27, 28 Radiant Visions by 30, 33 Ghostly Enemy by 35, 35 Bedazzling Visions by 37. Then Mentalism: 15 Disable Mind by 39, 18 Major Somatic Regeneration by 40, 23 Paralyze Mind by 42, 25 Major Somatic Rehabilitation by 43, 28 Mental Purification by 44. Light 42 Dream Enemy by 48, 44 Cataclysm of Illusion by 49, 45 Coruscating Visions at 50. Mana 10 Curative Trance last, at 50. A mez sooner takes a target of its own, such as Light 13 and Mentalism 5 at level 14.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Light: 22, Mentalism: 9 } },
                { level: 44, specs: { Light: 35, Mentalism: 28 } },
                { level: 50, specs: { Light: 45, Mentalism: 28, Mana: 10 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Typical PvP spec is 46 Light, 28 Mentalism, 4 Mana: nuking, charm and demez for groups. Mana is not typically specced at the end.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/mentalist-guide',
                    title: 'Mentalist guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Most common group spec is 45 Light, 29 Mentalism, the Light Ment.',
                },
            ],
        },
        {
            name: 'Mentalism healer',
            role: "Self-sufficient heals and mez, solo first. Using it as a group backup healer is this file's idea, not a source's.",
            why: 'Blackthorn names Mentalism as the solo choice without numbers, and does not call the class a backup healer, so all numbers are ours. Mentalism 23: Paralyze Mind (44 s mez, 23), Major Somatic Regeneration (172, 18), Paranoia (17), Disable Mind (15). Mana 5: Empowering Unity (4), Lesser Mind Fade (5). At 50: Unmake Mind (50), Insanity (49), Major Somatic Resuscitation (387, 42), Mental Purification (28); Mana 20: Empowering Harmony (14), Curative Trance (10), Greater Mind Dissolution (20).',
            order: 'Levels 2-4 buy Mana 4 (Empowering Unity, castable only from promotion). From promotion Mentalism one or two levels under character level, which leaves points banked: 5 Cripple Mind by 7, 10 Incapacitate Mind by 11, 13 Major Somatic Rejuvenation by 14, 15 Disable Mind by 16, 18 Major Somatic Regeneration by 19, 23 Paralyze Mind at 24. Level 24 also buys Mana 5 Lesser Mind Fade, with 10 points banked. After 24 Mentalism stays one under: 25 Major Somatic Rehabilitation by 26, 28 Mental Purification by 29, 31 Lock Mind by 32, 33 Major Somatic Revival by 34. The half levels from 40.5 bring it to character level (41 Petrify Mind, 42 Major Somatic Resuscitation, 50 Unmake Mind) and buy Mana: 14 Empowering Harmony by 45, 20 Greater Mind Dissolution at 50. Light 4 last, at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Mentalism: 23, Mana: 5 } },
                { level: 50, specs: { Mentalism: 50, Mana: 20, Light: 4 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/mentalist-guide',
                    title: 'Mentalist guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Names a Mentalism build for solo without point numbers.',
                },
            ],
        },
        {
            name: 'Mana levelling',
            role: 'PvE levelling: power regen for the group and AoE damage over time on camps.',
            why: 'disorder.dk says full Mana while levelling, Blackthorn says most PvE Mentalists level as Mana spec, and the 2002 Gameswelt guide presents a Mentalist with points mainly in Mana as one of many variants; numbers at 24 follow the disorder.dk rule, the 50 is ours. Mana 24: Empowering Tranquility (power regen 3, 24), Fog of Delirium (AoE DoT 41, 23), Restorative Trance (HoT, 21), Greater Mind Dissolution (DoT 35, 20). At 50: Complete Mind Annihilation (48), Storm of Insanity (46), Empowering Perfection (44). A free /respec all moves it to the group nuker at any level.',
            order: 'Mana at character level from level 2, which uses every point through 40: 14 Empowering Harmony, 17 Shroud of Madness, 20 Greater Mind Dissolution, 21 Restorative Trance, 23 Fog of Delirium, 24 Empowering Tranquility, 29 Hallucinatory Winds, 34 Empowering Concordance, 36 Torrent of Dementia. From 40.5 the half levels buy Mentalism while Mana keeps pace to 48 (43 Sanative Trance, 44 Empowering Perfection, 46 Storm of Insanity, 48 Complete Mind Annihilation): Mentalism 14 by 45, 24 at 50. Light 5 last, at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Mana: 24 } },
                { level: 50, specs: { Mana: 48, Mentalism: 24, Light: 5 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'For PvE: full Mana, for the regen spell and an AE damage over time to farm camps.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/mentalist-guide',
                    title: 'Mentalist guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Most PvE Mentalists level as Mana spec.',
                },
                {
                    url: 'https://www.gameswelt.de/dark-age-of-camelot/komplettloesung/komplettloesung-4617/7',
                    title: 'Hibernia: Der Mentalist (Gameswelt)',
                    era: 'Old frontiers: German guide dated 21 August 2002',
                    says: 'Presents the Mana Mentalist, with points mainly in the Mana line, as one of countless variants and of most interest to groups: small heal, power regen, damage over time, small AoE. It does not say first, full Mana or PvE. No numbers.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
