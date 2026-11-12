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
import { roleOfClass, type FoeRole } from './class-read';
import { BATTLEGROUND_LAYOUTS, clearOf, homeOf, keepDangers, type PlayerRealm } from './keeps';
import { decideRvr, legAnchor, mainBody, realmOfGroup, RVR_SETTINGS, runWay, rvrRoaming, spotAlong, stepLeg, type RvrSettings, type Trip } from './rvr';
import { isLevel } from './slope';
import { defineStrategy, type CoordinatorContext, type GroupStrategy } from './strategy';
import { aggroZones, type Danger } from './terrain';
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
    /** A group we would not take, and would leave if in it (odds below leaveAt), that comes this near runs us off (a flee, which sprints), not a walk away. */
    runAt: number;
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
    // 1500 until run B 09:10: a duo standing 2000 apart (gatherRadius) read as two lone enemies, and Mordred took each in turn and fled from both.
    joinRadius: 2500,
    fleeMaxMs: 45_000,
    shakenMs: 6000,
    avoidMs: 60_000,
    friendMax: 9000,
    friendReach: 1200,
    keepReach: 2500,
    runAt: 2000,
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
/**
 * A stealther out of combat is hidden (its kit hides it: sdk/classes/stealther.ts) and opens from stealth: about 200 damage
 * and a stun or bleed on the first swing, before the other side's defences are up (N5, 2026-11-11). It counts this much more
 * when the squad decides whether to start a fight, not once in it.
 */
const OPENER = 1.4;
const STEALTHERS = new Set(['Infiltrator', 'Nightshade', 'Shadowblade']);
/** An enemy that killed one of ours in the last GRUDGE_MS counts this much more when deciding to start a fight with it: the duo that beat us twice is no even fight the third time. */
const GRUDGE = 1.5;
const GRUDGE_MS = 10 * 60_000;
/** Enemies in a group we would not take stay hidden this long after it is last judged so: the judgement flickers as they move. */
const SHUN_MS = 10_000;
/** Once stepping away, on until the nearest of them is this much beyond sizeUp. */
const CLEAR_SLACK = 1000;
/**
 * Where we last saw a group we would not take, or ran from, is kept clear of this long: the patrol skips waypoints in it and
 * goes round it, rather than back on the same line (the user, run B 08:40: Hibernia's duo stepped clear of Albion's group,
 * patrolled straight back into it, again and again).
 */
const ZONE_MS = 4 * 60_000;
/** A zone's radius: the group's spread plus this, at least ZONE_MIN. */
const ZONE_PAD = 2000, ZONE_MIN = 3000;
/** A sighting within this of a zone moves that zone, not a new one. */
const ZONE_MERGE = 3000;
/** An enemy pet counts this much of a head in Lanchester's count (its worth is already 0.4 of a player's). */
const PET_HEAD = 0.4;
/** Per level of difference, a member or an enemy counts this much more or less (clamped). */
const PER_LEVEL = 0.08;
/**
 * A friendly group (two or more of our realm, not this squad) within this of the enemies, or of us, is in the fight: its
 * players count on our side. Run B 09:53 (N5): Diarmuid, a solo Ranger, read "1 vs 3", then "1 vs 5", and patrolled away from
 * Hibernia's own group fighting those five 3-4k off, where a human archer would have joined and shot from range.
 */
const ASSIST = 2000;
/** A friend's worth beside ours: not under our orders, and gone when its group moves on. */
const ALLY = 0.8;
/**
 * Only a friend in combat joins the count; once counted it stays counted this long, out to ASSIST + ALLY_SLACK. The user,
 * 14:43 on 11-12: Hibernia's duo engaged "beside 5 friends" as a group passed, and fled once it had passed.
 */
const ALLY_KEEP_MS = 15_000, ALLY_SLACK = 1500;
/**
 * A fight we chose (taken at engageAt or better) is held this long from its start: left inside it only below
 * leaveAt × HOLD_FAR. The user, 14:43 on 11-12: Aine and Fionn engaged two Albions at even odds, fled 13 s later at 0.50
 * when a third came near, came back, engaged, fled again; both Albions stayed at 100 %.
 */
