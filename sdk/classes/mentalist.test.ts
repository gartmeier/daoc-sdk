import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildPath, earnedSpecPoints, getBuild, specCost } from '../../data/builds';
import { getClassSkills } from '../../data/index';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import type { Contact } from '../group/types';
import { CHARM_SAFE_RESIST, charmLimits, charmResist, charmTarget, mentalist, noteTooFar, petOnMe, stunTarget, viewDistance, type TooFar } from './mentalist';
import type { NearbyNpc } from '../types';
import { selfBuffDue } from './paladin';
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

describe('the server "too far"', () => {
    test('holds 10 s, unless our view puts the target 200 nearer than when it was said', () => {
        const log: TooFar = new Map();
        noteTooFar(log, 7, 'resisted', 1300, 0);
        expect(viewDistance(log, 7, 1300, 0)).toBe(1300);
        noteTooFar(log, 7, 'out_of_range', 1300, 0);
        expect(viewDistance(log, 7, 1250, 5000)).toBe(Infinity);
        expect(viewDistance(log, 8, 1250, 5000)).toBe(1250);
        expect(viewDistance(log, 7, 1050, 5000)).toBe(1050);
        noteTooFar(log, 7, 'out_of_range', 1300, 0);
        expect(viewDistance(log, 7, 1300, 10_001)).toBe(1300);
    });
});

describe('quickFlash on a pet', () => {
    const pet = (o: Partial<Contact> = {}) => ({ objectId: 9, kind: 'npc', isPet: true, stale: false, cc: null, target: 'Niamh', targetBySpell: false, swinging: true, ...o }) as Contact;
    test('an enemy pet swinging at her, not one casting at her, held, or on someone else', () => {
        expect(petOnMe([pet()], 'Niamh')?.objectId).toBe(9);
        expect(petOnMe([pet({ targetBySpell: true })], 'Niamh')).toBeUndefined();
        expect(petOnMe([pet({ cc: { by: 'Oisin', kind: 'mezz', until: 1 } })], 'Niamh')).toBeUndefined();
        expect(petOnMe([pet({ target: 'Oisin' })], 'Niamh')).toBeUndefined();
        expect(petOnMe([pet({ swinging: false })], 'Niamh')).toBeUndefined();
    });
});

describe('bestStun', () => {
    const stun = (name: string, level: number, power: number, cooldownRemaining = 0) => ({ type: 'Stun', target: 'Enemy', radius: 0, power, spell: { name, level, cooldownRemaining } });
    test('Prismatic Flash (15, 5 s) over Prismatic Flare (5, 3 s), whatever the book order; Flare when Flash is unpaid or cooling', async () => {
        const { bestStun } = await import('./mentalist');
        const book = [stun('Prismatic Flare', 5, 4), stun('Prismatic Flash', 15, 9)];
        expect(bestStun(book)?.spell.name).toBe('Prismatic Flash');
        expect(bestStun(book, 8)?.spell.name).toBe('Prismatic Flare');
        expect(bestStun([stun('Prismatic Flare', 5, 4), stun('Prismatic Flash', 15, 9, 3)])?.spell.name).toBe('Prismatic Flare');
        expect(bestStun([], 100)).toBeNull();
    });
});

describe('the bladeturn kept up (the user, playing Niamh: recast each time it pops)', () => {
    const barrier = { spell: { name: 'Barrier of Negation', level: 19 }, type: 'Bladeturn', target: 'Self' } as unknown as Parameters<typeof selfBuffDue>[0][number];
    const shield = { spell: { name: 'Powershield', level: 24 }, type: 'BaseArmorFactorBuff', target: 'Self' } as unknown as Parameters<typeof selfBuffDue>[0][number];
    test('due when it is not on her, not while it is; in the kit below the fight', () => {
        expect(selfBuffDue([barrier, shield], [], ['Bladeturn'])?.spell.name).toBe('Barrier of Negation');
        expect(selfBuffDue([barrier, shield], ['Barrier of Negation'], ['Bladeturn'])).toBeNull();
        expect(mentalist().character.chores!.map(b => b.name)).toEqual(['bladeturnUp', 'charmUp', 'petControl']);
        expect(mentalist({ charm: false }).character.chores!.map(b => b.name)).toEqual(['bladeturnUp']);
    });
    test('not on the side tick, and a fight leaves her a turn for it when there is nothing to nuke', () => {
        const list = withCharacter(packBehaviors().nuker as any, mentalist().character).map(b => b.name);
        expect(list).toContain('bladeturnUp');
    });
});

