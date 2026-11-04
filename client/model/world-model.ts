// WorldModel: applies decoded server packets to an in-memory picture of the
// world, and builds the BotWorldState pieces from it. It does not own our
// position (the Mover does); callers pass it in when building snapshots.

import type {
    Ability, CombatEvent, DialogBox, Effect, GameMessage, GroupMember, InventoryItem, MerchantItem,
    MerchantState, Money, NearbyNpc, NearbyObject, NearbyPlayer, NpcDialog, PetAggression, PetLoss, PetLossCause,
    PetState, PetWalk, Realm, SkillsState,
    Specialization, Spell, SpellDetails, Stats, Style, StyleDetails, TextWindow, TradeWindow, TrainerState, Vec3,
} from '../../sdk/types';
import { getZone } from '../../data/zones';
import { mobRunInMs } from '../../sdk/mob-speed';
import { ServerOp } from '../protocol/opcodes';
import { chatTypeName, decodeDialog, decodeMessage, decodeTextWindow, extractKeywords, parseSpeech } from '../protocol/incoming/chat';
import {
    decodeAttackMode, decodeChangeGroundTarget, decodeChangeTarget, decodeCombatAnimation, decodeConcentrationList, decodeDisableSkills,
    decodeInterrupt, decodePlayerDeath, decodeRevive, decodeSpellCastAnimation, decodeSpellEffect, decodeUpdateIcons,
    type ConcentrationEntry,
} from '../protocol/incoming/combat';
import {
    decodeModelChange, decodeNpcCreate, decodeObjectCreate, decodeObjectDelete, decodeObjectUpdate, decodePlayerCreate,
    decodePlayerHeading, decodePlayerPosition, decodeRemoveObject, decodeObjectDataUpdate,
} from '../protocol/incoming/objects';
import {
    decodeDelveInfo, decodeInventoryUpdate, decodeMoney, decodePointsUpdate, decodeStatsUpdate, decodeStatusUpdate, decodeVariousUpdate,
    toSpellDetails, toStyleDetails, type ItemData, type SpellLinePage, type UsableSkillEntry,
} from '../protocol/incoming/player';
import { decodeEncumbrance, decodeMaxSpeed, decodeTime } from '../protocol/incoming/world';
import { decodeGroupMemberUpdate, decodeMerchantWindow, decodePetWindow, decodeTradeWindow, decodeTrainerWindow } from '../protocol/incoming/windows';
import { realmName } from './classes';
import { isCharmEffect, isMinionEffect, isPulsingCharmEffect, isSummonEffect } from './spell-effects';

/** (ushort)1000000: the server's 'no concentration' MaxConcentration. */
const NO_CONCENTRATION_U16 = 1_000_000 & 0xffff;
/** Process-wide, so ids stay monotonic across re-logins (a new WorldModel per session). */
let nextMessageId = 1;
/** Process-wide too: a window closed and reopened between two snapshots still reads as a new one. */
let nextTradeId = 1;
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

/** Copper as 0xDD money drops, [client slot, amount] per nonzero coin: 500 mithril .. 504 copper (IGameInventory.cs:95-99, PlayerMoveItemRequestHandler.cs:234-242). */
export function coinDrops(copper: number): Array<[slot: number, amount: number]> {
    const amounts = [
        Math.floor(copper / COPPER_PER.mithril),
        Math.floor((copper % COPPER_PER.mithril) / COPPER_PER.platinum),
        Math.floor((copper % COPPER_PER.platinum) / COPPER_PER.gold),
        Math.floor((copper % COPPER_PER.gold) / COPPER_PER.silver),
        copper % COPPER_PER.silver,
    ];
    const drops: Array<[number, number]> = [];
    amounts.forEach((amount, i) => {
        if (amount > 0) drops.push([500 + i, amount]);
    });
    return drops;
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
    0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x86, 0x8D, 0x92, 0x99,
    0x9E, 0xC3, 0xC5, 0xC6, 0xC8, 0xC9, 0xD1, 0xD3, 0xE2, 0xE3, 0xEF, 0xF0, 0xF3, 0xF5, 0xF7, 0xF9,
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
    /** When targetId was last named: by 0xA1, by a swing or a cast on us, our pet or a summon, or by a lost pet's mobs being handed to us. */
    targetAt: number;
    /** When a 0x1B by it last named targetId, or a 0x72 by it began with one on us or a pet of ours: a caster reads 0 in 0xA1 between casts (PacketLib168.cs:820). */
    castAt: number;
    /** A mob handed to us at the loss of a pet: until when its run at us lasts, reading 0xFFFF all the way. Over at its next real id or 0. */
    chaseUntil: number;
    /** When that run began, and how far off it read last: it goes on as long as it comes nearer. */
    chaseFrom: number;
    chaseDist: number;
    /** The id on our side a 0 last cleared, for a 0x72 that comes after it: 0 with none. A real id since says it has gone on. */
    clearedId: number;
    /** When that id was last good: its naming, or the 0 itself if that came in a run held for us. */
    clearedAt: number;
    isPeaceful: boolean;
    isTargetable: boolean;
    hasQuest: boolean;
    isPet: boolean;
    /** When this entry first appeared; a 0xDA for an entry we still hold keeps it. */
    firstSeenAt: number;
    lastUpdate: number;
}

