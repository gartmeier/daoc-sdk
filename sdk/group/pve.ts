// PvE leveling: find a camp for the group's level, set up a base next to it,
// travel there together, rest until everyone is ready, let the tank body-pull
// one monster at a time, focus it, mezz adds, retreat when the fight is lost.
//
// decide() runs every coordinator tick on the shared picture. It only writes
// orders; members carry them out with their behaviour lists.

import { conLevel } from '../actions-helpers';
import { planBase, planRejects, segDist, type BasePlan } from './baseplan';
import { defaultBehaviors, mezzRefuses, SAVING_POWER, type TacticsSettings } from './behaviors';
import { readsOnPet } from './blackboard';
import type { Finding, RunReport } from './observer';
import { PET_SETTINGS, waitsForPet } from './pets';
import type { CoordinatorContext, GroupStrategy } from './strategy';
import { aggroAt, chooseBase, dangerNear, findCamp, keepOnMap, safePath, type Camp } from './terrain';
import type { Contact, MemberReport, OrdersUpdate, Point, Point3 } from './types';

export interface PveSettings extends TacticsSettings {
    /** Pull targets in this con window relative to the group's lowest level (-3 grey .. 3 purple). */
    minCon: number;
    maxCon: number;
    /**
     * Never pull a mob more than this many levels above the group's lowest level (99 = off).
     * Con stops at purple (3), so maxCon 3 alone lets in anything above: camelot run 20261031-004507
     * (L11) pulled Granddaddy Longlegs L24 as "con 3" and all five died.
     */
    maxLevelAbove: number;
    /** Hunt here instead of searching static data for a camp. */
    camp: Point3 | null;
    /** Camp search: spawn levels from group level + band[0] to + band[1]. */
    campLevelBand: [number, number];
    /** Camp search: an aggressive spawn counts as this fraction of a passive one (below 1 prefers passive camps). */
    campAggressiveWeight: number;
    /**
     * Reject a camp when an aggressive spawn at or above (group level - 2) stands within this
     * radius of it (0 = off). Midgard L3 run 20261030-203443: two aggressive L5 sapherds inside a
     * dryad sprig camp and huldu lurkers around it, 21 deaths; dangers() let both through.
     */
    campClearance: number;
    /** Pull targets within this distance of the base. */
    huntRadius: number;
    /**
     * Place the base by planBase (baseplan.ts): next to the targets the tank can pull safely, every
     * formation slot and the walk to each target out of aggressive reach. Off: chooseBase with baseClearance.
     */
    basePlan: boolean;
    /**
     * Aggressive mobs at or below this con to the group are welcome walk-ins: the base plan doesn't keep
     * away from them and pulls don't avoid them (-3: only grey ones, which never aggro).
     */
    aggroTolerance: number;
    /** Base without basePlan: this far from every spawn, and twice that from aggressive ones near our level. */
    baseClearance: number;
    /** Pull only when every living member is at or above these (mana counts for casters only). */
    ready: { hp: number; mana: number };
    /** Members within this distance of the base count as present. */
    gatherRadius: number;
    /** A pulled monster this close to the base starts the fight. */
    engageRadius: number;
    /** Give up on a pull after this long. */
    pullTimeoutMs: number;
    /** Skip targets standing near aggressive monsters (aggro from the nearest spawn in static data). */
    avoidAggressive: boolean;
    /** ... counting an aggressive monster as near within its aggro range plus this. */
    aggroPad: number;
    /** ... and allowing this many of them (an add the mezzers can take). */
    maxAggroNeighbors: number;
    /**
     * No base: a few melee members hunt as one. The base is wherever the leader stands, a passive mob
     * is an engage for everyone at once (nobody waits, nobody is carried home), and they rest where
     * they finish. An aggressive mob is still pulled by the tank to where the others stand, away from its friends.
     */
    roam?: boolean;
    /** Pull aggressive monsters too (false: passive ones only; aggressive ones still get fought when they come). */
    pullAggressive: boolean;
    /**
     * Running away. Off by default: in PvE it almost never saves anyone (monsters run as
     * fast as an unsprinting player), and the group has crowd control and a tank to hold adds.
     */
    retreat: {
        enabled: boolean;
        /** Retreat when the tank drops below this while the focus has more than half its health. */
        tankHp: number;
        /** ... or this many adds (not the focus) are neither crowd-controlled nor assigned to a mezzer. */
        maxAdds: number;
        /** ... or this many members are dead. */
        deaths: number;
        /** How far to run from the attackers. */
        distance: number;
        /** Stop running after this long and fight. */
        maxMs: number;
    };
    /** Travel in legs of at most this length, regrouping at each. */
    travelLeg: number;
    /** Move the base inside the camp after this long without a target. */
    roamMs: number;
    /** Pick another camp after this long without a target. */
    newCampMs: number;
}

