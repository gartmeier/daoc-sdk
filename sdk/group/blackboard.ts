// Shared awareness: every member publishes what its own client sees, and the
// blackboard merges that into one picture of the group and its enemies.
//
// Knowledge is partial and ages. A contact keeps the freshest sighting any member
// had; it turns `stale` when nobody has seen it for a while, and it is dropped
// when a member standing near its last position no longer sees it (it died,
// despawned or walked off) or after forgetAfterMs.
//
// The server never sends an enemy player's target: only the player's own client
// gets it (WeaponAction.cs SendChangeTarget; assist.cs refuses other realms).
// Every client in view does get the fights around it: 0xBC CombatAnimation
// (attacker, defender; WeaponAction.cs), 0x72 SpellCastAnimation (caster) and
// 0x1B SpellEffectAnimation (caster, target; SpellHandler.cs). A player's target,
// casts and heals are read from those combat events. Those reach everyone within
// 6000 of the fight, so a swinging player is a threat to the group only when it is
// on a member, fights us, or swings or casts within hostileRadius of a member:
// in a three-realm battleground the other two fighting each other are not.
//
// A monster's target comes from the server, but only while it is in attack state and
// within its attack range (PacketLib168.cs): one starting a timed cast leaves attack
// state, so a caster nuking a member from range reports none. Its hostile spell effects
// stand in for that target. Spell effects only: a swing would keep a mob's old target
// after a reset, and the server keeps naming the target of a mob that swings.
//
// A player dies only by its death event or isDead, never by 0 % health: the
// server rounds health down (GameLiving.cs:2621), so a living player with a few
// hit points reads 0.

import type { BotWorldState, PlayerState, Realm } from '../types';
import { isKillable, PLAYER_AIM_MS } from '../actions-helpers';
import { CC_IMMUNE_MS, npcCcLanded, readCcEnds, serverNameKey, type CcEnd, type CcImmunity, type CcKind, type NpcCcRun } from './cc';
import type { Activity, Capabilities, MemberCombat, Contact, GroupEvent, GroupPicture, MemberReport, Orders, OrdersUpdate, Role, Sighting } from './types';

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
    /**
     * An enemy player swinging or casting at someone we can't name (another realm's player, or a cast
     * whose target is unknown until it lands) is hostile within this distance of a living member
     * (default 2500, the rvr strategy's engage radius); farther off it is someone else's fight.
     */
    hostileRadius?: number;
}

/** The part of a member's report its agent knows and the snapshot does not. */
export interface MemberSelf {
    bot: string;
    role: Role;
    activity: Activity;
    capabilities: Capabilities;
    combat?: MemberCombat;
}

/** Who killed a member, as its client saw them (the board's 'death' event data). Enemy players go by race name. */
export interface Killer {
    name: string;
    kind: 'npc' | 'player';
    realm: Realm;
}

export interface Observation {
    report: MemberReport;
    sightings: Sighting[];
    /** Object ids the client saw die: server death events, NPCs at 0 %, players marked dead while their entry is fresh. */
    deaths: number[];
    /** Players among `deaths` whose killer (named by 0xAE PlayerDeath) is in view and of another realm than ours, a monster too. */
    foeKills?: number[];
    /**
     * Enemy players this member hit lately: a swing that landed (a miss, parry, block or evade does
     * no damage, so the server gives no share of the kill for it: GameLiving.TakeDamage → AddXPGainer),
     * or a hostile spell, which counts whatever it did: the effect animation doesn't tell a nuke from a mezz.
     */
    hits?: number[];
    /** While the member is dead: who killed it; null when it is alive or the killer is unknown. */
    killer?: Killer | null;
    /** Crowd control the server told this member has ended, from the last CC_END_MS of messages. */
    ccEnds?: CcEnd[];
}