const FIGHT_HOLD_MS = 20_000, HOLD_FAR = 0.6;
/** Engaged or attacked again within this of the last time is the same fight. */
const FIGHT_GAP_MS = 10_000;
/** A flee is held this long before it turns on those following, unless the odds reach engageAt × TURN_FAR. */
const FLEE_HOLD_MS = 10_000, TURN_FAR = 2;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centroid = (ps: readonly Point[]): Point => ({ x: ps.reduce((a, p) => a + p.x, 0) / Math.max(1, ps.length), y: ps.reduce((a, p) => a + p.y, 0) / Math.max(1, ps.length) });
const usesMana = (m: MemberReport) => m.capabilities.heal || m.capabilities.nuke || m.capabilities.cc || !!m.capabilities.pet;
const onWhom = (c: Contact): string | null => c.target ?? c.targetPet ?? null;
const unit = (a: Point, b: Point): Point => { const d = Math.max(1, dist(a, b)); return { x: (b.x - a.x) / d, y: (b.y - a.y) / d }; };
/** Distance from `p` to the segment a-b. */
const segmentDist = (p: Point, a: Point, b: Point): number => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};
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
export function sideStrength(worths: readonly number[], healers: number, heads?: readonly number[]): number {
    // How many: a pet is part of a fighter, not one more (PET_HEAD). Run B 08:49: a Hunter and its pet read "1 vs 2" to Tristram.
    const n = worths.reduce((a, w, i) => a + (w > 0 ? heads?.[i] ?? 1 : 0), 0);
    if (!n) return 0;
    const sum = worths.reduce((a, w) => a + w, 0);
    const backed = healers > 0 && n > 1 ? sum * HEALER_BACKING : sum;
    return backed * n;
}

/** A friendly player of our realm outside the squad (squad-run.ts friendsIn): where it stands, and what the region frame tells. */
export type Friend = Point & { name?: string; hp?: number; level?: number; className?: string; inCombat?: boolean };

/** A friend's worth against a side of level `ours`: its class's role, health and level, at ALLY. */
export function allyWorth(f: Friend, ours: number): number {
    const role = f.className ? roleOfClass(f.className) : undefined;
    const lv = clamp(1 + PER_LEVEL * ((f.level || ours) - ours), 0.6, 1.5);
    return (role ? FOE_ROLE[role] : 1) * health(f.hp ?? 100) * lv * ALLY;
}

export interface SizeUp {
    /** The enemies the fight is with (or would be): players and pets. */
    foes: Contact[];
    /** Friends in the fight (ASSIST): counted on our side. */
    allies: number;
    /** Their names, where known (to keep them counted: ALLY_KEEP_MS). */
    allyNames: string[];
    ours: number;
    theirs: number;
    /** ours / theirs; Infinity with nobody against us. */
    ratio: number;
    /** The same with our hidden stealthers' opener (OPENER): the odds of a fight we would start. */
    opening: number;
}

/**
 * The fight in front of us: the enemies against us near the centre (within sizeUp, else within huntRadius), the
 * largest realm among them plus any on us, and those within joinRadius of them; and both sides' strength. Friends
 * (`allies`) in combat within ASSIST of those enemies, or of us, fight on our side; those named in `keep` (counted lately)
 * out to ASSIST + ALLY_SLACK, in combat or not.
 */
