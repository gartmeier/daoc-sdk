import { describe, expect, test } from 'bun:test';
import {
    curveAt, CURVE, groupNeeds, initialLives, LIFECYCLE_SETTINGS, logOutUnsafe, mixFor, newWave, openNeeds, readBalance, see, stepBalance,
    stepRealm, stepWave, wantsMuster, wearOf, type BalanceState, type Life, type LifeBot, type RealmStep, type Sightings,
} from './lifecycle';
import { quietSpot, waveOrder, nextIdle, QUIET_DOOR_CLEAR, QUIET_REASON, type RealmWave } from './waves';
import { doorSide, PORTAL_DOORS } from '../doors';
import { homeOf } from './keeps';
import type { RealmBoardView, UnitView } from './realm-board';

const MIN = 60_000;
const at = (h: number, m = 0) => new Date(2026, 10, 13, h, m).getTime();
/** A seeded random in [0, 1). */
function seeded(seed = 1): () => number {
    let x = seed;
    return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

const HIB: LifeBot[] = [
    ['amergin', 'Druid', true], ['fiacra', 'Bard', false], ['cathbad', 'Valewalker', false], ['laoghaire', 'Blademaster', false],
    ['deirdre', 'Mentalist', false], ['etain', 'Animist', false], ['manannan', 'Eldritch', false], ['emer', 'Enchanter', false],
    ['fergus', 'Champion', false], ['conall', 'Hero', false], ['cuchulainn', 'Hero', false], ['oisin', 'Bard', false],
    ['brigid', 'Druid', true], ['ciaran', 'Enchanter', false], ['lugh', 'Eldritch', false], ['niamh', 'Mentalist', false],
    ['aine', 'Warden', false], ['fionn', 'Blademaster', false], ['scathach', 'Nightshade', false], ['diarmuid', 'Ranger', false],
].map(([bot, className, healer]) => ({ bot: bot as string, className: className as string, healer: healer as boolean }));
const HIB_NEEDS = groupNeeds(['Druid', 'Bard'], HIB);

function step(lives: Life[], o: Partial<RealmStep> & { target: number }, now: number, rand = seeded()) {
    const inGame = new Set(lives.filter(l => l.state === 'online' || l.state === 'leaving').map(l => l.bot));
    return stepRealm(lives, { inGame, held: new Set(), needs: HIB_NEEDS, pinned: { away: new Set(), stay: new Set() }, lastOut: 0, lastIn: 0, ...o }, now, rand);
}

/** Simulate a realm for `hours` from `start`: the swarm does what it is asked at once, nobody holds a bot. */
function simulate(start: number, hours: number, o: { shift?: (t: number) => number; seed?: number } = {}) {
    const rand = seeded(o.seed ?? 7);
    const lives = initialLives(HIB, 'hibernia', new Set(HIB.map(b => b.bot)), start, rand);
    const inGame = new Set(HIB.map(b => b.bot));
    let lastOut = 0, lastIn = 0;
    const samples: { t: number; playing: number; target: number; needsOpen: number }[] = [];
    const sessions: number[] = [];
    const rests: number[] = [];
    for (let t = start; t < start + hours * 60 * MIN; t += 30_000) {
        const target = Math.max(6, curveAt(t) + (o.shift?.(t) ?? 0));
        const before = new Map(lives.map(l => [l.bot, { state: l.state, since: l.since }]));
        const r = stepRealm(lives, { target, inGame, held: new Set(), needs: HIB_NEEDS, needsAt: Math.max(6, curveAt(t + 60 * MIN) + (o.shift?.(t) ?? 0)), pinned: { away: new Set(), stay: new Set() }, lastOut, lastIn }, t, rand);
        lastOut = r.lastOut; lastIn = r.lastIn;
        for (const a of r.actions) { if (a.kind === 'logIn') inGame.add(a.bot); else inGame.delete(a.bot); }
        for (const l of lives) {
            const b = before.get(l.bot)!;
            if (b.state === 'leaving' && l.state === 'offline') sessions.push(0);
            if (b.state === 'joining' && l.state === 'online') rests.push(0);
        }
        const playing = lives.filter(l => l.state === 'online');
        samples.push({ t, playing: playing.length, target, needsOpen: openNeeds(playing, HIB_NEEDS).length });
    }
    return { lives, samples, sessions, rests };
}

describe('the curve', () => {
    test('full in the evening, thin in the small hours, never below the floor', () => {
        expect(curveAt(at(20))).toBe(19);
        expect(curveAt(at(4))).toBe(7);
        expect(curveAt(at(13))).toBe(12);
        expect(curveAt(at(23, 30))).toBe(15);
        expect(Math.min(...Array.from({ length: 24 * 4 }, (_, i) => curveAt(at(0) + i * 15 * MIN)))).toBeGreaterThanOrEqual(6);
        expect(CURVE.length).toBe(24);
        expect(curveAt(at(4), CURVE.map(() => 2))).toBe(6);
    });
});

describe('the mix', () => {
    const units = ['hibernia', 'hibernia-2', 'hibernia-s1', 'hibernia-s2', 'hibernia-s3', 'hibernia-s4'];
    const max = { hibernia: 6, 'hibernia-2': 6, 'hibernia-s1': 3, 'hibernia-s2': 2, 'hibernia-s3': 1, 'hibernia-s4': 1 };
    test('two groups and squads in the evening, a group and small-man at night', () => {
        expect(mixFor(19, units, max)).toEqual({ hibernia: 6, 'hibernia-2': 6, 'hibernia-s1': 3, 'hibernia-s2': 2, 'hibernia-s3': 1, 'hibernia-s4': 1 });
        expect(mixFor(8, units, max)).toEqual({ hibernia: 5, 'hibernia-2': 0, 'hibernia-s1': 2, 'hibernia-s2': 1, 'hibernia-s3': 0, 'hibernia-s4': 0 });
        expect(mixFor(6, units, max)).toEqual({ hibernia: 5, 'hibernia-2': 0, 'hibernia-s1': 1, 'hibernia-s2': 0, 'hibernia-s3': 0, 'hibernia-s4': 0 });
    });
    test('never more than the field mix holds, never more than play', () => {
        for (let n = 0; n <= 25; n++) {
            const m = mixFor(n, units, max);
            const sum = Object.values(m).reduce((a, b) => a + b, 0);
            expect(sum).toBeLessThanOrEqual(n);
            for (const u of units) expect(m[u]!).toBeLessThanOrEqual(max[u as keyof typeof max]);
        }
        expect(mixFor(12, ['camelot', 'camelot-s1'], { camelot: 5, 'camelot-s1': 2 })).toEqual({ camelot: 5, 'camelot-s1': 2 });
    });
});

describe('needed classes', () => {
    test('a healer only when no required class heals', () => {
        expect(HIB_NEEDS).toEqual([['Druid'], ['Bard']]);
        expect(groupNeeds(['Sorcerer'], [{ bot: 'enid', className: 'Cleric', healer: true }])).toEqual([['Sorcerer'], ['healer']]);
        expect(groupNeeds([['Warrior', 'Thane']], [])).toEqual([['Warrior', 'Thane'], ['healer']]);
    });
    test('open needs match greedily, one bot a need', () => {
        const two = [...HIB_NEEDS, ...HIB_NEEDS];
        expect(openNeeds(HIB.filter(b => ['amergin', 'fiacra'].includes(b.bot)), two)).toEqual([['Druid'], ['Bard']]);
        expect(openNeeds(HIB, two)).toEqual([]);
    });
});

describe('sessions', () => {
    test('at the start the sessions end at staggered times', () => {
        const lives = initialLives(HIB, 'hibernia', new Set(HIB.map(b => b.bot)), at(13), seeded(3));
        const ends = lives.map(l => l.until - at(13)).sort((a, b) => a - b);
        expect(ends[0]!).toBeGreaterThanOrEqual(10 * MIN);
        expect(ends.at(-1)!).toBeLessThanOrEqual(180 * MIN);
        expect(new Set(ends.map(e => Math.round(e / (10 * MIN)))).size).toBeGreaterThan(6);
    });

    test('over the target one leaves early per step, only after half an hour, and is logged out once no unit holds it', () => {
        const now = at(13);
        const lives = initialLives(HIB, 'hibernia', new Set(HIB.map(b => b.bot)), now - 40 * MIN, seeded(3));
        for (const l of lives) l.until = now + 60 * MIN;
        const held = new Set(HIB.map(b => b.bot));
        const r = step(lives, { target: 12, held }, now);
        const leaving = lives.filter(l => l.state === 'leaving');
        expect(leaving.length).toBe(1);
        expect(r.actions).toEqual([]);   // held: it waits for its unit's next line-up
        const r2 = step(lives, { target: 12, held: new Set(), lastOut: r.lastOut }, now + 30_000);
        expect(r2.actions).toEqual([{ kind: 'logOut', bot: leaving[0]!.bot, realm: 'hibernia', why: 'early' }]);
        expect(lives.filter(l => l.state === 'leaving').length).toBe(1);   // one per step (stepMs)
        const young = initialLives(HIB, 'hibernia', new Set(HIB.map(b => b.bot)), now - 10 * MIN, seeded(3));
        for (const l of young) { l.since = now - 10 * MIN; l.until = now + 60 * MIN; }
        step(young, { target: 12 }, now);
        expect(young.filter(l => l.state === 'leaving').length).toBe(0);
    });

    test('under the target rested bots log in, a missing class first', () => {
        const now = at(19);
        const lives = initialLives(HIB, 'hibernia', new Set(['cathbad', 'laoghaire', 'deirdre', 'etain', 'manannan', 'emer']), now, seeded(3));
        const r = step(lives, { target: 12 }, now);
        expect(r.actions.length).toBe(2);
        const classes = r.actions.map(a => HIB.find(b => b.bot === a.bot)!.className).sort();
        expect(classes).toEqual(['Bard', 'Druid']);
        expect(lives.filter(l => l.state === 'joining').length).toBe(2);
    });

    test('a rester comes back no sooner than 20 min', () => {
        const now = at(19);
        const lives = initialLives(HIB, 'hibernia', new Set(), now, seeded(3));
        for (const l of lives) { l.since = now - 10 * MIN; l.until = now + 30 * MIN; }
        expect(step(lives, { target: 12 }, now).actions).toEqual([]);
        for (const l of lives) l.since = now - 21 * MIN;
        expect(step(lives, { target: 12 }, now).actions.length).toBe(2);
    });

    test('the last Druid plays on until the other is rested, then hands over', () => {
        const now = at(13);
        const lives = initialLives(HIB, 'hibernia', new Set(HIB.map(b => b.bot).filter(b => b !== 'brigid')), now - 100 * MIN, seeded(3));
        const amergin = lives.find(l => l.bot === 'amergin')!;
        amergin.until = now - MIN;
        for (const l of lives) if (l.bot !== 'amergin') l.until = now + 60 * MIN;
        const brigid = lives.find(l => l.bot === 'brigid')!;
        brigid.since = now - 5 * MIN; brigid.until = now + 40 * MIN;   // just left: not rested
        const r = step(lives, { target: 19 }, now);
        expect(amergin.state).toBe('online');
        expect(r.events.some(e => e.kind === 'extend' && e.bot === 'amergin')).toBe(true);
        brigid.since = now - 25 * MIN;
        const r2 = step(lives, { target: 19 }, amergin.until + 1);
        expect(amergin.state).toBe('leaving');
        expect(r2.actions.some(a => a.kind === 'logIn' && a.bot === 'brigid')).toBe(true);
    });

    test('pinned away never comes in; pinned stay never leaves', () => {
        const now = at(20);
        const lives = initialLives(HIB, 'hibernia', new Set(), now, seeded(3));
        const r = step(lives, { target: 19, pinned: { away: new Set(['niamh']), stay: new Set() } }, now);
        expect(r.actions.some(a => a.bot === 'niamh')).toBe(false);
        const on = initialLives(HIB, 'hibernia', new Set(HIB.map(b => b.bot)), now - 200 * MIN, seeded(3));
        for (const l of on) l.until = now - MIN;
        const r2 = step(on, { target: 6, pinned: { away: new Set(), stay: new Set(on.map(l => l.bot)) } }, now);
        expect(r2.events.filter(e => e.kind === 'leave')).toEqual([]);
    });

    test('reconcile: a log-in seen joins, one never seen goes back offline; a log-out seen rests 20-90 min', () => {
        const now = at(20);
        const lives = initialLives(HIB.slice(0, 3), 'hibernia', new Set(), now, seeded(3));
        lives[0]!.state = 'joining'; lives[0]!.since = now - MIN;
        lives[1]!.state = 'joining'; lives[1]!.since = now - 6 * MIN;
        lives[2]!.state = 'leaving'; lives[2]!.since = now - MIN;
        stepRealm(lives, { target: 0, inGame: new Set([lives[0]!.bot]), held: new Set(), needs: [], pinned: { away: new Set(), stay: new Set() }, lastOut: now, lastIn: now }, now, seeded(3));
        expect(lives.map(l => l.state)).toEqual(['online', 'offline', 'offline']);
        expect(lives[0]!.until - now).toBeGreaterThanOrEqual(60 * MIN);
        expect(lives[2]!.until - now).toBeGreaterThanOrEqual(20 * MIN);
        expect(lives[2]!.until - now).toBeLessThanOrEqual(90 * MIN);
    });

    test('a log-in outside Thidranki walks back in before it plays; retried, then given up', () => {
        const now = at(20);
        const lives = initialLives(HIB.slice(0, 2), 'hibernia', new Set(), now, seeded(3));
        lives[0]!.state = 'joining' as Life['state']; lives[0]!.since = now - MIN;
        const base = { target: 1, held: new Set<string>(), needs: [] as string[][], pinned: { away: new Set<string>(), stay: new Set<string>() }, lastOut: now, lastIn: now };
        const r = stepRealm(lives, { ...base, inGame: new Set(['amergin']), outside: new Set(['amergin']) }, now, seeded(3));
        expect(lives[0]!.state).toBe('entering');
        expect(r.actions).toEqual([{ kind: 'enter', bot: 'amergin', realm: 'hibernia', why: 'logged in outside the battleground' }]);
        // Not again before enterRetryMs; again after.
        expect(stepRealm(lives, { ...base, inGame: new Set(['amergin']), outside: new Set(['amergin']) }, now + MIN, seeded(3)).actions).toEqual([]);
        expect(stepRealm(lives, { ...base, inGame: new Set(['amergin']), outside: new Set(['amergin']) }, now + 5 * MIN, seeded(3)).actions.map(a => a.kind)).toEqual(['enter']);
        // In Thidranki: it plays.
        stepRealm(lives, { ...base, inGame: new Set(['amergin']), outside: new Set() }, now + 6 * MIN, seeded(3));
        expect(lives[0]!.state).toBe('online');
        // An online bot no unit holds, found outside: back in; a held one is its unit's.
        stepRealm(lives, { ...base, inGame: new Set(['amergin']), outside: new Set(['amergin']), held: new Set(['amergin']) }, now + 7 * MIN, seeded(3));
        expect(lives[0]!.state).toBe('online');
        stepRealm(lives, { ...base, inGame: new Set(['amergin']), outside: new Set(['amergin']) }, now + 8 * MIN, seeded(3));
        expect(lives[0]!.state).toBe('entering');
        stepRealm(lives, { ...base, inGame: new Set(['amergin']), outside: new Set(['amergin']) }, now + 30 * MIN, seeded(3));
        expect(lives[0]!.state).toBe('leaving');
    });

    test('pinned away is left alone: not walked back in, not logged out, not counted', () => {
        const now = at(20);
        const lives = initialLives(HIB.slice(0, 2), 'hibernia', new Set(['amergin', 'fiacra']), now - 200 * MIN, seeded(3));
        for (const l of lives) l.until = now - MIN;
        const away = new Set(['amergin']);
        const r = stepRealm(lives, { target: 0, inGame: new Set(['amergin', 'fiacra']), outside: new Set(['amergin']), held: new Set<string>(), needs: [] as string[][], pinned: { away, stay: new Set<string>() }, lastOut: 0, lastIn: 0 }, now, seeded(3));
        expect(lives[0]!.state).toBe('online');
        expect(r.actions.some(a => a.bot === 'amergin')).toBe(false);
        expect(r.events.some(e => e.bot === 'amergin')).toBe(false);
    });

    test('lfg: a held bot leaves now, is logged out, and never comes in while held; then it rests as usual', () => {
        const now = at(20);
        const lives = initialLives(HIB.slice(0, 3), 'hibernia', new Set(['amergin', 'fiacra', 'cathbad']), now - 20 * MIN, seeded(3));
        const lfg = new Set(['cathbad']);
        const base = { target: 3, held: new Set<string>(), needs: [] as string[][], pinned: { away: new Set<string>(), stay: new Set<string>() }, lastOut: now, lastIn: now, lfg };
        const r = stepRealm(lives, { ...base, inGame: new Set(['amergin', 'fiacra', 'cathbad']) }, now, seeded(3));
        expect(lives[2]!.state).toBe('leaving');
        expect(r.actions).toEqual([{ kind: 'logOut', bot: 'cathbad', realm: 'hibernia', why: 'lfg' }]);
        stepRealm(lives, { ...base, inGame: new Set(['amergin', 'fiacra']) }, now + MIN, seeded(3));
        expect(lives[2]!.state).toBe('offline');
        // Still held two hours on: never asked in, though the realm is one short.
        const later = stepRealm(lives, { ...base, inGame: new Set(['amergin', 'fiacra']), lastIn: 0 }, now + 120 * MIN, seeded(3));
        expect(later.actions.some(a => a.bot === 'cathbad')).toBe(false);
        // Let go: it comes in as any rested bot.
        const free = stepRealm(lives, { ...base, lfg: new Set<string>(), inGame: new Set(['amergin', 'fiacra']), lastIn: 0 }, now + 121 * MIN, seeded(3));
        expect(free.actions).toEqual([expect.objectContaining({ kind: 'logIn', bot: 'cathbad' })]);
    });

    test('a leaving bot near a keep waits to log out', () => {
        const now = at(20);
        const lives = initialLives(HIB.slice(0, 1), 'hibernia', new Set(['amergin']), now, seeded(3));
        lives[0]!.state = 'leaving' as Life['state'];
        const base = { target: 0, inGame: new Set(['amergin']), held: new Set<string>(), needs: [] as string[][], pinned: { away: new Set<string>(), stay: new Set<string>() }, lastOut: now, lastIn: now };
        const r = stepRealm(lives, { ...base, unsafe: new Set(['amergin']) }, now, seeded(3));
        expect(r.actions).toEqual([]);
        expect(r.events.map(e => e.kind)).toEqual(['wait']);
        expect(stepRealm(lives, base, now + 30_000, seeded(3)).actions.map(a => a.kind)).toEqual(['logOut']);
    });

    test('unsafe to log out: near the Faste (whoever holds it), near an enemy portal keep; safe at home and in the field', () => {
        const none = () => null;
        expect(logOutUnsafe({ regionId: 252, x: 33089 + 3000, y: 38271 }, 'hibernia', none)).toBe(true);
        expect(logOutUnsafe({ regionId: 252, x: 33089 + 3000, y: 38271 }, 'albion', () => 'albion')).toBe(true);
        expect(logOutUnsafe({ regionId: 252, x: 54053, y: 24680 + 2000 }, 'hibernia', none)).toBe(true);
        expect(logOutUnsafe({ regionId: 252, x: 18362 + 1500, y: 18257 }, 'hibernia', none)).toBe(false);
        expect(logOutUnsafe({ regionId: 252, x: 26000, y: 26000 }, 'hibernia', none)).toBe(false);
    });

    test('a day: playing follows the curve, Druid and Bard always on, sessions turn over', () => {
        const { samples, lives } = simulate(at(13, 30), 24);
        const off = samples.filter(x => Math.abs(x.playing - x.target) > 2);
        // Within 2 of the target nearly all the time (ramps take a few steps).
        expect(off.length / samples.length).toBeLessThan(0.08);
        expect(Math.min(...samples.map(x => x.playing))).toBeGreaterThanOrEqual(6);
        const evening = samples.filter(x => new Date(x.t).getHours() === 20).map(x => x.playing);
        const night = samples.filter(x => new Date(x.t).getHours() === 4).map(x => x.playing);
        expect(Math.min(...evening)).toBeGreaterThanOrEqual(17);
        expect(Math.max(...night)).toBeLessThanOrEqual(9);
        // One group's Druid and Bard are on nearly always (a handover can leave a step or two open).
        expect(samples.filter(x => x.needsOpen > 0).length / samples.length).toBeLessThan(0.02);
        // Everybody played more than one session in a day, nobody played all day.
        expect(lives.filter(l => l.sessions >= 2).length).toBeGreaterThan(14);
    });
});

describe('balance', () => {
    const S = LIFECYCLE_SETTINGS.balance;
    const sight = (ours: number, seen: Record<string, number>): Sightings => ({
        near: Object.fromEntries(Array.from({ length: ours }, (_, i) => [`b${i}`, 0])),
        foes: Object.fromEntries(Object.entries(seen).map(([r, n]) => [r, Object.fromEntries(Array.from({ length: n }, (_, i) => [`${r}${i}`, 0]))])),
    });
    test('reading', () => {
        expect(readBalance(sight(6, { albion: 10 })).reading).toBe('under');
        expect(readBalance(sight(10, { albion: 6, midgard: 4 })).reading).toBe('over');
        expect(readBalance(sight(10, { albion: 8 })).reading).toBe('even');
        expect(readBalance(sight(2, { albion: 3 })).reading).toBe('even');   // too few to judge
        expect(readBalance(sight(10, {})).reading).toBe('even');             // nobody seen: no judgement
    });
    test('the shift moves after the reading held 10 min, by one, within ±3, and back toward 0 when even', () => {
        let b: BalanceState = { shift: 0, reading: 'even', readingSince: 0, movedAt: 0 };
        b = stepBalance(b, 'under', 30 * MIN);
        expect(b.shift).toBe(0);
        b = stepBalance(b, 'under', 40 * MIN);
        expect(b.shift).toBe(1);
        b = stepBalance(b, 'under', 45 * MIN);
        expect(b.shift).toBe(1);
        for (let t = 50; t < 200; t += 5) b = stepBalance(b, 'under', t * MIN);
        expect(b.shift).toBe(S.maxShift);
        b = stepBalance(b, 'even', 200 * MIN);
        b = stepBalance(b, 'even', 221 * MIN);
        expect(b.shift).toBe(2);
    });
    test('sightings from the board, forgotten after the window', () => {
        const s: Sightings = { foes: {}, near: {} };
        const unit = { unit: 'hibernia', running: true, inFight: true, members: [{ name: 'Amergin', bot: 'amergin', x: 0, y: 0, z: 0, hp: 100, isDead: false, inCombat: true }, { name: 'Fiacra', bot: 'fiacra', x: 9000, y: 0, z: 0, hp: 100, isDead: false, inCombat: false }] } as unknown as UnitView;
        const board = { realm: 'hibernia', at: 0, units: [unit], foes: [{ key: '252:1', realm: 'albion', x: 1000, y: 0, z: 0 }] } as unknown as RealmBoardView;
        see(s, board, 0);
        expect(Object.keys(s.near)).toEqual(['amergin']);
        expect(Object.keys(s.foes.albion!)).toEqual(['252:1']);
        see(s, { ...board, foes: [] }, 21 * MIN);
        expect(s.near).toEqual({});
        expect(s.foes.albion).toEqual({});
    });
});

describe('raids', () => {
    const base = { playing: 17, target: 17 as number | undefined, out: 12, open: false, lastEnd: 0, holdsTarget: false, shift: 0, now: 60 * MIN };
    test('the numbers on and out, no raid lately', () => {
        expect(wantsMuster(base).want).toBe(true);
        expect(wantsMuster({ ...base, playing: 16 }).want).toBe(true);
        expect(wantsMuster({ ...base, playing: 10 }).want).toBe(false);
        expect(wantsMuster({ ...base, out: 11 }).want).toBe(false);
        expect(wantsMuster({ ...base, target: undefined }).want).toBe(false);
        expect(wantsMuster({ ...base, lastEnd: 50 * MIN }).want).toBe(false);
        expect(wantsMuster({ ...base, holdsTarget: true }).want).toBe(false);
        expect(wantsMuster({ ...base, open: true }).want).toBe(false);
        expect(wantsMuster({ ...base, shift: 1 }).want).toBe(false);
    });
    test('follow the curve: the afternoon 12 and a night of 7 raid too, with most of them out', () => {
        expect(wantsMuster({ ...base, target: 12, playing: 11, out: 9 }).want).toBe(true);
        expect(wantsMuster({ ...base, target: 12, playing: 11, out: 8 }).want).toBe(false);
        expect(wantsMuster({ ...base, target: 7, playing: 6, out: 5 }).want).toBe(true);
        expect(wantsMuster({ ...base, target: 7, playing: 7, out: 4 }).want).toBe(false);
        expect(wantsMuster({ ...base, target: 6, playing: 6, out: 4 }).want).toBe(false);
    });
});

describe('waves', () => {
    const unit = (inFight: boolean) => ({ unit: 'hibernia', running: true, inFight, members: [] }) as unknown as UnitView;
    const board = (inFight: boolean, foes: { x: number; y: number }[] = []) => ({ realm: 'hibernia', at: 0, units: [unit(inFight)], foes: foes.map((f, i) => ({ key: `${i}`, realm: 'albion', z: 3000, ...f })) }) as unknown as RealmBoardView;
    const o = (now: number, musterOpen = false) => ({ realm: 'hibernia' as const, musterOpen, now });
    test('out, a fight, then quiet once out long enough and the fight is over; then out toward the last sighting', () => {
        let w = newWave(0);
        w = stepWave(w, board(true, [{ x: 30000, y: 30000 }]), o(5 * MIN), seeded());
        expect(w.phase).toBe('out');
        expect(w.fought).toBe(true);
        w = stepWave(w, board(false), o(10 * MIN), seeded());
        expect(w.phase).toBe('out');   // not out 12 min yet
        w = stepWave(w, board(false), o(13 * MIN), seeded());
        expect(w.phase).toBe('quiet');
        const until = w.until!;
        expect(until - 13 * MIN).toBeGreaterThanOrEqual(4 * MIN);
        expect(until - 13 * MIN).toBeLessThanOrEqual(7 * MIN);
        w = stepWave(w, board(false), o(until + 1), seeded());
        expect(w.phase).toBe('out');
        expect(w.toward).toEqual({ x: 30000, y: 30000, z: 3000 });
    });
    test('quiet after outMax without a fight; a muster brings them out', () => {
        let w = newWave(0);
        w = stepWave(w, board(false), o(31 * MIN), seeded());
        expect(w.phase).toBe('quiet');
        w = stepWave(w, board(false), o(32 * MIN, true), seeded());
        expect(w.phase).toBe('out');
        expect(w.toward).toBeNull();   // nothing seen
        w = stepWave(w, board(false), o(70 * MIN, true), seeded());
        expect(w.phase).toBe('out');   // never quiet while the muster is open
    });
    test('sightings at an enemy portal keep are its spawn, not a place to go', () => {
        let w = newWave(0);
        w = stepWave(w, board(true, [{ x: 54053, y: 24680 }]), o(MIN), seeded());   // Midgard Portal Keep
        expect(w.lastSeen).toBeNull();
    });
    test('a unit\'s orders from the wave', () => {
        const wave: RealmWave = { v: 1, realm: 'hibernia', at: 0, id: 4, phase: 'quiet', since: 0, until: 5 * MIN, toward: null, why: 'after a fight' };
        const spot = quietSpot(252, 'hibernia', 'hibernia-s1')!;
        expect(spot).not.toBeNull();
        expect(quietSpot(252, 'hibernia', 'hibernia-s1')).toEqual(spot);
        expect(quietSpot(252, 'hibernia', 'hibernia-s2')).not.toEqual(spot);
        const far = waveOrder(wave, { unit: 'hibernia-s1', realm: 'hibernia', regionId: 252, centre: { x: 33000, y: 33000 }, now: 0 });
        expect(far?.kind).toBe('home');
        const there = waveOrder(wave, { unit: 'hibernia-s1', realm: 'hibernia', regionId: 252, centre: spot, now: MIN });
        expect(there?.kind).toBe('quiet');
        expect((there as { why: string }).why.startsWith(QUIET_REASON)).toBe(true);
        const out: RealmWave = { ...wave, phase: 'out', id: 5, until: null, toward: { x: 30000, y: 30000, z: 3000 } };
        const go = waveOrder(out, { unit: 'hibernia-s1', realm: 'hibernia', regionId: 252, centre: spot, now: 0 });
        expect(go?.kind).toBe('toward');
        const near = waveOrder(out, { unit: 'hibernia-s1', realm: 'hibernia', regionId: 252, centre: { x: 29000, y: 30000 }, now: 0 });
        expect(near).toEqual({ kind: 'reached', key: '5' });
        expect(waveOrder(out, { unit: 'hibernia-s1', realm: 'hibernia', regionId: 252, centre: spot, reached: '5', now: 0 })).toBeNull();
        expect(waveOrder(null, { unit: 'hibernia-s1', realm: 'hibernia', regionId: 252, centre: spot })).toBeNull();
    });
    test('quiet spots stay clear of the portal keep doors, on the arrival side of ours', () => {
        for (const region of [250, 251, 252, 253]) for (const [realm, g] of [['albion', 'camelot'], ['midgard', 'midgard'], ['hibernia', 'hibernia']] as const) {
            const home = homeOf(region, realm);
            if (!home) continue;
            for (const unit of [g, `${g}-2`, `${g}-s1`, `${g}-s2`, `${g}-s3`, `${g}-s4`]) {
                const spot = quietSpot(region, realm, unit)!;
                for (const d of Object.values(PORTAL_DOORS[region]!).flat()) expect(Math.hypot(d.at.x - spot.x, d.at.y - spot.y)).toBeGreaterThanOrEqual(QUIET_DOOR_CLEAR);
                for (const d of PORTAL_DOORS[region]![realm]) expect(doorSide(d, spot)).toBe(doorSide(d, home.arrival));
            }
        }
    });
    test('idle acts: mostly sit and turn', () => {
        const r = seeded(11);
        const acts = Array.from({ length: 400 }, () => nextIdle(r, 0).act);
        const share = (a: string) => acts.filter(x => x === a).length / acts.length;
        expect(share('sit')).toBeGreaterThan(0.3);
        expect(share('stand')).toBeLessThan(0.2);
    });
});

describe('gear wear', () => {
    test('worn items only, lowest first', () => {
        const w = wearOf([{ slot: 10, name: 'Sword', condition: 92 }, { slot: 21, name: 'Helm', condition: 100 }, { slot: 45, name: 'Bag item', condition: 50 }, { slot: 25, name: 'Vest', condition: 88 }]);
        expect(w.min).toBe(88);
        expect(w.worn.map(i => i.name)).toEqual(['Vest', 'Sword']);
        expect(wearOf([]).min).toBe(100);
    });
});
