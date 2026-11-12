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
// Help calls (director.ts): a free squad goes to a friend's fight its realm's director asks it to, unless the odds there
// with our friends counted stay below leaveAt; unasked, it comes only from near and at engageAt or better. A muster (a
// raid) it joins when asked: the rally, then the target. Orders on the way read "call: ...".
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
import type { AnswerState, RealmCall } from './director';
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
    /** Answer the realm director's calls (help, muster) when free; off: never. */
    calls: boolean;
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
    calls: true,
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
/**
 * The opener's target is half out of the fight before it can answer: its worth and its head count this much less in the
 * odds of a fight a hidden stealther starts. The freeze on 11-12 (N5): with the opener only as 1.4 of our worth, the three
 * assassins kept clear of "1 vs 2" 140 times and opened twice in 4 h.
 */
const OPEN_TAKE = 0.5;
/**
 * Enemies farther than this from the opener's target come in after the burst: they count LATE (worth and head). The kit
 * calls a target with no enemy player this near a lone one, and opens on it (sdk/classes/stealther.ts LONE_RADIUS).
 */
const LATE_RADIUS = 1000, LATE = 0.6;
/** Under this % health a target is worth the opener whatever it is (stealther.ts SOFT_HP). */
const OPEN_SOFT_HP = 50;
/**
 * A fight we chose against players is fought out through an add or two, not through a whole group: with this many enemy
 * players in view per member of ours (plus one) it is left at once, at the health we still have. The commit hour on 11-12
 * (17:36-18:38): squads fled only once 40 points down, and 14 died fleeing (7 in the 4 h freeze). Aine and Fionn took
 * "2 vs 2" and fled at "2 vs 7" with health 100 to 50 %; both died within 13 s.
 */
const OVERRUN = 2;
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
/**
 * A fight we chose against players is fought out: left only on our own losses, a member dead or our mean health this many
 * points below where it was at the engage, then by the odds as usual. Not on enemies noticed after it. N1, the human-vision
 * hour on 11-12 (midgard-s1 15:54-16:05): a trio took "3 vs 1", saw five more come into view seconds later ("0.26 (3 vs 6)")
 * and fled; in a fight you notice the add late and fight on (the user).
 */
const COMMIT_LOSS = 40;
/**
 * An enemy player gone from view (stale on the board) counts at its last known place this long: in sizeUp, in a flee's
 * turn, and in the groups we would walk into. With human vision, pursuers behind a fleeing squad leave its cone: it read
 * "4 following, odds 0.61", turned back, saw them, and fled again (N1, hibernia-s1 15:55 on 11-12).
 */
const REMEMBER_MS = 30_000;
/**
 * The leg we walk to this far off is from before a jump (a release to our portal keep): it is dropped, and the patrol starts
 * again at its nearest waypoint. Kept, a solo walked ~30000 straight across the map to it after each release, and the
 * navmesh's shortest way crossed the Faste's island under its guards: Diarmuid 8 deaths 10:41-11:42 and Scathach 6 on 11-12,
 * "attacked by something unseen 1859 from Thidranki Faste", 4-8 min apart. Legs lie travelLeg apart; a crossing's far bank ~3000.
 */
const LEG_JUMP = 6000;
/** A help call we were asked to is answered from at most this far (the director asks within 7000) ... */
const CALL_REACH = 7000;
/** ... one we were not asked to, from at most this far, and only at engageAt or better with the friends there. */
const CALL_UNASKED = 5000;
/** Within this of the call's spot we are there: 'arrived', and the fight there is one we chose. */
const CALL_ARRIVE = 1500;
/** Enemies within this of the call's spot are its fight: not kept clear of on the way, and fought as chosen. */
const CALL_FIGHT = 3000;
/** Still not there after this long: given up ('left'). */
const CALL_MAX_MS = 90_000;
/** There, and no fight of ours for this long: done with it. */
const CALL_DONE_MS = 20_000;
/** A call we declined or are done with is not looked at again for this long. */
const CALL_AGAIN_MS = 60_000;

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
export type Friend = Point & { name?: string; hp?: number; level?: number; className?: string; inCombat?: boolean; targetId?: number | null };

