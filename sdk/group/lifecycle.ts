// The life cycle (S4, stint 2026-11-13): who of a realm's bots plays now, as players would.
//
//   Sessions  A bot plays a session of 1-3 h, logs out cleanly, and comes back 20-90 min later.
//   Curve     How many play follows the hour (CURVE: about 19 a realm in the evening, 7-8 in the small hours), never
//             below the floor (6). A realm's target is the curve plus its balance shift, less the humans playing in it.
//   Classes   A bot whose class a main group needs (group.json requires.classes, and a healer) stays on past its session
//             until another of its class can take over; a log-in fills a missing class first.
//   Mix       The units' sizes come from how many play (mixFor): two groups and squads in the evening, a group and
//             small-man at night. field.ts asks sizeOf(unit) at each line-up.
//   Balance   Each realm compares, from its own board only, how many of ours stood near enemies with how many of each
//             other realm it saw (20 min window). Outnumbered 1.5 to 1 for 10 min: one more plays; outnumbering: one less.
//   Raids     A realm with the numbers out (14 online, 10 living out) and no raid for a while wants a muster
//             (wantsMuster); field.ts starts it, the director (S3) decides when it goes.
//   Waves     Out toward where the realm last saw enemies, a fight, then a few minutes of quiet at the portal keep
//             (stepWave; the units' side is waves.ts).
//
// A bot due to leave is not pulled out of a running unit: it is 'leaving', field.ts leaves it out of the next line-up
// (mayPlay), and once no unit holds it and it stands away from any keep the server would call unsafe, the life cycle
// logs it out through S1's swarm control (options.presence). Logging in and out is never done here directly.
// A login near an enemy keep (or one in combat) lands at the bind, the realm's portal keep outside the battleground
// (PlayerInitRequestHandler CheckNearbyKeepAndMoveIfUnsafe, within 6000): a bot that comes in outside Thidranki, or
// one no unit holds found outside, is 'entering' and walks back in (enterBattleground) before it counts as online.
//
// Pure where it can be: stepRealm, stepBalance, stepWave, mixFor, curveAt and wantsMuster take state and inputs and return
// actions; startLifecycle runs them every 30 s against the gateway and the realm boards, keeps its state in
// groups/lifecycle/state.json (a field.ts restart picks it up), and logs to groups/lifecycle/log.jsonl and samples.jsonl.
//
// Hands-off overrides, re-read every step: groups/lifecycle/pinned.json { "away": [bots], "stay": [bots] }: `away` are
// never logged in nor picked (the user's Niamh), `stay` are never logged out. groups/lifecycle/off: the life cycle plans
// and logs but does nothing (shadow).

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BATTLEGROUND_LAYOUTS, THIDRANKI, type PlayerRealm } from './keeps';
import { findBotEnv, parseEnvFile } from '../index';
import { enterBattleground } from './battleground';
import { lineupPool } from './lineup';
import type { Member } from './member';
import { connectBot, loadGroup } from './roster';
import { roleForClass } from './strategy';
import type { RealmBoardView } from './realm-board';
import type { Point3 } from './types';
import { WAVE_DIR, writeWave, type RealmWave } from './waves';

export const LIFECYCLE_DIR = process.env.DAOC_LIFECYCLE_DIR ?? join(import.meta.dir, '..', '..', 'groups', 'lifecycle');

// ──────────────────────────────────────────────────────────────────────────────────────────────────────────── settings

/** Bots playing per realm by the hour (local time, 0-23), linearly between hours. */
export const CURVE: readonly number[] = [
    //  0   1   2   3   4   5   6   7   8   9  10  11
    14, 12, 10, 8, 7, 7, 7, 8, 9, 10, 11, 11,
    // 12  13  14  15  16  17  18  19  20  21  22  23
    12, 12, 12, 12, 13, 15, 17, 19, 19, 19, 18, 16,
];

export interface LifecycleSettings {
    curve: readonly number[];
    /** Never fewer than this play in a realm (the floor), unless fewer bots can. */
    floor: number;
    session: { minMs: number; maxMs: number };
    rest: { minMs: number; maxMs: number };
    /** A session that can't end now (the floor, a needed class) goes on this much longer, then is looked at again. */
    extendMs: number;
    /** The longest a needed class (the last Druid, Bard, ...) plays on waiting for another of its class. */
    neededMaxMs: number;
    /** Entering: the way back in is asked again after this, and given up (the bot logs out to rest) after enterMaxMs. */
    enterRetryMs: number;
    enterMaxMs: number;
    /** A log-out waits while the bot stands within this of a keep not ours (or the Faste at all: it may be in combat). */
    keepClear: number;
    /** At most one log-out (and `logInsPerStep` log-ins) per realm this often. */
    stepMs: number;
    logInsPerStep: number;
    /** A bot asked to log in and not seen in game after this: back offline, asked again later. */
    joinTimeoutMs: number;
    /** A bot logging out still seen in game after this: asked again. */
    leaveRetryMs: number;
    /** An early leave (curve or balance) only takes a bot that has played at least this long. */
    earlyAfterMs: number;
    balance: BalanceSettings;
    raid: RaidSettings;
    wave: WaveSettings;
}

export interface BalanceSettings {
    /** Outnumbered (or outnumbering) means more than this ratio. */
    ratio: number;
    /** Sightings and our members near them count this long. */
    windowMs: number;
    /** One of ours stood near an enemy: within this of it. */
    near: number;
    /** The ratio held this long before the shift moves by one; again after as long. */
    holdMs: number;
    /** With neither, the shift moves one toward 0 this often. */
    decayMs: number;
    /** The shift stays within ±this. */
    maxShift: number;
    /** No judgement on fewer than this many seen or near, on the larger side. */
    minCount: number;
}

export interface RaidSettings {
    /** A muster wants at least this many of the realm playing ... */
    minOnline: number;
    /** ... at least this many of them alive out in the battleground ... */
    minOut: number;
    /** ... and this long since the realm's last muster ended (or the life cycle started). */
    gapMs: number;
}

export interface WaveSettings {
    /** Out at least this long, and the realm's last fight ended `afterFightMs` ago: quiet. */
    outMinMs: number;
    afterFightMs: number;
    /** Out this long without a fight that ended: quiet anyway. */
    outMaxMs: number;
    /** Quiet lasts between these. */
    quietMinMs: number;
    quietMaxMs: number;
    /** A sighting older than this is no place to go. */
    sightingMs: number;
    /** Sightings within this of an enemy portal keep are its spawn: no wave goes there. */
    portalClear: number;
}

