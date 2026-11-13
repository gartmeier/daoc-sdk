// The voice: what a group and a realm say aloud, as a pickup group's leader and the realm's callers would.
//
// Pure. A picture of the group (group chat) or a director update (`/region`) goes in, at most one line comes out:
//
//   claims   What is true now and worth saying, each with a key ("focus:425", "retreat", "help:hibernia-7"), a priority,
//            how long it must hold before it is said (settleMs: a decision that flickers back within it is never said)
//            and how long before the same key may be said again (cooldownMs).
//   Voice    Picks the claim to say now: settled, not said within its cooldown, the highest priority, within the rate
//            limits (a gap between lines, a cap per minute that urgent lines skip, no same text twice within textMs).
//            A claim that loses its turn is not queued: stale words are worse than none.
//
// groupClaims reads the coordinator's orders and the board (the focus by its class read as a human would, never by
// roster); regionClaims reads the director's calls and events (only what the realm's units saw). Transport is the
// caller's: the run's leader says group lines (`groupSay`), a unit's leader says region lines (`/region`).

import { BATTLEGROUND_LAYOUTS, THIDRANKI, type PlayerRealm } from './keeps';
import type { Contact, GroupPicture, MemberReport, Point } from './types';

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────── the voice

export interface Claim {
    key: string;
    text: string;
    /** Higher first. */
    prio: number;
    /** Held this long (continuously) before it is said. */
    settleMs: number;
    /** The same key isn't said again within this. Infinity: once per voice. */
    cooldownMs: number;
    /** Skips the per-minute cap and takes the shorter gap. */
    urgent?: boolean;
    /** Who should say it (region lines: a unit); the transport's choice when absent. */
    by?: string;
}

export interface VoiceLimits {
    /** Between two lines. */
    gapMs: number;
    /** Between an urgent line and the one before. */
    urgentGapMs: number;
    /** At most this many lines in a minute, urgent ones aside. */
    perMinute: number;
    /** The same text isn't said twice within this, whatever its key. */
    textMs: number;
    /** A claim not seen for this long starts settling again. */
    forgetMs: number;
}

/** Group chat: one line every few seconds at most, six a minute. Server limit: 500 ms (commands/playercommands/group.cs). */
export const GROUP_LIMITS: VoiceLimits = { gapMs: 3500, urgentGapMs: 1500, perMinute: 6, textMs: 20_000, forgetMs: 2500 };
/** `/region`: one line every 5 s at most per realm, five a minute. Server limit: 800 ms (region.cs). */
export const REGION_LIMITS: VoiceLimits = { gapMs: 5000, urgentGapMs: 3000, perMinute: 5, textMs: 30_000, forgetMs: 5000 };

export interface Line { text: string; key: string; at: number; by?: string }

export class Voice {
    private firstSeen = new Map<string, { since: number; last: number }>();
    private said = new Map<string, number>();
    private texts = new Map<string, number>();
    private recent: number[] = [];
    private lastAt = -Infinity;
    readonly lines: Line[] = [];

    constructor(readonly limits: VoiceLimits = GROUP_LIMITS) {}

    /** When `key` was last said; undefined if never. */
    saidAt(key: string): number | undefined { return this.said.get(key); }

    /** Mark a key said without saying it (a line that would only repeat what another just said). */
    mute(key: string, now: number): void { this.said.set(key, now); }