const SWING_WINDOW_MS = 2000;
/** A message about crowd control ending is reported this long: the board goes by its time, so repeats change nothing. */
const CC_END_MS = 3000;
/** A rooted player creeps at 1 % speed, about 2 units/s: this far from where the root landed means it broke. */
const ROOT_BROKEN_MOVE = 120;
/** An enemy player's target: its latest swing or hostile spell this recent (longer than a slow weapon's swing). */
const PLAYER_TARGET_MS = PLAYER_AIM_MS;
/** A monster the server names no target for: its latest hostile spell effect this recent. */
const SPELL_TARGET_MS = PLAYER_AIM_MS;
/**
 * A dead player's model entry counts as a death only this fresh. A release moves the player within
 * the region without telling those who saw it die (GamePlayer.MoveTo), so its entry stays dead at the
 * corpse while we stand near: reported on every publish, it would delete the live contact another
 * member sees after it walked back. The death event itself is reported for 5 s.
 */
const DEAD_ENTRY_MS = 3000;
/** A cast counts this long at least (an instant spell's cast time is 0). */
const CASTING_MS = 3000;
/** It landed a spell on another player of its own realm (a heal or buff) this recent. */
const HELPED_MS = 5000;
/** The killer is looked for among combat events this recent. */
const KILLER_MS = 15_000;

/**
 * Turn one member's snapshot into its report and sightings (pure). Sightings are
 * monsters it could fight and players of other realms, within `sightRadius`.
 */
