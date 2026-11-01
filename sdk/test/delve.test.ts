// Delve lines in the server's formats: GameInventoryItem.cs:357-488, :855-905, :1201-1250 with the
// English strings of language/EN (SkillHandler.txt, GameObjects/GameObject.txt).
import { describe, expect, test } from 'bun:test';
import { getClasses } from '../../data/index';
import { isDelveOf, parseDelve, SKILLS, specOf } from '../delve';

const bonusIn = (line: string) => parseDelve([' ', 'Magical Bonuses:', line, ' ']).bonuses[0];

describe('parseDelve: real windows', () => {
    test('an accessory: utility prefix, then the layout around it', () => {
        const d = parseDelve([
            ' ', 'Magical Bonuses:',
            '4.67 | Strength: 7 pts',
            '5.00 | Hits: 20 pts',
            '6.00 | Heat: 3 %',
            ' ',
            'Total utility: 15.67', ' ',
        ]);
        expect(d.bonuses.map(b => [b.category, b.name, b.value, b.unit])).toEqual([
            ['stat', 'Strength', 7, 'pts'], ['hits', 'Hits', 20, 'pts'], ['resist', 'Heat', 3, '%'],
        ]);
        expect(d.bonuses[0]!.stat).toBe('STR');
        expect(d.bonuses[1]!.text).toBe('5.00 | Hits: 20 pts');
        expect(d.unknown).toEqual([]);
    });

    test('a plain merchant cloak has no bonus and nothing unknown', () => {
        expect(parseDelve(['Total utility: 0.00', ' '])).toEqual({ bonuses: [], unknown: [], bonusLevel: null, levelRequirement: null });
    });

    test('armour: classes, bonuses, focus, and its stats are not bonuses', () => {
        const d = parseDelve([
            'Usable by:', '- Paladin', '- Armsman',
            ' ', 'Magical Bonuses:', '10.00 | Constitution: 15 pts', ' ',
            ' ', 'Focus Bonuses:', '- Body Magic Focus: 4 lvls', ' ',
            'Total utility: 10.00', ' ',
            'Armor Modifiers:', '- 40 Base Factor', '- 40 Clamped Factor', '- 27% Absorption', '- 90% Quality', '- 100% Condition',
            ' ', 'Effective Armor:', '- 45 Factor',
            ' ', 'Cannot be traded to other players.', 'Cannot be sold to merchants.', 'Cannot be destroyed.',
            ' ', 'Bonus Level: 25',
        ]);
        expect(d.bonuses.map(b => [b.category, b.name, b.value])).toEqual([['stat', 'Constitution', 15], ['focus', 'Body Magic Focus', 4]]);
        expect(d.bonuses[1]).toMatchObject({ unit: 'lvls', spec: 'Body Magic' });
        expect(d.bonusLevel).toBe(25);
        expect(d.unknown).toEqual([]);
    });

    test('a weapon and a shield: DPS lines are layout too', () => {
        expect(parseDelve([
            ' ', 'Damage Modifiers:', '- 16.5 Base DPS', '- 16.5 Clamped DPS', '- 3.7 Weapon Speed', '- 90% Quality', '- 100% Condition', '- Damage Type: Slash',
            ' ', 'Effective Damage:', '- 14.8 DPS',
            ' ', 'Damage Modifiers (when used with shield styles):', '- 6.0 Shield Speed', ' ', '- Shield Size : Small',
        ])).toEqual({ bonuses: [], unknown: [], bonusLevel: null, levelRequirement: null });
    });

    test('a spell on an item: its requirement is read, its text stays unknown, never a bonus', () => {
        const d = parseDelve([
            'Level Requirement: 35 Level', ' ', 'Magical Ability:',
            'Function: heal', 'Heals your target for 50 hits.', '- This spell is cast when the item is used.', ' ',
            'Can use item every: 5:00 min', 'Can use again in: 12 sec',
        ]);
        expect(d.levelRequirement).toBe(35);
        expect(d.bonuses).toEqual([]);
        expect(d.unknown).toEqual(['Function: heal', 'Heals your target for 50 hits.']);
    });

    test('a description line is not a bonus even when it reads like one', () => {
        const d = parseDelve(['Strength: 5 pts', ' ', 'Total utility: 0.00']);
        expect(d.bonuses).toEqual([]);
        expect(d.unknown).toEqual(['Strength: 5 pts']);
    });
});