    /** Offer this tick's claims; returns the line to say now, or null. */
    offer(claims: readonly Claim[], now: number): Line | null {
        const L = this.limits;
        for (const c of claims) {
            const f = this.firstSeen.get(c.key);
            if (!f || now - f.last > L.forgetMs) this.firstSeen.set(c.key, { since: now, last: now });
            else f.last = now;
        }
        for (const [k, f] of this.firstSeen) if (now - f.last > L.forgetMs) this.firstSeen.delete(k);
        this.recent = this.recent.filter(t => now - t < 60_000);
        for (const [t, at] of this.texts) if (now - at >= L.textMs) this.texts.delete(t);
        const ready = claims
            .filter(c => now - this.firstSeen.get(c.key)!.since >= c.settleMs)
            .filter(c => { const s = this.said.get(c.key); return s === undefined || now - s >= c.cooldownMs; })
            .filter(c => !this.texts.has(c.text))
            .sort((a, b) => b.prio - a.prio);
        const c = ready[0];
        if (!c) return null;
        if (now - this.lastAt < (c.urgent ? L.urgentGapMs : L.gapMs)) return null;
        if (!c.urgent && this.recent.length >= L.perMinute) return null;
        this.said.set(c.key, now);
        this.texts.set(c.text, now);
        this.recent.push(now);
        this.lastAt = now;
        const line: Line = { text: c.text, key: c.key, at: now, ...(c.by ? { by: c.by } : {}) };
        this.lines.push(line);
        if (this.lines.length > 50) this.lines.shift();
        return line;
    }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── words

const REALM_WORD: Record<PlayerRealm, [string, string]> = { albion: ['alb', 'albs'], midgard: ['mid', 'mids'], hibernia: ['hib', 'hibs'] };

/** "1 mid", "6 mids", "4 mids and 2 albs": counts by realm, most first. */
export function countWords(byRealm: Partial<Record<string, number>>): string {
    const parts = Object.entries(byRealm)
        .filter((e): e is [PlayerRealm, number] => e[0] in REALM_WORD && (e[1] ?? 0) > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${n} ${REALM_WORD[r][n === 1 ? 0 : 1]}`);
    return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** A foe as a player names it: its class once most of the read agrees, else what the server calls it (the race). */
export function foeLabel(c: Pick<Contact, 'name' | 'kind' | 'classGuess'>): string {
    const g = c.classGuess;
    if (c.kind === 'player' && g?.classes[0] && (g.p[0] ?? 0) >= 0.6) return g.classes[0];
    return c.name;
}

/** Bridges onto the Faste's island, middle of each (learnings/rvr.md "The Faste"). */
const BRIDGES: { realm: PlayerRealm; x: number; y: number }[] = [
    { realm: 'hibernia', x: 30400, y: 34750 },
    { realm: 'midgard', x: 38600, y: 36125 },
    { realm: 'albion', x: 29200, y: 41000 },
];
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

/**
 * Where `p` is, as a player of `realm` would say it in Thidranki: "at our PK", "at the mid PK", "at the hib bridge",
 * "at the Faste", "near the alb PK", "north-west of the Faste". Region coordinates: x east, y south.
 */
export function placeName(p: Point, realm: PlayerRealm, regionId = THIDRANKI): string {
    const bg = BATTLEGROUND_LAYOUTS[regionId];
    if (!bg) return 'here';
    const d = (a: Point) => Math.hypot(a.x - p.x, a.y - p.y);
    const portals = bg.keeps.filter(k => k.portal).map(k => ({ k, d: d(k) })).sort((a, b) => a.d - b.d);
    const pk = portals[0];
    const pkName = (owner: string) => owner === realm ? 'our PK' : `the ${REALM_WORD[owner as PlayerRealm]?.[0] ?? owner} PK`;
    if (pk && pk.d <= 6000) return `at ${pkName(pk.k.owner)}`;
    if (regionId === THIDRANKI) {
        const b = BRIDGES.map(x => ({ ...x, d: d(x) })).sort((a, c) => a.d - c.d)[0]!;
        if (b.d <= 2000) return `at the ${b.realm === realm ? 'our' : REALM_WORD[b.realm][0]} bridge`.replace('the our', 'our');
    }
    const faste = bg.keeps.find(k => !k.portal);
    if (faste && d(faste) <= 3500) return 'at the Faste';
    if (pk && pk.d <= 10_000) return `near ${pkName(pk.k.owner)}`;
    if (!faste) return 'out there';
    // atan2 with y south: 0 east, a quarter turn south.
    const a = Math.atan2(p.y - faste.y, p.x - faste.x);
    const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    return `${COMPASS[i]} of the Faste`;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────── group chat

export interface GroupVoiceState {
    /** The speaker's character name ("/assist <name>"). */
    speaker: string;
    realm: PlayerRealm;
    regionId?: number;
    /** Enemy players seen in this encounter: the most so far, and the most already called. */
    incPeak?: number;
    incCalled?: number;
    /** When the last enemy player was in sight. */
    incLastSeen?: number;
    /** The focus the last "going in"/"switch" named, and when it was said. */
    lastFocus?: number | null;
    focusSaidAt?: number;
    /** The last tick in engage, and when this run of engage ticks began (a break of SWITCH_MS starts a new one). */
    engagedAt?: number;
    engageSince?: number;
    /** The label the last focus line named ("Valewalker"): the next on another of those is "next Valewalker". */
    lastLabel?: string;
}

/** An encounter ends when no enemy player was in sight this long: the next one is "inc" again. */
export const INC_RESET_MS = 25_000;
/** A focus line within this of the last says "switch", not "going in". */
const SWITCH_MS = 30_000;

const enemyPlayers = (p: GroupPicture, realm: PlayerRealm) =>
    p.contacts.filter(c => c.kind === 'player' && !c.stale && !c.isPet && c.realm !== realm && c.realm !== 'none');

const bots = (members: readonly MemberReport[]) => members.filter(m => !m.observed);

/**
 * What the group would say now, from its picture (pure but for `st`, which carries the encounter between ticks):
 * pulling back, going in and focus, cc on someone, inc, rez, the wipe, the human's welcome. Lines are short,
 * lower case, as typed in a fight.
 */
export function groupClaims(p: GroupPicture, st: GroupVoiceState, now = p.at): Claim[] {
    const out: Claim[] = [];
    const o = p.orders;
    const reason = o.reason ?? '';
    const byId = new Map(p.contacts.map(c => [c.objectId, c]));
    const regionId = st.regionId ?? THIDRANKI;

    // A human joined: tell them how this group plays, once.
    for (const m of p.members) {
        if (!m.observed) continue;
        out.push({ key: `hi:${m.name.toLowerCase()}`, text: `hi ${m.name}, stick with us and /assist ${st.speaker}, I call the targets here`, prio: 90, settleMs: 3000, cooldownMs: Infinity });
    }

    const team = bots(p.members);
    // A solo has nobody to tell (the server answers "You are not part of a group").
    if (p.members.length < 2) return out;
    const living = team.filter(m => !m.isDead);
    if (team.length && !living.length) {
        out.push({ key: 'wipe', text: 'wiped, release and meet at our PK', prio: 100, settleMs: 1500, cooldownMs: 120_000, urgent: true });
        return out;
    }

    // Enemy players in sight: "inc".
    const seen = enemyPlayers(p, st.realm);
    if (seen.length) st.incLastSeen = now;
    else if (st.incLastSeen !== undefined && now - st.incLastSeen > INC_RESET_MS) { st.incPeak = 0; st.incCalled = 0; }
    st.incPeak = Math.max(st.incPeak ?? 0, seen.length);
    // The first sight, then only when it grew by two or more: not a line per enemy.
    const called = st.incCalled ?? 0;
    if (seen.length >= (called ? called + 2 : 1) && o.phase !== 'engage' && o.phase !== 'retreat') {
        const by: Record<string, number> = {};
        for (const c of seen) by[c.realm] = (by[c.realm] ?? 0) + 1;
        const centre = { x: seen.reduce((t, c) => t + c.x, 0) / seen.length, y: seen.reduce((t, c) => t + c.y, 0) / seen.length };
        const where = placeName(centre, st.realm, regionId);
        out.push({ key: `inc:${seen.length}`, text: `inc ${countWords(by)} ${where}`, prio: 60, settleMs: 1000, cooldownMs: 45_000 });
    }

    if (o.phase === 'retreat') {
        // "to our PK", "to the hib bridge"; a compass place ("north-east of the Faste") says nothing a human can run to.
        const place = o.retreatTo ? placeName(o.retreatTo, st.realm, regionId) : '';
        const to = /^(at|near) /.test(place) ? ` to ${place.replace(/^(at|near) /, '')}` : '';
        out.push({ key: 'retreat', text: `pulling back${to}, stay with me`, prio: 95, settleMs: 800, cooldownMs: 30_000, urgent: true });
    } else if (o.phase === 'travel' && /^avoid\b/.test(reason)) {
        out.push({ key: 'avoid', text: 'too many for us, steering clear', prio: 50, settleMs: 1500, cooldownMs: 90_000 });
    } else if (o.phase === 'travel' && /^call\b/.test(reason)) {
        out.push({ key: 'call', text: 'friends need help, heading over', prio: 45, settleMs: 2000, cooldownMs: 90_000 });
    } else if (o.phase === 'travel' && /^raid approach\b/.test(reason)) {
        out.push({ key: 'raid', text: 'on to the Faste, keep together', prio: 45, settleMs: 2000, cooldownMs: 180_000 });
    }

    // Going in, and the focus.
    if (o.phase === 'engage') {
        if (st.engagedAt === undefined || now - st.engagedAt > SWITCH_MS) st.engageSince = now;
        st.engagedAt = now;
    }
    if (o.phase === 'engage' && o.focus !== null) {
        const f = byId.get(o.focus);
        if (f && f.kind === 'player') {
            const label = foeLabel(f);
            const fresh = st.focusSaidAt === undefined || st.focusSaidAt < (st.engageSince ?? 0);
            const text = fresh ? `going in, focus the ${label}` : label === st.lastLabel ? `next ${label}` : `switch, focus the ${label}`;
            out.push({ key: `focus:${o.focus}`, text, prio: 80, settleMs: 1500, cooldownMs: 25_000 });
        }
    }

    // Crowd control that landed, on players: leave it.
    for (const c of p.contacts) {
        if (!c.cc || c.cc.until <= now || c.kind !== 'player' || c.stale) continue;
        const label = foeLabel(c);
        if (c.cc.kind === 'mezz') out.push({ key: `cc:${c.objectId}:mezz`, text: `mezz on the ${label}, leave it`, prio: 70, settleMs: 0, cooldownMs: 40_000 });
        else if (c.cc.kind === 'root') out.push({ key: `cc:${c.objectId}:root`, text: `${label} rooted`, prio: 40, settleMs: 0, cooldownMs: 40_000 });
    }

    // Rez: once the fight is over, the dead and who brings them back.
    if (o.phase !== 'engage' && o.phase !== 'retreat') {
        const rezzer = living.find(m => m.capabilities.rez);
        for (const m of p.members) {
            if (m.isDead && m.observed) out.push({ key: `rez:${m.name}`, text: rezzer ? `${m.name}, don't release, rez coming` : `${m.name}, nobody can rez, release`, prio: 85, settleMs: 2000, cooldownMs: 90_000 });
        }
        // The dead bots in one line: "rez Eir", "rez Eir and Leif", "rez Eir, Leif and Freydis".
        const dead = rezzer ? team.filter(m => m.isDead).map(m => m.name) : [];
        if (dead.length) {
            const names = dead.length === 1 ? dead[0]! : `${dead.slice(0, -1).join(', ')} and ${dead.at(-1)}`;
            out.push({ key: `rez:${[...dead].sort().join(',')}`, text: `rez ${names}`, prio: 55, settleMs: 3000, cooldownMs: 90_000 });
        }
    }