export const LIFECYCLE_SETTINGS: LifecycleSettings = {
    curve: CURVE,
    floor: 6,
    session: { minMs: 60 * 60_000, maxMs: 180 * 60_000 },
    rest: { minMs: 20 * 60_000, maxMs: 90 * 60_000 },
    extendMs: 15 * 60_000,
    neededMaxMs: 5 * 60 * 60_000,
    enterRetryMs: 4 * 60_000,
    enterMaxMs: 20 * 60_000,
    keepClear: 7000,
    stepMs: 90_000,
    logInsPerStep: 2,
    joinTimeoutMs: 5 * 60_000,
    leaveRetryMs: 3 * 60_000,
    earlyAfterMs: 30 * 60_000,
    balance: { ratio: 1.5, windowMs: 20 * 60_000, near: 4000, holdMs: 10 * 60_000, decayMs: 20 * 60_000, maxShift: 3, minCount: 4 },
    raid: { minOnline: 14, minOut: 10, gapMs: 25 * 60_000 },
    wave: { outMinMs: 12 * 60_000, afterFightMs: 90_000, outMaxMs: 30 * 60_000, quietMinMs: 4 * 60_000, quietMaxMs: 7 * 60_000, sightingMs: 15 * 60_000, portalClear: 6000 },
};

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────── the curve

