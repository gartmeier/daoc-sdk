import type { ClassBuilds } from './types';

export default {
    className: 'Enchanter',
    notes: "Budget 299 at 24, 1494 at 50 (ClassEnchanter.cs:31, multiplier 10). No autotrain. Starts as Magician with Light and Mana; Enchantments waits for promotion at 5. Sources say Light Magic and Mana Magic; the keys are Light and Mana. Blackthorn's 48 Mana misses the top heat debuff on this server: Empower Heat is Mana 49 here (spelllines.json, Empowering), while Disenchanting Eruption is 48. A Mana Enchanter still has the Light baseline with level (Sun Streak 88 at 24, Prismatic Flash stun at 15), but at Light 1 its damage minimum is 20.8 % (SpellHandler.cs:2748-2763).",
    builds: [
        {
            name: 'Mana nuker',
            role: 'Main-assist debuffer and PBAoE bomber, the common group and levelling shape.',
            why: "Level 50 is disorder.dk's 49 Mana, 22 Light verbatim, plus 14 of the 18 leftover points in Enchantments 5. Level 24 follows disorder's rule (Mana at level) and uses all 299. Mana 24: Disenchanting Emission (PBAoE 133, 20), Amplify Matter (23), Amplify Cold (24), Aura of Resonation (22). At 50: Disenchanting Eruption (325, 48), Empower Heat (49). Light 22: Deceiving Rapture, Dazzling Torch (21), Blinding Scintillation (20).",
            order: 'Mana at character level from level 2, which uses every point through 40: 7 Minor Disenchanting Emanation, 11 Disenchanting Emanation, 16 Lesser Disenchanting Emission, 20 Disenchanting Emission, 23 Amplify Matter, 24 Amplify Cold, 26 Lesser Disenchanting Burst, 27 Amplify Heat, 32 Disenchanting Burst, 33 Endow Matter, 39 Lesser Disenchanting Eruption. From 40.5 the half levels buy Light while Mana keeps pace to 49 (44 Empower Matter, 46 Empower Cold, 48 Disenchanting Eruption, 49 Empower Heat): Light 14 by 45, 22 Deceiving Rapture at 50. Enchantments 5 last, at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Mana: 24 } },
                { level: 50, specs: { Mana: 49, Light: 22, Enchantments: 5 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Calls 49 Mana, 22 Light a good RvR spec with the best debuffs and second-best PBAE, but high-variance single-line nukes. For levelling: Mana at level, cheap and efficient, with a damage shield on the pet.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/enchanter-guide',
                    title: 'Enchanter guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Group spec 48 Mana, 24 Light: mandatory heat debuff and strongest bomb, plus blue and green instant debuffs from Light. Most PvE Enchanters go Mana.',
                },
            ],
        },
        {
            name: 'Light nuker',
            role: 'Single-target nukes and instant debuffs for solo roaming and duels.',
            why: 'Blackthorn names the build for solo but gives no numbers, so all numbers are ours. Light 22: Deceiving Rapture (102, 22), Dazzling Torch (melee debuff, 21), Blinding Scintillation (haste debuff, 20), Field of Scintillation (AoE, 17). Mana 9: Aura of Reflection, Minor Disenchanting Emanation (PBAoE 52, 7). At 50: Insidious Rapture (209, 45), Galaxy of Scintillation (46), Dazzling Strobe (41); Mana 28: Amplify Heat (27), Lesser Disenchanting Burst (26). Point 28 adds no spell on Empowering (next stop 30), only less bomb variance; it is the Eldritch number, where 28 is a real stop.',
            order: 'Light at character level from level 2 to 22 Deceiving Rapture (17 Field of Scintillation, 20 Blinding Scintillation, 21 Dazzling Torch), which uses every point. Levels 23-24 buy Mana 9 Aura of Reflection. After 24 Light runs two levels behind: 28 Beguiling Rapture by 30, 31 Dazzling Flare by 33, 35 Phantom Rapture by 37, 37 Sky of Scintillation by 39. Then Mana: 16 Lesser Disenchanting Emission by 41, 20 Disenchanting Emission by 42, 24 Amplify Cold by 43, 27 Amplify Heat and 28 by 45. Light 41 Dazzling Strobe by 47, 45 Insidious Rapture and 46 Galaxy of Scintillation last, at 50.',
            basis: 'derived',
            targets: [
                { level: 24, specs: { Light: 22, Mana: 9 } },
                { level: 45, specs: { Light: 37, Mana: 28 } },
                { level: 50, specs: { Light: 46, Mana: 28 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/enchanter-guide',
                    title: 'Enchanter guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Solo and duel build leaning on Light for a stronger single-target nuke and better instant debuffs. No spec numbers.',
                },
            ],
        },
        {
            name: 'Pet buffer',
            role: 'Solo play behind a strongly buffed Underhill pet.',
            why: "Niche. The Eden walkthrough reports 49 Enchantments, 22 Light; that post was read only through a search summary and Eden's rules differ: the summary names a Protection of the Underhill buff as central, and spells.json has no spell of that name. The pet itself is baseline with level (Underhill Friend 1, Compatriot 20, Zealot 32); the spec line buffs it, with Str/Con and Dex/Qui targeting the pet and damage adds targeting any realm member. Enchantments 20: Glowing Arms (20), Trickiness (19), Power of the Underhill (18). Light 12: Duplicitous Rapture, Dazzling Flash (11). Level 24 is ours; 13 points stay banked there and 18 at 50, because the next Mana stop costs more. Bots keep the pet up and buffed and send it at the focus (sdk/group/pets.ts); no round has been run with it.",
            order: 'Levels 2-4 bank everything: the first target is empty. At promotion the 14 points buy Enchantments 5, and it stays at character level to 20, which uses every point: 12 Zest of the Underhill, 13 Slyness, 15 Shimmering Arms, 18 Power of the Underhill, 19 Trickiness, 20 Glowing Arms. Levels 21-24 buy Light 12 (11 Dazzling Flash, 12 Duplicitous Rapture), with 13 points banked. After 24 Enchantments runs three levels behind: 24 Vim of the Underhill by 27, 26 Glittering Arms by 29, 32 Force of the Underhill by 35, 34 Brilliant Arms by 37. The half levels from 40.5 bring it back to character level: 42 Fury of the Underhill by 43, 44 Splendorous Arms at 44, 49 Splendorous Armor at 49. Light 14 by 45, 22 Deceiving Rapture at 50.',
            basis: 'derived',
            targets: [
                { level: 4, specs: {} },
                { level: 24, specs: { Enchantments: 20, Light: 12 } },
                { level: 50, specs: { Enchantments: 49, Light: 22 } },
            ],
            sources: [
                {
                    url: 'https://eden-daoc.net/viewtopic.php?t=4708',
                    title: 'Melee Enchanter Walkthrough (Eden forum)',
                    era: 'Eden freeshard, live-era class rules, posts about 2022-2025. Direct fetch returned 403, so this was read only through a search-result summary',
                    says: 'Reports a tested build at 49 Enchantments, 22 Light, and says min-maxers would likely skip it.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