export interface PlayerEntry {
    objectId: number;
    sessionId: number;
    name: string;
    guildName: string;
    lastName: string;
    level: number;
    /** From its create, then 0xDB. */
    model: number;
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
    statsWithoutItems: Stats | null;
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

/** What we remember of a pet of ours with no window. */
export interface SummonEntry {
    /** The 0x1B that made it one: the spell's ClientEffect. */
    effect: number;
    /** Its name then: a 0xDA with another one under this id is somebody else (Region.cs:955, :779). */
    name: string;
    /** When we last held an entry for it, as of the last cull. */
    lastSeenAt: number;
    /** When that 0x1B came. */
    since: number;
}

export interface ModelHooks {
    /** A relayed 0xA9/0xBA named a session we have no 0x4B for. */
    onUnknownSession?(sessionId: number): void;
    /** We died (0xAE with victim = us). */
    onSelfDeath?(): void;
    /** A significant change (death, dialog, merchant, target, combat start/stop...). */
    onSignificant?(reason: string): void;
    /** Where we stand: the mover has it, and the model has no position of its own. */
    selfPosition?(): PositionRef;
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
        specPoints: 0, realmSpecPoints: 0, money: emptyMoney(), stats: null, statsWithoutItems: null, constitutionLost: 0, encumbrance: null,
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
/** The pet window's aggro and walk bytes (PacketLib181.cs:120-149), not the server's enums: those run Follow, Stay, ComeHere, GoTarget from 0. */
const PET_AGGRESSION: Record<number, PetAggression> = { 1: 'aggressive', 2: 'defensive', 3: 'passive' };
const PET_WALK: Record<number, PetWalk> = { 1: 'follow', 2: 'stay', 3: 'goTarget', 4: 'comeHere' };
/** What 0xA1 writes for a target it won't name: attacking, but moving or out of reach (PacketLib168.cs:820-828). */
const TARGET_UNNAMED = 0xFFFF;
/** How long the pet's last aim outlives an 0xA1 reading 0, which a caster pet sends between casts (PacketLib168.cs:820): longer than any pet cast (3.1-3.5 s) and its first swing. A caster mob's target on us or a pet of ours holds as long. */
const PET_AIM_HOLD_MS = 6000;
/** How long a mob on the move (0xFFFF) still counts as on us, our pet or a summon, after it was last named or swung. */
const MOB_CHASE_HOLD_MS = 5000;
/**
 * The most a mob handed to us gets to come: mobRunInMs, and at least MOB_CHASE_HOLD_MS, going on while its 0xA1 reads 0xFFFF, it moves and it comes nearer (PacketLib168.cs:820-828). A pet fights up to 2000 from us
 * (GamePlayer.cs:12185), about 13 s at full health, and a mob at 10 % or under a snare takes well over that. A 0 or a real id ends it at once, so this only bounds a wrong guess.
 */
const MOB_RUN_MAX_MS = 30_000;
/** The result byte of a spell's damage in 0xBC (SpellHandler.cs:3092): a swing's is 0-4, 10 or 11 (WeaponAction.cs:280-330). Its weapon and style are 0, as an unarmed mob's are. */
const SPELL_DAMAGE_RESULT = 0x14;
/** A summon's 0x1B follows its 0xDA at once (GameNPC.cs:1983, SummonSpellHandler.cs:176, :183); a pet of ours seen longer ago is a buff's target, not a new summon. */
const SUMMON_FRESH_MS = 2000;
/** How long a new summon counts as in a fight with nothing to show for it: a caster in range reads target 0 (PacketLib168.cs:820) until its first cast lands, about 3 s in. */
const SUMMON_FIGHT_MS = 3500;
/**
 * A summon with no entry for this long has ended, as far as we can tell: one that ends beyond VISIBILITY_DISTANCE leaves no 0xA2 (WorldMgr.cs:60). One of ours coming back
 * after that reads as a stranger's, a smaller harm than a stranger's pet under a reused id (Region.cs:955, :779) reading as ours. Not a minion while its window is open:
 * it can't outlive its commander, whose close drops it, and out of `summons` nothing could address it while the server still counts it.
 */
const SUMMON_ABSENT_MS = 30_000;
/** How long an id stays dead after its 0xA2 type 0 or 0xAE, and a lost pet's after the loss: an 0xA1 built before that lands after it, that queue being drained after TCP (PacketProcessor.cs:273-274). */
const DEAD_ID_MS = 2000;
/** A mob this close to another pet of ours isn't handed to us when the one it was on is lost: it may just stay on that one. */
const OTHER_PET_NEAR = 600;
/** How long the id an attack order named waits for the order's answer. */
const PET_ORDER_MS = 3000;
/** ShadeECSGameEffect's icon, 0x193 (ShadeECSEffect.cs:8). Stealth has the same one, and so does a Theurgist's haste (StealthECSEffect.cs:14, spell 403 in spell.sql): only the shade is negative (ShadeECSEffect.cs:10). */
const SHADE_ICON = 403;
/** Another player's sign of a shade: a Disciple's ShadeModel (GamePlayer.cs:12345-12346), set as the effect starts and put back as it ends (ShadeECSEffect.cs:25-26, :37-38). */
const SHADE_MODEL = 822;
/** The answers to our orders (GamePlayer.cs:12193, :12207, :12223, :12239, :12269). Follow, stay, come here and go to target all disengage it. */
const PET_ATTACK_ANSWER = /^You command .+ to kill your target!$/;
const PET_DISENGAGE_ANSWER = /^You command .+ to (?:follow you!|stay in this position!|come to you\.|go to your target\.)$/;

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
    /** Replaced per 0xEA, never mutated: snapshots share it. */
    trade: TradeWindow | null = null;
    /**
     * Our pet's window (0x88). Replaced per change, never mutated: snapshots share it. Independent of its NPC entry,
     * which can go while the window stays: a jump (0xA2 type 1), silence or range (cull).
     */
    pet: PetState | null = null;
    lastPetLoss: PetLoss | null = null;
    /** Its last known health, for a fresh 0xDA: that has no health (PacketLib1124.cs:148-278). */
    private petHealth = 100;
    /** When something last named who it is fighting. */
    private petAimAt = 0;
    /** Who our last attack order named, until its answer line or PET_ORDER_MS. */
    private petOrder: { objectId: number; at: number } | null = null;
    /**
     * Our own pets with no window: a Theurgist's, a fire-and-forget turret, a bomber, a Bonedancer's minion. They outlive
     * a cull and a jump, and maybe our death (FnFs were seen to). Only the 0x1B of the summon tells them from anyone's.
     */
    summons = new Map<number, SummonEntry>();
    /** Ids gone by 0xA2 type 0 or 0xAE, and when: for DEAD_ID_MS an 0xA1 naming one is older than the death. */
    private deadIds = new Map<number, number>();
    /** Ids of pets we lost, and when: for DEAD_ID_MS an 0xA1 naming one is older than the loss. A released charm stays in the world, so it never gets into deadIds. */
    private lostPetIds = new Map<number, number>();
    /** The mob our last charm's 0x1B named, when that charm pulses: no packet names the song otherwise, and a pulse has no icon on us (PacketLib1110.cs:68). */
    private charmSongOn: number | null = null;
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
        // Leaving the region releases the pet (GamePlayer.cs:7886-7887); its close comes around or after 0xB7, a no-op then.
        this.losePet('region_change');
        this.summons.clear();
        this.deadIds.clear();
        this.lostPetIds.clear();
        this.charmSongOn = null;
        this.petOrder = null;
        this.npcs.clear();
        this.players.clear();
        this.sessionToOid.clear();
        this.objects.clear();
        this.trade = null;
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

