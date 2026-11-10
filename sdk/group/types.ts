// Group coordination contract: what members share (reports, sightings), what the
// coordinator decides (orders) and what the observer records (events).
//
// Everything here is plain JSON, so the same shapes can later travel between
// processes (a gateway channel) instead of living in one process's blackboard.

import type { CcImmunity, CcKind } from './cc';
import type { ClassGuess, FoeLook } from './class-read';
import type { PetAggression, PetWalk, Realm } from '../types';

/** What a member is for. Roles pick a behaviour list; capabilities come from its spells. */
export type Role = 'tank' | 'healer' | 'support' | 'nuker' | 'melee';

export interface Point { x: number; y: number }
export interface Point3 extends Point { z: number }

/** What a member is doing right now. Doubles as its claim on a target, so others don't double up. */
export interface Activity {
    /** 'idle', 'move', 'pull', 'melee', 'nuke', 'heal', 'cc', 'buff', 'rest', 'flee', 'release', ... */
    kind: string;
    targetId: number | null;
    /** Spell or behaviour detail, e.g. "Renewal" or "no mana". */
    detail: string;
    since: number;
}

/**
 * What a buff raises. Buffs of one slot don't stack (the stronger wins), so a slot
 * is covered once any of them is on the target. Base: af, str, con, dex; spec
 * (Druid Nurture spec and the like): strcon, dexqui, acuity, specaf.
 */
export type BuffSlot = 'af' | 'str' | 'con' | 'dex' | 'qui' | 'strcon' | 'dexqui' | 'acuity' | 'specaf'
    | 'haste' | 'dmgshield' | 'dmgadd' | 'absorb' | 'regen' | 'resist';

/** A buff spell a member can cast: the top rank per slot and target kind. */
export interface BuffSpell {
    name: string;
    slot: BuffSlot;
    /** Spell target: 'Self' (only on the caster), 'Realm' (anyone), 'Group' (everyone at once). */
    target: string;
    /** Concentration it ties up while it lasts (0 for timed buffs). */
    concentration: number;
}

/** What a member can do, from its spell list (refreshed as it levels). */
export interface Capabilities {
    heal: boolean;
    cc: boolean;
    /** Of `cc`, it holds a root, which takes an NPC under 75 % where a mezz can't (assignCc). Absent otherwise. */
    root?: boolean;
    /** The kinds it can put on someone (what `cc` says it has); absent in reports from before it. */
    ccKinds?: CcKind[];
    nuke: boolean;
    /** Knows a resurrection spell and has the rez behaviour; absent in reports from before it. */
    rez?: boolean;
    /** Buff spell names it can cast. */
    buffs: string[];
    /** The same buffs with slot, target and concentration (who buffs whom: buffs.ts). */
    buffSpells: BuffSpell[];
    /** The pet the group has it keep up: 'main' one in the pet window, 'fnf' a Theurgist's, which fights alone; null none; absent in reports from before pets. */
    pet?: 'main' | 'fnf' | null;
}

/** One member's view of itself, built from its own snapshots. */
/** What a member's own client saw it do in the run, counted from the server's messages. */
export interface MemberCombat {
    /** Damage dealt with weapons and spells. */
    dealt: number;
    /** Styles landed, by name. */
    styles: Record<string, number>;
    /** "You fail to execute your X perfectly!": the opening was gone by the swing. */
    missedStyles: number;
    /** Damage its pets dealt; absent until they have, so a group with no pets reads as before. */
    petDealt?: number;
    /** "The spirit soldier steps in front of you and takes the blow!", from its own window pet: a blow at this member, and the swing's 0xBC names the pet (AttackComponent.cs:1900). Absent until one has. */
    petIntercepts?: number;
}

/**
 * A member's window pet, for the others. Pets stay out of `members`: level, ready, formation and heal
 * targets all iterate that, and a pet's object id changes per login and is reused fast.
 */