export function observeState(state: BotWorldState, self: MemberSelf, sightRadius = 3000): Observation | null {
    const p = state.player;
    if (!state.inGame || !p) return null;
    const now = state.timestamp;
    // A spell effect is hostile when caster and target are of different realms (monsters are 'none').
    const realmOf = new Map<number, Realm>([[p.objectId, p.realm]]);
    for (const n of state.nearbyNpcs) realmOf.set(n.objectId, n.realm);
    for (const o of state.nearbyPlayers) realmOf.set(o.objectId, o.realm);
    const isPlayer = new Set(state.nearbyPlayers.map(o => o.objectId));
    const lastSwing = new Set<number>();
    // Hostile spell effects and cast starts in the swing window: a player's swing (see its sighting).
    const lastSpell = new Set<number>();
    const aim = new Map<number, { targetId: number; at: number }>();
    const spellAim = new Map<number, { targetId: number; at: number }>();
    const casting = new Set<number>();
    const helped = new Set<number>();
    const deaths: number[] = [];
    const foeKills: number[] = [];
    const hits = new Set<number>();
    for (const e of state.combatEvents) {
        const by = e.attackerObjectId, on = e.targetObjectId, age = now - e.receivedAt;
        // Object ids are reused after a mob is removed: only fresh deaths count.
        if (e.kind === 'death' && on !== null && age < 5000) {
            deaths.push(on);
            // A player's death event names its killer (PacketLib168.cs SendPlayerDied), a mob's none.
            const killer = by !== null ? realmOf.get(by) : undefined;
            if (killer !== undefined && killer !== p.realm) foeKills.push(on);
        }
        if (by === null) continue;
        const effect = e.kind === 'spellEffect' && on !== null && realmOf.has(by) && realmOf.has(on);
        const hostile = e.kind === 'melee' || (effect && realmOf.get(by) !== realmOf.get(on!));
        if (e.kind === 'melee' && age < SWING_WINDOW_MS) lastSwing.add(by);
        if (hostile && e.kind === 'spellEffect' && age < SWING_WINDOW_MS) lastSpell.add(by);
        if (hostile && on !== null && age < PLAYER_TARGET_MS && e.receivedAt >= (aim.get(by)?.at ?? -Infinity)) aim.set(by, { targetId: on, at: e.receivedAt });
        if (hostile && e.kind === 'spellEffect' && age < SPELL_TARGET_MS && e.receivedAt >= (spellAim.get(by)?.at ?? -Infinity)) spellAim.set(by, { targetId: on!, at: e.receivedAt });
        // Any swing shows its aim, only one that landed did damage.
        const landed = e.kind !== 'melee' || e.result === undefined || e.result === 'hit' || e.result === 'styledHit';
        if (hostile && landed && by === p.objectId && isPlayer.has(on!) && age < PLAYER_TARGET_MS) hits.add(on!);
        if (effect && !hostile && on !== by && isPlayer.has(on!) && age < HELPED_MS) helped.add(by);
        if (e.kind === 'spellCast') {
            if (age < Math.max(e.castTimeMs ?? 0, CASTING_MS)) casting.add(by);
            if (age < SWING_WINDOW_MS) lastSpell.add(by);
        }
    }
    const sightings: Sighting[] = [];
    for (const n of state.nearbyNpcs) {
        const spell = spellAim.get(n.objectId);
        const aimed = aim.get(n.objectId)?.targetId;
        if (n.distance2d > sightRadius) continue;
        if (n.healthPercent <= 0) { deaths.push(n.objectId); continue; }
        if (!isKillable(n, p)) continue;
        sightings.push({
            objectId: n.objectId, kind: 'npc', name: n.name, level: n.level, realm: n.realm,
            x: n.x, y: n.y, z: n.z, hp: n.healthPercent, targetId: n.targetObjectId, inCombat: n.inCombat,
            spellTargetId: spell?.targetId ?? null,
            // A spell that landed counts, not a cast start, which may be a self-buff. Like a swing it ends a mezz:
            // a mezz stops the cast under way and any new one (CrowdControlECSEffect.cs OnHardCCStart,
            // CastingComponent.cs CanCastSpell), a bolt shows at launch, and DoT ticks show nothing (DoTSpellHandler.cs).
            swinging: lastSwing.has(n.objectId) || (spell !== undefined && now - spell.at < SWING_WINDOW_MS),
            aimedAtPlayer: aimed !== undefined && isPlayer.has(aimed) ? aimed : null,
        });
    }
    for (const o of state.nearbyPlayers) {
        if (o.distance2d > sightRadius || o.realm === p.realm || o.realm === 'none') continue;
        // Dead by isDead only; at 0 % it may be alive. A stale corpse is no news (DEAD_ENTRY_MS).
        if (o.isDead) {
            if (o.lastSeenAgo < DEAD_ENTRY_MS) deaths.push(o.objectId);
            continue;
        }
        sightings.push({
            objectId: o.objectId, kind: 'player', name: o.name, level: o.level, realm: o.realm,
            x: o.x, y: o.y, z: o.z, hp: o.healthPercent, targetId: aim.get(o.objectId)?.targetId ?? null, inCombat: o.inCombat,
            // A cast's target is unknown until its effect lands, so any cast start counts. A mezzed or
            // stunned player can neither swing nor cast: the board's mezz-break check stays right.
            swinging: lastSwing.has(o.objectId) || lastSpell.has(o.objectId),
            casting: casting.has(o.objectId), helped: helped.has(o.objectId),
        });
    }
    const report: MemberReport = {
        name: p.name, bot: self.bot, role: self.role, className: p.className, level: p.level, experience: p.experience,
        realmPoints: p.realmPoints, objectId: p.objectId, regionId: p.regionId, x: p.x, y: p.y, z: p.z,
        hp: p.healthPercent, maxHp: p.maxHealth, mana: p.manaPercent, endurance: p.endurancePercent,
        load: p.encumbrance && p.encumbrance.max > 0 ? Math.round(100 * p.encumbrance.current / p.encumbrance.max) : 0,
        isDead: p.isDead, isSitting: p.isSitting, inCombat: p.inCombat, attacking: p.attacking, targetId: p.targetObjectId,
        effects: state.effects.map(e => e.name), capabilities: self.capabilities, activity: self.activity, combat: self.combat,
        at: state.timestamp,
    };
    const ccEnds = readCcEnds(state.gameMessages ?? [], state.timestamp - CC_END_MS);
    return { report, sightings, deaths, foeKills, hits: [...hits], killer: p.isDead ? killerOf(state, p) : null, ...(ccEnds.length ? { ccEnds } : {}) };
}

/**
 * Who killed `p`: the death event's killer (0xAE PlayerDeath names it; GamePlayer.cs),
 * else the newest foe that hit it, while still in view; null otherwise. A friend's heal
 * or buff is a spell effect on it too, so a hitter counts only when of another realm.
 */
