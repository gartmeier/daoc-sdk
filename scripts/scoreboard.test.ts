import { describe, expect, test } from 'bun:test';
import { fighters, standings, toRun, type Run } from './scoreboard';

const report = (over: object = {}) => ({
    group: 'hibernia', strategy: 'hibernia-pack', startedAt: '2026-11-04T01:00:00Z', durationMs: 600_000,
    totals: { kills: 9, playerKills: 7, deaths: 2, realmPoints: 50, alivePct: 90 },
    members: { Niamh: { className: 'Mentalist', dealt: 100, deaths: 1 } },
    ...over,
});
const run = (over: Partial<Run>): Run => ({ ...toRun(report())!, ...over });

describe('toRun', () => {
    test('reads a full RvR round, with kills from players', () => {
        expect(toRun(report())).toMatchObject({ group: 'hibernia', seconds: 600, kills: 7, deaths: 2, realmPoints: 50 });
    });

    test('leaves out PvE, rounds before level 24, short runs and broken reports', () => {
        expect(toRun(report({ strategy: 'hibernia-pve' }))).toBeNull();
        expect(toRun(report({ startedAt: '2026-11-01T01:00:00Z' }))).toBeNull();
        expect(toRun(report({ durationMs: 14_000 }))).toBeNull();
        expect(toRun(report({ totals: undefined }))).toBeNull();
        expect(toRun({})).toBeNull();
    });
});

describe('standings', () => {
    test('counts only the last rounds, and ranks by kills per death', () => {
        const runs = [
            run({ group: 'midgard', startedAt: '1', kills: 100, deaths: 1 }),
            run({ group: 'midgard', startedAt: '2', kills: 3, deaths: 3 }),
            run({ group: 'hibernia', startedAt: '2', kills: 5, deaths: 0 }),
        ];
        const s = standings(runs, 1);
        expect(s.map(x => [x.group, x.kills, x.kd])).toEqual([['hibernia', 5, 5], ['midgard', 3, 1]]);
    });
});

describe('fighters', () => {
    test('adds a character across its group\'s last rounds, most damage first', () => {
        const a = { name: 'A', className: 'Hero', dealt: 10, deaths: 1 };
        const b = { name: 'B', className: 'Bard', dealt: 15, deaths: 0 };
        const f = fighters([run({ startedAt: '1', members: [a] }), run({ startedAt: '2', members: [a] }), run({ startedAt: '2', group: 'camelot', members: [b] })], 5);
        expect(f.map(x => [x.name, x.dealt, x.deaths, x.group])).toEqual([['A', 20, 2, 'hibernia'], ['B', 15, 0, 'camelot']]);
    });
});
