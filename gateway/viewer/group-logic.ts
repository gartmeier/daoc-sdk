// DOM-free decisions for the group page (group.ts), kept apart so they can be
// unit-tested: which region the map shows, which level NPC con colours are
// relative to, the run pill, when the page's cursors start over, which contacts
// the map and the panel show, the merged event feed and its filters, and the
// run log helpers.
//
// Clocks: the frame's `now`, run firstAt/lastAt and passive events are the
// gateway's; everything inside a publish (events, orders, timing, cc) is the
// runner's, which RunView.skewMs converts (gateway = runner + skewMs).

import type { GroupFrame, GroupMemberView, PassiveEvent, RunState, RunView, WorldContact } from '../group-types';
import type { PetReport } from '../../sdk/group/types';
import type { RunMeta, WireEvent } from '../../sdk/group/wire';
import { petOrders } from './logic';
import { arr, dur, mmss, num } from './ui-kit';

/** Run states whose orders, activities and board contacts still describe the group (the gateway merges only these). */
export const CURRENT_STATES: ReadonlySet<RunState> = new Set(['starting', 'live', 'stale', 'ending']);

/** A wind-down can be asked for: the gateway takes one for a starting, live or stale run that accepts viewer control. */
export function canWindDown(run: RunView | null | undefined, meta: RunMeta | null | undefined): boolean {
    return !!run && (run.state === 'starting' || run.state === 'live' || run.state === 'stale') && meta?.control !== false;
}

/** Shape check of a GET /groups/<id>/live answer, enough for the page to read it without throwing. */
export function isGroupFrame(x: unknown): x is GroupFrame {
    if (!x || typeof x !== 'object') return false;
    const f = x as Record<string, any>;
    if (f.v !== 1 || typeof f.id !== 'string' || typeof f.now !== 'number' || !Number.isFinite(f.now)) return false;
    if (!Array.isArray(f.members) || !f.members.every((m: any) => m && typeof m === 'object' && typeof m.bot === 'string')) return false;
    if (!Array.isArray(f.world) || !f.world.every((c: any) => c && typeof c === 'object')) return false;
    if (!f.leader || typeof f.leader !== 'object') return false;
    if (!f.passive || typeof f.passive !== 'object' || !Array.isArray(f.passive.events) || typeof f.passive.seq !== 'number') return false;
    if (f.run !== null && (typeof f.run !== 'object' || typeof f.run.runId !== 'string' || typeof f.run.state !== 'string')) return false;
    return true;
}

/**
 * The region the map shows: the followed member's (bot folder), else the
 * region most members with a known player are in (ties: the earlier member in
 * group.json order).
 */
export function mapRegion(members: GroupMemberView[], followed: string | null): number | null {
    const f = followed ? arr(members).find(m => m.bot === followed) : undefined;
    if (f?.player && Number.isFinite(f.player.regionId)) return f.player.regionId;
    const counts = new Map<number, number>();
    for (const m of arr(members)) {
        const r = m.player?.regionId;
        if (typeof r === 'number' && Number.isFinite(r)) counts.set(r, (counts.get(r) ?? 0) + 1);
    }
    let best: number | null = null, bestN = 0;
    for (const [r, n] of counts) if (n > bestN) { best = r; bestN = n; }
    return best;
}

/**
 * The region the run's orders and plan are in: the living tank's, else the
 * first living member's, as pve.ts decidePve picks it. Only members the
 * current run reports count; null without any.
 */
export function runRegion(members: GroupMemberView[]): number | null {
    const inRun = arr(members).filter(m => m.run && m.player && Number.isFinite(m.player.regionId));
    const alive = inRun.filter(m => !m.player!.isDead);
    const lead = alive.find(m => m.run!.role === 'tank') ?? alive[0] ?? inRun[0];
    return lead ? lead.player!.regionId : null;
}

/**
 * The level NPC con colours are relative to: the lowest living member level
 * in the region, which is what the coordinator pulls by (pve.ts decidePve);
 * else the lowest of the dead ones there; null when no member is there.
 */
