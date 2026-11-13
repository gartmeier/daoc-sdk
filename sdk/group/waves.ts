// Waves (the life cycle's unit side, S4): a realm goes out toward where it last saw enemies, fights, then spends a few
// minutes of quiet at its portal keep, where its members idle as players do (sit, turn, a step) instead of standing in
// formation. The realm's wave is decided in sdk/group/lifecycle.ts (stepWave) and written to <dir>/<realm>-wave.json; a
// unit's coordinator reads it (waveWatch, from rvr.ts realmCalls) and turns it into orders (waveOrder, from decideRvr,
// after fights, calls and rests: a fight, a help call or a muster always comes first). No file, or a stale one (the
// life cycle not running): no wave, the unit patrols as before.
//
// Kept apart from lifecycle.ts so the units' processes load only this (fs, keeps, behaviors), never the line-up code.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { formationSlot, type TacticsSettings } from './behaviors';
import { homeOf, type PlayerRealm } from './keeps';
import type { Behavior } from './member';
import type { Point, Point3 } from './types';

/** Where the director's files live (director.ts DIRECTOR_DIR, without importing it). */
export const WAVE_DIR = process.env.DAOC_DIRECTOR_DIR ?? join(import.meta.dir, '..', '..', 'groups', 'director');

/** <dir>/<realm>-wave.json */
export interface RealmWave {
    v: 1;
    realm: PlayerRealm;
    /** Written at (ms epoch): older than WAVE_STALE_MS, the units ignore it. */
    at: number;
    /** Bumped on each new wave (out or quiet). */
    id: number;
    phase: 'out' | 'quiet';
    since: number;
    /** Quiet: when it goes out again. */
    until: number | null;
    /** Out: where the realm last saw enemies when this wave went out (null: none seen lately, patrol as usual). */
    toward: Point3 | null;
    why: string;
}

/** A wave file older than this is the life cycle gone: ignored. */
export const WAVE_STALE_MS = 3 * 60_000;
/** Quiet: a unit's spot by its portal keep is this far from where we arrive (by its name, so units don't stack). */
const QUIET_RING = { min: 500, max: 900 };
/** Quiet: a unit farther than this from its spot walks there first. */
export const QUIET_NEAR = 900;
/** Out: a unit within this of `toward` has reached it, and patrols on from there. */
export const TOWARD_NEAR = 2500;
/** The orders' reason of a quiet unit at its keep starts with this; loiter() acts only on it. */
export const QUIET_REASON = 'quiet:';

export function wavePath(realm: string, dir = WAVE_DIR): string {
    return join(dir, `${realm}-wave.json`);
}

export function writeWave(w: RealmWave, dir = WAVE_DIR): void {
    const path = wavePath(w.realm, dir);
    mkdirSync(dirname(path), { recursive: true });
    // A directory in its place blocked an older writer (13:36 on 11-13, a shadow run's waves): clear it.
    if (existsSync(path) && statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(w));
    renameSync(tmp, path);
}

/** The realm's wave from its file, read at most every `everyMs`; null when missing, unreadable or stale. */
export function waveWatch(realm: string, dir = WAVE_DIR, everyMs = 2000): { wave(now?: number): RealmWave | null } {
    const path = wavePath(realm, dir);
    let readAt = 0, mtime = 0;
    let last: RealmWave | null = null;
    return {
        wave(now = Date.now()) {
            if (now - readAt >= everyMs) {
                readAt = now;
                try {
                    if (!existsSync(path)) last = null;
                    else {
                        const m = statSync(path).mtimeMs;
                        if (m !== mtime) { mtime = m; last = JSON.parse(readFileSync(path, 'utf8')) as RealmWave; }
                    }
                } catch { last = null; }
            }
            return last && now - last.at <= WAVE_STALE_MS ? last : null;
        },
    };
}

/** A stable number in [0, 1) from a name. */
function hash01(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 100000) / 100000;
}

/** A unit's quiet spot by its realm's portal keep: round where we arrive, at an angle and distance of its own. */
export function quietSpot(regionId: number, realm: PlayerRealm, unit: string): Point3 | null {
    const home = homeOf(regionId, realm);
    if (!home) return null;
    const a = hash01(unit) * 2 * Math.PI;
    const r = QUIET_RING.min + hash01(`${unit}/r`) * (QUIET_RING.max - QUIET_RING.min);
    return { x: Math.round(home.arrival.x + Math.cos(a) * r), y: Math.round(home.arrival.y + Math.sin(a) * r), z: home.arrival.z };
}