/** A friend's worth against a side of level `ours`: its class's role, health and level, at ALLY. */
export function allyWorth(f: Friend, ours: number): number {
    const role = f.className ? roleOfClass(f.className) : undefined;
    const lv = clamp(1 + PER_LEVEL * ((f.level || ours) - ours), 0.6, 1.5);
    return (role ? FOE_ROLE[role] : 1) * health(f.hp ?? 100) * lv * ALLY;
}

/**
 * The odds at a friend's fight if we come: us (a hidden stealther with its opener, OPENER) and the realm's own there
 * (`ours`, each a fighter at ALLY) against `foes` by their read roles (unknown: a fighter). Lanchester as sizeUp.
 */
export function callOdds(members: readonly MemberReport[], call: Pick<RealmCall, 'foes' | 'ours' | 'foeRoles'>): number {
    const alive = members.filter(m => !m.isDead);
    const ours = [...alive.map(m => memberWorth(m) * (STEALTHERS.has(m.className) && !m.inCombat ? OPENER : 1)), ...Array.from({ length: Math.max(0, call.ours) }, () => ALLY)];
    const theirs: number[] = [];
    let healers = 0;
    for (const [role, n] of Object.entries(call.foeRoles ?? {})) {
        for (let i = 0; i < (n ?? 0); i++) {
            theirs.push(role in FOE_ROLE ? FOE_ROLE[role as FoeRole] : 1);
            if (role === 'healer') healers++;
        }
    }
    while (theirs.length < call.foes) theirs.push(1);
    if (call.foes > 0) theirs.length = Math.min(theirs.length, call.foes);
    const b = sideStrength(theirs, Math.min(healers, theirs.length));
    return b > 0 ? sideStrength(ours, alive.filter(m => m.role === 'healer' || m.capabilities.heal).length) / b : Infinity;
}

export interface SizeUp {
    /** The enemies the fight is with (or would be): players and pets. */
    foes: Contact[];
    /** Friends in the fight (ASSIST): counted on our side. */
    allies: number;
    /** Their names, where known (to keep them counted: ALLY_KEEP_MS). */
    allyNames: string[];
    /** The friends counted. */
    beside: Friend[];
    ours: number;
    theirs: number;
    /** ours / theirs; Infinity with nobody against us. */
    ratio: number;
    /** The same with our hidden stealthers' opener (OPENER, OPEN_TAKE, LATE): the odds of a fight we would start. */
    opening: number;
    /** The enemy player a hidden stealther of ours would open on (the one that gives the best opening), if any. */
    openOn: number | null;
}