export interface PetReport {
    objectId: number;
    /** '' until its client has had an entry for it. */
    name: string;
    /** These five are its NPC entry's, null while that is out of view: the window (state.pet) outlives it. */
    level: number | null;
    x: number | null;
    y: number | null;
    z: number | null;
    hp: number | null;
    /** Who it is fighting, from the window's PetState: a caster pet's entry reads 0 while casting, a walking one's 65535. */
    targetId: number | null;
    /** Its entry's; false out of view. */
    inCombat: boolean;
    aggression: PetAggression;
    walk: PetWalk;
    /** Effect icons on it, at most 8 (PacketLib181.cs:157-166). */
    icons: number[];
    /** The target of an attack order of ours that stands (petControl). An order leaves a pet on stay on stay (ControlledMobBrain.cs:211-226), so this is what tells its going in from its answering a blow. Absent with none. */
    orderedOn?: number;
}

export interface MemberReport {
    /** Character name. */
    name: string;
    /** Bot (account) folder name under bots/. */
    bot: string;
    role: Role;
    className: string;
    level: number;
    /** Cumulative experience (for XP rates). */
    experience: number;
    /** Cumulative realm points (for RvR); absent in reports from before RvR. */
    realmPoints?: number;
    objectId: number;
    regionId: number;
    x: number;
    y: number;
    z: number;
    /** Percentages. */
    hp: number;
    /** Full health in hit points, to size a heal; absent in reports from before it. */
    maxHp?: number;
    mana: number;
    endurance: number;
    /** Carried weight as % of capacity; above 100 the character cannot move. */
    load: number;
    isDead: boolean;
    isSitting: boolean;
    inCombat: boolean;
    attacking: boolean;
    targetId: number | null;
    /** Names of active effects (buffs we can see on ourselves). */
    effects: string[];
    capabilities: Capabilities;
    combat?: MemberCombat;
    activity: Activity;
    /** Snapshot time (ms epoch). */
    at: number;
    /** Its window pet; null without one, absent from an older runner or client. */
    pet?: PetReport | null;
    /** Object ids of its pets with no window (state.summons: a Theurgist's, minions), so what fights them fights us; absent without any. */
    summons?: number[];
    /** It has no pet, and the summon it keeps one up with is on its recast: pet-down's reason. Absent otherwise. */
    petRecast?: true;
}

/** A monster (or enemy player) as one member saw it in one snapshot. */
export interface Sighting {
    objectId: number;
    kind: 'npc' | 'player';
    name: string;
    level: number;
    realm: Realm;
    x: number;
    y: number;
    z: number;
    hp: number;
    targetId: number | null;
    inCombat: boolean;
    /** Monsters: units/s, from its latest position update. */
    speed?: number;
    /** Monsters on the move: when the server sent that update. x and y are reckoned on from it, to its destination at its speed (WorldModel.npcPosition), whatever has stopped the mob since. */
    fixedAt?: number;
    /** It swung at someone or, a monster, landed a hostile spell on someone in the last ~2 s (a mezz on it is broken). */
    swinging: boolean;
    /** Monsters: whom its latest hostile spell effect landed on in the last few seconds. The server reports no target for a mob mid-cast. */
    spellTargetId?: number | null;
    /** Monsters: `swinging` holds a hostile spell that landed. A root leaves it that at any range, where a swing reaches only what stands next to it (Blackboard.publish). */
    spellLanded?: boolean;
    /** Monsters: the player its latest swing or hostile spell in the last few seconds was aimed at, if it was at a player. */
    aimedAtPlayer?: number | null;
    /** Monsters: the same at a pet of anyone but this member: on the board, a stranger's or an enemy's unless a member owns it. Absent otherwise. */
    aimedAtPet?: number;
    /**
     * Players: it started a cast in the last few seconds (0x72 spell cast animation). The
     * server never sends an enemy player's target, so `targetId` for a player is inferred
     * from its latest melee swing or hostile spell effect on someone.
     */
    casting?: boolean;
    /** Players: it cast a spell on a player of its own realm in the last few seconds (a heal or buff). */
    helped?: boolean;
    /** An enemy realm's pet. Its owner can't be known: the server sends every client the pet flag and the owner's realm, never the owner (PacketLib1124.cs:186-187). */
    isPet?: boolean;
    /** Players: a Necromancer in shade (NearbyPlayer.isShade). No attack and no pet order lands on it (AbstractServerRules.cs:449-455): what can be fought is its servant. */
    isShade?: boolean;
    /** Players: what this member saw of it in this snapshot that tells a class: gear (0x15), spell effects, style animations, weapons swung (class-read.ts). The board keeps it as evidence, not on the contact. */
    look?: FoeLook;
}

