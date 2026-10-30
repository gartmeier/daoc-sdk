// Shared contract between the headless DAoC client, the gateway and the SDK.
//
// The client produces BotWorldState snapshots and executes BotActions. The SDK
// never speaks the DAoC wire protocol; it only sees these JSON shapes.
//
// Coordinates are DAoC global region coordinates: x/y on the ground plane,
// z is height. Headings are DAoC units (0..4095, 0 = +Y, clockwise).
// Distances are in world units (a player runs ~191 units/s at 100% speed).

// ── Primitives ──────────────────────────────────────────────────────────────

export type Realm = 'none' | 'albion' | 'midgard' | 'hibernia';

export interface Position {
    regionId: number;
    x: number;
    y: number;
    z: number;
}

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

// ── Player ──────────────────────────────────────────────────────────────────

export interface Stats {
    strength: number;
    dexterity: number;
    constitution: number;
    quickness: number;
    intelligence: number;
    piety: number;
    empathy: number;
    charisma: number;
}

export interface Money {
    copper: number;
    silver: number;
    gold: number;
    mithril: number;
    platinum: number;
    /** Everything expressed in copper (1s = 100c, 1g = 100s, 1m = 1000g, 1p = 1000m). */
    totalCopper: number;
}

export interface PlayerState {
    name: string;
    lastName: string;
    guildName: string;
    accountName: string;
    objectId: number;
    sessionId: number;
    level: number;
    realm: Realm;
    className: string;
    raceName: string;

    regionId: number;
    zoneId: number;
    zoneName: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    /** Current speed reported by our own mover, units/s. */
    speed: number;
    /** Absolute max run speed, units/s (191 * maxSpeedPercent / 100). */
    maxSpeed: number;
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
    /** Progress toward next level, 0..1000. */
    levelPermill: number;
    realmPoints: number;
    bountyPoints: number;
    specPoints: number;
    realmSpecPoints: number;
    money: Money;
    stats: Stats | null;
    encumbrance: { current: number; max: number } | null;

    isDead: boolean;
    isSitting: boolean;
    /** Melee auto-attack toggled on (server 0x74 AttackMode). */
    attacking: boolean;
    inCombat: boolean;
    targetObjectId: number | null;
    /** Server tick-independent counter incremented on each death. */
    deathCount: number;
    lastDeathAt: number | null;
}

// ── World objects ───────────────────────────────────────────────────────────

interface WorldObjectBase {
    objectId: number;
    name: string;
    x: number;
    y: number;
    z: number;
    heading: number;
    /** 3D distance from our player, world units. */
    distance: number;
    /** 2D (ground-plane) distance from our player. */
    distance2d: number;
    /** ms since this object was last updated by the server. */
    lastSeenAgo: number;
}

export interface NearbyNpc extends WorldObjectBase {
    kind: 'npc';
    guildName: string;
    level: number;
    model: number;
    realm: Realm;
    healthPercent: number;
    speed: number;
    /** Object the NPC is attacking/targeting, if any. */
    targetObjectId: number | null;
    inCombat: boolean;
    /** Flags decoded from 0xDA. */
    isPeaceful: boolean;
    isTargetable: boolean;
    hasQuest: boolean;
    isPet: boolean;
    /** Best-effort guess from guild/name text: 'merchant', 'trainer', 'guard', 'healer', 'stablemaster', ... */
    role: string | null;
}

export interface NearbyPlayer extends WorldObjectBase {
    kind: 'player';
    sessionId: number;
    guildName: string;
    lastName: string;
    level: number;
    realm: Realm;
    healthPercent: number;
    isDead: boolean;
    isSitting: boolean;
    inCombat: boolean;
}

export interface NearbyObject extends WorldObjectBase {
    kind: 'object';
    model: number;
    realm: Realm;
    /** Door id when this object is a door. */
    doorId: number | null;
    /** True when this is likely loot on the ground (bag/coins/drop). */
    isLoot: boolean;
    /** True when the server says this loot belongs to us. */
    ownedByUs: boolean;
}

// ── Items ───────────────────────────────────────────────────────────────────

