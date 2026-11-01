// WorldModel: applies decoded server packets to an in-memory picture of the
// world, and builds the BotWorldState pieces from it. It does not own our
// position (the Mover does); callers pass it in when building snapshots.

import type {
    Ability, CombatEvent, DialogBox, Effect, GameMessage, GroupMember, InventoryItem, MerchantItem,
    MerchantState, Money, NearbyNpc, NearbyObject, NearbyPlayer, NpcDialog, Realm, SkillsState,
    Specialization, Spell, SpellDetails, Stats, Style, StyleDetails, TextWindow, TrainerState, Vec3,
} from '../../sdk/types';
import { getZone } from '../../data/zones';
import { ServerOp } from '../protocol/opcodes';
import { chatTypeName, decodeDialog, decodeMessage, decodeTextWindow, extractKeywords, parseSpeech } from '../protocol/incoming/chat';
import {
    decodeAttackMode, decodeChangeGroundTarget, decodeChangeTarget, decodeCombatAnimation, decodeConcentrationList, decodeDisableSkills,
    decodeInterrupt, decodePlayerDeath, decodeRevive, decodeSpellCastAnimation, decodeSpellEffect, decodeUpdateIcons,
    type ConcentrationEntry,
} from '../protocol/incoming/combat';
import {
    decodeNpcCreate, decodeObjectCreate, decodeObjectDelete, decodeObjectUpdate, decodePlayerCreate,
    decodePlayerHeading, decodePlayerPosition, decodeRemoveObject, decodeObjectDataUpdate,
} from '../protocol/incoming/objects';
import {
    decodeDelveInfo, decodeInventoryUpdate, decodeMoney, decodePointsUpdate, decodeStatsUpdate, decodeStatusUpdate, decodeVariousUpdate,
    toSpellDetails, toStyleDetails, type ItemData, type SpellLinePage, type UsableSkillEntry,
} from '../protocol/incoming/player';
import { decodeEncumbrance, decodeMaxSpeed, decodeTime } from '../protocol/incoming/world';
import { decodeGroupMemberUpdate, decodeMerchantWindow, decodeTrainerWindow } from '../protocol/incoming/windows';
import { realmName } from './classes';

/** (ushort)1000000: the server's 'no concentration' MaxConcentration. */
const NO_CONCENTRATION_U16 = 1_000_000 & 0xffff;
/** Process-wide, so ids stay monotonic across re-logins (a new WorldModel per session). */
let nextMessageId = 1;
export const VISIBILITY_DISTANCE = 6000;
const NPC_STALE_MS = 16_000;
const OBJECT_STALE_MS = 95_000;
const PLAYER_STALE_MS = 60_000;
/**
 * A relayed position sent just before a player's death can arrive just after its 0xAE (UDP behind
 * TCP), with the old health: health only revives a death this old. A release takes at least 10 s
 * (GamePlayer.RELEASE_MINIMUM_WAIT) and a rez its cast time.
 */
const REVIVE_SETTLE_MS = 2000;
const MAX_MESSAGES = 100;
/** Enough for a group-vs-group fight: every swing and spell in view lands here, not only ours. */
export const MAX_COMBAT_EVENTS = 200;
/**
 * The trainer window is client-side only: the server never sends a close (it only pushes 0x7B,
 * GameTrainer.cs:132/198, PlayerTrainRequestHandler.cs:240, train.cs:170). Training needs the trainer
 * as TargetObject unless allow_train_anywhere is on (TrainCommandHandler.CanTrain, train.cs:141-152;
 * it is on by default and on this server, so a window may legitimately open far from any trainer).
 * We treat the window as closed once the target moves off the trainer it arrived with, we walk this
 * far from where we stood when it arrived, or the region changes.
 */
export const TRAINER_WINDOW_RANGE = 512;

/** Copper per denomination (Money.cs:39-66: GetMoney = ((mithril*1000 + platinum)*1000 + gold)*100*100 + ...). */
export const COPPER_PER = { silver: 100, gold: 100 * 100, platinum: 100 * 100 * 1000, mithril: 100 * 100 * 1000 * 1000 } as const;

export function totalCopper(m: { copper: number; silver: number; gold: number; platinum: number; mithril: number }): number {
    return m.copper + m.silver * COPPER_PER.silver + m.gold * COPPER_PER.gold + m.platinum * COPPER_PER.platinum + m.mithril * COPPER_PER.mithril;
}

/**
 * Reverse of GlobalConstants.GetSpecToInternalIndex (GlobalConstants.cs:801-891), which the server
 * writes as the bonus byte of a 0x16/01 style entry (PacketLib1112.cs:150). Values are the Specs
 * constants (SkillConstants.cs:467-842), i.e. the specialization names in the same skill list.
 */
export const SPEC_BY_INTERNAL_INDEX: Readonly<Record<number, string>> = {
    0x01: 'Slash', 0x02: 'Thrust', 0x08: 'Parry', 0x0E: 'Sword', 0x10: 'Hammer', 0x11: 'Axe', 0x12: 'Left Axe',
    0x13: 'Stealth', 0x1A: 'Spear', 0x1D: 'Mending', 0x1E: 'Augmentation', 0x21: 'Crush', 0x22: 'Pacification',
    0x26: 'Darkness', 0x27: 'Suppression', 0x2A: 'Runecarving', 0x2B: 'Shields', 0x2E: 'Flexible', 0x2F: 'Staff',
    0x30: 'Summoning', 0x32: 'Stormcalling', 0x3E: 'Beastcraft', 0x40: 'Polearm', 0x41: 'Two Handed',
    0x42: 'Fire Magic', 0x43: 'Wind Magic', 0x44: 'Cold Magic', 0x45: 'Earth Magic', 0x46: 'Light',
    0x47: 'Matter Magic', 0x48: 'Body Magic', 0x49: 'Spirit Magic', 0x4A: 'Mind Magic', 0x4B: 'Void', 0x4C: 'Mana',
    0x4D: 'Dual Wield', 0x4E: 'Composite Bow', 0x52: 'Battlesongs', 0x53: 'Enhancement', 0x54: 'Enchantments',
    0x58: 'Rejuvenation', 0x59: 'Smite', 0x5A: 'Longbows', 0x5B: 'Crossbows', 0x61: 'Chants', 0x62: 'Instruments',
    0x65: 'Blades', 0x66: 'Blunt', 0x67: 'Piercing', 0x68: 'Large Weapons', 0x69: 'Mentalism', 0x6A: 'Regrowth',
    0x6B: 'Nurture', 0x6C: 'Nature', 0x6D: 'Music', 0x6E: 'Celtic Dual', 0x70: 'Celtic Spear', 0x71: 'Recurve Bow',
    0x72: 'Valor', 0x74: 'Pathfinding', 0x75: 'Envenom', 0x76: 'Critical Strike', 0x78: 'Deathsight',
    0x79: 'Painworking', 0x7A: 'Death Servant', 0x7B: 'Soulrending', 0x7C: 'Hand to Hand', 0x7D: 'Scythe',
    0x7F: 'Arboreal Path', 0x81: 'Creeping Path', 0x82: 'Verdant Path', 0x85: "Odin's Will", 0x86: 'Spectral Force',
    0x87: 'Phantasmal Wail', 0x88: 'Ethereal Shriek', 0x89: 'Shadow Mastery', 0x8A: 'Vampiiric Embrace',
    0x8B: 'Dementia', 0x8C: 'Witchcraft', 0x8D: 'Cursing', 0x8E: 'Hexing', 0x93: 'Fist Wraps', 0x94: 'Mauler Staff',
    0x95: 'Spectral Guard', 0x9B: 'Archery',
};

