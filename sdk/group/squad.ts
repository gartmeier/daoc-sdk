// Small squads: a solo, a duo or a trio roaming a battleground through the same coordinator as a group. They play by
// the RvR roaming rules (rvr.ts decideRvr: the focus, crowd control, anchors, legs, regrouping), with three of their own
// on top, as small-man players in Thidranki do:
//
//  - Picking fights (sizeUp): a fight is taken only with enough expected strength. Ours from our members' role, health
//    and power; theirs from each enemy's role by its class read (Contact.classGuess, else its deeds: the healer and caster
//    flags), health and level, never from who it is. Both sides by Lanchester's square law (strength × count): two
//    against one is four to one, which is how a solo loses to a duo. Enemies busy with a third realm count less.
//  - Leaving (flee): in a fight that turned (the ratio below leaveAt), the squad runs: toward a friendly group of our
//    realm when one is near and not behind the enemy, else toward our portal keep (its guards fight for us), else
//    straight away. A lone melee already on us (a stealther's opener) is fought out unless safety is near: it runs as
//    fast as we do. After fleeMaxMs still followed, caught: fight it out.
//  - Roaming the edges (edgePatrol): the roads to the enemy portal keeps, where their released walk back alone, and the
//    banks where two realms meet (BattlegroundLayout.pairs), away from the groups' meeting point.
//
// Enemies we would not fight are hidden from the inner decide (no hunt, no engage) unless they attack us, and the squad
// steps away from them when they come near. The inner decide never sees a retreat: retreat.enabled is off for it, so
// every retreat is this file's flee.
//
// Orders' reasons start with "flee:", "caught:" or "avoid:" for the ledger (groups/field.ts): a fight with a retreat
// phase whose reason starts with "flee:" was fled.

import { estimateZ } from '../../data/index';
import type { Realm } from '../types';
import { untouchable } from './blackboard';
import type { FoeRole } from './class-read';
import { BATTLEGROUND_LAYOUTS, clearOf, homeOf, keepDangers, type PlayerRealm } from './keeps';
import { decideRvr, legAnchor, realmOfGroup, RVR_SETTINGS, runWay, rvrRoaming, spotAlong, stepLeg, type RvrSettings, type Trip } from './rvr';
import { isLevel } from './slope';
import { defineStrategy, type CoordinatorContext, type GroupStrategy } from './strategy';
import { aggroZones } from './terrain';
import { isDry, staysDry } from './water';
import type { Contact, MemberReport, OrdersUpdate, Point, Point3, Role } from './types';

export interface SquadRules {
    /** Take a fight (engage, hunt) only at this strength ratio or better: ours / theirs. 1 is an even fight. */
    engageAt: number;
    /** In a fight, leave it below this ratio. Between the two the fight goes on. */
    leaveAt: number;
    /** Enemies within this of our centre are the fight we would take; beyond it, those we would hunt. */
    sizeUp: number;
    /** An enemy within this of a counted one comes with it. */
    joinRadius: number;
    /** Still followed after this long: caught, fight it out. */
    fleeMaxMs: number;
    /** A flee ends when nobody against us is within engageRadius for this long. */
    shakenMs: number;
    /** Enemies we left or would not take are left alone (no hunt) this long, unless they attack us. */
    avoidMs: number;
    /** Run toward friends only when they are at most this far ... */
    friendMax: number;
    /** ... and are safety once within this. */
    friendReach: number;
    /** Our portal keep's guards (2000 round it) are safety within this of its centre. */
    keepReach: number;
    /** A lone melee on us is outrun only when safety is at most this far. */
    outrunMax: number;
    /** Patrol the edges (edgePatrol); off: the groups' ring round the meeting point. */
    edge: boolean;
    /** Which lane first (edgePatrol): squads of one realm with different variants start on different enemies' sides. */
    variant: number;
}

export interface SquadSettings extends RvrSettings {
    squad: SquadRules;
}

export const SQUAD_RULES: SquadRules = {
    engageAt: 0.9,
    leaveAt: 0.55,
    sizeUp: 3500,
    joinRadius: 1500,
    fleeMaxMs: 45_000,
    shakenMs: 6000,
    avoidMs: 60_000,
    friendMax: 9000,
    friendReach: 1200,
    keepReach: 2500,
    outrunMax: 5000,
    edge: true,
    variant: 0,
};

