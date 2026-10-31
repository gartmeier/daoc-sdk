// PvE leveling: find a camp for the group's level, set up a base next to it,
// travel there together, rest until everyone is ready, let the tank body-pull
// one monster at a time, focus it, mezz adds, retreat when the fight is lost.
//
// decide() runs every coordinator tick on the shared picture. It only writes
// orders; members carry them out with their behaviour lists.

import { conLevel } from '../actions-helpers';
import { defaultBehaviors, type TacticsSettings } from './behaviors';
import type { CoordinatorContext, GroupStrategy } from './strategy';
import { aggroAt, chooseBase, dangerNear, findCamp, safePath, type Camp } from './terrain';
import type { Contact, MemberReport, OrdersUpdate, Point, Point3 } from './types';

export interface PveSettings extends TacticsSettings {
    /** Pull targets in this con window relative to the group's lowest level (-3 grey .. 3 purple). */
    minCon: number;
    maxCon: number;
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
    /** The base keeps this far from every spawn (a hit mob calls friends within 1050 for a group of five). */
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
    combatRange: { healer: [450, 1000], support: [450, 900], nuker: [900, 1400] },
    // The pulled mob ends up on the tank at the anchor: everyone else stands well out of its reach.
    formation: { tank: { back: 0, angle: 0 }, healer: { back: 550, angle: 0.45 }, support: { back: 550, angle: -0.45 }, nuker: { back: 900, angle: 0.3 }, melee: { back: 120, angle: 0.8 } },
    pullDistance: 450,
    buffMana: 40,
    aoe: false,
    meleeWhenOom: false,
    shedLoadAt: 95,
    keepItems: 'Bind Recall|Initiate|Staff of|Lute|Focus Staff|^task',
    tauntOpenMs: 6000,
    peelAfterMs: 4000,
    guard: { guard: 'healer', protect: 'nuker' },
    minCon: -1,
    maxCon: 1,
    camp: null,
    campLevelBand: [-1, 2],
    campAggressiveWeight: 1,
    campClearance: 0,
    huntRadius: 2200,
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
const usesMana = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc;
const names = (ms: { name: string }[]) => ms.map(m => m.name).join(', ');

/** Why a contact is not worth pulling, or null when it is. */
export function rejectPull(c: Contact, live: Contact[], opts: { base: Point; regionId: number; level: number; exclude: Set<number>; settings: PveSettings }): string | null {
    const s = opts.settings;
    if (c.kind !== 'npc' || c.stale || c.hp <= 0 || c.regionId !== opts.regionId) return 'gone';
    if (opts.exclude.has(c.objectId)) return 'failed pull';
    if (c.targetId !== null && c.target === null) return 'fighting someone else';
    const con = conLevel(opts.level, c.level);
    if (con < s.minCon || con > s.maxCon) return `con ${con}`;
    if (dist(c, opts.base) > s.huntRadius) return 'too far';
    if (!s.pullAggressive && aggroAt(opts.regionId, c.name, c)) return 'aggressive';
    if (!s.avoidAggressive) return null;
    if (dangerNear(opts.regionId, opts.level, c, 300)) return 'in a danger zone';
    const near = live.filter(o => {
        if (o.objectId === c.objectId) return false;
        const a = aggroAt(opts.regionId, o.name, o);
        return !!a && dist(o, c) < a.range + s.aggroPad;
    });
    return near.length > s.maxAggroNeighbors ? `near aggressive ${near[0]!.name}` : null;
}

/** The best monster to pull: in the con window, near the base, not fighting someone else, away from aggressive mobs. */
export function pickPullTarget(contacts: Contact[], opts: { base: Point; regionId: number; level: number; exclude: Set<number>; settings: PveSettings }): { target: Contact | null; rejected: Record<string, number> } {
    const live = contacts.filter(c => c.kind === 'npc' && !c.stale && c.hp > 0 && c.regionId === opts.regionId);
    const rejected: Record<string, number> = {};
    const pool: Contact[] = [];
    for (const c of live) {
        const why = rejectPull(c, live, opts);
        if (!why) { pool.push(c); continue; }
        const key = why.replace(/^near aggressive .*/, 'near aggressive mobs');
        rejected[key] = (rejected[key] ?? 0) + 1;
    }
    const con = (c: Contact) => conLevel(opts.level, c.level);
    const target = pool.sort((a, b) => (con(b) * 800 - dist(b, opts.base)) - (con(a) * 800 - dist(a, opts.base)))[0] ?? null;
    return { target, rejected };
}

/** Who to focus among the attackers: what the tank is hitting, else whoever is on a non-tank, else the weakest. */
export function pickFocus(threats: Contact[], tank: MemberReport | undefined): Contact | null {
    const free = threats.filter(t => !t.cc);
    const pool = free.length ? free : threats;
    return (tank ? pool.find(t => t.objectId === tank.targetId) : undefined)
        ?? pool.filter(t => t.target !== tank?.name).sort((a, b) => a.hp - b.hp)[0]
        ?? [...pool].sort((a, b) => a.hp - b.hp)[0] ?? null;
}

/** One mezzer per add, keeping assignments that still hold; supports first, then nukers, then healers. */
export function assignCc(adds: Contact[], members: MemberReport[], current: { targetId: number; by: string }[]): { targetId: number; by: string }[] {
    const order = ['support', 'nuker', 'healer', 'melee', 'tank'];
    const free = members.filter(m => !m.isDead && m.capabilities.cc).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)).map(m => m.name);
    const out: { targetId: number; by: string }[] = [];
    for (const a of current) {
        if (adds.some(t => t.objectId === a.targetId) && free.includes(a.by)) { out.push(a); free.splice(free.indexOf(a.by), 1); }
    }
    for (const t of adds) {
        if (!free.length) break;
        if (out.some(a => a.targetId === t.objectId)) continue;
        out.push({ targetId: t.objectId, by: free.shift()! });
    }
    return out;
}