/** Server packets we recognise but do not model (IPacketLib.cs eServerPackets): visuals, sounds, keeps, housing, social. */
const IGNORED_OPCODES = new Set<number>([
    0x03, 0x05, 0x08, 0x09, 0x0A, 0x0F, 0x12, 0x13, 0x18, 0x1E, 0x1F, 0x45, 0x46, 0x49, 0x4A, 0x4C, 0x4E, 0x59, 0x5C,
    0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x86, 0x88, 0x8D, 0x92, 0x99,
    0x9E, 0xC3, 0xC5, 0xC6, 0xC8, 0xC9, 0xD1, 0xD3, 0xDB, 0xE2, 0xE3, 0xEA, 0xEF, 0xF0, 0xF3, 0xF5, 0xF7, 0xF9,
]);

export interface NpcEntry {
    objectId: number;
    name: string;
    guildName: string;
    level: number;
    model: number;
    realm: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    speed: number;
    dest: Vec3 | null;
    healthPercent: number;
    targetId: number;
    isPeaceful: boolean;
    isTargetable: boolean;
    hasQuest: boolean;
    isPet: boolean;
    lastUpdate: number;
}

export interface PlayerEntry {
    objectId: number;
    sessionId: number;
    name: string;
    guildName: string;
    lastName: string;
    level: number;
    realm: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    speed: number;
    healthPercent: number;
    /** From 0xAE or the create's dead flag until it shows health again (relayedHealth); never from 0 % alone. */
    isDead: boolean;
    /** When 0xAE marked it dead; 0 otherwise. */
    diedAt: number;
    isSitting: boolean;
    inCombat: boolean;
    lastUpdate: number;
}

export interface ObjectEntry {
    objectId: number;
    name: string;
    model: number;
    realm: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    doorId: number | null;
    isLoot: boolean;
    ownedByUs: boolean;
    lastUpdate: number;
}

export interface SelfState {
    name: string;
    lastName: string;
    guildName: string;
    accountName: string;
    objectId: number;
    sessionId: number;
    level: number;
    realm: number;
    className: string;
    raceName: string;
    maxSpeedPercent: number;
    health: number;
    maxHealth: number;
    healthPercent: number;
    mana: number;
    maxMana: number;
    manaPercent: number;
    endurance: number;
    maxEndurance: number;
    endurancePercent: number;
    concentration: number;
    maxConcentration: number;
    experience: number;
    experienceForNextLevel: number;
    levelPermill: number;
    realmPoints: number;
    bountyPoints: number;
    specPoints: number;
    realmSpecPoints: number;
    money: Money;
    stats: Stats | null;
    constitutionLost: number;
    encumbrance: { current: number; max: number } | null;
    isDead: boolean;
    isSitting: boolean;
    attacking: boolean;
    targetObjectId: number | null;
    deathCount: number;
    lastDeathAt: number | null;
    lastCombatAt: number;
    statusReceived: boolean;
}

export interface ModelHooks {
    /** A relayed 0xA9/0xBA named a session we have no 0x4B for. */
    onUnknownSession?(sessionId: number): void;
    /** We died (0xAE with victim = us). */
    onSelfDeath?(): void;
    /** A significant change (death, dialog, merchant, target, combat start/stop...). */
    onSignificant?(reason: string): void;
}

export interface PositionRef {
    x: number;
    y: number;
    z: number;
}

function closedTrainer(receivedAt = 0): TrainerState {
    return { isOpen: false, specPoints: 0, specs: [], trainerObjectId: null, receivedAt };
}

function emptyMoney(): Money {
    return { copper: 0, silver: 0, gold: 0, mithril: 0, platinum: 0, totalCopper: 0 };
}

function newSelf(): SelfState {
    return {
        name: '', lastName: '', guildName: '', accountName: '', objectId: 0, sessionId: 0, level: 0, realm: 0,
        className: '', raceName: '', maxSpeedPercent: 100,
        health: 0, maxHealth: 0, healthPercent: 100, mana: 0, maxMana: 0, manaPercent: 0,
        endurance: 0, maxEndurance: 0, endurancePercent: 100, concentration: 0, maxConcentration: 0,
        experience: 0, experienceForNextLevel: 0, levelPermill: 0, realmPoints: 0, bountyPoints: 0,
        specPoints: 0, realmSpecPoints: 0, money: emptyMoney(), stats: null, constitutionLost: 0, encumbrance: null,
        isDead: false, isSitting: false, attacking: false, targetObjectId: null, deathCount: 0,
        lastDeathAt: null, lastCombatAt: 0, statusReceived: false,
    };
}

export function guessNpcRole(name: string, guild: string): string | null {
    const t = `${guild} ${name}`.toLowerCase();
    if (/merchant|vendor|shopkeep|smith|armou?r|weapon|tailor|fletcher|baker|grocer|provision|supplies|arrow|bowyer|dyes?\b|poison/.test(t)) return 'merchant';
    if (/trainer|master\b|mentor|instructor|lord|lady|elder/.test(guild.toLowerCase())) return 'trainer';
    if (/stable|horse|hastener/.test(t)) return 'stablemaster';
    if (/healer/.test(t)) return 'healer';
    if (/guard|sentry|sentinel|watchman|soldier/.test(t)) return 'guard';
    if (/vault|keeper|banker/.test(t)) return 'vault';
    if (/teleport|channeler/.test(t)) return 'teleporter';
    if (/town crier|crier|enchanter|recharger|guild registrar|registrar/.test(t)) return 'service';
    return null;
}

