// DaocClient: session + world model + mover behind the SDK contract.
//   connect()            log in and enter the world
//   collectState()       BotWorldState snapshot (sdk/types.ts)
//   onStateChange(fn)    published at most every 250 ms, and promptly on significant changes
//   execute(action)      every BotAction, sent as real packets; success = dispatched

import type { ActionResult, BotAction, BotWorldState, ClientPhase, PlayerState, Vec3 } from '../sdk/types';
import { getZone } from '../data/zones';
import { DaocSession, SessionError, type SessionEndReason } from './session';
import { ClientOp } from './protocol/opcodes';
import * as out from './protocol/outgoing';
import { headingTo, type MoverDeps } from './movement';
import { realmName } from './model/classes';
import { coinDrops, COPPER_PER } from './model/world-model';

export interface DaocClientOptions {
    host?: string;
    port?: number;
    username: string;
    password: string;
    /** Default: capitalised username. */
    charName?: string;
    realm?: string;
    className?: string;
    raceName?: string;
    gender?: number;
    createIfMissing?: boolean;
    log?: (msg: string) => void;
    trace?: boolean;
    /** Minimum ms between published snapshots (default 250). */
    publishIntervalMs?: number;
    /** Ground height for the mover (sdk/ground.ts moverGround); default none: z follows the waypoints. */
    ground?: MoverDeps['ground'];
}

type StateListener = (state: BotWorldState) => void;

const MELEE_RANGE = 128;
const INTERACT_RANGE = 192;
const PICKUP_RANGE = 256;
/**
 * Refresh our position before a prefixed packet (0xBB/0x7D/0x71) once the last 0xA9 is this old.
 * After 5 s without one the server soft-linkdeads us (PlayerMovementComponent.cs:15,52-61) and the
 * next packet's IsPositionUpdateFromPacketAllowed() returns false once (GamePlayer.cs:824-833), so
 * UseSkill/UseSpell/UseSlot would skip their 18-byte prefix and read index/slot from the x float
 * (UseSkillHandler.cs:17-28, UseSpellHandler.cs:26-38, UseSlotHandler.cs:16-29). A plain 0xA9 is
 * dropped safely in that state (PlayerPositionUpdateHandler.cs:21-22), and TCP keeps the order.
 */
const STALE_POSITION_MS = 4000;

/** A 0xDD to a player has toSlot = 1000 + objectId, which must fit its u16 and exceed 1000 (PlayerMoveItemRequestHandler.cs:16-21). */
const tradeOid = (oid: number): boolean => Number.isInteger(oid) && oid > 0 && oid <= 0xFFFF - 1000;

const ok = (message: string, data?: unknown): ActionResult => ({ success: true, message, phase: 'dispatch', ...(data !== undefined ? { data } : {}) });
const fail = (reason: string, message: string, phase: ActionResult['phase'] = 'validation'): ActionResult => ({ success: false, message, reason, phase });

/**
 * Default character name: the capitalised username. Names must match ^[A-Z][a-zA-Z]+$
 * (CharacterCreateRequestHandler.cs:42), so digits map to letters (0→a … 9→j) to keep
 * 'bot1' and 'bot2' distinct ('Botb', 'Botc'); other characters are dropped.
 */
export function defaultCharName(username: string): string {
    const mapped = username.replace(/[0-9]/g, d => String.fromCharCode(97 + Number(d))).replace(/[^a-zA-Z]/g, '');
    const base = mapped.length >= 3 ? mapped : `${mapped}bot`.slice(0, Math.max(3, mapped.length + 3));
    return base[0]!.toUpperCase() + base.slice(1).toLowerCase();
}

export class DaocClient {
    session: DaocSession | null = null;
    tick = 0;
    private listeners: StateListener[] = [];
    private endListeners: Array<(reason: SessionEndReason, message: string) => void> = [];
    private publishTimer: ReturnType<typeof setInterval> | null = null;
    private lastPublishAt = 0;
    /** The window and revision our last accept went out on. It stands on the server until a new revision or a close. */
    private acceptSent: { id: number; revision: number } | null = null;
    private lastPublishedRevision = -1;
    private pendingSignificant: ReturnType<typeof setTimeout> | null = null;
    private readonly log: (msg: string) => void;
    private lastPhase: ClientPhase = 'disconnected';
    private lastError: string | null = null;

    constructor(readonly opts: DaocClientOptions) {
        this.log = opts.log ?? (() => {});
    }

    get charName(): string {
        return this.opts.charName ?? defaultCharName(this.opts.username);
    }

