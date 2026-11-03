// Group coordination contract: what members share (reports, sightings), what the
// coordinator decides (orders) and what the observer records (events).
//
// Everything here is plain JSON, so the same shapes can later travel between
// processes (a gateway channel) instead of living in one process's blackboard.

import type { Realm } from '../types';

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
    nuke: boolean;
    /** Buff spell names it can cast. */
    buffs: string[];
    /** The same buffs with slot, target and concentration (who buffs whom: buffs.ts). */
    buffSpells: BuffSpell[];
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
    /** It swung at someone or, a monster, landed a hostile spell on someone in the last ~2 s (a mezz on it is broken). */
    swinging: boolean;
    /** Monsters: whom its latest hostile spell effect landed on in the last few seconds. The server reports no target for a mob mid-cast. */
    spellTargetId?: number | null;
    /**
     * Players: it started a cast in the last few seconds (0x72 spell cast animation). The
     * server never sends an enemy player's target, so `targetId` for a player is inferred
     * from its latest melee swing or hostile spell effect on someone.
     */
    casting?: boolean;
    /** Players: it cast a spell on a player of its own realm in the last few seconds (a heal or buff). */
    helped?: boolean;
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
    /** `target` comes from its spell alone: a monster casting from where it stands. A taunt can take it off; running to the tank can't. */
    targetBySpell?: boolean;
    /** When it started targeting `target` (how long the tank has held it). */
    targetSince: number;
    /** When the coordinator first ordered engage with it as the focus; 0 until then. */
    engagedAt: number;
    /** The last sighting before engagedAt that kept the target while it ran (a carried pull); 0 if none. */
    movedAt: number;
    /** Members that see it in their latest snapshot. */
    seenBy: string[];
    firstSeen: number;
    lastSeen: number;
    /** Not seen by anyone for staleAfterMs: position and health are old. */
    stale: boolean;
    /**
     * Fighting the group: it targeted a member, swung, or a member attacked it within
     * the last hostileMs. Sticky on purpose: a mob's target field flickers between snapshots.
     */
    threat: boolean;
    /** Start of the current hostile streak (0 when not a threat). */
    hostileSince: number;
    /** Crowd control a member put on it, until `until` (ms epoch). */
    cc: { by: string; kind: string; until: number } | null;
    /**
     * A mezz can't land on it before this (ms epoch): a member's mezz got "Your target is immune to this
     * effect!" (a player is immune for a while after one ends). Nobody is assigned it meanwhile. A root's
     * immunity is the server's separate snare immunity and stays with the member who cast it.
     */
    ccImmuneUntil?: number;
    /** Players: seen helping its own realm (Sighting.helped) since the group first saw it. Sticky: a healer to focus first. */
    healer?: boolean;
    /** Players: seen casting (Sighting.casting) since the group first saw it. Sticky: a caster, not a melee fighter. */
    caster?: boolean;
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
    /** Why the coordinator decided this (for the observer and the log). */
    reason: string;
    issuedAt: number;
}

export type OrdersUpdate = Partial<Omit<Orders, 'seq' | 'issuedAt'>> & { reason: string };

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
    // 'kill' data: { name, level, kind: 'npc' | 'player', realm }. 'death' data: { killer: { name, kind: 'npc' | 'player', realm } | null }.
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