const dist3 = (a: PositionRef, b: PositionRef): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dist2 = (a: PositionRef, b: PositionRef): number => Math.hypot(a.x - b.x, a.y - b.y);

/** item.Type_Damage in the merchant window's type byte (PacketLib1125.cs:689). */
const MERCHANT_DAMAGE_TYPES: Record<number, MerchantItem['damageType']> = { 1: 'crush', 2: 'slash', 3: 'thrust' };

export class WorldModel {
    self = newSelf();
    npcs = new Map<number, NpcEntry>();
    players = new Map<number, PlayerEntry>();
    sessionToOid = new Map<number, number>();
    objects = new Map<number, ObjectEntry>();
    /** All inventory slots (equipment, backpack, vault, ...). */
    items = new Map<number, InventoryItem>();
    usableSkills: UsableSkillEntry[] = [];
    /** 0xD8 tooltips by '<kind>:<internal id>'. Kept when the skills list is resent, since the server pushes each only hourly. */
    delves = new Map<string, Record<string, string>>();
    spellLines = new Map<number, SpellLinePage>();
    private spellLinesSinceFooter = 0;
    /** key 'S:<skillIndex>' or 'L:<line>:<spell>' → expiresAt ms. */
    cooldowns = new Map<string, number>();
    effects = new Map<number, Effect & { receivedAt: number }>();
    concentrationEffects: ConcentrationEntry[] = [];
    group: GroupMember[] = [];
    messages: GameMessage[] = [];
    npcDialog: NpcDialog | null = null;
    dialog: DialogBox | null = null;
    textWindow: TextWindow | null = null;
    merchant: MerchantState = { isOpen: false, merchantObjectId: null, windowType: 0, items: [] };
    private merchantLastPageAt = 0;
    /** Where we stood when the trainer window arrived (set by the next cull). */
    private trainerAnchor: PositionRef | null = null;
    trainer: TrainerState = closedTrainer();
    combatEvents: CombatEvent[] = [];
    groundTarget: Vec3 | null = null;
    gameTime = 0;

    revision = 0;
    decodeErrors = 0;
    unknownOpcodes = new Map<number, number>();
    packetsHandled = 0;
    lastDecodeError: string | null = null;
    /** Recent decode error timestamps, for the "burst" check. */
    private errorTimes: number[] = [];

    private nextCombatId = 1;
    private lastNpcDeath: { at: number; x: number; y: number } | null = null;

    constructor(public hooks: ModelHooks = {}, private readonly now: () => number = Date.now) {}

    /** Clear everything region-specific (called on region change / world re-entry). */
    clearWorld(): void {
        this.npcs.clear();
        this.players.clear();
        this.sessionToOid.clear();
        this.objects.clear();
        this.merchant = { isOpen: false, merchantObjectId: null, windowType: 0, items: [] };
        this.closeTrainer();
        this.self.targetObjectId = null;
        this.revision++;
    }

    /** Mark the trainer window closed (keeps `receivedAt`, so callers comparing it see no new window). */
    closeTrainer(): void {
        if (!this.trainer.isOpen) return;
        this.trainer = closedTrainer(this.trainer.receivedAt);
        this.revision++;
    }

    /** Our current target changed (our 0xB0 PlayerTarget or the server's 0xF6 ChangeTarget). A trainer window belongs to its target. */
    setSelfTarget(objectId: number | null): void {
        this.self.targetObjectId = objectId || null;
        const t = this.trainer;
        if (t.isOpen && t.trainerObjectId != null && t.trainerObjectId !== this.self.targetObjectId) this.closeTrainer();
    }

    /** Decode errors in the last 10 s. */
    recentDecodeErrors(windowMs = 10_000): number {
        const cutoff = this.now() - windowMs;
        this.errorTimes = this.errorTimes.filter(t => t >= cutoff);
        return this.errorTimes.length;
    }

    /** Apply one server packet. Returns false for opcodes the model does not handle. Never throws. */
    handle(code: number, payload: Uint8Array): boolean {
        try {
            const handled = this.apply(code, payload);
            if (handled) {
                this.packetsHandled++;
                this.revision++;
            } else {
                this.unknownOpcodes.set(code, (this.unknownOpcodes.get(code) ?? 0) + 1);
            }
            return handled;
        } catch (e) {
            this.decodeErrors++;
            this.errorTimes.push(this.now());
            this.lastDecodeError = `0x${code.toString(16)}: ${(e as Error).message}`;
            return true;
        }
    }

    private signal(reason: string): void {
        this.hooks.onSignificant?.(reason);
    }

