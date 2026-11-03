// Holds what the class guides (learnings/classes/) claim to the data and to the Spellbook a member fights with.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPath, earnedSpecPoints, getBuild, specCost } from '../../data/builds';
import { getClass } from '../../data/index';
import { reach, reachOfBuild } from './reach';

const guide = (name: string) => readFileSync(join(import.meta.dir, `../../learnings/classes/${name}.md`), 'utf-8').replaceAll('\r\n', '\n');
const names = (list: { spell: { name: string } }[]) => list.map(s => s.spell.name);

/** The build table of a guide is what the rule gives. */
function tableHolds(className: string, builds: string[]) {
    const text = guide(className.toLowerCase());
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

describe('reach', () => {
    test('a line spell comes with its spec', () => {
        expect(reach('Druid', 24, {}).known.some(k => k.name === 'Greater Regrowth')).toBe(false);
        expect(reach('Druid', 24, { Regrowth: 19 }).known.some(k => k.name === 'Greater Regrowth')).toBe(true);
    });
});

describe('druid guide', () => {
    const heal = () => reachOfBuild(getBuild('Druid', 'Heal druid')!, 24);

    test('its table is what the rule gives', () => tableHolds('Druid', ['Heal druid', 'Buff druid', 'Group Nature', 'Solo Nature']));

    test('Heal druid heals up to Greater Regrowth, then the instant, and never picks a group heal or Appreciation', () => {
        const r = names(heal().heals);
        expect(r.at(-2)).toBe('Greater Regrowth');
        expect(r.at(-1)).toBe("Nature's Blessing");
        expect(r).not.toContain('Renewing Conflux');
        expect(r).not.toContain("Nature's Appreciation");
    });

    test('its crowd control is a root, its rez the lesser one', () => {
        const r = heal();
        expect(r.cc?.kind).toBe('root');
        expect(r.cc?.spell.name).toBe('Holding Vines');
        expect(r.rez?.spell.name).toBe('Lesser Reconstitution');
    });

    test('Nurture 9 has no acuity; Regrowth 21, Nurture 11 has it, keeps the instant, and fits the budget', () => {
        expect(heal().buffs.some(b => b.slot === 'acuity')).toBe(false);
        const moved = reach('Druid', 24, { Regrowth: 21, Nurture: 11 });
        expect(names(moved.buffs.filter(b => b.slot === 'acuity'))).toEqual(["Nature's Sight"]);
        expect(names(moved.heals)).toContain("Nature's Blessing");
        expect(specCost(1, 21) + specCost(1, 11)).toBeLessThanOrEqual(earnedSpecPoints(10, 24));
    });

    test('a Bard at 24 has no acuity either', () => {
        expect(reachOfBuild(getBuild('Bard', 'Nurture support')!, 24).buffs.some(b => b.slot === 'acuity')).toBe(false);
    });
});