describe('the charm (the user, playing Niamh: Imaginary Enemy on a bwca and mature boars to tank the adds)', () => {
    test('the resist a pulse, by the server formula: 1 % well under, 34 % at her own level', () => {
        // 24 x 0.66 + 22 x 0.33 = 23.1: a L20 is 3.1 under, 10 - 9.3 -> at least 1.
        expect(charmResist(24, 22, 20)).toBe(1);
        expect(charmResist(24, 22, 21)).toBeCloseTo(3.7, 5);
        expect(charmResist(24, 22, 23)).toBeCloseTo(9.7, 5);
        expect(charmResist(24, 22, 24)).toBeCloseTo(34.05, 5);
        expect(charmResist(24, 22, 60)).toBe(99);
    });

    test('the cap is the spell value or 110 % of the spec, and safe the highest level at 10 % a pulse or less', () => {
        expect(charmLimits(24, 22, 76)).toEqual({ cap: 24, safe: 23 });
        expect(charmLimits(24, 22, 76, 4)).toEqual({ cap: 24, safe: 21 });
        expect(charmLimits(24, 22, 76, 35)).toEqual({ cap: 24, safe: 24 });
        expect(charmLimits(20, 17, 76)).toEqual({ cap: 18, safe: 18 });
        expect(charmLimits(24, 22, 15).cap).toBe(15);
        expect(charmLimits(24, 22, 15).safe).toBe(15);
        for (const [level, spec] of [[24, 22], [20, 17], [40, 35], [50, 45]] as const) {
            const { safe } = charmLimits(level, spec, 76);
            expect(charmResist(level, spec, safe)).toBeLessThanOrEqual(CHARM_SAFE_RESIST);
            expect(charmResist(level, spec, safe + 1)).toBeGreaterThan(CHARM_SAFE_RESIST);
        }
    });

    const npc = (id: number, o: Partial<NearbyNpc> = {}) => ({ objectId: id, kind: 'npc', name: 'mature boar', level: 20, realm: 'none', isPet: false, isPeaceful: false, isTargetable: true, distance: 800, healthPercent: 100, inCombat: false, targetObjectId: null, ...o }) as NearbyNpc;

    test('the strongest it may take, then the nearest', () => {
        const list = [npc(1, { level: 18, distance: 300 }), npc(2, { level: 21, distance: 1200 }), npc(3, { level: 21, distance: 900 }), npc(4, { level: 22, distance: 200 })];
        expect(charmTarget(list, { maxLevel: 21, busy: new Set() })?.objectId).toBe(3);
        expect(charmTarget(list, { maxLevel: 18, busy: new Set() })?.objectId).toBe(1);
    });

    test('not one a member fights, on anybody, hurt, in combat, far, named, a pet, peaceful or of a realm', () => {
        const none = (o: Partial<NearbyNpc>, c: Partial<Parameters<typeof charmTarget>[1]> = {}) => expect(charmTarget([npc(1, o)], { maxLevel: 21, busy: new Set(), ...c })).toBeNull();
        none({}, { busy: new Set([1]) });
        none({ targetObjectId: 77 });
        none({ healthPercent: 80 });
        none({ inCombat: true });
        none({ distance: 1600 });
        none({ name: 'Growler' });
        none({ isPet: true });
        none({ isPeaceful: true });
        none({ realm: 'hibernia' });
        none({}, { skipNames: new Set(['mature boar']) });
        none({}, { skipIds: new Set([1]) });
        expect(charmTarget([npc(1)], { maxLevel: 21, busy: new Set() })?.objectId).toBe(1);
    });

    test('in the pack nuker list: charmUp in the chores, petControl on the side tick from the start', () => {
        const list = withCharacter(packBehaviors().nuker as any, mentalist().character);
        expect(list.map(b => b.name)).toContain('charmUp');
        expect(list.find(b => b.name === 'petControl')?.side).toBe(true);
        expect(list.find(b => b.name === 'charmUp')?.interruptible).toBe(false);
    });
});
