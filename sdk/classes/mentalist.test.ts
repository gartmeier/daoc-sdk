import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPath, earnedSpecPoints, getBuild, specCost } from '../../data/builds';
import { getClassSkills } from '../../data/index';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import type { Contact } from '../group/types';
import { mentalist, stunTarget } from './mentalist';
import { reachOfBuild } from './reach';

const BUDGET_AT_50 = earnedSpecPoints(10, 50);
const pathOf = (name: string) => buildPath(getBuild('Mentalist', name)!);
const lastSpell = (line: string) => Math.max(...getClassSkills('Mentalist').find(l => l.specKey === line)!.skills.map(s => s.specLevel));

describe('mentalist kit', () => {
    test('the nuker role with stunCaster above assist, in the pack', () => {
        const c = mentalist().character;
        expect(c.role).toBe('nuker');
        expect(c.fight!.map(b => b.name)).toEqual(['assist', 'offFocus']);
        const names = withCharacter(packBehaviors().nuker, c).map(b => b.name);
        expect(names.indexOf('stunCaster')).toBeGreaterThan(-1);
        expect(names.indexOf('stunCaster')).toBeLessThan(names.indexOf('assist'));
        // Round 18: 11 emergency heals and no Flash. As urgent it goes above them (and below her cc orders).
        expect(names.indexOf('stunCaster')).toBeLessThan(names.indexOf('emergencyHeal'));
        expect(names.indexOf('stunCaster')).toBeGreaterThan(names.indexOf('crowdControl'));
        // Quickcast under a melee: her Flash on it first, else the nuke; both above flee.
        expect(names.slice(names.indexOf('flee') - 2, names.indexOf('flee'))).toEqual(['quickFlash', 'quickcast']);
    });

    test('Light nuker reaches Prismatic Flash at 24: a single-target stun', () => {
        const flash = reachOfBuild(getBuild('Mentalist', 'Light nuker')!, 24).unused.find(k => k.name === 'Prismatic Flash')!;
        expect(flash.info.type).toBe('Stun');
        expect(flash.info.target).toBe('Enemy');
        expect(flash.info.radius).toBe(0);
    });

    const members = [{ name: 'Oisin', role: 'support' as const }, { name: 'Niamh', role: 'nuker' as const }, { name: 'Brigid', role: 'healer' as const }];
    const dist = (c: Contact) => Math.hypot(c.x, c.y);
    const foe = (id: number, o: Partial<Contact> = {}) => ({ objectId: id, kind: 'player', regionId: 238, x: 500, y: 0, stale: false, cc: null, castingAt: 1000, target: null, targetBySpell: false, ...o }) as Contact;

    test('a caster on our Bard before one on a nuker, before a casting healer; the nearest of each', () => {
        const list = [foe(1, { healer: true }), foe(2, { target: 'Niamh', targetBySpell: true }), foe(3, { target: 'Oisin', targetBySpell: true, x: 1400 }), foe(4, { target: 'Oisin', targetBySpell: true, x: 900 })];
        expect(stunTarget(list, members, 238, dist, 1500, 2000)?.objectId).toBe(4);
        expect(stunTarget(list.slice(0, 2), members, 238, dist, 1500, 2000)?.objectId).toBe(2);
        expect(stunTarget(list.slice(0, 1), members, 238, dist, 1500, 2000)?.objectId).toBe(1);
    });

    test('none that is quiet, out of range, held or stun-immune', () => {
        const on = { target: 'Oisin', targetBySpell: true };
        expect(stunTarget([foe(1, { ...on, castingAt: -5000 })], members, 238, dist, 1500, 2000)).toBeNull();
        expect(stunTarget([foe(1, { ...on, x: 1460 })], members, 238, dist, 1500, 2000)).toBeNull();
        expect(stunTarget([foe(1, { ...on, cc: { by: 'Oisin', kind: 'mezz', until: 9000 } })], members, 238, dist, 1500, 2000)).toBeNull();
        expect(stunTarget([foe(1, { ...on, ccImmune: { stun: 3000 } })], members, 238, dist, 1500, 2000)).toBeNull();
    });

    test('a melee swinging at our Bard or Druid counts first, as a caster on them; on a nuker, or not swinging, it does not', () => {
        const melee = (id: number, target: string, swinging = true, x = 500) => foe(id, { target, targetBySpell: false, swinging, castingAt: undefined, x });
        expect(stunTarget([melee(1, 'Brigid')], members, 238, dist, 1500, 2000)?.objectId).toBe(1);
        expect(stunTarget([foe(2, { target: 'Niamh', targetBySpell: true, x: 200 }), melee(1, 'Oisin', true, 900)], members, 238, dist, 1500, 2000)?.objectId).toBe(1);
        expect(stunTarget([melee(1, 'Oisin', false)], members, 238, dist, 1500, 2000)).toBeNull();
        expect(stunTarget([melee(1, 'Niamh')], members, 238, dist, 1500, 2000)).toBeNull();
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