/** Would the stealther kit open on `c` (stealther.ts softTarget): soft by role, going down, or with no enemy player within LATE_RADIUS. */
function openable(c: Contact, foes: readonly Contact[]): boolean {
    const role = foeRole(c);
    if (role === 'healer' || role === 'caster' || role === 'cc') return true;
    if (c.hp < OPEN_SOFT_HP) return true;
    return !foes.some(o => o !== c && !o.isPet && !o.stale && dist(o, c) <= LATE_RADIUS);
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
    const hidden = alive.some(m => STEALTHERS.has(m.className) && !m.inCombat);
    const opened = sideStrength(ourWorth.map((w, i) => w * (i < alive.length && STEALTHERS.has(alive[i]!.className) && !alive[i]!.inCombat ? OPENER : 1)), ourHealers);
    // To start a fight, those that beat us lately count more (GRUDGE).
    const grudged = foes.map((c, i) => theirWorth[i]! * (grudge.has(c.objectId) ? GRUDGE : 1));
    const wary = sideStrength(grudged, theirHealers, heads);
    // A hidden stealther opens on one it can (openable, in view): that one is half out of the fight (OPEN_TAKE), and those
    // farther than LATE_RADIUS from it come in late (LATE). The target that leaves them weakest.
    let opening = wary > 0 ? opened / wary : Infinity, openOn: number | null = null;
    if (hidden) {
        let best = -1;
        for (const t of foes) {
            if (t.isPet || t.stale || !openable(t, foes)) continue;
            const f = (c: Contact) => (c === t ? 1 - OPEN_TAKE : dist(c, t) > LATE_RADIUS ? LATE : 1);
            const theirs = sideStrength(foes.map((c, i) => grudged[i]! * f(c)), theirHealers, foes.map((c, i) => heads[i]! * f(c)));
            const odds = theirs > 0 ? opened / theirs : Infinity;
            if (odds > best) { best = odds; openOn = t.objectId; }
        }
        opening = Math.max(opening, best);
    }
    return { foes, allies: helping.length, allyNames: helping.flatMap(f => (f.name ? [f.name] : [])), beside: helping, ours: a, theirs: b, ratio: b > 0 ? a / b : Infinity, opening, openOn };
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
    flee: { start: number; lastFollowed: number; to: Point3; toward: 'friends' | 'home' | 'away'; target: Point | null; ids?: number[]; seen?: { x: number; y: number; r: number; n: number; realm: Realm } } | null;
    /** Friends counted in our fight lately, by name, until (ms epoch): ALLY_KEEP_MS. */
    allies?: Record<string, number>;
    /**
     * The fight we are in: when it started, when we were last in it, and whether we chose it (held: FIGHT_HOLD_MS; against
     * players committed: COMMIT_LOSS). At its start: whether players were in it, our mean health and our dead; `lost` once
     * we lost there (a death or health), which ends the commit.
     */
    fight?: { start: number; last: number; chosen: boolean; players?: boolean; hp0?: number; dead0?: string[]; lost?: string };
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
    /** Where groups we keep clear of were last seen (ZONE_MS); `fled`: one we ran from, its realm left alone in it until then. */
    zones?: { x: number; y: number; r: number; until: number; n: number; fled?: number; realm?: Realm }[];
    /** Counts for the run's report: fights left, fights fought out after being caught, groups stepped away from. */
    fled: number;
    caught: number;
    avoided: number;
    patrolKey?: string;
    /** The call we answer: 'coming' on the way, 'arrived' there (director.ts). */
    call?: { id: string; kind: RealmCall['kind']; from: string; state: 'coming' | 'arrived'; since: number; arrivedAt?: number; lastFight?: number };
    /** Calls declined or done, by id, not looked at again until (ms epoch). */
    callsSeen?: Record<string, number>;
    /** Calls answered 'coming', for the report. */
    answered?: number;
}

export interface SquadOptions {
    /** Where friendly players of our realm stand (not this squad): groups to run to, and to fight beside. Read each tick; none by default. */
    friends?: () => readonly Friend[];
    /** This unit's name, as the director knows it (its folder). Calls are answered only with it. */
    unit?: string;
    /** The realm's open help calls and musters (director.ts callWatch), not this unit's own; none by default. */
    calls?: (realm: Realm) => readonly RealmCall[];
    /** Tell the director: coming, declined, arrived, left. */
    answer?: (callId: string, state: AnswerState, why: string) => void;
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
    // In view, or a player out of view lately, at its last known place (REMEMBER_MS).
    const inView = (c: Contact) => !c.stale;
    const remembered = (c: Contact) => c.stale && c.kind === 'player' && now - c.lastSeen <= REMEMBER_MS;
    const enemies = p.contacts.filter(c => (c.kind === 'player' || (c.isPet && c.threat)) && (inView(c) || remembered(c)) && c.hp > 0 && c.regionId === regionId && !untouchable(c, now));
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
    // All of us hidden stealthers, out of combat: unseen. Such a squad opens (sizeUp opening) and walks away hidden, never sprints.
    const unseen = here.length > 0 && here.every(m => STEALTHERS.has(m.className) && !m.inCombat);
    if (here.length && mem.leg && dist(centre, mem.leg) > LEG_JUMP) {
        mem.leg = null;
        mem.legKind = null;
        mem.route = null;
        mem.legOnward = null;
        mem.wp = undefined;
    }
    const nearOnUs = (c: Contact) => inView(c) && onUs(c) && dist(c, centre) <= s.engageRadius + 1000;
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

