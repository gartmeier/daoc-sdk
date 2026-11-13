import { describe, expect, test } from 'bun:test';
import { rvrBehaviors } from '../group/rvr';
import { packBehaviors } from '../group/pack';
import { withCharacter } from '../group/character';
import { cleric } from './cleric';
import { druid } from './druid';
import { healer } from './healer';
import { atKeep, seenBy, standSpot, STAND_REACH, type Foe } from './healer-stand';

// A wall along x = 200 from y = -1000 to 1000: it hides what is on the other side of it from a foe east of it.
const wallX = 200;
const crosses = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    if ((a.x - wallX) * (b.x - wallX) >= 0) return false;
    const t = (wallX - a.x) / (b.x - a.x);
    const y = a.y + t * (b.y - a.y);
    return y >= -1000 && y <= 1000;
};
const los = (_r: number, from: { x: number; y: number }, to: { x: number; y: number }) => !crosses(from, to);
const flat = { los, floor: () => 0, wet: () => false, walk: (a: { x: number; y: number }, b: { x: number; y: number }) => !crosses(a, b) };
const foe = (x: number, y: number, id = 1): Foe => ({ id, x, y, z: 0 });

describe('healer stand: out of sight', () => {
    test('no step when no foe sees her', () => {
        const me = { x: 0, y: 0, z: 0 };
        expect(seenBy(1, me, [foe(1500, 0)], los)).toHaveLength(0);
        expect(standSpot(1, me, [], [foe(1500, 0)], flat)).toBeNull();
    });

    test('seen past the wall\'s end: she steps behind it, the shortest such step', () => {
        const me = { x: 0, y: 1400, z: 0 };
        const f = foe(1500, -500);
        expect(seenBy(1, me, [f], los)).toHaveLength(1);
        const s = standSpot(1, me, [], [f], flat)!;
        expect(s.seen).toBe(0);
        expect(Math.hypot(s.x - me.x, s.y - me.y)).toBeLessThanOrEqual(300);
        expect(los(1, f, s)).toBe(false);
    });

    test('keeps every member she reaches now in reach, and never steps through the wall', () => {
        const me = { x: 0, y: 1400, z: 0 };
        // A member east of her near the edge of her reach: the step west that hides her would leave him beyond STAND_REACH.
        const east = { x: STAND_REACH - 20, y: 1400 };
        expect(standSpot(1, me, [east], [foe(1500, -500)], flat)).toBeNull();
        const s = standSpot(1, me, [{ x: 0, y: 1400 + STAND_REACH - 100 }], [foe(1500, -500)], flat);
        expect(s).not.toBeNull();
        // East of the wall in the open, with the foe west of it: every spot west is a walk through the wall.
        const out = { x: 300, y: 0, z: 0 };
        const w = standSpot(1, out, [], [foe(-1500, 0)], flat);
        if (w) expect(w.x).toBeGreaterThan(wallX);
    });

    test('never nearer the nearest foe, nor into water', () => {
        const me = { x: 0, y: 1400, z: 0 };
        const f = foe(1500, -500);
        expect(standSpot(1, me, [], [f], { ...flat, wet: p => p.x < 0 })).toBeNull();
        // Dry east, the hidden spots there are nearer him (south): none.
    });

    test('in the open with nothing to hide behind: none', () => {
        const open = { ...flat, los: () => true, walk: () => true };
        expect(standSpot(1, { x: 0, y: 0, z: 0 }, [], [foe(1500, 0)], open)).toBeNull();
    });
});

describe('the healer kits carry the group heal, the stand and the clock', () => {
    for (const [name, c] of [['cleric', cleric()], ['healer', healer()], ['druid', druid()]] as const) {
        test(`${name}: groupHeal and stand above heal in the pack's list (field mode), above position in roaming's; the clock on the side`, () => {
            for (const [lists, above] of [[packBehaviors(), 'heal'], [rvrBehaviors(), 'position']] as const) {
                const list = withCharacter(lists.healer as any[], c).map(b => b.name);
                expect(list.indexOf('groupHeal')).toBeGreaterThan(-1);
                expect(list.indexOf('groupHeal')).toBeLessThan(list.indexOf(above));
                expect(list.indexOf('stand')).toBeGreaterThan(list.indexOf('groupHeal'));
                expect(list.indexOf('stand')).toBeLessThan(list.indexOf(above));
                expect(list).toContain('sightClock');
            }
        });
    }

    test('the stand can be left out', () => {
        expect(withCharacter(packBehaviors().healer as any[], cleric({ stand: false })).map(b => b.name)).not.toContain('stand');
    });
});

describe('healer stand: only in keep fights', () => {
    test('in the Faste area or on a defence seat; not in the open field, nor at a portal keep', () => {
        expect(atKeep(252, { x: 33089, y: 38271 }, false)).toBe(true);
        expect(atKeep(252, { x: 33089 + 2500, y: 38271 }, false)).toBe(true);
        expect(atKeep(252, { x: 26000, y: 30000 }, false)).toBe(false);
        expect(atKeep(252, { x: 26000, y: 30000 }, true)).toBe(true);
        expect(atKeep(1, { x: 33089, y: 38271 }, false)).toBe(false);
    });

    test('within a defence seat\'s leash only', () => {
        const me = { x: 0, y: 1400, z: 0 };
        const seat = { x: 0, y: 1400, z: 0 };
        // Hidden spots are west of her (past the wall's end): a leash of 100 leaves none, one of 300 some.
        expect(standSpot(1, me, [], [foe(1500, -500)], { ...flat, within: p => Math.hypot(p.x - seat.x, p.y - seat.y) <= 100 })).toBeNull();
        expect(standSpot(1, me, [], [foe(1500, -500)], { ...flat, within: p => Math.hypot(p.x - seat.x, p.y - seat.y) <= 300 })).not.toBeNull();
    });

    test('a spot on another floor or off the floor is none; members on other floors count in 3D', () => {
        const me = { x: 0, y: 1400, z: 0 };
        expect(standSpot(1, me, [], [foe(1500, -500)], { ...flat, floor: () => null })).toBeNull();
        // A member straight above, 1795 up: in reach from here, not from any spot 150 or more to the side.
        const above = { x: 0, y: 1400, z: STAND_REACH - 5 };
        expect(standSpot(1, me, [above], [foe(1500, -500)], flat)).toBeNull();
    });

    test('a spot without a short walk to it is none', () => {
        expect(standSpot(1, { x: 0, y: 1400, z: 0 }, [], [foe(1500, -500)], { ...flat, walk: () => false })).toBeNull();
    });
});