export interface InventoryItem {
    /** DAoC inventory slot (see EquipmentSlot / backpack 40-79). */
    slot: number;
    name: string;
    level: number;
    count: number;
    model: number;
    objectType: number;
    condition: number;
    durability: number;
    quality: number;
    weight: number;
    /** Raw value fields from ItemData (DPS/AF, SPD/ABS etc. depending on type). */
    value1: number;
    value2: number;
}

export const EquipmentSlot = {
    RightHand: 10,
    LeftHand: 11,
    TwoHand: 12,
    Ranged: 13,
    FirstQuiver: 14,
    Head: 21,
    Hands: 22,
    Feet: 23,
    Jewelry: 24,
    Torso: 25,
    Cloak: 26,
    Legs: 27,
    Arms: 28,
    Neck: 29,
    Waist: 32,
    LeftBracer: 33,
    RightBracer: 34,
    LeftRing: 35,
    RightRing: 36,
    Mythical: 37,
    FirstBackpack: 40,
    LastBackpack: 79,
    FirstVault: 110,
    LastVault: 149,
} as const;

// ── Skills / spells ─────────────────────────────────────────────────────────

export interface Specialization {
    name: string;
    level: number;
    internalId: number;
}

export interface Ability {
    name: string;
    level: number;
    internalId: number;
    /** Index to pass to the useSkill action. */
    skillIndex: number;
}

export interface Style {
    name: string;
    internalId: number;
    specLevel: number;
    specName: string | null;
    /** Index to pass to the useSkill action. */
    skillIndex: number;
    /** Raw prerequisite code from 0x16/01 (0x100 = none). */
    prerequisite: number;
}

export interface Spell {
    name: string;
    level: number;
    internalId: number;
    lineName: string;
    /** Indices to pass to the castSpell action. */
    lineIndex: number;
    spellIndex: number;
    /** Seconds remaining on cooldown, 0 when ready. */
    cooldownRemaining: number;
    /**
     * Set for hybrid-class spells that live in the usable-skills list instead of a
     * spell line (lineIndex/spellIndex are then -1): cast them with useSkill(skillIndex).
     */
    skillIndex?: number;
}

/** Server 0x75 concentration list entry. */
export interface ConcentrationEffect {
    index: number;
    name: string;
    ownerName: string;
    concentration: number;
    icon: number;
}

export interface SkillsState {
    specializations: Specialization[];
    abilities: Ability[];
    styles: Style[];
    spells: Spell[];
}

export interface Effect {
    index: number;
    name: string;
    icon: number;
    spellId: number;
    remainingSeconds: number;
    isNegative: boolean;
}

// ── Chat / messages ─────────────────────────────────────────────────────────

export type ChatType =
    | 'say' | 'send' | 'group' | 'guild' | 'broadcast' | 'emote' | 'help'
    | 'chat' | 'officer' | 'alliance' | 'spell' | 'youHit' | 'system' | 'items'
    | 'merchant' | 'yourDeath' | 'otherDeath' | 'otherCombat' | 'spellExpires'
    | 'loot' | 'resisted' | 'important' | 'damaged' | 'action' | 'spellPulse'
    | 'lfg' | 'trade' | 'screenCenter' | 'other';

export interface GameMessage {
    /** Monotonic id assigned by the client; stable across snapshots. */
    id: number;
    type: ChatType;
    /** Raw eChatType byte. */
    rawType: number;
    text: string;
    /** Parsed sender for player chat ("Bob says, ..."), else null. */
    sender: string | null;
    /** True for popup-window ("##") messages, e.g. NPC dialog text. */
    popup: boolean;
    receivedAt: number;
}

/** Last NPC dialogue seen (GameNPC.SayTo text), with [keywords] extracted. */
export interface NpcDialog {
    npcObjectId: number | null;
    npcName: string | null;
    text: string;
    keywords: string[];
    receivedAt: number;
}

/** Server 0x81 dialog box (group invite, quest offer, custom yes/no, ...). */
export interface DialogBox {
    isOpen: boolean;
    code: number;
    data: [number, number, number, number];
    /** 0 = OK only, 1 = yes/no. */
    type: number;
    text: string;
    receivedAt: number;
}

