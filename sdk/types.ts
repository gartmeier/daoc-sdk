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
    /** Everything expressed in copper (1s = 100c, 1g = 100s, 1p = 1000g, 1m = 1000p). */
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
    /** Absolute max swim speed in deep water, units/s (85 at 100 %, up to 170 with water speed bonuses). */
    maxSwimSpeed: number;
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
    /** The same without item bonuses: base, buffs and realm abilities, what a percent power cost goes by (SpellHandler.cs:1190-1199). Absent from an older client. */
    statsWithoutItems?: Stats | null;
    /** Constitution lost to PvE deaths (from level 6); a town healer (GameHealer) restores it for money. */
    constitutionLost: number;
    encumbrance: { current: number; max: number } | null;

    isDead: boolean;
    isSitting: boolean;
    /** Melee auto-attack toggled on (server 0x74 AttackMode). */
    attacking: boolean;
    /**
     * In a fight as far as we can see: attack mode on, a swing or harmful spell by or on us, our pet or a summon within the last 8 s, or an NPC on one of them.
     * Not the server's own flag: that lasts 10 s (GameLiving.cs:31, :227), so what the server gates on it ("You have been in combat recently") can refuse for up to 2 s after this reads false.
     */
    inCombat: boolean;
    targetObjectId: number | null;
    /** Server tick-independent counter incremented on each death. */
    deathCount: number;
    lastDeathAt: number | null;
    /** A Necromancer in shade (the negative effect with icon 403, ShadeECSEffect.cs:8, :10; Stealth has that icon as a positive one): the servant fights, we can't melee (ClassDisciple.cs:91), and its death is ours. Leaving shade cuts our health to the pet's percent as it last went (:72-82, :149): a release or the tether leaves min(current, max(10, its %)), its death 10 %. A zone change or a quit in shade uses that percent stale (:155-160), 10 % with no release this session: releasePet first. False out of shade, absent from an older client. */
    isShade?: boolean;
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
    /**
     * Object the NPC is attacking/targeting, if any. Its 0xA1 names one only at a standstill within reach (PacketLib168.cs:820-828), so its swings and spells on us, our pet or a summon
     * name it too. That holds for 5 s while it is on the move, and 6 s between its casts, from a cast's first animation when it was on one of those then. When a pet of ours is lost, not to a region change or our death, a mob on it reads as on us at once:
     * the server re-aims it. So does the window pet's own target if it was moving or hurt, on its first run at the pet and never named. That holds for its run: its distance at 150 units/s, slower below 33 % health, plus 2 s, at least 5 s, and on while it reads 0xFFFF and comes nearer, 30 s at most, until
     * a real id or a 0 says otherwise. The server goes by threat, so where it has another to turn to it reads as on nobody until its next swing or 0xA1: with another pet of ours within 600 of it, a minion's mob while
     * its commander lives, and in a group of two or more. So does a mob on the pet at full health with nothing to show that it or we attacked it: it has no aggro on us (StandardMobBrain.cs:566-571). A 0 clears any of this, and a 0x72 under 6 s after its naming puts it back: a caster's 0 can come first.
     * A DoT's tick on one of ours names nobody when the mob was named on another of ours in the last 6 s: it has no 0x1B, and says where the spell landed some time ago.
     */
    targetObjectId: number | null;
    /**
     * `targetObjectId` stands on a spell alone: a mob casting from range at us or a pet of ours, with its 0x1B or its damage spell's 0xBC to go by, or held through 0xA1's 0 between casts.
     * Its target for the bot's own fight all the same, as the server sends none (PacketLib168.cs:820-828). The group reads it as the others' clients do, from the spell (observeState, Contact.targetBySpell), so what is on a member isn't told by whose report came last. Absent otherwise: the server's own id, a swing, or a run at us (65535).
     */
    targetBySpell?: boolean;
    /** When the client first held this entry, on its clock (as `receivedAt`): a death under this id before then was another mob's, as the server hands ids on at once (Region.cs:955). Absent from an older client. */
    firstSeenAt?: number;
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
    /** Rounded down by the server (GameLiving.cs:2621): a living player with a few hit points reads 0. */
    healthPercent: number;
    /** The death signal: set by the death event (0xAE) and kept until the player shows health again; never inferred from 0 %. */
    isDead: boolean;
    isSitting: boolean;
    inCombat: boolean;
    /** Its model, from its create (PacketLib1124.cs:382) and every change since (0xDB, PacketLib168.cs:990-998). Absent from an older client. */
    model?: number;
    /** A Necromancer in shade, model 822 (GamePlayer.cs:12345-12346): nobody can attack it, and no pet can be ordered at it: `You can't attack a shadowed necromancer!` (AbstractServerRules.cs:449-455). Its servant can be. Absent from an older client. */
    isShade?: boolean;
    /** What it shows it wears and holds (0x15 EquipmentUpdate), as any client in view draws it. Absent before its first 0x15 and from an older client. */
    gear?: PlayerGear;
}

