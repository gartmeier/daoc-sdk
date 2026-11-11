// Groups in the gateway: the groups/<id>/group.json folders on its disk, what
// their members' own states show (positions, health, what each client sees),
// and on top the latest publish of a group run (sdk/group/publish.ts): orders,
// activities, the board's contacts, events and the observer's score so far.
//
//   GET  /groups                     every group, its members' status and its current run
//   GET  /groups/<id>/live           GroupFrame (?run= &events= &passive= &planRev= &reportRev=)
//   POST /groups/<id>/publish        a group run's snapshot (GroupPublish) → PublishAck
//   POST /groups/<id>/control        {"kind": "windDown", "runId"} → ControlAnswer
//   GET  /groups/<id>/runs           runs/history.jsonl, the report files, the campaign log tail
//   GET  /groups/<id>/runs/<stamp>   one saved report (?part=json|md|log)
//
// Auth: a group's principal is its leader, as the gateway's own disk names it
// (group.json leader, its bot.env BOT_USERNAME). Reading and publishing need
// what the auth hook wants for that username over HTTP; a wind-down needs the
// control-grade check (security.ts checkControlPassword). Passwords come from
// the Authorization header or a POST body, never from the query string. A
// publish is authenticated right after JSON.parse, before its body is walked.
// activeRuns() hands every current run to the region page (gateway/regions.ts),
// which checks the leader's credential the same way before showing one.
//
// Besides the run's picture it watches the members' states itself (deaths,
// levels, region changes, clients and controllers coming and going), so the
// page can show what happened between runs, when nothing else is watching.
//
// It only observes: it reads the session maps, never sends on a socket and
// writes no files. Every entry point catches its own errors, so a bad publish or
// a broken group.json cannot disturb the bots' traffic, and everything it keeps
// is capped (GROUP_LIMITS).

import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotWorldState, GatewayAuthHook, NearbyNpc, NearbyPlayer, PetAggression, PetWalk, PlayerState, Realm } from './types';
import type { ViewerBotSession } from './viewer/routes';
import type {
    ClientStatus, ControlAnswer, ControlView, GroupBadge, GroupFrame, GroupListEntry, GroupMemberView, GroupRuns,
    HistoryEntry, MemberPlayer, PassiveEvent, RunState, RunView, WorldContact,
} from './group-types';
import { WIRE_VERSION } from '../sdk/group/wire';
import type { CoordinatorView, GroupPublish, LiveReport, PlanView, PublishAck, RunMeta, RunPhase, RunResultView, WireEvent } from '../sdk/group/wire';
import type { Contact, GroupPicture, MemberReport, Orders, PetReport, Phase, Point, Point3, Role } from '../sdk/group/types';
import { roleForClass } from '../sdk/group/strategy';
import { botIdentity, checkControlPassword, isJsonRequest } from './security';

export const GROUP_LIMITS = {
    maxGroups: 64, maxRuns: 24, runsPerGroup: 2, maxPublishBytes: 512 * 1024, maxEventsPerRun: 1000,
    maxEventsPerFrame: 500, maxContacts: 300, maxWorld: 400, maxPassiveEvents: 300, staleMs: 5000, lostMs: 30_000,
    retainEndedMs: 6 * 3600_000, discoveryTtlMs: 5000, trackMs: 1000, trackKeepMs: 60_000, maxSettingsBytes: 16 * 1024,
    maxReportBytes: 128 * 1024, maxPlanBytes: 32 * 1024, maxFileBytes: 1024 * 1024,
};
export type GroupLimits = typeof GROUP_LIMITS;

const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOT = /^[A-Za-z0-9_-]{1,64}$/;
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;
const STAMP = /^\d{8}-\d{6}$/;
const RUN_FILE = /^(\d{8}-\d{6})\.(json|md|log)$/;
const ROLES: readonly string[] = ['tank', 'healer', 'support', 'nuker', 'melee'] satisfies Role[];
const PHASES: readonly string[] = ['idle', 'gather', 'travel', 'recover', 'pull', 'engage', 'retreat'] satisfies Phase[];
const RUN_PHASES: readonly string[] = ['starting', 'running', 'ending', 'ended'] satisfies RunPhase[];
const EVENT_KINDS: readonly string[] = ['orders', 'activity', 'result', 'death', 'kill', 'level', 'note'];
const REALMS: readonly string[] = ['none', 'albion', 'midgard', 'hibernia'] satisfies Realm[];
const PET_AGGRESSION: readonly string[] = ['aggressive', 'defensive', 'passive'] satisfies PetAggression[];
const PET_WALK: readonly string[] = ['follow', 'stay', 'goTarget', 'comeHere'] satisfies PetWalk[];
/** Object ids of pets with no window read per member. */
const MAX_SUMMONS = 32;
/** A contact's optional player flags (Sighting.casting/helped, Contact.healer/caster). */
const PLAYER_SIGNS = ['casting', 'helped', 'healer', 'caster'] as const satisfies readonly (keyof Contact)[];
/** RunReport.totals' optional RvR numbers, also in runs/history.jsonl. */
const RVR_TOTALS = ['playerKills', 'deathsToPlayers', 'realmPoints', 'rpPerHour', 'enemiesSeen', 'engagements'] as const satisfies readonly (keyof RunResultView['totals'])[];
/** The run states in which a run speaks for its group: its members' activities and contacts are current. */
const ACTIVE: ReadonlySet<RunState> = new Set(['starting', 'live', 'stale', 'ending']);
/** A DAoC group holds 8; a group.json listing more than this is a mistake, not a group. */
const MAX_MEMBERS = 32;
const MAX_GROUP_JSON_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 16 * 1024;
/** Nearby objects read per member state (a client reports far fewer). */
const MAX_NEARBY = 500;
/** An NPC's death event counts this long: ids are reused after a mob is removed (sdk/group/blackboard.ts keeps the same). */
const DEATH_EVENT_MS = 5000;
const HISTORY_TAIL_BYTES = 256 * 1024;
const CAMPAIGN_TAIL_BYTES = 64 * 1024;
const CAMPAIGN_LINES = 30;
const MAX_FILE_SETS = 50;
/** The killer is looked for among combat events this recent at the death. */
const DEATH_WINDOW_MS = 15_000;
const ERROR_LOG_MS = 60_000;
/** A valid group path is under 100 characters; anything much longer is refused before it is looked at. */
const MAX_PATH = 512;
/** Nesting a display blob may have (the runner's jsonSafe cuts at 6): JSON.stringify slows sharply past ~10k levels. */
const MAX_JSON_DEPTH = 32;
/** A refused publish or wind-down reads the disk again at most this often (unknown ids cost a stranger nothing). */
const FORCED_DISCOVERY_MS = 1000;

/** A group folder as discovery read it. */
export interface DiskMember { bot: string; username: string; charName: string | null; role: Role | null }
export interface DiskGroup {
    id: string;
    /** The group folder (runs/ lives in it). */
    dir: string;
    name: string;
    /** Leader bot folder and its gateway username: the group's principal for auth. */
    leader: string;
    leaderUsername: string;
    hasCampaign: boolean;
    /** group.json could not be read or is invalid; the group then has no members. */
    error: string | null;
    members: DiskMember[];
    /** Things the page should say ("galahad: no bots/galahad/bot.env, using the folder name"). */
    notes: string[];
}

export interface GroupStoreOptions {
    /** groups/ and bots/ under each, in order (the gateway: [cwd, repo root], deduped). */
    roots: string[];
    /** DAOC_GROUPS_DIR, searched before the roots' groups/. */
    groupsDir?: string;
    /** The gateway's botSessions, by username. */
    sessions: ReadonlyMap<string, ViewerBotSession>;
    /** The gateway's sdkSessions, by session id. */
    sdkSessions: ReadonlyMap<string, { targetUsername: string; mode: 'control' | 'observe'; sdkClientId?: string; sessionId?: string }>;
    /** The gateway's own status rule ('active' | 'stale' | 'dead'). */
    sessionStatus(session: any): string;
    auth: GatewayAuthHook;
    log(...args: unknown[]): void;
    /** Clock (tests). */
    now?: () => number;
    limits?: Partial<GroupLimits>;
}

/**
 * A group's current run while it speaks for its group (starting, live, stale,
 * ending), as its last publish left it: for the region page (gateway/regions.ts).
 * The picture, coordinator, report and result are the store's own objects: read only.
 */
export interface ActiveRun {
    id: string;
    name: string;
    /** The group's principal for auth, like /groups/<id>/live. */
    leaderUsername: string;
    /** group.json members' gateway usernames. */
    usernames: string[];
    runId: string;
    state: RunState;
    strategy: string;
    /** Gateway clock. */
    lastAt: number;
    picture: GroupPicture;
    timing: GroupPublish['timing'];
    coordinator: CoordinatorView | null;
    /** A JSON copy of what the runner sent: check every field before use. */
    report: LiveReport | null;
    result: RunResultView | null;
}

export interface GroupStore {
    /** Answers /groups routes; null for any other path. Never throws (500 JSON on an error). */
    handle(req: Request, url: URL): Promise<Response | null>;
    /** The group a username plays in, for /bots and /status/<bot>. */
    badge(username: string): GroupBadge | null;
    /** Every group's current run while it speaks for its group (no auth: the caller checks the leader). Never throws. */
    activeRuns(): ActiveRun[];
    /** The passive tracker, from the gateway's state branch. Never throws. */
    onState(username: string, state: BotWorldState): void;
    /** Client and controller changes, discovery refresh and the sweep; a 1 s timer calls it. */
    tick(now?: number): void;
    stop(): void;
}

// ── small helpers ──────────────────────────────────────────────────────────

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
/** A run clock: null stays null (a field run's Infinity deadline arrives as JSON null: no end time), anything else as num. */
const runClock = (x: unknown): number | null => (x === null ? null : num(x));
const str = (x: unknown, max: number, d = ''): string => (typeof x === 'string' ? x.slice(0, max) : d);
const strOrNull = (x: unknown, max: number): string | null => (typeof x === 'string' ? x.slice(0, max) : null);
const bool = (x: unknown): boolean => x === true;
const arr = <T>(x: readonly T[] | null | undefined): readonly T[] => (Array.isArray(x) ? x : []);
const lower = (s: string) => s.toLowerCase();
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const roleOf = (x: unknown): Role | null => (typeof x === 'string' && ROLES.includes(x) ? (x as Role) : null);