export const SQUAD_SETTINGS: SquadSettings = {
    ...RVR_SETTINGS,
    // A squad is no group to wait for: hunt and engage nearer, and set out again sooner.
    engageRadius: 2000,
    huntRadius: 4000,
    gatherRadius: 2000,
    ready: { hp: 70, mana: 40 },
    squad: SQUAD_RULES,
};

// ── Strength ──────────────────────────────────────────────────────────────────────────────────────────────────────

const OUR_ROLE: Record<Role, number> = { tank: 0.9, melee: 1, healer: 0.8, support: 1, nuker: 1 };
/** A mezzer or a caster beats a lone fighter more often than not; a tank deals little. */
const FOE_ROLE: Record<FoeRole, number> = { healer: 0.9, caster: 1.1, cc: 1.2, tank: 0.9, melee: 1, support: 1 };
/** A healer standing with others keeps them up: every other one of its side counts this much more. */
const HEALER_BACKING = 1.25;
/** An enemy fighting a third realm (not us) counts this much. */
const BUSY = 0.6;
/** Per level of difference, a member or an enemy counts this much more or less (clamped). */
const PER_LEVEL = 0.08;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ps: readonly Point[]): Point => ({ x: ps.reduce((a, p) => a + p.x, 0) / Math.max(1, ps.length), y: ps.reduce((a, p) => a + p.y, 0) / Math.max(1, ps.length) });
const usesMana = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc || !!m.capabilities.pet;
const onWhom = (c: Contact): string | null => c.target ?? c.targetPet ?? null;
const unit = (a: Point, b: Point): Point => { const d = Math.max(1, dist(a, b)); return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; };
const health = (hp: number) => Math.max(0.1, clamp(hp, 0, 100) / 100);

/** One member's worth: its role, health, and power for those that cast. */
export function memberWorth(m: MemberReport): number {
    if (m.isDead) return 0;
    const power = !usesMana(m) ? 1 : m.mana < 10 ? 0.3 : m.mana < 30 ? 0.7 : 1;
    return (OUR_ROLE[m.role] ?? 1) * health(m.hp) * power;
}

/** An enemy's role as we can tell it: the class read when settled, else its deeds, else unknown (null). */
export function foeRole(c: Contact): FoeRole | null {
    return c.classGuess?.role ?? (c.healer ? 'healer' : c.caster ? 'caster' : null);
}

/** One enemy's worth against a side of level `ours`: its role (unknown counts as a fighter), health and level. */
export function foeWorth(c: Contact, ours: number): number {
    const role = foeRole(c);
    const lv = clamp(1 + PER_LEVEL * ((c.level || ours) - ours), 0.6, 1.5);
    return (role ? FOE_ROLE[role] : 1) * health(c.hp) * lv * (c.isPet ? 0.4 : 1);
}

/** A side's strength from its worths: the sum, backed by a healer, times how many (Lanchester's square law). */
export function sideStrength(worths: readonly number[], healers: number): number {
    const n = worths.filter(w => w > 0).length;
    if (!n) return 0;
    const sum = worths.reduce((a, w) => a + w, 0);
    const backed = healers > 0 && n > 1 ? sum * HEALER_BACKING : sum;
    return backed * n;
}

export interface SizeUp {
    /** The enemies the fight is with (or would be): players and pets. */
    foes: Contact[];
    ours: number;
    theirs: number;
    /** ours / theirs; Infinity with nobody against us. */
    ratio: number;
}

/**
 * The fight in front of us: the enemies against us near the centre (within sizeUp, else within huntRadius), the
 * largest realm among them plus any on us, and those within joinRadius of them; and both sides' strength.
 */