export type WaveOrder =
    | { kind: 'home'; at: Point3; why: string }
    | { kind: 'quiet'; at: Point3; why: string }
    | { kind: 'toward'; at: Point3; key: string; why: string }
    | { kind: 'reached'; key: string };

const d2 = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * What the realm's wave asks of a free unit (no fight, no call, nobody dead or away, rested): null to patrol as usual.
 * Quiet: walk to its spot by the portal keep ('home'), then stay there ('quiet'). Out with somewhere to go: a leg toward
 * it ('toward'), once per wave; within TOWARD_NEAR it is 'reached' (the caller remembers the key) and patrols on.
 */
export function waveOrder(wave: RealmWave | null, o: { unit: string; realm: PlayerRealm; regionId: number; centre: Point; reached?: string | null; now?: number }): WaveOrder | null {
    if (!wave) return null;
    const now = o.now ?? Date.now();
    if (wave.phase === 'quiet') {
        const at = quietSpot(o.regionId, o.realm, o.unit);
        if (!at) return null;
        const left = wave.until ? Math.max(0, Math.round((wave.until - now) / 1000)) : null;
        const d = d2(o.centre, at);
        if (d > QUIET_NEAR) return { kind: 'home', at, why: `${QUIET_REASON} back to the portal keep for a break (${wave.why}), ${Math.round(d)} away` };
        return { kind: 'quiet', at, why: `${QUIET_REASON} a break at the portal keep${left !== null ? `, out again in ${left} s` : ''} (${wave.why})` };
    }
    if (!wave.toward) return null;
    const key = `${wave.id}`;
    if (o.reached === key) return null;
    if (d2(o.centre, wave.toward) <= TOWARD_NEAR) return { kind: 'reached', key };
    return { kind: 'toward', at: wave.toward, key, why: `wave: out toward where our realm last saw enemies (${Math.round(wave.toward.x)}, ${Math.round(wave.toward.y)}), ${Math.round(d2(o.centre, wave.toward))} away` };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────── idling like players

/** A turn idling: what a member does next and when it picks again. */
interface Idle { act: 'sit' | 'turn' | 'step' | 'stand'; next: number }
/** An idle act lasts this long before the member picks another. */
const IDLE_MS = { min: 15_000, max: 50_000 };
/** A step goes this far at most from the member's formation slot (rvr's slotSlack is 350: holdFormation leaves it there). */
const STEP_REACH = 220;

/** The next idle act: mostly sit and turn, sometimes a step, now and then stand up. */
export function nextIdle(rand: () => number, now: number): Idle {
    const r = rand();
    const act: Idle['act'] = r < 0.4 ? 'sit' : r < 0.65 ? 'turn' : r < 0.9 ? 'step' : 'stand';
    return { act, next: now + IDLE_MS.min + rand() * (IDLE_MS.max - IDLE_MS.min) };
}

/**
 * Last in each list: in a quiet break at the portal keep (orders reason QUIET_REASON, phase recover) with nothing on us,
 * idle as a player would: sit down, turn, take a step near our slot, stand up again, each for a while. Everything above
 * (buffs, rest, holdFormation) comes first; a walk or a cast stands us up by itself.
 */
export const loiter = (rand: () => number = Math.random): Behavior<TacticsSettings> => ({
    name: 'loiter',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'recover' || !o.reason.startsWith(QUIET_REASON) || !o.anchor || ctx.threats().length) return false;
        const me = ctx.me();
        if (me.isDead) return false;
        const now = Date.now();
        const was: Idle | undefined = ctx.memory.get('loiter');
        if (was && now < was.next) {
            ctx.doing('idle', null, `idle at the keep: ${was.act}`);
            await Bun.sleep(1000);
            return true;
        }
        const idle = nextIdle(rand, now);
        ctx.memory.set('loiter', idle);
        if (idle.act === 'sit' && !me.isSitting) await ctx.sdk.sendSit(true);
        else if (idle.act === 'stand' && me.isSitting) await ctx.sdk.sendSit(false);
        else if (idle.act === 'turn') await ctx.sdk.sendFace(Math.floor(rand() * 4096));
        else if (idle.act === 'step') {
            const slot = formationSlot(ctx, o.anchor, o.facing);
            const a = rand() * 2 * Math.PI, r = rand() * STEP_REACH;
            await ctx.sdk.sendMoveTo(Math.round(slot.x + Math.cos(a) * r), Math.round(slot.y + Math.sin(a) * r), me.z, { tolerance: 40 });
        }
        ctx.doing('idle', null, `idle at the keep: ${idle.act}`);
        return true;
    },
});
