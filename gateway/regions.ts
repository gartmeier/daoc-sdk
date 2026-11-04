// One region as the gateway's bots see it, for the region page
// (gateway/viewer/region.ts): every in-game bot there with its group, each
// group's current run there (gateway/groups.ts activeRuns: phase, reason,
// focus, anchor, travel leg, score so far), the players the bots see that are
// none of ours, and the keeps when sdk/group/rvr.ts knows the region's
// battleground layout. Three groups of different realms fighting in Thidranki
// are one map here; the group page shows one group at a time.
//
//   GET  /regions                  regions with an in-game bot: bots per realm, zones, groups
//   GET  /regions/<regionId>/live  RegionFrame
//
// gateway/viewer/routes.ts serves both. Auth: /regions says no more than /bots,
// so it needs none. A frame shows a bot only when the request may read its
// /state, and a run only when it may read the run's group (its leader's
// username, as for /groups/<id>/live): the auth hook, kind 'http', with the
// Authorization bearer password, never one from the query string. What is left
// out is counted in `hidden`. The default hook allows everything.
//
// Like groups.ts it only reads the session maps and never writes to a state.
// listRegions and composeRegion are pure; the types are for the browser page.

import type { BotWorldState, GatewayAuthHook, PlayerState, Realm } from './types';
import type { ViewerBotSession } from './viewer/routes';
import type { GroupBadge, RunState } from './group-types';
import type { ActiveRun } from './groups';
import type { Phase, Point, Point3 } from '../sdk/group/types';
import type { BattlegroundLayout } from '../sdk/group/rvr';

/** Nearby players read per bot state (a client reports far fewer). */
const MAX_NEARBY = 500;
const MAX_ENEMIES = 300;
/** An enemy pet's last blow says what it aims at for this long (the board's PLAYER_AIM_MS). */
const PET_AIM_MS = 6000;
const MAX_ROUTE = 200;
const REALMS: readonly string[] = ['none', 'albion', 'midgard', 'hibernia'] satisfies Realm[];

/** An in-game bot in the region (its own state). */
export interface RegionBot {
    username: string;
    /** The gateway's sessionStatus: 'active' or 'stale' (a dead session is not in game). */
    status: string;
    stateAge: number | null;
    name: string;
    objectId: number;
    level: number;
    className: string;
    realm: Realm;
    zoneId: number;
    zoneName: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    /** Percentages. */
    hp: number;
    mana: number;
    endurance: number;
    isDead: boolean;
    isSitting: boolean;
    inCombat: boolean;
    attacking: boolean;
    targetObjectId: number | null;
    realmPoints: number;
    /** The group it plays in (gateway/groups.ts badge). */
    group: { id: string; name: string } | null;
    /** Its window pet: null without one, absent from an older client. */
    pet?: RegionPet | null;
}

/** A bot's window pet. Place and health are its entry's, null while that is out of view. */
export interface RegionPet {
    objectId: number;
    name: string;
    x: number | null;
    y: number | null;
    hp: number | null;
}

/** RunReport.totals so far (the live report, else the result); the RvR numbers only when the run sent them. */
export interface RegionTotals {
    kills: number;
    deaths: number;
    playerKills?: number;
    deathsToPlayers?: number;
    realmPoints?: number;
    enemiesSeen?: number;
    engagements?: number;
}

/** A group's current run with members in the region. */
export interface RegionRun {
    /** Group id (groups/<id>). */
    group: string;
    name: string;
    /** The realm most of its members here play: the colour it is drawn in. */
    realm: Realm;
    runId: string;
    state: RunState;
    strategy: string;
    /** Since its last publish. */
    ageMs: number;
    windingDown: boolean;
    phase: Phase;
    reason: string;
    objective: string;
    /** The focus: one of our bots (by object id), else the run's own contact, else just the id. */
    focus: { objectId: number; name: string; realm: Realm; hp: number | null; ours: boolean } | null;
    anchor: Point3 | null;
    facing: Point | null;
    retreatTo: Point3 | null;
    /** The coordinator's current travel leg and the waypoints after it. */
    leg: Point3 | null;
    route: Point[];
    /** The coordinator's camp: the patrol waypoint it heads for in RvR. */
    camp: { x: number; y: number; label: string } | null;
    totals: RegionTotals | null;
    /** Its members' usernames among the region's bots. */
    members: string[];
    /** Run members alive in this region, and all the run's members. */
    alive: number;
    size: number;
}

