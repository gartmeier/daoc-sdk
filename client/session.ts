// DaocSession: TCP connection + login state machine + in-world housekeeping.
//
// Sequence (docs/research/critic.md §7, verified against the C# handlers):
//   F4 → 0x22 | A7 → 0x2A / 0x2C | FC(realm) → 0xFC overview
//   [FF create → 0x2A → FC → verify slot filled]
//   10 → 0x2A + 0x28 (session id, optional)
//   D4(charIndex) → 0x20 | BF(0) → 0x2D, then immediately the first 0xA9 | E8 → 0x2B ⇒ playing
// In world: 0xA9 stream (Mover), 0xA3 ping every 30 s, answer every 0xD0 with "clear",
// 0xD5 for unknown sessions, 0xBE for unknown objects, snap on 0x04/0x20, region change on 0xB7 (D4 → 0x20 → BF → E8),
// clean quit via '&quit' → 0xA4.

import type { ClientPhase } from '../sdk/types';
import { Connection } from './net/connection';
import type { ServerPacket } from './net/framing';
import { ClientOp, loginErrorName, ServerOp, serverOpName } from './protocol/opcodes';
import * as out from './protocol/outgoing';
import { decodeCharacterOverview, decodeCryptKey, decodeDupNameCheckReply, decodeLoginDenied, decodeLoginGranted, decodeSessionId, type CharacterOverview, type OverviewCharacter } from './protocol/incoming/login';
import { hasNoLook, lookFor } from './model/look';
import { decodeCharacterJump, decodeLosRequest, decodeMaxSpeed, decodePositionAndObjectId, decodeQuit, decodeRegionChanged, decodeRiding } from './protocol/incoming/world';
import { decodeInterrupt, decodeSpellCastAnimation } from './protocol/incoming/combat';
import { decodeObjectUpdate, decodeRemoveObject, type ObjectUpdate } from './protocol/incoming/objects';
import { decodeStatusUpdate } from './protocol/incoming/player';
import { getZone } from '../data/zones';
import { VISIBILITY_DISTANCE, WorldModel } from './model/world-model';
import { Mover, type MoverDeps } from './movement';
import { className as classNameById, planCharacter, raceNameById, realmNumber } from './model/classes';

export type SessionEndReason =
    | 'quit'
    /** The server sent 0xA4 without our '&quit' (KickPlayerToCharScreen, GameServiceUtils.cs:71-85). */
    | 'kicked'
    | 'connectFailed'
    | 'loginDenied'
    | 'accountInLogout'
    | 'timeout'
    | 'characterNotFound'
    | 'creationFailed'
    | 'realmLocked'
    | 'serverClosed'
    | 'decodeErrors'
    | 'clientClosed'
    | 'error';

export class SessionError extends Error {
    constructor(readonly reason: SessionEndReason, message: string, readonly code?: number) {
        super(message);
        this.name = 'SessionError';
    }

    /** Caller must wait at least 60 s before retrying (0x2C code 0x11, LoginRequestHandler.cs:231-240). */
    get mustBackOff(): boolean {
        return this.reason === 'accountInLogout';
    }
}

export interface SessionOptions {
    host: string;
    port: number;
    username: string;
    password: string;
    charName: string;
    realm: string | number;
    className?: string;
    raceName?: string;
    gender?: number;
    createIfMissing?: boolean;
    log?: (msg: string) => void;
    /** Log every packet in and out. */
    trace?: boolean;
    /** Ground height for the mover (MoverDeps.ground). */
    ground?: MoverDeps['ground'];
}