/** The group's merged knowledge of one enemy. May be outdated: check lastSeen / stale. */
export interface Contact extends Sighting {
    regionId: number;
    /**
     * Member name it is targeting, or null (targetId may point at someone outside the group).
     * While it is in combat but the server reports no target (it runs, or its target is out
     * of reach), the last known target and targetId are kept.
     */
    target: string | null;
    /** The owner's name while it targets a member's pet, kept like `target` while it runs; `target` is null then. */
    targetPet?: string | null;
    /** `target` or `targetPet` comes from its spell alone: a monster casting from where it stands. A taunt can take it off; running to the tank can't. */
    targetBySpell?: boolean;
    /** When it started targeting `target` (how long the tank has held it). */
    targetSince: number;
    /** When the coordinator first ordered engage with it as the focus; 0 until then. */
    engagedAt: number;
    /** Its first health loss since engagedAt, which is when the fight's damage starts: a carried pull's first hit came long before. Absent until then, and again back at full health. */
    lossSince?: number;
    /** Its health just before lossSince. */
    lossFromHp?: number;
    /** The last sighting before engagedAt that kept the target while it ran (a carried pull); 0 if none. */
    movedAt: number;
    /** Members that see it in their latest snapshot. */
    seenBy: string[];
    firstSeen: number;
    lastSeen: number;
    /** Not seen by anyone for staleAfterMs: position and health are old. */
    stale: boolean;
    /**
     * Fighting the group: it targeted a member or a member's pet, swung, or one of them attacked it
     * within the last hostileMs. Sticky on purpose: a mob's target field flickers between snapshots.
     */
    threat: boolean;
    /** Start of the current hostile streak (0 when not a threat). */
    hostileSince: number;
    /** Crowd control a member put on it and the group leaves it to, until `until` (ms epoch). A root's ends when it can fight or when it stops holding. */
    cc: { by: string; kind: string; until: number } | null;
    /**
     * Until when each kind can't land on it (ms epoch; cc.ts): one held or the 60 s after one ended, or an answer from the
     * server ("immune", "already has that effect"). On the board for all: each kind goes by its own, whoever cast it.
     */
    ccImmune?: CcImmunity;
    /** What the server calls it in messages, once a member's cast landed: an enemy player's real name, not the race in `name`. */
    serverName?: string;
    /** A member's attack on it was answered `You can't attack a shadowed necromancer!`, so it can't be attacked before this (ms epoch): for a client with no models to go by, or anything isShade misses. */
    unattackableUntil?: number;
    /** Players: seen helping its own realm (Sighting.helped) since the group first saw it. Sticky: a healer to focus first. */
    healer?: boolean;
    /** Players: seen casting (Sighting.casting) since the group first saw it. Sticky: a caster, not a melee fighter. */
    caster?: boolean;
    /** Players: when it was last seen starting a cast. What an interrupt goes on (behaviors.ts interrupt). */
    castingAt?: number;
    /**
     * Players: its likely class, read as a human would from its race, gear, spells and styles, by every member, all the
     * contact's life and beyond (class-read.ts). `classes` most likely first, `role` once 60 % of the weight agrees.
     */
    classGuess?: ClassGuess;
}

