// A healer's stand as a player keeps it: within group-heal reach of the group (2000, every Group heal at 24) and out of
// the enemy's line of sight, behind a hill, a keep wall or a building. A caster that can't see her can't start a spell
// on her, and one already casting loses it ("You can't see your target from here!"). For the Druid, Cleric and Healer kits.
// - `standOutOfSight`: in a fight, while nobody in her reach needs a heal (or an enemy is casting at her), a step of at
//   most STAND_STEP to a spot no free enemy player sees, keeping every member she reaches now in reach.
// - `sightClock`: on the side tick, how long she stood in an enemy's sight in each fight, as a note at the fight's end:
//   "in enemy sight 12.0 s of 41.5 s in the fight (29 %)". The stint's measure (groups/stint-lives-on-its-own.md, 6).
// Sight is the client's own (sdk/vision.ts lineOfSight: the terrain heightmap and the zone fixtures' collision meshes),
// the same that answers the server's checks, from the enemy's eyes to her chest. learnings/classes/cleric.md "The stand".

import { hammeredBy, type TacticsSettings } from '../group/behaviors';
import type { Behavior, MemberContext } from '../group/member';
import type { MemberReport } from '../group/types';
import { isWet } from '../group/water';
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

export interface Foe extends Seen { id: number }
type Los = (regionId: number, from: Seen, to: Seen) => boolean;
type Ground = (regionId: number, x: number, y: number) => number | null;

/** The foes that see a spot: its line of sight from their eyes to a chest standing there. */
export function seenBy(regionId: number, at: Seen, foes: readonly Foe[], los: Los = lineOfSight): Foe[] {
    return foes.filter(f => los(regionId, f, at));
}

/**
 * Where to step to be out of sight, or null: candidates on rings of 150, 300 and the step (STAND_STEP) round her, 16 ways,
 * on the ground there, not in water, reached without crossing a wall, no nearer the nearest foe than now (less NO_CLOSER),
 * and with every member within `reach` of her now still within it. The one seen by the fewest foes, then the shortest
 * step; only one seen by fewer than now.
 */