    private apply(code: number, p: Uint8Array): boolean {
        const now = this.now();
        switch (code) {
            case ServerOp.NPCCreate: {
                const d = decodeNpcCreate(p);
                this.objects.delete(d.objectId);
                this.players.delete(d.objectId);
                const prev = this.npcs.get(d.objectId);
                this.npcs.set(d.objectId, {
                    objectId: d.objectId, name: d.name, guildName: d.guildName, level: d.level, model: d.model,
                    realm: d.realm, x: d.x, y: d.y, z: d.z, heading: d.heading, speed: d.speed, dest: null,
                    healthPercent: prev?.healthPercent ?? 100, targetId: prev?.targetId ?? 0,
                    isPeaceful: d.isPeaceful, isTargetable: !d.cantTarget, hasQuest: d.questAvailable || d.questFinish,
                    isPet: d.isPet, lastUpdate: now,
                });
                return true;
            }
            case ServerOp.ObjectUpdate: {
                const d = decodeObjectUpdate(p);
                const zone = getZone(d.zoneSkinId);
                if (!zone) return true;
                const x = zone.xOffset + d.xOffset;
                const y = zone.yOffset + d.yOffset;
                const npc = this.npcs.get(d.objectId);
                if (npc) {
                    npc.x = x;
                    npc.y = y;
                    npc.z = d.z;
                    npc.heading = d.heading;
                    npc.speed = d.speed;
                    npc.healthPercent = d.healthPercent;
                    npc.targetId = d.targetId;
                    npc.realm = d.realm;
                    npc.lastUpdate = now;
                    // targetZoneSkinId is 0 both for "no destination" and for zone 0, so key off the offsets.
                    const hasDest = d.speed > 0 && (d.destXOffset !== 0 || d.destYOffset !== 0);
                    const dz = hasDest ? getZone(d.destZoneSkinId) : undefined;
                    npc.dest = d.speed > 0 && dz ? { x: dz.xOffset + d.destXOffset, y: dz.yOffset + d.destYOffset, z: d.destZ } : null;
                    return true;
                }
                const obj = this.objects.get(d.objectId);
                if (obj) {
                    obj.x = x;
                    obj.y = y;
                    obj.z = d.z;
                    obj.heading = d.heading;
                    obj.lastUpdate = now;
                }
                return true;
            }
            case ServerOp.RemoveObject: {
                const d = decodeRemoveObject(p);
                const npc = this.npcs.get(d.objectId);
                if (npc && d.type === 0) {
                    this.lastNpcDeath = { at: now, x: npc.x, y: npc.y };
                    this.pushCombat({ kind: 'death', attackerObjectId: null, targetObjectId: d.objectId, targetHealthPercent: 0 });
                }
                this.removeObject(d.objectId);
                return true;
            }
            case ServerOp.ObjectDelete: {
                this.removeObject(decodeObjectDelete(p).objectId);
                return true;
            }
            case ServerOp.ObjectCreate: {
                const d = decodeObjectCreate(p);
                this.npcs.delete(d.objectId);
                this.players.delete(d.objectId);
                // Static items are re-sent as 0xD9 every world_object_update_interval (30 s, ClientService.cs:832-865),
                // so the "spawned next to a fresh corpse" guess only applies the first time we see an object,
                // and an object already judged to be loot stays loot.
                const prev = this.objects.get(d.objectId);
                const samePrev = prev !== undefined && prev.name === d.name;
                const nearDeath = !samePrev && this.lastNpcDeath !== null && now - this.lastNpcDeath.at < 5000
                    && Math.hypot(this.lastNpcDeath.x - d.x, this.lastNpcDeath.y - d.y) < 400;
                const isLoot = d.doorId === null
                    && (d.ownedByUs || /\b(coins?|bag|pouch)\b/i.test(d.name) || nearDeath || (samePrev && prev.isLoot));
                this.objects.set(d.objectId, {
                    objectId: d.objectId, name: d.name, model: d.model, realm: d.realm, x: d.x, y: d.y, z: d.z,
                    heading: d.heading, doorId: d.doorId, isLoot, ownedByUs: d.ownedByUs, lastUpdate: now,
                });
                return true;
            }
            case ServerOp.PlayerCreate172: {
                const d = decodePlayerCreate(p);
                if (d.objectId === this.self.objectId) return true;
                this.npcs.delete(d.objectId);
                this.objects.delete(d.objectId);
                this.sessionToOid.set(d.sessionId, d.objectId);
                this.players.set(d.objectId, {
                    objectId: d.objectId, sessionId: d.sessionId, name: d.name, guildName: d.guildName, lastName: d.lastName,
                    level: d.level, realm: d.realm, x: d.x, y: d.y, z: d.z, heading: d.heading, speed: 0,
                    healthPercent: d.isDead ? 0 : 100, isDead: d.isDead, diedAt: 0, isSitting: false, inCombat: false, lastUpdate: now,
                });
                return true;
            }
            case ServerOp.PlayerPosition: {
                const d = decodePlayerPosition(p);
                if (d.sessionId === this.self.sessionId && this.self.sessionId !== 0) return true;
                const oid = this.sessionToOid.get(d.sessionId);
                const pl = oid !== undefined ? this.players.get(oid) : undefined;
                if (!pl) {
                    this.hooks.onUnknownSession?.(d.sessionId);
                    return true;
                }
                Object.assign(pl, {
                    x: d.x, y: d.y, z: d.z, heading: d.heading, speed: d.speed,
                    inCombat: d.inCombat, isSitting: d.isSitting, lastUpdate: now,
                });
                this.relayedHealth(pl, d.healthPercent, d.isDead, now);
                return true;
            }
            case ServerOp.PlayerHeading: {
                const d = decodePlayerHeading(p);
                if (d.sessionId === this.self.sessionId && this.self.sessionId !== 0) return true;
                const oid = this.sessionToOid.get(d.sessionId);
                const pl = oid !== undefined ? this.players.get(oid) : undefined;
                if (!pl) {
                    this.hooks.onUnknownSession?.(d.sessionId);
                    return true;
                }
                pl.heading = d.heading;
                pl.inCombat = d.inCombat;
                pl.lastUpdate = now;
                this.relayedHealth(pl, d.healthPercent, false, now);
                return true;
            }
            case ServerOp.ObjectDataUpdate: {
                const d = decodeObjectDataUpdate(p);
                const e = this.npcs.get(d.objectId) ?? this.players.get(d.objectId);
                if (e) e.level = d.level;
                return true;
            }
            case ServerOp.CharacterStatusUpdate: {
                const d = decodeStatusUpdate(p);
                const s = this.self;
                const wasDead = s.isDead;
                // Classes without a mana stat get MaxConcentration 1000000 (MaxConcentrationCalculator.cs:20),
                // written as (ushort) = 16960 (PacketLib190.cs:68); real values stay far below that.
                const noConc = d.maxConcentration === NO_CONCENTRATION_U16;
                Object.assign(s, {
                    healthPercent: d.healthPercent, manaPercent: d.manaPercent, endurancePercent: d.endurancePercent,
                    maxMana: d.maxMana, maxEndurance: d.maxEndurance, maxConcentration: noConc ? 0 : d.maxConcentration,
                    maxHealth: d.maxHealth, health: d.health, endurance: d.endurance, mana: d.mana,
                    concentration: noConc ? 0 : d.concentration, isSitting: (d.sittingFlag & 0x02) !== 0, statusReceived: true,
                });
                if (d.health > 0 && wasDead) {
                    s.isDead = false;
                    this.signal('revived');
                } else if (d.health === 0 && d.maxHealth > 0 && !wasDead) {
                    this.markSelfDead(now);
                }
                return true;
            }
            case ServerOp.CharacterPointsUpdate: {
                Object.assign(this.self, decodePointsUpdate(p));
                return true;
            }
            case ServerOp.MoneyUpdate: {
                const m = decodeMoney(p);
                // Mithril is the top denomination (10^10 copper), platinum 10^7 (Money.cs:39-66).
                this.self.money = { ...m, totalCopper: totalCopper(m) };
                return true;
            }
            case ServerOp.StatsUpdate: {
                const d = decodeStatsUpdate(p);
                if (d.kind === 'stats') {
                    const v = (i: number): number => d.base[i]! + d.buff[i]! + Math.min(d.item[i]!, d.itemCap[i] || d.item[i]!) + d.ra[i]!;
                    this.self.stats = {
                        strength: v(0), dexterity: v(1), constitution: v(2), quickness: v(3),
                        intelligence: v(4), piety: v(5), empathy: v(6), charisma: v(7),
                    };
                    if (d.maxHealth > 0) this.self.maxHealth = d.maxHealth;
                    this.self.constitutionLost = d.constitutionLost;
                }
                return true;
            }
            case ServerOp.MaxSpeed: {
                this.self.maxSpeedPercent = decodeMaxSpeed(p).percent;
                return true;
            }
            case ServerOp.Encumberance: {
                this.self.encumbrance = decodeEncumbrance(p);
                return true;
            }
            case ServerOp.DelveInfo: {
                const d = decodeDelveInfo(p);
                if (d && d.fields.Index !== undefined) this.delves.set(`${d.kind}:${Number(d.fields.Index) & 0xffff}`, d.fields);
                return true;
            }
            case ServerOp.VariousUpdate:
                return this.applyVarious(p);
            case ServerOp.InventoryUpdate: {
                const d = decodeInventoryUpdate(p);
                for (const { slot, item } of d.items) {
                    if (item.empty) this.items.delete(slot);
                    else this.items.set(slot, toInventoryItem(slot, item));
                }
                return true;
            }
            case ServerOp.Message:
                this.applyMessage(p, now);
                return true;
            case ServerOp.Dialog: {
                const d = decodeDialog(p);
                this.dialog = { isOpen: true, code: d.code, data: d.data, type: d.type, text: d.text, receivedAt: now };
                this.signal('dialog');
                return true;
            }
            case ServerOp.DetailWindow: {
                const d = decodeTextWindow(p);
                this.textWindow = { caption: d.caption, lines: d.lines, receivedAt: now };
                this.signal('textWindow');
                return true;
            }
            case ServerOp.MerchantWindow: {
                const d = decodeMerchantWindow(p);
                if (!this.merchant.isOpen || now - this.merchantLastPageAt > 1000) {
                    this.merchant = { isOpen: true, merchantObjectId: this.self.targetObjectId, windowType: d.windowType, items: [] };
                }
                this.merchantLastPageAt = now;
                this.merchant.windowType = d.windowType;
                this.merchant.items = this.merchant.items.filter(i => i.page !== d.page);
                for (const it of d.items) {
                    const item: MerchantItem = {
                        page: d.page, slot: it.index, name: it.name, level: it.level, price: it.price, model: it.model, usable: it.usable,
                        objectType: it.objectType, hand: it.hand, damageType: MERCHANT_DAMAGE_TYPES[it.damageType] ?? null, value1: it.value1, spdAbs: it.spdAbs,
                    };
                    this.merchant.items.push(item);
                }
                this.merchant.items.sort((a, b) => a.page * 30 + a.slot - (b.page * 30 + b.slot));
                this.signal('merchant');
                return true;
            }
            case ServerOp.TrainerWindow: {
                const d = decodeTrainerWindow(p);
                if ('specs' in d) {
                    this.trainer = {
                        isOpen: true,
                        specPoints: d.specPoints,
                        specs: d.specs.map(s => ({ index: s.index, name: s.name, level: s.level, nextLevelCost: s.nextLevel })),
                        trainerObjectId: this.self.targetObjectId,
                        receivedAt: now,
                    };
                    this.trainerAnchor = null;
                    this.signal('trainer');
                }
                return true;
            }
            case ServerOp.GroupMemberUpdate: {
                const d = decodeGroupMemberUpdate(p);
                for (const rec of d.records) {
                    if (rec.kind !== 'status') continue;
                    const m = this.group[rec.groupIndex];
                    if (!m) continue;
                    m.healthPercent = rec.healthPercent;
                    m.manaPercent = rec.manaPercent;
                    m.endurancePercent = rec.endurancePercent;
                    m.isDead = (rec.status & 0x01) !== 0;
                    m.inOtherRegion = (rec.status & 0x20) !== 0;
                }
                return true;
            }
            case ServerOp.CombatAnimation: {
                const d = decodeCombatAnimation(p);
                this.pushCombat({
                    kind: 'melee', attackerObjectId: d.attackerId || null, targetObjectId: d.defenderId || null,
                    result: d.result, targetHealthPercent: d.targetHealthPercent,
                });
                // The defender's HealthPercent at the swing (WeaponAction.cs:369), sent to everyone in view
                // of it: for a player fresher than its 0xA9 relay, which waits for its next position update.
                // Not a player's from our own swing: when a blow on our target is intercepted (a Spiritmaster's
                // pet, AttackComponent.cs:1492-1498), the attacker's copy names our target but carries the
                // interceptor's health (WeaponAction.cs:363-369), 0 when the blow killed it.
                const selfId = this.self.objectId;
                const defender = this.npcs.get(d.defenderId) ?? (d.attackerId !== selfId ? this.players.get(d.defenderId) : undefined);
                if (defender && d.targetHealthPercent <= 100) defender.healthPercent = d.targetHealthPercent;
                if (d.attackerId === selfId || d.defenderId === selfId) this.self.lastCombatAt = now;
                if (d.defenderId === selfId && d.attackerId) {
                    const att = this.npcs.get(d.attackerId);
                    if (att) att.targetId = selfId;
                }
                return true;
            }
            case ServerOp.SpellCastAnimation: {
                const d = decodeSpellCastAnimation(p);
                this.pushCombat({ kind: 'spellCast', attackerObjectId: d.casterId, targetObjectId: null, castTimeMs: d.castTimeMs, effectId: d.effect });
                return true;
            }
            case ServerOp.SpellEffectAnimation: {
                const d = decodeSpellEffect(p);
                this.pushCombat({ kind: 'spellEffect', attackerObjectId: d.casterId || null, targetObjectId: d.targetId || null, effectId: d.effect });
                if (d.targetId === this.self.objectId || d.casterId === this.self.objectId) this.self.lastCombatAt = now;
                return true;
            }
            case ServerOp.InterruptSpellCast: {
                const d = decodeInterrupt(p);
                this.pushCombat({ kind: 'interrupt', attackerObjectId: d.objectId, targetObjectId: null });
                return true;
            }
            case ServerOp.PlayerDeath: {
                const d = decodePlayerDeath(p);
                this.pushCombat({ kind: 'death', attackerObjectId: d.killerId || null, targetObjectId: d.victimId });
                if (d.victimId === this.self.objectId) this.markSelfDead(now);
                const pl = this.players.get(d.victimId);
                if (pl) {
                    if (!pl.isDead) pl.diedAt = now;
                    pl.isDead = true;
                    pl.healthPercent = 0;
                }
                return true;
            }
            case ServerOp.PlayerRevive: {
                const d = decodeRevive(p);
                if (d.objectId === this.self.objectId) {
                    this.self.isDead = false;
                    this.signal('revived');
                }
                const pl = this.players.get(d.objectId);
                if (pl) {
                    pl.isDead = false;
                    pl.diedAt = 0;
                }
                return true;
            }
            case ServerOp.AttackMode: {
                const on = decodeAttackMode(p).on;
                if (on !== this.self.attacking) {
                    this.self.attacking = on;
                    this.signal(on ? 'attackOn' : 'attackOff');
                }
                if (on) this.self.lastCombatAt = now;
                return true;
            }
            case ServerOp.ChangeTarget: {
                this.setSelfTarget(decodeChangeTarget(p).objectId);
                this.signal('target');
                return true;
            }
            case ServerOp.DisableSkills: {
                const d = decodeDisableSkills(p);
                if (d.kind === 'skills') {
                    for (const e of d.entries) this.setCooldown(`S:${e.skillIndex}`, e.seconds, now);
                } else if (d.kind === 'spells') {
                    for (const e of d.entries) this.setCooldown(`L:${e.lineIndex}:${e.spellIndex}`, d.seconds, now);
                }
                return true;
            }
            case ServerOp.UpdateIcons: {
                const d = decodeUpdateIcons(p);
                for (const e of d.entries) {
                    if (e.removed) this.effects.delete(e.index);
                    else this.effects.set(e.index, {
                        index: e.index, name: e.name, icon: e.icon, spellId: e.tooltipId,
                        remainingSeconds: e.remainingSeconds, isNegative: e.isNegative, receivedAt: now,
                    });
                }
                return true;
            }
            case ServerOp.ConcentrationList: {
                this.concentrationEffects = decodeConcentrationList(p).entries;
                return true;
            }
            case ServerOp.ChangeGroundTarget: {
                const d = decodeChangeGroundTarget(p);
                this.groundTarget = d.x === 0 && d.y === 0 ? null : d;
                return true;
            }
            case ServerOp.Time: {
                this.gameTime = decodeTime(p).gameTime;
                return true;
            }
            // Handled by the session (login / world entry / LoS / quit) or intentionally ignored.
            case ServerOp.CryptKey:
            case ServerOp.LoginGranted:
            case ServerOp.LoginDenied:
            case ServerOp.SessionID:
            case ServerOp.PingReply:
            case ServerOp.CharacterOverview1126:
            case ServerOp.Realm:
            case ServerOp.DupNameCheckReply:
            case ServerOp.PositionAndObjectID:
            case ServerOp.CharacterJump:
            case ServerOp.GameOpenReply:
            case ServerOp.CharacterInitFinished:
            case ServerOp.RegionChanged:
            case ServerOp.ClientRegion:
            case ServerOp.CheckLOSRequest:
            case ServerOp.Quit:
            case ServerOp.UDPInitReply:
            case ServerOp.EquipmentUpdate:
            case ServerOp.ObjectGuildID:
            case ServerOp.QuestEntry:
            case ServerOp.DebugMode:
                return true;
            default:
                return IGNORED_OPCODES.has(code);
        }
    }