/** A player of another realm that a bot sees and that is none of our bots (a human who joined), by object id; or such a player's pet (isPet). */
export interface RegionEnemy {
    objectId: number;
    name: string;
    level: number;
    realm: Realm;
    x: number;
    y: number;
    z: number;
    heading: number;
    hp: number;
    isDead: boolean;
    inCombat: boolean;
    /** Character names of the bots that see it. */
    seenBy: string[];
    /** An enemy pet: the server sends every client the flag and the realm, never who owns it (PacketLib1124.cs:186-187). Absent for a player. */
    isPet?: true;
    /** An enemy pet's aim: what its entry names, else what it last hit (petAim); null with neither. Absent for a player, whose target no client is told. */
    targetId?: number | null;
}

/** A keep of the region's battleground layout (sdk/group/rvr.ts). */
export interface RegionKeep {
    name: string;
    x: number;
    y: number;
    z: number;
    owner: Realm;
    portal: boolean;
    guardLevel: number;
    /** How far RvR groups stay from it when it isn't theirs (RVR_SETTINGS.keepClearance); 0 unknown. */
    clearance: number;
}

/** GET /regions/<regionId>/live */
export interface RegionFrame {
    v: 1;
    regionId: number;
    /** Gateway clock. */
    now: number;
    layout: { name: string; levels: [number, number] } | null;
    bots: RegionBot[];
    runs: RegionRun[];
    enemies: RegionEnemy[];
    keeps: RegionKeep[];
    /** Bots and runs here the request may not read. */
    hidden: { bots: number; runs: number };
}

/** GET /regions */
export interface RegionListEntry {
    regionId: number;
    /** Zone names the bots report, in first-seen order. */
    zones: string[];
    bots: number;
    realms: Partial<Record<Realm, number>>;
    groups: { id: string; name: string }[];
}

export interface RegionSources {
    /** The gateway's botSessions, by username. */
    sessions: ReadonlyMap<string, ViewerBotSession>;
    /** The gateway's own status rule ('active' | 'stale' | 'dead'). */
    sessionStatus(session: any): string;
    groupOf?(username: string): GroupBadge | null;
    /** gateway/groups.ts activeRuns(). */
    runs?: readonly ActiveRun[];
    /** sdk/group/rvr.ts BATTLEGROUND_LAYOUTS[regionId]; null or absent outside a known battleground. */
    layout?: BattlegroundLayout | null;
    keepClearance?: { portal: number; keep: number };
}

// ── small helpers ──────────────────────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const str = (x: unknown, max: number, d = ''): string => (typeof x === 'string' ? x.slice(0, max) : d);
const bool = (x: unknown): boolean => x === true;
const arr = <T>(x: readonly T[] | null | undefined): readonly T[] => (Array.isArray(x) ? x : []);
const lower = (s: string) => s.toLowerCase();
const realmOf = (x: unknown): Realm => (typeof x === 'string' && REALMS.includes(x) ? (x as Realm) : 'none');
const point = (x: unknown): Point | null => (isObj(x) && Number.isFinite(x.x) && Number.isFinite(x.y) ? { x: x.x, y: x.y } : null);
const point3 = (x: unknown): Point3 | null => (isObj(x) && Number.isFinite(x.x) && Number.isFinite(x.y) ? { x: x.x, y: x.y, z: num(x.z) } : null);

/** A bot's player while its client is connected and in game (like /bots), else null. */
function inGamePlayer(session: ViewerBotSession | undefined): PlayerState | null {
    if (!session || session.ws === null || session.ws === undefined) return null;
    const state = session.lastState;
    return state?.inGame && isObj(state.player) ? state.player : null;
}

interface Here { username: string; session: ViewerBotSession; state: BotWorldState; p: PlayerState }

