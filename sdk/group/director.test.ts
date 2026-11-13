import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askedOf, callsFor, callWatch, defaultRaid, DIRECTOR_SETTINGS, musterHold, RealmDirector, type AnswersFile, type CallsFile, type RealmCall } from './director';
import { homeOf, THIDRANKI } from './keeps';
import { frame, type FoeSpec, type MemberSpec } from './realm-board-fixtures';

const at = (x: number, y: number, n: number, prefix: string, over: Partial<MemberSpec> = {}): MemberSpec[] =>
    Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, x: x + i * 50, y, ...over }));
const foes = (x: number, y: number, n: number, from = 1, over: Partial<FoeSpec> = {}): FoeSpec[] =>
    Array.from({ length: n }, (_, i) => ({ id: from + i, x: x + i * 50, y, ...over }));

const UNITS = ['camelot', 'camelot-2', 'camelot-s1', 'camelot-s2'];
const director = (over: Partial<ConstructorParameters<typeof RealmDirector>[0]> = {}) => new RealmDirector({ realm: 'albion', units: UNITS, write: false, ...over });
/** A middle-of-the-map spot, far from every keep. */
const MID = { x: 30000, y: 30000 };

describe('help calls', () => {
    test('a unit in a fight with more enemies near than ours calls; the nearest free unit is asked', () => {
        const d = director();
        const out = d.update({
            'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x, MID.y, 2, 'S'), foes: foes(MID.x + 500, MID.y, 4) }),
            camelot: frame({ id: 'camelot', phase: 'travel', members: at(MID.x + 3000, MID.y, 6, 'G') }),
            'camelot-2': frame({ id: 'camelot-2', phase: 'travel', members: at(MID.x + 6500, MID.y, 6, 'H') }),
        }, 1000, []);
        expect(out.calls).toHaveLength(1);
        const c = out.calls[0]!;
        expect(c).toMatchObject({ kind: 'help', from: 'camelot-s1', why: 'outnumbered', foes: 4, ours: 2 });
        expect(c.asked).toEqual(['camelot']);
        expect(c.want).toBe(0);
        expect(out.events.map(e => e.kind)).toEqual(['open', 'ask']);
    });

    test('even odds is no call; nor a fight with nobody near, nor a unit out of a fight (first sight off)', () => {
        const d = director({ settings: { sight: false } });
        expect(d.update({ camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 3, 'G'), foes: foes(MID.x + 300, MID.y, 3) }) }, 0, []).calls).toHaveLength(0);
        expect(d.update({ camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 4000, MID.y, 3) }) }, 0, []).calls).toHaveLength(0);
        expect(d.update({ camelot: frame({ id: 'camelot', phase: 'travel', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 3) }) }, 0, []).calls).toHaveLength(0);
    });

    test('first sight: a bigger group of one realm within 5000 calls sighted, in a fight or not; fewer than 3, even, or split over two realms does not', () => {
        const one = (members: number, f: ReturnType<typeof foes>, phase = 'travel') => director().update({ camelot: frame({ id: 'camelot', phase, members: at(MID.x, MID.y, members, 'G'), foes: f }) }, 0, []).calls;
        expect(one(1, foes(MID.x + 4000, MID.y, 3))[0]).toMatchObject({ why: 'sighted', foes: 3, ours: 1 });
        expect(one(1, foes(MID.x + 4000, MID.y, 3), 'engage')[0]).toMatchObject({ why: 'sighted' });
        expect(one(4, foes(MID.x + 4000, MID.y, 5))[0]).toMatchObject({ why: 'sighted', foes: 5 });
        expect(one(1, foes(MID.x + 4000, MID.y, 2))).toHaveLength(0);
        expect(one(5, foes(MID.x + 4000, MID.y, 5))).toHaveLength(0);
        expect(one(1, foes(MID.x + 6000, MID.y, 6))).toHaveLength(0);
        // 2 Midgard and 2 Hibernia: two groups of 2, no call.
        expect(one(1, [...foes(MID.x + 3000, MID.y, 2), ...foes(MID.x + 3000, MID.y + 500, 2, 10, { realm: 'hibernia' })])).toHaveLength(0);
    });

    test('first sight: helpers from up to 9000, their places on the call; it turns outnumbered once in a fight', () => {
        const d = director();
        const helpers = { camelot: frame({ id: 'camelot', members: at(MID.x + 8500, MID.y, 6, 'G') }) };
        let out = d.update({ ...helpers, 'camelot-s1': frame({ id: 'camelot-s1', members: at(MID.x, MID.y, 2, 'S'), foes: foes(MID.x - 4000, MID.y, 4) }) }, 0, []);
        const c = out.calls[0]!;
        expect(c).toMatchObject({ why: 'sighted', asked: ['camelot'] });
        expect(c.helpers?.[0]).toMatchObject({ unit: 'camelot', alive: 6 });
        expect(out.events.find(e => e.kind === 'open')).toMatchObject({ nearest: expect.any(Number), fight: false });
        out = d.update({ ...helpers, 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x, MID.y, 2, 'S'), foes: foes(MID.x + 300, MID.y, 4) }) }, 1000, []);
        expect(out.calls[0]).toMatchObject({ id: c.id, why: 'outnumbered' });
        expect(out.events.find(e => e.kind === 'why')).toMatchObject({ why: 'outnumbered', was: 'sighted' });
    });

    test('closeAll: open calls close as stopped, not wiped', () => {
        const d = director();
        d.update({ 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x, MID.y, 1, 'S'), foes: foes(MID.x + 300, MID.y, 4) }) }, 0, []);
        d.startMuster({ rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } });
        d.update({ 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x, MID.y, 1, 'S'), foes: foes(MID.x + 300, MID.y, 4) }) }, 1000, []);
        const ev = d.closeAll('stopped', 2000);
        expect(ev.map(e => e.kind === 'close' && e.end)).toEqual(['stopped', 'stopped']);
        expect(d.calls()).toHaveLength(0);
    });

    test('ours of another unit standing in the fight count, so no call', () => {
        const d = director();
        const out = d.update({
            camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 2, 'G'), foes: foes(MID.x + 300, MID.y, 3) }),
            'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x + 200, MID.y, 2, 'S') }),
        }, 0, []);
        // camelot sees 3 against 2 + 2; camelot-s1's board has none.
        expect(out.calls).toHaveLength(0);
    });

    test('caught: the reason says so, or a third lost in 30 s, with enemies near, even at even odds; one more is wanted', () => {
        const d = director();
        const helpers = { camelot: frame({ id: 'camelot', members: at(MID.x + 2000, MID.y, 6, 'G') }) };
        let out = d.update({ ...helpers, 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', reason: 'caught: 2 came out of the trees', members: at(MID.x, MID.y, 3, 'S'), foes: foes(MID.x + 300, MID.y, 2) }) }, 0, []);
        expect(out.calls[0]).toMatchObject({ why: 'caught', asked: ['camelot'] });

        const d2 = director();
        const three = at(MID.x, MID.y, 3, 'S');
        d2.update({ ...helpers, 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: three, foes: foes(MID.x + 300, MID.y, 2) }) }, 0, []);
        out = d2.update({ ...helpers, 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: [three[0]!, three[1]!, { ...three[2]!, dead: true }], foes: foes(MID.x + 300, MID.y, 2) }) }, 1000, []);
        expect(out.calls[0]).toMatchObject({ why: 'caught', from: 'camelot-s1' });
    });

    test('a unit fleeing with enemies near is caught', () => {
        const out = director().update({ 'camelot-s1': frame({ id: 'camelot-s1', phase: 'retreat', reason: 'flee: 3 on 2', members: at(MID.x, MID.y, 2, 'S'), foes: foes(MID.x + 600, MID.y, 2) }) }, 0, []);
        expect(out.calls[0]?.why).toBe('caught');
    });

    test('helpers: not one in its own fight, low on health or numbers, or too far; nearest first until even', () => {
        const d = director();
        const out = d.update({
            camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 6) }),
            'camelot-2': frame({ id: 'camelot-2', phase: 'engage', members: at(MID.x + 3000, MID.y, 6, 'H') }),           // own fight
            'camelot-s1': frame({ id: 'camelot-s1', members: at(MID.x + 2500, MID.y, 3, 'S', { hp: 30 }) }),               // hurt
            'camelot-s2': frame({ id: 'camelot-s2', members: [...at(MID.x + 2500, MID.y, 1, 'T'), ...at(MID.x + 2500, MID.y, 2, 'U', { dead: true })] }), // 1 of 3
        }, 0, []);
        expect(out.calls[0]!.asked).toEqual([]);
        expect(out.calls[0]!.want).toBe(6);

        const far = director().update({
            camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 3) }),
            'camelot-2': frame({ id: 'camelot-2', members: at(MID.x + 8000, MID.y, 6, 'H') }),
            'camelot-s1': frame({ id: 'camelot-s1', members: at(MID.x + 3000, MID.y, 2, 'S') }),
            'camelot-s2': frame({ id: 'camelot-s2', members: at(MID.x + 2500, MID.y, 1, 'T') }),
        }, 0, []);
        // 3 foes + 1 against 1: 3 more, nearest first: s2 (1), s1 (2). camelot-2 is past reach.
        expect(far.calls[0]!.asked).toEqual(['camelot-s2', 'camelot-s1']);
    });

    test('a unit asked for one call is not asked for another', () => {
        const out = director().update({
            camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 3) }),
            'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x + 4000, MID.y, 1, 'S'), foes: foes(MID.x + 4300, MID.y, 3, 10) }),
            'camelot-2': frame({ id: 'camelot-2', members: at(MID.x + 2000, MID.y, 6, 'H') }),
        }, 0, []);
        const asked = out.calls.flatMap(c => c.asked);
        expect(asked).toEqual(['camelot-2']);
    });

    test('answers: coming counts toward the odds; declined drops it; the arrival is measured', () => {
        const d = director();
        const fight = (x2: number, now: number, answers: AnswersFile[]) => d.update({
            camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 2, 'G'), foes: foes(MID.x + 300, MID.y, 5) }),
            'camelot-2': frame({ id: 'camelot-2', members: at(x2, MID.y, 6, 'H') }),
        }, now, answers);
        const first = fight(MID.x + 5000, 0, []);
        const id = first.calls[0]!.id;
        expect(first.calls[0]!.asked).toEqual(['camelot-2']);
        const ans = (state: 'coming' | 'declined', t: number): AnswersFile => ({ v: 1, unit: 'camelot-2', answers: { [id]: { state, why: 'odds', at: t } } });
        let out = fight(MID.x + 3000, 2000, [ans('coming', 1500)]);
        expect(out.calls[0]!.coming).toEqual(['camelot-2']);
        expect(out.events.find(e => e.kind === 'answer')).toMatchObject({ unit: 'camelot-2', state: 'coming' });
        // The same answer again is not news.
        out = fight(MID.x + 2000, 3000, [ans('coming', 1500)]);
        expect(out.events.filter(e => e.kind === 'answer')).toHaveLength(0);
        out = fight(MID.x + 1000, 9000, [ans('coming', 1500)]);
        expect(out.events.find(e => e.kind === 'arrive')).toMatchObject({ unit: 'camelot-2', ms: 9000, answered: true });
        out = fight(MID.x + 1000, 10_000, [ans('declined', 9500)]);
        expect(out.calls[0]!.coming).toEqual([]);
    });

    test('a call closes 15 s after its fight went quiet, with what the caller lost and who arrived', () => {
        const d = director();
        const members = at(MID.x, MID.y, 3, 'S');
        d.update({ 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members, foes: foes(MID.x + 300, MID.y, 4), playerKills: 1 }) }, 0, []);
        d.update({ 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: [members[0]!, members[1]!, { ...members[2]!, dead: true }], foes: foes(MID.x + 300, MID.y, 4) }) }, 5000, []);
        const quiet = frame({ id: 'camelot-s1', phase: 'travel', members: [members[0]!, members[1]!, { ...members[2]!, dead: true }], playerKills: 3 });
        expect(d.update({ 'camelot-s1': quiet }, 15_000, []).calls).toHaveLength(1);
        const out = d.update({ 'camelot-s1': quiet }, 21_000, []);
        expect(out.calls).toHaveLength(0);
        expect(out.events.find(e => e.kind === 'close')).toMatchObject({ end: 'quiet', lost: 1, wiped: false, kills: 2, foesMax: 4, ms: 21_000 });
    });

    test('a wiped caller closes its call at once', () => {
        const d = director();
        d.update({ 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x, MID.y, 1, 'S'), foes: foes(MID.x + 300, MID.y, 2) }) }, 0, []);
        const out = d.update({ 'camelot-s1': frame({ id: 'camelot-s1', phase: 'engage', members: at(MID.x, MID.y, 1, 'S', { dead: true }) }) }, 1000, []);
        expect(out.events.find(e => e.kind === 'close')).toMatchObject({ end: 'wiped', wiped: true, lost: 1 });
    });

    test('camped: enemies near our portal keep for 15 s', () => {
        const keep = homeOf(THIDRANKI, 'albion')!.keep;
        const d = director();
        const f = frame({ id: 'camelot', phase: 'recover', members: at(keep.x, keep.y, 5, 'G'), foes: foes(keep.x + 3000, keep.y, 2) });
        expect(d.update({ camelot: f }, 0, []).calls).toHaveLength(0);
        expect(d.update({ camelot: f }, 10_000, []).calls).toHaveLength(0);
        expect(d.update({ camelot: f }, 16_000, []).calls[0]).toMatchObject({ why: 'camped', from: 'camelot', foes: 2 });
    });

    test('off: the same calls in shadow, logged as such', () => {
        const d = director({ enabled: false });
        const out = d.update({ camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 3) }) }, 0, []);
        expect(out.calls).toHaveLength(1);
        expect(out.events.every(e => e.shadow)).toBe(true);
    });

    test('a unit outside the director\'s units is not read', () => {
        const out = director().update({ other: frame({ id: 'other', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 3) }) }, 0, []);
        expect(out.board.units).toHaveLength(0);
    });
});