export const PVE_SETTINGS: PveSettings = {
    holdMs: 1500,
    assistAfterMs: 6000,
    // outOfCombat above ready.hp: healers top the group up instead of everyone sitting.
    heal: { tank: 70, other: 60, emergency: 35, outOfCombat: 90 },
    rest: { hp: 95, mana: 90 },
    // Limits, not a band to centre in: a fight at the anchor moves nobody (slots 550/900 back).
    // Session 2 recording: with bands, casters walked 1,200-1,400 across most close fights and nuked 5-9 s late.
    combatRange: { healer: [500, 1600], support: [500, 1600], nuker: [700, 1400] },
    slotSlack: 350,
    // The pulled mob ends up on the tank at the anchor: everyone else stands well out of its reach.
    formation: { tank: { back: 0, angle: 0 }, healer: { back: 550, angle: 0.45 }, support: { back: 550, angle: -0.45 }, nuker: { back: 900, angle: 0.3 }, melee: { back: 120, angle: 0.8 } },
    // Keep equal to engageRadius: a mob the coordinator doesn't carry home is fought where it stands, swinging.
    pullDistance: 700,
    buffMana: 40,
    aoe: false,
    meleeWhenOom: false,
    shedLoadAt: 95,
    keepItems: 'Bind Recall|Initiate|Staff of|Lute|Focus Staff|^task',
    tauntOpenMs: 6000,
    peelAfterMs: 4000,
    guard: { guard: 'healer', protect: 'nuker' },
    pet: PET_SETTINGS,
    minCon: -1,
    maxCon: 1,
    maxLevelAbove: 99,
    camp: null,
    campLevelBand: [-1, 2],
    campAggressiveWeight: 1,
    campClearance: 0,
    huntRadius: 2200,
    basePlan: false,
    aggroTolerance: -3,
    baseClearance: 700,
    ready: { hp: 80, mana: 50 },
    gatherRadius: 1200,
    engageRadius: 700,
    pullTimeoutMs: 30_000,
    avoidAggressive: true,
    aggroPad: 300,
    maxAggroNeighbors: 0,
    pullAggressive: true,
    retreat: { enabled: false, tankHp: 25, maxAdds: 3, deaths: 2, distance: 2500, maxMs: 25_000 },
    travelLeg: 1500,
    roamMs: 25_000,
    newCampMs: 120_000,
};

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ps: Point[]): Point => ({ x: ps.reduce((a, p) => a + p.x, 0) / Math.max(1, ps.length), y: ps.reduce((a, p) => a + p.y, 0) / Math.max(1, ps.length) });
/** The middle of each coordinate: one member 25000 off doesn't move it. */
const median = (ps: Point[]): Point => {
    const mid = (vs: number[]) => { const s = [...vs].sort((a, b) => a - b); const i = s.length >> 1; return s.length % 2 ? s[i]! : (s[i - 1]! + s[i]!) / 2; };
    return { x: mid(ps.map(p => p.x)), y: mid(ps.map(p => p.y)) };
};
const usesMana = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc || !!m.capabilities.pet;
const names = (ms: { name: string }[]) => ms.map(m => m.name).join(', ');
/** The highest aggressive mob level we pull or welcome: con up to aggroTolerance with pullAggressive, else none. */
const tolerated = (level: number, s: PveSettings) => {
    if (!s.pullAggressive) return Infinity;   // camp weighting as before: campAggressiveWeight alone
    let max = -1;
    for (let l = 0; l <= level + 10; l++) if (conLevel(level, l) <= s.aggroTolerance) max = l;
    return max;
};

