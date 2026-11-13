// A healer's stand in a keep fight, as a player keeps it: within group-heal reach of the group (2000, every Group heal at 24)
// and out of the enemy's line of sight, behind a keep wall, a building, a floor or a hill. A caster that can't see her can't
// start a spell on her, and one already casting loses it ("You can't see your target from here!"). For the Druid, Cleric and
// Healer kits. Only at a keep (user, 2026-11-13): the defence of our own, a raid on theirs, and the floors inside; in the field
// her turns are for her other work.
// - `standOutOfSight`: in a keep fight, while nobody in her reach needs a heal (or an enemy is casting at her), a step of at
//   most STAND_STEP to a spot no free enemy player sees, keeping every member she reaches now in reach (3D: floors), and on a
//   defence seat (sdk/group/defence.ts) within its leash.
// - `sightClock`: on the side tick, how long she stood in an enemy's sight in each fight, anywhere, as a note at the fight's
//   end: "in enemy sight 12.0 s of 41.5 s in the fight (29 %)", with ", at the keep" for a keep fight. The stint's measure
//   (groups/stint-lives-on-its-own.md, 6).
// Sight is the client's own (sdk/vision.ts lineOfSight: the terrain heightmap and the zone fixtures' collision meshes),
// the same that answers the server's checks, from the enemy's eyes to her chest. A spot's height is the navmesh floor she
// stands on (inside a keep the terrain is under the floors), and a spot counts only with a short walk to it on the navmesh
// (stairs and doors included). learnings/classes/cleric.md "The stand".

import { hammeredBy, type TacticsSettings } from '../group/behaviors';
import { keepAt } from '../group/keeps';
import type { Behavior, MemberContext } from '../group/member';
import type { MemberReport } from '../group/types';
import { wallSight } from '../group/siege';
import { isWet } from '../group/water';
import { getNavmeshStore, PolyFlags } from '../navmesh';
import { fixtureSolid, lineOfSight, terrainGround, type Seen } from '../vision';

/** Group heals reach 2000 (Heaven's Commendation, Favor of Battle, Renewing Conflux); a margin for moves and the server's 3D. */
export const STAND_REACH = 1800;
/** An enemy farther than this can't reach her with a spell (1500-2000 at 24) before a step of hers; nearer counts. */
export const SIGHT_RANGE = 2300;
/** The longest step to cover: farther is a walk, and her heals wait for it. */
export const STAND_STEP = 450;
/** No new step sooner than this after the last: a step a turn would be all she does. */
const STAND_SPACING_MS = 3000;
/** A spot no nearer to the nearest enemy than she is now, less this. */
const NO_CLOSER = 100;
/** A spot's floor is the navmesh within this of her height: a stair step either way, not the floor above or below (~250 apart). */
const FLOOR_Z = 120;
/** The walk to a spot may be this many times the straight line (round a corner, down a stair), plus WALK_SLACK. */
const WALK_FACTOR = 2;
const WALK_SLACK = 150;

export interface Foe extends Seen { id: number }
type Los = (regionId: number, from: Seen, to: Seen) => boolean;
type P2 = { x: number; y: number };
type P3 = P2 & { z?: number | null };

const d3 = (a: P3, b: P3) => Math.hypot(a.x - b.x, a.y - b.y, a.z == null || b.z == null ? 0 : a.z - b.z);

/** The foes that see a spot: its line of sight from their eyes to a chest standing there. */
export function seenBy(regionId: number, at: Seen, foes: readonly Foe[], los: Los = lineOfSight): Foe[] {
    return foes.filter(f => los(regionId, f, at));
}

/** The floor at `p` near height `z`: the navmesh where the zone has one (null off it), else the terrain. */
export function floorAt(regionId: number, p: P2, z: number): number | null {
    const mesh = getNavmeshStore().at(regionId, p.x, p.y);
    if (!mesh) return terrainGround(regionId, p.x, p.y) ?? z;
    return mesh.surfaceZ({ x: p.x, y: p.y, z }, { x: 16, y: 16, z: FLOOR_Z });
}

/** A short walk from `from` to `to`: a navmesh path found, dry, at most WALK_FACTOR times the line; without a mesh, no wall across. */
export function shortWalk(regionId: number, from: Seen, to: Seen): boolean {
    const mesh = getNavmeshStore().at(regionId, from.x, from.y);
    if (!mesh) return !fixtureSolid(regionId, { ...from, z: from.z + 50 }, { ...to, z: to.z + 50 });
    const path = mesh.findPath(from, to, undefined, PolyFlags.Swim);
    if (path.status !== 'found') return false;
    let len = 0;
    for (let i = 1; i < path.points.length; i++) len += d3(path.points[i - 1]!, path.points[i]!);
    return len <= WALK_FACTOR * d3(from, to) + WALK_SLACK;
}