describe('muster', () => {
    test('rally, then go once most stand at the rally point; arrivals measured per stage', () => {
        const d = director();
        const plan = { rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 3720 } };
        d.startMuster(plan);
        const away = { camelot: frame({ id: 'camelot', members: at(37000, 52000, 6, 'G') }), 'camelot-s1': frame({ id: 'camelot-s1', members: at(37000, 52000, 3, 'S') }) };
        let out = d.update(away, 0, []);
        expect(out.calls[0]).toMatchObject({ kind: 'muster', why: 'raid', stage: 'rally', at: plan.rally, target: plan.target, asked: UNITS });
        out = d.update({ ...away, camelot: frame({ id: 'camelot', members: at(33000, 44000, 6, 'G') }) }, 60_000, []);
        // 6 of 9 at the rally: below 70 %.
        expect(out.calls[0]!.stage).toBe('rally');
        expect(out.events.find(e => e.kind === 'arrive')).toMatchObject({ unit: 'camelot', ms: 60_000 });
        out = d.update({ camelot: frame({ id: 'camelot', members: at(33000, 44000, 6, 'G') }), 'camelot-s1': frame({ id: 'camelot-s1', members: at(33100, 44000, 3, 'S') }) }, 90_000, []);
        expect(out.calls[0]).toMatchObject({ stage: 'go', at: plan.target });
        expect(out.events.find(e => e.kind === 'stage')).toMatchObject({ stage: 'go', atRally: 9, of: 9 });
    });

    test('the muster call carries the raid: every member of each running unit asked, places rounded', () => {
        const d = director();
        d.startMuster({ rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } });
        const out = d.update({
            camelot: frame({ id: 'camelot', members: [{ name: 'G0', x: 37012, y: 52026, z: 3990 }, { name: 'G1', x: 37000, y: 52000, dead: true }] }),
            'camelot-s1': frame({ id: 'camelot-s1', noRun: true, members: at(30000, 30000, 2, 'S') }),
        }, 0, []);
        expect(out.calls[0]!.raid).toEqual([
            { unit: 'camelot', x: 37000, y: 52050, z: 4000, alive: true, name: 'G0', id: 14, level: 24, onWay: true },
            { unit: 'camelot', x: 37000, y: 52000, z: 0, alive: false, name: 'G1', id: 14, level: 24 },
        ]);
        // A help call carries none.
        const help = director().update({ camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 3) }) }, 0, []);
        expect(help.calls[0]!.raid).toBeUndefined();
    });

    test('the rally goes after rallyMaxMs with half there; endMuster closes it', () => {
        const d = director();
        d.startMuster({ rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } });
        const f = { camelot: frame({ id: 'camelot', members: at(33000, 44000, 4, 'G') }), 'camelot-s1': frame({ id: 'camelot-s1', members: at(37000, 52000, 3, 'S') }) };
        expect(d.update(f, 0, []).calls[0]!.stage).toBe('rally');
        expect(d.update(f, 250_000, []).calls[0]!.stage).toBe('go');
        d.endMuster('captured');
        const out = d.update(f, 260_000, []);
        expect(out.calls).toHaveLength(0);
        expect(out.events.find(e => e.kind === 'close')).toMatchObject({ end: 'captured', from: 'director' });
    });

    test('in go: captured once the target is ours, broken once most fell', () => {
        let owner = 'midgard';
        const d = director({ targetOwner: () => owner });
        d.startMuster({ rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } });
        const at6 = (n: number) => ({ camelot: frame({ id: 'camelot', members: [...at(33000, 44000, n, 'G'), ...at(33000, 44000, 6 - n, 'D', { dead: true })] }) });
        expect(d.update(at6(6), 0, []).calls[0]!.stage).toBe('go');
        expect(d.update(at6(6), 1000, []).calls).toHaveLength(1);
        owner = 'albion';
        expect(d.update(at6(6), 2000, []).events.find(e => e.kind === 'close')).toMatchObject({ end: 'captured' });

        const d2 = director();
        d2.startMuster({ rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } });
        d2.update(at6(6), 0, []);
        expect(d2.update(at6(2), 1000, []).calls).toHaveLength(1);
        expect(d2.update(at6(1), 2000, []).events.find(e => e.kind === 'close')).toMatchObject({ end: 'broken' });
    });

    test('the lord hold: past goMaxMs the clock waits while a unit reads the lord phase, up to lordMaxMs more', () => {
        const plan = { rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } };
        const f = (reason: string) => ({ camelot: frame({ id: 'camelot', phase: 'engage', reason, members: at(33000, 44000, 6, 'G') }) });
        const d = director();
        d.startMuster(plan);
        expect(d.update(f(''), 0, []).calls[0]!.stage).toBe('go');
        d.update(f('raid lord: Lady Thidranki on the roof'), 850_000, []);
        let out = d.update(f('raid lord: Lady Thidranki on the roof'), 901_000, []);
        expect(out.calls[0]!.hold).toBe('lord');
        expect(out.events.find(e => e.kind === 'hold')).toMatchObject({ why: 'lord', on: true });
        // A read in the last 30 s still holds; after that the clock ends it.
        expect(d.update(f('raid assault: wall-n is on us'), 920_000, []).calls).toHaveLength(1);
        out = d.update(f('raid assault: wall-n is on us'), 940_000, []);
        expect(out.calls).toHaveLength(0);
        expect(out.events.map(e => e.kind)).toEqual(['hold', 'close']);
        expect(out.events.find(e => e.kind === 'close')).toMatchObject({ end: 'timeout' });

        // On the lord all along: it ends at goMaxMs + lordMaxMs.
        const d2 = director();
        d2.startMuster(plan);
        d2.update(f(''), 0, []);
        expect(d2.update(f('raid lord: up to the roof'), 1_499_000, []).calls).toHaveLength(1);
        expect(d2.update(f('raid lord: up to the roof'), 1_501_000, []).events.find(e => e.kind === 'close')).toMatchObject({ end: 'timeout' });

        // Without the lord phase the clock ends it as before.
        const d3 = director();
        d3.startMuster(plan);
        d3.update(f(''), 0, []);
        expect(d3.update(f('raid assault: gate'), 901_000, []).events.find(e => e.kind === 'close')).toMatchObject({ end: 'timeout' });
    });

    test('the defence hold: the rally does not go while more defenders were seen near the target than the raid has living', () => {
        const plan = { rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } };
        // 6 at the rally and a scout by the keep: 7 living. The scout sees 8 near the target, then loses sight of them.
        const f = (n: number) => ({
            camelot: frame({ id: 'camelot', members: at(33000, 44000, 6, 'G') }),
            'camelot-s1': frame({ id: 'camelot-s1', members: at(33000, 41000, 1, 'S'), foes: foes(33000, 38500, n) }),
        });
        const d = director({ settings: { sight: false } });
        d.startMuster(plan);
        let out = d.update(f(8), 0, []);
        expect(out.calls[0]).toMatchObject({ stage: 'rally', defenders: 8, hold: 'defenders' });
        expect(out.events.find(e => e.kind === 'hold')).toMatchObject({ why: 'defenders', on: true, defenders: 8, living: 7 });
        // Out of sight, still remembered for a minute.
        expect(d.update(f(0), 30_000, []).calls[0]!.stage).toBe('rally');
        out = d.update(f(0), 61_000, []);
        expect(out.calls[0]).toMatchObject({ stage: 'go', defenders: 0 });
        expect(out.calls[0]!.hold).toBeUndefined();
        expect(out.events.map(e => e.kind)).toEqual(['hold', 'stage']);

        // Few (at most half the raid's living): no hold.
        const d2 = director({ settings: { sight: false } });
        d2.startMuster(plan);
        expect(d2.update(f(3), 0, []).calls[0]!.stage).toBe('go');

        // Held without a break for defenceMaxMs: the muster ends 'defended'.
        const d3 = director();
        d3.startMuster(plan);
        for (let t = 0; t < 600_000; t += 30_000) expect(d3.update(f(8), t, []).calls).toHaveLength(1);
        out = d3.update(f(8), 600_000, []);
        expect(out.calls).toHaveLength(0);
        expect(out.events.find(e => e.kind === 'close')).toMatchObject({ end: 'defended' });
    });

    test('the moment to raid: few defenders, the owners busy elsewhere, or the weaker side when a third realm is at the keep (S3, 2026-11-13)', () => {
        const S = DIRECTOR_SETTINGS;
        const h = (defenders: number, third: number, ownersAway: number, living = 12) => musterHold({ defenders, third, ownersAway, living }, S);
        expect(h(0, 0, 0)).toBeNull();
        expect(h(6, 0, 0)).toBeNull();                 // half of 12
        expect(h(7, 0, 0)).toBe('defenders');          // more than half
        expect(h(7, 0, 3)).toBeNull();                 // but the owners are fighting the third realm elsewhere
        expect(h(13, 0, 5)).toBe('defenders');         // more than us: never
        expect(h(2, 0, 0, 2)).toBeNull();              // at least fewMin
        expect(h(8, 8, 0)).toBe('winner');             // as many of the third realm: wait for the winner
        expect(h(10, 4, 0)).toBeNull();                // fewer: join them on the weaker side
        expect(h(20, 4, 0)).toBe('defenders');         // 16 more than our 12
    });

    test('the go: defenders by the owner\'s realm, the third realm apart, owners away from a fight seen far off', () => {
        const plan = { rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } };
        const raid = { camelot: frame({ id: 'camelot', members: at(33000, 44000, 6, 'G') }) };
        // The keep is Midgard's; a scout sees 4 Midgard and 5 Hibernia at it: wait for the winner.
        let d = director({ settings: { sight: false }, targetOwner: () => 'midgard' });
        d.startMuster(plan);
        const scout = (fs: ReturnType<typeof foes>) => frame({ id: 'camelot-s1', members: at(33000, 41000, 1, 'S'), foes: fs });
        let out = d.update({ ...raid, 'camelot-s1': scout([...foes(33000, 38500, 4), ...foes(33000, 38800, 5, 20, { realm: 'hibernia' })]) }, 0, []);
        expect(out.calls[0]).toMatchObject({ stage: 'rally', hold: 'winner', defenders: 4 });
        // 6 Midgard at it, and 4 Midgard fighting 3 Hibernia far off: the owners are busy, go.
        d = director({ settings: { sight: false }, targetOwner: () => 'midgard' });
        d.startMuster(plan);
        out = d.update({ ...raid, 'camelot-s1': scout(foes(33000, 38500, 5)) }, 0, []);
        expect(out.calls[0]).toMatchObject({ stage: 'rally', hold: 'defenders' });
        const far = frame({ id: 'camelot-s2', members: at(20000, 30000, 1, 'T'), foes: [...foes(20500, 30000, 4, 40), ...foes(21000, 30000, 3, 50, { realm: 'hibernia' })] });
        far.world.forEach(w => { w.inCombat = true; });
        out = d.update({ ...raid, 'camelot-s1': scout(foes(33000, 38500, 5)), 'camelot-s2': far }, 2000, []);
        expect(out.calls[0]).toMatchObject({ stage: 'go' });
        expect(out.events.find(e => e.kind === 'stage')).toMatchObject({ defenders: 5, third: 0, ownersAway: 4, owner: 'midgard' });
    });

    test('on its way: a raid unit closing on the target counts at any distance; one that stopped closing for 2 min does not', () => {
        const plan = { rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } };
        const d = director({ settings: { sight: false } });
        d.startMuster(plan);
        const f = (y: number) => ({ camelot: frame({ id: 'camelot', members: at(33000, 44000, 4, 'G') }), 'camelot-2': frame({ id: 'camelot-2', members: at(33000, y, 3, 'H') }) });
        const onWay = (o: ReturnType<typeof d.update>) => o.calls[0]!.raid!.filter(m => m.unit === 'camelot-2').every(m => m.onWay);
        expect(onWay(d.update(f(60000), 0, []))).toBe(true);
        expect(onWay(d.update(f(60000), 60_000, []))).toBe(true);    // just set out
        expect(onWay(d.update(f(60000), 130_000, []))).toBe(false);  // still at home after 2 min
        expect(onWay(d.update(f(58000), 140_000, []))).toBe(true);   // walking again
    });

    test('a muster counts losses and kills over every unit in the raid', () => {
        const d = director();
        d.startMuster({ rally: { x: 33000, y: 44000, z: 0 }, target: { x: 33089, y: 38271, z: 0 } });
        const f = (dead: boolean, kills: number) => ({
            camelot: frame({ id: 'camelot', playerKills: kills, members: at(33000, 44000, 6, 'G') }),
            'camelot-s1': frame({ id: 'camelot-s1', playerKills: 1, members: [{ name: 'S0', x: 33000, y: 44000 }, { name: 'S1', x: 33000, y: 44000, dead }] }),
        });
        d.update(f(false, 2), 0, []);
        d.update(f(true, 5), 1000, []);
        d.endMuster('stopped');
        expect(d.update(f(true, 5), 2000, []).events.find(e => e.kind === 'close')).toMatchObject({ end: 'stopped', lost: 1, kills: 3 });
    });

    test('on a rhythm: a muster from the raid plan once raidEveryMs passed since the last ended', () => {
        const plan = { rally: { x: 1, y: 2, z: 0 }, target: { x: 3, y: 4, z: 0 } };
        const d = director({ settings: { raidEveryMs: 60_000 }, raidPlan: () => plan });
        const f = { camelot: frame({ id: 'camelot', members: at(37000, 52000, 6, 'G') }) };
        const t0 = Date.now();
        expect(d.update(f, t0 + 1000, []).calls).toHaveLength(0);
        expect(d.update(f, t0 + 61_000, []).calls[0]).toMatchObject({ kind: 'muster', at: plan.rally });
    });

    test('defaultRaid: rally 5500 from the Faste toward our portal keep', () => {
        const r = defaultRaid('albion')!;
        expect(Math.round(Math.hypot(r.rally.x - r.target.x, r.rally.y - r.target.y))).toBeGreaterThan(5490);
        expect(r.rally.y).toBeGreaterThan(r.target.y);
    });
});

