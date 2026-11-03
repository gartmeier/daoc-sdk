import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPath, earnedSpecPoints, getBuild, specCost } from '../../data/builds';
import { getClassSkills } from '../../data/index';
import { mentalist } from './mentalist';

const BUDGET_AT_50 = earnedSpecPoints(10, 50);
const pathOf = (name: string) => buildPath(getBuild('Mentalist', name)!);
const lastSpell = (line: string) => Math.max(...getClassSkills('Mentalist').find(l => l.specKey === line)!.skills.map(s => s.specLevel));

describe('mentalist kit', () => {
    test('it keeps the role\'s fight, so a bot adds only what it changes', () => {
        expect(mentalist().character).toEqual({ role: 'nuker' });
    });
});

describe('mentalist builds, as the guide tells them', () => {
    test('its table is what the rule gives', () => {
        const guide = readFileSync(join(import.meta.dir, '../../learnings/classes/mentalist.md'), 'utf-8').replaceAll('\r\n', '\n');
        const builds = ['Light nuker', 'Mentalism healer', 'Mana levelling'];
        for (const level of [10, 20, 24, 30, 40, 50]) {
            const cells = builds.map(name => {
                const lines = Object.keys(getBuild('Mentalist', name)!.targets.at(-1)!.specs);
                return lines.map(line => pathOf(name)[level - 1]!.specs[line]).join(' / ');
            });
            expect(guide).toContain(`| ${level} | ${earnedSpecPoints(10, level)} | ${cells.join(' | ')} |`);
        }
    });

    test('the usual 46/28/4 costs every point, and Light nuker moves the Light that buys no spell to Mana', () => {
        expect(specCost(1, 46) + specCost(1, 28) + specCost(1, 4)).toBe(BUDGET_AT_50);
        expect(lastSpell('Light')).toBe(45);
        expect(pathOf('Light nuker')[49]!.specs).toEqual({ Light: 45, Mentalism: 28, Mana: 10 });
        expect(specCost(1, 45) + specCost(1, 28) + specCost(1, 10)).toBe(BUDGET_AT_50 - 1);
    });

    test('Mana levelling has each regen rank at the level it comes, and stops where Mana stops giving spells', () => {
        const path = pathOf('Mana levelling');
        for (const rank of [4, 14, 24, 34, 44]) expect(path[rank - 1]!.specs.Mana).toBeGreaterThanOrEqual(rank);
        expect(lastSpell('Mana')).toBe(48);
        expect(path[49]!.specs.Mana).toBe(48);
    });

    test('the mezz waits: Mentalism stays at 1 until Light nuker turns to it at 23 and Mana levelling at 40.5', () => {
        const nuker = pathOf('Light nuker');
        expect(nuker[21]!.specs.Mentalism).toBe(1);
        expect(nuker[22]!.specs.Mentalism).toBeGreaterThanOrEqual(5);
        const levelling = pathOf('Mana levelling');
        expect(levelling[39]!.specs.Mentalism).toBe(1);
        expect(levelling[40]!.specs.Mentalism).toBeGreaterThanOrEqual(5);
    });
});