export interface SpotOptions {
    reach?: number;
    step?: number;
    los?: Los;
    /** The floor at a spot near a height, or null for none there. */
    floor?: (p: P2, z: number) => number | null;
    wet?: (p: P2) => boolean;
    /** Whether she gets there by a short walk. */
    walk?: (from: Seen, to: Seen) => boolean;
    /** A bound on where she may stand (a defence seat's leash). */
    within?: (p: Seen) => boolean;
    /** How many of an enemy keep's wall casters and roof archers see a spot (siege.ts wallSight); none by default. */
    walls?: (p: Seen) => number;
}

/**
 * Where to step to be out of sight, or null: candidates on rings of 150, 300 and the step (STAND_STEP) round her, 16 ways,
 * on her floor there, not in water, no nearer the nearest foe than now (less NO_CLOSER), with every member within `reach` of
 * her now (3D) still within it, inside `within`, and a short walk away. The one seen by the fewest foes, then the shortest
 * step; only one seen by fewer than now.
 */
export function standSpot(regionId: number, me: Seen, members: readonly (Pick<MemberReport, 'x' | 'y'> & { z?: number })[], foes: readonly Foe[], o: SpotOptions = {}): { x: number; y: number; z: number; seen: number } | null {
    const reach = o.reach ?? STAND_REACH, step = o.step ?? STAND_STEP, los = o.los ?? lineOfSight;
    const floor = o.floor ?? ((p, z) => floorAt(regionId, p, z));
    const wet = o.wet ?? (p => isWet(regionId, p));
    const walk = o.walk ?? ((a, b) => shortWalk(regionId, a, b));
    const within = o.within ?? (() => true);
    const walls = o.walls ?? (() => 0);
    const kept = members.filter(m => d3(m, me) <= reach);
    const nearest = (p: P2) => Math.min(...foes.map(f => Math.hypot(f.x - p.x, f.y - p.y)));
    // A wall guard that sees her counts as a foe here, and no spot one sees is taken (S2, live 16:43: Amergin killed by
    // wall-e-n's Runemaster through a merlon gap, 1300 from the raid's stand).
    const now = seenBy(regionId, me, foes, los).length + walls(me);
    if (!now) return null;
    const closest = nearest(me) - NO_CLOSER;
    let best: { x: number; y: number; z: number; seen: number; d: number } | null = null;
    for (const r of [150, 300, step]) {
        for (let k = 0; k < 16; k++) {
            const a = (k / 16) * 2 * Math.PI;
            const p = { x: Math.round(me.x + Math.cos(a) * r), y: Math.round(me.y + Math.sin(a) * r) };
            if (wet(p) || nearest(p) < closest) continue;
            const z = floor(p, me.z);
            if (z === null) continue;
            const at = { ...p, z };
            if (!within(at) || kept.some(m => d3(m, at) > reach) || walls(at) > 0) continue;
            const seen = seenBy(regionId, at, foes, los).length;
            if (seen >= now || (best && (seen > best.seen || (seen === best.seen && r >= best.d)))) continue;
            if (!walk(me, at)) continue;
            best = { ...at, seen, d: r };
        }
        if (best?.seen === 0) break;
    }
    return best && { x: best.x, y: best.y, z: best.z, seen: best.seen };
}

/** The enemy players in her client within SIGHT_RANGE (3D), alive and not under our crowd control: who could cast at her. */
export function sightFoes(ctx: MemberContext<any>): Foe[] {
    const me = ctx.me();
    const now = Date.now();
    const held = new Set(ctx.picture().contacts.filter(c => c.cc && c.cc.until > now).map(c => c.objectId));
    return ctx.sdk.getNearbyPlayers()
        .filter(p => p.realm !== me.realm && !p.isDead && !held.has(p.objectId) && Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z) <= SIGHT_RANGE)
        .map(p => ({ id: p.objectId, x: p.x, y: p.y, z: p.z }));
}

/** In a fight by the group's picture: enemies on us, or the orders engage or retreat. */
const inFight = (ctx: MemberContext<any>) => ctx.threats().length > 0 || ctx.orders().phase === 'engage' || ctx.orders().phase === 'retreat';

/** Our seat in the keep's defence (Orders.settings.defence, sdk/group/defence.ts), if the orders give us one. */
interface Seat { at: { x: number; y: number; z: number }; leash: number }
const seatOf = (ctx: Pick<MemberContext<any>, 'settings' | 'name'>): Seat | null =>
    (ctx.settings as { defence?: { seats?: Record<string, Seat> } | null }).defence?.seats?.[ctx.name] ?? null;