describe('the units\' side', () => {
    const call = (over: Partial<RealmCall> = {}): RealmCall => ({
        id: 'albion-1', kind: 'help', from: 'camelot', why: 'outnumbered', at: { x: 0, y: 0, z: 0 }, foes: 3, ours: 1, foeRoles: {}, want: 0,
        asked: ['camelot-s1'], coming: [], since: 0, updatedAt: 0, ...over,
    });

    test('callsFor: none while off or stale; never the unit\'s own', () => {
        const file: CallsFile = { v: 1, realm: 'albion', at: 1000, enabled: true, calls: [call(), call({ id: 'albion-2', from: 'camelot-s1' })] };
        expect(callsFor(file, 'camelot-s1', 2000).map(c => c.id)).toEqual(['albion-1']);
        expect(callsFor({ ...file, enabled: false }, 'camelot-s1', 2000)).toEqual([]);
        expect(callsFor(file, 'camelot-s1', 30_000)).toEqual([]);
        expect(callsFor(null, 'camelot-s1')).toEqual([]);
    });

    test('askedOf: the calls naming the unit, nearest first', () => {
        const calls = [call({ id: 'a', at: { x: 5000, y: 0, z: 0 } }), call({ id: 'b', at: { x: 1000, y: 0, z: 0 } }), call({ id: 'c', asked: [] })];
        expect(askedOf(calls, 'camelot-s1', { x: 0, y: 0 }).map(c => c.id)).toEqual(['b', 'a']);
    });

    let dir = '';
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

    test('through files: the director publishes, a unit reads and answers, the director reads the answer', async () => {
        dir = mkdtempSync(join(tmpdir(), 'director-'));
        const d = new RealmDirector({ realm: 'albion', units: UNITS, dir });
        const frames = {
            camelot: frame({ id: 'camelot', phase: 'engage', members: at(MID.x, MID.y, 1, 'G'), foes: foes(MID.x + 300, MID.y, 3) }),
            'camelot-s1': frame({ id: 'camelot-s1', members: at(MID.x + 2000, MID.y, 3, 'S') }),
        };
        d.update(frames, Date.now());
        const watch = callWatch('camelot-s1', 'albion', dir);
        try {
            const calls = watch.calls();
            expect(calls).toHaveLength(1);
            expect(askedOf(calls, 'camelot-s1')).toHaveLength(1);
            watch.answer(calls[0]!.id, 'coming', 'short way');
            const out = d.update(frames, Date.now());
            expect(out.calls[0]!.coming).toEqual(['camelot-s1']);
            const log = readFileSync(join(dir, 'albion-log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
            expect(log.map(e => e.kind)).toEqual(['open', 'ask', 'answer']);
            // Off: the file carries no calls.
            d.setEnabled(false);
            const file = JSON.parse(readFileSync(join(dir, 'albion.json'), 'utf8')) as CallsFile;
            expect(file.enabled).toBe(false);
            expect(file.calls).toEqual([]);
        } finally {
            watch.stop();
        }
    });

    test('a watch on a broken or missing file reads none', () => {
        dir = mkdtempSync(join(tmpdir(), 'director-'));
        const w1 = callWatch('camelot-s1', 'albion', dir);
        expect(w1.calls()).toEqual([]);
        w1.stop();
        writeFileSync(join(dir, 'albion.json'), '{ half');
        const old = new Date(Date.now() - 60_000);
        utimesSync(join(dir, 'albion.json'), old, old);
        const w2 = callWatch('camelot-s1', 'albion', dir);
        expect(w2.calls()).toEqual([]);
        w2.stop();
    });
});

describe('the defence call (S3, 2026-11-13)', () => {
    const faste = { x: 33089, y: 38271 };
    const UNITS6 = ['camelot', 'camelot-2', 'camelot-s1', 'camelot-s2', 'camelot-s3', 'camelot-s4'];
    const frames = (attackers: number) => ({
        'camelot-s1': frame({ id: 'camelot-s1', members: at(faste.x + 3000, faste.y, 2, 'S'), foes: foes(faste.x + 1500, faste.y, attackers) }),
        camelot: frame({ id: 'camelot', members: at(faste.x + 6000, faste.y, 6, 'G') }),
        'camelot-2': frame({ id: 'camelot-2', members: at(faste.x - 9000, faste.y, 6, 'H') }),
        'camelot-s2': frame({ id: 'camelot-s2', members: at(faste.x, faste.y + 8000, 2, 'T') }),
        'camelot-s3': frame({ id: 'camelot-s3', members: at(faste.x, faste.y - 13000, 1, 'U') }),
        'camelot-s4': frame({ id: 'camelot-s4', members: at(faste.x, faste.y + 30000, 1, 'V') }),
    });

    test('attackers at our keep: the nearest units are asked in, not all; it closes quiet once none is seen', () => {
        const d = director({ units: UNITS6, targetOwner: () => 'albion', settings: { sight: false } });
        let out = d.update(frames(5), 0, []);
        const c = out.calls.find(x => x.kind === 'defend')!;
        expect(c).toMatchObject({ why: 'keep', foes: 5, ours: 2 });
        // Main groups only (squads don't answer a defence yet); 5 + 1 - 2 there: the nearest group of 6 is enough.
        expect(c.asked).toEqual(['camelot']);
        // Ten attackers: more, but at most half of the six running units.
        const d2 = director({ units: UNITS6, targetOwner: () => 'albion', settings: { sight: false } });
        out = d2.update(frames(10), 0, []);
        expect(out.calls.find(x => x.kind === 'defend')!.asked).toEqual(['camelot', 'camelot-2']);
        // A third main group: up to half the running units (4 of 7), so all three.
        const d3 = director({ units: [...UNITS6, 'camelot-3'], targetOwner: () => 'albion', settings: { sight: false } });
        out = d3.update({ ...frames(14), 'camelot-3': frame({ id: 'camelot-3', members: at(faste.x, faste.y - 7000, 6, 'W') }) }, 0, []);
        expect(out.calls.find(x => x.kind === 'defend')!.asked).toHaveLength(3);
        // Not ours: no call; lost: it closes.
        expect(director({ units: UNITS6, targetOwner: () => 'midgard', settings: { sight: false } }).update(frames(5), 0, []).calls).toHaveLength(0);
        out = d.update(frames(0), 30_000, []);
        expect(out.calls.find(x => x.kind === 'defend')).toBeDefined();
        out = d.update(frames(0), 80_000, []);
        expect(out.events.find(e => e.kind === 'close')).toMatchObject({ end: 'quiet' });
    });

    test('one attacker is no defence; the keep lost closes it', () => {
        let owner = 'albion';
        const d = director({ units: UNITS6, targetOwner: () => owner, settings: { sight: false } });
        expect(d.update(frames(1), 0, []).calls).toHaveLength(0);
        expect(d.update(frames(3), 1000, []).calls).toHaveLength(1);
        owner = 'hibernia';
        expect(d.update(frames(3), 2000, []).events.find(e => e.kind === 'close')).toMatchObject({ end: 'lost' });
    });
});