function killerOf(state: BotWorldState, p: PlayerState): Killer | null {
    const who = (id: number): Killer | null => {
        const n = state.nearbyNpcs.find(x => x.objectId === id);
        if (n) return { name: n.name, kind: 'npc', realm: n.realm };
        const o = state.nearbyPlayers.find(x => x.objectId === id);
        return o ? { name: o.name, kind: 'player', realm: o.realm } : null;
    };
    // Newest first.
    const hits = state.combatEvents.filter(e => e.targetObjectId === p.objectId && e.attackerObjectId !== null && e.attackerObjectId !== p.objectId
        && e.receivedAt > state.timestamp - KILLER_MS).reverse();
    const death = hits.find(e => e.kind === 'death');
    const killer = death ? who(death.attackerObjectId!) : null;
    if (killer) return killer;
    for (const e of hits) {
        if (e.kind !== 'melee' && e.kind !== 'spellEffect') continue;
        const k = who(e.attackerObjectId!);
        if (k && k.realm !== p.realm) return k;
    }
    return null;
}

/**
 * Still alive as far as the board knows. A monster at 0 % is dead (the board drops it at once); a player
 * leaves the board only on its death event or dead flag, since the server rounds health down and a
 * living player can read 0 % (GameLiving.cs:2621).
 */
export const isAlive = (c: Pick<Contact, 'kind' | 'hp'>) => c.kind === 'player' || c.hp > 0;

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
/** ... a player's only this long: players keep their id, and one seen alive after this was rezzed. */
const PLAYER_KILLED_MS = 3000;
/** ... when they are this close to its corpse and carry its name. */
const CORPSE_RADIUS = 300;
/** A death stays in members' observations this long (observeState keeps death events 5 s), plus lag. */
const DEATH_ECHO_MS = 6000;

/**
 * `engaged`: the group fought it, so its death is a kill event (not `engagedAt`, the engage order).
 * `hit`: a member hit it (an enemy player), so it is our kill even when another realm finishes it:
 * the server shares a player kill among all who damaged it (PlayerKillRewardProcessor.cs).
 * `deathEchoUntil`: it inherited a dead mob's id; deaths reported for that id until then are the old mob's.
 */
type InternalContact = Contact & { engaged: boolean; hit: boolean; ccSince: number; ccAt?: { x: number; y: number }; ccRuns?: Partial<Record<CcKind, NpcCcRun>>; lastHostile: number; deathEchoUntil: number };

export class Blackboard {
    private readonly reports = new Map<string, MemberReport>();
    private readonly contacts = new Map<string, InternalContact>();
    /** Recently died, by key, with where and as what: ignore its own late sightings (ids are reused at once). */
    private readonly killed = new Map<string, { at: number; name: string; x: number; y: number; hp: number; player: boolean }>();
    /** What we knew about crowd control on a contact gone from view: it outlasts forgetAfterMs, so it comes back with it. Not after a death. */
    private readonly ccMemory = new Map<string, Pick<InternalContact, 'ccImmune' | 'serverName' | 'ccRuns'>>();
    private orders: Orders = emptyOrders();
    private readonly eventLog: GroupEvent[] = [];
    private readonly eventListeners = new Set<(e: GroupEvent) => void>();
    private readonly orderListeners = new Set<(next: Orders, prev: Orders) => void>();
    private readonly staleAfterMs: number;
    private readonly forgetAfterMs: number;
    private readonly viewRadius: number;
    private readonly maxEvents: number;
    private readonly hostileMs: number;
    private readonly hostileRadius: number;

    constructor(options: BlackboardOptions = {}) {
        this.staleAfterMs = options.staleAfterMs ?? 5000;
        this.forgetAfterMs = options.forgetAfterMs ?? 60_000;
        this.viewRadius = options.viewRadius ?? 2500;
        this.maxEvents = options.maxEvents ?? 5000;
        this.hostileMs = options.hostileMs ?? 4000;
        this.hostileRadius = options.hostileRadius ?? 2500;
    }

