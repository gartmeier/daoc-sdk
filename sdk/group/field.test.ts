// Field mode: a run with no end time keeps its log and its observer bounded (runner.ts RunBounds), and its totals are
// the same as an unbounded run's.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { contact, enemy, picture, report } from './fixtures';
import { formatReport, GroupObserver, saveReport, stampOf, type ObserverBounds } from './observer';
import { FIELD_BOUNDS, lineLog, runBounds } from './runner';
import type { MemberReport } from './types';

const T0 = 1_800_000_000_000;

const members = (over: Partial<Record<string, Partial<MemberReport>>> = {}): MemberReport[] => [
    report('Tank', { role: 'tank', objectId: 1, x: 0, ...over.Tank }),
    report('Druid', { role: 'healer', objectId: 2, x: 600, ...over.Druid }),
    report('Menta', { role: 'nuker', objectId: 4, x: 1000, ...over.Menta }),
];

/**
 * `n` fights of different lengths and tank holds, every third with enemy players (every sixth with two realms), a
 * nuke from Menta in some and none in others, calm between: the same pictures to every observer.
 */
function feed(o: GroupObserver, n: number): void {
    let t = T0;
    const at = () => (t += 1000);
    for (let k = 0; k < n; k++) {
        for (let i = 0; i < 4; i++) o.sample(picture(members(), [], { seq: 2 * k + 1, phase: 'recover' }, at()));
        const len = 3 + (k % 5);
        const pvp = k % 3 === 0;
        const foes = pvp ? [enemy(500 + k, 'midgard', { x: 1200, threat: true, target: 'Tank' }), ...(k % 6 === 0 ? [enemy(900 + k, 'hibernia', { x: 1300, threat: true, target: 'Tank' })] : [])] : [];
        for (let i = 0; i < len; i++) {
            const held = i < len - (k % 3);
            const mob = contact(10 + k, { target: held ? 'Tank' : 'Druid', threat: true, x: held ? 0 : 600 });
            const now = at();
            if (k % 2 === 0 && i === 1) o.handle({ at: now - 500, kind: 'activity', member: 'Menta', targetId: 10 + k, text: 'nuke', data: { activity: 'nuke' } });
            o.sample(picture(members(), [mob, ...foes], { seq: 2 * k + 2, phase: 'engage', focus: 10 + k }, now));
        }
        o.handle({ at: t + 100, kind: 'kill', member: 'Tank', targetId: 10 + k, text: 'mob died', data: { name: `mob ${k}` } });
    }
    for (let i = 0; i < 5; i++) o.sample(picture(members(), [], { seq: 2 * n + 1, phase: 'recover' }, at()));
}

const observer = (bounds?: ObserverBounds) => new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0, ...(bounds ? { bounds } : {}) });

describe('runBounds', () => {
    test('none for a timed run, FIELD_BOUNDS with no end time, and the caller\'s own over either', () => {
        expect(runBounds(600)).toBeUndefined();
        expect(runBounds(Infinity)).toEqual(FIELD_BOUNDS);
        expect(runBounds(Infinity, { fights: 5 })).toEqual({ fights: 5 });
        expect(runBounds(600, { logLines: 10 })).toEqual({ logLines: 10 });
    });
});

describe('GroupObserver with bounds', () => {
    test('keeps the last fights, and the totals count every one as the unbounded observer does', () => {
        const all = observer(), kept = observer({ fights: 4, samples: 1000 });
        feed(all, 25);
        feed(kept, 25);
        const a = all.report(), b = kept.report();
        expect(a.fights).toHaveLength(25);
        expect(b.fights).toHaveLength(4);
        expect(b.fights).toEqual(a.fights.slice(-4));
        expect(a.foldedFights).toBeUndefined();
        expect(b.foldedFights).toBe(21);
        expect(b.totals).toEqual(a.totals);
        expect(a.totals.engagements).toBeGreaterThan(0);
        expect(a.totals.threeWay).toBeGreaterThan(0);
        for (const k of ['openerMs', 'fightsWithoutNuke'] as const) expect(b.members.Menta![k]).toEqual(a.members.Menta![k]);
        expect(a.members.Menta!.fightsWithoutNuke).toBeGreaterThan(0);
        expect(formatReport(b)).toContain('21 earlier fights are counted in the totals, not listed.');
        expect(formatReport(a)).not.toContain('earlier fights');
    });

    test('a snapshot mid-fight leaves the folding alone', () => {
        const o = observer({ fights: 2 });
        feed(o, 6);
        o.sample(picture(members(), [contact(99, { target: 'Tank', threat: true })], { seq: 99, phase: 'engage', focus: 99 }, T0 + 500_000));
        const s = o.snapshot();
        expect(s.openFight).toBe(true);
        expect(s.totals.fights).toBe(7);
        expect(o.report().totals.fights).toBe(7);
    });

    test('the values behind a median: the last `samples`, and the count within 1000 of all of them', () => {
        const o = observer({ samples: 3 });
        const ranges = [500, 800, 1500, 2000, 2500, 3000];
        ranges.forEach((x, i) => o.sample(picture(members(), [enemy(700 + i, 'midgard', { x: 1000 + x })], { seq: 1, phase: 'travel' }, T0 + (i + 1) * 1000)));
        const r = o.report();
        // Nearest member is Menta at x 1000: the ranges themselves. The last three: 2000, 2500, 3000.
        expect(r.totals.firstSightRange).toBe(2500);
        expect(r.totals.firstSightClose).toBe(2);
    });
});

describe('lineLog with a bound', () => {
    test('holds at most twice the bound, writing the oldest out ahead in order', () => {
        const spilled: string[] = [];
        const out = lineLog(() => {}, { lines: 3, spill: l => spilled.push(...l) });
        for (let i = 1; i <= 7; i++) out.log(`line ${i}`);
        expect(out.lines.length).toBeLessThan(6);
        expect([...spilled, ...out.lines].map(l => l.slice(9))).toEqual([1, 2, 3, 4, 5, 6, 7].map(i => `line ${i}`));
    });

    test('a spill that throws costs the lines, not the run', () => {
        const out = lineLog(() => {}, { lines: 1, spill: () => { throw new Error('disk full'); } });
        expect(() => { for (let i = 0; i < 5; i++) out.log(`x${i}`); }).not.toThrow();
    });

    test('unbounded: every line kept, as before', () => {
        const out = lineLog(() => {});
        for (let i = 0; i < 5000; i++) out.log(`l${i}`);
        expect(out.lines).toHaveLength(5000);
    });
});

describe('saveReport appendLog', () => {
    test('adds the last lines to the log the run already wrote', () => {
        const dir = mkdtempSync(join(tmpdir(), 'field-'));
        try {
            const o = observer();
            feed(o, 1);
            const r = o.report();
            const log = join(dir, 'runs', `${stampOf(r.startedAt)}.log`);
            saveReport(dir, r, ['first']);
            saveReport(dir, r, ['second'], { appendLog: true });
            expect(readFileSync(log, 'utf8')).toBe('first\nsecond\n');
            writeFileSync(log, 'old\n');
            saveReport(dir, r, ['new']);
            expect(readFileSync(log, 'utf8')).toBe('new\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