describe('parseDelve: formats', () => {
    test.each([
        // "<utility> | <name>: <value> <unit>", GameInventoryItem.cs:865-893.
        ['4.67 | Dexterity: 7 pts', 'stat', 7],
        ['-3.33 | Quickness: -5 pts', 'stat', -5],
        ['0.00 | Acuity: 6 pts', 'stat', 6],
        ['6,00 | Cold: 3 %', 'resist', 3],
        ['-4.00 | Matter: -2 %', 'resist', -2],
        ['0.00 | Essence: 4 pts', 'resist', 4],
        ['0.00 | Power Pool: 6 % of power pool.', 'powerPool', 6],
        ['6.00 | Power: 3 pts', 'power', 3],
        ['0.00 | Fatigue: 8 pts', 'fatigue', 8],
        ['0.00 | Bonus to casting speed: 2 pts', 'castingSpeed', 2],
        ['0.00 | Bonus to armor factor (AF): 18 pts', 'armorFactor', 18],
        ['0.00 | Bonus to armor absorption (ABS): 5 pts', 'absorption', 5],
        ['10.00 | Crush: 2 pts', 'skill', 2],
        ['10.00 | Polearm: 2 pts', 'skill', 2],
        ['5.00 | ALL Magic Skills: 1 pts', 'skillGroup', 1],
        ['5.00 | All Skills: 1 pts', 'skillGroup', 1],
        ['0.00 | Evade chance: 5 pts', 'other', 5],
        ['0.00 | Extra Health Points: 4 %', 'other', 4],
        ['0.00 | Heat cap: 5 %', 'other', 5],
        ['0.00 | Bonus to Weaponskill: 3 pts', 'other', 3],
        // The old handler's forms (DetailDisplayHandler.cs:1737-1776), inside a section.
        ['- Strength: 15 pts', 'stat', 15],
        ['- Strength: -5 pts', 'stat', -5],
        ['- Hits: 40 pts', 'hits', 40],
        ['- Fatigue: 8 pts', 'fatigue', 8],
        ['- Heat: 7%', 'resist', 7],
        ['- Axe: 5 pts', 'skill', 5],
        ['Bonus to casting speed: 2%', 'castingSpeed', 2],
        ['Bonus to armor factor (AF): 18', 'armorFactor', 18],
        ['Power: 6 % of power pool.', 'powerPool', 6],
        // PvE-only lines are the format string of the property name (SkillHandler.txt:165-188).
        ['- Defensive Bonus: 5% (PvE Only)', 'pve', 5],
        ['- Style Cost Reduction: 4 pts (PvE Only)', 'pve', 4],
        ['Evade: 3% (PvE Only)', 'pve', 3],
        // WriteFocusLine: no check on the value (GameInventoryItem.cs:897-903).
        ['- ALL Spell Lines: 3 lvls', 'focus', 3],
        ['- Wind Magic Focus: 0 lvls', 'focus', 0],
    ])('%s', (line, category, value) => {
        expect(bonusIn(line)).toMatchObject({ category, value });
    });

    test('Crush, Slash and Thrust are told apart by unit: a resist in %, a skill in pts', () => {
        expect(bonusIn('6.00 | Crush: 3 %')).toMatchObject({ category: 'resist' });
        expect(bonusIn('10.00 | Crush: 2 pts')).toMatchObject({ category: 'skill', group: 'melee', spec: 'Crush' });
        expect(bonusIn('10.00 | Body Magic: 2 pts')).toMatchObject({ category: 'skill', group: 'magic', spec: 'Body Magic' });
    });

    test.each([
        ['0.00 | Property123: 5 pts'],   // SkillBase.GetPropertyName's fallback for an unnamed property
        ['0.00 | : 5 pts'],              // OffhandDamageAndChance's empty name
        ['0.00 | Strength: 5 %'],        // a stat in percent: no such line
        ['0.00 | Heat: 5 lvls'],
        ['- Something new'],
    ])('never in a category when it does not fit: %s', line => {
        const d = parseDelve(['Magical Bonuses:', line, ' ']);
        expect(d.bonuses).toEqual([]);
        expect(d.unknown).toEqual([line]);
    });

    test('a tab in the language file is whitespace: Verdant\tPath', () => {
        expect(bonusIn('10.00 | Verdant\tPath: 1 pts')).toMatchObject({ category: 'skill', name: 'Verdant Path', spec: 'Verdant Path' });
    });
});