    /** The window is gone, for this cause. A later close or 0xA2 finds none, and stays a no-op. */
    private losePet(cause: PetLossCause): void {
        const pet = this.pet;
        if (!pet) return;
        const now = this.now();
        // Before the hand-over below, which rewrites them: this is all that will say what had engaged it.
        const targetedBy = [...this.npcs.values()].filter(n => n.targetId === pet.objectId).map(n => n.objectId);
        this.lastPetLoss = { objectId: pet.objectId, name: this.npcs.get(pet.objectId)?.name ?? pet.name ?? null, cause, at: now, ...(targetedBy.length > 0 && { targetedBy }), ...(pet.targetObjectId !== null && { targetObjectId: pet.targetObjectId }) };
        this.pet = null;
        // Its fight is over. A charm stays in the world as a mob, its attack stopped (CharmECSEffect.cs:64), and its next 0xA1 of its new realm can be 3 s off.
        const entry = this.npcs.get(pet.objectId);
        if (entry) {
            entry.targetId = 0;
            // A pulsing charm's ex-pet the server sends straight at a caster alive and here (CharmECSEffect.cs:75-82), and it reads 0xFFFF all the way: no guess, so a group changes nothing.
            if (this.charmSongOn === pet.objectId && !this.self.isDead && cause !== 'owner_died' && cause !== 'region_change') this.comesForUs(entry, now);
        }
        // A minion goes with its commander (SummonCommanderPet.cs:25-38), and its 0xA2 only reaches those in view of it.
        const gone = [pet.objectId];
        for (const [id, summon] of this.summons) {
            if (!isMinionEffect(summon.effect)) continue;
            this.summons.delete(id);
            gone.push(id);
        }
        for (const id of gone) this.notePetLost(id);
        if (cause !== 'region_change' && cause !== 'owner_died') for (const id of gone) this.handOverMobs(id, false, id === pet.objectId ? pet.targetObjectId : null);
        this.signal('pet');
    }

    /** A summon has gone, by its 0xA2 or its id going to something else. Not for one that is just long out of view: nothing says it has ended, or that the mobs on it are done with it. */
    private loseSummon(objectId: number): void {
        const summon = this.summons.get(objectId);
        if (!summon) return;
        this.summons.delete(objectId);
        this.notePetLost(objectId);
        // A minion's Owner is its commander, who has the threat of its hits (SummonMinionHandler.cs:147-149, StandardMob/StandardMobBrain.cs:569-570).
        this.handOverMobs(objectId, isMinionEffect(summon.effect) && this.pet !== null);
    }