    private applyVarious(p: Uint8Array): boolean {
        const d = decodeVariousUpdate(p);
        if (d.sub === 0x01 && 'entries' in d) {
            if (d.firstIndex === 0) this.usableSkills = [];
            d.entries.forEach((e, i) => {
                this.usableSkills[d.firstIndex + i] = e;
            });
            return true;
        }
        if (d.sub === 0x02 && 'footer' in d) {
            // SendNonHybridSpellLines (PacketLib1112.cs:189-260) sends lines 0..n-1 then the 02 00 63 00 footer,
            // so the footer marks the end of a complete list (possibly empty: footer only).
            if (d.footer) {
                for (const idx of [...this.spellLines.keys()]) if (idx >= this.spellLinesSinceFooter) this.spellLines.delete(idx);
                this.spellLinesSinceFooter = 0;
                return true;
            }
            if (d.lineIndex === 0) this.spellLines.clear();
            this.spellLines.set(d.lineIndex, d);
            this.spellLinesSinceFooter = Math.max(this.spellLinesSinceFooter, d.lineIndex + 1);
            return true;
        }
        if (d.sub === 0x03 && 'raceName' in d) {
            const s = this.self;
            s.level = d.level;
            if (d.name) s.name = d.name;
            s.className = d.className || s.className;
            s.raceName = d.raceName || s.raceName;
            s.guildName = d.guildName;
            s.lastName = d.lastName;
            s.realmSpecPoints = d.realmSpecPoints;
            return true;
        }
        if (d.sub === 0x06 && 'members' in d) {
            const old = new Map(this.group.map(m => [m.name, m]));
            this.group = d.members.map(m => {
                const prev = old.get(m.name);
                return {
                    name: m.name, className: m.className, level: m.level, objectId: m.objectId,
                    healthPercent: prev?.healthPercent ?? 100, manaPercent: prev?.manaPercent ?? 100,
                    endurancePercent: prev?.endurancePercent ?? 100, isDead: prev?.isDead ?? false,
                    inOtherRegion: prev?.inOtherRegion ?? false,
                };
            });
            this.signal('group');
            return true;
        }
        return true;
    }

