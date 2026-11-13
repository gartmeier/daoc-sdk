import { describe, expect, test } from 'bun:test';
import { foe, frame } from './realm-board-fixtures';
import { foesIn, mergeFoes, RealmBoard, roleOf } from './realm-board';

// ── tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('foesIn', () => {
    test('takes only enemy players the run board holds, fresh, alive, in the region, of another realm', () => {
        const f = frame({
            id: 'camelot', members: [{ name: 'A', x: 0, y: 0 }], foes: [
                { id: 1, x: 100, y: 0 },
                { id: 2, x: 100, y: 0, board: false },        // a raw client sighting: server truth, left out
                { id: 3, x: 100, y: 0, stale: true },
                { id: 4, x: 100, y: 0, dead: true },
                { id: 5, x: 100, y: 0, regionId: 1 },
                { id: 6, x: 100, y: 0, realm: 'albion' },
                { id: 7, x: 100, y: 0, npc: true },
            ],
        });
        expect(foesIn(f, 'albion').map(x => x.objectId)).toEqual([1]);
    });

    test('reads the role from a class read when there is one, else from the signs', () => {
        expect(roleOf(foe({ id: 1, x: 0, y: 0, role: 'tank', healer: true }).board!)).toBe('tank');
        expect(roleOf(foe({ id: 1, x: 0, y: 0, healer: true }).board!)).toBe('healer');
        expect(roleOf(foe({ id: 1, x: 0, y: 0, caster: true }).board!)).toBe('caster');
        expect(roleOf(foe({ id: 1, x: 0, y: 0 }).board!)).toBe('unknown');
    });
});

describe('mergeFoes', () => {
    test('one foe seen by two units is one, with both units and every viewer', () => {
        const a = foesIn(frame({ id: 'a', members: [], foes: [{ id: 1, x: 0, y: 0, seenBy: ['A'] }] }), 'albion');
        const b = foesIn(frame({ id: 'b', members: [], foes: [{ id: 1, x: 0, y: 0, seenBy: ['B'], healer: true }] }), 'albion');
        const m = mergeFoes([a, b]);
        expect(m).toHaveLength(1);
        expect(m[0]!.units).toEqual(['a', 'b']);
        expect(m[0]!.seenBy).toEqual(['A', 'B']);
        expect(m[0]!.role).toBe('healer');
    });
});

describe('RealmBoard', () => {
    test('a unit: centre and health of its living, fight from the phase or combat, caught and flee from the reason', () => {
        const board = new RealmBoard('albion');
        const v = board.update({
            camelot: frame({ id: 'camelot', phase: 'engage', members: [{ name: 'A', x: 0, y: 0, hp: 50 }, { name: 'B', x: 200, y: 0, hp: 100 }, { name: 'C', x: 9000, y: 0, dead: true }] }),
            'camelot-s1': frame({ id: 'camelot-s1', phase: 'retreat', reason: 'flee: 3 on us', members: [{ name: 'D', x: 0, y: 0 }] }),
            'camelot-s2': frame({ id: 'camelot-s2', phase: 'travel', reason: 'caught: by 2', members: [{ name: 'E', x: 0, y: 0, combat: true }] }),
        }, 1000);
        const [a, s1, s2] = v.units;
        expect(a!.alive).toBe(2);
        expect(a!.size).toBe(3);
        expect(a!.centre).toEqual({ x: 100, y: 0, z: 0 });
        expect(a!.hp).toBe(75);
        expect(a!.inFight).toBe(true);
        expect(s1!.fleeing).toBe(true);
        expect(s2!.caught).toBe(true);
        expect(s2!.inFight).toBe(true);
    });

    test('no live run: not running, and its world gives no foes', () => {
        const v = new RealmBoard('albion').update({ a: frame({ id: 'a', noRun: true, members: [{ name: 'A', x: 0, y: 0 }], foes: [{ id: 1, x: 0, y: 0 }] }) }, 0);
        expect(v.units[0]!.running).toBe(false);
        expect(v.foes).toHaveLength(0);
    });

    test('members of another realm or region are not ours here; a run ignores members outside it', () => {
        const v = new RealmBoard('albion').update({
            a: frame({ id: 'a', members: [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: 0, y: 0, regionId: 1 }, { name: 'C', x: 0, y: 0, realm: 'midgard' }, { name: 'D', x: 0, y: 0, inRun: false }] }),
        }, 0);
        expect(v.units[0]!.members.map(m => m.name)).toEqual(['A']);
    });

    test('deaths are counted once, on the frame that shows them, and forgotten after three minutes', () => {
        const board = new RealmBoard('albion');
        const alive = frame({ id: 'a', members: [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: 0, y: 0 }] });
        const dead = frame({ id: 'a', members: [{ name: 'A', x: 0, y: 0 }, { name: 'B', x: 0, y: 0, dead: true }] });
        board.update({ a: alive }, 0);
        expect(board.update({ a: dead }, 1000).units[0]!.losses).toEqual([{ name: 'B', at: 1000 }]);
        expect(board.update({ a: dead }, 2000).units[0]!.losses).toHaveLength(1);
        expect(board.update({ a: null }, 3000).units[0]!.losses).toHaveLength(1);
        expect(board.update({ a: dead }, 200_000).units[0]!.losses).toHaveLength(0);
    });

    test('a frame not read is kept 10 s, then the unit is gone', () => {
        const board = new RealmBoard('albion');
        board.update({ a: frame({ id: 'a', members: [{ name: 'A', x: 0, y: 0 }] }) }, 0);
        expect(board.update({ a: null }, 9000).units).toHaveLength(1);
        expect(board.update({ a: null }, 11_000).units).toHaveLength(0);
    });

    test('totals stay from the last frame that carried the report, for the same run', () => {
        const board = new RealmBoard('albion');
        board.update({ a: frame({ id: 'a', members: [{ name: 'A', x: 0, y: 0 }], playerKills: 3 }) }, 0);
        expect(board.update({ a: frame({ id: 'a', members: [{ name: 'A', x: 0, y: 0 }] }) }, 1000).units[0]!.totals).toEqual({ playerKills: 3, deathsToPlayers: 0 });
        expect(board.update({ a: frame({ id: 'a', runId: 'other', members: [{ name: 'A', x: 0, y: 0 }] }) }, 2000).units[0]!.totals).toBeNull();
    });
});

test('mainBodyOf: the members about the one with most others near; a straggler 15000 off is left out (live 17:55)', async () => {
    const { mainBodyOf } = await import('./realm-board');
    const ms = [{ x: 31_000, y: 28_000 }, { x: 31_300, y: 28_100 }, { x: 30_900, y: 28_400 }, { x: 17_500, y: 18_300 }];
    expect(mainBodyOf(ms)).toHaveLength(3);
    expect(mainBodyOf(ms.slice(2))).toHaveLength(2);
});