export function conReference(members: GroupMemberView[], regionId: number | null): number | null {
    if (regionId === null) return null;
    const here = arr(members).filter(m => m.player && m.player.regionId === regionId && Number.isFinite(m.player.level));
    const alive = here.filter(m => !m.player!.isDead);
    const pool = alive.length ? alive : here;
    return pool.length ? Math.min(...pool.map(m => m.player!.level)) : null;
}

/**
 * The run failed: its result says it stopped by an error, or it ended with an
 * error and no result (it failed before it started). A normal end may still
 * carry a reason in `error` from an older runner; the result decides.
 */
export function runFailed(run: RunView | null | undefined): boolean {
    if (!run) return false;
    return run.result ? run.result.stoppedBy === 'error' : !!run.error;
}

/**
 * The frame comes from a gateway that restarted since the last one (its
 * GroupFrame.boot changed): its event seqs and plan/report revisions start over
 * and name other things, so the page drops every cursor and what it holds. A
 * gateway that sends no boot never says so (the page still notices a seq that
 * went down).
 */
export function gatewayRestarted(lastBoot: number | null, f: { boot?: unknown }): boolean {
    return lastBoot !== null && typeof f.boot === 'number' && Number.isFinite(f.boot) && f.boot !== lastBoot;
}

/** Text and .pill class of the run pill in the topbar; `now` on the gateway clock. */
export function runPill(run: RunView | null | undefined, now: number): { text: string; cls: string } {
    if (!run) return { text: 'no run', cls: '' };
    const phase = run.orders?.phase;
    const since = dur(now - num(run.lastAt, now));
    const winding = run.timing?.windingDown ? ' · winding down' : '';
    switch (run.state) {
        case 'live': return { text: `live${phase ? ` · ${phase}` : ''}${winding}`, cls: 'active' };
        case 'starting': return { text: 'starting', cls: 'stale' };
        case 'stale': return { text: `stale · ${since}${phase ? ` · ${phase}` : ''}`, cls: 'stale' };
        case 'ending': return { text: 'ending', cls: 'stale' };
        case 'lost': return { text: `lost · no publish for ${since}`, cls: 'dead' };
        case 'ended': return runFailed(run) ? { text: 'ended · error', cls: 'dead' } : { text: 'ended', cls: '' };
        default: return { text: String(run.state), cls: '' };
    }
}

const PHASES = new Set(['idle', 'gather', 'travel', 'recover', 'pull', 'engage', 'retreat']);

/** CSS class for a coordinator phase (viewer.css .phase-*); unknown phases look idle. */
export function phaseClass(phase: unknown): string {
    return `phase-${typeof phase === 'string' && PHASES.has(phase) ? phase : 'idle'}`;
}

/** One line of the event feed: a run event or a passive one, on the gateway clock. */
export interface FeedLine {
    key: string;
    /** Gateway clock. */
    at: number;
    source: 'run' | 'passive';
    kind: string;
    /** Character name of the member it is about, null for group-level events (orders). */
    member: string | null;
    /** Names the member filter matches: the member, plus the bot folder for passive events. */
    who: string[];
    text: string;
    /** Passive events: the run that was live, else null (between runs). Run events: null. */
    runId: string | null;
    seq: number;
    /** Passive deaths: the killer. */
    by: string | null;
}

/**
 * Run events (runner clock, shifted by skewMs) and passive events merged into
 * one feed in time order; equal times keep run events first, each in seq order.
 */
export function mergeEvents(runEvents: WireEvent[], skewMs: number, passiveEvents: PassiveEvent[]): FeedLine[] {
    const skew = num(skewMs);
    const out: FeedLine[] = [];
    for (const e of arr(runEvents)) {
        if (!e || typeof e !== 'object') continue;
        const member = typeof e.member === 'string' && e.member ? e.member : null;
        out.push({
            key: `r${num(e.seq)}`, at: num(e.at) + skew, source: 'run', kind: String(e.kind), member, who: member ? [member] : [],
            text: String(e.text ?? ''), runId: null, seq: num(e.seq), by: null,
        });
    }
    for (const e of arr(passiveEvents)) {
        if (!e || typeof e !== 'object') continue;
        const name = typeof e.name === 'string' && e.name ? e.name : null;
        out.push({
            key: `p${num(e.seq)}`, at: num(e.at), source: 'passive', kind: String(e.kind), member: name ?? e.bot ?? null,
            who: [name, e.bot].filter((w): w is string => typeof w === 'string' && w !== ''),
            text: String(e.text ?? ''), runId: typeof e.runId === 'string' ? e.runId : null, seq: num(e.seq), by: typeof e.by === 'string' ? e.by : null,
        });
    }
    return out.sort((a, b) => a.at - b.at || (a.source === b.source ? a.seq - b.seq : a.source === 'run' ? -1 : 1));
}