interface Waiter {
    codes: Set<number>;
    predicate?: (p: ServerPacket) => boolean;
    resolve(p: ServerPacket): void;
    reject(e: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

const PING_INTERVAL_MS = 30_000;
const DECODE_ERROR_BURST = 50;
const OBJECT_REQUEST_THROTTLE_MS = 2000;
/** More than ever fit in view: the 0xBE throttle only needs ids asked for in the last 2 s. */
const MAX_OBJECT_REQUESTS = 512;

export class DaocSession {
    phase: ClientPhase = 'disconnected';
    serverName = '';
    accountName = '';
    lastError: string | null = null;
    endReason: SessionEndReason | null = null;

    readonly model: WorldModel;
    readonly mover: Mover;
    connection: Connection | null = null;

    sessionId = 0;
    objectId = 0;
    regionId = 0;
    /** Realm the account is locked to (from the overview), 1..3. */
    accountRealm = 0;
    charSlot = -1;
    character: OverviewCharacter | null = null;
    createdCharacter = false;

    private waiters: Waiter[] = [];
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private requestedSessions = new Map<number, number>();
    /** Object id → when we last sent 0xBE for it. */
    private requestedObjects = new Map<number, number>();
    private endListeners: Array<(reason: SessionEndReason, message: string) => void> = [];
    private packetListeners: Array<(p: ServerPacket) => void> = [];
    private phaseListeners: Array<(phase: ClientPhase) => void> = [];
    private regionChanging = false;
    /** Steed we ride, from 0xC8 Riding (MountSteed/DismountSteed send it to us too, GamePlayer.cs:7664, :7708). */
    steedId: number | null = null;
    private ended = false;
    losReplies = 0;
    private readonly log: (msg: string) => void;

    constructor(readonly opts: SessionOptions) {
        this.log = opts.log ?? (() => {});
        this.model = new WorldModel({
            onUnknownSession: sid => this.requestPlayer(sid),
            onSelfDeath: () => {
                this.mover.stop('died');
                this.mover.sendUpdate();
            },
            selfPosition: () => this.mover.position,
        });
        // self.isDead, not a health of 0 %: that is also a living character with a few hit points
        // (GameLiving.cs:2621), and the server wouldn't strip DEAD from it.
        this.mover = new Mover({ send: (c, p) => this.send(c, p), log: opts.trace ? this.log : undefined, ground: opts.ground, isDead: () => this.model.self.isDead, hasGroundTarget: () => this.model.groundTarget !== null });
    }

    // ── events ────────────────────────────────────────────────────────────

    onEnd(fn: (reason: SessionEndReason, message: string) => void): void {
        this.endListeners.push(fn);
    }

    onPacket(fn: (p: ServerPacket) => void): void {
        this.packetListeners.push(fn);
    }

    onPhase(fn: (phase: ClientPhase) => void): void {
        this.phaseListeners.push(fn);
    }

    private setPhase(phase: ClientPhase): void {
        if (this.phase === phase) return;
        this.phase = phase;
        this.log(`phase → ${phase}`);
        for (const fn of this.phaseListeners) fn(phase);
    }

    get inGame(): boolean {
        return this.phase === 'playing';
    }

    // ── connection ────────────────────────────────────────────────────────

    send(code: number, payload: Uint8Array): boolean {
        if (!this.connection) return false;
        return this.connection.send(code, payload);
    }

    /** Connect, log in, create the character if needed and enter the world. Resolves when playing. */
    async connect(): Promise<void> {
        const o = this.opts;
        if (this.connection) throw new Error('DaocSession is single-use; create a new one to reconnect');
        this.endReason = null;
        this.lastError = null;
        this.setPhase('connecting');
        const conn = new Connection({
            onPacket: p => this.handlePacket(p),
            onClose: reason => this.handleClose(reason),
        });
        if (o.trace) conn.onSend = (code, payload) => this.log(`→ 0x${code.toString(16)} (${payload.length})`);
        this.connection = conn;
        try {
            await conn.connect(o.host, o.port);
        } catch (e) {
            throw this.fail('connectFailed', `connect ${o.host}:${o.port} failed: ${(e as Error).message}`);
        }
        try {
            await this.login();
            await this.selectCharacter();
            await this.enterWorld(true);
        } catch (e) {
            const err = e instanceof SessionError ? e : new SessionError('error', (e as Error).message);
            if (!this.endReason) this.end(err.reason, err.message);
            throw err;
        }
    }

    private async login(): Promise<void> {
        const o = this.opts;
        this.setPhase('login');
        this.send(ClientOp.CryptKeyRequest, out.encodeCryptKeyRequest());
        const ck = decodeCryptKey((await this.waitFor([ServerOp.CryptKey], 10_000, 'CryptKey')).payload);
        this.log(`server version ${ck.version}`);
        this.send(ClientOp.LoginRequest, out.encodeLoginRequest(o.username, o.password));
        const reply = await this.waitFor([ServerOp.LoginGranted, ServerOp.LoginDenied], 20_000, 'LoginGranted');
        if (reply.code === ServerOp.LoginDenied) {
            const code = decodeLoginDenied(reply.payload).code;
            const name = loginErrorName(code);
            throw this.fail(code === 0x11 ? 'accountInLogout' : 'loginDenied', `login denied: ${name}`, code);
        }
        const g = decodeLoginGranted(reply.payload);
        this.serverName = g.serverName;
        this.accountName = g.accountName;
        this.model.self.accountName = g.accountName;
        this.log(`logged in as ${g.accountName} on ${g.serverName}`);
    }

    private async requestOverview(realm: number): Promise<CharacterOverview> {
        this.send(ClientOp.CharacterOverviewRequest, out.encodeCharacterOverviewRequest(realm));
        const p = await this.waitFor([ServerOp.CharacterOverview1126], 20_000, 'CharacterOverview');
        return decodeCharacterOverview(p.payload);
    }

    private async selectCharacter(): Promise<void> {
        const o = this.opts;
        this.setPhase('charScreen');
        const realm = realmNumber(o.realm);
        let overview = await this.requestOverview(realm);
        const findChar = (ov: CharacterOverview): OverviewCharacter | undefined =>
            ov.slots.find((c): c is OverviewCharacter => c !== null && c.name.toLowerCase() === o.charName.toLowerCase());
        const realmOf = (ov: CharacterOverview): number => ov.slots.find(c => c !== null)?.realm ?? realm;
        let ch = findChar(overview);
        this.accountRealm = realmOf(overview);

        if (!ch) {
            if (this.accountRealm !== realm) {
                throw this.fail('realmLocked', `account ${o.username} is locked to realm ${this.accountRealm}; cannot use realm ${realm}`);
            }
            if (o.createIfMissing === false) throw this.fail('characterNotFound', `character ${o.charName} not found on account ${o.username}`);
            await this.createCharacter(overview, realm);
            overview = await this.requestOverview(realm);
            ch = findChar(overview);
            if (!ch) throw this.fail('creationFailed', `character ${o.charName} was not created (server rejected it; check name, class/race and the server log)`);
            this.createdCharacter = true;
            this.accountRealm = realmOf(overview);
        } else if (hasNoLook(ch)) {
            ch = await this.giveLook(ch, realm, findChar) ?? ch;
        }
        this.character = ch;
        this.charSlot = ch.slot;
        this.model.self.name = ch.name;
        this.model.self.level = ch.level;
        this.model.self.realm = ch.realm;
        this.model.self.className = ch.className || classNameById(ch.realm, ch.classId);
        this.model.self.raceName = ch.raceName || raceNameById(ch.raceId);
        this.log(`character ${ch.name} L${ch.level} ${this.model.self.raceName} ${this.model.self.className} in slot ${ch.slot}`);

        // 0x10 CharacterSelect: optional, but it gives us our session id via 0x28.
        this.send(ClientOp.CharacterSelectRequest, out.encodeCharacterSelectRequest());
        try {
            const sid = await this.waitFor([ServerOp.SessionID], 5000, 'SessionID');
            this.sessionId = decodeSessionId(sid.payload).sessionId;
            this.mover.sessionId = this.sessionId;
            this.model.self.sessionId = this.sessionId;
        } catch {
            this.log('no 0x28 SessionID reply; continuing without session id');
        }
    }

    /**
     * A character made before looks existed gets one on its next login (0xFF customize, face only).
     * The server doesn't answer a customize, so the new overview shows whether it took.
     */
    private async giveLook(ch: OverviewCharacter, realm: number, findChar: (ov: CharacterOverview) => OverviewCharacter | undefined): Promise<OverviewCharacter | undefined> {
        const look = lookFor(ch.name, ch.raceId, ch.gender);
        if (!look) return undefined;
        const stats = ch.stats as out.CharacterCreateData['stats'];
        this.send(ClientOp.CharacterCreateRequest, out.encodeCharacterCreateRequest({
            slot: ch.slot, name: ch.name, realm: ch.realm, classId: ch.classId, raceId: ch.raceId, gender: ch.gender, model: ch.model, stats, operation: 2, look,
        }));
        const after = findChar(await this.requestOverview(realm));
        this.log(after && !hasNoLook(after) ? `gave ${ch.name} a look (model ${look.model & 0x7FF})` : `WARNING: ${ch.name} kept the blank look`);
        return after;
    }

    private async createCharacter(overview: CharacterOverview, realm: number): Promise<void> {
        const o = this.opts;
        this.setPhase('creatingCharacter');
        let plan: ReturnType<typeof planCharacter>;
        try {
            plan = planCharacter(realm, o.className ?? defaultClass(realm), o.raceName ?? defaultRace(realm), o.gender);
        } catch (e) {
            throw this.fail('creationFailed', (e as Error).message);
        }
        for (const w of plan.warnings) this.log(`WARNING: ${w}`);
        let slot = overview.slots.findIndex(s => s === null);
        if (overview.slots.length === 0) slot = 0;
        if (slot < 0) throw this.fail('creationFailed', 'no free character slot');
        if (!/^[A-Z][a-zA-Z]{2,}$/.test(o.charName)) {
            // The server disconnects (and may ban) on a bad name (CharacterCreateRequestHandler.cs:42-55).
            throw this.fail('creationFailed', `invalid character name '${o.charName}' (must match ^[A-Z][a-zA-Z]+$, >= 3 chars)`);
        }
        this.send(ClientOp.DuplicateNameCheck, out.encodeDupNameCheck(o.charName));
        try {
            const r = decodeDupNameCheckReply((await this.waitFor([ServerOp.DupNameCheckReply], 5000, 'DupNameCheckReply')).payload);
            if (r.result !== 0) throw this.fail('creationFailed', `character name ${o.charName} is ${r.result === 2 ? 'taken' : 'invalid'}`);
        } catch (e) {
            if (e instanceof SessionError) throw e;
            this.log('no dup-name reply; trying to create anyway');
        }
        this.log(`creating ${o.charName}: class ${plan.classId} race ${plan.raceId} slot ${slot} stats ${plan.stats.join('/')}`);
        this.send(ClientOp.CharacterCreateRequest, out.encodeCharacterCreateRequest({
            slot, name: o.charName, realm, classId: plan.classId, raceId: plan.raceId, gender: plan.gender, model: plan.model, stats: plan.stats,
            look: lookFor(o.charName, plan.raceId, plan.gender) ?? undefined,
        }));
        await this.waitFor([ServerOp.LoginGranted], 15_000, 'LoginGranted after create');
        this.setPhase('charScreen');
    }

    /** D4 → 0x20 → BF → 0x2D (+ first 0xA9) → E8 → 0x2B. */
    private async enterWorld(first: boolean): Promise<void> {
        this.setPhase(first ? 'enteringWorld' : 'regionChange');
        const charIndex = (this.accountRealm - 1) * 10 + this.charSlot;
        this.send(ClientOp.WorldInitRequest, out.encodeWorldInitRequest(charIndex));
        const pos = decodePositionAndObjectId((await this.waitFor([ServerOp.PositionAndObjectID], 30_000, 'PositionAndObjectID (character not loaded?)')).payload);
        this.objectId = pos.objectId;
        this.steedId = null; // object ids are per region, a steed id from before is stale
        this.regionId = pos.regionId;
        this.model.self.objectId = pos.objectId;
        this.mover.objectId = pos.objectId;
        this.mover.snap(pos.regionId, pos.x, pos.y, pos.z, pos.heading, first ? null : 'regionChange');
        this.log(`position region ${pos.regionId} (${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}) oid ${pos.objectId} zone ${this.mover.zoneId}`);
        if (this.mover.zoneId === null) this.log(`WARNING: no zone found for region ${pos.regionId}; 0xA9 will not be sent`);

        this.send(ClientOp.GameOpenRequest, out.encodeGameOpenRequest(0));
        await this.waitFor([ServerOp.GameOpenReply], 15_000, 'GameOpenReply');
        // The 5 s link-death clock starts at the Playing transition: first 0xA9 right now.
        if (first) this.mover.start();
        else this.mover.resume();

        this.send(ClientOp.PlayerInitRequest, out.encodePlayerInitRequest());
        await this.waitFor([ServerOp.CharacterInitFinished], 20_000, 'CharacterInitFinished');
        if (first) this.startPing();
        this.regionChanging = false;
        this.setPhase('playing');
    }

    private startPing(): void {
        if (this.pingTimer) return;
        const ping = () => this.send(ClientOp.PingRequest, out.encodePing(Math.floor(Date.now() / 1000)));
        ping();
        this.pingTimer = setInterval(ping, PING_INTERVAL_MS);
    }

    private requestPlayer(sessionId: number): void {
        if (!this.inGame) return;
        const now = Date.now();
        const last = this.requestedSessions.get(sessionId) ?? 0;
        if (now - last < 10_000) return;
        this.requestedSessions.set(sessionId, now);
        this.send(ClientOp.CreatePlayerRequest, out.encodeCreatePlayerRequest(sessionId));
    }

    /**
     * An 0xA1 for an object we have no entry for. The server won't send its 0xDA by itself: a plain 0xA1 put the NPC in
     * its cache for us (ClientService.cs:598, :659, :665-668) or a same-region jump left it there after its 0xA2 type 1
     * (GameNPC.cs:2044), and UpdateNpcs only creates on a cache miss (ClientService.cs:816-821). So ask, as a real client
     * does (CreateObjectRequestHandler.cs). Not beyond the model's cull: it would drop the 0xDA at once, and we would ask
     * again every 2 s. Not in a zone we can't place either: the model couldn't keep that entry fresh. Nor for one just dead:
     * an 0xA1 built before its 0xA2 lands after it (PacketProcessor.cs:273-274), and the server has nothing to answer with.
     */
    private requestUnknownObject(d: ObjectUpdate): void {
        if (!this.inGame || !d.objectId || d.objectId === this.objectId || this.model.hasObject(d.objectId) || this.model.diedRecently(d.objectId)) return;
        const zone = getZone(d.zoneSkinId);
        if (!zone) return;
        const pos = this.mover.position;
        if (Math.hypot(zone.xOffset + d.xOffset - pos.x, zone.yOffset + d.yOffset - pos.y) > VISIBILITY_DISTANCE) return;
        const now = Date.now();
        const last = this.requestedObjects.get(d.objectId);
        if (last !== undefined && now - last < OBJECT_REQUEST_THROTTLE_MS) return;
        if (this.requestedObjects.size >= MAX_OBJECT_REQUESTS) {
            for (const [id, at] of this.requestedObjects) if (now - at >= OBJECT_REQUEST_THROTTLE_MS) this.requestedObjects.delete(id);
            if (this.requestedObjects.size >= MAX_OBJECT_REQUESTS) this.requestedObjects.clear();
        }
        this.requestedObjects.set(d.objectId, now);
        this.send(ClientOp.CreateObjectRequest, out.encodeCreateObjectRequest(d.objectId));
    }

    // ── packet handling ───────────────────────────────────────────────────

    private handlePacket(p: ServerPacket): void {
        if (this.opts.trace) this.log(`← ${serverOpName(p.code)} (${p.payload.length})`);
        try {
            this.handleSessionPacket(p);
        } catch (e) {
            this.model.decodeErrors++;
            this.model.lastDecodeError = `session 0x${p.code.toString(16)}: ${(e as Error).message}`;
        }
        this.model.handle(p.code, p.payload);
        for (const fn of this.packetListeners) fn(p);
        for (const w of [...this.waiters]) {
            if (!w.codes.has(p.code)) continue;
            if (w.predicate && !w.predicate(p)) continue;
            clearTimeout(w.timer);
            this.waiters = this.waiters.filter(x => x !== w);
            w.resolve(p);
        }
        if (this.model.recentDecodeErrors() > DECODE_ERROR_BURST) {
            this.end('decodeErrors', `too many decode errors (last: ${this.model.lastDecodeError})`);
        }
    }

    private handleSessionPacket(p: ServerPacket): void {
        switch (p.code) {
            case ServerOp.CheckLOSRequest: {
                // Always answer "clear"; NPC aggro and our own casts wait on this (LosCheckHandler.cs, 1500 ms timeout).
                const d = decodeLosRequest(p.payload);
                this.send(ClientOp.CheckLosRequest, out.encodeLosResponse(d.sourceId, d.targetId, true));
                this.losReplies++;
                break;
            }
            case ServerOp.CharacterJump: {
                const d = decodeCharacterJump(p.payload);
                if (d.headingOnly) {
                    this.mover.heading = d.heading;
                } else if (this.steedId !== null) {
                    // Rider resync: a rider > 1000 units from its steed is put back on it with a bare
                    // SendPlayerJump, IsSitting untouched (PlayerPositionUpdateHandler.cs:36-49). MoveTo
                    // would have dismounted us first (GamePlayer.cs:7891-7892), clearing steedId.
                    const sitting = this.mover.sitting;
                    this.log(`server put us back on our steed at (${d.x}, ${d.y}, ${d.z})`);
                    this.mover.snap(this.regionId, d.x, d.y, d.z, d.heading, 'teleported');
                    this.mover.sitting = sitting;
                    this.mover.sendUpdate();
                } else if (this.mover.isHeightNudge(d.x, d.y, d.z)) {
                    // IsDiving Z+1 nudge (GamePlayer.cs:8378-8384): same spot, one unit up, IsSitting
                    // untouched. Adopt the height only. No immediate 0xA9: underwater in a zone without
                    // diving, every 0xA9 triggers another nudge, so keep the normal cadence.
                    this.mover.z = d.z;
                } else {
                    this.log(`server moved us to (${d.x}, ${d.y}, ${d.z})`);
                    this.mover.snap(this.regionId, d.x, d.y, d.z, d.heading, 'teleported');
                    this.model.self.isSitting = false; // MoveTo stands us up without a 0xAD (GamePlayer.cs:7900)
                    this.mover.sendUpdate();
                }
                break;
            }
            case ServerOp.PositionAndObjectID: {
                // During world entry the waiter handles it; later it is a forced position update.
                if (this.phase === 'playing') {
                    const d = decodePositionAndObjectId(p.payload);
                    this.regionId = d.regionId;
                    this.mover.snap(d.regionId, d.x, d.y, d.z, d.heading, 'teleported');
                    this.model.self.isSitting = false;
                    this.mover.sendUpdate();
                }
                break;
            }
            case ServerOp.Riding: {
                const d = decodeRiding(p.payload);
                if (this.objectId !== 0 && d.riderId === this.objectId) this.steedId = d.mounted ? d.steedId : null;
                break;
            }
            case ServerOp.RegionChanged: {
                const d = decodeRegionChanged(p.payload);
                this.log(`region change → ${d.regionId}`);
                void this.changeRegion();
                break;
            }
            case ServerOp.MaxSpeed:
                // 0 is real (rooted, stunned, mezzed, over-encumbered: PlayerMovementComponent.cs:29,132);
                // moving anyway would be flagged by PlayerMovementMonitor and teleported back.
                {
                    const d = decodeMaxSpeed(p.payload);
                    this.mover.maxSpeedPercent = d.percent;
                    this.mover.waterSpeedPercent = d.waterSpeed;
                }
                break;
            case ServerOp.CharacterStatusUpdate: {
                // The server stands us up on its own (moving, attacked, quit cancelled); keep the 0xA9
                // SITTING state flag in sync with 0xAD's sitting flag (PacketLib168.cs:1252-1257).
                const d = decodeStatusUpdate(p.payload);
                this.mover.healthPercent = d.healthPercent;
                this.mover.sitting = (d.sittingFlag & 0x02) !== 0;
                break;
            }
            case ServerOp.ObjectUpdate:
                this.requestUnknownObject(decodeObjectUpdate(p.payload));
                break;
            case ServerOp.RemoveObject: {
                // The model drops our selection on this (and hasn't yet, here); the server's TargetObject stays on the deleted NPC. A Pet spell with no target would land
                // on a dead pet of ours, paid (SpellHandler.cs:463-473, :648-658), and a quit release that one and not the live pet (GamePlayer.cs:927-928, CharacterClassBase.cs:332-341).
                // A target moved on before this came stays: then the model's isn't this one.
                const d = decodeRemoveObject(p.payload);
                if (d.type === 0 && d.objectId === this.model.self.targetObjectId) this.send(ClientOp.PlayerTarget, out.encodeTarget(0));
                break;
            }
            case ServerOp.SpellCastAnimation: {
                const d = decodeSpellCastAnimation(p.payload);
                if (d.casterId === this.objectId && d.castTimeMs > 0) this.mover.holdPosition(d.castTimeMs + 250);
                break;
            }
            case ServerOp.InterruptSpellCast:
                // Every break in the casting phase says so, whatever the line that goes with it, "You move and interrupt your focus!" too (CastingComponent.cs:189-207). With none the cast is over anyway: the hold ran for its time.
                if (decodeInterrupt(p.payload).objectId === this.objectId) this.mover.releaseHold();
                break;
            case ServerOp.LoginDenied: {
                const code = decodeLoginDenied(p.payload).code;
                this.lastError = loginErrorName(code);
                break;
            }
            case ServerOp.Quit: {
                // 0xA4 (totalOut=0) sends the client back to the character screen; the player is already
                // deleted server-side but ClientState is still Playing, so dropping the socket now would start
                // a 60 s hard link-death (GameClient.OnDisconnect, GameClient.cs:416-458). Re-enter the
                // character screen with 0xFC first; a disconnect from CharScreen quits immediately.
                // The server also sends it unasked (idle kick, unknown zone, ECS service exception, hardcore
                // death: GameServiceUtils.KickPlayerToCharScreen, GameServiceUtils.cs:23-40,71-85).
                const d = decodeQuit(p.payload);
                this.log(this.quitRequested ? 'quit acknowledged (0xA4)' : `kicked to the character screen by the server (0xA4 totalOut=${d.totalOut})`);
                void this.finishQuit();
                break;
            }
        }
    }

    private async changeRegion(): Promise<void> {
        if (this.regionChanging) return;
        this.regionChanging = true;
        this.mover.pause();
        this.mover.stop('regionChange');
        this.model.clearWorld();
        this.requestedObjects.clear(); // object ids are per region
        this.model.self.isSitting = false; // MoveTo to another region stands us up too (GamePlayer.cs:7900-7906)
        try {
            await this.enterWorld(false);
        } catch (e) {
            this.regionChanging = false;
            this.end('error', `region change failed: ${(e as Error).message}`);
        }
    }

    waitFor(codes: number[], timeoutMs: number, what: string, predicate?: (p: ServerPacket) => boolean): Promise<ServerPacket> {
        return new Promise((resolve, reject) => {
            if (!this.connection?.isOpen) {
                reject(new SessionError(this.endReason ?? 'serverClosed', `connection closed while waiting for ${what}`));
                return;
            }
            const w: Waiter = {
                codes: new Set(codes),
                predicate,
                resolve,
                reject,
                timer: setTimeout(() => {
                    this.waiters = this.waiters.filter(x => x !== w);
                    reject(new SessionError('timeout', `timed out after ${timeoutMs} ms waiting for ${what}`));
                }, timeoutMs),
            };
            this.waiters.push(w);
        });
    }

    // ── shutdown ──────────────────────────────────────────────────────────

    /** Set once we send '&quit'; an 0xA4 without it is a server kick. */
    private quitRequested = false;

    /** A '&quit' is being sent outside quit() (a raw command): its 0xA4 is a clean quit. */
    noteQuitRequested(): void {
        this.quitRequested = true;
    }

    /** Clean quit: stop moving, '&quit', wait for 0xA4, close. Falls back to closing after `timeoutMs`. */
    async quit(timeoutMs = 75_000): Promise<void> {
        if (!this.connection?.isOpen) return;
        if (this.phase === 'quitting') {
            // A quit is already under way (0xA4 → 0xFC); closing now would link-death the character.
            await this.waitUntil(() => this.ended, timeoutMs);
            if (!this.ended) this.close('quit');
            return;
        }
        if (this.phase === 'enteringWorld' || this.phase === 'regionChange') {
            // Dropping the socket mid world entry also link-deaths the character: let it land first.
            await this.waitUntil(() => this.phase !== 'enteringWorld' && this.phase !== 'regionChange', 30_000);
        }
        if (this.phase !== 'playing') {
            this.close('quit');
            return;
        }
        if (this.model.self.isDead) {
            // A dead character cannot quit (GamePlayer.Quit: CantQuitDead, GamePlayer.cs:1025); release
            // first. Before RELEASE_MINIMUM_WAIT (10 s after death) '&release' only toggles the automatic
            // release, so a second one would cancel it (GamePlayer.cs:1438-1448): wait the 10 s out.
            const sinceDeath = Date.now() - (this.model.self.lastDeathAt ?? 0);
            this.log('quit: dead, releasing first');
            if (sinceDeath < 11_000) await this.waitUntil(() => this.ended || !this.model.self.isDead, 11_000 - sinceDeath);
            if (this.ended) return;
            if (this.model.self.isDead) this.send(ClientOp.CommandHandler, out.encodeCommand('&release'));
            await this.waitUntil(() => this.ended || (!this.model.self.isDead && this.phase === 'playing'), 20_000);
            if (this.ended) return;
            if (this.phase !== 'playing') {
                this.close('quit');
                return;
            }
        }
        this.setPhase('quitting');
        this.mover.stop('stopped');
        this.mover.sendUpdate();
        const done = new Promise<void>(resolve => this.onEnd(() => resolve()));
        this.quitRequested = true;
        this.send(ClientOp.CommandHandler, out.encodeCommand('&quit'));
        const timer = setTimeout(() => {
            this.log(`quit: no 0xA4 after ${timeoutMs} ms; closing anyway`);
            this.close('quit');
        }, timeoutMs);
        await done;
        clearTimeout(timer);
    }

    /** Resolves once `pred` holds or `ms` has passed (checked every 50 ms). */
    private async waitUntil(pred: () => boolean, ms: number): Promise<void> {
        const deadline = Date.now() + ms;
        while (!pred() && Date.now() < deadline) await Bun.sleep(50);
    }

    private quitFinishing = false;

    private async finishQuit(): Promise<void> {
        if (this.quitFinishing) return;
        this.quitFinishing = true;
        this.mover.pause();
        this.setPhase('quitting');
        this.send(ClientOp.CharacterOverviewRequest, out.encodeCharacterOverviewRequest(this.accountRealm || realmNumber(this.opts.realm)));
        try {
            await this.waitFor([ServerOp.CharacterOverview1126, ServerOp.Realm], 5000, 'CharacterOverview after quit');
        } catch {
            // closing anyway
        }
        if (this.quitRequested) this.end('quit', 'quit');
        else this.end('kicked', 'kicked to the character screen by the server (0xA4)');
    }

    /** Close the socket immediately. While playing this causes a 60 s link-death lockout server-side. */
    close(reason: SessionEndReason = 'clientClosed'): void {
        this.end(reason, reason);
    }

    private fail(reason: SessionEndReason, message: string, code?: number): SessionError {
        this.lastError = message;
        const err = new SessionError(reason, message, code);
        this.end(reason, message);
        return err;
    }

    private handleClose(reason: string): void {
        this.end(this.endReason ?? 'serverClosed', reason);
    }

    private end(reason: SessionEndReason, message: string): void {
        if (this.ended) return;
        this.ended = true;
        if (!this.endReason) this.endReason = reason;
        if (reason !== 'quit' && reason !== 'clientClosed') this.lastError = this.lastError ?? message;
        this.mover.dispose();
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        const waiters = this.waiters;
        this.waiters = [];
        for (const w of waiters) {
            clearTimeout(w.timer);
            w.reject(new SessionError(this.endReason, `session ended (${message})`));
        }
        this.connection?.close(message);
        this.setPhase('disconnected');
        for (const fn of this.endListeners) fn(this.endReason, message);
    }
}

export function defaultClass(realm: number): string {
    return realm === 1 ? 'Fighter' : realm === 2 ? 'Viking' : 'Guardian';
}

export function defaultRace(realm: number): string {
    return realm === 1 ? 'Briton' : realm === 2 ? 'Norseman' : 'Celt';
}