    // A rest: once per break.
    if (o.phase === 'recover' && /rebuff|regroup|waiting for/.test(reason) && living.length) {
        out.push({ key: 'recover', text: 'rest and buff up here', prio: 20, settleMs: 4000, cooldownMs: 180_000 });
    }
    return out;
}

/** After a line is said: keep what the next tick's claims need ("inc" counted, the focus named). */
export function groupSaid(line: Line, st: GroupVoiceState): void {
    const inc = /^inc:(\d+)$/.exec(line.key);
    if (inc) st.incCalled = Number(inc[1]);
    const focus = /^focus:(\d+)$/.exec(line.key);
    if (focus) { st.lastFocus = Number(focus[1]); st.focusSaidAt = line.at; st.lastLabel = /focus the (.+)$/.exec(line.text)?.[1] ?? /^next (.+)$/.exec(line.text)?.[1]; }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── /region

/** The parts of a director update the region voice reads (director.ts DirectorUpdate). */
export interface RegionInput {
    realm: PlayerRealm;
    regionId?: number;
    /** Published calls: none while the director is off. */
    enabled: boolean;
    calls: readonly {
        id: string; kind: string; from: string; why: string; at: Point; stage?: 'rally' | 'go'; target?: Point;
        foes: number; asked: readonly string[]; coming: readonly string[]; defenders?: number; hold?: string;
    }[];
    /** Enemy players our realm sees, with their realm and place. */
    foes: readonly { x: number; y: number; realm: string }[];
    /** This update's events (director.ts LoggedEvent): closes say how a raid ended, answers who is coming. */
    events: readonly { kind: string; call: string; end?: string; why?: string; unit?: string; state?: string; from?: string }[];
    /** Units whose run is up now: the speakers. */
    running: readonly string[];
}

const near = (a: Point, b: Point, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

/**
 * What the realm says in `/region` now: help with place and count (by the caller), "omw" (by a unit coming), the
 * muster (gather, waiting, go), how a raid ended. Every claim names a running unit to say it, or none is made.
 */
export function regionClaims(u: RegionInput, nearFoe = 2500, only?: 'calls' | 'events'): Claim[] {
    if (!u.enabled) return [];
    const out: Claim[] = [];
    const regionId = u.regionId ?? THIDRANKI;
    const running = new Set(u.running);
    const anyone = u.running[0];
    for (const c of only === 'events' ? [] : u.calls) {
        if (c.kind === 'help') {
            const by: Record<string, number> = {};
            for (const f of u.foes) if (near(f, c.at, nearFoe)) by[f.realm] = (by[f.realm] ?? 0) + 1;
            const count = countWords(by) || `${c.foes}`;
            const where = placeName(c.at, u.realm, regionId);
            const speaker = running.has(c.from) ? c.from : anyone;
            if (!speaker) continue;
            const text = c.why === 'camped' ? `${count} camping ${where.replace(/^(at|near) /, '')}, need help`
                : c.why === 'caught' ? `${count} on us ${where}, help!`
                : c.why === 'sighted' ? `${count} coming ${where}, need help`
                : `${count} ${where}, need help`;
            // Said again only if it grew a lot (a new bucket of 3).
            out.push({ key: `help:${c.id}:${Math.floor(c.foes / 3)}`, text, prio: c.why === 'outnumbered' ? 60 : 70, settleMs: 0, cooldownMs: Infinity, by: speaker, urgent: c.why !== 'outnumbered' });
        } else if (c.kind === 'defend') {
            // Our keep is attacked: everyone hears it, the units asked go.
            const by: Record<string, number> = {};
            for (const f of u.foes) if (near(f, c.at, 4500)) by[f.realm] = (by[f.realm] ?? 0) + 1;
            const count = countWords(by) || `${c.foes}`;
            const speaker = [...c.asked].sort().find(a => running.has(a)) ?? anyone;
            if (!speaker) continue;
            out.push({ key: `defend:${c.id}:${Math.floor(c.foes / 4)}`, text: `Faste under attack, ${count} there, defend!`, prio: 80, settleMs: 0, cooldownMs: Infinity, by: speaker, urgent: true });
        } else if (c.kind === 'muster') {
            const speaker = [...c.asked].sort().find(a => running.has(a)) ?? anyone;
            if (!speaker) continue;
            if (c.stage === 'rally') {
                const where = placeName(c.at, u.realm, regionId).replace(/^at /, '');
                out.push({ key: `muster:${c.id}:rally`, text: `Faste raid, gather ${/^(near|our|the)/.test(where) ? `at ${where}` : where}`, prio: 50, settleMs: 0, cooldownMs: Infinity, by: speaker });
                if (c.hold === 'defenders' && c.defenders) out.push({ key: `muster:${c.id}:held`, text: `${c.defenders} on the Faste, wait at the rally`, prio: 45, settleMs: 0, cooldownMs: Infinity, by: speaker });
                if (c.hold === 'winner') out.push({ key: `muster:${c.id}:winner`, text: 'they are fighting at the Faste, wait for the winner', prio: 45, settleMs: 0, cooldownMs: Infinity, by: speaker });
            } else if (c.stage === 'go') {
                out.push({ key: `muster:${c.id}:go`, text: 'go go, Faste!', prio: 75, settleMs: 0, cooldownMs: Infinity, by: speaker, urgent: true });
            }
        }
    }
    for (const e of only === 'calls' ? [] : u.events) {
        if (e.kind === 'answer' && e.state === 'coming' && e.unit && running.has(e.unit)) {
            const call = u.calls.find(c => c.id === e.call);
            if (call && call.kind !== 'muster') out.push({ key: `omw:${e.call}:${e.unit}`, text: 'omw', prio: 30, settleMs: 0, cooldownMs: Infinity, by: e.unit });
        } else if (e.kind === 'close' && e.why === 'keep' && anyone) {
            const text = e.end === 'quiet' ? 'Faste holds, nice' : e.end === 'lost' ? 'Faste lost' : null;
            if (text) out.push({ key: `end:${e.call}`, text, prio: 65, settleMs: 0, cooldownMs: Infinity, by: anyone });
        } else if (e.kind === 'close' && e.why === 'raid' && anyone) {
            const text = e.end === 'captured' ? 'Faste is ours!'
                : e.end === 'broken' ? 'raid broke, back to our PK'
                : e.end === 'defended' ? 'too many on the Faste, calling it off'
                : e.end === 'timeout' ? 'calling off the raid' : null;
            if (text) out.push({ key: `end:${e.call}`, text, prio: 65, settleMs: 0, cooldownMs: Infinity, by: anyone });
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────── the wrappers

/** A group's voice: hear(picture) each tick, say what it returns with groupSay. */
export class GroupVoice {
    readonly voice: Voice;
    readonly state: GroupVoiceState;
    constructor(state: GroupVoiceState, limits: VoiceLimits = GROUP_LIMITS) {
        this.state = state;
        this.voice = new Voice(limits);
    }
    hear(p: GroupPicture, now = p.at): Line | null {
        const line = this.voice.offer(groupClaims(p, this.state, now), now);
        if (line) groupSaid(line, this.state);
        return line;
    }
}

/** Claims from one update's events stay on offer this long, so a busy moment doesn't lose "Faste is ours!". */
export const REGION_EVENT_HOLD_MS = 20_000;

/** A realm's voice: hear(update) each director tick; say each line with `/region` through the unit it names. */
export class RegionVoice {
    readonly voice: Voice;
    private held: { claim: Claim; until: number }[] = [];
    constructor(limits: VoiceLimits = REGION_LIMITS) { this.voice = new Voice(limits); }
    hear(u: RegionInput, now: number, nearFoe?: number): Line | null {
        const fromEvents = regionClaims(u, nearFoe, 'events');
        for (const c of fromEvents) if (!this.held.some(h => h.claim.key === c.key)) this.held.push({ claim: c, until: now + REGION_EVENT_HOLD_MS });
        this.held = this.held.filter(h => h.until > now && this.voice.saidAt(h.claim.key) === undefined);
        const fromCalls = regionClaims(u, nearFoe, 'calls');
        return this.voice.offer([...fromCalls, ...this.held.map(h => h.claim)], now);
    }
}