/** Append events newer than the last held seq, oldest first, keeping at most `cap` (the newest). */
export function appendBySeq<T extends { seq: number }>(list: T[], incoming: T[], cap: number): T[] {
    let last = list.length ? list[list.length - 1]!.seq : -Infinity;
    const out = list.slice();
    for (const e of [...arr(incoming)].sort((a, b) => num(a?.seq) - num(b?.seq))) {
        if (!e || typeof e.seq !== 'number' || !(e.seq > last)) continue;
        out.push(e);
        last = e.seq;
    }
    return out.length > cap ? out.slice(out.length - cap) : out;
}

export interface FeedFilters {
    orders: boolean;
    /** Kills, deaths, levels. */
    fights: boolean;
    /** Failed results (the runner publishes no successful ones). */
    failures: boolean;
    notes: boolean;
    /** Passive events while no run was live. */
    between: boolean;
    /** Names of one member (bot, character): only its lines; null for everyone. */
    member: string[] | null;
}

/**
 * Whether a feed line passes the filters. Passive events between runs follow
 * only "between runs"; during a run their deaths and levels count as fights and
 * client, control and region changes always show.
 */
export function eventVisible(line: FeedLine, filters: FeedFilters): boolean {
    if (filters.member && !line.who.some(w => filters.member!.includes(w))) return false;
    if (line.source === 'passive') {
        if (line.runId === null) return filters.between;
        return line.kind === 'death' || line.kind === 'level' ? filters.fights : true;
    }
    switch (line.kind) {
        case 'orders': return filters.orders;
        case 'kill': case 'death': case 'level': return filters.fights;
        case 'result': return filters.failures;
        default: return filters.notes;
    }
}

/**
 * Whether the member assigned to crowd-control a contact sees it: by the
 * members' own states (seenBy) or the run's board. A caster that doesn't see
 * its target fails with "cc: not_found".
 */
export function ccSeen(contact: WorldContact | null | undefined, casterName: string): boolean {
    if (!contact || !casterName) return false;
    const name = casterName.toLowerCase();
    return [...arr(contact.seenBy), ...arr(contact.board?.seenBy)].some(n => typeof n === 'string' && n.toLowerCase() === name);
}

/** What "threats only" keeps on the map: a board threat, anything targeting a member or a member's pet, or a player of another realm. Never a member's own pet. */
export function isThreat(c: WorldContact): boolean {
    if (c.npc?.owner) return false;
    return !!c.board?.threat || (!c.isDead && (typeof c.target === 'string' || typeof c.targetPet === 'string')) || !!c.enemy;
}

/**
 * Who a contact is on, for the panel and the tooltip: a member, else "Hrafna's pet"; null for nobody,
 * and for a member's pet, as a pet's entry can read a member it buffs: what it fights is PetReport.targetId.
 */
export function contactAim(c: WorldContact): string | null {
    if (c.npc?.owner) return null;
    if (c.target) return c.target;
    const owner = c.targetPet ?? c.board?.targetPet;
    return owner ? `${owner}'s pet` : null;
}

/** The realms the members play, 'none' left out. */
export function memberRealms(members: GroupMemberView[]): Set<string> {
    return new Set(arr(members).map(m => m.player?.realm).filter((r): r is string => typeof r === 'string' && r !== 'none'));
}

/** Whose side a pet is on, null for anything else. An enemy's owner can't be known: the server sends the flag and the realm only (PacketLib1124.cs:186-187). */
export function petSide(c: WorldContact, realms: ReadonlySet<string>): 'member' | 'enemy' | 'friend' | 'monster' | null {
    if (c.kind !== 'npc' || !c.npc) return null;
    if (c.npc.owner) return 'member';
    if (!c.npc.isPet) return null;
    if (c.realm === 'none') return 'monster';
    return realms.has(c.realm) ? 'friend' : 'enemy';
}

