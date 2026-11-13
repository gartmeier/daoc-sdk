// Fight lulls (night 2026-11-11, N3): what a member does with a turn nothing above it took. fightSit sits a caster short of
// power when no enemy is near, the tank stands by the member he guards while the focus is beyond his leash, and a caster
// holding its ground steps in behind our own front line (frontStep). A corpse with no rezzer left releases (noRezzerLeft).
import { describe, expect, test } from 'bun:test';
import { FIGHT_SIT_BELOW, FIGHT_SIT_CLEAR, fightSitBlock, FRONT_BEHIND, frontStep, guardedBy, noRezzerLeft } from './behaviors';
import { contact, enemy, report } from './fixtures';
import { packBehaviors } from './pack';
import { rvrBehaviors } from './rvr';

const R = 200;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const me = { name: 'Brigid', regionId: R, x: 1000, y: 1000, manaPercent: 60, maxMana: 400 };
const calm = { swimming: false, moving: false, hitAt: 0, now: 100_000 };

describe('fightSitBlock', () => {
    test('sits with power to win back and nobody near', () => {
        expect(fightSitBlock(me, [enemy(1, 'albion', { x: 1000 + FIGHT_SIT_CLEAR + 100, y: 1000 })], calm)).toBeNull();
    });
    test('not at full power, nor without a power bar', () => {
        expect(fightSitBlock({ ...me, manaPercent: FIGHT_SIT_BELOW }, [], calm)).toContain('power');
        expect(fightSitBlock({ ...me, maxMana: 0 }, [], calm)).toContain('no power');
    });
    test('not with a free enemy player or pet near, nor one on us at any range', () => {
        expect(fightSitBlock(me, [enemy(1, 'albion', { x: 1000 + FIGHT_SIT_CLEAR - 100, y: 1000 })], calm)).toContain('away');
        expect(fightSitBlock(me, [contact(2, { isPet: true, x: 1500, y: 1000 })], calm)).toContain('away');
        expect(fightSitBlock(me, [enemy(3, 'albion', { x: 9000, y: 1000, target: 'Brigid' })], calm)).toContain('on us');
    });
    test('a mezzed enemy counts nearer, a stale one, a dead pet or one elsewhere not at all', () => {
        const cc = { by: 'Oisin', kind: 'mezz', until: 200_000 };
        expect(fightSitBlock(me, [enemy(1, 'albion', { x: 2500, y: 1000, cc })], calm)).toBeNull();
        expect(fightSitBlock(me, [enemy(1, 'albion', { x: 1800, y: 1000, cc })], calm)).toContain('away');
        expect(fightSitBlock(me, [enemy(1, 'albion', { x: 1100, y: 1000, stale: true }), contact(2, { isPet: true, x: 1100, y: 1000, hp: 0 }), enemy(3, 'albion', { x: 1100, y: 1000, regionId: 1 })], calm)).toBeNull();
    });
    test('monsters far off or not on us leave it be', () => {
        expect(fightSitBlock(me, [contact(5, { x: 1200, y: 1000 })], calm)).toBeNull();
    });
    test('not swimming, moving or lately hit', () => {
        expect(fightSitBlock(me, [], { ...calm, swimming: true })).toBe('swimming');
        expect(fightSitBlock(me, [], { ...calm, moving: true })).toBe('moving');
        expect(fightSitBlock(me, [], { ...calm, hitAt: calm.now - 1000 })).toBe('hit lately');
    });
});

describe('guardedBy', () => {
    const members = [report('Brigid', { regionId: R, role: 'healer' }), report('Lugh', { regionId: R, isDead: true }), report('Aine', { regionId: 1 })];
    test('reads the member from our own Guard effect', () => {
        expect(guardedBy({ name: 'Cuchulainn', regionId: R }, ['Speed of the Realm', 'Brigid guarded by Cuchulainn'], members)?.name).toBe('Brigid');
    });
    test('none for another tank\'s guard, a dead or far-region member, or no effect', () => {
        expect(guardedBy({ name: 'Cuchulainn', regionId: R }, ['Brigid guarded by Fionn'], members)).toBeNull();
        expect(guardedBy({ name: 'Cuchulainn', regionId: R }, ['Lugh guarded by Cuchulainn'], members)).toBeNull();
        expect(guardedBy({ name: 'Cuchulainn', regionId: R }, ['Aine guarded by Cuchulainn'], members)).toBeNull();
        expect(guardedBy({ name: 'Cuchulainn', regionId: R }, [], members)).toBeNull();
    });
});

