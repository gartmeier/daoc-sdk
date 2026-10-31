// Shared awareness: every member publishes what its own client sees, and the
// blackboard merges that into one picture of the group and its enemies.
//
// Knowledge is partial and ages. A contact keeps the freshest sighting any member
// had; it turns `stale` when nobody has seen it for a while, and it is dropped
// when a member standing near its last position no longer sees it (it died,
// despawned or walked off) or after forgetAfterMs.

import type { BotWorldState } from '../types';
import { isKillable } from '../actions-helpers';
import type { Activity, Capabilities, Contact, GroupEvent, GroupPicture, MemberReport, Orders, OrdersUpdate, Role, Sighting } from './types';

export interface BlackboardOptions {
    /** A contact nobody has seen for this long is marked stale (default 5000). */
    staleAfterMs?: number;
    /** ... and forgotten after this long (default 60000). */
    forgetAfterMs?: number;
    /** A member this close to a contact's last position should see it; if it doesn't, the contact is gone (default 2500). */
    viewRadius?: number;
    /** Events kept for late readers (default 5000). */
    maxEvents?: number;
    /** A contact stays a threat this long after its last hostile sign (default 4000). */
    hostileMs?: number;
}

/** The part of a member's report its agent knows and the snapshot does not. */
export interface MemberSelf {
    bot: string;
    role: Role;
    activity: Activity;
    capabilities: Capabilities;
}

export interface Observation {
    report: MemberReport;
    sightings: Sighting[];
    /** Object ids the client saw die (server death events). */
    deaths: number[];
}

const SWING_WINDOW_MS = 2000;

/**
 * Turn one member's snapshot into its report and sightings (pure). Sightings are
 * monsters it could fight and players of other realms, within `sightRadius`.
 */
export function observeState(state: BotWorldState, self: MemberSelf, sightRadius = 3000): Observation | null {
    const p = state.player;
    if (!state.inGame || !p) return null;
    const lastSwing = new Map<number, number>();
    const deaths: number[] = [];
    for (const e of state.combatEvents) {
        // Object ids are reused after a mob is removed: only fresh deaths count.
        if (e.kind === 'death' && e.targetObjectId !== null && e.receivedAt > state.timestamp - 5000) deaths.push(e.targetObjectId);
        if (e.kind === 'melee' && e.attackerObjectId !== null && e.receivedAt > state.timestamp - SWING_WINDOW_MS) {
            lastSwing.set(e.attackerObjectId, Math.max(lastSwing.get(e.attackerObjectId) ?? 0, e.receivedAt));
        }
    }
    const sightings: Sighting[] = [];
    for (const n of state.nearbyNpcs) {
        if (n.distance2d > sightRadius) continue;
        if (n.healthPercent <= 0) { deaths.push(n.objectId); continue; }
        if (!isKillable(n, p)) continue;
        sightings.push({
            objectId: n.objectId, kind: 'npc', name: n.name, level: n.level, realm: n.realm,
            x: n.x, y: n.y, z: n.z, hp: n.healthPercent, targetId: n.targetObjectId, inCombat: n.inCombat,
            swinging: lastSwing.has(n.objectId),
        });
    }
    for (const o of state.nearbyPlayers) {
        if (o.distance2d > sightRadius || o.realm === p.realm || o.realm === 'none') continue;
        if (o.isDead || o.healthPercent <= 0) { deaths.push(o.objectId); continue; }
        sightings.push({
            objectId: o.objectId, kind: 'player', name: o.name, level: o.level, realm: o.realm,
            x: o.x, y: o.y, z: o.z, hp: o.healthPercent, targetId: null, inCombat: o.inCombat,
            swinging: lastSwing.has(o.objectId),
        });
    }
    const report: MemberReport = {
        name: p.name, bot: self.bot, role: self.role, className: p.className, level: p.level, experience: p.experience,
        objectId: p.objectId, regionId: p.regionId, x: p.x, y: p.y, z: p.z,
        hp: p.healthPercent, mana: p.manaPercent, endurance: p.endurancePercent,
        load: p.encumbrance && p.encumbrance.max > 0 ? Math.round(100 * p.encumbrance.current / p.encumbrance.max) : 0,
        isDead: p.isDead, isSitting: p.isSitting, inCombat: p.inCombat, attacking: p.attacking, targetId: p.targetObjectId,
        effects: state.effects.map(e => e.name), capabilities: self.capabilities, activity: self.activity,
        at: state.timestamp,
    };
    return { report, sightings, deaths };
}