/** The curve's value at `t` (local time), between the hours linearly, rounded, at least `floor`. */
export function curveAt(t: number | Date, curve: readonly number[] = CURVE, floor = LIFECYCLE_SETTINGS.floor): number {
    const d = new Date(t);
    const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    const a = curve[Math.floor(h) % 24]!, b = curve[(Math.floor(h) + 1) % 24]!;
    return Math.max(floor, Math.round(a + (b - a) * (h - Math.floor(h))));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────── the mix

/** Main groups' and squads' sizes by how many play (index: that many; past the end, the last). */
export const MIX: readonly { mains: readonly number[]; squads: readonly number[] }[] = [
    { mains: [], squads: [] },
    { mains: [], squads: [1] },
    { mains: [], squads: [2] },
    { mains: [], squads: [3] },
    { mains: [4], squads: [] },
    { mains: [4], squads: [1] },
    { mains: [5], squads: [1] },
    { mains: [5], squads: [2] },
    { mains: [5], squads: [2, 1] },
    { mains: [6], squads: [2, 1] },
    { mains: [6], squads: [3, 1] },
    { mains: [6], squads: [3, 1, 1] },
    { mains: [6], squads: [3, 2, 1] },
    { mains: [5, 5], squads: [2, 1] },
    { mains: [5, 5], squads: [2, 1, 1] },
    { mains: [6, 5], squads: [2, 1, 1] },
    { mains: [6, 6], squads: [2, 1, 1] },
    { mains: [6, 6], squads: [3, 1, 1] },
    { mains: [6, 6], squads: [3, 2, 1] },
    { mains: [6, 6], squads: [3, 2, 1, 1] },
];

/**
 * Each unit's size with `n` playing: MIX[n]'s main groups to the units without '-s' (in order), its squads to the '-s'
 * units, each at most `max[unit]` (field.ts --mix); units left over get 0 (no sortie).
 */
export function mixFor(n: number, units: readonly string[], max: Readonly<Record<string, number>> = {}): Record<string, number> {
    const m = MIX[Math.max(0, Math.min(n, MIX.length - 1))]!;
    const out: Record<string, number> = {};
    const mains = units.filter(u => !u.includes('-s')), squads = units.filter(u => u.includes('-s'));
    mains.forEach((u, i) => { out[u] = Math.min(m.mains[i] ?? 0, max[u] ?? Infinity); });
    squads.forEach((u, i) => { out[u] = Math.min(m.squads[i] ?? 0, max[u] ?? Infinity); });
    return out;
}

/** How many main groups play with `n` playing. */
export function mainsFor(n: number): number {
    return MIX[Math.max(0, Math.min(n, MIX.length - 1))]!.mains.length;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────── needed classes

/** One class a main group needs: any of these class names, or 'healer' for any healer. */
export type Need = readonly string[];

export interface LifeBot {
    bot: string;
    className: string;
    healer: boolean;
}

const fits = (b: LifeBot, need: Need) => need.some(c => (c === 'healer' ? b.healer : c.toLowerCase() === b.className.toLowerCase()));

/**
 * A main group's needs: its required classes (group.json requires.classes), then a healer unless a required class is
 * one already (Midgard's Healer, Hibernia's Druid): `bots` tells which classes heal.
 */
export function groupNeeds(requires: readonly (string | readonly string[])[] = [], bots: readonly LifeBot[] = []): Need[] {
    const needs: Need[] = requires.map(r => (typeof r === 'string' ? [r] : [...r]));
    const healsAlready = needs.some(n => bots.some(b => b.healer && fits(b, n)));
    return healsAlready ? needs : [...needs, ['healer']];
}

/** The needs `bots` leave open, matched greedily in order (a bot fills one need). */
export function openNeeds(bots: readonly LifeBot[], needs: readonly Need[]): Need[] {
    const used = new Set<string>();
    const open: Need[] = [];
    for (const need of needs) {
        const b = bots.find(x => !used.has(x.bot) && fits(x, need));
        if (b) used.add(b.bot);
        else open.push(need);
    }
    return open;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── the sessions

export type LifeState = 'online' | 'leaving' | 'offline' | 'joining' | 'entering';

export interface Life extends LifeBot {
    realm: PlayerRealm;
    state: LifeState;
    /** When it entered the state. */
    since: number;
    /** online: the session's planned end; offline: the rest's end; leaving/joining: when the request went out. */
    until: number;
    /** Sessions started. */
    sessions: number;
    /** leaving: when the log-out was last asked; entering: when the way back in was last asked. */
    askedAt?: number;
    /** leaving: when a log-out near a keep was last put off (logged once in leaveRetryMs). */
    waitedAt?: number;
    /** Why it is in this state (a log). */
    why: string;
}

export type LifeAction = { kind: 'logIn' | 'logOut' | 'enter'; bot: string; realm: PlayerRealm; why: string };
export type LifeEvent = { kind: 'joined' | 'left' | 'leave' | 'extend' | 'join' | 'adopt' | 'lost' | 'stuck' | 'entering' | 'wait'; bot: string; realm: PlayerRealm; why: string };

export interface RealmStep {
    /** Bots of the realm that should play now (the curve, the shift, the humans in it). */
    target: number;
    /** Bots in game now (any region). */
    inGame: ReadonlySet<string>;
    /** Of those, the ones outside the battleground (region known and not Thidranki). */
    outside?: ReadonlySet<string>;
    /** Bots standing where a log-out would bring them back at the bind (logOutUnsafe): they log out later. */
    unsafe?: ReadonlySet<string>;
    /** Bots a running unit holds (field.ts): a leaving one waits for its unit to let go. */
    held: ReadonlySet<string>;
    /** One main group's needs (groupNeeds), counted once for each main group at `needsAt` (default the target). */
    needs: readonly Need[];
    /** How many play soon (the target an hour ahead, if more): a class the second group will need stays on before the ramp. */
    needsAt?: number;
    pinned: { away: ReadonlySet<string>; stay: ReadonlySet<string> };
    /** Last log-out and log-in steps (ms), kept by the caller between steps. */
    lastOut: number;
    lastIn: number;
}

const between = (rand: () => number, r: { minMs: number; maxMs: number }) => r.minMs + rand() * (r.maxMs - r.minMs);

/**
 * Lives for a realm's bots at the start: those in game play on, their sessions ending at staggered times (so they don't
 * all leave at once), the rest are rested and may come in at once.
 */
export function initialLives(bots: readonly LifeBot[], realm: PlayerRealm, inGame: ReadonlySet<string>, now: number, rand: () => number = Math.random, s: LifecycleSettings = LIFECYCLE_SETTINGS): Life[] {
    return bots.map(b => inGame.has(b.bot)
        // As if they logged in at different times in the last two hours, so even the needed classes' caps (neededMaxMs) differ.
        ? { ...b, realm, state: 'online' as const, since: now - rand() * 120 * 60_000, until: now + 10 * 60_000 + rand() * (s.session.maxMs - 10 * 60_000), sessions: 1, why: 'in game at the start' }
        : { ...b, realm, state: 'offline' as const, since: now - s.rest.maxMs, until: now, sessions: 0, why: 'offline at the start' });
}

/**
 * One step of a realm's sessions: mutates `lives` (one realm's) and returns what to ask of the swarm and what happened.
 * Order: reconcile with what is in game, end sessions that are over (or extend them), one early leave when over the
 * target, log-ins when under it, log-outs for leaving bots no unit holds.
 */
export function stepRealm(lives: Life[], o: RealmStep, now: number, rand: () => number = Math.random, s: LifecycleSettings = LIFECYCLE_SETTINGS): { actions: LifeAction[]; events: LifeEvent[]; lastOut: number; lastIn: number } {
    const actions: LifeAction[] = [];
    const events: LifeEvent[] = [];
    let { lastOut, lastIn } = o;
    const ev = (kind: LifeEvent['kind'], l: Life, why: string) => events.push({ kind, bot: l.bot, realm: l.realm, why });
    const set = (l: Life, state: LifeState, until: number, why: string) => { l.state = state; l.since = now; l.until = until; l.why = why; };

    // 1. What is in game, and where.
    const enter = (l: Life, why: string) => { l.askedAt = now; actions.push({ kind: 'enter', bot: l.bot, realm: l.realm, why }); };
    for (const l of lives) {
        const inGame = o.inGame.has(l.bot);
        const outside = inGame && !!o.outside?.has(l.bot);
        if (l.state === 'joining' && outside) { set(l, 'entering', now, 'logged in outside the battleground'); ev('entering', l, 'logged in outside Thidranki: back in first'); enter(l, l.why); }
        else if (l.state === 'online' && outside && !o.held.has(l.bot)) { set(l, 'entering', now, 'outside the battleground'); ev('entering', l, 'in game outside Thidranki, no unit holds it: back in'); enter(l, l.why); }
        else if (l.state === 'entering' && inGame && !outside) { set(l, 'online', now + between(rand, s.session), 'session'); l.sessions++; ev('joined', l, `back in Thidranki, session of ${Math.round((l.until - now) / 60_000)} min`); }
        else if (l.state === 'entering' && !inGame) { set(l, 'offline', now + 2 * 60_000, 'dropped while entering'); ev('lost', l, 'out of the game on its way back in'); }
        else if (l.state === 'entering' && now - l.since > s.enterMaxMs) { set(l, 'leaving', now, 'could not get back in'); ev('leave', l, `not back in Thidranki after ${Math.round(s.enterMaxMs / 60_000)} min: logs out`); }
        else if (l.state === 'entering' && now - (l.askedAt ?? 0) >= s.enterRetryMs) enter(l, 'still outside the battleground: again');
        else if (l.state === 'joining' && inGame) { set(l, 'online', now + between(rand, s.session), 'session'); l.sessions++; ev('joined', l, `session of ${Math.round((l.until - now) / 60_000)} min`); }
        else if (l.state === 'joining' && now - l.since > s.joinTimeoutMs) { set(l, 'offline', now + 2 * 60_000, 'log-in not seen'); ev('lost', l, 'asked to log in, not in game after the timeout'); }
        else if (l.state === 'leaving' && !inGame) { set(l, 'offline', now + between(rand, s.rest), 'rest'); ev('left', l, `back in ${Math.round((l.until - now) / 60_000)} min at the earliest`); }
        else if (l.state === 'offline' && inGame && now - l.since > 3 * 60_000 && !o.pinned.away.has(l.bot)) {
            // In game though we logged it out (the supervisor brought it back, or someone logged it in): it plays.
            set(l, 'online', now + between(rand, s.session), 'adopted'); l.sessions++; ev('adopt', l, 'in game while offline by us: plays a session');
        }
    }

    const playing = () => lives.filter(l => l.state === 'online' || l.state === 'joining' || l.state === 'entering');
    const mains = mainsFor(Math.max(o.target, o.needsAt ?? 0));
    const needs = Array.from({ length: mains }, () => o.needs).flat();
    /** Would the realm's needs stay as covered without `l`? */
    const breaks = (l: Life) => openNeeds(playing().filter(x => x !== l), needs).length > openNeeds(playing(), needs).length;
    const rested = (l: Life) => l.state === 'offline' && !o.pinned.away.has(l.bot) && (now >= l.until || now - l.since >= s.rest.minMs);
    const sameClassRested = (l: Life) => lives.some(x => x !== l && rested(x) && x.className.toLowerCase() === l.className.toLowerCase());
    const logIn = (l: Life, why: string) => { set(l, 'joining', now, why); actions.push({ kind: 'logIn', bot: l.bot, realm: l.realm, why }); ev('join', l, why); };

    // 2. Sessions over: leave, unless the floor or a needed class holds them, and nobody rested can take over.
    let outThisStep = now - lastOut < s.stepMs;
    for (const l of lives.filter(x => x.state === 'online' && now >= x.until && !o.pinned.stay.has(x.bot)).sort((a, b) => a.until - b.until)) {
        if (outThisStep) break;
        const n = playing().length;
        const replace = lives.filter(rested).length > 0;
        // Players leave when their time is up even if nobody comes in at once: one under the target is fine, two is not.
        if (n - 1 < o.target - 1 && !replace) { l.until = now + s.extendMs; ev('extend', l, `${n} playing for a target of ${o.target}, nobody rested to come in`); continue; }
        // A needed class plays on until another of its class can take over, but not past neededMaxMs (a healer main's long evening).
        if (breaks(l) && !sameClassRested(l) && now - l.since < s.neededMaxMs) { l.until = now + s.extendMs; ev('extend', l, `the last ${l.className} a group needs`); continue; }
        const played = Math.round((now - l.since) / 60_000);
        set(l, 'leaving', now, 'session over'); ev('leave', l, `session over after ${played} min`);
        lastOut = now; outThisStep = true;
        // Its class needed: a rested one of its class comes in for it now.
        if (breaks(l)) {
            const sub = lives.filter(x => rested(x) && x.className.toLowerCase() === l.className.toLowerCase()).sort((a, b) => a.since - b.since)[0];
            if (sub) { logIn(sub, `takes over from ${l.bot} (${l.className})`); lastIn = now; }
        }
    }

    // 3. Over the target: one leaves early (played longest past earlyAfterMs, its class not needed).
    if (!outThisStep && playing().length > o.target) {
        const l = lives.filter(x => x.state === 'online' && !o.pinned.stay.has(x.bot) && now - x.since >= s.earlyAfterMs && !breaks(x)).sort((a, b) => a.until - b.until)[0];
        if (l) { const played = Math.round((now - l.since) / 60_000); set(l, 'leaving', now, 'early'); ev('leave', l, `early after ${played} min: ${playing().length + 1} playing for a target of ${o.target}`); lastOut = now; outThisStep = true; }
    }

    // 4. Under the target: log in rested bots, a missing class first, then the longest away.
    if (now - lastIn >= s.stepMs || lastIn === now) {
        let n = 0;
        while (playing().length < o.target && n < s.logInsPerStep) {
            const open = openNeeds(playing(), needs);
            const pool = lives.filter(rested);
            if (!pool.length) break;
            const fill = pool.filter(x => open.some(need => fits(x, need)));
            const pick = (fill.length ? fill : pool).sort((a, b) => a.since - b.since)[0]!;
            logIn(pick, fill.length ? `${playing().length} of ${o.target} playing; fills a needed ${pick.className}` : `${playing().length} of ${o.target} playing`);
            lastIn = now; n++;
        }
    }

    // 5. Leaving bots no unit holds, standing where a log-in later is safe: log out (again, if the last ask didn't take).
    for (const l of lives) {
        if (l.state !== 'leaving' || o.held.has(l.bot) || !o.inGame.has(l.bot)) continue;
        if (o.unsafe?.has(l.bot)) {
            if (!l.waitedAt || now - l.waitedAt >= s.leaveRetryMs) { l.waitedAt = now; ev('wait', l, 'near a keep: a log-in there would land at the bind, waits to log out'); }
            continue;
        }
        if (l.askedAt && now - l.askedAt < s.leaveRetryMs) continue;
        l.askedAt = now;
        actions.push({ kind: 'logOut', bot: l.bot, realm: l.realm, why: l.why });
    }
    return { actions, events, lastOut, lastIn };
}

/**
 * Whether a log-out here would bring the bot back at its bind: within `clear` of a keep not of its realm, or of a
 * non-portal keep at all (the Faste may be in combat). The server looks within 6000 (WorldMgr.VISIBILITY_DISTANCE).
 */
export function logOutUnsafe(p: { regionId: number; x: number; y: number }, realm: PlayerRealm, owners: (keep: string) => string | null, clear = LIFECYCLE_SETTINGS.keepClear): boolean {
    const keeps = BATTLEGROUND_LAYOUTS[p.regionId]?.keeps ?? [];
    return keeps.some(k => Math.hypot(k.x - p.x, k.y - p.y) < clear && (!k.portal || (owners(k.name) ?? k.owner) !== realm));
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────────────── balance

/** What a realm saw lately: enemy players by realm (key → last seen), and ours near them (bot → last seen near). */
export interface Sightings {
    foes: Record<string, Record<string, number>>;
    near: Record<string, number>;
}

export interface BalanceState {
    shift: number;
    /** Since when the current reading ('under', 'over' or 'even') holds, and when the shift last moved. */
    reading: 'under' | 'over' | 'even';
    readingSince: number;
    movedAt: number;
}

/** Add one board read to the realm's sightings, and forget what is older than the window. */
export function see(sight: Sightings, board: RealmBoardView, now: number, s: BalanceSettings = LIFECYCLE_SETTINGS.balance): void {
    for (const f of board.foes) (sight.foes[f.realm] ??= {})[f.key] = now;
    for (const u of board.units) for (const m of u.members) {
        if (m.isDead) continue;
        if (board.foes.some(f => Math.hypot(f.x - m.x, f.y - m.y) <= s.near)) sight.near[m.bot] = now;
    }
    for (const r of Object.keys(sight.foes)) for (const [k, t] of Object.entries(sight.foes[r]!)) if (now - t > s.windowMs) delete sight.foes[r]![k];
    for (const [k, t] of Object.entries(sight.near)) if (now - t > s.windowMs) delete sight.near[k];
}

/** under: some realm seen ratio× more than ours near them; over: ours near ratio× more than every realm seen; else even. */
export function readBalance(sight: Sightings, s: BalanceSettings = LIFECYCLE_SETTINGS.balance): { reading: BalanceState['reading']; ours: number; seen: Record<string, number> } {
    const ours = Object.keys(sight.near).length;
    const seen = Object.fromEntries(Object.entries(sight.foes).map(([r, m]) => [r, Object.keys(m).length]));
    const most = Math.max(0, ...Object.values(seen));
    if (most >= s.minCount && most > s.ratio * ours) return { reading: 'under', ours, seen };
    if (ours >= s.minCount && most > 0 && ours > s.ratio * most) return { reading: 'over', ours, seen };
    return { reading: 'even', ours, seen };
}

/** The shift after this reading: ±1 once a reading held holdMs (and holdMs since the last move), toward 0 after decayMs even. */
export function stepBalance(b: BalanceState, reading: BalanceState['reading'], now: number, s: BalanceSettings = LIFECYCLE_SETTINGS.balance): BalanceState {
    const out = { ...b };
    if (reading !== b.reading) { out.reading = reading; out.readingSince = now; }
    const held = now - out.readingSince;
    if (reading === 'under' && held >= s.holdMs && now - b.movedAt >= s.holdMs && out.shift < s.maxShift) { out.shift++; out.movedAt = now; }
    else if (reading === 'over' && held >= s.holdMs && now - b.movedAt >= s.holdMs && out.shift > -s.maxShift) { out.shift--; out.movedAt = now; }
    else if (reading === 'even' && out.shift !== 0 && held >= s.decayMs && now - b.movedAt >= s.decayMs) { out.shift += out.shift > 0 ? -1 : 1; out.movedAt = now; }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── raids

/** Whether a realm wants a muster now: the numbers on, out and alive, no raid lately, not already holding the target. */
export function wantsMuster(o: { playing: number; out: number; open: boolean; lastEnd: number; holdsTarget: boolean; shift: number; now: number }, s: RaidSettings = LIFECYCLE_SETTINGS.raid): { want: boolean; why: string } {
    if (o.open) return { want: false, why: 'a muster is open' };
    if (o.holdsTarget) return { want: false, why: 'we hold the Faste' };
    if (o.playing < s.minOnline) return { want: false, why: `${o.playing} playing, a raid wants ${s.minOnline}` };
    if (o.out < s.minOut) return { want: false, why: `${o.out} alive out, a raid wants ${s.minOut}` };
    if (o.shift > 0) return { want: false, why: 'outnumbered in the field' };
    if (o.now - o.lastEnd < s.gapMs) return { want: false, why: `last raid ended ${Math.round((o.now - o.lastEnd) / 60_000)} min ago` };
    return { want: true, why: `${o.playing} playing, ${o.out} alive out` };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────── waves

export interface WaveState {
    id: number;
    phase: 'out' | 'quiet';
    since: number;
    until: number | null;
    toward: Point3 | null;
    /** Out: a unit of ours fought this wave, last at foughtAt. */
    fought: boolean;
    foughtAt: number;
    /** The realm's last sighting outside enemy spawns. */
    lastSeen: (Point3 & { at: number }) | null;
    why: string;
}

export function newWave(now: number): WaveState {
    return { id: 1, phase: 'out', since: now, until: null, toward: null, fought: false, foughtAt: 0, lastSeen: null, why: 'start' };
}

/** Sightings this close to an enemy portal keep are its spawn. */
function nearEnemyPortal(p: { x: number; y: number }, realm: PlayerRealm, clear: number, regionId = THIDRANKI): boolean {
    return (BATTLEGROUND_LAYOUTS[regionId]?.keeps ?? []).some(k => k.portal && k.owner !== realm && Math.hypot(k.x - p.x, k.y - p.y) < clear);
}

/**
 * One step of the realm's wave from its board. Out: remember fights and the last sighting; once out long enough with its
 * last fight over (or far too long), quiet for a few minutes; then out again toward the last sighting. A muster forces out.
 */
export function stepWave(w: WaveState, board: RealmBoardView | null, o: { realm: PlayerRealm; musterOpen: boolean; now: number }, rand: () => number = Math.random, s: WaveSettings = LIFECYCLE_SETTINGS.wave): WaveState {
    const now = o.now;
    const out = { ...w };
    const foes = (board?.foes ?? []).filter(f => !nearEnemyPortal(f, o.realm, s.portalClear));
    if (foes.length) {
        const x = foes.reduce((a, f) => a + f.x, 0) / foes.length, y = foes.reduce((a, f) => a + f.y, 0) / foes.length;
        const z = foes.reduce((a, f) => a + f.z, 0) / foes.length;
        out.lastSeen = { x: Math.round(x), y: Math.round(y), z: Math.round(z), at: now };
    }
    const fighting = (board?.units ?? []).some(u => u.running && u.inFight);
    const goOut = (why: string) => {
        out.id = w.id + 1; out.phase = 'out'; out.since = now; out.until = null; out.fought = false; out.foughtAt = 0; out.why = why;
        out.toward = out.lastSeen && now - out.lastSeen.at <= s.sightingMs ? { x: out.lastSeen.x, y: out.lastSeen.y, z: out.lastSeen.z } : null;
    };
    if (w.phase === 'quiet') {
        if (o.musterOpen) goOut('a muster');
        else if (w.until !== null && now >= w.until) goOut('the break is over');
        return out;
    }
    if (fighting) { out.fought = true; out.foughtAt = now; }
    if (o.musterOpen) return out;
    const over = out.fought && now - out.foughtAt >= s.afterFightMs && now - w.since >= s.outMinMs;
    if (over || now - w.since >= s.outMaxMs) {
        out.id = w.id + 1; out.phase = 'quiet'; out.since = now; out.toward = null;
        out.until = now + s.quietMinMs + rand() * (s.quietMaxMs - s.quietMinMs);
        out.why = over ? 'after a fight' : `out ${Math.round((now - w.since) / 60_000)} min`;
    }
    return out;
}

export function waveFile(realm: PlayerRealm, w: WaveState, now: number): RealmWave {
    return { v: 1, realm, at: now, id: w.id, phase: w.phase, since: w.since, until: w.until, toward: w.toward, why: w.why };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────── gear wear

export interface GearWear {
    /** Lowest and mean condition (%) of the worn items. */
    min: number;
    mean: number;
    /** Worn items below 100 %, lowest first. */
    worn: { slot: number; name: string; condition: number }[];
}

/** The wear of what a bot wears (equipment slots 10-37). */
export function wearOf(equipment: readonly { slot: number; name: string; condition: number }[]): GearWear {
    const items = equipment.filter(i => i.slot >= 10 && i.slot <= 37 && Number.isFinite(i.condition));
    const conds = items.map(i => i.condition);
    return {
        min: conds.length ? Math.min(...conds) : 100,
        mean: conds.length ? conds.reduce((a, b) => a + b, 0) / conds.length : 100,
        worn: items.filter(i => i.condition < 100).sort((a, b) => a.condition - b.condition).map(i => ({ slot: i.slot, name: i.name, condition: i.condition })),
    };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── the runtime

export interface LifecycleRealm {
    realm: PlayerRealm;
    /** Its units (field.ts: groups/<realm-group>, -2, -s1 ...), and their largest sizes (field.ts --mix). */
    units: readonly string[];
    sizes: Readonly<Record<string, number>>;
    bots: readonly LifeBot[];
    /** A main group's required classes (group.json requires.classes). */
    requires?: readonly (string | readonly string[])[];
}

/**
 * A realm for startLifecycle from its main group's folder (groups/<camelot|midgard|hibernia>): every bot of its members
 * and bench with its class and whether it heals (lineup.ts lineupPool), its required classes, and the field's units with
 * their largest sizes.
 */
export async function lifecycleRealm(dir: string, realm: PlayerRealm, units: readonly string[], sizes: Readonly<Record<string, number>>): Promise<LifecycleRealm> {
    const def = loadGroup(dir, { lineup: undefined });
    const pool = await lineupPool(def);
    return { realm, units, sizes, bots: pool.map(c => ({ bot: c.bot, className: c.className, healer: c.healer })), requires: def.requires?.classes };
}

export interface LifecycleOptions {
    realms: readonly LifecycleRealm[];
    /** S1's swarm control. Resolves when the request is made; the life cycle watches the gateway for the effect. */
    presence: { logIn(bot: string): Promise<unknown>; logOut(bot: string): Promise<unknown> };
    /** Bots in game now, any region (default: the gateway's /status). */
    inGame?: () => Promise<Set<string>>;
    /** Where a bot in game stands (default: the gateway's /status/<user>); null when unknown. */
    where?: (bot: string) => Promise<{ regionId: number; x: number; y: number } | null>;
    /** Take a bot no unit holds back into Thidranki (default: enterBattleground for that bot alone, by its own control connection). */
    enter?: (bot: string) => Promise<{ success: boolean; message: string }>;
    /** Whether a running unit holds the bot (field.ts holding). */
    held: (bot: string) => boolean;
    /** The realm's board (director.lastBoard()); null without a director. */
    board?: (realm: PlayerRealm) => RealmBoardView | null;
    musterOpen?: (realm: PlayerRealm) => boolean;
    /** Who holds the Faste now (siege-watch). */
    owner?: () => string | null;
    settings?: Partial<LifecycleSettings>;
    dir?: string;
    waveDir?: string;
    everyMs?: number;
    log?: (line: string) => void;
    /** Plan and log only: no log-ins or log-outs (also while <dir>/off exists). */
    shadow?: boolean;
    rand?: () => number;
}

export interface Lifecycle {
    /** May field.ts pick this bot for a line-up now? (Not while leaving, joining, offline or pinned away.) */
    mayPlay(bot: string): boolean;
    /** The unit's size for its next line-up (0: it sits this one out). */
    sizeOf(unit: string): number;
    /** Whether the realm wants a muster now (field.ts starts it and then calls musterStarted). */
    wantsMuster(realm: PlayerRealm): boolean;
    musterStarted(realm: PlayerRealm): void;
    musterEnded(realm: PlayerRealm): void;
    /** Humans playing in the realm (S1, S6): the target drops by as many. */
    setHumans(realm: PlayerRealm, n: number): void;
    /** S6's "lfg": this bot leaves at its unit's next line-up, as a session end. */
    leaveNow(bot: string, why: string): boolean;
    /** One line per realm: playing / target, shift, wave. */
    summary(): string;
    stop(): void;
}

interface Saved {
    v: 1;
    at: number;
    lives: Life[];
    balance: Record<string, BalanceState>;
    sightings: Record<string, Sightings>;
    waves: Record<string, WaveState>;
    musterEnd: Record<string, number>;
    lastOut: Record<string, number>;
    lastIn: Record<string, number>;
}

const GATEWAY = () => process.env.GATEWAY_HTTP ?? 'http://127.0.0.1:7780';

function userOf(bot: string): string {
    const env = findBotEnv(bot);
    try { return env ? parseEnvFile(readFileSync(env, 'utf8')).BOT_USERNAME || bot : bot; } catch { return bot; }
}

async function gatewayWhere(bot: string): Promise<{ regionId: number; x: number; y: number } | null> {
    try {
        const res = await fetch(`${GATEWAY()}/status/${encodeURIComponent(userOf(bot))}`, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return null;
        const p = ((await res.json()) as { inGame?: boolean; player?: { regionId?: number; x?: number; y?: number } }).player;
        return p && Number.isFinite(p.regionId) && Number.isFinite(p.x) && Number.isFinite(p.y) ? { regionId: p.regionId!, x: p.x!, y: p.y! } : null;
    } catch {
        return null;
    }
}

/** One bot back into Thidranki: its portal keep by the town teleporter, bind, medallion, port (battleground.ts). */
export async function enterAlone(bot: string, className: string, log?: (line: string) => void): Promise<{ success: boolean; message: string }> {
    const c = await connectBot(bot);
    try {
        const m: Member = { bot, role: roleForClass(className), sdk: c.sdk, actions: c.bot };
        const r = await enterBattleground([m], { regionId: THIDRANKI, log });
        return { success: r.success, message: r.message };
    } finally {
        await c.sdk.sendStop().catch(() => null);
        await c.sdk.disconnect().catch(() => null);
    }
}

async function gatewayInGame(): Promise<Set<string>> {
    const res = await fetch(`${GATEWAY()}/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`gateway /status ${res.status}`);
    const j = await res.json() as { bots?: Record<string, { status?: string; inGame?: boolean }> };
    return new Set(Object.entries(j.bots ?? {}).filter(([, b]) => b.status === 'active' && b.inGame).map(([k]) => k));
}

function readJson<T>(path: string): T | null {
    try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null; } catch { return null; }
}

function writeAtomic(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
}

/**
 * Run the life cycle: every `everyMs` (30 s) read who is in game, step each realm's sessions, balance and wave, ask the
 * swarm, write the waves, the state and the log. Gateway user names are bot names (the swarm's /status keys).
 */
export function startLifecycle(opts: LifecycleOptions): Lifecycle {
    const s: LifecycleSettings = { ...LIFECYCLE_SETTINGS, ...opts.settings };
    const dir = opts.dir ?? LIFECYCLE_DIR;
    const waveDir = opts.waveDir ?? WAVE_DIR;
    const rand = opts.rand ?? Math.random;
    const log = opts.log ?? ((l: string) => console.log(l));
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'state.json');
    const logPath = join(dir, 'log.jsonl');
    const samplesPath = join(dir, 'samples.jsonl');
    const record = (e: Record<string, unknown>) => { try { appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), ...e }) + '\n'); } catch { /* full disk: go on */ } };

    const now0 = Date.now();
    const saved = readJson<Saved>(statePath);
    const fresh = saved && saved.v === 1 && now0 - saved.at < 30 * 60_000 ? saved : null;
    const lives = new Map<string, Life>();
    const balance: Record<string, BalanceState> = {};
    const sightings: Record<string, Sightings> = {};
    const waves: Record<string, WaveState> = {};
    const musterEnd: Record<string, number> = {};
    const musterOpenSince: Record<string, number | null> = {};
    const lastOut: Record<string, number> = {}, lastIn: Record<string, number> = {};
    const humans: Record<string, number> = {};
    const target: Record<string, number> = {};
    let started = false;
    for (const r of opts.realms) {
        balance[r.realm] = fresh?.balance[r.realm] ?? { shift: 0, reading: 'even', readingSince: now0, movedAt: now0 };
        sightings[r.realm] = fresh?.sightings[r.realm] ?? { foes: {}, near: {} };
        waves[r.realm] = fresh?.waves[r.realm] ?? newWave(now0);
        musterEnd[r.realm] = fresh?.musterEnd[r.realm] ?? now0;
        lastOut[r.realm] = fresh?.lastOut[r.realm] ?? 0;
        lastIn[r.realm] = fresh?.lastIn[r.realm] ?? 0;
        musterOpenSince[r.realm] = null;
        for (const l of fresh?.lives ?? []) if (l.realm === r.realm && r.bots.some(b => b.bot === l.bot)) lives.set(l.bot, l);
    }
    const realmLives = (realm: PlayerRealm) => [...lives.values()].filter(l => l.realm === realm);
    const pinned = () => {
        const p = readJson<{ away?: string[]; stay?: string[] }>(join(dir, 'pinned.json')) ?? {};
        return { away: new Set(p.away ?? []), stay: new Set(p.stay ?? []) };
    };
    let lastSample = 0;
    let stopped = false, busy = false;
    /** Bots on their way back in now (enterAlone running). */
    const enteringNow = new Set<string>();
    const where = opts.where ?? gatewayWhere;
    const classOf = (bot: string) => opts.realms.flatMap(r => r.bots).find(b => b.bot === bot)?.className ?? '';
    const enterOne = opts.enter ?? ((bot: string) => enterAlone(bot, classOf(bot), line => log(`lifecycle enter ${bot}: ${line}`)));
    const keepOwner = (keep: string) => (keep === 'Thidranki Faste' ? opts.owner?.() ?? null : null);

    const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        try {
            const now = Date.now();
            const inGame = await (opts.inGame ?? gatewayInGame)();
            const pins = pinned();
            const shadow = !!opts.shadow || existsSync(join(dir, 'off'));
            if (!started) {
                started = true;
                for (const r of opts.realms) {
                    const missing = r.bots.filter(b => !lives.has(b.bot));
                    for (const l of initialLives(missing, r.realm, inGame, now, rand, s)) lives.set(l.bot, l);
                }
                log(`lifecycle: ${fresh ? 'state picked up from ' + new Date(fresh.at).toTimeString().slice(0, 5) : 'new'}, ${[...lives.values()].filter(l => l.state === 'online').length} online${shadow ? ' (shadow)' : ''}`);
            }
            // Where the bots stand that may log in, out or walk back in: joining, entering and leaving ones, and those no unit holds.
            const look = [...lives.values()].filter(l => inGame.has(l.bot) && (l.state !== 'online' || !opts.held(l.bot)) && l.state !== 'offline');
            const places = new Map<string, { regionId: number; x: number; y: number } | null>();
            await Promise.all(look.map(async l => { places.set(l.bot, await where(l.bot)); }));
            for (const r of opts.realms) {
                const board = opts.board?.(r.realm) ?? null;
                // Balance and wave from the realm's own board.
                if (board) see(sightings[r.realm]!, board, now, s.balance);
                const read = readBalance(sightings[r.realm]!, s.balance);
                const b = stepBalance(balance[r.realm]!, board ? read.reading : 'even', now, s.balance);
                if (b.shift !== balance[r.realm]!.shift) { record({ kind: 'shift', realm: r.realm, shift: b.shift, ...read }); log(`lifecycle ${r.realm}: shift ${b.shift} (${read.reading}: ours near ${read.ours}, seen ${JSON.stringify(read.seen)})`); }
                balance[r.realm] = b;
                const open = opts.musterOpen?.(r.realm) ?? false;
                if (musterOpenSince[r.realm] && !open) musterEnd[r.realm] = now;
                musterOpenSince[r.realm] = open ? (musterOpenSince[r.realm] ?? now) : null;
                const w = stepWave(waves[r.realm]!, board, { realm: r.realm, musterOpen: open, now }, rand, s.wave);
                if (w.id !== waves[r.realm]!.id) { record({ kind: 'wave', realm: r.realm, phase: w.phase, why: w.why, toward: w.toward, until: w.until }); log(`lifecycle ${r.realm}: wave ${w.id} ${w.phase} (${w.why})${w.toward ? ` toward (${w.toward.x}, ${w.toward.y})` : ''}`); }
                waves[r.realm] = w;
                try { writeWave(waveFile(r.realm, w, now), waveDir); } catch (e) { log(`lifecycle ${r.realm}: wave file: ${(e as Error).message}`); }

                // Sessions.
                const humansIn = humans[r.realm] ?? 0;
                const t = Math.min(r.bots.length, Math.max(s.floor, curveAt(now, s.curve, s.floor) + b.shift) - humansIn);
                const soon = Math.min(r.bots.length, Math.max(s.floor, curveAt(now + 60 * 60_000, s.curve, s.floor) + b.shift) - humansIn);
                target[r.realm] = t;
                const held = new Set(r.bots.map(x => x.bot).filter(x => opts.held(x)));
                const outside = new Set<string>(), unsafe = new Set<string>();
                for (const [bot, p] of places) {
                    if (!p || lives.get(bot)?.realm !== r.realm) continue;
                    if (p.regionId !== THIDRANKI) outside.add(bot);
                    else if (logOutUnsafe(p, r.realm, keepOwner, s.keepClear)) unsafe.add(bot);
                }
                const res = stepRealm(realmLives(r.realm), { target: t, inGame, outside, unsafe, held, needs: groupNeeds(r.requires, r.bots), needsAt: soon, pinned: pins, lastOut: lastOut[r.realm]!, lastIn: lastIn[r.realm]! }, now, rand, s);
                lastOut[r.realm] = res.lastOut; lastIn[r.realm] = res.lastIn;
                for (const e of res.events) { record({ ...e, kind: e.kind, target: t }); log(`lifecycle ${r.realm}: ${e.bot} ${e.kind}: ${e.why}`); }
                for (const a of res.actions) {
                    record({ kind: a.kind, bot: a.bot, realm: a.realm, why: a.why, shadow });
                    if (shadow) continue;
                    if (a.kind === 'enter') {
                        if (enteringNow.has(a.bot)) continue;
                        enteringNow.add(a.bot);
                        void enterOne(a.bot)
                            .then(e => { record({ kind: 'entered', bot: a.bot, success: e.success, message: e.message.slice(0, 300) }); log(`lifecycle: ${a.bot} back in: ${e.success ? 'yes' : 'no'}, ${e.message.slice(0, 200)}`); })
                            .catch((e: Error) => { record({ kind: 'enter-error', bot: a.bot, error: e.message }); log(`lifecycle: ${a.bot} back in failed: ${e.message}`); })
                            .finally(() => enteringNow.delete(a.bot));
                        continue;
                    }
                    const call = a.kind === 'logIn' ? opts.presence.logIn(a.bot) : opts.presence.logOut(a.bot);
                    void call.catch((e: Error) => { record({ kind: 'presence-error', bot: a.bot, action: a.kind, error: e.message }); log(`lifecycle: ${a.kind} ${a.bot} failed: ${e.message}`); });
                }
            }
            const state: Saved = { v: 1, at: now, lives: [...lives.values()], balance, sightings, waves, musterEnd, lastOut, lastIn };
            // Shadow plays its sessions only in its head: no state for the real one to pick up.
            if (!shadow) try { writeAtomic(statePath, JSON.stringify(state)); } catch { /* next time */ }
            if (now - lastSample >= 5 * 60_000) {
                lastSample = now;
                const realms = Object.fromEntries(opts.realms.map(r => {
                    const ls = realmLives(r.realm);
                    return [r.realm, { playing: ls.filter(l => l.state === 'online' || l.state === 'joining' || l.state === 'entering').length, entering: ls.filter(l => l.state === 'entering').length, inGame: r.bots.filter(x => inGame.has(x.bot)).length, leaving: ls.filter(l => l.state === 'leaving').length, target: target[r.realm], curve: curveAt(now, s.curve, s.floor), shift: balance[r.realm]!.shift, humans: humans[r.realm] ?? 0, wave: waves[r.realm]!.phase }];
                }));
                try { appendFileSync(samplesPath, JSON.stringify({ at: new Date(now).toISOString(), shadow, realms }) + '\n'); } catch { /* next time */ }
            }
        } catch (e) {
            log(`lifecycle: ${(e as Error).message}`);
        } finally {
            busy = false;
        }
    };
    const timer = setInterval(() => void tick(), opts.everyMs ?? 30_000);
    void tick();

    const unitRealm = new Map<string, LifecycleRealm>();
    for (const r of opts.realms) for (const u of r.units) unitRealm.set(u, r);
    return {
        mayPlay(bot) {
            if (pinned().away.has(bot)) return false;
            const l = lives.get(bot);
            return !l || !started || l.state === 'online';
        },
        sizeOf(unit) {
            const r = unitRealm.get(unit);
            if (!r || !started) return r?.sizes[unit] ?? 0;
            const n = realmLives(r.realm).filter(l => l.state === 'online').length;
            return mixFor(n, r.units, r.sizes)[unit] ?? 0;
        },
        wantsMuster(realm) {
            const board = opts.board?.(realm) ?? null;
            const out = (board?.units ?? []).filter(u => u.running).reduce((a, u) => a + u.alive, 0);
            const w = wantsMuster({ playing: realmLives(realm).filter(l => l.state === 'online').length, out, open: opts.musterOpen?.(realm) ?? false, lastEnd: musterEnd[realm] ?? 0, holdsTarget: opts.owner?.() === realm, shift: balance[realm]?.shift ?? 0, now: Date.now() }, s.raid);
            return w.want;
        },
        musterStarted(realm) { musterOpenSince[realm] = Date.now(); record({ kind: 'muster', realm }); },
        musterEnded(realm) { musterEnd[realm] = Date.now(); musterOpenSince[realm] = null; },
        setHumans(realm, n) { humans[realm] = Math.max(0, n); record({ kind: 'humans', realm, n }); },
        leaveNow(bot, why) {
            const l = lives.get(bot);
            if (!l || l.state !== 'online') return false;
            l.state = 'leaving'; l.since = Date.now(); l.until = Date.now(); l.why = why;
            record({ kind: 'leave', bot, realm: l.realm, why });
            return true;
        },
        summary() {
            return opts.realms.map(r => {
                const ls = realmLives(r.realm);
                return `${r.realm} ${ls.filter(l => l.state === 'online').length}/${target[r.realm] ?? '?'} (shift ${balance[r.realm]!.shift}, ${ls.filter(l => l.state === 'leaving').length} leaving, ${ls.filter(l => l.state === 'joining').length} joining, ${ls.filter(l => l.state === 'entering').length} entering, wave ${waves[r.realm]!.phase})`;
            }).join('; ');
        },
        stop() { stopped = true; clearInterval(timer); },
    };
}