    /**
     * A pet of ours is gone, and the mobs on it turn on us: the server re-aims them (StandardMob/StandardMobBrain.cs:569, CharmECSEffect.cs:87-95), and on their
     * way they name nobody, for as long as their run takes (PacketLib168.cs:820-828). Naming us here, chaseUntil keeps that through the 0xFFFF, and an 0xA1
     * reading 0 clears it as any other. A window pet's own target goes too, on its first run-in at the pet and so never named: `petTarget`, if it is hurt, or runs in reading 0xFFFF. A 0 at full health is no attack whether it moves or not: a roam or a walk home (PacketLib168.cs:820-828, StandardMobState.cs:155-178). Nothing to hand over to when we lie dead. The server goes by threat, which the model can't see (StandardMob/StandardMobBrain.cs:1363-1400), so where a mob
     * has another to turn to its next 0xA1 or 0xBC decides, and until then it reads as on nobody: beside another pet of ours, under a commander, and in a group, where a groupmate can hold more
     * threat than the 30 % the owner gets (:569-570). A mob truly coming for us then reads so only as it arrives, as a first run-in does. That goes for a charm's end too, where the server names us first (CharmECSEffect.cs:87-95).
     * A mob on it at full health with no attack seen from it or from us has no aggro on us at all: only an attack tags the owner, a miss too (:566-571). It was body pulled, and goes home.
     */
    private handOverMobs(petId: number, toCommander = false, petTarget: number | null = null): void {
        if (this.self.isDead) return;
        const now = this.now();
        const elsewhere = toCommander || this.group.length > 1;
        const others: NpcEntry[] = [];
        for (const id of this.ownPetIds()) {
            const other = this.npcs.get(id);
            if (other) others.push(other);
        }
        for (const n of this.npcs.values()) {
            const named = n.targetId === petId;
            const unnamed = n.objectId === petTarget && (n.healthPercent < 100 ? n.targetId === 0 || n.targetId === TARGET_UNNAMED : n.targetId === TARGET_UNNAMED && n.speed > 0);
            if ((!named && !unnamed) || this.isFriendly(n.objectId)) continue;
            const at = this.npcPosition(n, now);
            if (elsewhere || others.some(o => dist2(at, this.npcPosition(o, now)) <= OTHER_PET_NEAR) || (named && n.healthPercent >= 100 && !this.attackedBy(n, petId))) {
                if (named) n.targetId = 0;
            } else {
                this.comesForUs(n, now);
            }
        }
    }

    /** Whether this pet or we have attacked this mob, hit or miss, as far as the events say: only since this entry appeared, as the server hands a dead mob's id on (Region.cs:955). */
    private attackedBy(n: NpcEntry, petId: number): boolean {
        return this.combatEvents.some(e => (e.kind === 'melee' || e.kind === 'spellEffect') && e.targetObjectId === n.objectId && (e.attackerObjectId === petId || e.attackerObjectId === this.self.objectId) && e.receivedAt >= n.firstSeenAt);
    }

    /** It is on its way to us: named, with a hold that fits its run, as every 0xA1 until it arrives reads 0xFFFF (PacketLib168.cs:820-828). */
    private comesForUs(n: NpcEntry, now: number): void {
        const me = this.hooks.selfPosition?.();
        n.targetId = this.self.objectId;
        n.targetAt = now;
        const distance = me ? dist2(this.npcPosition(n, now), me) : Infinity;
        const run = me ? mobRunInMs(distance, n.healthPercent) : 0;
        n.chaseFrom = now;
        n.chaseDist = distance;
        n.chaseUntil = now + Math.min(MOB_RUN_MAX_MS, Math.max(MOB_CHASE_HOLD_MS, run));
    }

    /** A reading of 0xFFFF on such a run: it goes on while the mob moves and comes nearer, however slowly, a snare's or a wound's. Its entry has this reading already. */
    private chaseGoesOn(n: NpcEntry, now: number): void {
        const me = this.hooks.selfPosition?.();
        if (!me) return;
        const distance = dist2(n, me);
        if (n.speed > 0 && distance < n.chaseDist) n.chaseUntil = Math.max(n.chaseUntil, Math.min(n.chaseFrom + MOB_RUN_MAX_MS, now + mobRunInMs(distance, n.healthPercent)));
        n.chaseDist = distance;
    }

    private setPetTarget(objectId: number | null): void {
        if (this.pet && this.pet.targetObjectId !== objectId) this.pet = { ...this.pet, targetObjectId: objectId };
    }

    /**
     * Called off. Its entry goes with it: the server broadcasts nothing at the end of a fight (AttackComponent.cs:737-785), so a pet that stands
     * still has no 0xA1 until the heartbeat, up to 5 s on (ClientService.cs:816-823), and would read as in a fight. One still on the mob is named again by its next swing or 0xA1.
     */
    private petOffTarget(): void {
        this.setPetTarget(null);
        const entry = this.pet && this.npcs.get(this.pet.objectId);
        if (entry) entry.targetId = 0;
    }

    /** It died: it is nobody's target any more, with the same silence as above, and the server gives its id to the next object it adds (Region.cs:955, :779). */
    private targetDied(objectId: number): void {
        const now = this.now();
        for (const [id, at] of this.deadIds) if (now - at > DEAD_ID_MS) this.deadIds.delete(id);
        this.deadIds.set(objectId, now);
        // Its entry too: one that last read 0xFFFF, on its way in, names nobody for the next line to find.
        if (objectId === this.pet?.targetObjectId) this.petOffTarget();
        for (const n of this.npcs.values()) if (n.targetId === objectId) n.targetId = 0;
    }

    /** Fresh evidence of who the pet is fighting: it holds through 0xA1's zeros for PET_AIM_HOLD_MS. */
    private aimPet(objectId: number, now: number): void {
        this.setPetTarget(objectId);
        this.petAimAt = now;
    }