export function emptyOrders(now = Date.now()): Orders {
    return { seq: 0, phase: 'idle', objective: '', anchor: null, facing: null, focus: null, puller: null, cc: [], retreatTo: null, waiting: [], reason: 'start', issuedAt: now };
}

const moved = (a: { x: number; y: number } | null, b: { x: number; y: number } | null, by: number) =>
    !a !== !b || (!!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) > by);
const ccKey = (o: Orders) => o.cc.map(c => `${c.targetId}:${c.by}`).sort().join(',');

/** Orders changed in a way that should interrupt what members are doing. */
export function isMaterialChange(a: Orders, b: Orders): boolean {
    return a.phase !== b.phase || a.focus !== b.focus || a.puller !== b.puller || ccKey(a) !== ccKey(b)
        || moved(a.retreatTo, b.retreatTo, 300) || moved(a.anchor, b.anchor, 300);
}

/** Late sightings of a dead mob (a member's client lags) are ignored this long ... */
const KILLED_MS = 20_000;
/** ... when they are this close to its corpse and carry its name. */
const CORPSE_RADIUS = 300;
/** A death stays in members' observations this long (observeState keeps death events 5 s), plus lag. */
const DEATH_ECHO_MS = 6000;

/**
 * `engaged`: the group fought it, so its death is a kill event (not `engagedAt`, the engage order).
 * `deathEchoUntil`: it inherited a dead mob's id; deaths reported for that id until then are the old mob's.
 */
type InternalContact = Contact & { engaged: boolean; ccSince: number; lastHostile: number; deathEchoUntil: number };

export class Blackboard {
    private readonly reports = new Map<string, MemberReport>();
    private readonly contacts = new Map<string, InternalContact>();
    /** Recently died, by key, with where and as what: ignore its own late sightings (ids are reused at once). */
    private readonly killed = new Map<string, { at: number; name: string; x: number; y: number; hp: number }>();
    private orders: Orders = emptyOrders();
    private readonly eventLog: GroupEvent[] = [];
    private readonly eventListeners = new Set<(e: GroupEvent) => void>();
    private readonly orderListeners = new Set<(next: Orders, prev: Orders) => void>();
    private readonly staleAfterMs: number;
    private readonly forgetAfterMs: number;
    private readonly viewRadius: number;
    private readonly maxEvents: number;
    private readonly hostileMs: number;

    constructor(options: BlackboardOptions = {}) {
        this.staleAfterMs = options.staleAfterMs ?? 5000;
        this.forgetAfterMs = options.forgetAfterMs ?? 60_000;
        this.viewRadius = options.viewRadius ?? 2500;
        this.maxEvents = options.maxEvents ?? 5000;
        this.hostileMs = options.hostileMs ?? 4000;
    }