describe('every registered property name', () => {
    // SkillBase.RegisterPropertyNames with language/EN/SkillHandler.txt, by what eProperty they are.
    test('every skill has a group and reaches a specialization in classes.json', () => {
        expect(Object.values(SKILLS).flat()).toHaveLength(94);
        const specs = new Set(getClasses().flatMap(c => c.specializations.map(s => s.spec)));
        for (const name of Object.values(SKILLS).flat()) {
            const spec = specOf(name);
            if (spec !== null) expect([name, specs.has(spec)]).toEqual([name, true]);
        }
    });

    test.each([
        'Darkness', 'Suppression', 'Runecarving', 'Spirit Magic', 'Fire Magic', 'Wind Magic', 'Cold Magic', 'Earth Magic', 'Light Magic', 'Body Magic',
        'Matter Magic', 'Mind Magic', 'Void Magic', 'Mana Magic', 'Enchantment', 'Mentalism', 'Summoning', 'Bone Army', 'Painworking', 'Deathsight',
        'Death Servant', 'Verdant', 'Creeping Path', 'Arboreal', 'Ethereal Shriek', 'Phantasmal Wail', 'Cursing', 'Hexing', 'Witchcraft',
    ])('%s Focus reaches a specialization', line => {
        const specs = new Set(getClasses().flatMap(c => c.specializations.map(s => s.spec)));
        const b = bonusIn(`- ${line} Focus: 4 lvls`)!;
        expect(b.category).toBe('focus');
        expect(specs.has(b.spec!)).toBe(true);
    });

    test.each([
        ['Strength', 'STR'], ['Dexterity', 'DEX'], ['Constitution', 'CON'], ['Quickness', 'QUI'], ['Intelligence', 'INT'],
        ['Piety', 'PIE'], ['Empathy', 'EMP'], ['Charisma', 'CHR'], ['Acuity', 'ACU'],
    ])('%s is the stat %s', (name, stat) => {
        expect(bonusIn(`1.00 | ${name}: 3 pts`)).toMatchObject({ category: 'stat', stat });
    });

    test.each([
        'Mythical Safe Fall', 'Mythical Coin', 'Spell Focus', 'Conversion', 'Style Absorb', 'Arcane Syphon', 'Realm Points', 'Bounty Points', 'Experience Points',
        'Maximum Speed', 'Concentration', 'Health Regeneration', 'Power Regeneration', 'Endurance Regeneration', 'Spell Range', 'Archery Range', 'Effective level',
        'Block chance', 'Parry chance', 'Fumble Chance', 'Bonus to melee damage', 'all Ranged Damage', 'Mesmerize Duration', 'Stun Duration', 'Speed Decrease Duration',
        'Archery Speed', 'Arrow Recovery', 'all Stat Buff Spells', 'Debuff Effectiveness', 'Bonus to healing effectiveness', 'Resist Pierce', 'Bonus to magic damage',
        'Spell Duration', 'Bonus to style damage', 'Bonus to melee combat speed', 'Bonus to Strength attribute bonus cap', 'Bonus to Acuity attribute bonus cap',
        'Bonus to hit points bonus cap', 'Bonus to power bonus cap', 'Bonus to critical melee hit chance', 'Mythical Stat Cap (Strength)', 'Mythical Stat Cap (Acuity)',
    ])('%s is a real property with no weight', name => {
        expect(bonusIn(`0.00 | ${name}: 3 pts`)).toMatchObject({ category: 'other', name });
    });
});

describe('isDelveOf', () => {
    test('the caption is the bare item name; the inventory name has a count in front of a stack', () => {
        expect(isDelveOf('Heatbender Bracelet', 'Heatbender Bracelet')).toBe(true);
        expect(isDelveOf('healing potion', '3 healing potion')).toBe(true);
        expect(isDelveOf('Player Statistics', 'Heatbender Bracelet')).toBe(false);
        expect(isDelveOf('Heatbender Bracelet', 'Heatbender Bracer')).toBe(false);
    });

    test('an inventory name stops at 55 characters, the caption does not', () => {
        const long = 'x'.repeat(70);
        expect(isDelveOf(long, long.slice(0, 55))).toBe(true);
        expect(isDelveOf(long, long.slice(0, 20))).toBe(false);
    });
});