export function sizeUp(members: readonly MemberReport[], enemies: readonly Contact[], centre: Point, s: Pick<SquadSettings, 'huntRadius' | 'squad'>, grudge: ReadonlySet<number> = new Set(), allies: readonly Friend[] = [], keep: ReadonlySet<string> = new Set()): SizeUp {
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
    // Those within joinRadius of a counted one, and theirs in turn: a group strung out along a road is one group.
    for (let grew = true; grew;) {
        grew = false;
        for (const c of enemies) if (!foes.includes(c) && c.realm === core[0]?.realm && foes.some(f => dist(f, c) <= s.squad.joinRadius)) { foes.push(c); grew = true; }
    }
    const alive = members.filter(m => !m.isDead);
    const level = alive.length ? alive.reduce((a, m) => a + m.level, 0) / alive.length : 1;
    const within = (f: Friend, reach: number) => dist(f, centre) <= reach || foes.some(c => !c.isPet && dist(c, f) <= reach);
    const helping = allies.filter(f => (f.name && keep.has(f.name) ? within(f, ASSIST + ALLY_SLACK) : f.inCombat !== false && within(f, ASSIST)));
    const ourWorth = [...alive.map(m => memberWorth(m) * clamp(1 + PER_LEVEL * (m.level - level), 0.6, 1.5)), ...helping.map(f => allyWorth(f, level))];
    const ourHealers = alive.filter(m => m.role === 'healer' || m.capabilities.heal).length + helping.filter(f => f.className && roleOfClass(f.className) === 'healer').length;
    const theirWorth = foes.map(c => foeWorth(c, level) * (busy(c) ? BUSY : 1));
    const theirHealers = foes.filter(c => !c.isPet && foeRole(c) === 'healer').length;
    const heads = foes.map(c => (c.isPet ? PET_HEAD : 1));
    const a = sideStrength(ourWorth, ourHealers), b = sideStrength(theirWorth, theirHealers, heads);
    const opened = sideStrength(ourWorth.map((w, i) => w * (i < alive.length && STEALTHERS.has(alive[i]!.className) && !alive[i]!.inCombat ? OPENER : 1)), ourHealers);
    // To start a fight, those that beat us lately count more (GRUDGE).
    const wary = sideStrength(foes.map((c, i) => theirWorth[i]! * (grudge.has(c.objectId) ? GRUDGE : 1)), theirHealers, heads);
    return { foes, allies: helping.length, allyNames: helping.flatMap(f => (f.name ? [f.name] : [])), ours: a, theirs: b, ratio: b > 0 ? a / b : Infinity, opening: wary > 0 ? opened / wary : Infinity };
}

/**
 * The enemies within reach as groups: any realm, linked through joinRadius (a member of one within it of a member of
 * another is the same group). Two realms fighting each other near us are one fight we would walk into.
 */
export function enemyClusters(enemies: readonly Contact[], joinRadius: number): Contact[][] {
    const left = [...enemies];
    const out: Contact[][] = [];
    while (left.length) {
        const cl = [left.shift()!];
        for (let grew = true; grew;) {
            grew = false;
            for (let i = left.length - 1; i >= 0; i--) if (cl.some(c => dist(c, left[i]!) <= joinRadius)) { cl.push(...left.splice(i, 1)); grew = true; }
        }
        out.push(cl);
    }
    return out;
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
    flee: { start: number; lastFollowed: number; to: Point3; toward: 'friends' | 'home' | 'away'; target: Point | null; ids?: number[] } | null;
    /** Friends counted in our fight lately, by name, until (ms epoch): ALLY_KEEP_MS. */
    allies?: Record<string, number>;
    /** The fight we are in: when it started, when we were last in it, and whether we chose it (held: FIGHT_HOLD_MS). */
    fight?: { start: number; last: number; chosen: boolean };
    /** Caught: fight it out until nobody is against us. */
    stand: boolean;
    /** Enemies in a group we would not take now, hidden until (ms epoch): SHUN_MS after last judged so. */
    shun: Record<number, number>;
    /** Enemies that killed one of ours, until (ms epoch). */
    grudge: Record<number, number>;
    /** Our dead last tick (to see a new death). */
    dead?: string[];
    /** Stepping away from a group we would not take (until it is CLEAR_SLACK beyond sizeUp). */
    clearing?: boolean;
    /** Where groups we keep clear of were last seen (ZONE_MS). */
    zones?: { x: number; y: number; r: number; until: number; n: number }[];
    /** Counts for the run's report: fights left, fights fought out after being caught, groups stepped away from. */
    fled: number;
    caught: number;
    avoided: number;
    patrolKey?: string;
}