/** A member this many gather radii from the group is one it could never wait for: a release far off, 25000 and 180000 live. */
const FAR_GATHER_RADII = 4;

/**
 * Who of `here` stands that far from the group's middle and from the tank. They don't steer the group or hold its gather, as a member in another region doesn't; holdFormation walks them back
 * all the same, and the reason names them. Never the tank, as nothing is pulled without him; and if it would leave nobody, there is no group to be far from.
 */
function farMembers(here: MemberReport[], tank: MemberReport | undefined, s: Pick<PveSettings, 'gatherRadius'>): MemberReport[] {
    const limit = s.gatherRadius * FAR_GATHER_RADII;
    const middle = median(here);
    const far = here.filter(m => m !== tank && dist(m, middle) > limit && (!tank || dist(m, tank) > limit));
    return far.length < here.length ? far : [];
}

const FAR_NOTE = /; [^;]* far off, not waited for$/;

/** Why a contact is not worth pulling, or null when it is. */
export function rejectPull(c: Contact, live: Contact[], opts: { base: Point; regionId: number; level: number; exclude: Set<number>; settings: PveSettings; plan?: BasePlan | null }): string | null {
    const s = opts.settings;
    if (c.kind !== 'npc' || c.stale || c.hp <= 0 || c.regionId !== opts.regionId) return 'gone';
    if (c.isPet) return 'pet';
    if (opts.exclude.has(c.objectId)) return 'failed pull';
    // On a member's pet it fights us, not someone else.
    if (c.targetId !== null && c.target === null && !c.targetPet) return 'fighting someone else';
    const con = conLevel(opts.level, c.level);
    if (con < s.minCon || con > s.maxCon) return `con ${con}`;
    if (c.level - opts.level > s.maxLevelAbove) return `${c.level - opts.level} levels above`;
    if (dist(c, opts.base) > s.huntRadius) return 'too far';
    const unsafe = opts.plan ? planRejects(opts.plan, c) : null;
    if (unsafe) return unsafe;
    if (aggroAt(opts.regionId, c.name, c) && (!s.pullAggressive || con > Math.max(-3, s.aggroTolerance))) return 'aggressive';
    if (!s.avoidAggressive) return null;
    if (dangerNear(opts.regionId, opts.level, c, 300)) return 'in a danger zone';
    // Roaming to a passive mob, nobody pulls: the whole group walks past whatever is on the way, so an
    // aggressive mob counts there even if it's one we'd pull. A wipe at level 13: a bear 1,862 away, past
    // trappers we could have pulled one by one, drew 4 adds. Those trappers are targets themselves, so they go first.
    const tolerated = s.roam && !aggroAt(opts.regionId, c.name, c) ? -3 : Math.max(-3, s.aggroTolerance);
    // The tank's walk out to it and back passes a live aggressive mob (those next to it count below).
    // Mobs that con grey to us never aggro (StandardMobBrain.CanAggroTarget), as in aggroZones and planBase.
    const onTheWay = live.find(o => {
        if (o.objectId === c.objectId || conLevel(opts.level, o.level) <= tolerated) return false;
        const a = aggroAt(opts.regionId, o.name, o);
        return !!a && dist(o, c) >= a.range + s.aggroPad && segDist(o, opts.base, c) < a.range + s.aggroPad;
    });
    if (onTheWay) return `aggressive on the way: ${onTheWay.name}`;
    const near = live.filter(o => {
        if (o.objectId === c.objectId || conLevel(opts.level, o.level) <= tolerated) return false;
        const a = aggroAt(opts.regionId, o.name, o);
        return !!a && dist(o, c) < a.range + s.aggroPad;
    });
    return near.length > s.maxAggroNeighbors ? `near aggressive ${near[0]!.name}` : null;
}