/** A pet's line in the tooltip; null for anything else. */
export function petTitle(c: WorldContact, realms: ReadonlySet<string>): string | null {
    switch (petSide(c, realms)) {
        case 'member': return `pet of ${c.npc!.owner}`;
        case 'enemy': return 'enemy pet';
        case 'friend': return 'friendly pet';
        case 'monster': return 'a monster\'s pet';
        default: return null;
    }
}

/** An NPC's label on the map: a member's pet by its owner, anything else by its level. */
export function mapLabel(c: WorldContact): string {
    const name = c.name || '(unnamed)';
    return c.npc?.owner ? `${name} (${c.npc.owner})` : `${name} ${c.level ?? ''}`;
}

/**
 * A member's window pet in one line, for its card and the CLI: "spirit warrior L17 84% · defensive · follow → wolf".
 * Out of view its entry's level and health aren't known. `nameOf` names what it fights.
 */
export function petLine(pet: PetReport, nameOf: (objectId: number) => string): string {
    const who = [pet.name || `#${pet.objectId}`, pet.level !== null ? `L${pet.level}` : '', pet.hp !== null ? `${Math.round(pet.hp)}%` : 'out of view'].filter(Boolean).join(' ');
    return `${who} · ${petOrders(pet.aggression, pet.walk)}${pet.targetId !== null ? ` → ${nameOf(pet.targetId)}` : ''}`;
}

/**
 * A member with no window pet: the count of those it has without one, and "no pet" only where it keeps a main one up (Capabilities.pet). A Theurgist's come and go with their target, so none is nothing to report.
 */
export function noWindowPet(summons: number, can: 'main' | 'fnf' | null | undefined): string | null {
    return summons ? `Pets: ${summons} with no window` : can === 'main' ? 'no pet' : null;
}

/** What a member's card says about its pets; null for a member with none to speak of, so its card reads as before. */
export function memberPetRow(m: GroupMemberView, nameOf: (objectId: number) => string): { text: string; hp: number | null } | null {
    const more = arr(m.summons).length;
    if (m.pet) return { text: `Pet: ${petLine(m.pet, nameOf)}${more ? ` · ${more} more` : ''}`, hp: m.pet.hp };
    const text = noWindowPet(more, m.run?.can.pet);
    return text ? { text, hp: null } : null;
}

/**
 * Whether the NPCs layer ('all', 'threats', 'off') draws a contact. Players and
 * members' pets always show. Everything drawn about a contact (its dot, the lines
 * to it, its cc ring, the focus ring) follows this, so nothing points at a hidden NPC.
 */
export function npcShown(c: WorldContact, npcs: string): boolean {
    return c.kind !== 'npc' || !!c.npc?.owner || !(npcs === 'off' || (npcs === 'threats' && !isThreat(c)));
}

/**
 * Whether the contacts panel lists a contact: threats, monsters the group could
 * fight (sdk isAttackable: targetable, not peaceful, of no realm or another realm
 * than the members', a pet only of another realm) and enemy players. Dead ones, town
 * NPCs, our pets and friendly players stay off the list; the map still draws them.
 */
export function contactListed(c: WorldContact, realms: ReadonlySet<string>): boolean {
    if (c.isDead || (c.kind === 'npc' && num(c.hp, 100) <= 0)) return false;
    if (isThreat(c)) return true;
    if (c.kind !== 'npc') return false;
    const n = c.npc;
    if (n && (n.isPeaceful || n.isTargetable === false || n.owner || (n.isPet && c.realm === 'none'))) return false;
    return c.realm === 'none' || !realms.has(c.realm);
}

/** A contact's tags in the panel: `pet` on a pet, and what the run's board saw an enemy player do (Contact.healer, Contact.caster). */
export function enemyTags(c: WorldContact): string[] {
    if (c.npc?.isPet) return ['pet'];
    if (c.kind !== 'player' || !c.board) return [];
    return [c.board.healer ? 'healer' : '', c.board.caster ? 'caster' : ''].filter(Boolean);
}