export type Phase = 'idle' | 'gather' | 'travel' | 'recover' | 'pull' | 'engage' | 'retreat';

/** The coordinator's current plan. Members follow it; their own reactions come first. */
export interface Orders {
    /** Bumped on every material change (phase, focus, puller, cc, retreat point, anchor moved). */
    seq: number;
    phase: Phase;
    /** What the group is trying to do, in words ("hunt badger cubs around (296000, 640000)"). */
    objective: string;
    /** Rally point: where the group stands between pulls, or the next leg while travelling. */
    anchor: Point3 | null;
    /** Where pulls come from: the formation faces it. */
    facing: Point | null;
    /** Primary target everyone assists on. */
    focus: number | null;
    /** Who brings the focus to the anchor. */
    puller: string | null;
    /** Crowd-control assignments. */
    cc: { targetId: number; by: string }[];
    retreatTo: Point3 | null;
    /** Who the group is waiting for in gather/recover, and why ('health', 'power', 'dead', 'away'). */
    waiting: { name: string; why: string }[];
    /** While travelling: how far there is still to go in all, beyond the leg in `anchor`. */
    journey?: number;
    /**
     * While travelling with no enemy player near: walk as a column, not in slots round the anchor. `driver` (the crowd
     * controller) walks the leg at `speed` of full speed, the others stand `gap` apart behind him in `order`. Members not
     * in it walk to their slots. Null or absent: slots for everyone. The pack sets it (pack.column).
     */
    column?: ColumnOrder | null;
    /** An enemy player is known: casters take wider slots (TacticsSettings.spreadOnSight). The pack sets it. */
    spread?: boolean;
    /**
     * Overrides of every member's settings, key by key (shallow: a nested object such as `heal` or `formation` replaces the
     * member's whole value), read through MemberContext.settings from the next behaviour on. A decide sets it to change a
     * run-start setting mid-run, e.g. a formation or heal limits once the enemy's classes are read (Contact.classGuess);
     * null clears it. Keep the object the same while nothing changes: members rebuild their settings on a new object.
     * Not a material change: no seq bump, no interrupt.
     */
    settings?: Record<string, unknown> | null;
    /** Why the coordinator decided this (for the observer and the log). */
    reason: string;
    issuedAt: number;
}

export type OrdersUpdate = Partial<Omit<Orders, 'seq' | 'issuedAt'>> & { reason: string };

/** Orders.column: who leads, who follows in which place, how far apart, and the leader's share of full speed. */
export interface ColumnOrder {
    driver: string;
    order: string[];
    gap: number;
    speed: number;
}

/** The shared picture every member and the coordinator read. */
export interface GroupPicture {
    at: number;
    members: MemberReport[];
    contacts: Contact[];
    orders: Orders;
}

export interface GroupEvent {
    at: number;
    /**
     * 'orders' phase/focus changes, 'activity' a member started something, 'result' an
     * action's outcome (success/reason), 'death' a member died, 'kill' an enemy died,
     * 'level' a member levelled, 'note' free text.
     */
    kind: 'orders' | 'activity' | 'result' | 'death' | 'kill' | 'level' | 'note';
    // 'kill' data: { name, level, kind: 'npc' | 'player', realm, pet?: true }. 'death' data: { killer: { name, kind: 'npc' | 'player', realm, isPet?: true } | null }.
    // A 'note' with data { pet: 'lost', name, cause }: a member's window pet went, cause a PetLossCause or null.
    // A 'note' with data { petBrokeCc: true, kind, by }: a member's pet broke the cc `by` put on targetId.
    member?: string;
    targetId?: number | null;
    text: string;
    data?: Record<string, unknown>;
}

/** groups/<name>/group.json */
export interface GroupDefinition {
    name: string;
    /** Bot whose control connection a group script opens first (default: the first member). */
    leader?: string;
    members: { bot: string; role?: Role }[];
}