describe('frontStep', () => {
    const caster = { name: 'Lugh', regionId: R, x: 0, y: 0 };
    const focus = { x: 4000, y: 0 };
    const tank = (x: number, over = {}) => report('Cuchulainn', { regionId: R, role: 'tank', x, y: 0, ...over });
    test('a leg toward the focus with our tank on it', () => {
        const to = frontStep(caster, focus, 1500, [tank(3500)], [])!;
        expect(to).not.toBeNull();
        expect(to.x).toBeCloseTo(600);
        expect(to.y).toBeCloseTo(0);
    });
    test('never past FRONT_BEHIND behind the front-liner', () => {
        const to = frontStep({ ...caster, x: 2600 }, focus, 800, [tank(3500)], [])!;
        expect(dist(to, focus)).toBeCloseTo(500 + FRONT_BEHIND);
        expect(frontStep({ ...caster, x: 3100 }, focus, 800, [tank(3500)], [])).toBeNull();
    });
    test('none without a front-liner on the focus: dead, far from it, in another region, or a caster', () => {
        expect(frontStep(caster, focus, 1500, [], [])).toBeNull();
        expect(frontStep(caster, focus, 1500, [tank(3500, { isDead: true })], [])).toBeNull();
        expect(frontStep(caster, focus, 1500, [tank(2000)], [])).toBeNull();
        expect(frontStep(caster, focus, 1500, [tank(3500, { regionId: 1 })], [])).toBeNull();
        expect(frontStep(caster, focus, 1500, [report('Niamh', { regionId: R, role: 'nuker', x: 3500, y: 0 })], [])).toBeNull();
    });
    test('none ending beside a free enemy player; a mezzed one is no bar', () => {
        expect(frontStep(caster, focus, 1500, [tank(3500)], [enemy(1, 'albion', { regionId: R, x: 700, y: 200 })])).toBeNull();
        expect(frontStep(caster, focus, 1500, [tank(3500)], [enemy(1, 'albion', { regionId: R, x: 700, y: 200, cc: { by: 'Oisin', kind: 'mezz', until: Date.now() + 9000 } })])).not.toBeNull();
    });
});

describe('the role lists', () => {
    test('casters sit in a lull last before rest; tank and melee never', () => {
        for (const lists of [rvrBehaviors(), packBehaviors()]) {
            for (const role of ['healer', 'support', 'nuker'] as const) {
                // loiter (waves.ts) idles at the keep in a break, after everything: it never runs in a fight.
                const names = lists[role].map(b => b.name).filter(n => n !== 'loiter');
                expect(names.at(-2)).toBe('fightSit');
                expect(names.at(-1)).toBe('rest');
            }
            for (const role of ['tank', 'melee'] as const) expect(lists[role].map(b => b.name)).not.toContain('fightSit');
        }
    });
});

describe('noRezzerLeft', () => {
    const cap = (rez: boolean) => ({ heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], rez });
    test('a living member who knows a rez keeps the corpse waiting; a dead one, or only the corpse itself, does not', () => {
        expect(noRezzerLeft([report('Brigid', { capabilities: cap(true) as any }), report('Lugh')], 'Lugh')).toBe(false);
        expect(noRezzerLeft([report('Brigid', { capabilities: cap(true) as any, isDead: true }), report('Lugh')], 'Lugh')).toBe(true);
        expect(noRezzerLeft([report('Brigid', { capabilities: cap(true) as any })], 'Brigid')).toBe(true);
    });
    test('an observed member (a human) may know one we cannot see', () => {
        expect(noRezzerLeft([report('Galahad', { observed: true }), report('Lugh')], 'Lugh')).toBe(false);
    });
});