    /** Gone by 0xA2 type 0 or 0xAE within DEAD_ID_MS, with no 0xDA under that id since. Not ourselves: our own 0xAE leaves us in the world. */
    diedRecently(objectId: number): boolean {
        const at = this.deadIds.get(objectId);
        return at !== undefined && this.now() - at <= DEAD_ID_MS;
    }

    private notePetLost(objectId: number): void {
        const now = this.now();
        for (const [id, at] of this.lostPetIds) if (now - at > DEAD_ID_MS) this.lostPetIds.delete(id);
        this.lostPetIds.set(objectId, now);
    }

    /** We ordered the pet onto this id: the order's answer names nobody, and our target can have moved on before it comes. */
    notePetAttack(objectId: number): void {
        this.petOrder = { objectId, at: this.now() };
    }

    /** Our window pet and the summons. */
    private ownPetIds(): number[] {
        return this.pet ? [this.pet.objectId, ...this.summons.keys()] : [...this.summons.keys()];
    }

    /** Summons of ours in their first moments. A minion has no fight to start in: it stands by its commander. */
    freshSummons(): number[] {
        const now = this.now();
        return [...this.summons].filter(([, s]) => now - s.since < SUMMON_FIGHT_MS && !isMinionEffect(s.effect)).map(([id]) => id);
    }

    /** Our window pet or a summon. */
    private isOwnPet(objectId: number): boolean {
        return objectId === this.pet?.objectId || this.summons.has(objectId);
    }

    /** Us, our window pet or a summon: who a mob's fight is our business for. */
    private isUsOrOwnPet(objectId: number): boolean {
        return objectId === this.self.objectId || this.isOwnPet(objectId);
    }

    /**
     * Our 0x1B with a summon's effect on a pet of our realm whose entry has only just appeared, and that isn't the window pet, is its summon
     * (effect = the spell's, proven live on Theurgist and Bonedancer). The window never lists these and no other packet tells them apart. The
     * effect is what tells them from a groupmate's fresh pet under our group heal or buff (HealSpellHandler.cs:58, SpellHandler.cs:1747-1850).
     */
    private noteSummon(targetId: number, effect: number, now: number): void {
        const npc = this.npcs.get(targetId);
        if (npc?.isPet && targetId !== this.pet?.objectId && this.isFriendly(targetId) && now - npc.firstSeenAt <= SUMMON_FRESH_MS && isSummonEffect(effect)) {
            this.summons.set(targetId, { effect, name: npc.name, lastSeenAt: now, since: now });
        }
    }

