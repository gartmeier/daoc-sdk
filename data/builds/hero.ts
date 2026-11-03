import type { ClassBuilds } from './types';

export default {
    className: 'Hero',
    notes: 'Budget 584 at 24, 2979 at 50 (ClassHero.cs:31, multiplier 20). No autotrain. Starts as Guardian with Blades, Blunt, Piercing, Parry; Celtic Spear, Large Weapons and Shields wait for promotion at 5. Keys: Shields, not Shield, and Large Weapons, not Large Weapon. Shield stuns on this server: Numb 3 (2 s, any time), Stun 8 (3 s, after block), Disable 13 (4 s, side), Incapacitate 18 (5 s, after block), Paralyze 23 (6 s, back), Bash 29 (7 s, after block), Mangle 35 (8 s, side), Slam 42 (9 s, any time), Brutalize 50 (10 s, after block). Guard 1, 2, 3 at Shields 5, 10, 15, Engage at 7 (specializations.json).',
    builds: [
        {
            name: 'Sword and board tank',
            role: 'PvE main tank: holds aggro with one-hand styles and blocks.',
            why: 'Blackthorn casts the Hero as a sword-and-shield main tank in PvE but its specs put Large Weapons at 50, so these numbers are ours and no source backs them. Blades 24: Horizon Blade (4 s stun after block, 21), Fire Blade (18), Glowing Blade (side snare, 10), Taunting Blade (6). Shields 18: Incapacitate, Guard 3. Parry 14. At 50: Brilliant Blade, Brutalize (50), Slam (42).',
            order: 'Blades at character level from level 2 to 50 (10 Glowing Blade, 18 Fire Blade, 21 Horizon Blade, 50 Brilliant Blade). From promotion Shields takes the spare points: 3 Numb by 6, 5 Guard I by 8, 7 Engage by 9, 10 Guard II at 12, when Parry 4 comes too. Shields 15 Guard III by 17 and 18 Incapacitate by 20, then Parry 14 at 24, with 11 points banked. After 24 Shields again: 23 Paralyze by 28, 29 Bash by 33, 35 Mangle by 39, 42 Slam by 43, 50 Brutalize at 50. Parry takes what is left: 19 by 45, 28 at 50.',
            basis: 'derived',
            targets: [
                { level: 12, specs: { Blades: 12, Shields: 10, Parry: 4 } },
                { level: 24, specs: { Blades: 24, Shields: 18, Parry: 14 } },
                { level: 50, specs: { Blades: 50, Shields: 50, Parry: 28 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/hero-guide',
                    title: 'Hero guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'PvE section describes the Hero as main tank with sword and shield, without spec numbers.',
                },
            ],
        },
        {
            name: 'Large Weapons and Slam',
            role: 'Group tank that guards with a shield and hits with a two-hander.',
            why: "Level 50 is Blackthorn's most common spec verbatim (disorder.dk gives the same range). Level 24 is ours, from disorder's levelling rule of weapon at level with the rest in Shield or Parry. Large Weapons 24: Frontal Assault (21, front snare), Obliteration (18), Hibernian Vigor (12). Shields 15: Guard 3, Disable. Blades 10: Glowing Blade for the side snare when the shield is out. Parry 14. 8 points stay banked.",
            order: 'Levels 2-4 buy Blades 4. From promotion Large Weapons at character level (from 7) to 50: 12 Hibernian Vigor, 18 Obliteration, 21 Frontal Assault, 25 Gigantic Blow, 34 Demolish, 50 Annihilation. Shields takes the spare points: 3 Numb by 8, 5 Guard I by 9, 10 Guard II by 12, 15 Guard III by 17. Blades 10 Glowing Blade by 19, Parry 14 at 24, with 8 points banked. After 24: Shields 23 Paralyze by 30, 35 Mangle by 40, 42 Slam by 44. Parry fills up: 22 by 45, 38 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Large Weapons': 24, Shields: 15, Blades: 10, Parry: 14 } },
                { level: 50, specs: { 'Large Weapons': 50, Shields: 42, Parry: 38, Blades: 10 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/hero-guide',
                    title: 'Hero guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Most common spec: 50 Large Weapon or Celtic Spear, 42 Shield for Slam, 38 Parry, 10 Blades for the side snare.',
                },
                {
                    url: 'https://disorder.dk/daoc/class-guide-hibernia/',
                    title: 'Class guide, Hibernia (disorder.dk)',
                    era: 'Uthgard freeshard, built on a 1.65 vision whose strict policy a 2018 post on the site says was relaxed. Page undated; the site runs 2008-2024',
                    says: '50 in Large Weapon or Celtic Spear, 42 to 50 Shield, the rest in a weapon and Parry. For levelling: that weapon at level, leftovers in Shield or Parry.',
                },
            ],
        },
        {
            name: 'Celtic Spear and Slam',
            role: 'As the Large Weapons build, for a spear wielder with thrust damage and a stun off a parry.',
            why: "Level 50 is the same Blackthorn spec with the Celtic Spear option. Level 24 is ours. Celtic Spear 24: Tracking Spear (5 s stun after parry, 21), Javelin (bleed, 18), Hunter's Boon (back snare, 6), Forest Spear (taunt, 10). Rest as the Large Weapons build. At 50: Cuchulain's Revenge, Dragon Talon (44).",
            order: "Levels 2-4 buy Parry 4, because Tracking Spear needs a parry to open. From promotion Celtic Spear at character level (from 7) to 50: 10 Forest Spear, 18 Javelin, 21 Tracking Spear, 44 Dragon Talon, 50 Cuchulain's Revenge. Shields takes the spare points: 3 Numb by 8, 5 Guard I by 9, 10 Guard II by 12, 15 Guard III by 17. Parry 14 by 22, Blades 10 Glowing Blade at 24, with 8 points banked. After 24: Shields 23 Paralyze by 30, 35 Mangle by 40, 42 Slam by 44. Parry fills up: 22 by 45, 38 at 50.",
            basis: 'adapted',
            targets: [
                { level: 24, specs: { 'Celtic Spear': 24, Shields: 15, Parry: 14, Blades: 10 } },
                { level: 50, specs: { 'Celtic Spear': 50, Shields: 42, Parry: 38, Blades: 10 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/hero-guide',
                    title: 'Hero guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Same spec line allows Large Weapon or Celtic Spear at 50.',
                },
            ],
        },
        {
            name: 'Shield-heavy',
            role: 'Better block and guard rate, trading Parry.',
            why: "Level 50 is Blackthorn's second spec verbatim and uses the whole 2979. Level 24 is ours. Shields 23: Paralyze (6 s back stun), Incapacitate, Guard 3. Large Weapons 21: Frontal Assault. Blades 10, Parry 6. 5 points stay banked. Shields 24 adds nothing over 23.",
            order: 'Levels 2-4 buy Blades 4. From promotion Shields at character level (from 7) to 23: 5 Guard I, 10 Guard II, 13 Disable, 15 Guard III, 18 Incapacitate, 23 Paralyze. Large Weapons takes the spare points, four levels behind at 8 and two behind by 12: 15 Domination by 17, 18 Obliteration by 20, 21 Frontal Assault by 23. Blades 10 Glowing Blade and Parry 6 at 24, with 5 points banked. After 24 Large Weapons catches up by 27 and stays at character level: 29 Ultimate Recovery, 34 Demolish, 50 Annihilation. Shields takes the spare points: 29 Bash by 32, 35 Mangle by 38, 42 Slam by 43, 50 Brutalize at 50. Parry takes what is left: 16 by 45, 27 at 50.',
            basis: 'adapted',
            targets: [
                { level: 24, specs: { Shields: 23, 'Large Weapons': 21, Blades: 10, Parry: 6 } },
                { level: 50, specs: { 'Large Weapons': 50, Shields: 50, Parry: 27, Blades: 10 } },
            ],
            sources: [
                {
                    url: 'https://blackthorn-daoc.com/wiki/hero-guide',
                    title: 'Hero guide (Blackthorn wiki)',
                    era: 'Blackthorn freeshard: classes tweaked to 1.65, pre-ToA. Wiki undated and marked work in progress',
                    says: 'Variant at 50 main weapon, 50 Shield, 27 Parry, 10 Blades for a better block and guard rate, and rated very good.',
                },
            ],
        },
    ],
} satisfies ClassBuilds;