/** The best monster to pull: in the con window, near the base, not fighting someone else, away from aggressive mobs. */
export function pickPullTarget(contacts: Contact[], opts: { base: Point; regionId: number; level: number; exclude: Set<number>; settings: PveSettings; plan?: BasePlan | null }): { target: Contact | null; rejected: Record<string, number> } {
    // An enemy pet is no pull target or aggressive neighbour, and not worth a line in the reason.
    const live = contacts.filter(c => c.kind === 'npc' && !c.isPet && !c.stale && c.hp > 0 && c.regionId === opts.regionId);
    const rejected: Record<string, number> = {};
    const pool: Contact[] = [];
    for (const c of live) {
        const why = rejectPull(c, live, opts);
        if (!why) { pool.push(c); continue; }
        const key = why.replace(/^near aggressive .*/, 'near aggressive mobs').replace(/^(aggressive on the way|unsafe spawn).*/, '$1');
        rejected[key] = (rejected[key] ?? 0) + 1;
    }
    const con = (c: Contact) => conLevel(opts.level, c.level);
    const target = pool.sort((a, b) => (con(b) * 800 - dist(b, opts.base)) - (con(a) * 800 - dist(a, opts.base)))[0] ?? null;
    return { target, rejected };
}

/**
 * Who to focus among the attackers: what the tank is hitting, else whoever is on a non-tank, else the weakest.
 * An enemy pet only when nothing else is free to hit: killing it is worth nothing (GameNPC.cs:2731-2732).
 */
export function pickFocus(threats: Contact[], tank: MemberReport | undefined): Contact | null {
    const free = threats.filter(t => !t.cc);
    const mobs = free.filter(t => !t.isPet);
    const pool = mobs.length ? mobs : free.length ? free : threats;
    return (tank ? pool.find(t => t.objectId === tank.targetId) : undefined)
        ?? pool.filter(t => t.target !== tank?.name).sort((a, b) => a.hp - b.hp)[0]
        ?? [...pool].sort((a, b) => a.hp - b.hp)[0] ?? null;
}

/**
 * One mezzer per add, keeping assignments that still hold; supports first, then nukers, then healers. An NPC a mezz can't take (mezzRefuses) goes only to a member with a root (Capabilities.root), and crowdControl casts that at it.
 */
export function assignCc(adds: Contact[], members: MemberReport[], current: { targetId: number; by: string }[]): { targetId: number; by: string }[] {
    const order = ['support', 'nuker', 'healer', 'melee', 'tank'];
    const ccers = members.filter(m => !m.isDead && m.capabilities.cc).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
    const free = ccers.map(m => m.name);
    const rooters = new Set(ccers.filter(m => m.capabilities.root).map(m => m.name));
    const can = (t: Contact, name: string) => !mezzRefuses(t) || rooters.has(name);
    const out: { targetId: number; by: string }[] = [];
    for (const a of current) {
        const t = adds.find(c => c.objectId === a.targetId);
        if (t && can(t, a.by) && free.includes(a.by)) { out.push(a); free.splice(free.indexOf(a.by), 1); }
    }
    for (const t of adds) {
        if (out.some(a => a.targetId === t.objectId)) continue;
        const by = free.find(name => can(t, name));
        if (by === undefined) continue;
        out.push({ targetId: t.objectId, by });
        free.splice(free.indexOf(by), 1);
    }
    return out;
}

