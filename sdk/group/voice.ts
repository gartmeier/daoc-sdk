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
/** A human's corpse is promised a rez only with a living rezzer of ours this close (same region). */
export const REZ_NEAR = 3000;
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
    // Half of us down and no rezzer coming: our dead release at once (behaviors.ts HALF_DOWN, the release's detail; matched by its
    // words so voice.ts stays free of behaviors.ts). Tell the humans the same, once per wipe: the key is the wipe's, so the
    // full wipe after it is not said again within its cooldown. The user, playing Niamh at 17:0x: "should release and regroup at the PK."
    const halfDown = team.some(m => m.isDead && m.activity?.kind === 'release' && /^half the group down\b/.test(m.activity.detail ?? ''));
    if (halfDown) out.push({ key: 'wipe', text: 'half of us down and no rez coming, release and meet at our PK', prio: 100, settleMs: 0, cooldownMs: 120_000, urgent: true });

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
    } else if (o.phase === 'travel' && /^(ambush:|lie in wait\b)/.test(reason)) {
        // An ambush (tactics/ambush.ts, pack.ts): a human sees the group stand still, so say what for (live 15:28, Niamh:
        // "what are they waiting for?"). Whom: the count from the objective, the realm from the players we know of.
        const n = Number(/lie in wait for (\d+)/.exec(o.objective ?? '')?.[1] ?? 0);
        const realms = [...new Set(p.contacts.filter(c => c.kind === 'player' && !c.isPet && c.realm !== st.realm && c.realm in REALM_WORD).map(c => c.realm as PlayerRealm))];
        const word = realms.length === 1 ? REALM_WORD[realms[0]!] : null;
        const who = n === 1 && word ? `the ${word[0]}` : n > 1 && word ? `the ${n} ${word[1]}` : n > 1 ? `the ${n} of them` : 'them';
        if (/^ambush:/.test(reason)) out.push({ key: 'ambush:set', text: `setting an ambush for ${who}, follow me`, prio: 45, settleMs: 2000, cooldownMs: 120_000 });
        else out.push({ key: 'ambush:wait', text: `waiting here in ambush for ${who}, hold still`, prio: 45, settleMs: 2000, cooldownMs: 120_000 });
    } else if (o.phase !== 'engage' && /^quiet: back to the portal keep\b/.test(reason)) {
        // The realm's quiet wave (waves.ts): the walk home, then the break there and when it ends.
        out.push({ key: 'break', text: 'heading back to our PK for a short break', prio: 40, settleMs: 2000, cooldownMs: 300_000 });
    } else if (o.phase !== 'engage' && /^quiet: a break\b/.test(reason)) {
        const left = Number(/out again in (\d+) s/.exec(reason)?.[1] ?? NaN);
        if (Number.isFinite(left) && left >= 30) {
            const when = left < 90 ? 'in a minute' : `in about ${Math.round(left / 60)} min`;
            out.push({ key: 'break:here', text: `short break here, out again ${when}`, prio: 30, settleMs: 4000, cooldownMs: 300_000 });
        }
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
    if (o.phase !== 'engage' && o.phase !== 'retreat' && !halfDown) {
        const rezzer = living.find(m => m.capabilities.rez);
        for (const m of p.members) {
            if (!m.isDead || !m.observed) continue;
            // A rez is promised only with a living rezzer near the corpse: live 15:55, Niamh died 25000 from a unit that
            // walked out on its wave, was told "rez coming", and nobody came. Out of sight reads as another region.
            const near = living.some(r => r.capabilities.rez && r.regionId === m.regionId && Math.hypot(r.x - m.x, r.y - m.y) <= REZ_NEAR);
            if (near) out.push({ key: `rez:${m.name}`, text: `${m.name}, don't release, rez coming`, prio: 85, settleMs: 2000, cooldownMs: 90_000 });
            else if (!rezzer) out.push({ key: `rez:${m.name}`, text: `${m.name}, nobody can rez, release`, prio: 85, settleMs: 2000, cooldownMs: 90_000 });
            else {
                const here = living.filter(r => r.regionId === living[0]!.regionId);
                const place = placeName({ x: here.reduce((t, r) => t + r.x, 0) / here.length, y: here.reduce((t, r) => t + r.y, 0) / here.length }, st.realm, regionId);
                out.push({ key: `rez-far:${m.name}`, text: `${m.name}, we can't get to you, release and catch up, we're ${place}`, prio: 85, settleMs: 2000, cooldownMs: 90_000 });
            }
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

// ─────────────────────────────────────────────────────────────────────────────────────── a human's asks in group chat

/**
 * What a human (observed member) asks in group chat that the group answers: to be picked up, or where we are.
 * Live 2026-11-13, Niamh: "how can I ask the group to come pick me up?"; the bots read nothing of her group chat.
 */
export type GroupAsk = 'pickup' | 'where' | 'buff';

const PICKUP_ASK = /\b(pick\s?(me\s?)?up|pickup|come (get|for|pick) me|get me|wait (for|4) me|wait up|hold up|i'?m at (the |our )?(pk|portal ?keep))\b/i;
const WHERE_ASK = /\b(where(?: (?:are|r|is)|'?s) (?:you|u|ya|we|every(?:one|body)|the gr(?:ou)?p)(?: guys)?|where (?:you|u) at|location)\b|^\s*(where|loc)\s*\??\s*$/i;

/**
 * "buff", "buffs pls", "buff me", "need buffs", "rebuff", "no buffs": a line about wanting buffs, not one that mentions
 * them ("ty for the buffs", "nice buffs").
 */
const BUFF_ASK = /^\s*(re-?)?buffs?\s*(me|us|pl[sz]e?|please|pls|now|again|\?|!|\.)*\s*$|\b(re-?buff(s|ing)?\s*(me|us|pl[sz]e?|please|\?)|buff me|buff us|buffs? (pl[sz]e?|please)|(need|want|no|missing|any|can (i|we) (get|have)|got no|have no)\s+(some\s+|my\s+)?(re-?)?buffs?)\b/i;

/** The ask in a human's group line ("pick me up", "wait for me", "where are you?", "buffs pls"), or null. */
export function readGroupAsk(text: string): GroupAsk | null {
    if (PICKUP_ASK.test(text)) return 'pickup';
    if (WHERE_ASK.test(text)) return 'where';
    if (BUFF_ASK.test(text)) return 'buff';
    return null;
}

/**
 * Does a decide stop for a human's buff ask (observed.ts buffAsk)? Until one does, the leader promises no buffs: no answer to
 * "buff", and a pickup says nothing of buffs (the user, via the player-feedback session: a promise the group doesn't keep
 * is worse than none, as with the rez, 63188db). The roaming session sets it true in the commit that lands the stop (pack.ts).
 */
export const BUFF_STOP_ON: boolean = false;

/** The group can stop for a buff stop now: no fight, pull or pull back (after one, the runner asks again). */
export function buffFree(o: Pick<GroupPicture['orders'], 'phase'>): boolean {
    return o.phase !== 'engage' && o.phase !== 'retreat' && o.phase !== 'pull';
}

/** The group can go and fetch someone: no fight, no pull back, no realm call, raid or defence. */
export function pickupFree(o: Pick<GroupPicture['orders'], 'phase' | 'reason' | 'objective'>, where?: string | null): boolean {
    if (o.phase === 'engage' || o.phase === 'retreat' || o.phase === 'pull') return false;
    // At our PK, or near it, a pickup there is never refused for a call: live 20:11, Niamh released and walking in at our PK
    // was told "we're near our PK on a call, ... ask again in a bit". The wait for everyone at our PK (rvr.ts "full force
    // first", before the raid or any call) is a pickup already.
    if (/^full force first\b/i.test(o.reason ?? '') || nearOurPk(where)) return true;
    return !/^(call|raid|defen|muster|help)/i.test(o.reason ?? '') && !/\b(raid|defen[cd]e?|muster|help)\b/i.test(o.objective ?? '');
}

/** What a member does that targets something of its own (a friend to heal or buff, a mob to mezz): the speaker's target is left alone. */
const OWN_TARGET = new Set(['heal', 'buff', 'cure', 'rez', 'rez_prep', 'cc', 'confuse', 'interrupt', 'song', 'guard', 'pull', 'nuke', 'accept_rez', 'release', 'drop']);

/**
 * The target the speaker (the one a human /assists, "hi …, /assist <speaker>") should take now, or null to leave it. The
 * orders' focus on an enemy player, unless the speaker is on something of its own: the user, playing Niamh 2026-11-14:
 * "a lot of time when I assist Laoghaire, he has no target. Only at the last moment does he target the enemy he wants
 * to hit." A melee speaker selects the focus only once it reaches it; a caster assisting wants it on the way in.
 */
export function assistTarget(
    o: Pick<GroupPicture['orders'], 'phase' | 'focus'>, contacts: readonly Contact[],
    me: { targetObjectId: number | null; isDead: boolean } | null | undefined, activity: { kind: string; targetId: number | null } | undefined,
): number | null {
    if (o.phase !== 'engage' || o.focus === null || !me || me.isDead || me.targetObjectId === o.focus) return null;
    const f = contacts.find(c => c.objectId === o.focus);
    if (!f || f.kind !== 'player' || f.stale) return null;
    // On something of its own (a heal, a buff, a mezz, a peel onto another foe): back to the focus once that is done.
    if (activity && (OWN_TARGET.has(activity.kind) || (activity.kind === 'melee' && activity.targetId !== null && activity.targetId !== o.focus))) return null;
    return o.focus;
}

/** whereWeAre's "at our PK" (within 6000) or "near our PK" (within 10000). */
export const nearOurPk = (where: string | null | undefined): boolean => !!where && /^(at|near) our PK$/.test(where);

/** Where the bots are, as a player says it ("at our PK", "north of the Faste"); null with none alive. */
export function whereWeAre(p: GroupPicture, st: Pick<GroupVoiceState, 'realm' | 'regionId'>): string | null {
    const living = bots(p.members).filter(m => !m.isDead);
    const here = living.filter(m => m.regionId === (st.regionId ?? THIDRANKI));
    if (!here.length) return null;
    const at = { x: here.reduce((t, m) => t + m.x, 0) / here.length, y: here.reduce((t, m) => t + m.y, 0) / here.length };
    return placeName(at, st.realm, st.regionId ?? THIDRANKI);
}

/** The leader's answer to a human's ask. `picking`: a pickup or a buff stop was taken (the group comes to our PK, or buffs here). */
export function groupAnswer(ask: GroupAsk, p: GroupPicture, st: Pick<GroupVoiceState, 'realm' | 'regionId'>, picking: boolean, buffStop = BUFF_STOP_ON): string | null {
    const where = whereWeAre(p, st);
    const fight = p.orders.phase === 'engage' || p.orders.phase === 'retreat' || p.orders.phase === 'pull';
    const we = where ? `we're ${fight ? 'fighting ' : ''}${where}` : 'we are all dead';
    // A buff ask: a buff stop here now (`picking`: it was taken), or after the fight; nothing while no decide stops for it.
    if (ask === 'buff') return !where ? `${we}, release and meet at our PK` : !buffStop ? null : picking ? 'ok, buffing here, stay close' : 'after this fight';
    if (ask === 'where') return where ? `${we}, come to us` : `${we}, release and meet at our PK`;
    // A pickup ends in a buff stop where we meet (observed.ts pickup `buff`).
    if (picking) return nearOurPk(where) ? `wait there, ${we}${buffStop ? `, we'll buff you here` : ''}` : `ok, coming to our PK for you, ${buffStop ? `we'll buff there` : 'wait there'}`;
    if (!where) return `${we}, release and meet at our PK`;
    return fight ? `${we}, come to us or ask again after the fight` : `${we} on a call, come to us or ask again in a bit`;
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
    events: readonly {
        /** Absent on events of no call (director.ts 'picket'). */
        kind: string; call?: string; end?: string; why?: string; unit?: string | null; state?: string; from?: string;
        /** The stage event at the go: what made it go (director.ts musterHold). */
        stage?: string; defenders?: number; third?: number; ownersAway?: number; owner?: string | null;
    }[];
    /** Units whose run is up now: the speakers. */
    running: readonly string[];
}

const near = (a: Point, b: Point, r: number) => Math.hypot(a.x - b.x, a.y - b.y) <= r;

/**
 * "6 mids", "4 mids and 2 albs": the call's own count (the director's, steadier than a look at the board now), in the
 * realms seen there; the realms' split only when it adds up to that count.
 */
function callCount(c: { foes: number; at: Point }, foes: RegionInput['foes'], r: number): string {
    const by: Record<string, number> = {};
    for (const f of foes) if (near(f, c.at, r)) by[f.realm] = (by[f.realm] ?? 0) + 1;
    const realms = Object.keys(by).filter(k => k in REALM_WORD) as PlayerRealm[];
    const total = Object.values(by).reduce((t, n) => t + (n ?? 0), 0);
    if (total === c.foes && total > 0) return countWords(by);
    if (realms.length === 1 && c.foes > 0) return countWords({ [realms[0]!]: c.foes });
    return `${Math.max(c.foes, total)}`;
}

/** What /region already said of a help call: say it again only when it got worse or grew by 3 since. */
export type HelpSaid = ReadonlyMap<string, { foes: number; why: string; at?: Point }>;

/**
 * Help calls this close are one fight: the director opens one per unit, and two or three units that see the same enemy
 * group each call (live 14:44: three hib units, "8 mids … north of the Faste" three times in 10 s).
 */
export const SAME_FIGHT_RANGE = 3000;

/**
 * A help call not said yet takes what was said of an open call of the same fight, so the realm hears that fight once
 * (and again only when it got worse or grew by 3). Returns the map with those entries added.
 */
export function inheritHelpSaid(
    calls: RegionInput['calls'], said: Map<string, { foes: number; why: string; at?: Point }>,
    recent: readonly { foes: number; why: string; at?: Point }[] = [],
): typeof said {
    const help = calls.filter(c => c.kind === 'help');
    for (const c of help) {
        if (said.has(c.id)) continue;
        const sib = help.find(h => h.id !== c.id && said.has(h.id) && (near(h.at, c.at, SAME_FIGHT_RANGE) || near(said.get(h.id)!.at ?? h.at, c.at, SAME_FIGHT_RANGE)));
        // Else a call of this place that closed lately: the worst said there.
        const old = sib ? said.get(sib.id)! : recent.filter(r => r.at && near(r.at, c.at, SAME_FIGHT_RANGE))
            .sort((a, b) => (WHY_RANK[b.why] ?? 0) - (WHY_RANK[a.why] ?? 0) || b.foes - a.foes)[0];
        if (old) said.set(c.id, { ...old, at: c.at });
    }
    return said;
}
// "8 mids coming X" and "8 mids X": the same news, so sighted and outnumbered rank alike (live 14:52).
const WHY_RANK: Record<string, number> = { sighted: 0, outnumbered: 0, camped: 1, caught: 2 };

/**
 * A fight said in /region stays known this long after its call closed: the director closes a call that lapses and
 * opens a new one there seconds later (live 14:51-14:53: one fight, four calls, "7 mids … north-east" four times).
 */
export const HELP_MEMORY_MS = 60_000;

/**
 * What the realm says in `/region` now: help with place and count (by the caller), "omw" (by a unit coming), the
 * muster (gather, waiting, go), how a raid ended. Every claim names a running unit to say it, or none is made.
 */
export function regionClaims(u: RegionInput, nearFoe = 2500, only?: 'calls' | 'events', said: HelpSaid = new Map()): Claim[] {
    if (!u.enabled) return [];
    const out: Claim[] = [];
    const regionId = u.regionId ?? THIDRANKI;
    const running = new Set(u.running);
    const anyone = u.running[0];
    for (const c of only === 'events' ? [] : u.calls) {
        if (c.kind === 'help') {
            const before = said.get(c.id);
            if (before && (WHY_RANK[c.why] ?? 0) <= (WHY_RANK[before.why] ?? 0) && c.foes < before.foes + 3) continue;
            const count = callCount(c, u.foes, nearFoe);
            const where = placeName(c.at, u.realm, regionId);
            const speaker = running.has(c.from) ? c.from : anyone;
            if (!speaker) continue;
            const text = c.why === 'camped' ? `${count} camping ${where.replace(/^(at|near) /, '')}, need help`
                : c.why === 'caught' ? `${count} on us ${where}, help!`
                : c.why === 'sighted' ? `${count} coming ${where}, need help`
                : `${count} ${where}, need help`;
            // Said again only if it grew a lot (a new bucket of 3) or got worse (sighted → outnumbered → caught).
            out.push({ key: `help:${c.id}:${c.why}:${c.foes}`, text, prio: c.why === 'outnumbered' ? 60 : 70, settleMs: 0, cooldownMs: Infinity, by: speaker, urgent: c.why !== 'outnumbered' });
        } else if (c.kind === 'defend') {
            // Our keep is attacked: everyone hears it, the units asked go.
            const count = callCount(c, u.foes, 4500);
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
            // Never the caller itself (an answer can outlive its call: ids start over when the director restarts).
            if (call && call.kind !== 'muster' && call.from !== e.unit) out.push({ key: `omw:${e.call}:${e.unit}`, text: 'omw', prio: 30, settleMs: 0, cooldownMs: Infinity, by: e.unit });
        } else if (e.kind === 'stage' && e.stage === 'go') {
            // The go, with why now: the same key as the call's plain go, so only one of them is said.
            const call = u.calls.find(c => c.id === e.call);
            const speaker = (call ? [...call.asked].sort().find(a => running.has(a)) : undefined) ?? anyone;
            const owner = e.owner && e.owner in REALM_WORD ? REALM_WORD[e.owner as PlayerRealm][1] : 'they';
            const why = (e.ownersAway ?? 0) > 0 ? ` ${owner} are busy elsewhere`
                : e.defenders === 0 ? ' nobody on it'
                : e.defenders !== undefined && e.defenders <= 3 ? ` only ${e.defenders} on it` : '';
            if (speaker) out.push({ key: `muster:${e.call}:go`, text: `go go, Faste!${why}`, prio: 76, settleMs: 0, cooldownMs: Infinity, by: speaker, urgent: true });
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
    private helpSaid = new Map<string, { foes: number; why: string; at?: Point }>();
    /** What was said of help calls that closed, kept HELP_MEMORY_MS. */
    private helpRecent: { foes: number; why: string; at?: Point; until: number }[] = [];
    constructor(limits: VoiceLimits = REGION_LIMITS) { this.voice = new Voice(limits); }
    hear(u: RegionInput, now: number, nearFoe?: number): Line | null {
        const fromEvents = regionClaims(u, nearFoe, 'events');
        for (const c of fromEvents) if (!this.held.some(h => h.claim.key === c.key)) this.held.push({ claim: c, until: now + REGION_EVENT_HOLD_MS });
        this.held = this.held.filter(h => h.until > now && this.voice.saidAt(h.claim.key) === undefined);
        const open = new Set(u.calls.map(c => c.id));
        for (const [id, s] of this.helpSaid) if (!open.has(id)) { this.helpSaid.delete(id); this.helpRecent.push({ ...s, until: now + HELP_MEMORY_MS }); }
        this.helpRecent = this.helpRecent.filter(r => r.until > now);
        inheritHelpSaid(u.calls, this.helpSaid, this.helpRecent);
        const fromCalls = regionClaims(u, nearFoe, 'calls', this.helpSaid);
        const line = this.voice.offer([...fromCalls, ...this.held.map(h => h.claim)], now);
        const help = line && /^help:(.+):([a-z]+):(\d+)$/.exec(line.key);
        if (help) this.helpSaid.set(help[1]!, { why: help[2]!, foes: Number(help[3]), at: u.calls.find(c => c.id === help[1])?.at });
        return line;
    }
}