    /** Merge one member's observation. */
    publish(obs: Observation, now = Date.now()): void {
        const r = obs.report;
        const prev = this.reports.get(r.name);
        this.reports.set(r.name, r);
        if (prev && !prev.isDead && r.isDead) this.emit({ at: now, kind: 'death', member: r.name, text: `${r.name} died` });
        if (prev && r.level > prev.level) this.emit({ at: now, kind: 'level', member: r.name, text: `${r.name} reached level ${r.level}` });

        const memberById = new Map<number, string>();
        for (const m of this.reports.values()) if (m.regionId === r.regionId) memberById.set(m.objectId, m.name);
        const targetedByUs = new Set([...this.reports.values()].map(m => m.targetId).filter((t): t is number => t !== null));
        const attackedByUs = new Set([...this.reports.values()].filter(m => m.attacking && !m.isDead).map(m => m.targetId));

        const seen = new Set<string>();
        for (const s of obs.sightings) {
            const key = `${r.regionId}:${s.objectId}`;
            const dead = this.killed.get(key);
            let deathEchoUntil = 0;
            if (dead) {
                // Only the dead mob's own late sightings are ignored. Anything else under its id
                // is a mob that inherited it (the server frees ids on death): a new contact at once.
                // A camp respawn can inherit the id at the same spot: it shows full health, the corpse never more than it died with.
                if (now - dead.at < KILLED_MS && s.name === dead.name && Math.hypot(s.x - dead.x, s.y - dead.y) < CORPSE_RADIUS && s.hp <= dead.hp + 5) continue;
                this.killed.delete(key);
                deathEchoUntil = dead.at + DEATH_ECHO_MS;
            }
            seen.add(key);
            const target = s.targetId !== null ? memberById.get(s.targetId) ?? null : null;
            let c = this.contacts.get(key);
            if (!c) {
                c = { ...s, regionId: r.regionId, target, targetSince: now, engagedAt: 0, movedAt: 0, seenBy: [], firstSeen: now, lastSeen: r.at, stale: false, threat: false, hostileSince: 0, cc: null, engaged: false, ccSince: 0, lastHostile: 0, deathEchoUntil };
                this.contacts.set(key, c);
            } else if (r.at >= c.lastSeen) {
                // In combat with no target: the server sends none (65535) while the mob runs or its
                // target is out of reach. Keep the last one, so target and targetSince don't blink.
                const unknown = s.targetId === null && s.inCombat;
                if (unknown && c.targetId !== null) {
                    Object.assign(c, s, { targetId: c.targetId, target: c.target, lastSeen: r.at });
                    // Running before the engage order: a carried pull (its hold counts from engagedAt).
                    if (c.engagedAt === 0) c.movedAt = now;
                } else {
                    // A new target, or none after a reset or leash (no longer in combat).
                    if (c.targetId !== s.targetId) c.targetSince = now;
                    Object.assign(c, s, { target, lastSeen: r.at });
                }
            }
            if (!c.seenBy.includes(r.name)) c.seenBy.push(r.name);
            // The contact's target, which is kept while it runs at a member; an older report's own as a fallback.
            const onMember = c.target ?? target;
            if (onMember || targetedByUs.has(s.objectId)) c.engaged = true;
            if (onMember || s.swinging || attackedByUs.has(s.objectId)) {
                if (now - c.lastHostile > this.hostileMs) c.hostileSince = now;
                c.lastHostile = now;
            }
            // A mezzed mob does not swing: a swing after the cc landed means it broke.
            if (c.cc && s.swinging && now - c.ccSince > SWING_WINDOW_MS) {
                this.emit({ at: now, kind: 'note', member: c.cc.by, targetId: c.objectId, text: `${c.cc.kind} on ${c.name} broke` });
                c.cc = null;
            }
        }
        for (const id of obs.deaths) this.kill(`${r.regionId}:${id}`, r.name, now);
        // Contacts this member should see but doesn't: gone (died out of our sight, despawned, left).
        for (const [key, c] of this.contacts) {
            if (seen.has(key) || c.regionId !== r.regionId) continue;
            const i = c.seenBy.indexOf(r.name);
            if (i >= 0) c.seenBy.splice(i, 1);
            if (!r.isDead && Math.hypot(c.x - r.x, c.y - r.y) < this.viewRadius && r.at - c.lastSeen > 1500) this.contacts.delete(key);
        }
    }

    private kill(key: string, by: string, now: number): void {
        const c = this.contacts.get(key);
        // A mob that just inherited the id: the death members still report is its predecessor's.
        if (!c || now < c.deathEchoUntil) return;
        this.contacts.delete(key);
        for (const [k, d] of this.killed) if (now - d.at >= KILLED_MS) this.killed.delete(k);
        this.killed.set(key, { at: now, name: c.name, x: c.x, y: c.y, hp: c.hp });
        if (c.engaged) this.emit({ at: now, kind: 'kill', member: by, targetId: c.objectId, text: `${c.name} (L${c.level}) died`, data: { name: c.name, level: c.level } });
    }