    /** Merge one member's observation. */
    publish(obs: Observation, now = Date.now()): void {
        const r = obs.report;
        const prev = this.reports.get(r.name);
        this.reports.set(r.name, r);
        if (prev && !prev.isDead && r.isDead) this.emit({ at: now, kind: 'death', member: r.name, text: `${r.name} died`, data: { killer: obs.killer ?? null } });
        if (prev && r.level > prev.level) this.emit({ at: now, kind: 'level', member: r.name, text: `${r.name} reached level ${r.level}` });

        const memberById = new Map<number, string>();
        for (const m of this.reports.values()) if (m.regionId === r.regionId) memberById.set(m.objectId, m.name);
        const targetedByUs = new Set([...this.reports.values()].map(m => m.targetId).filter((t): t is number => t !== null));
        const attackedByUs = new Set([...this.reports.values()].filter(m => m.attacking && !m.isDead).map(m => m.targetId));
        const hitByUs = new Set(obs.hits);
        const living = [...this.reports.values()].filter(m => m.regionId === r.regionId && !m.isDead);
        const nearUs = (s: Sighting) => living.some(m => Math.hypot(m.x - s.x, m.y - s.y) < this.hostileRadius);
        const deadIds = new Set([...this.reports.values()].filter(m => m.isDead).map(m => m.objectId));

        const seen = new Set<string>();
        for (const sighted of obs.sightings) {
            const key = `${r.regionId}:${sighted.objectId}`;
            // Its spell names the target the server doesn't. Not while it is crowd-controlled: that spell is from
            // before, and it would hold a mezzed add as a threat for the whole aim window (behaviors.ts position()
            // counts on them dropping out). Not on a dead member either: nothing else would end it.
            // In combat with no target it is running (the 65535 below), so it isn't standing to cast.
            const spellTarget = sighted.spellTargetId ?? null;
            const bySpell = sighted.targetId === null && !sighted.inCombat && spellTarget !== null && !this.contacts.get(key)?.cc && !deadIds.has(spellTarget);
            const s = bySpell ? { ...sighted, targetId: spellTarget } : sighted;
            const dead = this.killed.get(key);
            let deathEchoUntil = 0;
            if (dead) {
                // Only the dead mob's own late sightings are ignored. Anything else under its id
                // is a mob that inherited it (the server frees ids on death): a new contact at once.
                // A camp respawn can inherit the id at the same spot: it shows full health, the corpse never more than it died with.
                if (now - dead.at < (dead.player ? PLAYER_KILLED_MS : KILLED_MS) && s.name === dead.name && Math.hypot(s.x - dead.x, s.y - dead.y) < CORPSE_RADIUS && s.hp <= dead.hp + 5) continue;
                this.killed.delete(key);
                deathEchoUntil = dead.at + DEATH_ECHO_MS;
            }
            seen.add(key);
            const target = s.targetId !== null ? memberById.get(s.targetId) ?? null : null;
            let c = this.contacts.get(key);
            if (!c) {
                c = { ...s, targetBySpell: bySpell, regionId: r.regionId, target, targetSince: now, engagedAt: 0, movedAt: 0, seenBy: [], firstSeen: now, lastSeen: r.at, stale: false, threat: false, hostileSince: 0, cc: null, engaged: false, hit: false, ccSince: 0, lastHostile: 0, deathEchoUntil };
                if (s.kind === 'player') Object.assign(c, { healer: false, caster: false });
                Object.assign(c, this.ccMemory.get(key));
                this.ccMemory.delete(key);
                this.contacts.set(key, c);
            } else if (r.at >= c.lastSeen) {
                // A mob in combat with no target: the server sends none (65535) while it runs or its
                // target is out of reach. Keep the last one, so target and targetSince don't blink.
                // A player's inCombat is only its attack mode (AttackState; PlayerPositionUpdateHandler.cs),
                // and observeState already keeps its target PLAYER_TARGET_MS after the last hit.
                const unknown = s.kind === 'npc' && s.targetId === null && s.inCombat;
                if (unknown && c.targetId !== null) {
                    Object.assign(c, s, { targetId: c.targetId, target: c.target, targetBySpell: false, lastSeen: r.at });
                    // Running before the engage order: a carried pull (its hold counts from engagedAt).
                    if (c.engagedAt === 0) c.movedAt = now;
                } else {
                    // A new target, or none after a reset or leash (no longer in combat).
                    if (c.targetId !== s.targetId) c.targetSince = now;
                    Object.assign(c, s, { target, targetBySpell: bySpell, lastSeen: r.at });
                }
            }
            if (!c.seenBy.includes(r.name)) c.seenBy.push(r.name);
            // Sticky, from any member's sighting, fresh or late: one heal on its own realm makes a healer.
            if (s.helped) c.healer = true;
            if (s.casting) { c.caster = true; c.castingAt = now; }
            // The contact's target, which is kept while it runs at a member; an older report's own as a fallback.
            const onMember = c.target ?? target;
            if (onMember || targetedByUs.has(s.objectId)) c.engaged = true;
            // A player's swing or cast start on someone we can't name is hostile only near us: its
            // combat reaches every client within 6000, so far off it is two other realms' fight.
            // A monster's hit or spell on a player outside the group isn't our fight (pve.ts rejectPull: 'fighting someone else').
            const onStranger = s.kind === 'npc' && s.aimedAtPlayer != null && !memberById.has(s.aimedAtPlayer);
            const fighting = s.swinging && !onStranger && (s.kind === 'npc' || nearUs(s));
            if (onMember || fighting || attackedByUs.has(s.objectId) || hitByUs.has(s.objectId)) {
                if (now - c.lastHostile > this.hostileMs) c.hostileSince = now;
                c.lastHostile = now;
            }
            // A mezzed or stunned mob neither swings nor casts: either after the cc landed means it broke. A rooted one
            // can still do both: it isn't controlled then, and the group must be free to kill it, but the root is still
            // on it. Only walking off says a root broke: any hit that lands ends it (GameLiving.HandleCrowdControlOnAttacked).
            const rootBroke = c.cc?.kind === 'root' && c.ccAt && Math.hypot(c.x - c.ccAt.x, c.y - c.ccAt.y) > ROOT_BROKEN_MOVE;
            if (rootBroke || (c.cc && c.cc.kind !== 'root' && s.swinging && now - c.ccSince > SWING_WINDOW_MS)) {
                this.emit({ at: now, kind: 'note', member: c.cc!.by, targetId: c.objectId, text: `${c.cc!.kind} on ${c.name} broke` });
                this.ccEnded(c, c.cc!.kind as CcKind, now);
            } else if (c.cc?.kind === 'root' && s.swinging && now - c.ccSince > SWING_WINDOW_MS) c.cc = null;
        }
        for (const e of obs.ccEnds ?? []) this.ccEndedNamed(r.regionId, e);
        for (const id of obs.hits ?? []) {
            const c = this.contacts.get(`${r.regionId}:${id}`);
            if (c) c.hit = c.engaged = true;
        }
        const foeKills = new Set(obs.foeKills);
        for (const id of obs.deaths) this.kill(`${r.regionId}:${id}`, r.name, now, foeKills.has(id));
        // Contacts this member should see but doesn't: gone (died out of our sight, despawned, left).
        for (const [key, c] of this.contacts) {
            if (seen.has(key) || c.regionId !== r.regionId) continue;
            const i = c.seenBy.indexOf(r.name);
            if (i >= 0) c.seenBy.splice(i, 1);
            if (!r.isDead && Math.hypot(c.x - r.x, c.y - r.y) < this.viewRadius && r.at - c.lastSeen > 1500) this.forget(key, c);
        }
    }