    private applyMessage(p: Uint8Array, now: number): void {
        const d = decodeMessage(p);
        const type = chatTypeName(d.rawType);
        const speech = parseSpeech(d.text);
        const msg: GameMessage = {
            id: nextMessageId++, type, rawType: d.rawType, text: d.text,
            sender: speech?.sender ?? null, popup: d.popup, receivedAt: now,
        };
        this.messages.push(msg);
        if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);

        // NPC dialog: GameNPC.SayTo sends CT_System with the '##' popup prefix (GameNPC.cs:2579-2601),
        // or CT_Say in the chat window. Accept either when the sender is a known NPC.
        if (speech) {
            const npc = this.findNpcByName(speech.sender);
            if (d.popup || (npc && (d.rawType === 0x01 || d.rawType === 0x12))) {
                this.npcDialog = {
                    npcObjectId: npc?.objectId ?? null, npcName: speech.sender, text: speech.body,
                    keywords: extractKeywords(speech.body), receivedAt: now,
                };
                this.signal('npcDialog');
            }
        } else if (d.popup) {
            this.npcDialog = { npcObjectId: this.self.targetObjectId, npcName: null, text: d.text, keywords: extractKeywords(d.text), receivedAt: now };
            this.signal('npcDialog');
        }
        if (type === 'yourDeath') this.signal('yourDeath');
    }

    findNpcByName(name: string): NpcEntry | undefined {
        const lower = name.toLowerCase().replace(/^the /, '');
        const target = this.self.targetObjectId !== null ? this.npcs.get(this.self.targetObjectId) : undefined;
        if (target && target.name.toLowerCase() === lower) return target;
        for (const n of this.npcs.values()) if (n.name.toLowerCase() === lower) return n;
        return undefined;
    }

    private markSelfDead(now: number): void {
        if (this.self.isDead) return;
        this.self.isDead = true;
        this.self.deathCount++;
        this.self.lastDeathAt = now;
        this.self.attacking = false;
        // GamePlayer.Die clears the target server-side (TargetObject = null, GamePlayer.cs:5743 and :5900)
        // without telling the client, so drop ours too.
        this.self.targetObjectId = null;
        this.hooks.onSelfDeath?.();
        this.signal('died');
    }

    /**
     * Another player's health from its relayed position or heading (GetHealthByte,
     * PlayerPositionUpdateHandler.cs:607), and whether it is dead. A death is sticky: health is
     * truncated (GameLiving.cs:2621), so a living player with a few hit points reads 0 %, and only
     * health again shows a revive, since 0x89 PlayerRevive goes to the revived player alone
     * (GamePlayer.cs:1688/1809, ResurrectSpellHandler.cs:179). `deadFlag` is the DEAD state the
     * player's own client sends; the server only strips it from the living (:640-643), so it holds,
     * except that a relay can still carry it just after a revive: at 0 % only.
     */
    private relayedHealth(pl: PlayerEntry, healthPercent: number, deadFlag: boolean, now: number): void {
        pl.healthPercent = healthPercent;
        if (deadFlag && healthPercent === 0) {
            if (!pl.isDead) pl.diedAt = now;
            pl.isDead = true;
        } else if (pl.isDead && healthPercent > 0 && now - pl.diedAt >= REVIVE_SETTLE_MS) {
            pl.isDead = false;
            pl.diedAt = 0;
        }
    }

    private setCooldown(key: string, seconds: number, now: number): void {
        if (seconds <= 0) this.cooldowns.delete(key);
        else this.cooldowns.set(key, now + seconds * 1000);
    }

    private pushCombat(e: Omit<CombatEvent, 'id' | 'receivedAt'>): void {
        this.combatEvents.push({ ...e, id: this.nextCombatId++, receivedAt: this.now() });
        if (this.combatEvents.length > MAX_COMBAT_EVENTS) this.combatEvents.splice(0, this.combatEvents.length - MAX_COMBAT_EVENTS);
    }

    removeObject(oid: number): void {
        this.npcs.delete(oid);
        this.objects.delete(oid);
        const pl = this.players.get(oid);
        if (pl) {
            this.players.delete(oid);
            if (this.sessionToOid.get(pl.sessionId) === oid) this.sessionToOid.delete(pl.sessionId);
        }
        if (this.self.targetObjectId === oid) this.self.targetObjectId = null;
    }

    /** Close the trainer window once we are further than TRAINER_WINDOW_RANGE from where it arrived. */
    private cullTrainer(pos: PositionRef): void {
        if (!this.trainer.isOpen) return;
        if (!this.trainerAnchor) this.trainerAnchor = { x: pos.x, y: pos.y, z: pos.z };
        if (dist2(pos, this.trainerAnchor) > TRAINER_WINDOW_RANGE) this.closeTrainer();
    }

    /** Drop objects that are out of range or have gone quiet (the server sends no remove packet when they leave view). */
    cull(pos: PositionRef): void {
        const now = this.now();
        for (const [oid, n] of this.npcs) {
            if (now - n.lastUpdate > NPC_STALE_MS || dist2(pos, this.npcPosition(n, now)) > VISIBILITY_DISTANCE) this.npcs.delete(oid);
        }
        for (const [oid, o] of this.objects) {
            if (now - o.lastUpdate > OBJECT_STALE_MS || dist2(pos, o) > VISIBILITY_DISTANCE) this.objects.delete(oid);
        }
        // A dead player gone quiet released: the release moves it within the region (GamePlayer.MoveTo,
        // same region) and its corpse would otherwise stay here, dead, as long as we stand near it.
        for (const [oid, pl] of this.players) {
            const quiet = now - pl.lastUpdate > PLAYER_STALE_MS;
            if (dist2(pos, pl) > VISIBILITY_DISTANCE || (quiet && (pl.speed > 0 || pl.isDead))) this.removeObject(oid);
        }
        this.cullTrainer(pos);
    }

    /** Extrapolated NPC position: moving NPCs head toward their 0xA1 destination at `speed`. */
    npcPosition(n: NpcEntry, now = this.now()): Vec3 {
        if (!n.dest || n.speed <= 0) return { x: n.x, y: n.y, z: n.z };
        const total = Math.hypot(n.dest.x - n.x, n.dest.y - n.y);
        if (total < 1) return { ...n.dest };
        const travelled = Math.min(total, (n.speed * (now - n.lastUpdate)) / 1000);
        const f = travelled / total;
        return { x: n.x + (n.dest.x - n.x) * f, y: n.y + (n.dest.y - n.y) * f, z: n.z + (n.dest.z - n.z) * f };
    }

    /** Position of any known object (NPC extrapolated). */
    positionOf(oid: number): Vec3 | null {
        const n = this.npcs.get(oid);
        if (n) return this.npcPosition(n);
        const pl = this.players.get(oid);
        if (pl) return { x: pl.x, y: pl.y, z: pl.z };
        const o = this.objects.get(oid);
        if (o) return { x: o.x, y: o.y, z: o.z };
        return null;
    }

    hasObject(oid: number): boolean {
        return this.npcs.has(oid) || this.players.has(oid) || this.objects.has(oid);
    }

    inCombat(): boolean {
        if (this.self.attacking) return true;
        if (this.now() - this.self.lastCombatAt < 8000) return true;
        for (const n of this.npcs.values()) if (n.targetId === this.self.objectId && n.targetId !== 0) return true;
        return false;
    }

    // ── Snapshot builders ──────────────────────────────────────────────────

    nearbyNpcs(pos: PositionRef): NearbyNpc[] {
        const now = this.now();
        const out: NearbyNpc[] = [];
        for (const n of this.npcs.values()) {
            const p = this.npcPosition(n, now);
            out.push({
                kind: 'npc', objectId: n.objectId, name: n.name, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z),
                heading: n.heading, distance: Math.round(dist3(pos, p)), distance2d: Math.round(dist2(pos, p)),
                lastSeenAgo: now - n.lastUpdate, guildName: n.guildName, level: n.level, model: n.model,
                realm: realmName(n.realm), healthPercent: n.healthPercent, speed: n.speed,
                targetObjectId: n.targetId && n.targetId !== 0xFFFF ? n.targetId : null,
                inCombat: n.targetId !== 0, isPeaceful: n.isPeaceful, isTargetable: n.isTargetable,
                hasQuest: n.hasQuest, isPet: n.isPet, role: guessNpcRole(n.name, n.guildName),
            });
        }
        return out.sort((a, b) => a.distance - b.distance);
    }

    nearbyPlayers(pos: PositionRef): NearbyPlayer[] {
        const now = this.now();
        const out: NearbyPlayer[] = [];
        for (const pl of this.players.values()) {
            out.push({
                kind: 'player', objectId: pl.objectId, name: pl.name, x: Math.round(pl.x), y: Math.round(pl.y), z: Math.round(pl.z),
                heading: pl.heading, distance: Math.round(dist3(pos, pl)), distance2d: Math.round(dist2(pos, pl)),
                lastSeenAgo: now - pl.lastUpdate, sessionId: pl.sessionId, guildName: pl.guildName, lastName: pl.lastName,
                level: pl.level, realm: realmName(pl.realm), healthPercent: pl.healthPercent, isDead: pl.isDead,
                isSitting: pl.isSitting, inCombat: pl.inCombat,
            });
        }
        return out.sort((a, b) => a.distance - b.distance);
    }

    nearbyObjects(pos: PositionRef): NearbyObject[] {
        const now = this.now();
        const out: NearbyObject[] = [];
        for (const o of this.objects.values()) {
            out.push({
                kind: 'object', objectId: o.objectId, name: o.name, x: o.x, y: o.y, z: o.z, heading: o.heading,
                distance: Math.round(dist3(pos, o)), distance2d: Math.round(dist2(pos, o)), lastSeenAgo: now - o.lastUpdate,
                model: o.model, realm: realmName(o.realm), doorId: o.doorId, isLoot: o.isLoot, ownedByUs: o.ownedByUs,
            });
        }
        return out.sort((a, b) => a.distance - b.distance);
    }

    inventoryList(min: number, max: number): InventoryItem[] {
        return [...this.items.values()].filter(i => i.slot >= min && i.slot <= max).sort((a, b) => a.slot - b.slot);
    }

    specCount(): number {
        let n = 0;
        while (n < this.usableSkills.length && this.usableSkills[n]?.skillType === 0) n++;
        return n;
    }

    skills(): SkillsState {
        const now = this.now();
        const specializations: Specialization[] = [];
        const abilities: Ability[] = [];
        const styles: Style[] = [];
        const spells: Spell[] = [];
        const specCount = this.specCount();
        const cd = (key: string): number => {
            const until = this.cooldowns.get(key);
            return until && until > now ? Math.ceil((until - now) / 1000) : 0;
        };
        this.usableSkills.forEach((e, i) => {
            if (!e) return;
            const skillIndex = i - specCount;
            switch (e.skillType) {
                case 0:
                    // e.bonus is the modified spec level minus the trained one (PacketLib1112.cs:70).
                    specializations.push({ name: e.name, level: e.level, internalId: e.internalId, bonus: e.bonus });
                    break;
                case 2:
                    // e.bonus is GlobalConstants.GetSpecToInternalIndex(style.Spec) (PacketLib1112.cs:150), a fixed table.
                    styles.push({ name: e.name, internalId: e.internalId, specLevel: e.level, specName: SPEC_BY_INTERNAL_INDEX[e.bonus] ?? null, skillIndex, prerequisite: e.special, ...this.styleDetails(e.internalId) });
                    break;
                case 3:
                case 4: {
                    const spec = e.special < specializations.length ? specializations[e.special] : undefined;
                    spells.push({
                        name: e.name, level: e.level, internalId: e.internalId, lineName: spec?.name ?? '',
                        lineIndex: -1, spellIndex: -1, cooldownRemaining: cd(`S:${skillIndex}`), skillIndex, ...this.spellDetails(e.internalId),
                    });
                    break;
                }
                default: {
                    const details = this.delves.get(`Ability:${e.internalId}`) ?? this.delves.get(`RealmAbility:${e.internalId}`);
                    abilities.push({ name: e.name, level: e.level, internalId: e.internalId, skillIndex, ...(details && { details }) });
                }
            }
        });
        for (const line of [...this.spellLines.values()].sort((a, b) => a.lineIndex - b.lineIndex)) {
            line.spells.forEach((s, spellIndex) => {
                if (s.kind !== 'spell') return;
                spells.push({
                    name: s.name, level: s.level, internalId: s.internalId, lineName: line.lineName,
                    lineIndex: line.lineIndex, spellIndex, cooldownRemaining: cd(`L:${line.lineIndex}:${spellIndex}`), ...this.spellDetails(s.internalId),
                });
            });
        }
        return { specializations, abilities, styles, spells };
    }

    private spellDetails(internalId: number): { details?: SpellDetails } {
        const fields = this.delves.get(`Spell:${internalId}`);
        return fields ? { details: toSpellDetails(fields) } : {};
    }

    private styleDetails(internalId: number): { details?: StyleDetails } {
        const fields = this.delves.get(`Style:${internalId}`);
        if (!fields) return {};
        const details = toStyleDetails(fields);
        const proc = details.procSpellId !== null ? this.spellDetails(details.procSpellId).details : undefined;
        return { details: proc ? { ...details, procSpell: proc } : details };
    }

    effectList(): Effect[] {
        const now = this.now();
        return [...this.effects.values()]
            .sort((a, b) => a.index - b.index)
            .map(({ receivedAt, ...e }) => ({ ...e, remainingSeconds: e.remainingSeconds > 0 ? Math.max(0, e.remainingSeconds - Math.floor((now - receivedAt) / 1000)) : 0 }));
    }

    realm(): Realm {
        return realmName(this.self.realm);
    }
}

function toInventoryItem(slot: number, d: ItemData): InventoryItem {
    return {
        slot, name: d.name, level: d.level, count: d.count, model: d.model, objectType: d.objectType,
        condition: d.condition, durability: d.durability, quality: d.quality, weight: d.weight,
        value1: d.value1, value2: d.value2,
    };
}
