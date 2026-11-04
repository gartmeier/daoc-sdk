import type { ClassBuilds } from './types';

export default {
    className: 'Champion',
    notes: 'Budget 584 at 24, 2979 at 50 (ClassChampion.cs:31, multiplier 20). No autotrain. Starts as Guardian with Blades, Blunt, Piercing, Parry; Large Weapons, Shields and Valor wait for promotion at 5. All Valor spells sit on the spec line (no baseline), so Valor sets what the class can cast at all. ChampionCareer is a career line and not trainable.',
    builds: [
        {
            name: 'Valor and Large Weapons',
            role: 'Off-tank that debuffs and hits hard with a two-hander, no shield.',
            why: "Level 50 is Blackthorn's most common spec verbatim. Level 24 is ours, from disorder.dk's advice (max Valor, the rest in Large Weapons). Valor 24: Enervation (Str/Con debuff 43, 24), Focus of the Champion (self Str/Con 39, 23), Blast of Defiance (61, 23), Capitulation (Dex/Qui debuff 39, 20), Major Demoralization (19). Large Weapons 23 sits past Frontal Assault (21) for weapon skill; next style is 25. At 50: Might of the Champion, Annihilation (9 s back stun).",
            order: 'Levels 2-4 buy Parry 4, which a Guardian can train. From promotion Valor at character level (from 7), with stops at 5, 10, 16, 23 for the self buff (Vigor, Strength, Fortification, Focus of the Champion) and 12, 17, 22 for the snare (Slowness, Languor, Lumber). Large Weapons takes the spare points from 7: four levels behind at 8, two behind by 12, 23 at 24. After 24 Large Weapons leads at character level (25 Gigantic Blow, 29 Ultimate Recovery, 34 Demolish), Valor one behind (32 Power of the Champion by 33, 40 Force of the Champion by 41). The half levels from 40.5 bring both to character level by 42 and buy Parry: 19 by 45, 28 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Valor: 24, 'Large Weapons': 23, Parry: 4 } },
                { level: 50, specs: { 'Large Weapons': 50, Valor: 50, Parry: 28 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/champion-guide',
                    title: 'Champion guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Most common group spec is 50 Valor, 50 Large Weaponry, 28 Parry: best self buff, debuffs, snare and damage, plus Annihilation.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'For levelling: Valor at maximum, the rest in Large Weapon, leftovers in Shield.',
                },
            ],
        },
        {
            name: 'Large Weapons with Slam',
            role: 'Melee first: the best two-hander line with a 9 s shield stun, and mid-tier debuffs.',
            why: 'Level 50 is the second Blackthorn spec verbatim. Level 24 is ours. Large Weapons 24 reaches Frontal Assault (21) and Obliteration (18). Valor 19: Major Demoralization (19), Fortification (self buff, 16), Greater Atony (16), Languor snare (17). Shields 13: Disable side stun, Numb, Guard 2. At 50: Annihilation, Slam (42), Infirmity (39), Power of the Champion (32): one tier short of Force of the Champion at 40.',
            order: 'Levels 2-3 buy Parry 3 and level 4 banks for promotion: Large Weapons 4 at 5, then at character level from 6 to 50 (15 Domination, 18 Obliteration, 21 Frontal Assault, 25 Gigantic Blow, 34 Demolish, 50 Annihilation). The spare points buy Shields 3 Numb by 7 and 5 Guard I by 8, then Valor 5 by 10, 10 Strength of the Champion by 13, 16 Fortification of the Champion by 18. Shields 10 Guard II by 20 and 13 Disable by 22. Valor 19 Major Demoralization at 24. After 24 the spare points stay in Valor: 23 Focus of the Champion by 28, 32 Power of the Champion at 36. Shields from 37: 15 Guard III at 37, 23 Paralyze by 41, 29 Bash by 42, 35 Mangle by 45, 42 Slam by 48. Valor 39 Infirmity and Parry 6 last, at 50.',
            basis: 'adapted',
            targets: [
                { level: 13, specs: { 'Large Weapons': 13, Shields: 5, Valor: 10, Parry: 3 } },
                { level: 22, specs: { 'Large Weapons': 22, Valor: 16, Shields: 13, Parry: 3 } },
                { level: 24, specs: { 'Large Weapons': 24, Valor: 19, Shields: 13, Parry: 3 } },
                { level: 36, specs: { 'Large Weapons': 36, Valor: 32, Shields: 13, Parry: 3 } },
                { level: 50, specs: { 'Large Weapons': 50, Shields: 42, Valor: 39, Parry: 6 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/champion-guide',
                    title: 'Champion guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Second spec 50 Large Weaponry, 42 Shield, 39 Valor, 6 Parry, trading one tier of debuffs for the 42 Shield stun.',
                },
            ],
        },
        {
            name: 'Debuff with Slam',
            role: 'Keeps the strongest debuffs and the shield stun at the cost of melee damage.',
            why: "Level 50 matches both sources: disorder.dk's 50 Valor, 42 Shield, 39 Large Weapon, plus Blackthorn's 6 Parry (Blackthorn only implies the split). Level 24 is ours. Valor 24 as in the first build. Large Weapons 18: Obliteration, Domination (15). Shields 13: Disable, Numb, Guard 2. Parry 6.",
            order: 'Levels 2-4 buy Parry 4. From promotion Valor at character level (from 7) to 50, the only line kept there. The spare points buy Shields 3 Numb by 8 and 5 Guard I by 9, then Large Weapons 8 Hibernian Wrath by 12 and 12 Hibernian Vigor by 15. Shields 10 Guard II by 18 and 13 Disable by 20, Large Weapons 15 Domination by 22 and 18 Obliteration at 24, Parry 6 at 24. After 24 the spare points go to Shields: 15 Guard III at 25, 23 Paralyze by 31, 29 Bash by 36, 35 Mangle by 41, 42 Slam by 44. Large Weapons holds at 18 until then, the price of this build, and takes what is left: 25 Gigantic Blow by 46, 29 Ultimate Recovery by 47, 34 Demolish by 49, 39 Shatter at 50.',
            basis: 'adapted',
            targets: [
                { level: 15, specs: { Valor: 15, Shields: 5, 'Large Weapons': 12, Parry: 4 } },
                { level: 24, specs: { Valor: 24, Shields: 13, 'Large Weapons': 18, Parry: 6 } },
                { level: 50, specs: { Valor: 50, Shields: 42, 'Large Weapons': 39, Parry: 6 } },
            ],
            sources: [
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: 'Calls 50 Valor, 42 Shield, 39 Large Weapon a decent final spec.',
                },
                {
                    url: 'https://blackthorn-daoc.com/wiki/champion-guide',
                    title: 'Champion guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Debuff-focused variation: move Valor to 50 and Large Weapon to 39, losing Annihilation. The 42 Shield and 6 Parry carry over from its previous spec.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