/** Up to `max` items of an array that `f` accepts (null = skip). */
function list<T>(x: unknown, max: number, f: (v: any) => T | null): T[] {
    if (!Array.isArray(x)) return [];
    const out: T[] = [];
    for (const v of x) {
        if (out.length >= max) break;
        const y = f(v);
        if (y !== null) out.push(y);
    }
    return out;
}
const strings = (x: unknown, max: number, len: number) => list(x, max, v => (typeof v === 'string' ? v.slice(0, len) : null));
/** The optional `keys` of `x` that hold a value of `type` (finite, for numbers); absent ones stay absent. */
function present(x: Record<string, any>, keys: readonly string[], type: 'boolean' | 'number'): Record<string, any> {
    const out: Record<string, any> = {};
    for (const k of keys) if (type === 'boolean' ? typeof x[k] === 'boolean' : Number.isFinite(x[k])) out[k] = x[k];
    return out;
}
const point = (x: unknown): Point | null => (isObj(x) && Number.isFinite(x.x) && Number.isFinite(x.y) ? { x: x.x, y: x.y } : null);
const point3 = (x: unknown): Point3 | null => (isObj(x) && Number.isFinite(x.x) && Number.isFinite(x.y) ? { x: x.x, y: x.y, z: num(x.z) } : null);

/** An untrusted value for an error text: String() of a nested array recurses through all of it. */
const brief = (x: unknown, max = 20): string => (x === null || typeof x !== 'object' ? String(x).slice(0, max) : Array.isArray(x) ? 'an array' : 'an object');

/**
 * The segments of a /groups/... path after "groups", trailing slashes dropped.
 * A loop, not /\/+$/: that regex backtracks quadratically on a run of slashes
 * followed by anything else.
 */
export function groupPath(pathname: string): string[] {
    const parts = pathname.split('/').slice(2);
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
}

/**
 * A JSON copy of `x` when it serialises to at most `maxBytes`, else null. The
 * value is walked first, without recursion, and refused when nested deeper than
 * MAX_JSON_DEPTH or holding more than `maxBytes` values (each takes at least a
 * byte): JSON.stringify never sees an attacker's 20k-deep array.
 */
function jsonCopy(x: unknown, maxBytes: number): { value: unknown } | null {
    const stack: [unknown, number][] = [[x, 0]];
    let values = 1;
    while (stack.length) {
        const [v, depth] = stack.pop()!;
        if (!v || typeof v !== 'object') continue;
        if (depth >= MAX_JSON_DEPTH) return null;
        const children = Array.isArray(v) ? v : Object.values(v);
        values += children.length;
        if (values > maxBytes) return null;
        for (const child of children) stack.push([child, depth + 1]);
    }
    try {
        const text = JSON.stringify(x);
        if (text === undefined || Buffer.byteLength(text) > maxBytes) return null;
        return { value: JSON.parse(text) };
    } catch {
        return null;
    }
}

function isFile(path: string): boolean {
    try { return statSync(path).isFile(); } catch { return false; }
}

function fileSize(path: string): number | null {
    try {
        const st = statSync(path);
        return st.isFile() ? st.size : null;
    } catch {
        return null;
    }
}

/** The last `max` bytes of a file, without the line the cut went through. */
function readTail(path: string, max: number): string {
    const fd = openSync(path, 'r');
    try {
        const size = fstatSync(fd).size;
        const start = Math.max(0, size - max);
        const buf = Buffer.alloc(size - start);
        const read = readSync(fd, buf, 0, buf.length, start);
        let text = buf.subarray(0, read).toString('utf8');
        if (start > 0) {
            const nl = text.indexOf('\n');
            text = nl >= 0 ? text.slice(nl + 1) : '';
        }
        return text;
    } finally {
        closeSync(fd);
    }
}

/** A request body as text, or null once it is larger than `max` bytes (read no further). */
async function readCapped(req: Request, max: number): Promise<string | null> {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) return null;
    if (!req.body) return '';
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
            reader.cancel().catch(() => {});
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

function bearer(req: Request): string {
    const header = req.headers.get('authorization');
    return header?.startsWith('Bearer ') ? header.slice(7) : '';
}

// JSON answers are compact and never cached (the page polls).
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});
const text = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