/** A living's visible equipment (0x15, PacketLib1124.cs:52-105). */
export interface PlayerGear {
    /** VisibleActiveWeaponSlots: low nibble the right hand's slot - 10, high nibble the left's; 0xF none, 0xFF nothing drawn (GameLiving.cs:2037). */
    activeWeapons: number;
    /** Slot (eInventorySlot: 10 right hand, 11 left, 12 two-hand, 13 ranged, 21-28 armour, 26 cloak) and item model. */
    items: { slot: number; model: number }[];
    /** When it came (ms epoch). */
    at: number;
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
    /** See ItemHand. Only a weapon's means anything. */
    hand: number;
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

/** eObjectType.cs: `objectType` on inventory and merchant items. Weapon types belong to a realm: Blades is Hibernian, Sword Midgardian. */
export const ObjectType = {
    GenericItem: 0,
    GenericWeapon: 1,
    // Albion weapons
    CrushingWeapon: 2,
    SlashingWeapon: 3,
    ThrustWeapon: 4,
    Fired: 5,
    TwoHandedWeapon: 6,
    PolearmWeapon: 7,
    Staff: 8,
    Longbow: 9,
    Crossbow: 10,
    Flexible: 24,
    // Midgard weapons
    Sword: 11,
    Hammer: 12,
    Axe: 13,
    Spear: 14,
    CompositeBow: 15,
    Thrown: 16,
    LeftAxe: 17,
    HandToHand: 25,
    // Hibernia weapons
    RecurvedBow: 18,
    Blades: 19,
    Blunt: 20,
    Piercing: 21,
    LargeWeapons: 22,
    CelticSpear: 23,
    Scythe: 26,
    // Mauler weapons
    FistWraps: 27,
    MaulerStaff: 28,
    // Armor
    GenericArmor: 31,
    Cloth: 32,
    Leather: 33,
    Studded: 34,
    Chain: 35,
    Plate: 36,
    Reinforced: 37,
    Scale: 38,
    // Misc
    Magical: 41,
    Shield: 42,
    Arrow: 43,
    Bolt: 44,
    Instrument: 45,
    Poison: 46,
    AlchemyTincture: 47,
    SpellcraftGem: 48,
    // Housing
    GardenObject: 49,
    HouseWallObject: 50,
    HouseFloorObject: 51,
    HouseCarpetFirst: 52,
    HouseNPC: 53,
    HouseVault: 54,
    HouseInteriorObject: 55,
    HouseTentColor: 56,
    HouseExteriorBanner: 57,
    HouseExteriorShield: 58,
    HouseRoofMaterial: 59,
    HouseWallMaterial: 60,
    HouseDoorMaterial: 61,
    HousePorchMaterial: 62,
    HouseWoodMaterial: 63,
    HouseShutterMaterial: 64,
    HouseInteriorBanner: 66,
    HouseInteriorShield: 67,
    HouseBindstone: 68,
    HouseCarpetSecond: 69,
    HouseCarpetThird: 70,
    HouseCarpetFourth: 71,
    // Siege weapons
    SiegeBalista: 80,
    SiegeCatapult: 81,
    SiegeCauldron: 82,
    SiegeRam: 83,
    SiegeTrebuchet: 84,
} as const;

/** eObjectType's _FirstWeapon.._LastWeapon. */
export const isWeapon = (objectType: number): boolean => objectType >= ObjectType.CrushingWeapon && objectType <= ObjectType.MaulerStaff;
/** eObjectType's _FirstArmor.._LastArmor. */
export const isArmor = (objectType: number): boolean => objectType >= ObjectType.GenericArmor && objectType <= ObjectType.Scale;

/**
 * item.Hand, `hand` on a merchant item. The left-hand slot itself checks the item's Item_Type, which
 * the window doesn't send (GamePlayerInventory.cs:822), so FitsLeft is a guide and equipItem has the last word.
 */
export const ItemHand = { MainHand: 0, TwoHanded: 1, FitsLeft: 2 } as const;

// ── Skills / spells ─────────────────────────────────────────────────────────

export interface Specialization {
    /** The server's display name, not always the key elsewhere: 'Shield' (key Shields), 'Light Magic' (key Light). sdk.findSpecialization takes either. */
    name: string;
    level: number;
    internalId: number;
    /** Levels added on top of `level` by items and the like. */
    bonus: number;
}

export interface Ability {
    name: string;
    level: number;
    internalId: number;
    /** Index to pass to the useSkill action. */
    skillIndex: number;
    /** The server's tooltip fields as sent; a plain ability has little beyond Index and Name. */
    details?: Record<string, string>;
}

/** A style as the server's tooltip describes it. */
export interface StyleDetails {
    /** Endurance cost as the style table lists it. */
    fatigue: number;
    /** To-hit and defence modifiers while the style lands. */
    attackMod: number;
    defensiveMod: number;
    /** Damage growth: the style's GrowthRate * 200. */
    openingDamage: number;
    /** What it needs: his own last attack (offensive), the enemy's (defensive), or where he stands (positional). */
    opening: 'offensive' | 'defensive' | 'positional';
    /** The attack result `opening` asks for; null for any. 'styledHit' with `openingStyle` is a follow-up. */
    result: CombatResult | null;
    position: 'back' | 'side' | 'front' | null;
    /** The style this one follows. */
    openingStyle: string | null;
    /** Styles that follow this one, learned or not. */
    followUps: string[];
    /** Weapon it needs, in the server's words. */
    weapon: string | null;
    /** Needs stealth. */
    stealth: boolean;
    /** Internal id of the spell it procs, and that spell's details when the server sent them. */
    procSpellId: number | null;
    procSpell?: SpellDetails;
}

/** A spell as the server's tooltip describes it. */
export interface SpellDetails {
    /** 0 when instant; null for a cast under 2 s, which the tooltip doesn't state. */
    castTimeMs: number | null;
    damageType: string | null;
    /** Negative: a percent of the full pool. */
    powerCost: number;
    costType: 'power' | 'health' | 'endurance';
    range: number;
    durationSeconds: number;
    recastSeconds: number;
    target: 'self' | 'enemy' | 'group' | 'pet' | 'realm' | 'corpse' | 'area';
    radius: number;
    concentration: number;
    /** Time between pulses or ticks. */
    frequencyMs: number;
    /** The server's description; empty when it has none. */
    description: string;
}

export interface Style {
    name: string;
    internalId: number;
    specLevel: number;
    /** The line's DB key, so 'Shields' where the skill list says 'Shield': find its level with sdk.findSpecialization(specName). */
    specName: string | null;
    /** Index to pass to the useSkill action. */
    skillIndex: number;
    /** Raw prerequisite code from 0x16/01 (0x100 = none). `details` says the same in words. */
    prerequisite: number;
    /** From the 0xD8 tooltip the server pushes after the skills list. */
    details?: StyleDetails;
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
    /** From the 0xD8 tooltip the server pushes after the skills list. */
    details?: SpellDetails;
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
    /** Set when this box is a resurrection offer. */
    resurrection?: ResurrectionOffer;
}

/** Another player's rez waiting for our answer: who cast it and the health it restores. It expires after 15 s, and the caster's power is gone then. */
export interface ResurrectionOffer {
    caster: string;
    healthPercent: number;
}

export type BonusCategory =
    | 'stat' | 'hits' | 'power' | 'powerPool' | 'resist' | 'skill' | 'skillGroup' | 'focus'
    | 'armorFactor' | 'absorption' | 'castingSpeed' | 'fatigue'
    /** "(PvE Only)" lines (GameInventoryItem.cs:859-863). */
    | 'pve'
    /** A real property that says nothing about these categories: "Evade chance", "Slash cap". */
    | 'other';

export type SkillGroup = 'melee' | 'magic' | 'dual' | 'archery' | 'other';

/** One bonus line of an item delve (sdk/delve.ts). */
export interface ItemBonus {
    category: BonusCategory;
    /** The server's name for it: "Strength", "Body Magic Focus". */
    name: string;
    /** Negative for a penalty. */
    value: number;
    unit: 'pts' | '%' | 'lvls' | null;
    /** category 'stat'. */
    stat?: 'STR' | 'DEX' | 'CON' | 'QUI' | 'INT' | 'PIE' | 'EMP' | 'CHR' | 'ACU';
    /** category 'skill' and 'focus': the specialization's DB key, as in classes.json (sdk.findSpecialization takes it), null when no class has one. */
    spec?: string | null;
    /** category 'skill': its ePropertyType group; 'skillGroup': the group it raises, null for "All Skills". */
    group?: SkillGroup | null;
    /** The line as the server sent it. */
    text: string;
}

/** A weapon's "Damage Modifiers" lines. */
export interface WeaponDelve {
    baseDps: number;
    /** DPS at this character's level (GamePlayer.GetWeaponDpsCap). */
    clampedDps: number;
    /** Seconds per swing. */
    speed: number;
    quality: number;
    condition: number;
}

export interface ParsedDelve {
    bonuses: ItemBonus[];
    /** Non-blank lines that are neither a bonus nor known layout: proc spell text, descriptions, new formats. */
    unknown: string[];
    /** "Bonus Level: N" (GameInventoryItem.cs:478-482). Nothing enforces it: only the delve and spellcrafting read it. */
    bonusLevel: number | null;
    /** "Level Requirement: N Level" (:564). It gates the item's spells (GamePlayer.cs:7045), not its bonuses. */
    levelRequirement: number | null;
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
    /** The server's verdict: this character has the ability to use it. */
    usable: boolean;
    /** See ObjectType (the same number as InventoryItem.objectType). */
    objectType: number;
    /** See ItemHand. */
    hand: number;
    /** Crush, slash or thrust for a weapon; null otherwise. */
    damageType: 'crush' | 'slash' | 'thrust' | null;
    /** DPS * 10 for a weapon, AF for armour, pack size for ammunition (PacketLib1125.cs:640-675). */
    value1: number;
    /** Speed in 0.1 s for a weapon, absorption for armour. */
    spdAbs: number;
}

export interface MerchantState {
    isOpen: boolean;
    merchantObjectId: number | null;
    windowType: number;
    items: MerchantItem[];
}

export interface TrainerSpec {
    index: number;
    /** The server's display name, as in Specialization.name. */
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
    /** For kinds 'spellCast' and 'spellEffect': the spell's client effect id (Spell.ClientEffect, SpellHandler.cs:1273/:1290), not its spell id. */
    effectId?: number;
    /** Kind 'melee': the 0xBC animation, when not a plain swing: a style's (Style.Icon, or its TwoHandAnimation with a two-hander; StyleProcessor.cs:448-452), or a dual wield's or a bow's. */
    style?: number;
    /** Kind 'melee': the model of the weapon it swung or shot. */
    weaponModel?: number;
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

/** Open player trade (server 0xEA). Accept state is not on the wire: every 0xEA means both accepts were reset. */
export interface TradeWindow {
    /** Process-wide, new per window. */
    id: number;
    /** 1 on open, +1 per 0xEA. */
    revision: number;
    /** From "Trading with <name>". Null is a self-craft window: never accept it. */
    partnerName: string | null;
    /** Our offered slots. The items stay there until the commit. */
    mySlots: number[];
    /** Copper. */
    myMoney: number;
    /** slot is the PARTNER's slot, never ours. */
    partnerItems: InventoryItem[];
    /** Copper. */
    partnerMoney: number;
}

export type PetAggression = 'aggressive' | 'defensive' | 'passive';
export type PetWalk = 'follow' | 'stay' | 'goTarget' | 'comeHere';
export type PetCommand = PetAggression | PetWalk | 'attack' | 'release';

/**
 * Our pet as the server's pet window (0x88) has it. A pet the window doesn't list (a Theurgist's, a
 * fire-and-forget turret, a bomber, a Bonedancer's minion: SetBrainToOwner is empty or the commander
 * holds it) never shows here. Its health and position are its entry in nearbyNpcs (sdk.getPet):
 * that entry can be gone while the window stays: out of view, or until the client has asked for it again after a jump.
 */
export interface PetState {
    objectId: number;
    /** Its name, from its entry when we last had one, so it holds while the pet is out of view. Absent until an entry was seen, and from an older client. */
    name?: string;
    /** From the server, not from what we asked: an order can change it (ControlledMobBrain.cs:213-214, :228-233). */
    aggression: PetAggression;
    /** Where it was told to go. A turret's reads 'follow' for its whole life: its walk orders change nothing (TurretBrain.cs:100-108). */
    walk: PetWalk;
    /** Effect icons on it, at most 8 (PacketLib181.cs:157-166). */
    icons: number[];
    /**
     * Who it is fighting, a caster pet between casts and a pet on its way included. Set by the answer to an attack order
     * (to what the order named), by its 0xBC swing or 0x1B cast at an enemy, and by an 0xA1 naming the id. An 0xA1 reading 0, as
     * a caster's does between casts (PacketLib168.cs:820), clears it only when all that is over 6 s old; one reading 0xFFFF
     * (on the move) keeps it and counts as that evidence, for a run of any length. Cleared at once by the target's death (an 0xA1 still naming it in the next 2 s, older than the death, reads 0), a change to passive, and the answer to a follow, stay,
     * come here or go to target order (a defensive pet that hits back gets a fresh target from that swing). Null when it isn't fighting.
     */
    targetObjectId: number | null;
}

export type PetLossCause = 'died' | 'released' | 'owner_died' | 'region_change';

/**
 * How our last window pet went. Stays until the next loss: compare `at`. 'released' is any close that came first:
 * our order, a charm or duration ending, the tether, or a death out of our view (its 0xA2 goes only to players near it).
 */
export interface PetLoss {
    objectId: number;
    /** From its NPC entry, also one since gone out of view; null when we never had one. */
    name: string | null;
    cause: PetLossCause;
    /** Client wall-clock time (ms epoch). */
    at: number;
    /**
     * The NPCs that read as on it when it went; absent with none. Their entries can't say so any more: the model hands them to us at the loss, or with another for them to turn to (a groupmate, another pet of ours) clears them. Absent from an older client.
     */
    targetedBy?: number[];
    /** Who it aimed at when it went (PetState.targetObjectId), which targetedBy can't say of a mob it was on its way to. Absent with nobody, and from an older client. */
    targetObjectId?: number;
}

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
    /** When a vault keeper last opened the vault in this client session; null or absent means `vault` says nothing yet. */
    vaultOpenedAt?: number | null;
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
    /** Last 200 combat events in view (ours and everyone else's), oldest first. */
    combatEvents: CombatEvent[];
    /** Concentration effects we maintain (server 0x75). */
    concentrationEffects?: ConcentrationEffect[];
    /** Current ground target, when set via setGroundTarget or the server (0xEC). Null again once the server drops it: 'Your ground target is not visible!'. */
    groundTarget?: Vec3 | null;
    /** Open player trade window; absent or null when closed. */
    trade?: TradeWindow | null;
    /** Our pet's window; null without one, absent from an older client. */
    pet?: PetState | null;
    /** How the last window pet went; null before the first loss. */
    lastPetLoss?: PetLoss | null;
    /**
     * Object ids of our own pets with no window, in view or not (sdk.getSummons has the entries in view): a Theurgist's, a
     * fire-and-forget turret, a bomber, a Bonedancer's minion. Known from the 0x1B of their summon on an entry just seen, so
     * a buff of ours on a groupmate's fresh pet can land here too. Gone with their 0xA2 type 0, a region change, a 0xDA under that id with no pet flag or another name (ids get reused),
     * for a minion the window closing (it goes with its commander), or 30 s with no entry: one that ends out of view leaves no 0xA2, so it lingers that long, and one of ours that comes back
     * after that reads as a stranger's. A minion is exempt from the 30 s while its window is open: it can't outlive the commander, and it would be a pet nothing could address. Absent from an older client.
     */
    summons?: number[];
    /**
     * Those of `summons` that came under 3.5 s ago, minions left out. One that fights by itself is in its fight from the start (TheurgistPetBrain.cs), with nothing to show it yet:
     * a caster in range reads target 0 until its first cast lands (PacketLib168.cs:820). Absent from an older client.
     */
    freshSummons?: number[];
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
    | { type: 'setGroundTarget'; x: number; y: number; z?: number }

    // Pets. Success means dispatched: the server's "You command ..." line and state.pet show the effect.
    | { type: 'petCommand'; command: PetCommand; targetObjectId?: number }

    // Items
    | { type: 'useItem'; slot: number; useType?: number }
    | { type: 'moveItem'; fromSlot: number; toSlot: number; count?: number }
    | { type: 'dropItem'; slot: number }
    | { type: 'destroyItem'; slot: number }
    | { type: 'delve'; slot: number }
    | { type: 'delveMerchantItem'; page: number; slot: number }

    // Player trade. Success means dispatched: only the next 0xEA in state.trade shows the server took it.
    | { type: 'tradeOfferItem'; partnerObjectId: number; slot: number }
    | { type: 'tradeOfferMoney'; partnerObjectId: number; copper: number }
    | { type: 'tradeAccept'; revision?: number; windowId?: number }
    | { type: 'tradeCancel' }

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
    // Drop one of our concentration buffs: its index in state.concentrationEffects.
    | { type: 'removeConcentration'; index: number }
    // Use a zone point by its id (getZonePointsFrom in data/index).
    | { type: 'regionChangeRequest'; zonePointId: number }
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