    /** Record crowd control a member landed, so nobody hits or re-mezzes it. */
    markCc(targetId: number, regionId: number, by: string, kind: string, durationMs: number, now = Date.now()): void {
        const c = this.contacts.get(`${regionId}:${targetId}`);
        if (!c) return;
        c.cc = { by, kind, until: now + durationMs };
        c.ccSince = now;
    }

    /** The current shared picture (copies; safe to keep). */
    picture(now = Date.now()): GroupPicture {
        const contacts: Contact[] = [];
        for (const [key, c] of this.contacts) {
            if (now - c.lastSeen > this.forgetAfterMs) { this.contacts.delete(key); continue; }
            if (c.cc && c.cc.until <= now) c.cc = null;
            const { engaged: _e, ccSince: _s, deathEchoUntil: _d, lastHostile, ...pub } = c;
            const stale = now - c.lastSeen > this.staleAfterMs;
            const threat = !stale && c.hp > 0 && now - lastHostile < this.hostileMs;
            contacts.push({ ...pub, seenBy: [...c.seenBy], stale, threat, hostileSince: threat ? c.hostileSince : 0, cc: c.cc ? { ...c.cc } : null });
        }
        return { at: now, members: [...this.reports.values()].map(m => ({ ...m })), contacts, orders: this.getOrders() };
    }

    getOrders(): Orders {
        return { ...this.orders, cc: this.orders.cc.map(c => ({ ...c })), waiting: this.orders.waiting.map(w => ({ ...w })) };
    }

    /** Apply the coordinator's update. Returns true when the change is material (seq bumped). */
    setOrders(update: OrdersUpdate, now = Date.now()): boolean {
        const prev = this.orders;
        const next: Orders = { ...prev, ...update, seq: prev.seq, issuedAt: prev.issuedAt };
        const material = isMaterialChange(prev, next);
        if (material) {
            next.seq = prev.seq + 1;
            next.issuedAt = now;
        }
        this.orders = next;
        const focus = this.contactById(next.focus);
        // Set once per contact (cc or reason changes don't move it): a carried mob's hold counts from here.
        if (next.phase === 'engage' && focus && focus.engagedAt === 0) focus.engagedAt = now;
        if (material) {
            this.emit({
                at: now, kind: 'orders', targetId: next.focus,
                text: `${next.phase}${focus ? ` on ${focus.name}` : ''}${next.cc.length ? ` (cc ${next.cc.map(c => `${c.by}→${c.targetId}`).join(', ')})` : ''}: ${next.reason}`,
                data: { phase: next.phase, focus: next.focus, puller: next.puller, seq: next.seq },
            });
            for (const l of this.orderListeners) l(this.getOrders(), prev);
        }
        return material;
    }

    /** The contact under an object id. Ids are per region: the most recently seen one wins. */
    private contactById(id: number | null): InternalContact | undefined {
        let best: InternalContact | undefined;
        if (id === null) return best;
        for (const c of this.contacts.values()) if (c.objectId === id && (!best || c.lastSeen > best.lastSeen)) best = c;
        return best;
    }

    emit(event: GroupEvent): void {
        this.eventLog.push(event);
        if (this.eventLog.length > this.maxEvents) this.eventLog.splice(0, this.eventLog.length - this.maxEvents);
        for (const l of this.eventListeners) l(event);
    }

    events(since = 0): GroupEvent[] {
        return this.eventLog.filter(e => e.at >= since);
    }

    onEvent(listener: (e: GroupEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    /** Called after every material orders change. */
    onOrders(listener: (next: Orders, prev: Orders) => void): () => void {
        this.orderListeners.add(listener);
        return () => this.orderListeners.delete(listener);
    }
}