export function sizeUp(members: readonly MemberReport[], enemies: readonly Contact[], centre: Point, s: Pick<SquadSettings, 'huntRadius' | 'squad'>): SizeUp {
    const ours = new Set(members.map(m => m.name));
    const onUs = (c: Contact) => { const n = onWhom(c); return n !== null && ours.has(n); };
    const byId = new Map(enemies.map(c => [c.objectId, c]));
    const busy = (c: Contact) => !onUs(c) && c.targetId !== null && byId.has(c.targetId) && byId.get(c.targetId)!.realm !== c.realm;
    const against = (cs: readonly Contact[]): Contact[] => {
        const realms = [...new Set(cs.map(c => c.realm))];
        return realms.map(r => cs.filter(c => c.realm === r || onUs(c))).sort((a, b) => b.length - a.length)[0] ?? [];
    };
    const near = enemies.filter(c => dist(c, centre) <= s.squad.sizeUp || onUs(c));
    const core = against(near.length ? near : enemies.filter(c => dist(c, centre) <= s.huntRadius));
    const foes = [...core];
    for (const c of enemies) if (!foes.includes(c) && c.realm === core[0]?.realm && foes.some(f => dist(f, c) <= s.squad.joinRadius)) foes.push(c);
    const alive = members.filter(m => !m.isDead);
    const level = alive.length ? alive.reduce((a, m) => a + m.level, 0) / alive.length : 1;
    const ourWorth = alive.map(m => memberWorth(m) * clamp(1 + PER_LEVEL * (m.level - level), 0.6, 1.5));
    const ourHealers = alive.filter(m => m.role === 'healer' || m.capabilities.heal).length;
    const theirWorth = foes.map(c => foeWorth(c, level) * (busy(c) ? BUSY : 1));
    const theirHealers = foes.filter(c => !c.isPet && foeRole(c) === 'healer').length;
    const a = sideStrength(ourWorth, ourHealers), b = sideStrength(theirWorth, theirHealers);
    return { foes, ours: a, theirs: b, ratio: b > 0 ? a / b : Infinity };
}

// ── Roaming the edges ─────────────────────────────────────────────────────────────────────────────────────────────

/** How far along each realm's road from the meeting point to its arrival a lane's road point lies. */
const ROAD_AT = 0.55;
/** Lane waypoints stay at least this far from the meeting point, where the groups ring (5500) and fight. */
const MEET_CLEAR = 6500;
const LANE_MARGIN = 900;
/** Where an unsafe lane waypoint is tried next: offsets in units, nearest first. */
const LANE_NUDGES: [number, number][] = [[0, 0], ...[600, 1200, 1800, 2400, 3000].flatMap(r => [0, 1, 2, 3, 4, 5, 6, 7].map(k => [Math.round(r * Math.cos(k * Math.PI / 4)), Math.round(r * Math.sin(k * Math.PI / 4))] as [number, number]))];

/**
 * A squad's loop: from our own road out to each enemy's lane and back. A lane is the bank where we meet that realm
 * (BattlegroundLayout.pairs) and that realm's road toward its portal keep (ROAD_AT of the way from the meeting point),
 * where its released walk back alone. Loop: our road, lane 1's bank, its road, its bank again, our road, lane 2 likewise.
 * An odd `variant` starts on the second enemy's lane. Each point is nudged out of camps, keep circles (ours aside), water
 * (stayDry), steep ground and the meeting point's ring; a point with no safe spot near is dropped. Empty outside a known battleground.
 */
export function edgePatrol(regionId: number, realm: Realm, level: number, settings: Partial<Pick<SquadSettings, 'keepClearance' | 'keepOwners' | 'stayDry'>> = {}, variant = 0): Point3[] {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    if (!bg || realm === 'none' || !bg.pairs) return [];
    const me = realm as PlayerRealm;
    const others = (['albion', 'midgard', 'hibernia'] as PlayerRealm[]).filter(r => r !== me);
    const lanes = variant % 2 ? [others[1]!, others[0]!] : others;
    const camps = aggroZones(regionId, level), keeps = keepDangers(regionId, realm, settings);
    const dry = staysDry(settings);
    const road = (r: PlayerRealm): Point => ({ x: bg.meet.x + ROAD_AT * (bg.arrival[r].x - bg.meet.x), y: bg.meet.y + ROAD_AT * (bg.arrival[r].y - bg.meet.y) });
    const bank = (r: PlayerRealm): Point | null => bg.pairs![[me, r].sort().join('|')] ?? null;
    const safe = (p: Point) => dist(p, bg.meet) >= MEET_CLEAR && clearOf(p, camps, LANE_MARGIN) && clearOf(p, keeps, LANE_MARGIN) && (!dry || isDry(regionId, p)) && isLevel(regionId, p);
    const settle = (p: Point | null): Point3 | null => {
        if (!p) return null;
        const spot = LANE_NUDGES.map(([dx, dy]) => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) })).find(safe);
        return spot ? { ...spot, z: estimateZ(regionId, spot.x, spot.y, bg.meet.z, { radius: 8000 }) } : null;
    };
    const ownRoad = settle(road(me));
    const out: Point3[] = [];
    for (const r of lanes) {
        const b = settle(bank(r)), q = settle(road(r));
        for (const p of [ownRoad, b, q, b]) if (p && !(out.length && dist(out.at(-1)!, p) < 1)) out.push(p);
    }
    while (out.length > 1 && dist(out[0]!, out.at(-1)!) < 1) out.pop();
    return out;
}