    get inGame(): boolean {
        return this.session?.inGame ?? false;
    }

    get phase(): ClientPhase {
        return this.session?.phase ?? this.lastPhase;
    }

    /** Connect and enter the world. Rejects with SessionError (see `reason`, `mustBackOff`). */
    async connect(): Promise<void> {
        if (this.session && this.session.phase !== 'disconnected') throw new Error('already connected');
        const s = new DaocSession({
            host: this.opts.host ?? 'localhost',
            port: this.opts.port ?? 10300,
            username: this.opts.username,
            password: this.opts.password,
            charName: this.charName,
            realm: this.opts.realm ?? 'albion',
            className: this.opts.className,
            raceName: this.opts.raceName,
            gender: this.opts.gender,
            createIfMissing: this.opts.createIfMissing ?? true,
            log: this.log,
            trace: this.opts.trace,
            ground: this.opts.ground,
        });
        this.session = s;
        s.model.hooks.onSignificant = (reason: string) => this.significant(reason);
        s.onPhase(phase => {
            this.lastPhase = phase;
            this.significant(`phase:${phase}`);
        });
        s.onEnd((reason, message) => {
            this.lastError = s.lastError;
            this.stopPublishing();
            this.publish();
            for (const fn of this.endListeners) fn(reason, message);
        });
        s.mover.onStop(reason => this.significant(`stop:${reason}`));
        this.startPublishing();
        await s.connect();
    }

    onStateChange(fn: StateListener): () => void {
        this.listeners.push(fn);
        return () => {
            this.listeners = this.listeners.filter(f => f !== fn);
        };
    }

    /** Alias of onStateChange (rs-sdk naming). */
    onTick(fn: StateListener): () => void {
        return this.onStateChange(fn);
    }

    onDisconnect(fn: (reason: SessionEndReason, message: string) => void): void {
        this.endListeners.push(fn);
    }

    // ── publishing ────────────────────────────────────────────────────────

    private startPublishing(): void {
        if (this.publishTimer) return;
        const interval = this.opts.publishIntervalMs ?? 250;
        this.publishTimer = setInterval(() => {
            const s = this.session;
            if (!s) return;
            if (s.inGame) s.model.cull(s.mover.position);
            const rev = s.model.revision + s.mover.sentCount;
            if (rev !== this.lastPublishedRevision || Date.now() - this.lastPublishAt > 1000) this.publish();
        }, interval);
    }

    private stopPublishing(): void {
        if (this.publishTimer) clearInterval(this.publishTimer);
        this.publishTimer = null;
        if (this.pendingSignificant) clearTimeout(this.pendingSignificant);
        this.pendingSignificant = null;
    }

    private significant(_reason: string): void {
        if (this.listeners.length === 0 || this.pendingSignificant) return;
        const wait = Math.max(0, 50 - (Date.now() - this.lastPublishAt));
        this.pendingSignificant = setTimeout(() => {
            this.pendingSignificant = null;
            this.publish();
        }, wait);
    }

    private publish(): void {
        if (this.listeners.length === 0) return;
        const state = this.collectState();
        for (const fn of this.listeners) {
            try {
                fn(state);
            } catch (e) {
                this.log(`state listener threw: ${(e as Error).message}`);
            }
        }
    }

    // ── state ─────────────────────────────────────────────────────────────