/** Server 0xC4 custom text window. */
export interface TextWindow {
    caption: string;
    lines: string[];
    receivedAt: number;
}

// ── Merchant / trainer / group ──────────────────────────────────────────────

export interface MerchantItem {
    page: number;
    slot: number;
    name: string;
    level: number;
    price: number;
    model: number;
    usable: boolean;
}

export interface MerchantState {
    isOpen: boolean;
    merchantObjectId: number | null;
    windowType: number;
    items: MerchantItem[];
}

export interface TrainerSpec {
    index: number;
    name: string;
    level: number;
    /** Cost in spec points to train the next level. */
    nextLevelCost: number;
}

export interface TrainerState {
    /**
     * True from a 0x7B trainer window until the target moves off its trainer, we walk more than 512
     * units from where it arrived, or the region changes (the server never sends a close).
     */
    isOpen: boolean;
    specPoints: number;
    specs: TrainerSpec[];
    /** The object targeted when the window arrived (the trainer), or null. */
    trainerObjectId?: number | null;
    /** ms timestamp of the last 0x7B; kept when the window closes. Compare it to detect a fresh window. */
    receivedAt?: number;
}

export interface GroupMember {
    name: string;
    className: string;
    level: number;
    objectId: number;
    healthPercent: number;
    manaPercent: number;
    endurancePercent: number;
    isDead: boolean;
    inOtherRegion: boolean;
}

// ── Combat events ───────────────────────────────────────────────────────────

export type CombatResult = 'miss' | 'parry' | 'block' | 'evade' | 'fumble' | 'hit' | 'styledHit' | 'other';

export interface CombatEvent {
    id: number;
    kind: 'melee' | 'spellCast' | 'spellEffect' | 'interrupt' | 'death';
    attackerObjectId: number | null;
    targetObjectId: number | null;
    result?: CombatResult;
    targetHealthPercent?: number;
    /** Spell cast time in ms for kind 'spellCast'. */
    castTimeMs?: number;
    receivedAt: number;
}

// ── Movement ────────────────────────────────────────────────────────────────

export interface MovementState {
    moving: boolean;
    destination: Vec3 | null;
    /** Remaining waypoints, including the destination. */
    waypoints: Vec3[];
    /** Set when the last move stopped without arriving. */
    lastStopReason: 'arrived' | 'stopped' | 'teleported' | 'regionChange' | 'died' | null;
    /** Count of server position corrections (0x04 CharacterJump / 0x20) received. */
    correctionCount: number;
    /** In deep water: position updates carry the swim flag and z sits under the river surface (sdk/ground.ts). */
    swimming: boolean;
}

// ── Connection ──────────────────────────────────────────────────────────────

export type ClientPhase =
    | 'connecting' | 'login' | 'charScreen' | 'creatingCharacter'
    | 'enteringWorld' | 'playing' | 'regionChange' | 'linkdead'
    | 'quitting' | 'disconnected';