    /** One of our realm: our pet casts defensive spells on the group and its own minions too (ControlledMobBrain.cs:434-503), and can't attack these. Mobs are realm 0. */
    private isFriendly(objectId: number): boolean {
        const realm = (this.npcs.get(objectId) ?? this.players.get(objectId))?.realm;
        return realm !== undefined && realm !== 0 && realm === this.self.realm;
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
                if (d.objectId === this.pet?.objectId && this.pet.name !== d.name) this.pet = { ...this.pet, name: d.name };
                // Ids get reused at once (Region.cs:955, :779): no pet, or another name, is somebody else.
                const summon = this.summons.get(d.objectId);
                if (summon && (!d.isPet || d.name !== summon.name)) this.loseSummon(d.objectId);
                this.deadIds.delete(d.objectId);
                // A released charm's 0xDA has the name it had (CharmECSEffect.cs:104-113), with the 0xA1s built before it still to land. Anything else is the id handed on.
                if (prev?.name !== d.name) this.lostPetIds.delete(d.objectId);
                this.npcs.set(d.objectId, {
                    objectId: d.objectId, name: d.name, guildName: d.guildName, level: d.level, model: d.model,
                    realm: d.realm, x: d.x, y: d.y, z: d.z, heading: d.heading, speed: d.speed, dest: null,
                    // Our pet comes back with no prev after a same-region jump or a cull (GameNPC.cs:2024-2064), wounded as it was.
                    healthPercent: prev?.healthPercent ?? (d.objectId === this.pet?.objectId ? this.petHealth : 100), targetId: prev?.targetId ?? 0, targetAt: prev?.targetAt ?? 0, castAt: prev?.castAt ?? 0, chaseUntil: prev?.chaseUntil ?? 0,
                    chaseFrom: prev?.chaseFrom ?? 0, chaseDist: prev?.chaseDist ?? Infinity, clearedId: prev?.clearedId ?? 0, clearedAt: prev?.clearedAt ?? 0,
                    isPeaceful: d.isPeaceful, isTargetable: !d.cantTarget, hasQuest: d.questAvailable || d.questFinish,
                    isPet: d.isPet, firstSeenAt: prev?.firstSeenAt ?? now, lastUpdate: now,
                });
                return true;
            }
            case ServerOp.ObjectUpdate: {
                const d = decodeObjectUpdate(p);
                const npc = this.npcs.get(d.objectId);
                // Realm comes from 0xDA alone: every change sends one (GameNPC.cs:312-313, CharmECSEffect.cs:41, :104-113). Another realm here means an 0xA1 built before that 0xDA and landing after it
                // (PlayerTargetHandler.cs:56, PacketProcessor.cs:273-274): its target is as old as its realm, and names the fight of a pet that is one no more, or of a mob that wasn't one yet.
                const stale = npc !== undefined && d.realm !== npc.realm;
                // A dead id is older than the death (DEAD_ID_MS), a lost pet's than the loss. It reads 0: it would re-aim what targetDied cleared or undo a hand-over, and a hold would keep it there, under an id soon given to somebody else.
                const lostAt = this.lostPetIds.get(d.targetId);
                const late = this.diedRecently(d.targetId) || (lostAt !== undefined && now - lostAt <= DEAD_ID_MS);
                const targetId = late ? 0 : d.targetId;
                if (d.objectId === this.pet?.objectId) {
                    this.petHealth = d.healthPercent;
                    if (!stale) {
                        if (targetId === 0) {
                            if (now - this.petAimAt > PET_AIM_HOLD_MS) this.setPetTarget(null);
                        } else if (targetId !== TARGET_UNNAMED) {
                            this.aimPet(targetId, now);
                        } else if (this.pet.targetObjectId !== null) {
                            // On its way in: the first 0 at the stop counts from here, not from the order, for a run of any length.
                            this.petAimAt = now;
                        }
                    }
                }
                const zone = getZone(d.zoneSkinId);
                if (!zone) return true;
                const x = zone.xOffset + d.xOffset;
                const y = zone.yOffset + d.yOffset;
                if (npc) {
                    npc.x = x;
                    npc.y = y;
                    npc.z = d.z;
                    npc.heading = d.heading;
                    npc.speed = d.speed;
                    npc.healthPercent = d.healthPercent;
                    if (!stale) {
                        // On us or a pet of ours: on the move it reads 0xFFFF and a caster 0 between casts, neither naming anyone, and a late id can't undo what has named it since (a swing, a hand-over).
                        const onOurs = this.isUsOrOwnPet(npc.targetId);
                        if (onOurs && targetId === TARGET_UNNAMED && npc.chaseUntil > 0) this.chaseGoesOn(npc, now);
                        const chasing = targetId === TARGET_UNNAMED && (now - npc.targetAt <= MOB_CHASE_HOLD_MS || now <= npc.chaseUntil);
                        const holds = onOurs && (late || chasing || (targetId === 0 && now - npc.castAt <= PET_AIM_HOLD_MS));
                        if (!holds) {
                            // A mob that stops swinging to cast reads 0, and that can come before its 0x72 (PacketLib168.cs:820-828). A mob that goes home sends none.
                            if (onOurs && targetId === 0) {
                                npc.clearedId = npc.targetId;
                                npc.clearedAt = now <= npc.chaseUntil ? now : npc.targetAt;
                            }
                            npc.targetId = targetId;
                            npc.chaseUntil = 0;
                        }
                        if (targetId !== 0 && targetId !== TARGET_UNNAMED) {
                            npc.targetAt = now;
                            npc.clearedId = 0;
                        }
                    }
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
                    // No loot from a pet (GameNPC.cs:2731-2732), and a release is type 0 too: its health is set to 0 first (PetECSEffect.cs:19, PacketLib168.cs:884).
                    if (!npc.isPet) this.lastNpcDeath = { at: now, x: npc.x, y: npc.y };
                    this.pushCombat({ kind: 'death', attackerObjectId: null, targetObjectId: d.objectId, targetHealthPercent: 0 });
                }
                if (d.type === 0) {
                    // Before targetDied, which clears the targets these go by.
                    this.loseSummon(d.objectId);
                    // A release closes the window first (PetECSEffect.cs:18-20), so one still open here means it died: the close comes on a later tick.
                    // Type 1 is the same-region jump, which keeps it (GameNPC.cs:2044).
                    if (d.objectId === this.pet?.objectId) this.losePet('died');
                    this.targetDied(d.objectId);
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
                    level: d.level, model: d.model, realm: d.realm, x: d.x, y: d.y, z: d.z, heading: d.heading, speed: 0,
                    healthPercent: d.isDead ? 0 : 100, isDead: d.isDead, diedAt: 0, isSitting: false, inCombat: false, lastUpdate: now,
                });
                return true;
            }
            case ServerOp.ModelChange: {
                const d = decodeModelChange(p);
                // Ours comes too (GetPlayersInRadius has us in it), with no entry: our own shade reads from the effect (isShade).
                const entry = this.players.get(d.objectId) ?? this.npcs.get(d.objectId);
                if (entry) entry.model = d.model;
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
                    const bare = (i: number): number => d.base[i]! + d.buff[i]! + d.ra[i]!;
                    const v = (i: number): number => bare(i) + Math.min(d.item[i]!, d.itemCap[i] || d.item[i]!);
                    const stats = (of: (i: number) => number): Stats => ({
                        strength: of(0), dexterity: of(1), constitution: of(2), quickness: of(3),
                        intelligence: of(4), piety: of(5), empathy: of(6), charisma: of(7),
                    });
                    this.self.stats = stats(v);
                    this.self.statsWithoutItems = stats(bare);
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
            case ServerOp.TradeWindow: {
                const d = decodeTradeWindow(p);
                const prev = d && this.trade?.partnerName === d.partnerName ? this.trade : null;
                this.trade = d && {
                    id: prev?.id ?? nextTradeId++,
                    revision: (prev?.revision ?? 0) + 1,
                    partnerName: d.partnerName,
                    mySlots: d.mySlots,
                    myMoney: totalCopper(d.myMoney),
                    partnerItems: d.partnerItems.map(i => toInventoryItem(i.slot, i.item)), // never into this.items: the slots are the partner's
                    partnerMoney: totalCopper(d.partnerMoney),
                };
                this.signal('trade');
                return true;
            }
            case ServerOp.PetWindow: {
                const d = decodePetWindow(p);
                if (d.action === 0) {
                    // After a death, a region change or the pet's own death this comes late: the server queues it (EffectListComponent.cs:914-921). A no-op then.
                    this.losePet('released');
                    return true;
                }
                const prev = this.pet?.objectId === d.objectId ? this.pet : null;
                // An update can still land between a lost pet's 0xA2 and its close (PlayerEffectListComponent.cs:99-100): only an open makes a window.
                if (!d.objectId || (d.action !== 2 && !prev)) return true;
                const entry = this.npcs.get(d.objectId);
                if (!prev) {
                    this.petHealth = entry?.healthPercent ?? 100;
                    this.summons.delete(d.objectId);
                    this.lostPetIds.delete(d.objectId);
                    // A song's next pulse takes back what it let go, on its way to us by then (CharmSpellHandler.cs:81-82): our pet isn't on us.
                    if (entry?.targetId === this.self.objectId) {
                        entry.targetId = 0;
                        entry.chaseUntil = 0;
                    }
                }
                const aggression = PET_AGGRESSION[d.aggro] ?? prev?.aggression ?? 'defensive';
                const name = entry?.name ?? prev?.name;
                this.pet = {
                    ...(name !== undefined && { name }),
                    objectId: d.objectId,
                    aggression,
                    walk: PET_WALK[d.walk] ?? prev?.walk ?? 'follow',
                    icons: d.icons,
                    targetObjectId: prev?.targetObjectId ?? null,
                };
                // Going passive calls it off (ControlledMobBrain.cs:199-203). A passive pet that swings back later is named by that swing.
                if (aggression === 'passive' && prev?.aggression !== 'passive') this.petOffTarget();
                this.signal('pet');
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
                // No defender is a bow being drawn (AttackAction.cs:261), not a swing.
                if (d.defenderId) {
                    this.pushCombat({
                        kind: 'melee', attackerObjectId: d.attackerId || null, targetObjectId: d.defenderId,
                        result: d.result, targetHealthPercent: d.targetHealthPercent,
                    });
                }
                // The defender's HealthPercent at the swing (WeaponAction.cs:369), sent to everyone in view
                // of it: for a player fresher than its 0xA9 relay, which waits for its next position update.
                // Not a player's from our own swing: when a blow on our target is intercepted (a Spiritmaster's
                // pet, AttackComponent.cs:1492-1498), the attacker's copy names our target but carries the
                // interceptor's health (WeaponAction.cs:363-369), 0 when the blow killed it.
                const selfId = this.self.objectId;
                const defender = this.npcs.get(d.defenderId) ?? (d.attackerId !== selfId ? this.players.get(d.defenderId) : undefined);
                if (defender && d.targetHealthPercent <= 100) defender.healthPercent = d.targetHealthPercent;
                const petId = this.pet?.objectId;
                // The server counts the pet's fights as ours (GamePlayer.cs:6045-6047), and a minion's through its commander (GameNPC.cs:3040-3080).
                if (this.isUsOrOwnPet(d.attackerId) || this.isUsOrOwnPet(d.defenderId)) this.self.lastCombatAt = now;
                if (d.attackerId === petId && d.defenderId) this.aimPet(d.defenderId, now);
                if (d.defenderId === petId && d.targetHealthPercent <= 100) this.petHealth = d.targetHealthPercent;
                if (this.isUsOrOwnPet(d.defenderId) && d.attackerId) {
                    const att = this.npcs.get(d.attackerId);
                    // A DoT's tick comes with no 0x1B (DoTSpellHandler.cs:169): it says who the spell landed on some time ago, not who the mob is on now.
                    const tick = d.resultCode === SPELL_DAMAGE_RESULT && !!att && att.targetId !== d.defenderId && this.isUsOrOwnPet(att.targetId) && now - att.targetAt <= PET_AIM_HOLD_MS;
                    if (att && !tick) {
                        att.targetId = d.defenderId;
                        att.targetAt = now;
                    }
                }
                return true;
            }
            case ServerOp.SpellCastAnimation: {
                const d = decodeSpellCastAnimation(p);
                this.pushCombat({ kind: 'spellCast', attackerObjectId: d.casterId, targetObjectId: null, castTimeMs: d.castTimeMs, effectId: d.effect });
                // A mob that stops swinging to cast reads 0 (PacketLib168.cs:820), with the 0x1B of its first cast still to come. This names nobody: one lately on us or a pet of ours likely stays on it, and PET_AIM_HOLD_MS bounds a wrong guess.
                // Only lately: a mob that has gone on to somebody else casts on, each of its 0x72s the same, and would read as on us until it died. Its 0x1Bs name that other, who is nothing to us, so they can't say so.
                const caster = this.npcs.get(d.casterId);
                if (caster && this.isUsOrOwnPet(caster.targetId) && now - caster.targetAt <= PET_AIM_HOLD_MS) caster.castAt = now;
                // Its 0 came first. Once only: what it clears next has the same old naming to go by, past the bound by then.
                else if (caster && (caster.targetId === 0 || caster.targetId === TARGET_UNNAMED) && this.isUsOrOwnPet(caster.clearedId) && now - caster.clearedAt <= PET_AIM_HOLD_MS) {
                    caster.targetId = caster.clearedId;
                    caster.clearedId = 0;
                    caster.castAt = now;
                }
                return true;
            }
            case ServerOp.SpellEffectAnimation: {
                const d = decodeSpellEffect(p);
                this.pushCombat({ kind: 'spellEffect', attackerObjectId: d.casterId || null, targetObjectId: d.targetId || null, effectId: d.effect });
                const selfId = this.self.objectId;
                if (d.casterId === selfId) this.noteSummon(d.targetId, d.effect, now);
                if (d.casterId === selfId && isCharmEffect(d.effect)) this.charmSongOn = isPulsingCharmEffect(d.effect) ? d.targetId : null;
                if (this.isOwnPet(d.casterId)) {
                    // Its buffs and heals on us or itself are no fight; it would make us read in combat for 8 s after each.
                    if (d.targetId && !this.isUsOrOwnPet(d.targetId) && !this.isFriendly(d.targetId)) {
                        this.self.lastCombatAt = now;
                        if (d.casterId === this.pet?.objectId) this.aimPet(d.targetId, now);
                    }
                } else if (d.casterId === selfId) {
                    // Nor is our own summon, buff or heal: a recall stone read as 8 s of combat. The server's InCombat doesn't start on these either.
                    // Nor a charm, landed or resisted: its first 0x1B comes before the mob is ours (CharmSpellHandler.cs:426, :430), and to the server it is no harm (Spell.cs:301-306).
                    if (!this.isUsOrOwnPet(d.targetId) && !this.isFriendly(d.targetId) && !isCharmEffect(d.effect)) this.self.lastCombatAt = now;
                } else if ((d.targetId === selfId || this.isOwnPet(d.targetId)) && !this.isFriendly(d.casterId) && !this.npcs.get(d.casterId)?.isPeaceful) {
                    // A friend's buff, heal or revive is no fight: the server's InCombat comes from combat ticks (GameLiving.cs:225-227). A caster we can't place stays one.
                    // Nor is a peace flag's, a realm-0 Hastener's as we talk to it (Hastener.cs:28-29): it can't attack (AbstractServerRules.cs:380-384).
                    this.self.lastCombatAt = now;
                    const caster = this.npcs.get(d.casterId);
                    if (caster) {
                        caster.targetId = d.targetId;
                        caster.targetAt = now;
                        caster.castAt = now;
                    }
                }
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
                if (d.victimId !== this.self.objectId) this.targetDied(d.victimId); // a player leaves no 0xA2 type 0
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
        // An order's answer: the first says whom, with nothing else naming the mob during its run-in (0xA1 reads 0xFFFF). That is the server's target at the order (GamePlayer.cs:12194):
        // what we named then, ours having maybe moved on since, as a melee fight's does. Failing that, our target. A mob the order was too late for gets no aim.
        if (PET_ATTACK_ANSWER.test(d.text)) {
            const order = this.petOrder && now - this.petOrder.at <= PET_ORDER_MS ? this.petOrder.objectId : null;
            this.petOrder = null;
            const named = order ?? this.self.targetObjectId;
            if (named !== null && !this.diedRecently(named)) this.aimPet(named, now);
        } else if (PET_DISENGAGE_ANSWER.test(d.text)) {
            this.petOffTarget();
        }
        // Sent when the spot is more than 16 off the mesh, after GroundTarget.Unset (PlayerGroundTargetHandler.cs:21-34). No 0xEC tells us.
        if (d.text === 'Your ground target is not visible!') this.groundTarget = null;
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
        // The pet does not outlive us (GamePlayer.cs:5988-5989); its close follows this, a no-op then.
        this.losePet('owner_died');
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
        for (const [oid, summon] of this.summons) {
            if (this.npcs.has(oid)) summon.lastSeenAt = now;
            else if (now - summon.lastSeenAt > SUMMON_ABSENT_MS && !(this.pet && isMinionEffect(summon.effect))) this.summons.delete(oid);
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
        for (const n of this.npcs.values()) if (n.targetId !== 0 && this.isUsOrOwnPet(n.targetId)) return true;
        return false;
    }

    /** A Necromancer in shade: the effect, as 0x75 lists it, is the only sign of it for ourselves. */
    isShade(): boolean {
        for (const e of this.effects.values()) if (e.icon === SHADE_ICON && e.isNegative) return true;
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
                lastSeenAgo: now - n.lastUpdate, firstSeenAt: n.firstSeenAt, guildName: n.guildName, level: n.level, model: n.model,
                realm: realmName(n.realm), healthPercent: n.healthPercent, speed: n.speed,
                targetObjectId: n.targetId && n.targetId !== 0xFFFF ? n.targetId : null,
                inCombat: n.targetId !== 0, isPeaceful: n.isPeaceful, isTargetable: n.isTargetable,
                hasQuest: n.hasQuest, isPet: n.isPet, role: n.isPet ? null : guessNpcRole(n.name, n.guildName),
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
                isSitting: pl.isSitting, inCombat: pl.inCombat, model: pl.model, isShade: pl.model === SHADE_MODEL,
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