export function decidePve(ctx: CoordinatorContext<PveSettings>): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, settings: s, now } = ctx;
    if (!p.members.length) return { phase: 'idle', reason: 'no member reports yet' };
    const alive = p.members.filter(m => !m.isDead);
    if (!alive.length) return { phase: 'recover', focus: null, cc: [], puller: null, reason: 'everyone is dead: releasing' };
    const tank = alive.find(m => m.role === 'tank');
    const leader = tank ?? alive[0]!;
    const regionId = leader.regionId;
    const level = Math.min(...alive.map(m => m.level));
    const here = alive.filter(m => m.regionId === regionId);
    const centre = centroid(here);
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
        if (o.phase === 'pull' && o.anchor && kept && threats.length === 1 && (focus.target === o.puller || focus.target === null)
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
            const to = { x: Math.round(centre.x + dx * s.retreat.distance), y: Math.round(centre.y + dy * s.retreat.distance), z: leader.z };
            return { phase: 'retreat', focus: null, cc: [], puller: null, retreatTo: to, reason: `retreat: ${lost}` };
        }
        if (lost && o.phase === 'retreat') return { phase: 'retreat', reason: o.reason };
        const cc = assignCc(threats.filter(t => t.objectId !== focus.objectId && !t.cc), alive, o.cc);
        const why = kept ? `fighting ${focus.name} (${focus.hp}%)` : `${focus.name} L${focus.level} attacks ${focus.target ?? 'the group'}`;
        return { phase: 'engage', focus: focus.objectId, puller: null, cc, retreatTo: null, reason: threats.length > 1 ? `${why}, ${threats.length - 1} more attacking` : why };
    }

    // ── Where to hunt ──
    // A level-up with no camp for the new level nearby keeps the current camp (the next town
    // visit moves the hub) instead of idling for the rest of the run.
    let found: Camp | null = null;
    if (!mem.camp || (!s.camp && mem.campLevel !== level)) {
        found = s.camp
            ? { ...s.camp, zone: '', count: 0, names: 'given camp' }
            : findCamp(regionId, leader, Math.max(0, level + s.campLevelBand[0]), level + s.campLevelBand[1], { avoid: mem.avoidCamps, aggressiveWeight: s.campAggressiveWeight, clear: { radius: s.campClearance, level: level - 2 } });
        if (!found && !mem.camp) return { phase: 'idle', anchor: null, focus: null, reason: `no camp for level ${level} in region ${regionId}` };
        mem.campLevel = level;
    }
    if (found) {
        mem.camp = found;
        mem.base = chooseBase(regionId, level, found, leader, s.baseClearance);
        mem.route = null;
        mem.leg = null;
    }
    const camp: Camp = mem.camp;
    const base: Point3 = mem.base;
    const objective = `hunt ${camp.names || 'monsters'} (con ${s.minCon}..${s.maxCon}) from base (${base.x}, ${base.y})`;
    const calm = { focus: null, puller: null, cc: [], retreatTo: null, waiting: [], objective };

    // ── A pull in progress goes on (also when time is up: a mob already hit would follow us) ──
    if (o.phase === 'pull' && o.focus !== null) {
        const c = p.contacts.find(x => x.objectId === o.focus);
        if (c && !c.stale && c.hp > 0 && now - (mem.pullStart ?? now) < s.pullTimeoutMs) return { phase: 'pull', reason: o.reason };
        if (c) mem.exclude.add(o.focus);
    }

    if (ctx.windingDown) return { ...calm, phase: 'recover', anchor: base, facing: camp, reason: 'time is up: no more pulls' };

    // ── Travel: most of the group is far from the base. Legs of travelLeg, regrouping at each (or after 30 s). ──
    const away = here.filter(m => dist(m, base) > s.gatherRadius);
    if (away.length * 2 > here.length) {
        if (!mem.route) mem.route = safePath(regionId, level, centroid(away), base);
        // Arrived: everyone within the formation's depth of the leg (casters stand ~900 behind it).
        const legDone = !mem.leg || here.every(m => dist(m, mem.leg) < 1200) || now - mem.legAt > 30_000;
        if (legDone) {
            mem.legAt = now;
            // Chain legs from the last one (where the tank stands), not from the group's
            // centre: that trails the anchor by the formation's depth and never reaches a waypoint.
            const from: Point = mem.leg ?? centroid(away);
            while (mem.route.length > 1 && dist(from, mem.route[0]) < 300) mem.route.shift();
            const next: Point = mem.route[0] ?? base;
            const f = Math.min(1, s.travelLeg / Math.max(1, dist(from, next)));
            mem.leg = { x: Math.round(from.x + (next.x - from.x) * f), y: Math.round(from.y + (next.y - from.y) * f), z: base.z };
            mem.legFacing = next;
        }
        return { ...calm, phase: 'travel', anchor: mem.leg, facing: mem.legFacing, reason: `to the base, ${Math.round(dist(centroid(away), base))} away` };
    }
    mem.route = null;
    mem.leg = null;

    // ── Gather and recover ──
    if (away.length) return { ...calm, phase: 'gather', anchor: base, facing: camp, waiting: away.map(m => ({ name: m.name, why: 'away' })), reason: `waiting for ${names(away)}` };
    const deadMembers = p.members.filter(m => m.isDead);
    if (deadMembers.length) return { ...calm, phase: 'recover', anchor: base, facing: camp, waiting: deadMembers.map(m => ({ name: m.name, why: 'dead' })), reason: `waiting for ${names(deadMembers)} to release and come back` };
    const waiting = alive.flatMap(m => [
        ...(m.hp < s.ready.hp ? [{ name: m.name, why: 'health' }] : []),
        ...(usesMana(m) && m.mana < s.ready.mana ? [{ name: m.name, why: 'power' }] : []),
    ]);
    if (waiting.length) return { ...calm, phase: 'recover', anchor: base, facing: camp, waiting, reason: `waiting for ${waiting.map(w => `${w.name}'s ${w.why}`).join(', ')} (ready at ${s.ready.hp}% health, ${s.ready.mana}% power)` };

    // ── Pull ──
    if (!tank) return { ...calm, phase: 'recover', anchor: base, facing: camp, reason: 'no living tank to pull' };
    const { target, rejected } = pickPullTarget(p.contacts, { base, regionId, level, exclude: mem.exclude, settings: s });
    if (target) {
        mem.pullStart = now;
        mem.idleSince = undefined;
        return { ...calm, phase: 'pull', anchor: base, facing: camp, focus: target.objectId, puller: tank.name, reason: `pull ${target.name} L${target.level} (con ${conLevel(level, target.level)})` };
    }

    // ── Nothing in reach: wander the camp, then try another ──
    mem.idleSince ??= now;
    if (now - mem.idleSince > s.newCampMs && !s.camp) {
        (mem.avoidCamps ??= []).push({ x: camp.x, y: camp.y });
        mem.camp = null;
        mem.idleSince = undefined;
        return { ...calm, phase: 'idle', anchor: base, facing: camp, reason: `nothing to pull at ${camp.names}: choosing another camp` };
    }
    if (now - (mem.roamAt ?? mem.idleSince) > s.roamMs) {
        mem.roamAt = now;
        const a = Math.random() * Math.PI * 2;
        mem.base = { x: Math.round(camp.x + Math.cos(a) * 900), y: Math.round(camp.y + Math.sin(a) * 900), z: camp.z };
    }
    const seen = Object.entries(rejected).map(([k, v]) => `${v} ${k}`).join(', ');
    return { ...calm, phase: 'idle', anchor: mem.base, facing: camp, reason: `no target in reach${seen ? ` (${seen})` : ''}` };
}

export const pveLeveling: GroupStrategy<PveSettings> = {
    name: 'pve-leveling',
    description: 'Camp from spawn data, body pulls to a base, focus fire, mezz adds, retreat when the fight is lost.',
    settings: PVE_SETTINGS,
    behaviors: defaultBehaviors(),
    decide: decidePve,
};