export function standSpot(regionId: number, me: Seen, members: readonly Pick<MemberReport, 'x' | 'y'>[], foes: readonly Foe[], o: { reach?: number; step?: number; los?: Los; ground?: Ground; wet?: (p: { x: number; y: number }) => boolean; blocked?: (from: Seen, to: Seen) => boolean } = {}): { x: number; y: number; z: number; seen: number } | null {
    if (!foes.length) return null;
    const reach = o.reach ?? STAND_REACH, step = o.step ?? STAND_STEP, los = o.los ?? lineOfSight, ground = o.ground ?? terrainGround;
    const wet = o.wet ?? (p => isWet(regionId, p));
    const blocked = o.blocked ?? ((a, b) => fixtureSolid(regionId, { ...a, z: a.z + 50 }, { ...b, z: b.z + 50 }));
    const d2 = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
    const kept = members.filter(m => d2(m, me) <= reach);
    const nearest = (p: { x: number; y: number }) => Math.min(...foes.map(f => d2(f, p)));
    const now = seenBy(regionId, me, foes, los).length;
    if (!now) return null;
    const floor = nearest(me) - NO_CLOSER;
    let best: { x: number; y: number; z: number; seen: number; d: number } | null = null;
    for (const r of [150, 300, step]) {
        for (let k = 0; k < 16; k++) {
            const a = (k / 16) * 2 * Math.PI;
            const p = { x: Math.round(me.x + Math.cos(a) * r), y: Math.round(me.y + Math.sin(a) * r) };
            if (wet(p) || nearest(p) < floor || kept.some(m => d2(m, p) > reach)) continue;
            const z = ground(regionId, p.x, p.y) ?? me.z;
            const at = { ...p, z };
            if (blocked(me, at)) continue;
            const seen = seenBy(regionId, at, foes, los).length;
            if (seen >= now) continue;
            if (!best || seen < best.seen || (seen === best.seen && r < best.d)) best = { ...at, seen, d: r };
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

/** A spell of an enemy is coming at her: it targets her and cast within the last 3 s. */
const castAtMe = (ctx: MemberContext<any>) => {
    const name = ctx.me().name;
    return ctx.threats().some(c => !c.cc && c.kind === 'player' && c.target === name && (c.castingAt ?? 0) > Date.now() - 3000);
};

/**
 * In a fight: a step out of every free enemy player's sight (standSpot), while no living member within her reach is under
 * its heal line (settings.heal), unless an enemy is casting at her. Never with a melee on her (flee's).
 */
export const standOutOfSight = (): Behavior<TacticsSettings> => ({
    name: 'stand',
    async run(ctx) {
        if (!inFight(ctx) || hammeredBy(ctx)) return false;
        if (Date.now() - (ctx.memory.get('standAt') ?? 0) < STAND_SPACING_MS) return false;
        const me = ctx.me();
        const self = ctx.members().find(m => m.name === me.name);
        const region = self?.regionId ?? me.regionId;
        const others = ctx.members().filter(m => m.name !== me.name && !m.isDead && m.regionId === region);
        const s = ctx.settings.heal;
        const hurt = ctx.members().some(m => !m.isDead && m.regionId === region && Math.hypot(m.x - me.x, m.y - me.y) <= STAND_REACH && m.hp < (m.role === 'tank' ? s.tank : s.other));
        if (hurt && !castAtMe(ctx)) return false;
        const foes = sightFoes(ctx);
        if (!foes.length) return false;
        const spot = standSpot(region, me, others, foes);
        if (!spot) return ctx.skip('stand: no cover in reach of the group');
        ctx.memory.set('standAt', Date.now());
        ctx.doing('move', null, `out of sight (${spot.seen} of ${foes.length} see the spot)`);
        // A route round a wall corner can be longer than the step: a timeout is a step part of the way, and the next turn looks again.
        const w = await ctx.bot.walkTo(spot.x, spot.y, { z: spot.z, tolerance: 40, timeout: 3500 });
        ctx.result('stand', w.success || w.reason === 'timeout' ? { success: true, message: `${spot.seen} of ${foes.length} see it${w.success ? '' : ' (part way)'}` } : w);
        return true;
    },
});

/** How often the clock looks; a sight line is ~40 terrain samples and a fixture query per foe. */
const CLOCK_EVERY_MS = 1000;
/** A fight ends this long after the last sign of one. */
const FIGHT_GONE_MS = 5000;

interface Clock { at: number; fightMs: number; sightMs: number; lastFight: number }

/** Side tick: the time in an enemy's sight per fight, as a note at its end (no action, no turn). */
export const sightClock = (): Behavior<TacticsSettings> => ({
    name: 'sightClock',
    side: true,
    run(ctx) {
        const now = Date.now();
        const c: Clock = ctx.memory.get('sightClock') ?? { at: 0, fightMs: 0, sightMs: 0, lastFight: 0 };
        if (now - c.at < CLOCK_EVERY_MS) return false;
        const dt = c.at ? Math.min(now - c.at, 3000) : 0;
        c.at = now;
        ctx.memory.set('sightClock', c);
        const me = ctx.sdk.getPlayer();
        if (!me || me.isDead) return false;
        if (inFight(ctx)) {
            c.lastFight = now;
            c.fightMs += dt;
            if (seenBy(me.regionId, me, sightFoes(ctx)).length) c.sightMs += dt;
        } else if (c.fightMs && now - c.lastFight > FIGHT_GONE_MS) {
            if (c.fightMs >= 5000) ctx.note(`in enemy sight ${(c.sightMs / 1000).toFixed(1)} s of ${(c.fightMs / 1000).toFixed(1)} s in the fight (${Math.round(100 * c.sightMs / c.fightMs)} %)`);
            c.fightMs = 0;
            c.sightMs = 0;
        }
        return false;
    },
});