export interface ConnectionInfo {
    phase: ClientPhase;
    serverName: string;
    clientVersion: string;
    /** Last login/disconnect error if any (e.g. "AccountIsInLogoutProcedure"). */
    lastError: string | null;
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export interface BotWorldState {
    /** Monotonic publish counter (one per published snapshot). */
    tick: number;
    revision: number;
    /** Client wall-clock time (ms epoch) when the snapshot was built. */
    timestamp: number;
    inGame: boolean;
    connection: ConnectionInfo;
    player: PlayerState | null;
    movement: MovementState;
    nearbyNpcs: NearbyNpc[];
    nearbyPlayers: NearbyPlayer[];
    nearbyObjects: NearbyObject[];
    /** Backpack (slots 40-79). */
    inventory: InventoryItem[];
    /** Equipped items (slots 10-37). */
    equipment: InventoryItem[];
    /** Vault items, populated after the vault window has been opened. */
    vault: InventoryItem[];
    skills: SkillsState;
    effects: Effect[];
    group: GroupMember[];
    /** Last 100 messages, oldest first. */
    gameMessages: GameMessage[];
    npcDialog: NpcDialog | null;
    dialog: DialogBox | null;
    textWindow: TextWindow | null;
    merchant: MerchantState;
    trainer: TrainerState;
    /** Last 50 combat events, oldest first. */
    combatEvents: CombatEvent[];
    /** Concentration effects we maintain (server 0x75). */
    concentrationEffects?: ConcentrationEffect[];
    /** Current ground target, when set via setGroundTarget or the server (0xEC). */
    groundTarget?: Vec3 | null;
}

// ── Actions ─────────────────────────────────────────────────────────────────

interface ActionBase {
    /** Free-text reason, shown in logs. */
    reason?: string;
}

export type BotAction = ActionBase & (
    | { type: 'none' }
    | { type: 'wait'; ms: number }

    // Movement (the client streams position updates itself)
    | { type: 'moveTo'; x: number; y: number; z?: number; tolerance?: number; waypoints?: Vec3[]; speedFactor?: number }
    | { type: 'stop' }
    | { type: 'face'; heading: number }
    | { type: 'faceObject'; objectId: number }
    | { type: 'jump' }

    // Targeting / interaction
    | { type: 'setTarget'; objectId: number | null }
    | { type: 'interact'; objectId: number }
    | { type: 'whisper'; objectId: number; text: string }
    | { type: 'pickup'; objectId: number }

    // Combat
    | { type: 'attack'; on: boolean }
    | { type: 'useSkill'; skillIndex: number }
    | { type: 'castSpell'; lineIndex: number; spellIndex: number }
    | { type: 'setGroundTarget'; x: number; y: number; z: number }

    // Items
    | { type: 'useItem'; slot: number; useType?: number }
    | { type: 'moveItem'; fromSlot: number; toSlot: number; count?: number }
    | { type: 'dropItem'; slot: number }
    | { type: 'destroyItem'; slot: number }

    // Merchants / trainers
    | { type: 'buy'; page: number; slot: number; count: number }
    | { type: 'sell'; slot: number }
    | { type: 'openTrainer' }
    | { type: 'trainSpec'; specIndex: number; levels?: number }

    // UI
    | { type: 'respondDialog'; accept: boolean }
    | { type: 'closeMerchant' }

    // Chat / slash commands. `command` is sent verbatim through the command
    // handler, e.g. "&say hello", "&release", "&stick". A leading '/' is
    // converted to '&'.
    | { type: 'say'; text: string }
    | { type: 'send'; to: string; text: string }
    | { type: 'groupSay'; text: string }
    | { type: 'command'; command: string }

    // Status
    | { type: 'sit'; sit: boolean }
    | { type: 'release' }
    | { type: 'quit' }
);

export type BotActionType = BotAction['type'];

export type ActionPhase = 'validation' | 'routing' | 'dispatch' | 'observation' | 'completion';

export interface ActionResult {
    success: boolean;
    message: string;
    data?: unknown;
    /** Machine-readable failure reason, e.g. 'timeout', 'busy', 'not_in_game', 'unknown_object'. */
    reason?: string;
    phase?: ActionPhase;
}

// ── SDK configuration / status ──────────────────────────────────────────────

export type ConnectionMode = 'control' | 'observe';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface BotStatus {
    status: 'active' | 'stale' | 'dead' | 'unknown';
    inGame: boolean;
    stateAge: number | null;
    controllers: string[];
    observers: string[];
    player: { name: string; regionId: number; x: number; y: number; z: number } | null;
}

export interface SDKConfig {
    botUsername: string;
    password?: string;
    gatewayUrl?: string;
    connectionMode?: ConnectionMode;
    /** Spawn a headless client process for this bot when none is attached. */
    autoLaunchClient?: boolean | 'auto';
    readyTimeout?: number;
    connectTimeout?: number;
    actionTimeout?: number;
    autoReconnect?: boolean;
    reconnectMaxRetries?: number;
    reconnectBaseDelay?: number;
    reconnectMaxDelay?: number;
    /**
     * false hides other players' chat (say/send/group/... from someone else). Our own echoes,
     * popup text and NPC speech stay: NPCs talk as CT_Say too (GameNPC.cs:2607-2608), and
     * bot.say/talkTo/whisper observe those lines. Default true.
     */
    showChat?: boolean;
}