    /** Build a snapshot. Each call is one publish and increments `tick`. */
    collectState(): BotWorldState {
        const s = this.session;
        this.tick++;
        this.lastPublishAt = Date.now();
        if (s) this.lastPublishedRevision = s.model.revision + s.mover.sentCount;
        const phase = this.phase;
        const connection = {
            phase,
            serverName: s?.serverName ?? '',
            clientVersion: '1.127',
            lastError: s?.lastError ?? this.lastError,
        };
        const emptyMovement = { moving: false, destination: null, waypoints: [], lastStopReason: null, correctionCount: 0, swimming: false };
        if (!s) {
            return {
                tick: this.tick, revision: 0, timestamp: Date.now(), inGame: false, connection, player: null,
                movement: emptyMovement, nearbyNpcs: [], nearbyPlayers: [], nearbyObjects: [], inventory: [], equipment: [],
                vault: [], skills: { specializations: [], abilities: [], styles: [], spells: [] }, effects: [], group: [],
                gameMessages: [], npcDialog: null, dialog: null, textWindow: null,
                merchant: { isOpen: false, merchantObjectId: null, windowType: 0, items: [] },
                trainer: { isOpen: false, specPoints: 0, specs: [] }, combatEvents: [],
            };
        }
        const m = s.model;
        const mv = s.mover;
        const pos = mv.position;
        const self = m.self;
        const hasWorld = self.objectId !== 0;
        const zone = mv.zoneId !== null ? getZone(mv.zoneId) : undefined;
        const player: PlayerState | null = hasWorld ? {
            name: self.name, lastName: self.lastName, guildName: self.guildName, accountName: self.accountName,
            objectId: self.objectId, sessionId: s.sessionId, level: self.level, realm: realmName(self.realm),
            className: self.className, raceName: self.raceName,
            regionId: mv.regionId, zoneId: mv.zoneId ?? -1, zoneName: zone?.name ?? '',
            x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), heading: mv.heading,
            speed: mv.moving ? Math.round(mv.speed) : 0, maxSpeed: Math.round(mv.maxSpeed), maxSwimSpeed: mv.maxSwimSpeed, maxSpeedPercent: mv.maxSpeedPercent,
            health: self.health, maxHealth: self.maxHealth, healthPercent: self.healthPercent,
            mana: self.mana, maxMana: self.maxMana, manaPercent: self.manaPercent,
            endurance: self.endurance, maxEndurance: self.maxEndurance, endurancePercent: self.endurancePercent,
            concentration: self.concentration, maxConcentration: self.maxConcentration,
            experience: self.experience, experienceForNextLevel: self.experienceForNextLevel, levelPermill: self.levelPermill,
            realmPoints: self.realmPoints, bountyPoints: self.bountyPoints, specPoints: self.specPoints,
            realmSpecPoints: self.realmSpecPoints, money: { ...self.money }, stats: self.stats ? { ...self.stats } : null,
            constitutionLost: self.constitutionLost, encumbrance: self.encumbrance ? { ...self.encumbrance } : null,
            isDead: self.isDead, isSitting: self.isSitting || mv.sitting, attacking: self.attacking, inCombat: m.inCombat(),
            targetObjectId: self.targetObjectId, deathCount: self.deathCount, lastDeathAt: self.lastDeathAt,
        } : null;
        return {
            tick: this.tick,
            revision: m.revision,
            timestamp: Date.now(),
            inGame: s.inGame,
            connection,
            player,
            movement: mv.state(),
            nearbyNpcs: m.nearbyNpcs(pos),
            nearbyPlayers: m.nearbyPlayers(pos),
            nearbyObjects: m.nearbyObjects(pos),
            inventory: m.inventoryList(40, 79),
            equipment: m.inventoryList(10, 37),
            vault: m.inventoryList(110, 149),
            skills: m.skills(),
            effects: m.effectList(),
            group: m.group.map(g => ({ ...g })),
            gameMessages: m.messages.slice(),
            npcDialog: m.npcDialog ? { ...m.npcDialog, keywords: [...m.npcDialog.keywords] } : null,
            dialog: m.dialog ? { ...m.dialog } : null,
            textWindow: m.textWindow ? { ...m.textWindow, lines: [...m.textWindow.lines] } : null,
            merchant: { ...m.merchant, items: m.merchant.items.slice() },
            trainer: { ...m.trainer, specs: m.trainer.specs.slice() },
            combatEvents: m.combatEvents.slice(),
            concentrationEffects: m.concentrationEffects.map(c => ({ ...c })),
            groundTarget: m.groundTarget,
            trade: m.trade,
        };
    }

    // ── actions ───────────────────────────────────────────────────────────

    private send(code: number, payload: Uint8Array): boolean {
        return this.session?.send(code, payload) ?? false;
    }

    private command(text: string): void {
        this.send(ClientOp.CommandHandler, out.encodeCommand(text));
    }

    private prefix(): out.PositionPrefix {
        const mv = this.session!.mover;
        return { x: mv.x, y: mv.y, z: mv.z, speed: 0, heading: mv.heading };
    }

    private targetServer(objectId: number): void {
        this.send(ClientOp.PlayerTarget, out.encodeTarget(objectId));
        this.session!.model.setSelfTarget(objectId);
    }

    /** Make sure the server has a recent 0xA9 before a position-prefixed packet (see STALE_POSITION_MS). */
    private ensureFreshPosition(): ActionResult | null {
        const mv = this.session!.mover;
        const gap = mv.msSinceLastSend();
        if (gap <= STALE_POSITION_MS) return null;
        this.log(`no 0xA9 for ${Math.round(gap)} ms; sending one before the action`);
        mv.sendUpdate();
        if (mv.msSinceLastSend() > STALE_POSITION_MS) {
            return fail('no_zone', 'cannot send a position update (zone unknown); the server would misread this packet');
        }
        return null;
    }

    private faceObject(objectId: number): boolean {
        const s = this.session!;
        const p = s.model.positionOf(objectId);
        if (!p || s.model.self.isDead) return false;
        if (s.mover.moving) {
            s.mover.heading = headingTo(s.mover, p);
        } else {
            s.mover.faceTowards(p);
        }
        return true;
    }

    private distanceTo(objectId: number): number | null {
        const s = this.session!;
        const p = s.model.positionOf(objectId);
        if (!p) return null;
        const me = s.mover.position;
        return Math.hypot(p.x - me.x, p.y - me.y, p.z - me.z);
    }

    /** Execute one action. Success means the packets were dispatched; observe state for the effect. */
    async execute(action: BotAction): Promise<ActionResult> {
        try {
            const r = await this.executeInner(action);
            if (r.success) this.significant(`action:${action.type}`);
            return r;
        } catch (e) {
            const err = e as Error;
            return fail(err instanceof SessionError ? err.reason : 'error', err.message, 'dispatch');
        }
    }

    /**
     * With our accept standing, the partner's accept commits while it holds the window's lock and then wants ours
     * and our inventory's, and an add or a removal holds those and wants the window: that can hang the server
     * (PlayerTradeWindow.cs:406, :513, :718-722; GamePlayer.cs:6261; GamePlayerInventory.cs:335). A plain move is safe (:489).
     */
    private changesWhatWeAccepted(a: BotAction): boolean {
        switch (a.type) {
            case 'tradeOfferItem': case 'tradeOfferMoney': case 'dropItem': case 'destroyItem': case 'sell': case 'useItem': return true;
            case 'moveItem': return a.toSlot === 1 || a.toSlot > 1000;
            default: return false;
        }
    }

    private async executeInner(a: BotAction): Promise<ActionResult> {
        if (a.type === 'none') return ok('noop');
        if (a.type === 'wait') {
            const ms = Math.max(0, Math.min(120_000, Number(a.ms) || 0));
            await Bun.sleep(ms);
            return { success: true, message: `waited ${ms} ms`, phase: 'completion' };
        }
        const s = this.session;
        if (!s || !s.inGame) return fail('not_in_game', `not in game (phase ${this.phase})`);
        const m = s.model;
        const mv = s.mover;
        const requireObject = (oid: number): ActionResult | null =>
            Number.isInteger(oid) && oid > 0 && m.hasObject(oid) ? null : fail('unknown_object', `unknown objectId ${oid}`);

        if (this.acceptSent && this.changesWhatWeAccepted(a) && this.acceptSent.id === m.trade?.id && this.acceptSent.revision === m.trade.revision) {
            return fail('trade_accepted', 'our accept stands on the open trade window: cancel it first');
        }
        switch (a.type) {
            case 'moveTo': {
                if (![a.x, a.y].every(Number.isFinite)) return fail('bad_args', 'x/y must be finite numbers');
                if (m.self.isDead) return fail('dead', 'cannot move while dead');
                let finalZ: number | undefined = a.z;
                if (finalZ === undefined) {
                    // No terrain data: adopt the z of a known object at the destination, if any.
                    let best = 96;
                    for (const n of [...m.npcs.values()].map(n => m.npcPosition(n)).concat([...m.objects.values()], [...m.players.values()])) {
                        const d = Math.hypot(n.x - a.x, n.y - a.y);
                        if (d < best) {
                            best = d;
                            finalZ = n.z;
                        }
                    }
                }
                m.self.isSitting = false;
                mv.moveTo({ x: a.x, y: a.y, z: finalZ }, { waypoints: a.waypoints, tolerance: a.tolerance, speedFactor: a.speedFactor });
                const d = Math.hypot(a.x - mv.x, a.y - mv.y);
                const speed = mv.speedLimit * Math.min(1, Math.max(0.05, a.speedFactor ?? 0.9));
                // maxSpeed 0 = rooted/stunned: the mover waits in place until 0xB6 restores it.
                const etaMs = speed > 0 ? Math.round((d / speed) * 1000) : null;
                const note = speed > 0 ? '' : ' (max speed is 0: rooted/stunned, waiting)';
                return ok(`moving to (${Math.round(a.x)}, ${Math.round(a.y)}), ${Math.round(d)} units${note}`, { distance: Math.round(d), etaMs });
            }
            case 'stop':
                mv.stop('stopped');
                return ok('stopped');
            case 'face': {
                if (m.self.isDead) return fail('dead', 'cannot turn while dead');
                if (!Number.isFinite(a.heading)) return fail('bad_args', 'heading must be a number');
                mv.face(((Math.round(a.heading) % 4096) + 4096) % 4096);
                return ok(`facing ${mv.heading}`);
            }
            case 'faceObject': {
                if (m.self.isDead) return fail('dead', 'cannot turn while dead');
                const bad = requireObject(a.objectId);
                if (bad) return bad;
                this.faceObject(a.objectId);
                return ok(`facing object ${a.objectId} (heading ${mv.heading})`);
            }
            case 'jump': {
                if (m.self.isDead) return fail('dead', 'cannot jump while dead');
                if (mv.zoneId === null) return fail('no_zone', 'current zone unknown');
                mv.sendUpdate();
                const p = encodeJump(mv);
                this.send(ClientOp.PositionUpdate, p);
                return ok('jumped');
            }
            case 'setTarget': {
                if (a.objectId === null || a.objectId === 0) {
                    this.targetServer(0);
                    return ok('target cleared');
                }
                if (a.objectId !== m.self.objectId) {
                    const bad = requireObject(a.objectId);
                    if (bad) return bad;
                }
                this.targetServer(a.objectId);
                return ok(`targeted ${a.objectId}`, { distance: roundOrNull(this.distanceTo(a.objectId)) });
            }
            case 'interact': {
                const bad = requireObject(a.objectId);
                if (bad) return bad;
                const d = this.distanceTo(a.objectId);
                this.targetServer(a.objectId);
                this.faceObject(a.objectId);
                this.send(ClientOp.ObjectInteractRequest, out.encodeInteract(mv.x, mv.y, s.sessionId, a.objectId));
                const warn = d !== null && d > INTERACT_RANGE ? ` (warning: ${Math.round(d)} > interact range ${INTERACT_RANGE})` : '';
                return ok(`interact sent to ${a.objectId}${warn}`, { distance: roundOrNull(d) });
            }
            case 'whisper': {
                const bad = requireObject(a.objectId);
                if (bad) return bad;
                if (!a.text) return fail('bad_args', 'text is empty');
                this.targetServer(a.objectId);
                this.command(`&whisper ${a.text}`);
                return ok(`whispered "${a.text}" to ${a.objectId}`, { distance: roundOrNull(this.distanceTo(a.objectId)) });
            }
            case 'pickup': {
                const bad = requireObject(a.objectId);
                if (bad) return bad;
                const o = m.objects.get(a.objectId);
                const d2 = o ? Math.hypot(o.x - mv.x, o.y - mv.y) : null;
                // PlayerPickUpRequestHandler ignores its payload ids and picks up the server-side TargetObject.
                this.targetServer(a.objectId);
                this.send(ClientOp.PickUpRequest, out.encodePickup(mv.x, mv.y, s.sessionId, a.objectId));
                const warn = d2 !== null && d2 > PICKUP_RANGE ? ` (warning: ${Math.round(d2)} > pickup range ${PICKUP_RANGE})` : '';
                return ok(`pickup sent for ${a.objectId}${warn}`, { distance: roundOrNull(d2) });
            }
            case 'attack': {
                if (a.on) {
                    const t = m.self.targetObjectId;
                    if (t === null) return fail('no_target', 'no target: use setTarget first');
                    if (m.self.isDead) return fail('dead', 'cannot attack while dead');
                    this.targetServer(t); // re-assert in-view flags
                    this.faceObject(t);
                    this.send(ClientOp.PlayerAttackRequest, out.encodeAttack(true));
                    const d = this.distanceTo(t);
                    const warn = d !== null && d > MELEE_RANGE ? ` (warning: ${Math.round(d)} > melee range ${MELEE_RANGE})` : '';
                    return ok(`attack on${warn}`, { distance: roundOrNull(d) });
                }
                this.send(ClientOp.PlayerAttackRequest, out.encodeAttack(false));
                return ok('attack off');
            }
            case 'useSkill': {
                const specCount = m.specCount();
                const n = m.usableSkills.length - specCount;
                if (!Number.isInteger(a.skillIndex) || a.skillIndex < 0 || a.skillIndex >= n) {
                    return fail('bad_args', `skillIndex ${a.skillIndex} out of range (0..${n - 1})`);
                }
                const t = m.self.targetObjectId;
                if (t !== null) this.faceObject(t);
                const stale = this.ensureFreshPosition();
                if (stale) return stale;
                this.send(ClientOp.UseSkill, out.encodeUseSkill(this.prefix(), a.skillIndex, 1));
                const sk = m.usableSkills[a.skillIndex + specCount];
                return ok(`used skill ${sk?.name ?? a.skillIndex}`);
            }
            case 'castSpell': {
                const line = m.spellLines.get(a.lineIndex);
                if (!line) return fail('bad_args', `unknown spell line ${a.lineIndex}`);
                const sp = line.spells[a.spellIndex];
                if (!sp) return fail('bad_args', `unknown spell ${a.spellIndex} in line ${line.lineName}`);
                const t = m.self.targetObjectId;
                if (mv.moving) mv.stop('stopped');
                if (t !== null) this.faceObject(t);
                const stale = this.ensureFreshPosition();
                if (stale) return stale;
                mv.holdPosition(600); // until 0x72 tells us the real cast time
                this.send(ClientOp.UseSpell, out.encodeUseSpell(this.prefix(), sp.level, a.lineIndex));
                return ok(`casting ${sp.name}`);
            }
            case 'setGroundTarget': {
                if (![a.x, a.y, a.z].every(Number.isFinite)) return fail('bad_args', 'x/y/z must be finite numbers');
                this.send(ClientOp.PlayerGroundTarget, out.encodeGroundTarget(a.x, a.y, a.z, true));
                m.groundTarget = { x: a.x, y: a.y, z: a.z };
                return ok('ground target set');
            }
            case 'useItem': {
                if (!Number.isInteger(a.slot) || a.slot < 0 || a.slot > 255) return fail('bad_args', `bad slot ${a.slot}`);
                if (a.slot >= 40 && !m.items.has(a.slot)) return fail('empty_slot', `no item in slot ${a.slot}`);
                const stale = this.ensureFreshPosition();
                if (stale) return stale;
                this.send(ClientOp.UseSlot, out.encodeUseSlot(this.prefix(), a.slot, a.useType ?? 0));
                return ok(`used slot ${a.slot}`);
            }
            case 'moveItem': {
                if (!m.items.has(a.fromSlot)) return fail('empty_slot', `no item in slot ${a.fromSlot}`);
                this.send(ClientOp.PlayerMoveItem, out.encodeMoveItem(a.toSlot, a.fromSlot, a.count ?? 0));
                return ok(`moving slot ${a.fromSlot} → ${a.toSlot}`);
            }
            case 'dropItem': {
                if (!m.items.has(a.slot)) return fail('empty_slot', `no item in slot ${a.slot}`);
                this.send(ClientOp.PlayerMoveItem, out.encodeMoveItem(1 /* eInventorySlot.Ground */, a.slot, m.items.get(a.slot)!.count));
                return ok(`dropping slot ${a.slot}`);
            }
            case 'destroyItem': {
                if (!m.items.has(a.slot)) return fail('empty_slot', `no item in slot ${a.slot}`);
                this.send(ClientOp.DestroyItemRequest, out.encodeDestroyItem(a.slot));
                return ok(`destroying slot ${a.slot}`);
            }
            case 'delve': {
                // An empty slot gets no reply at all (DetailDisplayHandler.cs:72-77): don't ask.
                if (!m.items.has(a.slot)) return fail('empty_slot', `no item in slot ${a.slot}`);
                this.send(ClientOp.DetailRequest, out.encodeDetailRequest(1, 0, a.slot));
                return ok(`delving slot ${a.slot}`);
            }
            case 'delveMerchantItem': {
                // The server looks the item up on our target, and answers nothing for an unknown one (DetailDisplayHandler.cs:311-318).
                if (!m.merchant.isOpen) return fail('merchant_not_open', 'no merchant window open: interact with the merchant first');
                if (!m.merchant.items.some(i => i.page === a.page && i.slot === a.slot)) return fail('bad_args', `no merchant item at page ${a.page} slot ${a.slot}`);
                this.send(ClientOp.DetailRequest, out.encodeDetailRequest(4, 0, a.page * 30 + a.slot));
                return ok(`delving merchant item ${a.page}:${a.slot}`);
            }
            case 'buy': {
                if (!m.merchant.isOpen) return fail('merchant_not_open', 'no merchant window open: interact with a merchant first');
                const item = m.merchant.items.find(i => i.page === a.page && i.slot === a.slot);
                if (!item) return fail('bad_args', `no merchant item at page ${a.page} slot ${a.slot}`);
                const count = Math.max(1, Math.min(255, Math.floor(a.count || 1)));
                if (m.merchant.merchantObjectId !== null && m.self.targetObjectId !== m.merchant.merchantObjectId) this.targetServer(m.merchant.merchantObjectId);
                this.send(ClientOp.BuyRequest, out.encodeBuy(mv.x, mv.y, a.page * 30 + a.slot, count, m.merchant.windowType));
                return ok(`buying ${count} × ${item.name} (${item.price}c each)`);
            }
            case 'sell': {
                if (!m.items.has(a.slot)) return fail('empty_slot', `no item in slot ${a.slot}`);
                const mid = m.merchant.merchantObjectId ?? m.self.targetObjectId;
                if (mid === null) return fail('no_target', 'target a merchant first');
                if (m.self.targetObjectId !== mid) this.targetServer(mid);
                this.send(ClientOp.SellRequest, out.encodeSell(mv.x, mv.y, a.slot));
                return ok(`selling slot ${a.slot}`);
            }
            case 'openTrainer':
                this.send(ClientOp.TrainWindowHandler, out.encodeTrainWindowRequest());
                return ok('trainer window requested');
            case 'trainSpec': {
                const spec = m.trainer.specs.find(sp => sp.index === a.specIndex);
                if (!spec) return fail('trainer_not_open', `unknown spec index ${a.specIndex}: use openTrainer first`);
                const target = spec.level + Math.max(1, Math.floor(a.levels ?? 1));
                this.send(ClientOp.TrainHandler, out.encodeTrain([{ specIndex: a.specIndex, level: target }]));
                return ok(`training ${spec.name} to ${target}`);
            }
            case 'respondDialog': {
                const d = m.dialog;
                if (!d || !d.isOpen) return fail('no_dialog', 'no dialog open');
                this.send(ClientOp.DialogResponse, out.encodeDialogResponse(d.data[0], d.data[1], d.data[2], d.code, a.accept));
                m.dialog = { ...d, isOpen: false };
                return ok(`dialog ${a.accept ? 'accepted' : 'declined'}`);
            }
            case 'closeMerchant':
                m.merchant = { ...m.merchant, isOpen: false };
                return ok('merchant closed');
            case 'say':
                if (!a.text) return fail('bad_args', 'text is empty');
                this.command(`&say ${a.text}`);
                return ok(`said "${a.text}"`);
            case 'send':
                if (!a.to || !a.text) return fail('bad_args', 'to and text are required');
                this.command(`&send ${a.to} ${a.text}`);
                return ok(`sent to ${a.to}`);
            case 'groupSay':
                if (!a.text) return fail('bad_args', 'text is empty');
                this.command(`&group ${a.text}`);
                return ok('group message sent');
            case 'command': {
                let c = (a.command ?? '').trim();
                if (!c) return fail('bad_args', 'command is empty');
                if (c.startsWith('/')) c = '&' + c.slice(1);
                if (!c.startsWith('&')) c = '&' + c;
                // A scripted '&quit' is a requested quit: its 0xA4 must end the session as 'quit', not 'kicked'.
                if (/^&quit\b/i.test(c)) s.noteQuitRequested();
                this.command(c);
                return ok(`command ${c}`);
            }
            case 'sit': {
                if (a.sit && mv.moving) mv.stop('stopped');
                this.send(ClientOp.PlayerSitRequest, out.encodeSit(a.sit));
                // Sitting is applied when the server confirms it: a successful GamePlayer.Sit always ends in
                // UpdatePlayerStatus → 0xAD (GamePlayer.cs:8720-8721), while a refusal (dead, stunned, mezzed,
                // moving, mounted: 8656-8697) only sends a message. Standing up early is harmless.
                if (!a.sit) {
                    mv.sitting = false;
                    m.self.isSitting = false;
                }
                return ok(a.sit ? 'sit requested' : 'standing');
            }
            case 'removeConcentration': {
                const i = a.index;
                if (!Number.isInteger(i) || i < 0 || i > 255) return fail('bad_args', 'index must be 0..255');
                if (!(m.concentrationEffects ?? []).some(e => e.index === i)) return fail('not_found', `no concentration effect at index ${i}`);
                this.send(ClientOp.RemoveConcentrationEffect, out.encodeRemoveConcentrationEffect(i));
                return ok(`concentration effect ${i} removal requested`);
            }
            case 'regionChangeRequest': {
                const id = a.zonePointId;
                if (!Number.isInteger(id) || id < 0 || id > 0xffff) return fail('bad_args', 'zonePointId must be 0..65535');
                // A refused request (wrong id or realm: RegionChangeRequestHandler.cs:41-45) is silent for a
                // PrivLevel-1 account. A jump comes back as a region change like a teleporter's (session.ts).
                this.send(ClientOp.PlayerRegionChangeRequest, out.encodeRegionChangeRequest(id));
                return ok(`zone point ${id} requested`);
            }
            case 'tradeOfferItem': {
                if (!tradeOid(a.partnerObjectId)) return fail('bad_args', `bad partner objectId ${a.partnerObjectId}`);
                if (!Number.isInteger(a.slot) || a.slot < 40 || a.slot > 79) return fail('bad_args', `slot ${a.slot} is not in the backpack`);
                if (!m.items.has(a.slot)) return fail('empty_slot', `no item in slot ${a.slot}`);
                this.send(ClientOp.PlayerMoveItem, out.encodeMoveItem(1000 + a.partnerObjectId, a.slot, 0));
                return ok(`offering slot ${a.slot} to object ${a.partnerObjectId}`);
            }
            case 'tradeOfferMoney': {
                // Each coin's amount goes out as a u16 (PlayerMoveItemRequestHandler.cs:18). The drops add up (PlayerTradeWindow.cs:350).
                if (!tradeOid(a.partnerObjectId)) return fail('bad_args', `bad partner objectId ${a.partnerObjectId}`);
                if (!Number.isSafeInteger(a.copper) || a.copper <= 0 || a.copper >= 0x10000 * COPPER_PER.mithril) return fail('bad_args', `bad copper amount ${a.copper}`);
                for (const [slot, amount] of coinDrops(a.copper)) this.send(ClientOp.PlayerMoveItem, out.encodeMoveItem(1000 + a.partnerObjectId, slot, amount));
                return ok(`offering ${a.copper} copper to object ${a.partnerObjectId}`);
            }
            case 'tradeAccept': {
                const t = m.trade;
                if (!t || t.partnerName === null) return fail('no_trade', 'no trade window open');
                if (a.revision !== undefined && a.revision !== t.revision) return fail('trade_changed', `the offer changed: revision ${t.revision}, not ${a.revision}`);
                // Revisions start over per window, so a reopened window can show the same one. The packet names neither (PlayerModifyTradeHandler.cs:54-56): this hop is the last check.
                if (a.windowId !== undefined && a.windowId !== t.id) return fail('trade_changed', `another window: ${t.id}, not ${a.windowId}`);
                this.send(ClientOp.ModifyTrade, out.encodeModifyTrade(2));
                this.acceptSent = { id: t.id, revision: t.revision };
                return ok('trade accept sent');
            }
            case 'tradeCancel':
                // No guard: this also cures a window the server holds but we were never told about, and it is a no-op
                // there otherwise (PlayerModifyTradeHandler.cs:16-18). m.trade waits for the server's own 0xEA.
                this.send(ClientOp.ModifyTrade, out.encodeModifyTrade(0));
                this.acceptSent = null;
                return ok('trade close sent');
            case 'release':
                if (!m.self.isDead) return fail('not_dead', 'release only works while dead');
                this.command('&release');
                return ok('release requested');
            case 'quit':
                void s.quit();
                return ok('quit requested (the server quit timer is >= 20 s)');
            default: {
                const t = (a as { type: string }).type;
                return fail('unknown_action', `unknown action type '${t}'`);
            }
        }
    }

    /** Clean quit ('&quit' → 0xA4). */
    async quit(): Promise<void> {
        await this.session?.quit();
    }

    /** Drop the connection immediately (60 s link-death lockout if in game). */
    disconnect(): void {
        this.session?.close('clientClosed');
    }

    /** Position as seen by the mover. */
    get position(): Vec3 | null {
        return this.session ? this.session.mover.position : null;
    }
}

function roundOrNull(v: number | null): number | null {
    return v === null ? null : Math.round(v);
}

function encodeJump(mv: { x: number; y: number; z: number; heading: number; zoneId: number | null; sessionId: number; objectId: number; healthPercent: number }): Uint8Array {
    return out.encodePositionUpdate({
        x: mv.x, y: mv.y, z: mv.z, speed: 0, zSpeed: 0, sessionId: mv.sessionId, objectId: mv.objectId,
        zoneId: mv.zoneId ?? 0, stateFlags: out.StateFlags.Jumping, heading: mv.heading,
        actionFlags: out.ActionFlags.TargetInView, healthPercent: mv.healthPercent,
    });
}
