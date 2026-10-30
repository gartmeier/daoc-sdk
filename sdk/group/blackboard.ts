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

type InternalContact = Contact & { engaged: boolean; ccSince: number; lastHostile: number };

export class Blackboard {
    private readonly reports = new Map<string, MemberReport>();
    private readonly contacts = new Map<string, InternalContact>();
    /** Recently died, by key: ignore late sightings of them (ids are reused, so not forever). */
    private readonly killed = new Map<string, number>();
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
            if (now - (this.killed.get(key) ?? -Infinity) < 20_000) continue;
            seen.add(key);
            const target = s.targetId !== null ? memberById.get(s.targetId) ?? null : null;
            let c = this.contacts.get(key);
            if (!c) {
                c = { ...s, regionId: r.regionId, target, targetSince: now, seenBy: [], firstSeen: now, lastSeen: r.at, stale: false, threat: false, hostileSince: 0, cc: null, engaged: false, ccSince: 0, lastHostile: 0 };
                this.contacts.set(key, c);
            } else if (r.at >= c.lastSeen) {
                if (c.targetId !== s.targetId) c.targetSince = now;
                Object.assign(c, s, { target, lastSeen: r.at });
            }
            if (!c.seenBy.includes(r.name)) c.seenBy.push(r.name);
            if (target || targetedByUs.has(s.objectId)) c.engaged = true;
            if (target || s.swinging || attackedByUs.has(s.objectId)) {
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
        if (!c) return;
        this.contacts.delete(key);
        this.killed.set(key, now);
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
            const { engaged: _e, ccSince: _s, lastHostile, ...pub } = c;
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
        if (material) {
            const focus = next.focus !== null ? [...this.contacts.values()].find(c => c.objectId === next.focus) : null;
            this.emit({
                at: now, kind: 'orders', targetId: next.focus,
                text: `${next.phase}${focus ? ` on ${focus.name}` : ''}${next.cc.length ? ` (cc ${next.cc.map(c => `${c.by}→${c.targetId}`).join(', ')})` : ''}: ${next.reason}`,
                data: { phase: next.phase, focus: next.focus, puller: next.puller, seq: next.seq },
            });
            for (const l of this.orderListeners) l(this.getOrders(), prev);
        }
        return material;
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