/** A keep fight: a seat in the defence, or standing in a keep's area (keepAt: within 3000 of a battleground keep), never a portal keep's. */
export function atKeep(regionId: number, me: P2, seated: boolean): boolean {
    if (seated) return true;
    const k = keepAt(regionId, me);
    return !!k && !k.portal;
}

/** A spell of an enemy is coming at her: it targets her and cast within the last 3 s. */
const castAtMe = (ctx: MemberContext<any>) => {
    const name = ctx.me().name;
    return ctx.threats().some(c => !c.cc && c.kind === 'player' && c.target === name && (c.castingAt ?? 0) > Date.now() - 3000);
};

/**
 * In a keep fight: a step out of every free enemy player's sight (standSpot), while no living member within her reach is under
 * its heal line (settings.heal), unless an enemy is casting at her. Never with a melee on her (flee's). On a defence seat, within
 * its leash (a leash of 0 holds her on it: no step).
 */
export const standOutOfSight = (): Behavior<TacticsSettings> => ({
    name: 'stand',
    async run(ctx) {
        if (!inFight(ctx) || hammeredBy(ctx)) return false;
        if (Date.now() - (ctx.memory.get('standAt') ?? 0) < STAND_SPACING_MS) return false;
        const me = ctx.me();
        const self = ctx.members().find(m => m.name === me.name);
        const region = self?.regionId ?? me.regionId;
        const seat = seatOf(ctx);
        if (!atKeep(region, me, !!seat) || seat?.leash === 0) return false;
        const others = ctx.members().filter(m => m.name !== me.name && !m.isDead && m.regionId === region);
        const s = ctx.settings.heal;
        const hurt = ctx.members().some(m => !m.isDead && m.regionId === region && d3(m, me) <= STAND_REACH && m.hp < (m.role === 'tank' ? s.tank : s.other));
        if (hurt && !castAtMe(ctx)) return false;
        const foes = sightFoes(ctx);
        // An enemy keep's wall guards (no keep of ours is in a raid: ctx.settings.raid); ours are no danger.
        const ours = !(ctx.settings as { raid?: unknown }).raid;
        const walls = (p: Seen) => wallSight(region, p, ours).length;
        if (!foes.length && !walls(me)) return false;
        const spot = standSpot(region, me, others, foes, { walls, ...(seat ? { within: (p: Seen) => d3(p, seat.at) <= seat.leash } : {}) });
        if (!spot) return ctx.skip('stand: no cover in reach of the group');
        ctx.memory.set('standAt', Date.now());
        ctx.doing('move', null, `out of sight (${spot.seen} of ${foes.length} see the spot)`);
        // A route round a wall corner or down a stair can be longer than the step: a timeout is a step part of the way, and the next turn looks again.
        const w = await ctx.bot.walkTo(spot.x, spot.y, { z: spot.z, tolerance: 40, timeout: 3500 });
        ctx.result('stand', w.success || w.reason === 'timeout' ? { success: true, message: `${spot.seen} of ${foes.length} see it${w.success ? '' : ' (part way)'}` } : w);
        return true;
    },
});

/** How often the clock looks; a sight line is ~40 terrain samples and a fixture query per foe. */
const CLOCK_EVERY_MS = 1000;
/** A fight ends this long after the last sign of one. */
const FIGHT_GONE_MS = 5000;

interface Clock { at: number; fightMs: number; sightMs: number; lastFight: number; keep: boolean }

/** Side tick: the time in an enemy's sight per fight, as a note at its end (no action, no turn). */
export const sightClock = (): Behavior<TacticsSettings> => ({
    name: 'sightClock',
    side: true,
    run(ctx) {
        const now = Date.now();
        const c: Clock = ctx.memory.get('sightClock') ?? { at: 0, fightMs: 0, sightMs: 0, lastFight: 0, keep: false };
        if (now - c.at < CLOCK_EVERY_MS) return false;
        const dt = c.at ? Math.min(now - c.at, 3000) : 0;
        c.at = now;
        ctx.memory.set('sightClock', c);
        const me = ctx.sdk.getPlayer();
        if (!me || me.isDead) return false;
        if (inFight(ctx)) {
            c.lastFight = now;
            c.fightMs += dt;
            if (atKeep(me.regionId, me, !!seatOf(ctx))) c.keep = true;
            if (seenBy(me.regionId, me, sightFoes(ctx)).length) c.sightMs += dt;
        } else if (c.fightMs && now - c.lastFight > FIGHT_GONE_MS) {
            if (c.fightMs >= 5000) ctx.note(`in enemy sight ${(c.sightMs / 1000).toFixed(1)} s of ${(c.fightMs / 1000).toFixed(1)} s in the fight (${Math.round(100 * c.sightMs / c.fightMs)} %)${c.keep ? ', at the keep' : ''}`);
            c.fightMs = 0;
            c.sightMs = 0;
            c.keep = false;
        }
        return false;
    },
});