    /** `byFoe`: a player another realm (or a monster) killed, which is ours only if we hit it too. */
    private kill(key: string, by: string, now: number, byFoe = false): void {
        const c = this.contacts.get(key);
        // A mob that just inherited the id: the death members still report is its predecessor's.
        if (!c || now < c.deathEchoUntil) return;
        this.contacts.delete(key);
        this.ccMemory.delete(key);
        for (const [k, d] of this.killed) if (now - d.at >= KILLED_MS) this.killed.delete(k);
        this.killed.set(key, { at: now, name: c.name, x: c.x, y: c.y, hp: c.hp, player: c.kind === 'player' });
        if (!c.engaged) return;
        if (byFoe && !c.hit) this.emit({ at: now, kind: 'note', member: by, targetId: c.objectId, text: `${c.name} (L${c.level}) died to someone else` });
        else this.emit({ at: now, kind: 'kill', member: by, targetId: c.objectId, text: `${c.name} (L${c.level}) died`, data: { name: c.name, level: c.level, kind: c.kind, realm: c.realm } });
    }

    /**
     * Record crowd control a member landed, so nobody hits it or casts that kind at it. `durationMs` is the spell's
     * full length: the server's own line ends it sooner (ccEnded). A root holds for half of that, then wears off
     * (ECSGameSpellEffect.cs, EffectService.cs), and a monster's repeats are shorter (npcCcLanded).
     */
    markCc(targetId: number, regionId: number, by: string, kind: string, durationMs: number, now = Date.now(), serverName?: string): void {
        const c = this.contacts.get(`${regionId}:${targetId}`);
        if (!c) return;
        const k = kind as CcKind;
        let lastsMs = durationMs;
        if (c.kind === 'player') (c.ccImmune ??= {})[k] = now + durationMs + CC_IMMUNE_MS;
        // A monster has no limit on roots (TryApplyImmunity is for players, and NpcImmunityEffect for mezz and stun).
        else if (k !== 'root') {
            const landed = npcCcLanded(c.ccRuns?.[k], durationMs, now);
            lastsMs = landed.durationMs;
            (c.ccRuns ??= {})[k] = landed.run;
            if (landed.immuneUntil) (c.ccImmune ??= {})[k] = landed.immuneUntil;
        }
        c.cc = { by, kind, until: now + (k === 'root' ? lastsMs / 2 : lastsMs) };
        c.ccSince = now;
        c.ccAt = { x: c.x, y: c.y };
        if (serverName) c.serverName = serverName;
    }