/** A contact's line in the CLI's --live, with what the page's panel has of it: `*` on the focus, level, health, who it is on, tags and crowd control, how many see it and how near. */
export function contactLine(c: WorldContact, focus: number | null): string {
    const aim = contactAim(c);
    const tags = [...enemyTags(c), c.board?.cc?.kind ?? '', c.board?.stale ? 'stale' : ''].filter(Boolean);
    return `${focus === c.objectId ? '* ' : ''}${c.name} L${c.level} ${Math.round(num(c.hp, 100))}%${aim ? ` → ${aim}` : ''}${tags.length ? ` [${tags.join(', ')}]` : ''}, seen ${arr(c.seenBy).length}, ${Math.round(num(c.nearest))} away`;
}

/** The contacts panel's list: listed contacts, threats first, then the nearest. */
export function listedContacts(world: WorldContact[], members: GroupMemberView[]): WorldContact[] {
    const realms = memberRealms(members);
    return arr(world).filter(c => c && contactListed(c, realms))
        .sort((a, b) => Number(isThreat(b)) - Number(isThreat(a)) || num(a.nearest) - num(b.nearest));
}

/**
 * After a good /live answer: ask for the runs list again when none is held,
 * none is on its way, and the last try went out with another password (the
 * bot page's stored one has just unlocked /live). Once per password, so a
 * runs route that keeps failing waits for the 30 s refresh.
 */
export function retryRuns(held: boolean, busy: boolean, failedWith: string | null, password: string): boolean {
    return !held && !busy && failedWith !== null && failedWith !== password;
}

/**
 * The run's clock: time until pulling stops (deadline), or while winding down
 * until it stops even mid-fight (hardStop). `now` on the gateway clock.
 */
export function timeLeft(timing: RunView['timing'] | null | undefined, skewMs: number, now: number): { text: string; ms: number; windingDown: boolean } | null {
    if (!timing || !Number.isFinite(timing.deadline) || !Number.isFinite(timing.hardStop)) return null;
    const skew = num(skewMs);
    if (timing.windingDown) {
        const ms = Math.max(0, timing.hardStop + skew - now);
        return { text: `winding down · stops within ${mmss(ms)}`, ms, windingDown: true };
    }
    const ms = Math.max(0, timing.deadline + skew - now);
    return { text: `${mmss(ms)} left`, ms, windingDown: false };
}

const ROLE_LETTERS: Record<string, string> = { tank: 'T', healer: 'H', support: 'S', nuker: 'N', melee: 'M' };

/** Role → the letter after a member's name on the map. */
export function roleLetter(role: string | null | undefined): string {
    return role && Object.hasOwn(ROLE_LETTERS, role) ? ROLE_LETTERS[role]! : '?';
}

/**
 * Kind of a runs/<stamp>.log line (runner.ts: "HH:MM:SS [<member>: ]<text>"):
 * orders ("» ..."), a member death ("Galahad: Galahad died", "kill: died (...)"),
 * a kill ("<mob> (L13) died"), a failed result ("nuke: no_target (...)").
 */
export function logLineKind(line: string): 'orders' | 'death' | 'kill' | 'failure' | 'other' {
    if (/^\d\d:\d\d:\d\d » /.test(line)) return 'orders';
    const m = line.match(/^\d\d:\d\d:\d\d ([^:]+): (.*)$/);
    if (!m) return 'other';
    const who = m[1]!, rest = m[2]!;
    if (rest === `${who} died` || /^\w+: died\b/.test(rest)) return 'death';
    if (/\(L\d+\) died$/.test(rest)) return 'kill';
    if (/^\w+: (?!ok\b)[a-z_]+( \(|$)/.test(rest)) return 'failure';
    return 'other';
}

/** The log lines around line i: 12 before, the line, 3 after; `start` is the index of the first. */
export function deathContext(logLines: string[], i: number): { start: number; lines: string[] } {
    const lines = arr(logLines);
    if (!Number.isInteger(i) || i < 0 || i >= lines.length) return { start: 0, lines: [] };
    const start = Math.max(0, i - 12);
    return { start, lines: lines.slice(start, Math.min(lines.length, i + 4)) };
}
