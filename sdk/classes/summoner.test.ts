import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPath, earnedSpecPoints, getBuild } from '../../data/builds';
import { getClass } from '../../data/index';
import { hurtsOne } from './summoner';
import { knownThrough } from './summoner-fixtures';

/** The build table of a guide is what the rule gives (as guides.test.ts tableHolds). */
function tableHolds(className: string, builds: string[]) {
    const text = readFileSync(join(import.meta.dir, `../../learnings/classes/${className.toLowerCase()}.md`), 'utf-8').replaceAll('\r\n', '\n');
    const multiplier = getClass(className)!.specializationMultiplier;
    for (const level of [10, 20, 24, 30, 40, 50]) {
        const cells = builds.map(name => {
            const build = getBuild(className, name)!;
            const specs = buildPath(build)[level - 1]!.specs;
            return Object.keys(build.targets.at(-1)!.specs).map(line => specs[line] ?? 1).join(' / ');
        });
        expect(text).toContain(`| ${level} | ${earnedSpecPoints(multiplier, level)} | ${cells.join(' | ')} |`);
    }
}

describe('pet class guides', () => {
    test('their tables are what the rule gives', () => {
        tableHolds('Necromancer', ['Deathsight', 'Sight and servant split', 'Sight and pain', 'Servant with a healer']);
        tableHolds('Bonedancer', ['Suppression lifetap', 'Bone Army', 'Split Darkness and Suppression']);
        tableHolds('Animist', ['Arboreal group', 'Creeping turret farm', 'Verdant bomber core']);
    });
});

describe('summoner helpers', () => {
    test("a PetSpell's half, a turret's shot and a bomber's hit come from the static data", () => {
        const pet = knownThrough('Necromancer', 'Deathsight', 24, 'PetSpell').find(k => k.pick.spell.name === 'Vitality Theft')!;
        expect(pet.sub?.type).toBe('Lifedrain');
        expect(hurtsOne(pet.sub)).toBe(true);
        const turret = knownThrough('Animist', 'Arboreal group', 24, 'SummonAnimistPet').find(k => k.pick.spell.name === "Forest's Sentry")!;
        expect(turret.sub?.type).toBe('DirectDamage');
        const tangler = knownThrough('Animist', 'Arboreal group', 24, 'SummonAnimistFnF').find(k => k.pick.spell.name === 'Tangler Youngling')!;
        expect(hurtsOne(tangler.sub)).toBe(false);
    });
});