    /** Record that this kind can't land on it for up to `durationMs` (the server answered so), unless we already know until when. */
    markCcImmune(targetId: number, regionId: number, kind: CcKind, durationMs: number, now = Date.now()): void {
        const c = this.contacts.get(`${regionId}:${targetId}`);
        if (c && (c.ccImmune?.[kind] ?? 0) <= now) (c.ccImmune ??= {})[kind] = now + durationMs;
    }

    /** It ended at `at`: on a player the immunity runs from then (EffectListComponent.cs TryApplyImmunity). */
    private ccEnded(c: InternalContact, kind: CcKind, at: number): void {
        if (at < c.ccSince) return; // Its predecessor's.
        if (c.cc?.kind === kind) c.cc = null;
        if (c.kind === 'player') (c.ccImmune ??= {})[kind] = at + CC_IMMUNE_MS;
    }

    /** The server said so by name. A monster's isn't unique: only the one contact of that name under this kind. */
    private ccEndedNamed(regionId: number, e: CcEnd): void {
        const key = serverNameKey(e.name);
        const named = [...this.contacts.values()].filter(c => c.regionId === regionId && (c.kind === 'player' ? c.serverName && serverNameKey(c.serverName) === key : c.cc?.kind === e.kind && serverNameKey(c.name) === key));
        if (named.length === 1) this.ccEnded(named[0]!, e.kind, e.at);
    }

    private forget(key: string, c: InternalContact): void {
        this.contacts.delete(key);
        if (c.ccImmune || c.serverName || c.ccRuns) this.ccMemory.set(key, { ccImmune: c.ccImmune, serverName: c.serverName, ccRuns: c.ccRuns });
    }

    /** The current shared picture (copies; safe to keep). */
    picture(now = Date.now()): GroupPicture {
        const contacts: Contact[] = [];
        for (const [key, c] of this.contacts) {
            if (now - c.lastSeen > this.forgetAfterMs) { this.forget(key, c); continue; }
            if (c.cc && c.cc.until <= now) c.cc = null;
            for (const k of Object.keys(c.ccImmune ?? {}) as CcKind[]) if (c.ccImmune![k]! <= now) delete c.ccImmune![k];
            const { engaged: _e, hit: _h, ccSince: _s, ccAt: _a, ccRuns: _r, deathEchoUntil: _d, lastHostile, ...pub } = c;
            const stale = now - c.lastSeen > this.staleAfterMs;
            // A player contact at 0 % is alive (a dead one is no contact): it still fights.
            const threat = !stale && (c.kind === 'player' || c.hp > 0) && now - lastHostile < this.hostileMs;
            contacts.push({ ...pub, seenBy: [...c.seenBy], stale, threat, hostileSince: threat ? c.hostileSince : 0, cc: c.cc ? { ...c.cc } : null, ...(c.ccImmune ? { ccImmune: { ...c.ccImmune } } : {}) });
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