export interface SquadOptions {
    /** Where friendly players of our realm stand (not this squad): groups to run to, and to fight beside. Read each tick; none by default. */
    friends?: () => readonly Friend[];
}

/** The squad's decide around `inner` (decideRvr by default, or a realm's own wrapper of it). */
export function squadDecide(inner: (ctx: CoordinatorContext<any>) => OrdersUpdate = decideRvr, opts: SquadOptions = {}): (ctx: CoordinatorContext<SquadSettings>) => OrdersUpdate {
    return ctx => decideSquad(ctx, inner, opts);
}

export function decideSquad(ctx: CoordinatorContext<SquadSettings>, inner: (ctx: CoordinatorContext<any>) => OrdersUpdate = decideRvr, opts: SquadOptions = {}): OrdersUpdate {
    const { picture: p, orders: o, memory: mem, now } = ctx;
    const s: SquadSettings = { ...ctx.settings, squad: { ...SQUAD_RULES, ...ctx.settings.squad } };
    const r = s.squad;
    const sq: SquadMemory = mem.squad ??= { avoid: {}, shun: {}, grudge: {}, flee: null, stand: false, fled: 0, caught: 0, avoided: 0 };
    sq.shun ??= {};
    sq.grudge ??= {};
    for (const map of [sq.avoid, sq.shun, sq.grudge]) for (const [id, until] of Object.entries(map)) if (until <= now) delete map[+id];

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

    const ours = new Set(p.members.map(m => m.name));
    const onUs = (c: Contact) => { const n = onWhom(c); return n !== null && ours.has(n); };
    const enemies = p.contacts.filter(c => (c.kind === 'player' || (c.isPet && c.threat)) && !c.stale && c.hp > 0 && c.regionId === regionId && !untouchable(c, now));
    // Our side is the main body (rvr.ts mainBody): one walking back from a release 9000 off is in no fight here.
    // Run B, 23:25: Tuck alone took a Celt at "2 vs 1" with Galahad walking back from the portal keep, and died.
    const inRegion = alive.filter(m => m.regionId === regionId);
    const scratch: Record<string, any> = { gatherLead: mem.squadLead };
    const attacked = new Set(enemies.map(onWhom).filter((n): n is string => n !== null && ours.has(n)));
    // Twice the gather radius: a tank chasing its focus to the leash (2000) is still with its healer. Run B 09:17: Camelot's and
    // Hibernia's duos each read "1 vs 2" that way, mid-chase, and both fled from an even fight.
    const here = mainBody(inRegion, 2 * s.gatherRadius, scratch, attacked).main;
    mem.squadLead = scratch.gatherLead;
    const centre = centroid(here);
    const nearOnUs = (c: Contact) => onUs(c) && dist(c, centre) <= s.engageRadius + 1000;
    // A new death of ours: those near it killed it, and are remembered (GRUDGE).
    for (const m of p.members.filter(x => x.isDead && !(sq.dead ?? []).includes(x.name))) {
        for (const c of enemies) if (c.kind === 'player' && dist(c, m) <= s.engageRadius) sq.grudge[c.objectId] = now + GRUDGE_MS;
    }
    sq.dead = p.members.filter(m => m.isDead).map(m => m.name);
    const grudge = new Set(Object.keys(sq.grudge).map(Number));
    const home = homeOf(regionId, realm);
    const keeps = keepDangers(regionId, realm, s);
    const zAt = (q: Point) => estimateZ(regionId, q.x, q.y, here[0]?.z ?? 0, { radius: 8000 });
    const trip: Trip = { mem, now, regionId, level: Math.min(...here.map(m => m.level)), avoid: keeps, travelLeg: s.travelLeg, zAt, dry: staysDry(s) };
    const ourInKeepReach = !!home && dist(centre, home.keep) <= r.keepReach;
    // A friendly group is two or more of ours together: one passing by (a stealther, a solo) is no safety to stand by.
    // Run B 08:53: Midgard's trio turned to fight 1 s into its flee, by one friend, and all three died.
    const known = opts.friends?.() ?? [];
    const friends = known.filter(f => dist(f, centre) <= r.friendMax && known.some(g => g !== f && dist(g, f) <= r.joinRadius));
    const nearestFriend = friends.reduce<Point | null>((best, f) => (!best || dist(f, centre) < dist(best, centre) ? f : best), null);
    const atFriends = !!nearestFriend && dist(nearestFriend, centre) <= r.friendReach;

    // A friendly group's fight near us is ours too: its players count on our side (ASSIST).
    sq.allies = Object.fromEntries(Object.entries(sq.allies ?? {}).filter(([, until]) => until > now));
    const keep = new Set(Object.keys(sq.allies));
    const up = sizeUp(here, enemies, centre, s, grudge, friends, keep);
    for (const n of up.allyNames) sq.allies[n] = now + ALLY_KEEP_MS;
    // Attacked: one on us near (the board keeps a runner's last target, so not at any range), or in combat with one beside us.
    const hit = up.foes.some(nearOnUs) || here.some(m => m.inCombat && up.foes.some(c => dist(c, m) < 400));
    const engaged = o.phase === 'engage';
    // The fight's start, and whether we chose it (taken at engageAt or better): a fight we chose is held (FIGHT_HOLD_MS).
    if (engaged || hit) {
        if (!sq.fight || now - sq.fight.last > FIGHT_GAP_MS) sq.fight = { start: now, last: now, chosen: engaged && up.ratio >= r.engageAt };
        sq.fight.last = now;
    }
    let held = !!sq.fight?.chosen && now - sq.fight.start < FIGHT_HOLD_MS && now - sq.fight.last <= FIGHT_GAP_MS && !sq.flee;
    // Far past the line: the hold ends.
    if (held && up.foes.length && up.ratio < r.leaveAt * HOLD_FAR) { sq.fight!.chosen = false; held = false; }
    const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '∞');
    const side = (n: number) => `${here.length}${n ? `+${n}` : ''}`;
    const odds = `${fmt(up.ratio)} (${side(up.allies)} vs ${up.foes.length})`;

    /** Where to run: toward friends near and not behind the enemy, else home (or straight away when they stand that way). */
    const fleeTarget = (from: readonly Contact[] = up.foes): { way: Point; toward: 'friends' | 'home' | 'away'; target: Point | null } => {
        const them = centroid(from.length ? from : enemies);
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
    const fleeOrder = (why: string, walk = false): OrdersUpdate => {
        const f = sq.flee!;
        if (dist(centre, f.to) < 600) f.to = nextSpot(f);
        const where = f.toward === 'friends' ? 'friends' : f.toward === 'home' ? 'our portal keep' : 'open ground';
        // Nobody following within engageRadius: on at a walk (travel), so sprint (retreat only) is off and endurance is kept for
        // the next fight. The user, 14:44 on 11-12: Fionn, a Blademaster, at 5 % endurance from sprinting every flee.
        if (walk) return { phase: 'travel', focus: null, puller: null, cc: [], waiting: [], retreatTo: null, anchor: f.to, objective: `walk on away from ${up.foes.length || 'the'} enemies toward ${where}`, reason: `flee: ${why}, none within ${s.engageRadius}: walking` };
        return { phase: 'retreat', focus: null, puller: null, cc: [], waiting: [], retreatTo: f.to, anchor: f.to, objective: `get away from ${up.foes.length || 'the'} enemies toward ${where}`, reason: `flee: ${why}` };
    };

    /** Note where a group we keep clear of stands (sq.zones). */
    const noteZone = (cl: readonly Contact[]) => {
        if (!cl.length) return;
        const c = centroid(cl);
        const r0 = Math.max(ZONE_MIN, Math.max(...cl.map(e => dist(e, c))) + ZONE_PAD);
        const zones = sq.zones ??= [];
        const z = zones.find(q => dist(q, c) <= ZONE_MERGE);
        if (z) Object.assign(z, { x: Math.round(c.x), y: Math.round(c.y), r: Math.round(r0), until: now + ZONE_MS, n: cl.length });
        else zones.push({ x: Math.round(c.x), y: Math.round(c.y), r: Math.round(r0), until: now + ZONE_MS, n: cl.length });
    };
    sq.zones = (sq.zones ?? []).filter(z => z.until > now);

    // ── Fleeing: on toward safety while they follow ──
    if (sq.flee) {
        // One that still has us as its last target counts only within the focus slack: the board keeps a runner's target.
        const following = up.foes.filter(c => dist(c, centre) <= s.engageRadius || (onUs(c) && dist(c, centre) <= s.engageRadius + 1000));
        if (following.length) sq.flee.lastFollowed = now;
        const ids = sq.flee.ids ??= [];
        for (const c of up.foes) if (!ids.includes(c.objectId)) ids.push(c.objectId);
        const safe = atFriends || ourInKeepReach;
        // Only those we can take still following: turn on them (run B 09:42: Hibernia's duo ran 45 s from one Troll at
        // odds 1.18, was caught and lost Aine), once the flee has held FLEE_HOLD_MS, or at once when the odds are far past
        // engageAt. The fight logic below takes it from here, and holds it as a fight we chose.
        if (following.length && up.ratio >= r.engageAt && (now - sq.flee.start >= FLEE_HOLD_MS || up.ratio >= r.engageAt * TURN_FAR)) {
            sq.flee = null;
            sq.fight = { start: now, last: now, chosen: true };
            held = true;
        } else if (safe || now - sq.flee.lastFollowed >= r.shakenMs) {
            // All we ran from are left alone (avoidMs), not only those still in view: else the next tick hunts the two of
            // the three that came back into view (the user, 14:43 on 11-12).
            for (const id of ids) sq.avoid[id] = now + r.avoidMs;
            noteZone(up.foes);
            sq.flee = null;
            // At safety with them on us: fight there, beside our friends or under our guards.
            if (safe && following.length) sq.stand = true;
        } else if (now - sq.flee.start >= r.fleeMaxMs) {
            sq.flee = null;
            sq.stand = true;
            sq.caught++;
        } else return fleeOrder(`${following.length} following, odds ${odds}`, !following.length);
    }
    if (sq.stand && !up.foes.some(c => onUs(c) || dist(c, centre) <= s.engageRadius)) sq.stand = false;

    // ── In a fight that turned: leave it ──
    // A fight we chose is held for FIGHT_HOLD_MS unless the odds fall far past leaveAt (held, above).
    const holding = held && up.foes.length > 0 && up.ratio < r.leaveAt;
    if ((engaged || hit) && up.foes.length && !sq.stand && !held && up.ratio < r.leaveAt) {
        const focus = engaged && o.focus !== null ? up.foes.find(c => c.objectId === o.focus) : undefined;
        const finishing = !!focus && focus.hp < s.retreat.focusHp && up.ratio >= r.leaveAt / 2;
        // One enemy player on us (with its pet, if any) runs as fast as we do, or shoots or casts at our back: only worth
        // running from with safety near. Run B 08:49: Tristram ran from a Hunter for 45 s and died to its arrows.
        const lone = up.foes.filter(c => !c.isPet);
        // In a fight (engaged or attacked) one enemy player is that one, whether or not the board reads its target: an archer's
        // arrows don't name one (run B 09:30: Tristram ran from a Hunter at "1 vs 1" and died 2 s later).
        const melee = lone.length === 1;
        const safetyNear = (nearestFriend && dist(nearestFriend, centre) <= r.outrunMax) || (home && dist(centre, home.keep) <= r.outrunMax);
        if (!finishing && !(melee && !safetyNear) && !atFriends && !ourInKeepReach) {
            const t = fleeTarget();
            sq.flee = { start: now, lastFollowed: now, to: { x: Math.round(centre.x), y: Math.round(centre.y), z: zAt(centre) }, toward: t.toward, target: t.target, ids: up.foes.map(c => c.objectId) };
            sq.fled++;
            return fleeOrder(`odds ${odds} below ${r.leaveAt}`);
        }
    }

    // ── Not fighting: groups we would not take are left alone, and stepped away from when near ──
    // Each group within reach is judged by itself (enemyClusters): one stray at the edge of a group of eight is no lone
    // enemy (run B, 23:11: Camelot's duo engaged a Kobold "1 vs 1" and fled 13 s later from six), and a lone caster of one
    // realm by another realm's group neither (23:13: hunt and avoid flipped every second).
    let worstText = '';
    if (!engaged && !hit && !sq.stand && !held) {
        const whole = { ...s, squad: { ...r, sizeUp: Infinity } };
        const groups = enemyClusters(enemies, r.joinRadius).filter(cl => cl.some(c => dist(c, centre) <= s.huntRadius));
        const bad: Contact[] = [];
        let worst = Infinity;
        for (const cl of groups) {
            // The group as a whole is what we would walk into, whichever realms are in it.
            const su = sizeUp(here, cl.map(c => ({ ...c, realm: cl[0]!.realm })), centre, whole, grudge, friends, keep);
            const odds = su.opening;
            if (odds >= r.engageAt) {
                for (const c of cl) delete sq.shun[c.objectId];
                // Those we ran from stay left alone, unless a friendly group's fight with them makes it far better than even.
                if (su.allies && odds >= r.engageAt * TURN_FAR) for (const c of cl) delete sq.avoid[c.objectId];
                continue;
            }
            if (!cl.every(c => (sq.shun[c.objectId] ?? 0) > now || (sq.avoid[c.objectId] ?? 0) > now)) sq.avoided++;
            for (const c of cl) sq.shun[c.objectId] = now + SHUN_MS;
            noteZone(cl);
            bad.push(...cl);
            if (odds < worst) { worst = odds; worstText = `${fmt(odds)} (${side(su.allies)} vs ${cl.length}${here.some(m => STEALTHERS.has(m.className) && !m.inCombat) ? ', from stealth' : ''})`; }
        }
        const nearest = bad.length ? Math.min(...bad.map(c => dist(c, centre))) : Infinity;
        sq.clearing = nearest <= r.sizeUp || (!!sq.clearing && nearest <= r.sizeUp + CLEAR_SLACK);
        // Closing on us: run (retreat sprints). Run B, 08:32: a group of five walked Camelot's duo down from 3300 to 900 while it
        // stepped away at a walk, then caught it 45 s into the flee and killed both.
        // A hidden stealther (alone or with others hidden) is unseen: it walks away.
        const unseen = here.every(m => STEALTHERS.has(m.className) && !m.inCombat);
        // One enemy player (and its pet) closing is no group to run from: it runs as fast, or shoots (run B 09:15: Skadi, resting
        // after a mob, ran from a lone Celt at 175 and died to it).
        const players = bad.filter(c => !c.isPet).length;
        if (nearest <= r.runAt && worst < r.leaveAt && players >= 2 && !unseen && !atFriends && !ourInKeepReach) {
            const t = fleeTarget(bad);
            sq.flee = { start: now, lastFollowed: now, to: { x: Math.round(centre.x), y: Math.round(centre.y), z: zAt(centre) }, toward: t.toward, target: t.target, ids: bad.map(c => c.objectId) };
            sq.fled++;
            sq.clearing = false;
            return fleeOrder(`${bad.length} closing ${Math.round(nearest)} away, odds ${worstText}`);
        }
        if (sq.clearing) {
            const way = runWay(centre, bad, home?.arrival ?? null);
            const goal = spotAlong(trip, centre, way, r.sizeUp);
            stepLeg(trip, 'avoid', goal, { from: centre, movers: here, replan: 1500 });
            return { phase: 'travel', focus: null, puller: null, cc: [], retreatTo: null, waiting: [], anchor: legAnchor(mem), facing: mem.legFacing, objective: `keep clear of ${bad.length} enemies`, reason: `avoid: odds ${worstText} below ${r.engageAt}, nearest ${Math.round(nearest)} away` };
        }
    } else sq.clearing = false;
    const hidden = new Set([...Object.keys(sq.avoid), ...Object.keys(sq.shun)].map(Number));
    // A fight we are in (taken, held, caught, or they attack us) shows everyone: the avoided ones too.
    const showAll = sq.stand || hit || engaged || held;
    const contacts = showAll ? p.contacts : p.contacts.filter(c => !hidden.has(c.objectId) || nearOnUs(c));
    // The patrol's next waypoint by enemies we keep clear of is skipped (at most the whole loop once): else the loop walks
    // us back to them as soon as we stepped away.
    const loop: Point3[] | null = innerSettings.patrol ?? mem.patrol ?? null;
    const shunned = enemies.filter(c => hidden.has(c.objectId) && !nearOnUs(c));
    const zones = sq.zones ?? [];
    const kept = (q: Point) => shunned.some(c => dist(c, q) <= r.sizeUp + 1000) || zones.some(z => dist(z, q) <= z.r + 500);
    // Another lane first: a waypoint whose way passes through such a spot is skipped too (run B 08:47: Midgard's trio fled
    // east from a group, patrolled west past it to the next waypoint, and was run off again every ten seconds). Only with
    // every waypoint behind one does the patrol go round (below).
    const blocked = (q: Point) => kept(q) || zones.some(z => dist(z, centre) > z.r && segmentDist(z, centre, q) < z.r);
    if (!showAll && loop?.length && (shunned.length || zones.length) && typeof mem.wp === 'number') {
        const start = mem.wp % loop.length;
        let k = 0;
        while (k < loop.length && blocked(loop[(start + k) % loop.length]!)) k++;
        // All blocked: the first one not in a spot itself, to go round to.
        if (k === loop.length) { k = 0; while (k < loop.length && kept(loop[(start + k) % loop.length]!)) k++; }
        if (k > 0 && k < loop.length) { mem.wp = (start + k) % loop.length; mem.legKind = null; }
    }
    const u = callInner(contacts);
    if (sq.stand && u.phase === 'engage') return { ...u, reason: `caught: ${u.reason ?? ''}` };
    // On patrol, a zone across the way to the waypoint is gone round (safePath round it as round a keep), not through.
    if (!showAll && u.phase === 'travel' && u.reason?.startsWith('patrol') && loop?.length && typeof mem.wp === 'number' && zones.length) {
        const wp = loop[mem.wp % loop.length]!;
        const across = zones.filter(z => dist(z, centre) > z.r && segmentDist(z, centre, wp) < z.r);
        if (across.length) {
            const round: Danger[] = across.map(z => ({ x: z.x, y: z.y, r: z.r, name: `${z.n} enemies last seen`, level: 0 }));
            stepLeg({ ...trip, avoid: [...keeps, ...round] }, 'detour', wp, { from: centre, movers: here, replan: 1500, force: true });
            const at = across.map(z => `(${z.x}, ${z.y})`).join(', ');
            return { ...u, anchor: legAnchor(mem), facing: mem.legFacing, reason: `${u.reason}; round ${across.length === 1 ? 'a group' : `${across.length} groups`} last seen at ${at}` };
        }
    }
    // Fighting beside a friendly group: say so, for the log and the ledger.
    if (u.phase === 'engage' && up.foes.length && (up.allies || holding)) {
        const why = [up.allies ? `beside ${up.allies} friends` : '', holding ? `held ${Math.round((now - sq.fight!.start) / 1000)} s of ${FIGHT_HOLD_MS / 1000}` : ''].filter(Boolean).join(', ');
        return { ...u, reason: `${u.reason ?? ''}; ${why}, odds ${odds}` };
    }
    // Say who we keep clear of, for the log: the orders alone show only a patrol.
    if (shunned.length && !showAll && u.phase !== 'engage') return { ...u, reason: `${u.reason ?? ''}; clear of ${shunned.length}${worstText ? ` at odds ${worstText}` : ''}` };
    return u;
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
