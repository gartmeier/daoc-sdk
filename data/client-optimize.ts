// What the retail client's "Optimize" button on the character attributes screen
// spends the 30 creation points on, per class (eCharacterClass id).
//
// Read from the OpenDAoC client's game.dll (5,902,336 bytes, 2021-10-14):
// - pregame/character_customize_stats.xml: control 1021 is the "Optimize" button.
// - Its click posts message 0x1F9; the message switch at VA 0x59C9FB jumps to
//   VA 0x59CC45, which calls VA 0x59C086: reset to 30 points, look up the selected
//   class's record, then for each of its three (stat, amount) pairs set the stat to
//   race base + amount and charge 1 point each up to +10, 2 up to +15, 3 beyond
//   (the server's CharacterStatValidator curve).
// - The records are built at VA 0x5B0CC5-0x5B4377: per class a 3-stat array and a
//   3-byte amount array, committed with the class id. Every class gets either
//   +10/+10/+10 or +10/+15 (and +0 on its third stat); both cost exactly 30.
// The amounts don't depend on race. The client lists only the classes one picks at
// creation (the advanced ones); base classes have no entry.
//
// Checked live: Niamh (Lurikeen Mentalist) re-spent with the client's customize
// screen on 2026-11-14 holds +10 INT, +15 DEX, +0 QUI over race base.

import type { StatName } from './build';

/** Points above race base the client's Optimize gives, by eCharacterClass id. Stats left out get 0. */
export const CLIENT_OPTIMIZE: Readonly<Record<number, Readonly<Partial<Record<StatName, number>>>>> = {
    // Albion
    1: { CON: 10, PIE: 10, STR: 10 },   // Paladin
    2: { STR: 10, CON: 10, DEX: 10 },   // Armsman
    3: { DEX: 15, STR: 10 },            // Scout
    4: { CHR: 10, DEX: 10, STR: 10 },   // Minstrel
    5: { INT: 10, DEX: 15 },            // Theurgist
    6: { PIE: 10, DEX: 15 },            // Cleric
    7: { INT: 10, DEX: 15 },            // Wizard
    8: { INT: 10, DEX: 15 },            // Sorcerer
    9: { DEX: 15, STR: 10 },            // Infiltrator
    10: { PIE: 10, CON: 10, DEX: 10 },  // Friar
    11: { STR: 10, DEX: 10, CON: 10 },  // Mercenary
    12: { INT: 10, DEX: 15 },           // Necromancer
    13: { INT: 10, DEX: 15 },           // Cabalist
    19: { STR: 10, DEX: 10, CON: 10 },  // Reaver
    33: { PIE: 10, DEX: 10, CON: 10 },  // Heretic
    60: { STR: 10, CON: 10, DEX: 10 },  // Mauler (Albion)
    // Midgard
    21: { STR: 10, CON: 10, PIE: 10 },  // Thane
    22: { STR: 10, CON: 10, DEX: 10 },  // Warrior
    23: { STR: 10, DEX: 15 },           // Shadowblade
    24: { STR: 10, CON: 10, CHR: 10 },  // Skald
    25: { DEX: 15, STR: 10 },           // Hunter
    26: { PIE: 10, DEX: 15 },           // Healer
    27: { PIE: 10, DEX: 15 },           // Spiritmaster
    28: { PIE: 10, DEX: 15 },           // Shaman
    29: { PIE: 10, DEX: 15 },           // Runemaster
    30: { PIE: 10, DEX: 15 },           // Bonedancer
    31: { STR: 10, CON: 10, DEX: 10 },  // Berserker
    32: { STR: 10, CON: 10, DEX: 10 },  // Savage
    34: { STR: 10, CON: 10, DEX: 10 },  // Valkyrie
    59: { CON: 10, PIE: 15 },           // Warlock
    61: { STR: 10, CON: 10, DEX: 10 },  // Mauler (Midgard)
    // Hibernia
    39: { STR: 10, DEX: 15 },           // Bainshee
    40: { INT: 10, DEX: 15 },           // Eldritch
    41: { INT: 10, DEX: 15 },           // Enchanter
    42: { INT: 10, DEX: 15 },           // Mentalist
    43: { STR: 10, CON: 10, DEX: 10 },  // Blademaster
    44: { STR: 10, CON: 10, DEX: 10 },  // Hero
    45: { STR: 10, DEX: 10, CON: 10 },  // Champion
    46: { DEX: 15, EMP: 10 },           // Warden
    47: { DEX: 15, EMP: 10 },           // Druid
    48: { DEX: 15, CHR: 10 },           // Bard
    49: { STR: 10, DEX: 15 },           // Nightshade
    50: { STR: 10, DEX: 15 },           // Ranger
    55: { DEX: 15, INT: 10 },           // Animist
    56: { STR: 10, CON: 10, DEX: 10 },  // Valewalker
    58: { STR: 10, CON: 10, DEX: 10 },  // Vampiir
    62: { STR: 10, CON: 10, DEX: 10 },  // Mauler (Hibernia)
};