/** decide, with the far members in the reason (a reason carried over has them already). */
export function decidePve(ctx: CoordinatorContext<PveSettings>): OrdersUpdate {
    const u = decide(ctx);
    const alive = ctx.picture.members.filter(m => !m.isDead);
    const tank = alive.find(m => m.role === 'tank');
    const regionId = (tank ?? alive[0])?.regionId;
    const far = farMembers(alive.filter(m => m.regionId === regionId), tank, ctx.settings);
    const reason = u.reason.replace(FAR_NOTE, '');
    return { ...u, reason: far.length ? `${reason}; ${names(far)} far off, not waited for` : reason };
}

function decide(ctx: CoordinatorContext<PveSettings>): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, settings: s, now } = ctx;
    if (!p.members.length) return { phase: 'idle', reason: 'no member reports yet' };
    const alive = p.members.filter(m => !m.isDead);
    if (!alive.length) return { phase: 'recover', focus: null, cc: [], puller: null, reason: 'everyone is dead: releasing' };
    const tank = alive.find(m => m.role === 'tank');
    const leader = tank ?? alive[0]!;
    const regionId = leader.regionId;
    const level = Math.min(...alive.map(m => m.level));
    const here = alive.filter(m => m.regionId === regionId);
    const far = farMembers(here, tank, s);
    const near = here.filter(m => !far.includes(m));
    const centre = centroid(near);
    mem.exclude ??= new Set<number>();
    const threats = p.contacts.filter(c => c.threat && c.regionId === regionId);

    // ── Retreating: keep running until nothing follows or time is up ──
    if (o.phase === 'retreat') {
        const following = threats.filter(t => !t.cc && dist(t, centre) < 1500);
        if (following.length && now - (mem.retreatStart ?? now) < s.retreat.maxMs) return { phase: 'retreat', reason: o.reason };
    }

    // ── Fighting ──
    if (threats.length) {
        mem.idleSince = undefined;
        const kept = threats.find(t => t.objectId === o.focus && !t.cc);
        const focus = kept ?? pickFocus(threats, tank)!;
        // A body pull in progress: the puller brings the focus home before the fight starts.
        // On a member's pet it isn't coming: the fight starts where it stands. No branch comes back from that, so not on a reading a snapshot could still correct (readsOnPet).
        if (o.phase === 'pull' && o.anchor && kept && threats.length === 1 && (focus.target === o.puller || focus.target === null) && !readsOnPet(focus, now)
            && dist(focus, o.anchor) > s.engageRadius && now - (mem.pullStart ?? now) < s.pullTimeoutMs) {
            return { phase: 'pull', reason: `${o.puller} brings ${focus.name} to the base (${Math.round(dist(focus, o.anchor))} away)` };
        }
        // The focus is being killed, and an add with a mezz ordered on it gets one within a cast (2.5-3 s).
        const uncontrolled = threats.filter(t => !t.cc && t.objectId !== focus.objectId && !o.cc.some(a => a.targetId === t.objectId));
        const dead = p.members.length - alive.length;
        const lost = !s.retreat.enabled ? null
            : !tank && threats.some(t => t.hp > 50) ? 'the tank is dead'
            : uncontrolled.length >= s.retreat.maxAdds ? `${uncontrolled.length} adds not under control`
            : dead >= s.retreat.deaths ? `${dead} members dead`
            : tank && tank.hp < s.retreat.tankHp && focus.hp > 50 ? `tank at ${tank.hp}% with ${focus.name} at ${focus.hp}%`
            : null;
        if (lost && o.phase !== 'retreat') {
            mem.retreatStart = now;
            const from = centroid(threats);
            let dx = centre.x - from.x, dy = centre.y - from.y;
            const len = Math.hypot(dx, dy);
            if (len < 1) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
            const to = { ...keepOnMap(regionId, centre, { x: Math.round(centre.x + dx * s.retreat.distance), y: Math.round(centre.y + dy * s.retreat.distance) }), z: leader.z };
            return { phase: 'retreat', focus: null, cc: [], puller: null, retreatTo: to, reason: `retreat: ${lost}` };
        }
        if (lost && o.phase === 'retreat') return { phase: 'retreat', reason: o.reason };
        const cc = assignCc(threats.filter(t => t.objectId !== focus.objectId && !t.cc && !t.isPet && (t.ccImmuneUntil ?? 0) <= now), alive, o.cc);
        const why = kept ? `fighting ${focus.name} (${focus.hp}%)` : `${focus.name} L${focus.level} attacks ${focus.target ?? (focus.targetPet ? `${focus.targetPet}'s pet` : 'the group')}`;
        return { phase: 'engage', focus: focus.objectId, puller: null, cc, retreatTo: null, reason: threats.length > 1 ? `${why}, ${threats.length - 1} more attacking` : why };
    }

    // ── Roaming: everyone is on their way to a passive mob. It counts as the fight until it's dead or out of reach. ──
    if (s.roam && o.phase === 'engage' && o.focus !== null) {
        const c = p.contacts.find(x => x.objectId === o.focus);
        if (c && !c.stale && c.hp > 0 && now - (mem.pullStart ?? now) < s.pullTimeoutMs) return { phase: 'engage', reason: o.reason };
        if (c) mem.exclude.add(o.focus);
    }

    // ── Where to hunt ──
    // A level-up with no camp for the new level nearby keeps the current camp (the next town
    // visit moves the hub) instead of idling for the rest of the run.
    let found: Camp | null = null;
    if (!mem.camp || (!s.camp && mem.campLevel !== level) || (s.camp && (s.camp.x !== mem.camp.x || s.camp.y !== mem.camp.y))) {
        found = s.camp
            ? { ...s.camp, zone: '', count: 0, names: 'given camp' }
            : findCamp(regionId, leader, Math.max(0, level + s.campLevelBand[0]), level + s.campLevelBand[1], { avoid: mem.avoidCamps, aggressiveWeight: s.campAggressiveWeight, aggressiveMaxLevel: tolerated(level, s), clear: { radius: s.campClearance, level: level - 2 } });
        if (!found && !mem.camp) return { phase: 'idle', anchor: null, focus: null, reason: `no camp for level ${level} in region ${regionId}` };
        mem.campLevel = level;
    }
    if (found) {
        mem.camp = found;
        mem.heading = true;
        mem.plan = null;
        if (s.basePlan) {
            // A camp without a safe base (every spot in aggressive reach): try the next camps, else keep this one with chooseBase.
            const opts = { level, minCon: s.minCon, maxCon: s.maxCon, pullAggressive: s.pullAggressive, huntRadius: s.huntRadius, roles: p.members.map(m => m.role), formation: s.formation, avoid: mem.avoidCamps, tolerateCon: s.aggroTolerance };
            const tried: Point[] = [];
            for (let next: Camp | null = found; next && tried.length < 3; ) {
                mem.plan = planBase(regionId, next, opts);
                if (mem.plan) { mem.camp = next; break; }
                tried.push(next);
                next = s.camp ? null : findCamp(regionId, leader, Math.max(0, level + s.campLevelBand[0]), level + s.campLevelBand[1], { avoid: [...(mem.avoidCamps ?? []), ...tried], aggressiveWeight: s.campAggressiveWeight, aggressiveMaxLevel: tolerated(level, s), clear: { radius: s.campClearance, level: level - 2 } });
            }
        }
        mem.base = mem.plan?.base ?? chooseBase(regionId, level, mem.camp, leader, s.baseClearance);
        mem.facing = mem.plan?.facing ?? null;
        mem.route = null;
        mem.leg = null;
    }
    const camp: Camp = mem.camp;
    // Roaming: once they have reached a new camp, the base is where the leader stands, as long as they are together.
    if (s.roam) {
        if (near.every(m => dist(m, mem.base) < s.gatherRadius)) mem.heading = false;
        if (!mem.heading && near.every(m => dist(m, leader) < s.gatherRadius)) mem.base = { x: Math.round(leader.x), y: Math.round(leader.y), z: Math.round(leader.z) };
    }
    const base: Point3 = mem.base;
    const plan: BasePlan | null = mem.plan ?? null;
    const facing: Point = mem.facing ?? camp;
    const reach = plan?.targets.length ? `: ${plan.targets.length} targets ${plan.targets[0]!.d}-${plan.targets.at(-1)!.d} away` : '';
    const objective = `hunt ${camp.names || 'monsters'} (con ${s.minCon}..${s.maxCon}) from base (${base.x}, ${base.y})${reach}`;
    const calm = { focus: null, puller: null, cc: [], retreatTo: null, waiting: [], objective };

    // ── A pull in progress goes on (also when time is up: a mob already hit would follow us) ──
    if (o.phase === 'pull' && o.focus !== null) {
        const c = p.contacts.find(x => x.objectId === o.focus);
        if (c && !c.stale && c.hp > 0 && now - (mem.pullStart ?? now) < s.pullTimeoutMs) return { phase: 'pull', reason: o.reason };
        if (c) mem.exclude.add(o.focus);
    }

    if (ctx.windingDown) return { ...calm, phase: 'recover', anchor: base, facing, reason: 'time is up: no more pulls' };

    // ── Travel: most of the group is far from the base. Legs of travelLeg, regrouping at each (or after 30 s). ──
    const away = near.filter(m => dist(m, base) > s.gatherRadius);
    if (away.length * 2 > near.length) {
        const start = median(away);
        if (!mem.route) mem.route = safePath(regionId, level, start, base);
        // Arrived: everyone within the formation's depth of the leg (casters stand ~900 behind it).
        const legDone = !mem.leg || near.every(m => dist(m, mem.leg) < 1200) || now - mem.legAt > 30_000;
        if (legDone) {
            mem.legAt = now;
            // Chain legs from the last one (where the tank stands), not from the group's
            // centre: that trails the anchor by the formation's depth and never reaches a waypoint.
            const from: Point = mem.leg ?? start;
            while (mem.route.length > 1 && dist(from, mem.route[0]) < 300) mem.route.shift();
            const next: Point = mem.route[0] ?? base;
            const f = Math.min(1, s.travelLeg / Math.max(1, dist(from, next)));
            mem.leg = { ...keepOnMap(regionId, from, { x: Math.round(from.x + (next.x - from.x) * f), y: Math.round(from.y + (next.y - from.y) * f) }), z: base.z };
            mem.legFacing = next;
        }
        const journey = Math.round(dist(start, base));
        return { ...calm, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, journey, reason: `to the base, ${journey} away` };
    }
    mem.route = null;
    mem.leg = null;

    // ── Gather and recover ──
    if (away.length) return { ...calm, phase: 'gather', anchor: base, facing, waiting: away.map(m => ({ name: m.name, why: 'away' })), reason: `waiting for ${names(away)}` };
    const deadMembers = p.members.filter(m => m.isDead);
    if (deadMembers.length) return { ...calm, phase: 'recover', anchor: base, facing, waiting: deadMembers.map(m => ({ name: m.name, why: 'dead' })), reason: `waiting for ${names(deadMembers)} to release and come back` };
    const waiting = alive.flatMap(m => [
        ...(m.hp < s.ready.hp ? [{ name: m.name, why: 'health' }] : []),
        ...(usesMana(m) && m.mana < s.ready.mana ? [{ name: m.name, why: m.activity.detail === SAVING_POWER ? 'pet power' : 'power' }] : []),
        ...(waitsForPet(m, s.pet) ? [{ name: m.name, why: 'pet' }] : []),
    ]);
    if (waiting.length) return { ...calm, phase: 'recover', anchor: base, facing, waiting, reason: `waiting for ${waiting.map(w => `${w.name}'s ${w.why}`).join(', ')} (ready at ${s.ready.hp}% health, ${s.ready.mana}% power)` };

    // ── Pull ──
    if (!tank) return { ...calm, phase: 'recover', anchor: base, facing, reason: 'no living tank to pull' };
    const { target, rejected } = pickPullTarget(p.contacts, { base, regionId, level, exclude: mem.exclude, settings: s, plan });
    if (target) {
        mem.pullStart = now;
        mem.idleSince = undefined;
        if (s.roam && !aggroAt(regionId, target.name, target)) {
            return { ...calm, phase: 'engage', anchor: { x: Math.round(target.x), y: Math.round(target.y), z: Math.round(target.z) }, facing: target, focus: target.objectId, reason: `together on ${target.name} L${target.level} (con ${conLevel(level, target.level)}) ${Math.round(dist(target, base))} away` };
        }
        return { ...calm, phase: 'pull', anchor: base, facing, focus: target.objectId, puller: tank.name, reason: `pull ${target.name} L${target.level} (con ${conLevel(level, target.level)}) ${Math.round(dist(target, base))} away` };
    }

    // ── Nothing in reach: wander the camp, then try another ──
    mem.idleSince ??= now;
    if (now - mem.idleSince > s.newCampMs && !s.camp) {
        (mem.avoidCamps ??= []).push({ x: camp.x, y: camp.y }, ...(plan ? [{ x: base.x, y: base.y }] : []));
        mem.camp = null;
        mem.idleSince = undefined;
        return { ...calm, phase: 'idle', anchor: base, facing, reason: `nothing to pull at ${camp.names}: choosing another camp` };
    }
    // A planned base is already next to every safe target: wait there for respawns.
    if (!plan && now - (mem.roamAt ?? mem.idleSince) > s.roamMs) {
        mem.roamAt = now;
        const a = Math.random() * Math.PI * 2;
        // Farther than gatherRadius when roaming, or the base would come straight back to the leader.
        const out = s.roam ? s.gatherRadius + 800 : 900;
        mem.base = { ...keepOnMap(regionId, camp, { x: Math.round(camp.x + Math.cos(a) * out), y: Math.round(camp.y + Math.sin(a) * out) }), z: camp.z };
        mem.heading = true;
    }
    const seen = Object.entries(rejected).map(([k, v]) => `${v} ${k}`).join(', ');
    return { ...calm, phase: 'idle', anchor: mem.base, facing, reason: `no target in reach${seen ? ` (${seen})` : ''}` };
}

