import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { pickNuke, type SpellPick } from '../group/spells';
import { reachOfBuild } from './reach';
import { DARKNESS_LINES, onLines, onlyLines, runemaster } from './runemaster';

/** Gudrun's damage spells at Darkness 24 that matter (bun data/class-sheet.ts Runemaster), with their lines as the server names them. */
const pick = (name: string, lineName: string, level: number, damage: number, over: Partial<SpellPick> = {}): SpellPick => ({
    spell: { name, level, lineName, internalId: 0, lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 }, type: 'DirectDamage', target: 'Enemy', range: 1500, radius: 0,
    power: 14, castTime: 2.8, duration: 0, recast: 0, concentration: 0, damage, value: 0, ...over,
} as SpellPick);
// In the order the server lists her lines (Darkness, Suppression, Runecarving, Runes of Darkness: bun sdk/cli.ts gudrun), which decides a tie on level.
const GUDRUN = [
    pick('Murk Blast', 'Darkness', 20, 73),
    pick('Quell Strength', 'Suppression', 17, 0, { type: 'StrengthDebuff', castTime: 0 }),
    pick('Greater Runebolt', 'Runecarving', 22, 115, { type: 'Bolt', range: 1875, recast: 20 }),
    pick('Symbol of Destruction', 'Runecarving', 23, 85),
    pick('Greater Raven Bolt', 'Runes of Darkness', 22, 79, { type: 'DirectDamageWithDebuff', recast: 20 }),
    pick('Rune of Obscurity', 'Runes of Darkness', 23, 108),
];

describe('runemaster kit', () => {
    test('a nuker: quickcast above flee, then assist and nukeInReach, in every list', () => {
        expect(runemaster().role).toBe('nuker');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.nuker as Behavior<any>[], runemaster()).map(b => b.name);
            expect(list.filter(n => n === 'assist')).toHaveLength(1);
            expect(list.indexOf('nukeInReach')).toBe(list.indexOf('assist') + 1);
            expect(list.indexOf('quickcast')).toBe(list.indexOf('flee') - 1);
        }
    });

    test('off its lines the Spellbook would take Symbol of Destruction (level) or Greater Runebolt (damage); on them Rune of Obscurity', () => {
        expect(pickNuke(GUDRUN)?.spell.name).toBe('Symbol of Destruction');
        expect(pickNuke(GUDRUN, { byDamage: true })?.spell.name).toBe('Greater Runebolt');
        const mine = GUDRUN.filter(s => onLines(s, DARKNESS_LINES));
        expect(mine.map(s => s.spell.name)).toEqual(['Murk Blast', 'Quell Strength', 'Greater Raven Bolt', 'Rune of Obscurity']);
        expect(pickNuke(mine)?.spell.name).toBe('Rune of Obscurity');
        expect(pickNuke(mine, { byDamage: true })?.spell.name).toBe('Rune of Obscurity');
    });

    test('onlyLines hands the behaviour a book that sees its lines, and leaves the member\'s own alone', async () => {
        class Book {
            constructor(private readonly picks: SpellPick[]) {}
            all() { return this.picks; }
            nuke(o: { byDamage?: boolean } = {}) { return pickNuke(this.all(), o); }
        }
        const book = new Book(GUDRUN);
        const ctx = { spells: book, memory: new Map(), name: 'Gudrun' } as any;
        let seen: string | undefined;
        const inner: Behavior<any> = { name: 'assist', async run(c) { seen = c.spells.nuke({ byDamage: true })?.spell.name; return c.memory === ctx.memory; } };
        expect(await onlyLines(inner, DARKNESS_LINES).run(ctx)).toBe(true);
        expect(seen).toBe('Rune of Obscurity');
        expect(ctx.spells.nuke({ byDamage: true })?.spell.name).toBe('Greater Runebolt');
    });

    // The live line names are the DB's spellline.Name (PacketLib1112 writes SpellLine.Name): 'Darkness' (baseline) and 'Runes of Darkness'.
    test('the build reaches Rune of Obscurity in the Darkness spec', () => {
        const r = reachOfBuild(getBuild('Runemaster', 'Darkness nuker')!, 24);
        const obscurity = r.known.find(k => k.name === 'Rune of Obscurity');
        expect(obscurity?.baseline).toBe(false);
        expect(obscurity?.line).toBe('Darkness');
    });
});