/** runs/<stamp> of a run, as observer.ts saveReport names it. */
function stampOf(startedAt: string): string {
    return startedAt.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

// ── discovery ──────────────────────────────────────────────────────────────

/**
 * Every groups/<id>/group.json: groupsDir first, then <root>/groups for each
 * root; the first folder of an id wins. Folders starting with _ (the template)
 * are skipped. A group.json that cannot be used is still listed, with its error
 * and no members, so the page can say what is wrong.
 */
export function discoverGroups(roots: string[], groupsDir?: string, maxGroups = GROUP_LIMITS.maxGroups): DiskGroup[] {
    const dirs: string[] = [];
    const seen = new Set<string>();
    for (const dir of [groupsDir, ...roots.map(root => join(root, 'groups'))]) {
        if (!dir) continue;
        const abs = resolve(dir);
        const key = process.platform === 'win32' ? lower(abs) : abs;
        if (!seen.has(key)) {
            seen.add(key);
            dirs.push(abs);
        }
    }
    const out: DiskGroup[] = [];
    const ids = new Set<string>();
    for (const dir of dirs) {
        let names: string[];
        try { names = readdirSync(dir).sort(); } catch { continue; }
        for (const id of names) {
            if (out.length >= maxGroups) break;
            if (!GROUP_ID.test(id) || id.startsWith('_') || ids.has(id)) continue;
            const folder = join(dir, id);
            if (!isFile(join(folder, 'group.json'))) continue;
            ids.add(id);
            out.push(readGroup(id, folder, roots));
        }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What is wrong with a parsed group.json (the rules of sdk/group/roster.ts loadGroup), or null. */
function definitionProblem(def: any): string | null {
    if (!isObj(def)) return 'expected a JSON object';
    if (!Array.isArray(def.members) || !def.members.length) return '"members" must list at least one { "bot": "<name>" }';
    if (def.members.length > MAX_MEMBERS) return `more than ${MAX_MEMBERS} members`;
    for (const [i, m] of def.members.entries()) {
        if (!isObj(m) || typeof m.bot !== 'string' || !BOT.test(m.bot)) return `member ${i + 1} needs a "bot" folder name (letters, digits, _ and -)`;
        if (m.role !== undefined && !roleOf(m.role)) return `${m.bot} has role ${JSON.stringify(m.role).slice(0, 40)}; use one of ${ROLES.join(', ')}`;
    }
    // The bench (bots that sit out) is not shown; it is checked only so that a bot is in one place.
    if (def.bench !== undefined) {
        if (!Array.isArray(def.bench) || def.bench.length > MAX_MEMBERS) return `"bench" must list at most ${MAX_MEMBERS} { "bot": "<name>" }`;
        const playing = new Set(def.members.map((m: { bot: string }) => m.bot));
        for (const [i, m] of def.bench.entries()) {
            if (!isObj(m) || typeof m.bot !== 'string' || !BOT.test(m.bot)) return `bench entry ${i + 1} needs a "bot" folder name (letters, digits, _ and -)`;
            if (playing.has(m.bot)) return `${m.bot} is both a member and on the bench`;
        }
    }
    return null;
}

function readGroup(id: string, dir: string, roots: string[]): DiskGroup {
    const group: DiskGroup = {
        id, dir, name: id, leader: '', leaderUsername: '', hasCampaign: isFile(join(dir, 'runs', 'campaign.log')),
        error: null, members: [], notes: [],
    };
    let def: any;
    try {
        const file = join(dir, 'group.json');
        if (statSync(file).size > MAX_GROUP_JSON_BYTES) throw new Error(`larger than ${MAX_GROUP_JSON_BYTES} bytes`);
        def = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
        group.error = `group.json: ${errorText(error).slice(0, 200)}`;
        return group;
    }
    if (isObj(def) && typeof def.name === 'string' && def.name.trim()) group.name = def.name.trim().slice(0, 64);
    const problem = definitionProblem(def);
    if (problem) {
        group.error = `group.json: ${problem}`;
        return group;
    }
    for (const m of def.members as { bot: string; role?: Role }[]) {
        const who = botIdentity(m.bot, roots);
        if (!who) group.notes.push(`${m.bot}: no bots/${m.bot}/bot.env, using the folder name`);
        group.members.push({ bot: m.bot, username: (who?.username ?? m.bot).slice(0, 64), charName: who?.charName?.slice(0, 64) ?? null, role: m.role ?? null });
    }
    const named = typeof def.leader === 'string' ? group.members.find(m => m.bot === def.leader) : undefined;
    const leader = named ?? group.members[0]!;
    if (def.leader !== undefined && !named) group.notes.push(`leader ${String(def.leader).slice(0, 64)} is not a member: ${leader.bot} leads`);
    group.leader = leader.bot;
    group.leaderUsername = leader.username;
    return group;
}

// ── the passive picture: the members' own states ───────────────────────────

/** Where the passive picture reads from: the gateway's session maps and its status rule. */
export type SessionSources = Pick<GroupStoreOptions, 'sessions' | 'sdkSessions' | 'sessionStatus'>;

export interface PassiveView {
    members: GroupMemberView[];
    world: WorldContact[];
    grouping: GroupFrame['grouping'];
}

/** A member's session by gateway username: the exact key first, then ignoring case. */
function sessionFinder(sessions: SessionSources['sessions']): (username: string) => { key: string; session: ViewerBotSession } | null {
    let byLower: Map<string, string> | null = null;
    return username => {
        const exact = sessions.get(username);
        if (exact) return { key: username, session: exact };
        if (!byLower) {
            byLower = new Map();
            for (const key of sessions.keys()) if (!byLower.has(lower(key))) byLower.set(lower(key), key);
        }
        const key = byLower.get(lower(username));
        const session = key === undefined ? undefined : sessions.get(key);
        return key !== undefined && session ? { key, session } : null;
    };
}

/** Control sessions (id, label) and the observer count per target username (exact, like the gateway). */
function sdkCounts(sdkSessions: SessionSources['sdkSessions']): Map<string, { control: { id: string; label: string }[]; observers: number }> {
    const out = new Map<string, { control: { id: string; label: string }[]; observers: number }>();
    for (const [id, s] of sdkSessions) {
        let entry = out.get(s.targetUsername);
        if (!entry) out.set(s.targetUsername, entry = { control: [], observers: 0 });
        if (s.mode === 'control') entry.control.push({ id: s.sessionId ?? id, label: s.sdkClientId ?? 'sdk' });
        else entry.observers++;
    }
    return out;
}

const clientStatus = (src: SessionSources, session: ViewerBotSession | undefined): ClientStatus => {
    if (!session) return 'none';
    const s = src.sessionStatus(session);
    return s === 'active' || s === 'stale' ? s : 'dead';
};

function memberPlayer(p: PlayerState): MemberPlayer {
    return {
        name: str(p.name, 64), objectId: num(p.objectId), level: num(p.level), levelPermill: num(p.levelPermill),
        className: str(p.className, 32), realm: str(p.realm, 16, 'none'),
        regionId: num(p.regionId), zoneId: num(p.zoneId), zoneName: str(p.zoneName, 64),
        x: num(p.x), y: num(p.y), z: num(p.z), heading: num(p.heading), speed: num(p.speed),
        hp: num(p.healthPercent), mana: num(p.manaPercent), endurance: num(p.endurancePercent),
        concentration: num(p.concentration), maxConcentration: num(p.maxConcentration),
        isDead: bool(p.isDead), isSitting: bool(p.isSitting), inCombat: bool(p.inCombat), attacking: bool(p.attacking),
        targetObjectId: numOrNull(p.targetObjectId),
        load: p.encumbrance && num(p.encumbrance.max) > 0 ? Math.round(100 * num(p.encumbrance.current) / p.encumbrance.max) : null,
        deathCount: num(p.deathCount), constitutionLost: num(p.constitutionLost),
    };
}

/** A PetReport from anything: null for no usable pet. What doesn't parse reads as what a pet starts on (PetState). */
function petOf(x: unknown): PetReport | null {
    if (!isObj(x) || !Number.isFinite(x.objectId)) return null;
    return {
        objectId: x.objectId, name: str(x.name, 64), level: numOrNull(x.level), x: numOrNull(x.x), y: numOrNull(x.y), z: numOrNull(x.z), hp: numOrNull(x.hp),
        targetId: numOrNull(x.targetId), inCombat: bool(x.inCombat),
        aggression: (PET_AGGRESSION.includes(x.aggression) ? x.aggression : 'defensive') as PetAggression,
        walk: (PET_WALK.includes(x.walk) ? x.walk : 'follow') as PetWalk,
        icons: list(x.icons, 8, numOrNull),
    };
}

/** A member's window pet as its own state has it: the window says what it does, its entry where it is. Undefined from an older client. */
function statePet(state: BotWorldState): PetReport | null | undefined {
    const pet: unknown = state.pet;
    if (pet === undefined) return undefined;
    if (!isObj(pet)) return null;
    const n = arr(state.nearbyNpcs).find(o => isObj(o) && o.objectId === pet.objectId);
    return petOf({
        objectId: pet.objectId, name: n?.name ?? pet.name, level: n?.level, x: n?.x, y: n?.y, z: n?.z, hp: n?.healthPercent,
        // From the window: a caster pet's entry reads 0 while it casts and 65535 while it walks.
        targetId: pet.targetObjectId, inCombat: n?.inCombat, aggression: pet.aggression, walk: pet.walk, icons: pet.icons,
    });
}

/**
 * The group as its members' own states show it, with no run: every member in
 * roster order (the last known player stays after its client left), and the
 * NPCs and players they see merged by region and object id. Pure: it copies
 * before sorting and never writes to the states.
 */
export function composePassive(group: DiskGroup, src: SessionSources, now: number, maxWorld = GROUP_LIMITS.maxWorld): PassiveView {
    const find = sessionFinder(src.sessions);
    const sdks = sdkCounts(src.sdkSessions);
    const members: GroupMemberView[] = [];
    const usable: { name: string; player: PlayerState; state: BotWorldState; at: number }[] = [];
    for (const m of group.members) {
        const found = find(m.username);
        const session = found?.session;
        const state = session?.lastState ?? null;
        const status = clientStatus(src, session);
        const p = state?.inGame && isObj(state.player) ? state.player : null;
        const counts = sdks.get(found?.key ?? m.username);
        const live = (status === 'active' || status === 'stale') && !!p;
        const mv = state?.movement;
        const pet = live ? statePet(state!) : undefined;
        const summons = live ? list(state!.summons, MAX_SUMMONS, numOrNull) : [];
        members.push({
            bot: m.bot, username: m.username, charName: m.charName,
            role: m.role ?? (p ? roleForClass(p.className) : null),
            leader: m.bot === group.leader,
            client: {
                status,
                stateAge: session?.lastStateReceivedAt ? Math.max(0, now - session.lastStateReceivedAt) : null,
                phase: strOrNull(state?.connection?.phase, 32),
                lastError: strOrNull(state?.connection?.lastError, 300),
                controllers: counts?.control.length ?? 0,
                observers: counts?.observers ?? 0,
            },
            player: p ? memberPlayer(p) : null,
            movement: live && isObj(mv) ? {
                moving: bool(mv.moving),
                destination: point3(mv.destination),
                waypoints: list(mv.waypoints, 50, point3),
            } : null,
            inGameGroup: list(state?.group, 16, g => (isObj(g) && typeof g.name === 'string' && g.name ? g.name.slice(0, 64) : null)),
            run: null,
            ...(pet !== undefined ? { pet } : {}),
            ...(summons.length ? { summons } : {}),
        });
        if (live) usable.push({ name: str(p!.name, 64), player: p!, state: state!, at: session!.lastStateReceivedAt });
    }

    // Members are not contacts, and they name an NPC's target: `${regionId}:${objectId}` → character name. Only
    // from live states: the server hands a departed member's object id to the next object it adds. A member
    // whose client left can still stand in the world (link-dead for a minute): the others see it as a player
    // by its character name, unique on the server.
    const rosterNames = new Map<string, string>();
    for (const v of members) {
        const shown = v.player?.name || v.charName;
        for (const n of [v.player?.name, v.charName]) if (n && shown) rosterNames.set(lower(n), shown);
    }
    const memberAt = new Map<string, string>();
    for (const u of usable) {
        const region = num(u.player.regionId);
        memberAt.set(`${region}:${num(u.player.objectId)}`, u.name);
        for (const o of arr(u.state.nearbyPlayers).slice(0, MAX_NEARBY)) {
            const name = isObj(o) && typeof o.name === 'string' && Number.isFinite(o.objectId) ? rosterNames.get(lower(o.name)) : undefined;
            if (name) memberAt.set(`${region}:${o.objectId}`, name);
        }
    }
    // Whose pet an object is, the same way and from the same live states. Apart, as a window names its pet outright (a charm can
    // stay a mob for the others), while an id in summons can be old: it lingers up to 30 s and the server hands it on (BotWorldState.summons).
    const windowPets = new Map<string, string>();
    const summoned = new Map<string, string>();
    for (const u of usable) {
        const region = num(u.player.regionId);
        for (const id of list(u.state.summons, MAX_SUMMONS, numOrNull)) summoned.set(`${region}:${id}`, u.name);
        if (isObj(u.state.pet) && Number.isFinite(u.state.pet.objectId)) windowPets.set(`${region}:${u.state.pet.objectId}`, u.name);
    }
    const world = new Map<string, WorldContact>();
    // Freshest state first, so the first sighting of an object is the newest.
    for (const u of [...usable].sort((a, b) => b.at - a.at)) {
        const region = num(u.player.regionId);
        const see = (o: NearbyNpc | NearbyPlayer, kind: 'npc' | 'player') => {
            if (!isObj(o) || !Number.isFinite(o.objectId) || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return;
            const key = `${region}:${o.objectId}`;
            if (memberAt.has(key)) return;
            const known = world.get(key);
            if (known) {
                if (!known.seenBy.includes(u.name)) known.seenBy.push(u.name);
                return;
            }
            const npc = kind === 'npc' ? o as NearbyNpc : null;
            const pc = kind === 'player' ? o as NearbyPlayer : null;
            const targetObjectId = npc ? numOrNull(npc.targetObjectId) : null;
            // The server rounds health down, so a living one can read 0 % (GameLiving.cs:2621). A player dies by its dead flag only, an NPC
            // by a fresh death event; without one it is floored at 1, as the board does it (observeState): the viewers read hp 0 as dead.
            const npcAtZero = !!npc && num(o.healthPercent, 100) <= 0;
            const npcDied = npcAtZero && arr(u.state.combatEvents).some(e => isObj(e) && e.kind === 'death' && e.targetObjectId === o.objectId && num(u.state.timestamp) - num(e.receivedAt) < DEATH_EVENT_MS);
            const owner = npc ? windowPets.get(key) ?? (npc.isPet ? summoned.get(key) : undefined) : undefined;
            const targetKey = `${region}:${targetObjectId}`;
            const targetPet = targetObjectId === null || memberAt.has(targetKey) ? undefined : windowPets.get(targetKey) ?? summoned.get(targetKey);
            world.set(key, {
                key, objectId: o.objectId, regionId: region, kind,
                name: str(o.name, 64), level: num(o.level), realm: str(o.realm, 16, 'none'),
                x: o.x, y: o.y, z: num(o.z), heading: num(o.heading), speed: num(npc?.speed),
                hp: npcAtZero && !npcDied ? 1 : num(o.healthPercent), inCombat: bool(o.inCombat),
                isDead: pc ? bool(pc.isDead) : npcDied,
                targetObjectId,
                target: targetObjectId === null ? null : memberAt.get(targetKey) ?? null,
                ...(targetPet ? { targetPet } : {}),
                npc: npc ? { isPeaceful: bool(npc.isPeaceful), isTargetable: npc.isTargetable !== false, isPet: bool(npc.isPet) || !!owner, role: strOrNull(npc.role, 32), ...(owner ? { owner } : {}) } : null,
                // A pet of ours has an owner, whichever member's report this is. A monster's has no realm.
                enemy: (!!pc || (!!npc && bool(npc.isPet) && !owner)) && o.realm !== u.player.realm && o.realm !== 'none',
                ...(pc && bool(pc.isShade) ? { isShade: true as const } : {}),
                seenBy: [u.name],
                nearest: Infinity,
                board: null,
            });
        };
        for (const o of arr(u.state.nearbyNpcs).slice(0, MAX_NEARBY)) see(o, 'npc');
        for (const o of arr(u.state.nearbyPlayers).slice(0, MAX_NEARBY)) see(o, 'player');
    }
    for (const c of world.values()) {
        for (const u of usable) {
            if (num(u.player.regionId) !== c.regionId) continue;
            c.nearest = Math.min(c.nearest, Math.round(Math.hypot(c.x - num(u.player.x), c.y - num(u.player.y))));
        }
    }

    // The leader's in-game group (or the largest member list) against the roster.
    const names = members.map(v => v.player?.name || v.charName).filter((n): n is string => !!n);
    const leader = members.find(v => v.leader);
    let inGame = leader?.inGameGroup ?? [];
    if (!inGame.length) for (const v of members) if (v.inGameGroup.length > inGame.length) inGame = v.inGameGroup;
    const grouped = new Set(inGame.map(lower));
    const roster = new Set(names.map(lower));
    return {
        members,
        world: [...world.values()].sort((a, b) => a.nearest - b.nearest).slice(0, maxWorld),
        grouping: {
            inLeaderGroup: names.filter(n => grouped.has(lower(n))),
            // Alone, nobody is missing: a one-member group has no in-game group.
            missing: inGame.length || names.length > 1 ? names.filter(n => !grouped.has(lower(n))) : [],
            strangers: inGame.filter(n => !roster.has(lower(n))),
        },
    };
}

// ── runs ───────────────────────────────────────────────────────────────────

/** What the gateway keeps of one run: the last snapshot, its events and control requests. */
interface RunRecord {
    runId: string;
    groupId: string;
    /** Creation order, to break firstAt ties. */
    order: number;
    declared: RunPhase;
    /** Gateway clock. */
    firstAt: number;
    lastAt: number;
    lastPublishSeq: number;
    /** receivedAt − sentAt of the last 10 publishes. */
    skews: number[];
    error: string | null;
    meta: RunMeta;
    picture: GroupPicture;
    timing: GroupPublish['timing'];
    coordinator: CoordinatorView | null;
    plan: PlanView | null;
    planRev: number;
    report: LiveReport | null;
    reportRev: number;
    /** Oldest first, seq ascending, at most maxEventsPerRun. */
    events: WireEvent[];
    lastEventSeq: number;
    /** Holes in the stored seqs. The runner's outbox drops are such holes, so GroupPublish.dropped is not added. */
    lostEvents: number;
    /** At most one: a second wind-down returns the first. */
    control: ControlView[];
    result: RunResultView | null;
    notes: string[];
}

/** A run's state from its declared phase and the age of its last publish (the table in group-types.ts). */
export function runStateOf(run: { declared: RunPhase; lastAt: number }, now: number, limits: Partial<GroupLimits> = {}): RunState {
    const staleMs = limits.staleMs ?? GROUP_LIMITS.staleMs;
    const lostMs = limits.lostMs ?? GROUP_LIMITS.lostMs;
    const age = now - run.lastAt;
    if (run.declared === 'ended') return 'ended';
    if (run.declared === 'ending') return age <= lostMs ? 'ending' : 'ended';
    if (age > lostMs) return 'lost';
    if (run.declared === 'starting') return 'starting';
    return age <= staleMs ? 'live' : 'stale';
}

const newer = (a: RunRecord, b: RunRecord) => a.firstAt > b.firstAt || (a.firstAt === b.firstAt && a.order > b.order);

/** The group's current run: the newest one starting, live, stale or ending, else the newest. */
function currentOf(runs: RunRecord[], now: number, limits: GroupLimits): RunRecord | null {
    let active: RunRecord | null = null;
    let newest: RunRecord | null = null;
    for (const r of runs) {
        if (!newest || newer(r, newest)) newest = r;
        if (ACTIVE.has(runStateOf(r, now, limits)) && (!active || newer(r, active))) active = r;
    }
    return active ?? newest;
}

function skewOf(r: RunRecord): number {
    if (!r.skews.length) return 0;
    return Math.max(-86_400_000, Math.min(86_400_000, Math.min(...r.skews)));
}

// ── publish sanitising ─────────────────────────────────────────────────────

function memberReport(x: any): MemberReport | null {
    if (!isObj(x) || typeof x.bot !== 'string') return null;
    const caps = isObj(x.capabilities) ? x.capabilities : {};
    const act = isObj(x.activity) ? x.activity : {};
    return {
        name: str(x.name, 64), bot: x.bot.slice(0, 64), role: roleOf(x.role) ?? 'melee', className: str(x.className, 32),
        level: num(x.level), experience: num(x.experience), ...present(x, ['realmPoints'], 'number'), objectId: num(x.objectId), regionId: num(x.regionId),
        ...(x.pet === undefined ? {} : { pet: petOf(x.pet) }), ...(Array.isArray(x.summons) ? { summons: list(x.summons, MAX_SUMMONS, numOrNull) } : {}),
        x: num(x.x), y: num(x.y), z: num(x.z), hp: num(x.hp), mana: num(x.mana), endurance: num(x.endurance), load: num(x.load),
        isDead: bool(x.isDead), isSitting: bool(x.isSitting), inCombat: bool(x.inCombat), attacking: bool(x.attacking),
        targetId: numOrNull(x.targetId), effects: strings(x.effects, 64, 64),
        // buffSpells stay with the runner (it strips them too): nothing here draws them.
        capabilities: { heal: bool(caps.heal), cc: bool(caps.cc), nuke: bool(caps.nuke), ...present(caps, ['rez'], 'boolean'), buffs: strings(caps.buffs, 32, 64), buffSpells: [], ...(caps.pet === 'main' || caps.pet === 'fnf' || caps.pet === null ? { pet: caps.pet } : {}) },
        activity: { kind: str(act.kind, 32, 'unknown'), targetId: numOrNull(act.targetId), detail: str(act.detail, 200), since: num(act.since) },
        at: num(x.at),
    };
}

function contactOf(x: any): Contact | null {
    if (!isObj(x) || !Number.isFinite(x.objectId)) return null;
    return {
        objectId: x.objectId, kind: x.kind === 'player' ? 'player' : 'npc', name: str(x.name, 64), level: num(x.level),
        realm: (REALMS.includes(x.realm) ? x.realm : 'none') as Realm,
        x: num(x.x), y: num(x.y), z: num(x.z), hp: num(x.hp), targetId: numOrNull(x.targetId),
        inCombat: bool(x.inCombat), swinging: bool(x.swinging), ...present(x, PLAYER_SIGNS, 'boolean'), ...present(x, ['isPet'], 'boolean'), regionId: num(x.regionId), target: strOrNull(x.target, 64),
        ...(x.targetPet === undefined ? {} : { targetPet: strOrNull(x.targetPet, 64) }),
        targetSince: num(x.targetSince), engagedAt: num(x.engagedAt), movedAt: num(x.movedAt), seenBy: strings(x.seenBy, 16, 64),
        firstSeen: num(x.firstSeen), lastSeen: num(x.lastSeen), stale: bool(x.stale), threat: bool(x.threat),
        hostileSince: num(x.hostileSince),
        cc: isObj(x.cc) ? { by: str(x.cc.by, 64), kind: str(x.cc.kind, 16), until: num(x.cc.until) } : null,
    };
}

function ordersOf(x: unknown): Orders {
    const o = isObj(x) ? x : {};
    return {
        seq: num(o.seq), phase: (PHASES.includes(o.phase) ? o.phase : 'idle') as Phase, objective: str(o.objective, 300),
        anchor: point3(o.anchor), facing: point(o.facing), focus: numOrNull(o.focus), puller: strOrNull(o.puller, 64),
        cc: list(o.cc, 16, c => (isObj(c) && Number.isFinite(c.targetId) ? { targetId: c.targetId as number, by: str(c.by, 64) } : null)),
        retreatTo: point3(o.retreatTo),
        waiting: list(o.waiting, 16, w => (isObj(w) ? { name: str(w.name, 64), why: str(w.why, 16) } : null)),
        reason: str(o.reason, 300), issuedAt: num(o.issuedAt),
    };
}

function coordinatorOf(x: unknown): CoordinatorView | null {
    if (!isObj(x)) return null;
    const camp = isObj(x.camp) && Number.isFinite(x.camp.x) && Number.isFinite(x.camp.y)
        ? { x: x.camp.x as number, y: x.camp.y as number, z: num(x.camp.z), zone: str(x.camp.zone, 64), count: num(x.camp.count), names: str(x.camp.names, 300) }
        : null;
    return {
        camp, campLevel: numOrNull(x.campLevel), base: point3(x.base), facing: point(x.facing),
        route: list(x.route, 200, point), leg: point3(x.leg), avoidCamps: list(x.avoidCamps, 50, point),
        excluded: list(x.excluded, 50, numOrNull),
    };
}

function planOf(x: unknown): PlanView | null {
    if (!isObj(x)) return null;
    const base = point3(x.base);
    if (!base) return null;
    return {
        base, facing: point(x.facing) ?? { x: base.x, y: base.y }, score: num(x.score), margin: num(x.margin),
        targets: list(x.targets, 64, t => (isObj(t) && Number.isFinite(t.x) && Number.isFinite(t.y)
            ? { name: str(t.name, 64), level: num(t.level), x: t.x as number, y: t.y as number, d: num(t.d) } : null)),
        unsafe: list(x.unsafe, 64, u => (isObj(u) && Number.isFinite(u.x) && Number.isFinite(u.y)
            ? { name: str(u.name, 64), level: num(u.level), x: u.x as number, y: u.y as number, why: str(u.why, 120) } : null)),
    };
}

function metaOf(x: unknown, limits: GroupLimits, notes: string[]): RunMeta | null {
    if (!isObj(x)) return null;
    let settings: unknown = null;
    if (x.settings !== undefined && x.settings !== null) {
        const copy = jsonCopy(x.settings, limits.maxSettingsBytes);
        if (copy) settings = copy.value;
        else notes.push(`the run's settings were over ${limits.maxSettingsBytes} bytes (or nested over ${MAX_JSON_DEPTH} deep) and are not shown`);
    }
    return {
        strategy: str(x.strategy, 64), description: strOrNull(x.description, 500), startedAt: num(x.startedAt),
        stamp: typeof x.stamp === 'string' && STAMP.test(x.stamp) ? x.stamp : null,
        seconds: num(x.seconds), graceMs: num(x.graceMs),
        members: list(x.members, MAX_MEMBERS, m => (isObj(m) && typeof m.bot === 'string' ? {
            bot: m.bot.slice(0, 64), username: str(m.username, 64), name: str(m.name, 64), role: roleOf(m.role) ?? 'melee',
            className: str(m.className, 32), level: num(m.level), behaviors: strings(m.behaviors, 32, 64),
        } : null)),
        settings, pid: num(x.pid),
        // Missing means the runner predates the flag: it applies wind-downs.
        control: x.control !== false,
    };
}

function eventOf(x: any): WireEvent | null {
    if (!isObj(x) || !Number.isSafeInteger(x.seq) || x.seq < 1 || !EVENT_KINDS.includes(x.kind)) return null;
    const e: WireEvent = { seq: x.seq, at: num(x.at), kind: x.kind, text: str(x.text, 300) };
    if (typeof x.member === 'string') e.member = x.member.slice(0, 64);
    if (x.targetId !== undefined) e.targetId = numOrNull(x.targetId);
    if (isObj(x.data)) e.data = (jsonCopy(x.data, 512)?.value as Record<string, unknown> | undefined) ?? { truncated: true };
    return e;
}

function resultOf(x: unknown): RunResultView | undefined {
    if (!isObj(x)) return undefined;
    const t = isObj(x.totals) ? x.totals : {};
    return {
        totals: {
            kills: num(t.kills), deaths: num(t.deaths), wipes: num(t.wipes), retreats: num(t.retreats), fights: num(t.fights),
            killsPerHour: num(t.killsPerHour), xpPerHour: num(t.xpPerHour), avgFightMs: num(t.avgFightMs), downtime: num(t.downtime),
            tankHold: numOrNull(t.tankHold), ...present(t, RVR_TOTALS, 'number'),
        },
        findings: strings(x.findings, 50, 300),
        stamp: typeof x.stamp === 'string' && STAMP.test(x.stamp) ? x.stamp : null,
        stoppedBy: x.stoppedBy === 'viewer' || x.stoppedBy === 'error' ? x.stoppedBy : 'time',
    };
}

/**
 * A whitelisted copy of a publish: every field the gateway keeps is checked by
 * type, numbers are finite, strings truncated, arrays capped. The display-only
 * blobs (meta.settings, report, event data) are kept as JSON copies when under
 * their size caps and MAX_JSON_DEPTH, else dropped (with a note, or for event
 * data { truncated: true }). Anything else in the body is left behind.
 */
export function sanitizePublish(raw: unknown, limits: Partial<GroupLimits> = {}): { ok: true; value: GroupPublish; notes: string[] } | { ok: false; error: string } {
    const L: GroupLimits = { ...GROUP_LIMITS, ...limits };
    const notes: string[] = [];
    if (!isObj(raw)) return { ok: false, error: 'the body must be a JSON object' };
    if (raw.v !== WIRE_VERSION) return { ok: false, error: `wire version ${brief(raw.v)} is not supported (this gateway speaks v${WIRE_VERSION})` };
    if (typeof raw.runId !== 'string' || !RUN_ID.test(raw.runId)) return { ok: false, error: 'runId must match ^[A-Za-z0-9-]{8,64}$' };
    if (!Number.isSafeInteger(raw.publishSeq) || raw.publishSeq < 0) return { ok: false, error: 'publishSeq must be a whole number' };
    if (!Number.isFinite(raw.sentAt)) return { ok: false, error: 'sentAt must be a number (ms epoch)' };
    if (typeof raw.group !== 'string' || !GROUP_ID.test(raw.group)) return { ok: false, error: 'group must be a group folder name' };
    if (typeof raw.leader !== 'string' || !BOT.test(raw.leader)) return { ok: false, error: 'leader must be a bot folder name' };
    if (!RUN_PHASES.includes(raw.state)) return { ok: false, error: 'state must be starting, running, ending or ended' };
    const meta = metaOf(raw.meta, L, notes);
    if (!meta) return { ok: false, error: 'meta must be an object' };
    if (!isObj(raw.picture)) return { ok: false, error: 'picture must be an object' };
    const timing = isObj(raw.timing) ? raw.timing : {};
    const value: GroupPublish = {
        v: WIRE_VERSION,
        runId: raw.runId,
        publishSeq: raw.publishSeq,
        sentAt: raw.sentAt,
        group: raw.group,
        leader: raw.leader,
        roster: list(raw.roster, MAX_MEMBERS, r => (isObj(r) && typeof r.username === 'string' ? { bot: str(r.bot, 64), username: r.username.slice(0, 64) } : null)),
        state: raw.state,
        error: strOrNull(raw.error, 500),
        meta,
        picture: {
            at: num(raw.picture.at),
            members: list(raw.picture.members, MAX_MEMBERS, memberReport),
            contacts: list(raw.picture.contacts, L.maxContacts, contactOf),
            orders: ordersOf(raw.picture.orders),
        },
        timing: { windingDown: bool(timing.windingDown), deadline: runClock(timing.deadline), hardStop: runClock(timing.hardStop) },
        coordinator: coordinatorOf(raw.coordinator),
        planRev: num(raw.planRev),
        reportRev: num(raw.reportRev),
        events: list(raw.events, L.maxEventsPerFrame, eventOf),
        dropped: Math.max(0, num(raw.dropped)),
        applied: strings(raw.applied, 16, 64),
    };
    // Absent = unchanged since the last publish; null = none.
    if (raw.plan === null) value.plan = null;
    else if (raw.plan !== undefined) {
        const plan = planOf(raw.plan);
        if (plan && Buffer.byteLength(JSON.stringify(plan)) <= L.maxPlanBytes) value.plan = plan;
        else notes.push(plan ? `the run's plan was over ${L.maxPlanBytes} bytes and is not shown` : 'the run sent a plan the gateway could not read');
    }
    if (raw.report === null) value.report = null;
    else if (raw.report !== undefined) {
        const copy = isObj(raw.report) ? jsonCopy(raw.report, L.maxReportBytes) : null;
        if (copy) value.report = copy.value as LiveReport;
        else notes.push(`the run's report so far was over ${L.maxReportBytes} bytes (or nested over ${MAX_JSON_DEPTH} deep, or not an object) and is not shown`);
    }
    const result = resultOf(raw.result);
    if (result) value.result = result;
    return { ok: true, value, notes };
}

// ── the store ──────────────────────────────────────────────────────────────

/** What the tracker remembers of one member of one group. */
interface Track {
    /** onState has seen it once (the baseline: nothing is announced on first sight). */
    seen: boolean;
    name: string;
    isDead: boolean;
    deathCount: number;
    /** A death was announced on isDead's rising edge; a deathCount bump that follows is the same death. */
    countPending: boolean;
    level: number;
    regionId: number;
    pos: PassiveEvent['pos'];
    /** 1 Hz positions over the last trackKeepMs, in the current region. */
    samples: { x: number; y: number; at: number }[];
    lastSampleAt: number;
    /** The previous state's nearby lists (references: states are never changed after they arrive), to name a killer that left. */
    prevNpcs: readonly NearbyNpc[];
    prevPlayers: readonly NearbyPlayer[];
    /** tick's baselines: unset until the first tick. */
    client?: ClientStatus;
    controllers?: string[];
}

const newTrack = (): Track => ({
    seen: false, name: '', isDead: false, deathCount: 0, countPending: false, level: 0, regionId: 0, pos: null,
    samples: [], lastSampleAt: -Infinity, prevNpcs: [], prevPlayers: [],
});

/**
 * "<name> (L<level>)" of whoever killed `p`: the death event's killer, else the
 * newest foe that hit it, else null. A friend's heal or buff is a spellEffect on
 * it too, so a hitter counts only when it is of another realm: monsters are
 * 'none', and group members always share the victim's realm.
 *
 * For a pet's kill the server names the owner (GameLiving.cs:1299-1300), so as sdk/group/blackboard.ts
 * killerOf: the pet, when the newest blow before the death is a pet's of the named player's realm and
 * the named player has no blow of its own in the window.
 */
function killerOf(state: BotWorldState, p: PlayerState, track: Track): string | null {
    const me = p.objectId;
    const since = num(state.timestamp) - DEATH_WINDOW_MS;
    const find = (id: number): { o: NearbyNpc | NearbyPlayer; npc: boolean } | null => {
        const match = (o: { objectId: number }) => isObj(o) && o.objectId === id;
        const npc = arr(state.nearbyNpcs).find(match);
        if (npc) return { o: npc, npc: true };
        const pc = arr(state.nearbyPlayers).find(match);
        if (pc) return { o: pc, npc: false };
        const prevNpc = track.prevNpcs.find(match);
        if (prevNpc) return { o: prevNpc, npc: true };
        const prevPc = track.prevPlayers.find(match);
        return prevPc ? { o: prevPc, npc: false } : null;
    };
    const label = (o: NearbyNpc | NearbyPlayer) => (typeof o.name === 'string' && o.name ? `${o.name.slice(0, 64)} (L${num(o.level)})` : null);
    // A friendly guard or pet is an NPC of the victim's realm; a player of an unknown realm may be a friend.
    const foe = ({ o, npc }: { o: NearbyNpc | NearbyPlayer; npc: boolean }) =>
        npc ? o.realm === 'none' || o.realm !== p.realm : o.realm !== 'none' && p.realm !== 'none' && o.realm !== p.realm;
    // Newest first, copied: states are never changed.
    const hits = arr(state.combatEvents).filter(e => isObj(e) && e.targetObjectId === me && typeof e.attackerObjectId === 'number'
        && e.attackerObjectId !== me && num(e.receivedAt) >= since).reverse();
    // PlayerDeath's killer (client/model/world-model.ts) is the death event's attacker: the server named it.
    const death = hits.find(e => e.kind === 'death');
    const killer = death ? find(death.attackerObjectId!) : null;
    if (killer && label(killer.o)) {
        const blows = hits.slice(hits.indexOf(death!) + 1).filter(e => e.kind === 'melee' || e.kind === 'spellEffect');
        const last = blows.map(e => find(e.attackerObjectId!)).find(h => h && foe(h))?.o;
        const petsKill = !killer.npc && !!last && (last as NearbyNpc).isPet === true && last.realm === killer.o.realm && !blows.some(e => e.attackerObjectId === death!.attackerObjectId);
        return label(petsKill ? last! : killer.o) ?? label(killer.o);
    }
    const tried = new Set<number>();
    for (const e of hits) {
        if ((e.kind !== 'melee' && e.kind !== 'spellEffect') || tried.has(e.attackerObjectId!)) continue;
        tried.add(e.attackerObjectId!);
        const hitter = find(e.attackerObjectId!);
        if (hitter && foe(hitter) && label(hitter.o)) return label(hitter.o);
    }
    return null;
}

export function createGroupStore(opts: GroupStoreOptions): GroupStore {
    const L: GroupLimits = { ...GROUP_LIMITS, ...opts.limits };
    const now = opts.now ?? Date.now;
    const runs = new Map<string, RunRecord>();
    const passive = new Map<string, { events: PassiveEvent[]; seq: number }>();
    /** By `${groupId}/${bot}`. */
    const tracks = new Map<string, Track>();
    let disk: DiskGroup[] = [];
    let byId = new Map<string, DiskGroup>();
    /** Lower-cased gateway username → the groups it plays in, for onState's O(1) lookup. */
    let byUsername = new Map<string, { group: DiskGroup; member: DiskMember }[]>();
    let discoveredAt = -Infinity;
    let forcedAt = -Infinity;
    /** When this store started (gateway clock): a new value tells a page the gateway restarted, so its cursors start over. */
    const boot = now();
    let runOrder = 0;
    let lastErrorAt = -Infinity;
    let suppressed = 0;

    /** One log line per minute at most: a broken group must not flood the gateway's log. */
    function fail(where: string, error: unknown) {
        const t = Date.now();
        if (t - lastErrorAt < ERROR_LOG_MS) {
            suppressed++;
            return;
        }
        opts.log(`Groups: ${where} failed${suppressed ? ` (and ${suppressed} more errors in the last minute)` : ''}:`, error);
        lastErrorAt = t;
        suppressed = 0;
    }

    /**
     * The discovered groups, read again after discoveryTtlMs. `force` reads them
     * now (at most once per FORCED_DISCOVERY_MS), before refusing a publish or a
     * wind-down that a group.json written a moment ago would allow: a publisher
     * stops for the whole run on a 404 or 409.
     */
    function groups(force = false): DiskGroup[] {
        const t = now();
        const fresh = t - discoveredAt < L.discoveryTtlMs;
        if (fresh && (!force || t - forcedAt < FORCED_DISCOVERY_MS)) return disk;
        if (fresh) forcedAt = t;
        discoveredAt = t;
        disk = discoverGroups(opts.roots, opts.groupsDir, L.maxGroups);
        byId = new Map(disk.map(g => [g.id, g]));
        byUsername = new Map();
        const keys = new Set<string>();
        for (const group of disk) {
            for (const member of group.members) {
                const key = lower(member.username);
                const entries = byUsername.get(key) ?? [];
                entries.push({ group, member });
                byUsername.set(key, entries);
                keys.add(`${group.id}/${member.bot}`);
            }
        }
        // Forget what belonged to groups or members that are gone.
        for (const key of tracks.keys()) if (!keys.has(key)) tracks.delete(key);
        for (const id of passive.keys()) if (!byId.has(id)) passive.delete(id);
        return disk;
    }

    /** The discovered group `id`; an unknown id reads the disk once more first (a group.json written a moment ago). */
    function lookup(id: string): DiskGroup | undefined {
        groups();
        if (!byId.has(id)) groups(true);
        return byId.get(id);
    }

    const runsOf = (groupId: string) => [...runs.values()].filter(r => r.groupId === groupId);
    const current = (groupId: string, t: number) => currentOf(runsOf(groupId), t, L);

    function emit(group: DiskGroup, e: Omit<PassiveEvent, 'seq' | 'at' | 'runId'>, t: number) {
        let ring = passive.get(group.id);
        if (!ring) passive.set(group.id, ring = { events: [], seq: 0 });
        const run = current(group.id, t);
        const runId = run && ACTIVE.has(runStateOf(run, t, L)) ? run.runId : null;
        ring.events.push({ ...e, seq: ++ring.seq, at: t, runId });
        if (ring.events.length > L.maxPassiveEvents) ring.events.splice(0, ring.events.length - L.maxPassiveEvents);
    }

    function observe(group: DiskGroup, member: DiskMember, state: BotWorldState, p: PlayerState, t: number) {
        const key = `${group.id}/${member.bot}`;
        let tr = tracks.get(key);
        if (!tr) tracks.set(key, tr = newTrack());
        const name = str(p.name, 64) || member.charName || member.bot;
        const pos = { regionId: num(p.regionId), x: num(p.x), y: num(p.y), z: num(p.z) };
        const level = num(p.level);
        const deathCount = num(p.deathCount);
        const isDead = bool(p.isDead);
        const base = { bot: member.bot, name, by: null, pos, track: null };
        if (tr.seen) {
            if (pos.regionId !== tr.regionId) {
                tr.samples = [];
                emit(group, { ...base, kind: 'region', text: `${name} entered region ${pos.regionId}${p.zoneName ? ` (${str(p.zoneName, 64)})` : ''}` }, t);
            }
            if (level > tr.level) emit(group, { ...base, kind: 'level', text: `${name} reached level ${level}` }, t);
            const rose = isDead && !tr.isDead;
            const counted = deathCount > tr.deathCount;
            if (counted && tr.countPending) tr.countPending = false;
            else if (rose || counted) {
                tr.countPending = rose && !counted;
                const by = killerOf(state, p, tr);
                emit(group, { ...base, kind: 'death', text: `${name} died${by ? `, killed by ${by}` : ''}`, by, track: tr.samples.map(s => ({ ...s })) }, t);
            }
        }
        if (!isDead) tr.countPending = false;
        Object.assign(tr, { seen: true, name, isDead, deathCount, level, regionId: pos.regionId, pos });
        if (t - tr.lastSampleAt >= L.trackMs) {
            tr.samples.push({ x: pos.x, y: pos.y, at: t });
            tr.lastSampleAt = t;
        }
        const keep = Math.max(1, Math.ceil(L.trackKeepMs / Math.max(1, L.trackMs)) + 1);
        const old = tr.samples.findIndex(s => s.at >= t - L.trackKeepMs);
        if (old > 0) tr.samples.splice(0, old);
        else if (old < 0) tr.samples = [];
        if (tr.samples.length > keep) tr.samples.splice(0, tr.samples.length - keep);
        tr.prevNpcs = arr(state.nearbyNpcs);
        tr.prevPlayers = arr(state.nearbyPlayers);
    }

    function track(at: number) {
        const find = sessionFinder(opts.sessions);
        const sdks = sdkCounts(opts.sdkSessions);
        for (const group of disk) {
            for (const member of group.members) {
                const key = `${group.id}/${member.bot}`;
                let tr = tracks.get(key);
                if (!tr) tracks.set(key, tr = newTrack());
                const found = find(member.username);
                const status = clientStatus(opts, found?.session);
                const control = sdks.get(found?.key ?? member.username)?.control ?? [];
                const name = tr.name || member.charName || member.bot;
                const base = { bot: member.bot, name, by: null, pos: tr.pos, track: null };
                const up = status === 'active' || status === 'stale';
                if (tr.client !== undefined) {
                    const wasUp = tr.client === 'active' || tr.client === 'stale';
                    if (wasUp && !up) emit(group, { ...base, kind: 'client', text: `${name}: client disconnected` }, at);
                    else if (!wasUp && up) emit(group, { ...base, kind: 'client', text: `${name}: ${tr.client === 'none' ? 'client connected' : 'client back'}` }, at);
                }
                tr.client = status;
                const ids = control.map(c => c.id).sort();
                const before = tr.controllers;
                if (before !== undefined && (before.length !== ids.length || before.some((id, i) => id !== ids[i]))) {
                    const label = (control.find(c => !before.includes(c.id)) ?? control[0])?.label ?? 'sdk';
                    const what = !before.length ? `controller attached (${label})` : !ids.length ? 'controller left' : `control taken over (${label})`;
                    emit(group, { ...base, kind: 'control', text: `${name}: ${what}` }, at);
                }
                tr.controllers = ids;
            }
        }
    }

    function sweep(at: number) {
        for (const r of [...runs.values()]) {
            const st = runStateOf(r, at, L);
            const over = st === 'ended' || st === 'lost';
            // A group whose folder went away keeps a running run until it stops publishing.
            if (over && (at - r.lastAt > L.retainEndedMs || !byId.has(r.groupId))) runs.delete(r.runId);
        }
        for (const ring of passive.values()) {
            const old = ring.events.findIndex(e => e.at >= at - L.retainEndedMs);
            if (old > 0) ring.events.splice(0, old);
            else if (old < 0) ring.events.length = 0;
        }
    }

    // ── routes ─────────────────────────────────────────────────────────────

    function listEntry(group: DiskGroup, t: number, find: ReturnType<typeof sessionFinder>): GroupListEntry {
        const run = current(group.id, t);
        const st = run ? runStateOf(run, t, L) : null;
        const active = !!st && ACTIVE.has(st);
        return {
            id: group.id, name: group.name, leader: group.leader, error: group.error, hasCampaign: group.hasCampaign,
            members: group.members.map(m => {
                const session = find(m.username)?.session;
                // Like /bots: the player only while its client is connected.
                const connected = !!session && session.ws !== null && session.ws !== undefined;
                const state = session?.lastState ?? null;
                const p = connected && state?.inGame && isObj(state.player) ? state.player : null;
                const runRole = active ? run!.picture.members.find(r => lower(r.bot) === lower(m.bot))?.role : undefined;
                return {
                    bot: m.bot, username: m.username,
                    name: strOrNull(state?.player?.name, 64) || m.charName,
                    role: m.role ?? runRole ?? (p ? roleForClass(p.className) : null),
                    status: clientStatus(opts, session), inGame: connected && !!state?.inGame, isDead: bool(p?.isDead),
                    level: numOrNull(p?.level), className: strOrNull(p?.className, 32), regionId: numOrNull(p?.regionId), zoneName: strOrNull(p?.zoneName, 64),
                };
            }),
            run: run && st ? {
                runId: run.runId, state: st, strategy: run.meta.strategy, phase: active ? run.picture.orders.phase : null,
                ageMs: Math.max(0, t - run.lastAt), windingDown: run.timing.windingDown,
            } : null,
        };
    }

    const intParam = (q: URLSearchParams, key: string): number | null => {
        const v = q.get(key);
        if (v === null || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    function runView(r: RunRecord, st: RunState, q: URLSearchParams): RunView {
        // A page that knows another run (or none) starts over: all events, plan, report and meta.
        const same = q.get('run') === r.runId;
        const after = same ? intParam(q, 'events') ?? 0 : 0;
        const pending = r.events.filter(e => e.seq > after);
        const events = pending.slice(0, L.maxEventsPerFrame);
        const view: RunView = {
            runId: r.runId, state: st, error: r.error, current: true, firstAt: r.firstAt, lastAt: r.lastAt, skewMs: skewOf(r),
            strategy: r.meta.strategy, orders: r.picture.orders, pictureAt: r.picture.at, timing: r.timing, coordinator: r.coordinator,
            planRev: r.planRev, reportRev: r.reportRev,
            events, eventSeq: r.lastEventSeq, eventsFrom: r.events[0]?.seq ?? r.lastEventSeq + 1,
            lostEvents: r.lostEvents, moreEvents: pending.length > events.length,
            control: r.control.map(c => ({ ...c })), result: r.result,
        };
        if (!same) view.meta = r.meta;
        if (!same || q.get('planRev') !== String(r.planRev)) view.plan = r.plan;
        if (!same || q.get('reportRev') !== String(r.reportRev)) view.report = r.report;
        return view;
    }

    function frame(group: DiskGroup, q: URLSearchParams): GroupFrame {
        const t = now();
        const view = composePassive(group, opts, t, L.maxWorld);
        const mine = runsOf(group.id);
        const run = currentOf(mine, t, L);
        const st = run ? runStateOf(run, t, L) : null;
        if (run && st && ACTIVE.has(st)) {
            // The run's view of each member (by bot folder) and of what the members see.
            const reports = new Map(run.picture.members.map(m => [lower(m.bot), m]));
            const metaRoles = new Map(run.meta.members.map(m => [lower(m.bot), m.role]));
            view.members.forEach((v, i) => {
                const r = reports.get(lower(v.bot));
                if (r) v.run = { name: r.name, role: r.role, activity: { ...r.activity }, effects: [...r.effects], can: { heal: r.capabilities.heal, cc: r.capabilities.cc, nuke: r.capabilities.nuke, ...present(r.capabilities, ['rez'], 'boolean'), ...(r.capabilities.pet !== undefined ? { pet: r.capabilities.pet } : {}) }, ...present(r, ['realmPoints'], 'number'), at: r.at };
                const runRole = r?.role ?? metaRoles.get(lower(v.bot));
                if (!group.members[i]?.role && runRole) v.role = runRole;
            });
            const contacts = new Map(run.picture.contacts.map(c => [`${c.regionId}:${c.objectId}`, c]));
            for (const w of view.world) {
                const c = contacts.get(w.key);
                if (c) w.board = { threat: c.threat, stale: c.stale, cc: c.cc ? { ...c.cc } : null, engagedAt: c.engagedAt, hostileSince: c.hostileSince, seenBy: [...c.seenBy], lastSeen: c.lastSeen, ...present(c, PLAYER_SIGNS, 'boolean'), ...(c.targetPet ? { targetPet: c.targetPet } : {}) };
            }
        }
        const ring = passive.get(group.id);
        const after = intParam(q, 'passive') ?? 0;
        return {
            v: 1, id: group.id, name: group.name, leader: { bot: group.leader, username: group.leaderUsername }, now: t, boot,
            members: view.members, world: view.world, grouping: view.grouping,
            run: run && st ? runView(run, st, q) : null,
            others: mine.filter(r => r !== run).sort((a, b) => (newer(a, b) ? -1 : 1))
                .map(r => ({ runId: r.runId, state: runStateOf(r, t, L), firstAt: r.firstAt, strategy: r.meta.strategy })),
            passive: { events: ring ? ring.events.filter(e => e.seq > after).map(e => ({ ...e })) : [], seq: ring?.seq ?? 0 },
            notes: [...(group.error ? [group.error] : []), ...group.notes, ...(run?.notes ?? [])],
        };
    }

    /**
     * Null when the request may read the group, else why not. The leader's
     * credential reads every member's state through this (more than its own
     * /state): accepted, since the same credential can already pre-empt the
     * leader and so abort the whole run.
     */
    async function readDenied(req: Request, group: DiskGroup, bodyPassword?: unknown): Promise<string | null> {
        const password = typeof bodyPassword === 'string' && bodyPassword !== '' ? bodyPassword : bearer(req);
        const result = await opts.auth({ kind: 'http', username: group.leaderUsername, password });
        return result.success ? null : `Authentication failed: ${result.error ?? 'refused'}`;
    }

    const unauthorized = (group: DiskGroup, error: string) => json({ error, auth: { bot: group.leader, username: group.leaderUsername } }, 401);
    const noGroup = (id: string) => `no group '${id}' on the gateway's disk (groups/${id}/group.json)`;

    /** A run for a first publish, making room for it; null when every slot holds a live run. */
    function admit(group: DiskGroup, runId: string, t: number): RunRecord | null {
        const mine = runsOf(group.id);
        let victim: RunRecord | null = null;
        if (mine.length >= L.runsPerGroup) {
            const cur = currentOf(mine, t, L);
            for (const r of mine) if (r !== cur && (!victim || newer(victim, r))) victim = r;
            victim ??= cur;
        } else if (runs.size >= L.maxRuns) {
            for (const r of runs.values()) {
                const st = runStateOf(r, t, L);
                if ((st === 'ended' || st === 'lost') && (!victim || r.lastAt < victim.lastAt)) victim = r;
            }
            if (!victim) return null;
        }
        if (victim) runs.delete(victim.runId);
        const record: RunRecord = {
            runId, groupId: group.id, order: ++runOrder, declared: 'starting', firstAt: t, lastAt: t, lastPublishSeq: -1, skews: [],
            error: null, meta: { strategy: '', description: null, startedAt: 0, stamp: null, seconds: 0, graceMs: 0, members: [], settings: null, pid: 0, control: true },
            picture: { at: 0, members: [], contacts: [], orders: ordersOf(null) }, timing: { windingDown: false, deadline: 0, hardStop: 0 },
            coordinator: null, plan: null, planRev: 0, report: null, reportRev: 0, events: [], lastEventSeq: 0, lostEvents: 0,
            control: [], result: null, notes: [],
        };
        runs.set(runId, record);
        return record;
    }

    function apply(r: RunRecord, body: GroupPublish, notes: string[], t: number) {
        r.lastAt = t;
        r.skews.push(t - body.sentAt);
        if (r.skews.length > 10) r.skews.shift();
        // Snapshots only move forward: a delayed older POST changes nothing.
        if (body.publishSeq > r.lastPublishSeq) {
            r.lastPublishSeq = body.publishSeq;
            r.declared = body.state;
            r.error = body.error;
            r.meta = body.meta;
            r.picture = body.picture;
            r.timing = body.timing;
            r.coordinator = body.coordinator;
            if (body.plan !== undefined) {
                r.plan = body.plan;
                r.planRev = body.planRev;
            }
            if (body.report !== undefined) {
                r.report = body.report;
                r.reportRev = body.reportRev;
            }
            if (body.result) r.result = body.result;
            r.notes = notes.slice(0, 4);
        }
        // Events are numbered per run: a resend is skipped, a hole is counted.
        for (const e of [...body.events].sort((a, b) => a.seq - b.seq)) {
            if (e.seq <= r.lastEventSeq) continue;
            if (r.lastEventSeq > 0 && e.seq > r.lastEventSeq + 1) r.lostEvents += e.seq - r.lastEventSeq - 1;
            r.events.push(e);
            r.lastEventSeq = e.seq;
        }
        if (r.events.length > L.maxEventsPerRun) r.events.splice(0, r.events.length - L.maxEventsPerRun);
        for (const id of body.applied) {
            const c = r.control.find(x => x.id === id);
            if (c && c.appliedAt === null) c.appliedAt = t;
        }
    }

    /**
     * Why a publish's group, leader or roster disagree with the gateway's own
     * group.json (409), else null. Only the disk says who is in a group, never
     * the runner. It reads plain fields only, so it also runs on the unchecked body.
     */
    function conflict(group: DiskGroup, body: { group?: unknown; leader?: unknown; roster?: unknown }): string | null {
        if (body.group !== group.id) return `group mismatch: the body is for '${brief(body.group, 64)}', the URL for '${group.id}'`;
        if (group.error) return `the gateway cannot use groups/${group.id}/group.json (${group.error})`;
        if (typeof body.leader !== 'string' || lower(body.leader) !== lower(group.leader)) return `leader mismatch: the gateway's group.json is led by ${group.leader}`;
        const roster = new Set(list(body.roster, MAX_MEMBERS, r => (isObj(r) && typeof r.username === 'string' ? lower(r.username.slice(0, 64)) : null)));
        const mine = new Set(group.members.map(m => lower(m.username)));
        if (roster.size !== mine.size || [...roster].some(u => !mine.has(u))) {
            return `roster mismatch: the gateway's group.json has ${group.members.map(m => m.username).join(', ')}`;
        }
        return null;
    }

    async function publish(req: Request, id: string): Promise<Response> {
        const refuse = (status: number, error: string) => json({ ok: false, v: WIRE_VERSION, error } satisfies PublishAck, status);
        // text/plain would be a CORS "simple" request that a browser sends with no preflight.
        if (!isJsonRequest(req)) return refuse(415, 'Content-Type must be application/json');
        const body = await readCapped(req, L.maxPublishBytes);
        if (body === null) return refuse(413, `a publish may be at most ${L.maxPublishBytes} bytes`);
        let raw: any;
        try { raw = JSON.parse(body); } catch { return refuse(400, 'the body must be JSON'); }
        if (!isObj(raw) || raw.v !== WIRE_VERSION) return refuse(400, `wire version ${brief(isObj(raw) ? raw.v : raw)} is not supported (this gateway speaks v${WIRE_VERSION})`);
        let group = lookup(id);
        if (!group) return refuse(404, noGroup(id));
        // A group.json edited a moment ago: read it again before its leader's password is checked.
        if (conflict(group, raw)) {
            groups(true);
            group = byId.get(id);
            if (!group) return refuse(404, noGroup(id));
            // Still a mismatch: say which (leader and roster are public on /groups) rather than a misleading 401.
            const problem = conflict(group, raw);
            if (problem) return refuse(409, problem);
        }
        // Auth before sanitising: a stranger's body costs a JSON.parse, never a walk of its blobs.
        const denied = await readDenied(req, group, raw.password);
        if (denied) return refuse(401, denied);
        const clean = sanitizePublish(raw, L);
        if (!clean.ok) return refuse(400, clean.error);
        const p = clean.value;
        const problem = conflict(group, p);
        if (problem) return refuse(409, problem);
        const t = now();
        let run = runs.get(p.runId);
        if (run && run.groupId !== group.id) return refuse(409, `run ${p.runId} belongs to another group`);
        if (!run) {
            run = admit(group, p.runId, t) ?? undefined;
            if (!run) return refuse(503, `the gateway already holds ${L.maxRuns} live runs`);
        }
        apply(run, p, clean.notes, t);
        const pending = run.control.filter(c => c.appliedAt === null);
        for (const c of pending) c.deliveredAt ??= t;
        return json({
            ok: true, v: WIRE_VERSION, ackSeq: run.lastEventSeq,
            control: pending.map(c => ({ id: c.id, runId: c.runId, kind: c.kind, reason: c.reason, requestedAt: c.requestedAt })),
        } satisfies PublishAck);
    }

    async function control(req: Request, id: string): Promise<Response> {
        const refuse = (status: number, error: string, auth?: { bot: string; username: string }) =>
            json((auth ? { ok: false, error, auth } : { ok: false, error }) satisfies ControlAnswer, status);
        if (!isJsonRequest(req)) return refuse(415, 'Content-Type must be application/json');
        const group = lookup(id);
        if (!group) return refuse(404, noGroup(id));
        const text = await readCapped(req, MAX_CONTROL_BYTES);
        let body: any = null;
        try { body = text === null ? null : JSON.parse(text); } catch {}
        if (!isObj(body) || body.kind !== 'windDown') return refuse(400, 'the body must be JSON: {"kind": "windDown", "runId": "..."}');
        // Control-grade: a wind-down ends the run, so it needs what taking control needs.
        const password = typeof body.password === 'string' && body.password !== '' ? body.password : bearer(req);
        const check = await checkControlPassword(group.leaderUsername, password, opts.roots, opts.auth);
        if (!check.ok) return refuse(401, check.error ?? 'Authentication failed', { bot: group.leader, username: group.leaderUsername });
        const t = now();
        const run = current(group.id, t);
        const st = run ? runStateOf(run, t, L) : null;
        if (!run || (st !== 'live' && st !== 'stale' && st !== 'starting')) return refuse(409, 'no live run');
        // A tab still showing the previous run must not wind down the next one.
        if (body.runId !== run.runId) return refuse(409, `run changed: the live run is ${run.runId}`);
        if (run.meta.control === false) return refuse(403, 'this run does not accept viewer control');
        const existing = run.control.find(c => c.kind === 'windDown');
        if (existing) return json({ ok: true, request: { ...existing } } satisfies ControlAnswer);
        const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 120) : 'requested from the viewer';
        const request: ControlView = { id: randomUUID(), runId: run.runId, kind: 'windDown', reason, requestedAt: t, deliveredAt: null, appliedAt: null };
        run.control.push(request);
        opts.log(`Group ${group.id}: wind-down requested for run ${run.runId}`);
        return json({ ok: true, request: { ...request } } satisfies ControlAnswer);
    }

    function history(dir: string, limit: number): HistoryEntry[] {
        const path = join(dir, 'history.jsonl');
        if (!isFile(path)) return [];
        const lines = readTail(path, HISTORY_TAIL_BYTES).split('\n');
        const out: HistoryEntry[] = [];
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            const line = lines[i]!.trim();
            if (!line) continue;
            let h: any;
            try { h = JSON.parse(line); } catch { continue; }
            if (!isObj(h) || typeof h.startedAt !== 'string') continue;
            out.push({
                stamp: stampOf(h.startedAt), startedAt: h.startedAt.slice(0, 40), strategy: str(h.strategy, 64), seconds: num(h.seconds),
                kills: num(h.kills), deaths: num(h.deaths), wipes: num(h.wipes), retreats: num(h.retreats), fights: num(h.fights),
                killsPerHour: num(h.killsPerHour), xpPerHour: num(h.xpPerHour), avgFightMs: num(h.avgFightMs), downtime: num(h.downtime),
                tankHold: numOrNull(h.tankHold), ...present(h, RVR_TOTALS, 'number'), findings: strings(h.findings, 50, 64),
            });
        }
        return out;
    }

    function runFiles(dir: string): GroupRuns['files'] {
        let names: string[];
        try { names = readdirSync(dir); } catch { return []; }
        const sets = new Map<string, { json: boolean; md: boolean; log: boolean }>();
        for (const name of names) {
            const m = RUN_FILE.exec(name);
            if (!m) continue;
            let set = sets.get(m[1]!);
            if (!set) sets.set(m[1]!, set = { json: false, md: false, log: false });
            set[m[2] as 'json' | 'md' | 'log'] = true;
        }
        return [...sets.keys()].sort().reverse().slice(0, MAX_FILE_SETS).map(stamp => {
            const set = sets.get(stamp)!;
            let size = 0;
            for (const part of ['json', 'md', 'log'] as const) if (set[part]) size += fileSize(join(dir, `${stamp}.${part}`)) ?? 0;
            return { stamp, ...set, size };
        });
    }

    function campaign(dir: string): GroupRuns['campaign'] {
        const path = join(dir, 'campaign.log');
        let mtime: number;
        try {
            const st = statSync(path);
            if (!st.isFile()) return null;
            mtime = st.mtimeMs;
        } catch {
            return null;
        }
        const log = readTail(path, CAMPAIGN_TAIL_BYTES).split(/\r?\n/).filter(l => l.trim()).slice(-CAMPAIGN_LINES).map(l => l.slice(0, 500));
        return { log, stopPending: existsSync(join(dir, 'campaign.stop')), updatedAt: mtime };
    }

    async function runsRoute(req: Request, url: URL, group: DiskGroup, stamp: string | undefined): Promise<Response> {
        const denied = await readDenied(req, group);
        if (denied) return unauthorized(group, denied);
        // Only fixed names inside the discovered folder: no URL text reaches a path unchecked.
        const dir = join(group.dir, 'runs');
        if (stamp === undefined) {
            const limit = Math.max(1, Math.min(200, Math.floor(intParam(url.searchParams, 'limit') ?? 20)));
            return json({ history: history(dir, limit), files: runFiles(dir), campaign: campaign(dir) } satisfies GroupRuns);
        }
        if (!STAMP.test(stamp)) return json({ error: 'Not found' }, 404);
        const part = url.searchParams.get('part') ?? 'json';
        if (part !== 'json' && part !== 'md' && part !== 'log') return json({ error: 'part must be json, md or log' }, 400);
        const file = join(dir, `${stamp}.${part}`);
        const size = fileSize(file);
        if (size === null) return json({ error: `no runs/${stamp}.${part}` }, 404);
        if (part === 'log') return text(readTail(file, L.maxFileBytes));
        if (size > L.maxFileBytes) return json({ error: `runs/${stamp}.${part} is larger than ${L.maxFileBytes} bytes` }, 413);
        if (part === 'md') return text(readFileSync(file, 'utf8'));
        let report: unknown;
        try { report = JSON.parse(readFileSync(file, 'utf8')); } catch { return json({ error: `runs/${stamp}.json is not valid JSON` }, 500); }
        return json({ report });
    }

    async function route(req: Request, url: URL): Promise<Response> {
        const parts = groupPath(url.pathname);
        const notAllowed = (allow: string) => json({ error: 'Method not allowed' }, 405, { Allow: allow });
        if (!parts.length) {
            if (req.method !== 'GET') return notAllowed('GET');
            const t = now();
            const find = sessionFinder(opts.sessions);
            return json({ groups: groups().map(g => listEntry(g, t, find)) });
        }
        const [id, what, stamp, ...extra] = parts as [string, string | undefined, string | undefined, ...string[]];
        if (!GROUP_ID.test(id) || extra.length || (stamp !== undefined && what !== 'runs')) return json({ error: 'Not found' }, 404);
        if (what === 'publish') return req.method === 'POST' ? publish(req, id) : notAllowed('POST');
        if (what === 'control') return req.method === 'POST' ? control(req, id) : notAllowed('POST');
        if (what !== 'live' && what !== 'runs') return json({ error: 'Not found' }, 404);
        if (req.method !== 'GET') return notAllowed('GET');
        groups();
        const group = byId.get(id);
        if (!group) return json({ error: noGroup(id) }, 404);
        if (what === 'runs') return runsRoute(req, url, group, stamp);
        const denied = await readDenied(req, group);
        if (denied) return unauthorized(group, denied);
        return json(frame(group, url.searchParams));
    }

    const timer = setInterval(() => store.tick(), 1000);
    timer.unref?.(); // the server keeps the process alive, not the tracker

    const store: GroupStore = {
        async handle(req, url) {
            const path = url.pathname;
            if (path !== '/groups' && !path.startsWith('/groups/')) return null;
            if (path.length > MAX_PATH) return json({ error: 'Not found' }, 404);
            try {
                return await route(req, url);
            } catch (error) {
                fail(`${req.method} ${path}`, error);
                return json({ ok: false, v: WIRE_VERSION, error: 'the gateway failed to answer this group request (see its log)' }, 500);
            }
        },
        badge(username) {
            try {
                if (discoveredAt === -Infinity) groups();
                const entries = byUsername.get(lower(username));
                if (!entries) return null;
                const t = now();
                let first: GroupBadge | null = null;
                for (const { group } of entries) {
                    const run = current(group.id, t);
                    const st = run ? runStateOf(run, t, L) : null;
                    const active = !!st && ACTIVE.has(st);
                    const badge: GroupBadge = { id: group.id, name: group.name, run: run && st ? { runId: run.runId, state: st, phase: active ? run.picture.orders.phase : null } : null };
                    // A bot in two groups: the one running now.
                    if (active) return badge;
                    first ??= badge;
                }
                return first;
            } catch (error) {
                fail('badge', error);
                return null;
            }
        },
        activeRuns() {
            try {
                const t = now();
                const out: ActiveRun[] = [];
                for (const group of groups()) {
                    const run = current(group.id, t);
                    const st = run ? runStateOf(run, t, L) : null;
                    if (!run || !st || !ACTIVE.has(st)) continue;
                    out.push({
                        id: group.id, name: group.name, leaderUsername: group.leaderUsername, usernames: group.members.map(m => m.username),
                        runId: run.runId, state: st, strategy: run.meta.strategy, lastAt: run.lastAt, picture: run.picture, timing: run.timing,
                        coordinator: run.coordinator, report: run.report, result: run.result,
                    });
                }
                return out;
            } catch (error) {
                fail('active runs', error);
                return [];
            }
        },
        onState(username, state) {
            try {
                // The tick keeps discovery fresh; a state never waits on the disk after the first.
                if (discoveredAt === -Infinity) groups();
                const entries = byUsername.get(lower(username));
                if (!entries) return;
                const p = state?.inGame && isObj(state.player) ? state.player : null;
                if (!p) return;
                const t = now();
                for (const { group, member } of entries) observe(group, member, state, p, t);
            } catch (error) {
                fail('state tracker', error);
            }
        },
        tick(at = now()) {
            try {
                groups();
                track(at);
                sweep(at);
            } catch (error) {
                fail('tick', error);
            }
        },
        stop() {
            clearInterval(timer);
        },
    };
    return store;
}