/**
 * decidePve pulls with a tank only, and no fallback puller stands in: that is a strategy's to decide. A group with no member in the role sits in recover ("no living tank to pull") with nothing else to say why,
 * and no Midgard pet class is a tank by its class (CLASS_ROLES). A dead tank is another matter, and so is a strategy of its own that pulled with someone else.
 */
function pveFindings(r: RunReport): Finding[] {
    const ms = Object.entries(r.members);
    if (!ms.length || ms.some(([, m]) => m.role === 'tank') || r.phases.pull) return [];
    const [, first] = ms.find(([, m]) => m.role === 'melee') ?? ms[0]!;
    return [{
        severity: 'high', topic: 'no-tank', issue: 'The group has no tank, so nothing is pulled',
        evidence: `${ms.map(([n, m]) => `${n} ${m.role}`).join(', ')}; phases ${Object.entries(r.phases).map(([k, v]) => `${k} ${v}%`).join(', ')}`,
        suggestion: `Give a member the role: "role": "tank" on its entry in group.json, or --role=${first.bot ?? '<bot>'}:tank when creating the group (bun groups/create-group.ts).`,
    }];
}

export const pveLeveling: GroupStrategy<PveSettings> = {
    name: 'pve-leveling',
    description: 'Camp from spawn data, body pulls to a base, focus fire, mezz adds, retreat when the fight is lost.',
    settings: PVE_SETTINGS,
    behaviors: defaultBehaviors(),
    decide: decidePve,
    findings: pveFindings,
};