    // A friend's fight near us is ours too: its players count on our side (ASSIST), a lone one as well, in combat there.
    // The user, 15:47 on 11-12: Scathach and Diarmuid, two solos, fought the same three Albions 1000 apart, each reading
    // "1 vs 3" (the other one alone was no "group"), fled at 0.10 and were caught one by one.
    const allyPool = known.filter(f => dist(f, centre) <= r.friendMax);
    sq.allies = Object.fromEntries(Object.entries(sq.allies ?? {}).filter(([, until]) => until > now));
    const keep = new Set(Object.keys(sq.allies));
    const up = sizeUp(here, enemies, centre, s, grudge, allyPool, keep);
    for (const n of up.allyNames) sq.allies[n] = now + ALLY_KEEP_MS;
    // Attacked: one on us near (the board keeps a runner's last target, so not at any range), or in combat with one beside us.
    const hit = up.foes.some(nearOnUs) || here.some(m => m.inCombat && up.foes.some(c => inView(c) && dist(c, m) < 400));
    const engaged = o.phase === 'engage';
    // ── Help calls (director.ts) ──
    const sqCallsSeen = (sq.callsSeen ??= {});
    for (const [id, until] of Object.entries(sqCallsSeen)) if (until <= now) delete sqCallsSeen[id];
    const say = (id: string, state: AnswerState, why: string) => { try { opts.answer?.(id, state, why); } catch { /* the director sees us arrive anyway */ } };
    const openCalls = r.calls && opts.unit && opts.calls && realm !== 'none' ? opts.calls(realm).filter(c => c.kind === 'help' || c.kind === 'muster') : [];
    let call: RealmCall | null = sq.call ? openCalls.find(c => c.id === sq.call!.id) ?? null : null;
    if (sq.call && !call) sq.call = undefined; // closed
    /** Our fight is the call's: we came to it and stand there. */
    const atCall = () => !!call && sq.call?.state === 'arrived' && dist(centre, call.at) <= CALL_FIGHT;
    const meanHp = () => (alive.length ? alive.reduce((a, m) => a + m.hp, 0) / alive.length : 0);
    const startFight = (chosen: boolean): NonNullable<SquadMemory['fight']> =>
        ({ start: now, last: now, chosen, players: up.foes.some(c => !c.isPet), hp0: meanHp(), dead0: p.members.filter(m => m.isDead).map(m => m.name) });
    // The fight's start, and whether we chose it (taken at engageAt or better): a fight we chose is held (FIGHT_HOLD_MS),
    // against players committed (COMMIT_LOSS).
    if (engaged || hit) {
        if (!sq.fight || now - sq.fight.last > FIGHT_GAP_MS) sq.fight = startFight(engaged && (up.ratio >= r.engageAt || (unseen && up.opening >= r.engageAt) || atCall()));
        sq.fight.last = now;
    }
    const fight = sq.fight;
    const inFight = !!fight && now - fight.last <= FIGHT_GAP_MS && !sq.flee;
    // Our own losses since the engage: a member dead, or mean health COMMIT_LOSS down. They end the commit for the fight.
    if (inFight && fight.chosen && fight.players && !fight.lost) {
        const died = p.members.find(m => m.isDead && !(fight.dead0 ?? []).includes(m.name));
        const hpNow = meanHp();
        // A whole group in view, not an add or two (OVERRUN): left now, at the health we have. Not beside a friend in it.
        const seen = up.foes.filter(c => !c.isPet && inView(c)).length;
        if (died) fight.lost = `${died.name} died`;
        else if ((fight.hp0 ?? 100) - hpNow >= COMMIT_LOSS) fight.lost = `health ${Math.round(fight.hp0 ?? 100)} to ${Math.round(hpNow)} %`;
        else if (!up.allies && seen >= OVERRUN * here.length + 1 && up.ratio < r.leaveAt) fight.lost = `${seen} in view`;
    }
    const committed = inFight && fight.chosen && !!fight.players && !fight.lost;
    let held = committed || (inFight && fight.chosen && !fight.players && now - fight.start < FIGHT_HOLD_MS);
    // Far past the line: the hold ends (not a commit: only our losses end that).
    if (held && !committed && up.foes.length && up.ratio < r.leaveAt * HOLD_FAR) { fight!.chosen = false; held = false; }
    const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '∞');
    const side = (n: number) => `${here.length}${n ? `+${n}` : ''}`;
    const outOfView = (cs: readonly Contact[]) => { const n = cs.filter(c => !inView(c)).length; return n ? `, ${n} out of view` : ''; };
    const odds = `${fmt(up.ratio)} (${side(up.allies)} vs ${up.foes.length}${outOfView(up.foes)})`;
    // The whole of a group, however far it reaches (a flee's pursuers, a group we would walk into).
    const whole = { ...s, squad: { ...r, sizeUp: Infinity } };

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
        // Hidden, a retreat would show us (stealther.ts hide) to sprint: walk on hidden instead.
        if (walk || unseen) return { phase: 'travel', focus: null, puller: null, cc: [], waiting: [], retreatTo: null, anchor: f.to, objective: `walk on away from ${up.foes.length || 'the'} enemies toward ${where}`, reason: `flee: ${why}, ${unseen ? 'hidden' : `none within ${s.engageRadius}`}: walking` };
        return { phase: 'retreat', focus: null, puller: null, cc: [], waiting: [], retreatTo: f.to, anchor: f.to, objective: `get away from ${up.foes.length || 'the'} enemies toward ${where}`, reason: `flee: ${why}` };
    };

    /** Where a group stands, as a zone: its centre, and its spread plus ZONE_PAD (at least ZONE_MIN). */
    const zoneOf = (cl: readonly Contact[]) => {
        const c = centroid(cl);
        return { x: Math.round(c.x), y: Math.round(c.y), r: Math.round(Math.max(ZONE_MIN, Math.max(...cl.map(e => dist(e, c))) + ZONE_PAD)), n: cl.length, realm: cl[0]!.realm };
    };
    /** Note where a group we keep clear of stands (sq.zones); `fled`: one we ran from, left alone until then. */
    const putZone = (q: { x: number; y: number; r: number; n: number; realm: Realm }, fled?: number) => {
        const zones = sq.zones ??= [];
        const z = zones.find(e => dist(e, q) <= ZONE_MERGE);
        const at = { x: q.x, y: q.y, r: q.r, until: now + ZONE_MS, n: q.n, ...(fled ? { fled: Math.max(fled, z?.fled ?? 0), realm: q.realm } : {}) };
        if (z) Object.assign(z, at);
        else zones.push(at);
    };
    const noteZone = (cl: readonly Contact[]) => { if (cl.length) putZone(zoneOf(cl)); };
    sq.zones = (sq.zones ?? []).filter(z => z.until > now);

    // ── Fleeing: on toward safety while they follow ──
    if (sq.flee) {
        // One that still has us as its last target counts only within the focus slack: the board keeps a runner's target.
        const following = up.foes.filter(c => dist(c, centre) <= s.engageRadius || (onUs(c) && dist(c, centre) <= s.engageRadius + 1000));
        if (following.length) sq.flee.lastFollowed = now;
        const ids = sq.flee.ids ??= [];
        for (const c of up.foes) if (!ids.includes(c.objectId)) ids.push(c.objectId);
        // All we ran from that we still know of, in view or not and however far their last known place: out of view
        // behind us is not gone (REMEMBER_MS).
        const chasing = enemies.filter(c => ids.includes(c.objectId));
        if (chasing.length) sq.flee.seen = zoneOf(chasing);
        const turnOdds = Math.min(up.ratio, sizeUp(here, chasing.length ? chasing : up.foes, centre, whole, grudge, allyPool, keep).ratio);
        const safe = atFriends || ourInKeepReach;
        // Only those we can take still following: turn on them (run B 09:42: Hibernia's duo ran 45 s from one Troll at
        // odds 1.18, was caught and lost Aine), once the flee has held FLEE_HOLD_MS, or at once when the odds are far past
        // engageAt; counting the pursuers out of view. The fight logic below takes it from here, as a fight we chose.
        if (following.length && turnOdds >= r.engageAt && (now - sq.flee.start >= FLEE_HOLD_MS || turnOdds >= r.engageAt * TURN_FAR)) {
            sq.flee = null;
            sq.fight = startFight(true);
            held = true;
        } else if (safe || now - sq.flee.lastFollowed >= r.shakenMs) {
            // All we ran from are left alone (avoidMs), not only those still in view: else the next tick hunts the two of
            // the three that came back into view (the user, 14:43 on 11-12). Where they were is theirs as long: one of their
            // realm seen there is with them (N1 on 11-12: a flee turned back on the group it ran from).
            for (const id of ids) sq.avoid[id] = now + r.avoidMs;
            if (sq.flee.seen) putZone(sq.flee.seen, now + r.avoidMs);
            sq.flee = null;
            // At safety with them on us: fight there, beside our friends or under our guards.
            if (safe && following.length) sq.stand = true;
        } else if (now - sq.flee.start >= r.fleeMaxMs) {
            sq.flee = null;
            sq.stand = true;
            sq.caught++;
        } else return fleeOrder(`${following.length} following, odds ${odds}${chasing.length > up.foes.length ? `, ${chasing.length} we ran from` : ''}`, !following.length);
    }
    if (sq.stand && !up.foes.some(c => onUs(c) || dist(c, centre) <= s.engageRadius)) sq.stand = false;

    // ── In a fight that turned: leave it ──
    // A fight we chose is held for FIGHT_HOLD_MS unless the odds fall far past leaveAt (held, above).
    const holding = held && up.foes.length > 0 && up.ratio < r.leaveAt;
    // A friend staying in the fight is not left to it: with one beside us we leave only far past the line (HOLD_FAR).
    const leaveLine = up.allies ? r.leaveAt * HOLD_FAR : r.leaveAt;
    if ((engaged || hit) && up.foes.length && !sq.stand && !held && up.ratio < leaveLine) {
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
            sq.flee = { start: now, lastFollowed: now, to: { x: Math.round(centre.x), y: Math.round(centre.y), z: zAt(centre) }, toward: t.toward, target: t.target, ids: up.foes.map(c => c.objectId), seen: zoneOf(up.foes) };
            sq.fled++;
            return fleeOrder(`odds ${odds} below ${r.leaveAt}${fight?.lost ? `, ${fight.lost}` : ''}`);
        }
    }

    // ── Not fighting: groups we would not take are left alone, and stepped away from when near ──
    // Each group within reach is judged by itself (enemyClusters): one stray at the edge of a group of eight is no lone
    // enemy (run B, 23:11: Camelot's duo engaged a Kobold "1 vs 1" and fled 13 s later from six), and a lone caster of one
    // realm by another realm's group neither (23:13: hunt and avoid flipped every second).
    let worstText = '';
    if (!engaged && !hit && !sq.stand && !held) {
        // The call we are on: on, given up, or done.
        if (call && sq.call) {
            const c = sq.call;
            const odds = call.kind === 'help' ? callOdds(here, call) : Infinity;
            const why = c.state === 'coming' && call.kind === 'help' && now - c.since > CALL_MAX_MS ? `not there after ${Math.round((now - c.since) / 1000)} s`
                : c.state === 'coming' && odds < r.leaveAt * HOLD_FAR ? `odds there ${fmt(odds)} (${here.length}+${call.ours} vs ${call.foes})`
                : c.state === 'arrived' && call.kind === 'help' && now - Math.max(c.arrivedAt ?? now, c.lastFight ?? 0) > CALL_DONE_MS ? 'done' : '';
            if (why) {
                if (why !== 'done') say(call.id, 'left', why);
                sqCallsSeen[call.id] = now + CALL_AGAIN_MS;
                sq.call = undefined;
                call = null;
            }
        }
        // A new one: asked, free, near, and the odds there with our friends counted; unasked, nearer and better.
        if (!call && openCalls.length) {
            const free = p.members.every(m => !m.isDead) && here.length === alive.length && meanHp() >= s.ready.hp && alive.every(m => !usesMana(m) || m.mana >= s.ready.mana);
            for (const c of [...openCalls].sort((a, b) => dist(a.at, centre) - dist(b.at, centre))) {
                if (sqCallsSeen[c.id]) continue;
                const d = dist(c.at, centre);
                const asked = c.asked.includes(opts.unit!);
                const odds = c.kind === 'help' ? callOdds(here, c) : Infinity;
                const no = !free ? `not ready (${Math.round(meanHp())} % health)` : d > CALL_REACH && c.kind === 'help' ? `${Math.round(d)} away` : odds < r.leaveAt ? `odds there ${fmt(odds)} (${here.length}+${c.ours} vs ${c.foes})` : '';
                if (asked && no) {
                    say(c.id, 'declined', no);
                    sqCallsSeen[c.id] = now + CALL_AGAIN_MS;
                    continue;
                }
                if (!asked && (no || c.kind === 'muster' || d > CALL_UNASKED || c.want <= 0 || odds < r.engageAt)) continue;
                sq.call = { id: c.id, kind: c.kind, from: c.from, state: 'coming', since: now };
                sq.answered = (sq.answered ?? 0) + 1;
                say(c.id, 'coming', `${asked ? 'asked' : 'unasked'}, ${Number.isFinite(odds) ? `odds there ${fmt(odds)}, ` : ''}${Math.round(d)} away`);
                call = c;
                break;
            }
        }
        if (call && sq.call && dist(centre, call.at) <= CALL_ARRIVE && sq.call.state === 'coming') {
            sq.call.state = 'arrived';
            sq.call.arrivedAt = now;
            say(call.id, 'arrived', `${up.foes.length} enemies in view`);
        }
    }
    if (call && sq.call && (engaged || hit) && dist(centre, call.at) <= CALL_FIGHT) sq.call.lastFight = now;
    /** Enemies in the call's fight: not kept clear of, and shown to the inner decide. */
    const inCallFight = (c: Point) => !!call && call.kind === 'help' && dist(c, call.at) <= CALL_FIGHT;
    if (!engaged && !hit && !sq.stand && !held) {
        const groups = enemyClusters(enemies, r.joinRadius).filter(cl => cl.some(c => dist(c, centre) <= s.huntRadius));
        const bad: Contact[] = [];
        let worst = Infinity;
        for (const cl of groups) {
            // One we ran from, or one of their realm where they were, brings its group with it: all left alone while we
            // remember them (avoidMs). N1 on 11-12: squads re-engaged the group they had just fled.
            const mid = centroid(cl);
            if (cl.some(inCallFight)) continue;
            const fledUntil = Math.max(0, ...cl.map(c => sq.avoid[c.objectId] ?? 0), ...(sq.zones ?? []).filter(z => (z.fled ?? 0) > now && z.realm === cl[0]!.realm && dist(z, mid) <= z.r).map(z => z.fled!));
            if (fledUntil > now) for (const c of cl) sq.avoid[c.objectId] = Math.max(sq.avoid[c.objectId] ?? 0, fledUntil);
            // The group as a whole is what we would walk into, whichever realms are in it.
            const su = sizeUp(here, cl.map(c => ({ ...c, realm: cl[0]!.realm })), centre, whole, grudge, allyPool, keep);
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
            if (odds < worst) { worst = odds; worstText = `${fmt(odds)} (${side(su.allies)} vs ${cl.length}${outOfView(cl)}${here.some(m => STEALTHERS.has(m.className) && !m.inCombat) ? ', from stealth' : ''})`; }
        }
        const nearest = bad.length ? Math.min(...bad.map(c => dist(c, centre))) : Infinity;
        // A run (sprint) only from those in view closing: a last known place is no one closing.
        const seenBad = bad.filter(inView);
        const nearestSeen = seenBad.length ? Math.min(...seenBad.map(c => dist(c, centre))) : Infinity;
        sq.clearing = nearest <= r.sizeUp || (!!sq.clearing && nearest <= r.sizeUp + CLEAR_SLACK);
        // Closing on us: run (retreat sprints). Run B, 08:32: a group of five walked Camelot's duo down from 3300 to 900 while it
        // stepped away at a walk, then caught it 45 s into the flee and killed both.
        // A hidden stealther (alone or with others hidden) is unseen: it walks away.
        // One enemy player (and its pet) closing is no group to run from: it runs as fast, or shoots (run B 09:15: Skadi, resting
        // after a mob, ran from a lone Celt at 175 and died to it).
        const players = bad.filter(c => !c.isPet).length;
        if (nearestSeen <= r.runAt && worst < r.leaveAt && players >= 2 && !unseen && !atFriends && !ourInKeepReach) {
            const t = fleeTarget(bad);
            sq.flee = { start: now, lastFollowed: now, to: { x: Math.round(centre.x), y: Math.round(centre.y), z: zAt(centre) }, toward: t.toward, target: t.target, ids: bad.map(c => c.objectId) };
            sq.fled++;
            sq.clearing = false;
            return fleeOrder(`${bad.length} closing ${Math.round(nearestSeen)} away, odds ${worstText}`);
        }
        if (sq.clearing) {
            const way = runWay(centre, bad, home?.arrival ?? null);
            const goal = spotAlong(trip, centre, way, r.sizeUp);
            stepLeg(trip, 'avoid', goal, { from: centre, movers: here, replan: 1500 });
            return { phase: 'travel', focus: null, puller: null, cc: [], retreatTo: null, waiting: [], anchor: legAnchor(mem), facing: mem.legFacing, objective: `keep clear of ${bad.length} enemies`, reason: `avoid: odds ${worstText} below ${r.engageAt}, nearest ${Math.round(nearest)} away` };
        }
        // On the way to a call; a muster's rally is held until it says go.
        if (call && sq.call) {
            const d = dist(centre, call.at);
            const what = call.kind === 'muster' ? (call.stage === 'go' ? 'the raid' : 'the rally') : `${call.from}'s fight (${call.why}, ${call.ours} vs ${call.foes})`;
            if (d > CALL_ARRIVE || (call.kind === 'muster' && call.stage !== 'go')) {
                // A raid goes into the keep circle it is after; the others are gone round as ever.
                const avoid = call.kind === 'muster' && call.target ? keeps.filter(k => dist(k, call!.target!) > k.r) : keeps;
                if (d > CALL_ARRIVE) stepLeg({ ...trip, avoid }, 'call', call.at, { from: centre, movers: here, replan: 1500 });
                const odds = call.kind === 'help' ? `, odds there ${fmt(callOdds(here, call))}` : '';
                return { phase: 'travel', focus: null, puller: null, cc: [], retreatTo: null, waiting: [], anchor: d > CALL_ARRIVE ? legAnchor(mem) : { x: Math.round(call.at.x), y: Math.round(call.at.y), z: call.at.z }, facing: mem.legFacing, objective: `answer the call to ${what}`, reason: `call: ${d > CALL_ARRIVE ? `to ${what}, ${Math.round(d)} away` : `at ${what}, waiting for go`}${odds}` };
            }
        }
    } else sq.clearing = false;
    const hidden = new Set([...Object.keys(sq.avoid), ...Object.keys(sq.shun)].map(Number));
    // A fight we are in (taken, held, caught, or they attack us) shows everyone: the avoided ones too.
    const showAll = sq.stand || hit || engaged || held;
    const contacts = showAll ? p.contacts : p.contacts.filter(c => !hidden.has(c.objectId) || nearOnUs(c) || inCallFight(c));
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
    let u = callInner(contacts);
    // In a friend's fight: the target of the nearest friend on one of these enemies, as our own bots see it (the region frame).
    // Two fighting one each, 1000 apart, is how both died (the user, 15:47 on 11-12).
    // Hidden: on the one the opener goes to (sizeUp openOn), soft or alone, which is what the odds were taken on.
    const opener = unseen && up.openOn !== null ? up.foes.find(c => c.objectId === up.openOn) : undefined;
    if (u.phase === 'engage' && opener && u.focus !== opener.objectId && (u.focus === null || up.foes.some(c => c.objectId === u.focus))) {
        u = { ...u, focus: opener.objectId, reason: `${u.reason ?? ''}; open on ${opener.name}#${opener.objectId}` };
    }
    if (u.phase === 'engage' && up.beside.length && !opener) {
        const there = new Map(up.foes.filter(c => !c.isPet).map(c => [c.objectId, c]));
        const on = up.beside.filter(f => f.targetId != null && there.has(f.targetId)).sort((a, b) => dist(a, centre) - dist(b, centre))[0];
        if (on && on.targetId !== u.focus) {
            const t = there.get(on.targetId!)!;
            u = { ...u, focus: t.objectId, reason: `${u.reason ?? ''}; on ${on.name ?? 'a friend'}'s target ${t.name}#${t.objectId}` };
        }
    }
    if (sq.stand && u.phase === 'engage') return { ...u, reason: `caught: ${u.reason ?? ''}` };
    if (u.phase === 'engage' && atCall()) u = { ...u, reason: `${u.reason ?? ''}; at ${call!.from}'s call` };
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
        const secs = Math.round((now - (sq.fight?.start ?? now)) / 1000);
        const why = [up.allies ? `beside ${up.allies} friend${up.allies === 1 ? '' : 's'}` : '', holding ? (committed ? `committed ${secs} s, no losses` : `held ${secs} s of ${FIGHT_HOLD_MS / 1000}`) : ''].filter(Boolean).join(', ');
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