// ── The decide ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the squad remembers across ticks (memory.squad). */
interface SquadMemory {
    /** Enemy ids left alone until (ms epoch). */
    avoid: Record<number, number>;
    flee: { start: number; lastFollowed: number; to: Point3; toward: 'friends' | 'home' | 'away'; target: Point | null } | null;
    /** Caught: fight it out until nobody is against us. */
    stand: boolean;
    /** Counts for the run's report: fights left, fights fought out after being caught, groups stepped away from. */
    fled: number;
    caught: number;
    avoided: number;
    patrolKey?: string;
}

export interface SquadOptions {
    /** Where friendly players of our realm stand (not this squad): groups to run to. Read each tick; none by default. */
    friends?: () => readonly Point[];
}

/** The squad's decide around `inner` (decideRvr by default, or a realm's own wrapper of it). */
export function squadDecide(inner: (ctx: CoordinatorContext<any>) => OrdersUpdate = decideRvr, opts: SquadOptions = {}): (ctx: CoordinatorContext<SquadSettings>) => OrdersUpdate {
    return ctx => decideSquad(ctx, inner, opts);
}

export function decideSquad(ctx: CoordinatorContext<SquadSettings>, inner: (ctx: CoordinatorContext<any>) => OrdersUpdate = decideRvr, opts: SquadOptions = {}): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, now } = ctx;
    const s: SquadSettings = { ...ctx.settings, squad: { ...SQUAD_RULES, ...ctx.settings.squad } };
    const r = s.squad;
    const sq: SquadMemory = mem.squad ??= { avoid: {}, flee: null, stand: false, fled: 0, caught: 0, avoided: 0 };
    for (const [id, until] of Object.entries(sq.avoid)) if (until <= now) delete sq.avoid[+id];

    const alive = p.members.filter(m => !m.isDead);
    // The inner decide never sees a retreat: every retreat is ours (retreat.enabled is off for it).
    const innerOrders = o.phase === 'retreat' ? { ...o, phase: 'travel' as const, retreatTo: null } : o;
    const innerSettings: RvrSettings = { ...s, retreat: { ...s.retreat, enabled: false } };
    if (!mem.realm || mem.realm === 'none') mem.realm = realmOfGroup(p.members);
    const realm: Realm = mem.realm;
    const regionId = alive[0]?.regionId ?? p.members[0]?.regionId ?? 0;
    // The edge loop, once per region, realm and level (unless the run set a patrol of its own).
    if (r.edge && !s.patrol && alive.length) {
        const level = Math.min(...alive.map(m => m.level));
        const key = `${regionId}:${realm}:${level}:${r.variant}`;
        if (sq.patrolKey !== key) { mem.squadPatrol = edgePatrol(regionId, realm, level, s, r.variant); sq.patrolKey = key; }
        if (mem.squadPatrol?.length) innerSettings.patrol = mem.squadPatrol;
    }
    const callInner = (contacts: Contact[]) => inner({ ...ctx, picture: { ...p, contacts }, orders: innerOrders, settings: innerSettings });
    if (!alive.length || ctx.windingDown && o.phase !== 'retreat') { sq.flee = null; return callInner(p.contacts); }

    const here = alive.filter(m => m.regionId === regionId);
    const centre = centroid(here);
    const ours = new Set(p.members.map(m => m.name));
    const onUs = (c: Contact) => { const n = onWhom(c); return n !== null && ours.has(n); };
    const nearOnUs = (c: Contact) => onUs(c) && dist(c, centre) <= s.engageRadius + 1000;
    const enemies = p.contacts.filter(c => (c.kind === 'player' || (c.isPet && c.threat)) && !c.stale && c.hp > 0 && c.regionId === regionId && !untouchable(c, now));
    const home = homeOf(regionId, realm);
    const keeps = keepDangers(regionId, realm, s);
    const zAt = (q: Point) => estimateZ(regionId, q.x, q.y, here[0]?.z ?? 0, { radius: 8000 });
    const trip: Trip = { mem, now, regionId, level: Math.min(...here.map(m => m.level)), avoid: keeps, travelLeg: s.travelLeg, zAt, dry: staysDry(s) };
    const ourInKeepReach = !!home && dist(centre, home.keep) <= r.keepReach;
    const friends = (opts.friends?.() ?? []).filter(f => dist(f, centre) <= r.friendMax);
    const nearestFriend = friends.reduce<Point | null>((best, f) => (!best || dist(f, centre) < dist(best, centre) ? f : best), null);
    const atFriends = !!nearestFriend && dist(nearestFriend, centre) <= r.friendReach;

    const up = sizeUp(here, enemies, centre, s);
    // Attacked: one on us near (the board keeps a runner's last target, so not at any range), or in combat with one beside us.
    const hit = up.foes.some(nearOnUs) || here.some(m => m.inCombat && up.foes.some(c => dist(c, m) < 400));
    const engaged = o.phase === 'engage';
    const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '∞');
    const odds = `${fmt(up.ratio)} (${here.length} vs ${up.foes.length})`;

    /** Where to run: toward friends near and not behind the enemy, else home (or straight away when they stand that way). */
    const fleeTarget = (): { way: Point; toward: 'friends' | 'home' | 'away'; target: Point | null } => {
        const them = centroid(up.foes.length ? up.foes : enemies);
        if (nearestFriend) {
            const toF = unit(centre, nearestFriend), toE = unit(centre, them);
            // Not when the enemy stands within 60° of that way (they are between us and them).
            if (toF.x * toE.x + toF.y * toE.y < 0.5) return { way: toF, toward: 'friends', target: nearestFriend };
        }
        const way = runWay(centre, [them], home?.arrival ?? null);
        return { way, toward: way.home ? 'home' : 'away', target: way.home && home ? home.arrival : null };
    };
    /** The next spot on the run: a leg of retreat.distance (at most to the target), round camps and keep circles. */
    const nextSpot = (f: NonNullable<SquadMemory['flee']>): Point3 => {
        const way = f.target ? unit(centre, f.target) : fleeTarget().way;
        const left = f.target ? dist(centre, f.target) : s.retreat.distance;
        return spotAlong(trip, centre, way, Math.min(s.retreat.distance, Math.max(600, left)));
    };
    const fleeOrder = (why: string): OrdersUpdate => {
        const f = sq.flee!;
        if (dist(centre, f.to) < 600) f.to = nextSpot(f);
        const where = f.toward === 'friends' ? 'friends' : f.toward === 'home' ? 'our portal keep' : 'open ground';
        return { phase: 'retreat', focus: null, puller: null, cc: [], waiting: [], retreatTo: f.to, anchor: f.to, objective: `get away from ${up.foes.length || 'the'} enemies toward ${where}`, reason: `flee: ${why}` };
    };

    // ── Fleeing: on toward safety while they follow ──
    if (sq.flee) {
        // One that still has us as its last target counts only within the focus slack: the board keeps a runner's target.
        const following = up.foes.filter(c => dist(c, centre) <= s.engageRadius || (onUs(c) && dist(c, centre) <= s.engageRadius + 1000));
        if (following.length) sq.flee.lastFollowed = now;
        const safe = atFriends || ourInKeepReach;
        if (safe || now - sq.flee.lastFollowed >= r.shakenMs) {
            for (const c of up.foes) sq.avoid[c.objectId] = now + r.avoidMs;
            sq.flee = null;
            // At safety with them on us: fight there, beside our friends or under our guards.
            if (safe && following.length) sq.stand = true;
        } else if (now - sq.flee.start >= r.fleeMaxMs) {
            sq.flee = null;
            sq.stand = true;
            sq.caught++;
        } else return fleeOrder(`${following.length} following, odds ${odds}`);
    }
    if (sq.stand && !up.foes.some(c => onUs(c) || dist(c, centre) <= s.engageRadius)) sq.stand = false;

    // ── In a fight that turned: leave it ──
    if ((engaged || hit) && up.foes.length && !sq.stand && up.ratio < r.leaveAt) {
        const focus = engaged && o.focus !== null ? up.foes.find(c => c.objectId === o.focus) : undefined;
        const finishing = !!focus && focus.hp < s.retreat.focusHp && up.ratio >= r.leaveAt / 2;
        // A lone melee on us runs as fast as we do: only worth running from with safety near.
        const lone = up.foes.filter(c => !c.isPet);
        const melee = lone.length === 1 && onUs(lone[0]!) && dist(lone[0]!, centre) < 500 && !['caster', 'cc', 'healer'].includes(foeRole(lone[0]!) ?? '');
        const safetyNear = (nearestFriend && dist(nearestFriend, centre) <= r.outrunMax) || (home && dist(centre, home.keep) <= r.outrunMax);
        if (!finishing && !(melee && !safetyNear) && !atFriends && !ourInKeepReach) {
            const t = fleeTarget();
            sq.flee = { start: now, lastFollowed: now, to: { x: Math.round(centre.x), y: Math.round(centre.y), z: zAt(centre) }, toward: t.toward, target: t.target };
            sq.fled++;
            return fleeOrder(`odds ${odds} below ${r.leaveAt}`);
        }
    }

    // ── Not fighting: enemies we would not take are left alone, and stepped away from when near ──
    if (!engaged && !hit && !sq.stand && up.foes.length && up.ratio < r.engageAt) {
        if (!up.foes.every(c => (sq.avoid[c.objectId] ?? 0) > now)) sq.avoided++;
        for (const c of up.foes) sq.avoid[c.objectId] = now + r.avoidMs;
        const nearest = Math.min(...up.foes.map(c => dist(c, centre)));
        if (nearest <= r.sizeUp) {
            const way = runWay(centre, up.foes, home?.arrival ?? null);
            const goal = spotAlong(trip, centre, way, r.sizeUp);
            stepLeg(trip, 'avoid', goal, { from: centre, movers: here, replan: 1500 });
            return { phase: 'travel', focus: null, puller: null, cc: [], retreatTo: null, waiting: [], anchor: legAnchor(mem), facing: mem.legFacing, objective: `keep clear of ${up.foes.length} enemies`, reason: `avoid: odds ${odds} below ${r.engageAt}, nearest ${Math.round(nearest)} away` };
        }
    }
    const hidden = new Set(Object.keys(sq.avoid).map(Number));
    // A fight we are in (taken, caught, or they attack us) shows everyone: the avoided ones too.
    const showAll = sq.stand || hit || engaged;
    const contacts = showAll ? p.contacts : p.contacts.filter(c => !hidden.has(c.objectId) || nearOnUs(c));
    const u = callInner(contacts);
    return sq.stand && u.phase === 'engage' ? { ...u, reason: `caught: ${u.reason ?? ''}` } : u;
}

/** The shared small-squad strategy: rvrRoaming's behaviours, with the squad's decide and settings. */
export const squadRoaming: GroupStrategy<SquadSettings> = defineStrategy(rvrRoaming as unknown as GroupStrategy<SquadSettings>, {
    name: 'squad-roam',
    description: 'Small squads (1-3): roam the edges (roads to the enemy portal keeps, the banks where realms meet), take only fights the odds favour, run toward friends or our portal keep from those that turn.',
    settings: SQUAD_SETTINGS as any,
    decide: squadDecide(),
});

/** squadRoaming with a decide of its own (friends to run to, or a realm's inner decide). */
export function squadStrategy(o: SquadOptions & { inner?: (ctx: CoordinatorContext<any>) => OrdersUpdate; name?: string } = {}): GroupStrategy<SquadSettings> {
    return defineStrategy(squadRoaming, { name: o.name ?? squadRoaming.name, decide: squadDecide(o.inner, o) });
}
