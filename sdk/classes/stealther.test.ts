import { describe, expect, test } from 'bun:test';
import type { Contact } from '../group/types';
import type { Style } from '../types';
import { allCanHide, HOTSPOT_HIDE, hotspotsOf, SHOW_AFTER_MS, wantHidden, angleFrom, openerFor, sideOf, sideToTake, softTarget, standPoint, stealther } from './stealther';

const style = (name: string): Style => ({ name, internalId: 1, specLevel: 1, specName: 'Critical Strike', skillIndex: 3 } as Style);
const contact = (over: Partial<Contact>): Contact => ({
    objectId: 1, name: 'x', kind: 'player', realm: 'midgard', x: 0, y: 0, z: 0, hp: 100, regionId: 252, stale: false, isDead: false, ...over,
} as unknown as Contact);

describe('where we stand', () => {
    // Heading 0 faces +y (headingBetween: atan2(-dx, dy)).
    const t = { x: 1000, y: 1000, heading: 0 };
    test('in front, behind and to the side, as the server cones them', () => {
        expect(sideOf(angleFrom(t, { x: 1000, y: 1100 }))).toBe('front');
        expect(sideOf(angleFrom(t, { x: 1000, y: 900 }))).toBe('back');
        expect(sideOf(angleFrom(t, { x: 1100, y: 1000 }))).toBe('side');
        expect(sideOf(angleFrom(t, { x: 900, y: 1000 }))).toBe('side');
    });

    test('standPoint lands on the side it names, whatever the heading', () => {
        for (const heading of [0, 700, 1024, 2048, 3500]) {
            const target = { x: 5000, y: 5000, heading };
            expect(sideOf(angleFrom(target, standPoint(target, 'front')))).toBe('front');
            expect(sideOf(angleFrom(target, standPoint(target, 'back')))).toBe('back');
            const p = standPoint(target, 'back');
            expect(Math.round(Math.hypot(p.x - 5000, p.y - 5000))).toBe(70);
        }
    });
});

describe('the opener', () => {
    const all = [style('Backstab'), style('Backstab II'), style('Perforate Artery'), style('Garrote')];
    test('Perforate Artery in front, the best Backstab behind, none from the side', () => {
        expect(openerFor(all, 'front')?.name).toBe('Perforate Artery');
        expect(openerFor(all, 'back')?.name).toBe('Backstab II');
        expect(openerFor(all, 'side')).toBeNull();
        expect(openerFor([style('Backstab')], 'back')?.name).toBe('Backstab');
    });

    test('walks to the front with Perforate Artery, else behind, else no opener at all', () => {
        expect(sideToTake(all)).toBe('front');
        expect(sideToTake([style('Backstab')])).toBe('back');
        expect(sideToTake([style('Garrote')])).toBeNull();
    });
});

describe('softTarget', () => {
    test('a healer, caster or crowd controller by the read, or by its deeds', () => {
        expect(softTarget(contact({ classGuess: { classes: ['Healer'], p: [1], role: 'healer', basis: [] } }), [])).toBe(true);
        expect(softTarget(contact({ caster: true } as Partial<Contact>), [])).toBe(true);
    });

    test('a tank alone is soft, a tank with friends near is not, unless it is going down', () => {
        const tank = contact({ objectId: 1, classGuess: { classes: ['Warrior'], p: [1], role: 'tank', basis: [] } });
        const friend = contact({ objectId: 2, x: 600 });
        const far = contact({ objectId: 3, x: 3000 });
        expect(softTarget(tank, [tank, far])).toBe(true);
        expect(softTarget(tank, [tank, friend])).toBe(false);
        expect(softTarget({ ...tank, hp: 40 }, [tank, friend])).toBe(true);
        // A stale friend doesn't count, nor a monster.
        expect(softTarget(tank, [tank, { ...friend, stale: true }])).toBe(true);
        expect(softTarget(tank, [tank, { ...friend, kind: 'npc' }])).toBe(true);
    });
});

describe('wantHidden: open on the road, hidden by an enemy or a hotspot', () => {
    const far = { hidden: false, engaged: false, enemyInView: false, sinceEnemyMs: Infinity, hotspotDist: 9000 };
    test('travelling with nobody in view, far from the hotspots: open, at full speed', () => {
        expect(wantHidden(far)).toBe(false);
    });
    test('an enemy in view, a hotspot near, or an engage: hidden', () => {
        expect(wantHidden({ ...far, enemyInView: true, sinceEnemyMs: 0 })).toBe(true);
        expect(wantHidden({ ...far, hotspotDist: HOTSPOT_HIDE })).toBe(true);
        expect(wantHidden({ ...far, engaged: true })).toBe(true);
    });
    test('hidden stays hidden 30 s after the last enemy, and inside 5000 of a hotspot', () => {
        expect(wantHidden({ ...far, hidden: true, sinceEnemyMs: SHOW_AFTER_MS - 1 })).toBe(true);
        expect(wantHidden({ ...far, hidden: true, sinceEnemyMs: SHOW_AFTER_MS })).toBe(false);
        expect(wantHidden({ ...far, hidden: true, hotspotDist: 4800 })).toBe(true);
        expect(wantHidden({ ...far, hidden: false, hotspotDist: 4800 })).toBe(false);
    });
    test("Thidranki's hotspots: the meeting point and the three pair spots", () => {
        expect(hotspotsOf(252)).toHaveLength(4);
        expect(hotspotsOf(1)).toEqual([]);
    });
});

test('only a solo or a squad of stealthers hides: the rest would be trailed at 115', () => {
    const m = (className: string, isDead = false) => ({ className, isDead });
    expect(allCanHide([m('Infiltrator')])).toBe(true);
    expect(allCanHide([m('Shadowblade'), m('Huntress')])).toBe(true);
    expect(allCanHide([m('Nightshade'), m('Druid')])).toBe(false);
    // A dead one doesn't hold it back.
    expect(allCanHide([m('Scout'), m('Cleric', true)])).toBe(true);
});

test('the kit: melee, hide and the poison swap as instants, the ambush ahead of the melee fight, poisons as chores', () => {
    const c = stealther();
    expect(c.role).toBe('melee');
    expect(c.instant!.map(b => b.name)).toEqual(['hide', 'swapPoison']);
    expect(c.fight!.map(b => b.name)).toEqual(['ambush', 'assistMelee']);
    expect(c.chores!.map(b => b.name)).toEqual(['restock', 'envenom']);
});