/** The in-game bots standing in a region, by username. */
function botsHere(regionId: number, sessions: ReadonlyMap<string, ViewerBotSession>): Here[] {
    const out: Here[] = [];
    for (const [username, session] of sessions) {
        const p = inGamePlayer(session);
        if (!p || num(p.regionId, NaN) !== regionId || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        out.push({ username, session, state: session.lastState!, p });
    }
    return out.sort((a, b) => a.username.localeCompare(b.username));
}

/** The runs with a member among the region's bots (usernames ignoring case, like the group store). */
function runsHere(runs: readonly ActiveRun[], here: Here[]): ActiveRun[] {
    const names = new Set(here.map(h => lower(h.username)));
    return runs.filter(r => arr(r.usernames).some(u => names.has(lower(u))));
}

function petView(state: BotWorldState): RegionPet | null | undefined {
    const pet: unknown = state.pet;
    if (pet === undefined) return undefined;
    if (!isObj(pet) || !Number.isFinite(pet.objectId)) return null;
    const n = arr(state.nearbyNpcs).find(o => isObj(o) && o.objectId === pet.objectId);
    return { objectId: pet.objectId, name: str(n?.name ?? pet.name, 64), x: numOrNull(n?.x), y: numOrNull(n?.y), hp: numOrNull(n?.healthPercent) };
}

function botView(h: Here, src: RegionSources, now: number): RegionBot {
    const p = h.p;
    const badge = src.groupOf?.(h.username) ?? null;
    const pet = petView(h.state);
    return {
        username: h.username, status: src.sessionStatus(h.session),
        stateAge: h.session.lastStateReceivedAt ? Math.max(0, now - h.session.lastStateReceivedAt) : null,
        name: str(p.name, 64), objectId: num(p.objectId), level: num(p.level), className: str(p.className, 32), realm: realmOf(p.realm),
        zoneId: num(p.zoneId), zoneName: str(p.zoneName, 64), x: num(p.x), y: num(p.y), z: num(p.z), heading: num(p.heading),
        hp: num(p.healthPercent), mana: num(p.manaPercent), endurance: num(p.endurancePercent),
        isDead: bool(p.isDead), isSitting: bool(p.isSitting), inCombat: bool(p.inCombat), attacking: bool(p.attacking),
        targetObjectId: numOrNull(p.targetObjectId), realmPoints: num(p.realmPoints),
        group: badge ? { id: badge.id, name: badge.name } : null,
        ...(pet !== undefined ? { pet } : {}),
    };
}

const RVR_TOTALS = ['playerKills', 'deathsToPlayers', 'realmPoints', 'enemiesSeen', 'engagements'] as const;

/** The score so far: the live report's totals (a JSON copy, so every number is checked), else the result's. */
function totalsOf(run: ActiveRun): RegionTotals | null {
    const t = isObj(run.report) && isObj(run.report.totals) ? run.report.totals : isObj(run.result?.totals) ? run.result!.totals : null;
    if (!t) return null;
    const out: RegionTotals = { kills: num(t.kills), deaths: num(t.deaths) };
    for (const k of RVR_TOTALS) if (Number.isFinite(t[k])) out[k] = t[k] as number;
    return out;
}

/** The realm most of these players play; 'none' without any. */
function majorityRealm(players: PlayerState[]): Realm {
    const votes = new Map<Realm, number>();
    for (const p of players) {
        const r = realmOf(p.realm);
        if (r !== 'none') votes.set(r, (votes.get(r) ?? 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
}

function runView(run: ActiveRun, regionId: number, here: Here[], shown: ReadonlyMap<number, RegionBot>, now: number): RegionRun {
    const o = run.picture.orders;
    const mine = new Set(arr(run.usernames).map(lower));
    const members = here.filter(h => mine.has(lower(h.username)));
    const focusId = numOrNull(o.focus);
    let focus: RegionRun['focus'] = null;
    if (focusId !== null) {
        const bot = shown.get(focusId);
        const c = bot ? undefined : arr(run.picture.contacts).find(x => x.objectId === focusId && x.regionId === regionId);
        focus = bot ? { objectId: focusId, name: bot.name, realm: bot.realm, hp: bot.hp, ours: true }
            : c ? { objectId: focusId, name: str(c.name, 64), realm: realmOf(c.realm), hp: num(c.hp), ours: false }
                : { objectId: focusId, name: `#${focusId}`, realm: 'none', hp: null, ours: false };
    }
    const coord = run.coordinator;
    const camp = coord?.camp && Number.isFinite(coord.camp.x) && Number.isFinite(coord.camp.y)
        ? { x: coord.camp.x, y: coord.camp.y, label: str(coord.camp.names, 120) } : null;
    const reports = arr(run.picture.members);
    return {
        group: run.id, name: run.name, realm: majorityRealm(members.map(h => h.p)), runId: run.runId, state: run.state, strategy: run.strategy,
        ageMs: Math.max(0, now - run.lastAt), windingDown: bool(run.timing?.windingDown),
        phase: o.phase, reason: str(o.reason, 300), objective: str(o.objective, 300), focus,
        anchor: point3(o.anchor), facing: point(o.facing), retreatTo: point3(o.retreatTo),
        leg: point3(coord?.leg), route: arr(coord?.route).slice(0, MAX_ROUTE).map(point).filter((p): p is Point => p !== null), camp,
        totals: totalsOf(run),
        members: members.map(h => h.username),
        alive: reports.filter(m => !m.isDead && m.regionId === regionId).length, size: reports.length,
    };
}

// ── the region frame ───────────────────────────────────────────────────────

/**
 * Regions with an in-game bot, the busiest first: bots per realm, the zones
 * they report and the groups they play in. No more than /bots says.
 */
export function listRegions(src: Pick<RegionSources, 'sessions' | 'groupOf'>): RegionListEntry[] {
    const byRegion = new Map<number, RegionListEntry>();
    for (const [username, session] of src.sessions) {
        const p = inGamePlayer(session);
        const regionId = numOrNull(p?.regionId);
        if (!p || regionId === null) continue;
        let e = byRegion.get(regionId);
        if (!e) byRegion.set(regionId, e = { regionId, zones: [], bots: 0, realms: {}, groups: [] });
        e.bots++;
        const realm = realmOf(p.realm);
        e.realms[realm] = (e.realms[realm] ?? 0) + 1;
        const zone = str(p.zoneName, 64);
        if (zone && !e.zones.includes(zone)) e.zones.push(zone);
        const g = src.groupOf?.(username);
        if (g && !e.groups.some(x => x.id === g.id)) e.groups.push({ id: g.id, name: g.name });
    }
    return [...byRegion.values()].sort((a, b) => b.bots - a.bots || a.regionId - b.regionId);
}

/** What an enemy pet aims at: a caster's entry names that only on its victim's client and for moments (live), and its blows reach every client in view. */
function petAim(state: BotWorldState, n: { objectId: number; targetObjectId?: unknown }): number | null {
    const named = numOrNull(n.targetObjectId);
    if (named !== null) return named;
    const now = num(state.timestamp);
    const blow = arr(state.combatEvents).findLast(e => isObj(e) && e.attackerObjectId === n.objectId && (e.kind === 'melee' || e.kind === 'spellEffect') && now - num(e.receivedAt) < PET_AIM_MS);
    return numOrNull(blow?.targetObjectId);
}

/**
 * One region's frame: its in-game bots (sorted by username), the current runs
 * with a member there, the enemy players the shown bots see that are none of
 * ours and then their pets (deduplicated by object id, the freshest state first) and the layout's
 * keeps. `may(username)` says whether the request may read a bot's state or,
 * for a run, its leader's group. Every bot here counts as ours, shown or not,
 * so a hidden bot never turns up as an enemy marker.
 */
export function composeRegion(regionId: number, src: RegionSources, now: number, may: (username: string) => boolean = () => true): RegionFrame {
    const here = botsHere(regionId, src.sessions);
    const shownHere = here.filter(h => may(h.username));
    const bots = shownHere.map(h => botView(h, src, now));
    const byObject = new Map(bots.map(b => [b.objectId, b]));
    const ours = new Set(here.map(h => num(h.p.objectId, NaN)));
    // Another realm's bot's pet is ours as that bot is: only a stranger's is a marker. A hidden bot's too.
    for (const h of here) for (const id of [h.state.pet?.objectId, ...arr(h.state.summons)]) if (Number.isFinite(id)) ours.add(id as number);

    const enemies = new Map<number, RegionEnemy>();
    const seers = [...shownHere].sort((a, b) => b.session.lastStateReceivedAt - a.session.lastStateReceivedAt);
    for (const h of seers) {
        const seer = str(h.p.name, 64) || h.username;
        const own = realmOf(h.p.realm);
        for (const o of arr(h.state.nearbyPlayers).slice(0, MAX_NEARBY)) {
            if (!isObj(o) || !Number.isFinite(o.objectId) || !Number.isFinite(o.x) || !Number.isFinite(o.y) || ours.has(o.objectId)) continue;
            const realm = realmOf(o.realm);
            if (realm === 'none' || realm === own) continue;
            const known = enemies.get(o.objectId);
            if (known) {
                if (!known.seenBy.includes(seer)) known.seenBy.push(seer);
                continue;
            }
            if (enemies.size >= MAX_ENEMIES) continue;
            enemies.set(o.objectId, {
                objectId: o.objectId, name: str(o.name, 64), level: num(o.level), realm,
                x: o.x, y: o.y, z: num(o.z), heading: num(o.heading), hp: num(o.healthPercent),
                isDead: bool(o.isDead), inCombat: bool(o.inCombat), seenBy: [seer],
            });
        }
    }
    // After every player: a pet takes no player's place in a full list.
    for (const h of seers) {
        const seer = str(h.p.name, 64) || h.username;
        const own = realmOf(h.p.realm);
        for (const n of arr(h.state.nearbyNpcs).slice(0, MAX_NEARBY)) {
            if (!isObj(n) || !bool(n.isPet) || !Number.isFinite(n.objectId) || !Number.isFinite(n.x) || !Number.isFinite(n.y) || ours.has(n.objectId)) continue;
            const realm = realmOf(n.realm);
            if (realm === 'none' || realm === own) continue;
            const known = enemies.get(n.objectId);
            if (known) {
                if (!known.seenBy.includes(seer)) known.seenBy.push(seer);
                known.targetId ??= petAim(h.state, n);
                continue;
            }
            if (enemies.size >= MAX_ENEMIES) continue;
            enemies.set(n.objectId, {
                objectId: n.objectId, name: str(n.name, 64), level: num(n.level), realm,
                x: n.x, y: n.y, z: num(n.z), heading: num(n.heading), hp: num(n.healthPercent),
                isDead: false, inCombat: bool(n.inCombat), seenBy: [seer], isPet: true, targetId: petAim(h.state, n),
            });
        }
    }

    const local = runsHere(arr(src.runs), here);
    const runs = local.filter(r => may(r.leaderUsername)).map(r => runView(r, regionId, here, byObject, now))
        .sort((a, b) => a.name.localeCompare(b.name));
    const layout = src.layout ?? null;
    const clearance = src.keepClearance;
    return {
        v: 1, regionId, now,
        layout: layout ? { name: layout.name, levels: [layout.levels[0], layout.levels[1]] } : null,
        bots, runs, enemies: [...enemies.values()],
        keeps: arr(layout?.keeps).map(k => ({
            name: k.name, x: k.x, y: k.y, z: k.z, owner: k.owner, portal: k.portal, guardLevel: k.guardLevel,
            clearance: clearance ? num(k.portal ? clearance.portal : clearance.keep) : 0,
        })),
        hidden: { bots: here.length - shownHere.length, runs: local.length - runs.length },
    };
}

/**
 * The frame for one request: the auth hook is asked once per username (the
 * region's bots, the leaders of the runs there) with the request's password;
 * without a hook everything is shown. A throwing hook refuses.
 */
export async function regionFrame(regionId: number, src: RegionSources, auth: GatewayAuthHook | undefined, password: string, now = Date.now()): Promise<RegionFrame> {
    const here = botsHere(regionId, src.sessions);
    const names = new Set([...here.map(h => h.username), ...runsHere(arr(src.runs), here).map(r => r.leaderUsername)]);
    const allowed = new Set<string>();
    await Promise.all([...names].map(async username => {
        if (!auth) { allowed.add(username); return; }
        try {
            if ((await auth({ kind: 'http', username, password })).success) allowed.add(username);
        } catch {}
    }));
    return composeRegion(regionId, src, now, u => allowed.has(u));
}

type Rvr = typeof import('../sdk/group/rvr');
let rvr: Rvr | null = null;

/**
 * The battleground layout of a region and the default keep clearance, from
 * sdk/group/rvr.ts, imported on first use (and again after a failed import):
 * null outside a known battleground or when the module fails to load.
 */
export async function regionLayout(regionId: number): Promise<{ layout: BattlegroundLayout; keepClearance: { portal: number; keep: number } } | null> {
    if (!rvr) {
        try { rvr = await import('../sdk/group/rvr'); } catch { return null; }
    }
    const layout = rvr.BATTLEGROUND_LAYOUTS[regionId];
    return layout ? { layout, keepClearance: { ...rvr.RVR_SETTINGS.keepClearance } } : null;
}
