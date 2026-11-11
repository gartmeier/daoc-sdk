// Bot SDK - porcelain layer (bot.*).
// Each method resolves its target, dispatches low-level sdk.send* actions and
// then OBSERVES evidence (position, HP, inventory, messages) before reporting
// success. Game failures come back as { success: false, reason } and never
// throw; only an execution abort (MCP cancel, runScript timeout) throws.

import { BotSDK, bestNameMatch, headingBetween, isAttackable, nameMatcher, type NamePattern } from './index';
import { abortable, executionContext, throwIfExecutionAborted, withExecutionDeadline } from './execution-context';
import {
    effectiveSpellRange,
    ABILITY_REFUSALS,
    ActionHelpers,
    ALREADY_CASTING,
    ATTACK_REFUSALS,
    BUY_REFUSALS,
    CAST_REFUSALS,
    conLevel,
    CROWD_CONTROL_REFUSALS,
    CROWD_CONTROLLED_RETRY_MS,
    diffInventory,
    sameItem,
    experienceFromMessages,
    INTERACT_REFUSALS,
    isFatalAttackRefusal,
    isCrowdControlled,
    isKillable,
    isPvpImmunity,
    ENRAGED_REFUSAL,
    FOLLOW_UP,
    isResistOf,
    isServantCast,
    isServantQueued,
    maxCombatEventId,
    PET_ANSWERS,
    PET_CAST_REFUSALS,
    PET_REFUSALS,
    PET_UNDER_CONTROL,
    petSpellKind,
    NO_INSTRUMENT,
    NOTHING_TO_REPAIR,
    parseMoneyText,
    PICKUP_REFUSALS,
    PLAYER_AIM_MS,
    AUTO_RELEASE_ARMED,
    AUTO_RELEASE_DISARMED,
    CORPSE_ONLY,
    PULSE_CANCELLED,
    PVP_IMMUNE_REFUSALS,
    PVP_IMMUNE_RETRY_MS,
    RANGED_IN_HAND,
    RELEASE_REFUSALS,
    REPAIR_ANSWERS,
    REPAIR_OFFER,
    REPAIR_REFUSALS,
    RESPEC_OFFER,
    RESPEC_REFUSALS,
    resurrectCost,
    RETRYABLE_ATTACK_REFUSALS,
    SELL_REFUSALS,
    SIT_REFUSALS,
    STYLE_NEEDS_WEAPON,
    STYLE_REFUSALS,
    slotHolding,
    spellMessagePattern,
    SUMMON_FAILURES,
    TRAIN_REFUSALS,
    TRAINER_WANTED,
    TRADE_COMMIT_FAILURES,
    TRADE_COMPLETED,
    TRADE_REFUSALS,
    USE_ITEM_REFUSALS,
    WEAPON_LINES,
    describeTarget,
    firstReasonLine,
    ATTACK_ONLY_REFUSALS,
    GROUND_TARGET_DROPPED,
    worstPowerCost,
    isFocusCaster,
    isDeadLineOf,
    mobInCombatLately,
    nameOf,
    TARGET_IS_DEAD,
    offMeshMessage,
    theName,
    totalCopper,
    type LivingTarget,
    type MessageWatch,
    type NpcTarget,
    type ObjectTarget,
    type PetSpellKind,
    type PlayerTarget,
    type ReasonLine,
    type Point,
} from './actions-helpers';
import { castRoom, mobRunInMs } from './mob-speed';
import { EquipmentSlot, isWeapon, ObjectType } from './types';
import { getDefaultPathProvider, type PathProvider } from './pathfinding';
import { groundTargetSnap } from './ground';
import { lineOfSight, terrainGround } from './vision';
import { isDelveOf, parseDelve } from './delve';
import { botFolder, loadBuild } from './build';
import { findNpcSpawns, getClass, getSpecialization, getSpell, getSpellLine, getSpells, getZonePoint, realmId, specKey, type NpcSpawnMatch, type SpellInfo, type ZonePoint } from '../data/index';
import { buildProblems, earnedSpecPoints, freeLevels, linesOverTarget, nextBuildStep, specCost, type BuildState } from '../data/builds/rule';
import type { Build } from '../data/builds/types';
import type {
    Effect,
    ActionResult,
    BotWorldState,
    DialogBox,
    ResurrectionOffer,
    GameMessage,
    GroupMember,
    InventoryItem,
    ItemBonus,
    MerchantItem,
    NearbyNpc,
    NearbyObject,
    NearbyPlayer,
    NpcDialog,
    PetAggression,
    PetCommand,
    PetLoss,
    PetState,
    PlayerState,
    Spell,
    Style,
    TradeWindow,
    Vec3,
    Specialization,
} from './types';

export { conLevel, conColor, isKillable, petSpellKind } from './actions-helpers';
export { parseDelve } from './delve';
export type { ConColor, LivingTarget, NpcTarget, ObjectTarget, PetSpellKind, PlayerTarget, Point } from './actions-helpers';
export { StraightLinePathProvider, NavmeshPathProvider, getDefaultPathProvider, setDefaultPathProvider, navmeshGroundZ } from './pathfinding';
export type { PathProvider, PathRequest, PathResult } from './pathfinding';
export { NavmeshStore, NavMesh, getNavmeshStore, PolyFlags } from './navmesh';
export { groundAt, GROUND_TUNING, type Ground } from './ground';
export { TerrainStore, getTerrainStore, type TerrainSample } from './terrain';

// Server ranges (world/WorldMgr.cs, GamePlayer.cs) and the margins we approach to.
const MELEE_APPROACH = 90;       // AttackRange 128 (+32 per moving side), 3D
const MELEE_RANGE = 128;
const MELEE_REAPPROACH = 118;
/** As far as a swing reaches with both of us moving. */
const MELEE_REACH = 160;
const INTERACT_APPROACH = 150;   // INTERACT_DISTANCE 192, 3D
const PICKUP_APPROACH = 150;     // world_pickup_distance 256, 2D
const MERCHANT_APPROACH = 150;   // GameMerchant.OnPlayerBuy 256
const GIVE_APPROACH = 100;       // GIVE_ITEM_DISTANCE 128, 3D
const WHISPER_APPROACH = 300;    // WHISPER_DISTANCE 512
const WHISPER_RATE_LIMIT = /^slow down! think before you say each word/i;
// NPCs silently ignore a whisper < 1500 ms after the last one they accepted
// from the player (GameLiving.WhisperReceive); < 500 ms gets "Slow down!".
const WHISPER_SPACING_MS = 1600;
/** Gap between bot.say calls (the server drops says < 500 ms apart, say.cs:49-53). */
const SAY_SPACING_MS = 600;
const DEFAULT_SPELL_RANGE = 1500;
/** The server's next ticks past a cast's end, before a new cast is no follow-up any more. Its 0x72 reaches us after it starts, so the end we work out is on the late side of the tick already. */
const CAST_END_MARGIN_MS = 100;
/** "Already casting" with no running cast of ours to read (a 0x72 gone from the list): what to go by. */
const ALREADY_CASTING_UNREAD_MS = 1000;
/** What the server holds begins a tick or two past the running cast's end, and that shows a snapshot later. With no begin by then, it went with a running cast that failed its end check: no line and no 0x0B (SpellHandler.cs:1091-1097, CastingComponent.cs:196, :224-228). */
const FOLLOW_UP_BEGINS_MS = 500;
/** A refused attack order's line comes a snapshot or two behind the order. */
const PET_ORDER_ANSWER_MS = 500;
/** A cast's begin line can trail another line by a snapshot. */
const BEGIN_LINE_TICK_MS = 250;
/** How far inside a spell's range castSpell's walk stops: the smaller of this share of the range and SPELL_WALK_MARGIN. A mob that moves on from there gets the server's "too far away", and the caller goes again (SPELL_WALK_NEARER_SHARE). */
const SPELL_WALK_SHARE = 0.1;
const SPELL_WALK_MARGIN = 150;
/** After that "too far away" the next walk at the same target stops short by as much again as the target leaves in a cast, by our own readings, and at most at this share of the range, for this long or until a cast at it lands: from the margin again it failed again, for as long as the target walked. */
const SPELL_WALK_NEARER_SHARE = 0.5;
const SPELL_TOO_FAR_MS = 30_000;
/**
 * After "You can't see your target" (the client's honest LoS answer, sdk/vision.ts): the farthest castSpell steps toward
 * the target, in SIGHT_STEP_SAMPLE steps, for a spot it sees it from over the terrain, keeping SIGHT_STEP_KEEP off it.
 */
export const SIGHT_STEP_MAX = 800;
/**
 * With `approach: false` (a member holding its ground) the step is at most this long, and only to a spot that sees the
 * target, like the group's standStep into range. Live, arena round 141: Hrafna's held nukes got 68 refusals in 144 checks.
 */
export const SIGHT_STEP_SHORT = 300;
const SIGHT_STEP_SAMPLE = 100;
const SIGHT_STEP_KEEP = 150;

/**
 * Where to step after a cast refused for sight: the first point every SIGHT_STEP_SAMPLE units along the straight line
 * toward `to` (up to `max`, staying SIGHT_STEP_KEEP off it) from which `to` is in sight over the terrain, else the
 * farthest of them, or null with `clearOnly`. Null too when there is no room for a step.
 */
export function sightStep(regionId: number, from: Vec3, to: Vec3, ground: (regionId: number, x: number, y: number) => number | null = terrainGround, max = SIGHT_STEP_MAX, clearOnly = false): Vec3 | null {
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const reach = Math.min(max, d - SIGHT_STEP_KEEP);
    let spot: Vec3 | null = null;
    for (let s = SIGHT_STEP_SAMPLE; s <= reach; s += SIGHT_STEP_SAMPLE) {
        const x = from.x + ((to.x - from.x) * s) / d, y = from.y + ((to.y - from.y) * s) / d;
        spot = { x, y, z: ground(regionId, x, y) ?? from.z + ((to.z - from.z) * s) / d };
        if (lineOfSight(regionId, spot, to, ground)) return spot;
    }
    return clearOnly ? null : spot;
}
/** What a replace wants left of a charm's range: the server measures at the end of the cast, in 3D, from its own positions (SpellHandler.cs:941-945). Live, readings of 994 and 999 of 1000 lost the pet, and 989 and 997 went. */
const CHARM_REPLACE_MARGIN = 60;
/** A roaming mob's speed (StandardMobState.cs:141, NpcMovementComponent.cs:18), and a little over: a replace that has to walk anyway goes where one roaming away through the whole cast stays in range. */
const MOB_ROAM_SPEED = 70;
const CHARM_WALK_SLACK = 20;
/** spell_self_interrupt_duration, the wait a broken cast leaves (SpellHandler.cs:372, GameLiving.cs:740, ServerProperties.cs:2221-2222). */
const INTERRUPT_RETRY_MS = 2200;
/** How long a song refused for its instrument is worth leaving: only a change of hand cures it, and every try is a failed turn. */
const NO_INSTRUMENT_RETRY_MS = 60_000;
/** How long the next snapshot can take: they come about 250 ms apart. */
const SNAPSHOT_GAP_MS = 300;
/** Amnesia's line (Effects.txt:17): it ends a cast with no 0x0B and no line of the cast's own, and leaves a song alone (AmnesiaSpellHandler.cs:49-50). */
const CAST_WIPED = /^your mind goes blank/i;
/** A mezz's or a stun's line (spell.sql), which comes beside the 0x0B that ends a cast (CrowdControlECSEffect.cs:26): that is why it ended, and the next cast would only be refused for it. */
const HELD_LINE = /^you are (?:mesmerized|entranced|stunned)\b/i;
/** An item's recast (GamePlayer.UseSlot): a useItem's answer, whatever it has running. */
const ITEM_RECAST = /to discharge this item/i;
/** A spot in no zone of any region: the server has no plain clear, and this wipes what stands (Unset, PlayerGroundTargetHandler.cs:21-33, :72-73). */
const NO_ZONE_SPOT = { x: 1, y: 1, z: 1 };
/** GamePlayer.Attack.AlreadyDead, at a swing (AttackComponent.cs:1712). */
const ALREADY_DEAD = 'is already dead';
/** A 0xDD to an object has toSlot = 1000 + objectId (PlayerMoveItemRequestHandler.cs:20-23). */
const GIVE_TO_OBJECT = 1000;
/** No target has this many lines: a trainBuild past it isn't getting anywhere. */
const TRAIN_BUILD_MAX_STEPS = 32;
/** eInventorySlot.GeneralVault: the server picks an empty slot on the other side, or a partial stack (PlayerMoveItemRequestHandler.cs:306-337). A full side fails without a word. */
const GENERAL_VAULT_SLOT = 601;
/** Personal vault slots 110-149. */
const VAULT_SLOTS = 40;
/** CommandNpcAttack refuses a target farther than this from us, in 3D (GamePlayer.cs:12185). */
const PET_ORDER_RANGE = 2000;
/** Where petKill stops when it has to walk up to order the pet. */
const PET_ORDER_APPROACH = 1500;
/** The least of that left on the plane, with the mob far above or below us. */
const PET_ORDER_APPROACH_MIN = 300;
/** A mob this far above or below us: PET_ORDER_APPROACH would take us most of the way to under it, up a slope too, so the walk goes by the order's real reach. */
const PET_ORDER_HIGH = 1000;
/** After a refused order the walk comes this much nearer than what we read then, at least: that reading was no good. */
const PET_ORDER_RETRY_NEARER = 100;
/** That reach, on the reading, with a margin for one on the move: GamePlayer.cs:12185 measures in 3D, and a refused first order costs a walk. */
const PET_ORDER_HIGH_REACH = 1900;
/**
 * Where a shade stops to order its servant, and how near a step brings it. The tether runs from us, 1500 for 10 s and 2000 at once
 * (NecromancerPetBrain.cs:300-326), and the servant fights at the mob: the order's own range would lose it.
 */
const SHADE_ORDER_APPROACH = 1000;
/** A shade steps toward its servant when it is farther off than this: in time, short of the tether. */
const SHADE_STEP_BEYOND = 1200;
/** The longest one such step keeps petKill from looking at the fight. */
const SHADE_STEP_MS = 1500;
/** NecromancerPetBrain.cs:300: a servant lost from farther off went to the tether. */
const SHADE_TETHER = 1500;
/** What a servant's death leaves its owner at: Math.Max(10, the pet's %), and a dead pet's is 0 (ClassDisciple.cs:149). */
const SHADE_DEATH_HEALTH = 10;
/** How long the server gets to answer a pet order. */
const PET_ANSWER_MS = 3000;
/** How long a new pet's or an order's state gets to show in the snapshots once the server said so. */
const PET_SETTLE_MS = 500;
/** Order the pet again once the model has had it off the target this long, and no sooner: the model holds the target through a run-in and between casts, and a repeat is a no-op to the server (ControlledMobBrain.cs:216-217) but gets a line each. */
const PET_REORDER_MS = 5000;
/**
 * A pet standing this long off its target with nothing going on isn't getting there. With no way on the server moves mobs, and pets following their owner, but not a pet with a target
 * (NpcMovementComponent.cs:594-600, :710-735): that one stays in attack state, reading 0xFFFF for good (PacketLib168.cs:820-828). Longer than a pet's cast and the wait for the next.
 */
const PET_STUCK_MS = 8000;
/** How long a turret's target stays beyond its reach, in a fight, before that ends the fight: one at the edge steps in and out. */
const TURRET_BEYOND_MS = 2000;
/** A pet nearer its target than this is at it. */
const PET_STUCK_RANGE = 200;
/** A pet that has moved less than this is on the same spot. */
const PET_STUCK_MOVED = 16;
/** How long a cast refused with pet_exists waits for the close when we know of no pet. */
const PET_CLOSE_MS = 1000;
/** A kill's timeout unless it says otherwise. */
const DEFAULT_KILL_TIMEOUT_MS = 60_000;
/** How long a dispatched selection gets to show in the snapshots: live about 11 ms. */
const TARGET_SETTLE_MS = 500;
/**
 * How long a hit on us counts against a cast with a cast time. It holds none back: with hard_interrupt_on_attacked off only our own timer does (ServerProperties.cs:2215, AttackerTracker.cs:154-161), a swing's or a broken cast's. Its own timer, still running at the cast's half way, interrupts it, and that sets ours for 2.2 s (SpellHandler.cs:356-372).
 * That timer is the attacker's swing interval, which we can't read (AttackComponent.cs:1110), or spell_interrupt_duration for a spell: this.
 */
const HIT_INTERRUPT_MS = 3000;
/** How long the server gets to answer the use of a melee slot. */
const HAND_SWITCH_MS = 1000;
/** How long after its loss a hurt ex-pet counts as our doing, not someone else's fight. */
const EX_PET_MS = 10_000;
/** How long the server gets to drop a ground target it won't take. */
const GROUND_TARGET_ANSWER_MS = 300;
/** What we allow for the server moving a spot it takes: ground_target_snap_max_distance, and so its usual move and more. That is the half size of its search box, no limit: with a mesh loaded groundTargetSnap says where the spot goes (PlayerGroundTargetHandler.cs:63-85, LocalPathfindingMgr.cs:341-349). */
const GROUND_TARGET_SNAP = 16;
/** A turret's reach when its spell can't be told (TurretBrain.cs:9-18; spell.sql has its sub-spells at 1000, a tank's taunt at 1350). */
const TURRET_RANGE = 1000;
/** The most a rest goes for a summon that lacks power: every summon costs 10-25 % of the pool (spell.sql), a focus caster's 120 % of that with no focus item. */
const PET_SUMMON_MANA = 60;
/** Power a rest for a summon goes for over the most it can cost (worstPowerCost). */
const PET_SUMMON_MANA_MARGIN = 5;
/** grind stops after this many summons in a row that failed for lasting reasons. */
const PET_SUMMON_ATTEMPTS = 3;
/** How long grind waits before it tries a summon again. */
const PET_SUMMON_RETRY_MS = 3000;
/** How near a mob from an unfinished fight has to be for grind to go back to it before any other: as far as a chase goes (killNpc's maxChaseDistance). */
const GRIND_FOE_RANGE = 2500;
/** A kill that fails sooner than this has spent no time: grind waits this long before its next pass, or the same mob could come straight back. A rest that ends sooner has waited for nothing. */
const GRIND_RETRY_MS = 1000;
/** A mob on us farther off than this hasn't arrived, so with a pet up we stand off until then, and a pass with the pet ends as it does. A summon goes by what the mob covers by the cast's half way (castRoom). */
const GRIND_SUMMON_ROOM = 250;
/** The least a melee pass lasts while grind wants a pet, whatever the summon's timer says. Stopping and starting costs no swing: the server keeps when the next one is due (AttackAction.cs:54). */
const GRIND_MELEE_PASS_MS = 3000;
/** A mob on us below the summon's room with no speed yet, for grind: a turn after a hit, or a caster mob that means to stand. This long before we go to it. */
const GRIND_LET_COME_MS = 1000;
/** How often grind looks at a mob it lets come. */
const GRIND_LET_COME_LOOK_MS = 250;
/** What counts as running at us: the heading within this of the way to us (0..4095 is a whole turn), so about 45 degrees. */
const GRIND_CLOSING_ARC = 512;
/** How long a hit of ours names a mob with no target reading as pulled by us: a run-in from 1500 at its slowest. */
const GRIND_PULLED_MS = 10_000;
/** A fight's mob below this percent when the overrun is up gets GRIND_FINISHING_MS more, once: under 1 % it reads 0, for seconds before it goes (GameLiving.cs:2621). */
const GRIND_FINISHING_PERCENT = 5;
const GRIND_FINISHING_MS = 10_000;
/** How long past the N it names an armed release gets before we ask again. Its timer looks once a second (GamePlayer.cs:1722-1731), and by then no request can cancel it. */
const AUTO_RELEASE_MARGIN_MS = 2000;
/** eInventorySlot.PlayerPaperDoll: the server picks the item's own equipment slot (PlayerMoveItemRequestHandler.cs:28). */
const PAPER_DOLL_SLOT = 100;
/** What the server says when a slot won't take an item (GamePlayerInventory.cs CheckItemSlotRestriction). */
const MOVE_REFUSALS = [/you can't|you cannot|you are not|you must|can't go there|you have no skill/i];
/** Server dialog code for a group invite (PacketLib168.SendGroupInviteCommand). */
const GROUP_INVITE_DIALOG = 0x05;
/** Bound on one route plan when walkTo has no explicit timeout (its deadline follows the plan). */
const PLAN_TIMEOUT_MS = 15_000;

// ── Result / option types ───────────────────────────────────────────────────

export interface WalkOptions {
    /** Destination height; default: the navmesh ground where the zone has a mesh, else estimated from static data (by the path provider). */
    z?: number;
    /** Arrival radius on the ground plane (default 64). */
    tolerance?: number;
    /** Overall deadline in ms, planning included (default: 1.5 × ETA along the planned route + 15 s, extended when a correction re-plans a longer route). */
    timeout?: number;
    /**
     * Route planner (default getDefaultPathProvider(): NavmeshPathProvider when meshes are built
     * with bun run navmesh:build, else StraightLinePathProvider; DAOC_NAVMESH=off forces straight lines).
     */
    pathProvider?: PathProvider;
    /** Fraction of max speed (default 0.9, the mover's safe cap). */
    speedFactor?: number;
    /** Fail after this long without getting closer (default 8000 ms). */
    stuckMs?: number;
    /**
     * Cancelled (an abort): whether to stop the mover, read at that moment (default: always). False leaves it running
     * toward this walk's end, for a caller that sends the next move at once and wants no brake in between (a group
     * member's slot walk while the travel legs go on, sdk/group/travel.ts).
     */
    stopOnAbort?: () => boolean;
}

export interface RepairResult extends ActionResult {
    /** What was handed over; null for repairAll. */
    item: InventoryItem | null;
    /** The same item as it is now; null for repairAll. Its `condition` is a percent rounded up, so 100 can still hide wear. */
    repaired: InventoryItem | null;
    /** Copper the purse lost. */
    cost: number;
    messages: GameMessage[];
}

export interface VaultResult extends ActionResult {
    keeper: NearbyNpc | null;
    items: InventoryItem[];
}

export interface WalkResult extends ActionResult {
    position: Vec3 | null;
    /** Remaining 2D distance to the destination. */
    distance: number;
    /** Times the move was re-issued after a server correction or stop. */
    reissues: number;
}

export interface WalkToObjectOptions {
    /** Required 3D distance to the target (default 100). */
    range?: number;
    /** The whole walk, however often the target moves on (default: each leg's own, see WalkOptions). */
    timeout?: number;
}

export interface WalkToObjectResult extends WalkResult {
    target: NearbyNpc | NearbyPlayer | NearbyObject | null;
    /** With reason already_dead: the target died during this walk, or just before it with its id gone. It says nothing against the walker. */
    targetDied?: true;
}

export interface FaceResult extends ActionResult {
    heading: number;
}

export interface TargetResult extends ActionResult {
    target: NearbyNpc | NearbyPlayer | NearbyObject | null;
}

export type InteractResponse = 'merchant' | 'dialog' | 'dialogBox' | 'textWindow' | 'trainer' | 'vault' | 'message';

export interface InteractOptions {
    /** Walk until within this 3D distance first (default 150; the server allows 192). */
    range?: number;
    /** How long to wait for a response (default 4000 ms). */
    timeout?: number;
}

export interface InteractResult extends ActionResult {
    target: NearbyNpc | NearbyPlayer | NearbyObject | null;
    response: InteractResponse | null;
    dialog: NpcDialog | null;
    /** Messages that arrived in response. */
    messages: GameMessage[];
}

export interface DialogResult extends ActionResult {
    npc: NearbyNpc | null;
    dialog: NpcDialog | null;
    /** [keywords] in the newest dialog text. */
    keywords: string[];
    text: string;
    messages: GameMessage[];
}

export interface RespondDialogResult extends ActionResult {
    dialog: DialogBox | null;
}

export interface AttackResult extends ActionResult {
    /** The target when it is an NPC (null for a player). */
    npc: NearbyNpc | null;
    /** The resolved target, NPC or player. */
    target: NearbyNpc | NearbyPlayer | null;
    /** For reason 'immune' (PvP immunity, ours or the target's) and 'crowd_controlled' (we are mezzed or stunned): ms until trying again makes sense. */
    retryAfterMs?: number;
}

/**
 * A style for the next swing by name, or two: the server keeps a first style and a backup, and at the
 * moment of the swing uses the first if its opening is met, else the backup. Null for a plain swing.
 */
export type StyleChoice = string | readonly string[] | null | undefined;

/** Send a style choice again after this long without a swing, in case the last one never reached the queue. */
const STYLE_RESEND_MS = 5000;

/** The styles a choice names, at most the two the server keeps, each once. */
export function styleQueue(choice: StyleChoice, styles: Style[]): Style[] {
    const names = typeof choice === 'string' ? [choice] : choice ?? [];
    const found = names.map(n => bestNameMatch(styles, n)).filter((s): s is Style => !!s);
    return [...new Set(found)].slice(0, 2);
}

/** Choose the style or styles for the next swing. `target` repeats `npc`. */
export type StyleChooser = (ctx: { npc: NearbyNpc; target: NearbyNpc; player: PlayerState; state: BotWorldState; styles: Style[] }) => StyleChoice;

/** killPlayer's style chooser. One that takes `{ target: NearbyNpc | NearbyPlayer, ... }` fits killNpc as well. */
export type PlayerStyleChooser = (ctx: { target: NearbyPlayer; player: PlayerState; state: BotWorldState; styles: Style[] }) => StyleChoice;

export interface KillOptions {
    /** Give up after this long (default 60000 ms). */
    timeout?: number;
    /** Style names to rotate through, one per swing (endurance permitting). */
    styles?: string[];
    /** Pick the style, or a style and its backup, per swing instead of rotating `styles`. */
    useStyle?: StyleChooser;
    /** Follow a target that moves away (default true). */
    chase?: boolean;
    /** Stop chasing a target that has moved this far on the ground plane from where it stood when the fight began (default 2500). How far off it stands doesn't count: one that hasn't moved isn't running. */
    maxChaseDistance?: number;
    /** Allow NPCs isKillable() rejects (realm NPCs, peaceful flags) (default false). An enemy realm's pet needs no force. */
    force?: boolean;
    /**
     * Order a window pet that isn't passive onto the target too (default true). It wouldn't join by itself: it only answers a hit on us (GamePlayer.cs:5152-5153). A group run another controller took a member from can leave one passive (setPetAggression).
     * In shade the pet does all of it, as petKill. False there is reason 'refused': a shade can't melee.
     */
    usePet?: boolean;
    /**
     * End the fight, reason 'pet_died' as petKill's, as soon as the window pet we had at its start is gone, for a caller with something to do about that (default false: we fight on, and nothing looks at the pet). The swing stops with it, as at any end of the fight, and starting it again costs nothing (AttackAction.cs:54).
     */
    endOnPetLoss?: boolean;
}

export interface KillResult extends ActionResult {
    /** The target's entry as the fight ended; once it has gone, the one the fight began with. */
    npc: NearbyNpc | null;
    killed: boolean;
    /** All the XP gained during the fight: another kill of ours in that time counts too, a fire-and-forget pet's say. */
    xpGained: number;
    rpGained: number;
    moneyGained: number;
    itemsGained: InventoryItem[];
    durationMs: number;
    levelsGained: number;
    stylesUsed: number;
    /** For reason 'immune' (PvP immunity, ours or the target's) and 'crowd_controlled' (we are mezzed or stunned): ms until trying again makes sense. */
    retryAfterMs?: number;
    /** For reason 'attacked': the mob on us. */
    attacker?: NearbyNpc;
}

/** killPlayer's options: KillOptions' timeout, styles, chase and maxChaseDistance, with a style chooser for players. */
export interface KillPlayerOptions extends Omit<KillOptions, 'useStyle' | 'force' | 'usePet'> {
    /** Pick the style per swing instead of rotating `styles`. */
    useStyle?: PlayerStyleChooser;
}

/**
 * KillResult's numbers for an enemy player. A player kill gives realm points: rpGained counts
 * those that arrived by the time the death did (killPlayer does not wait for the award).
 */
export interface KillPlayerResult extends Omit<KillResult, 'npc'> {
    player: NearbyPlayer | null;
}

export interface ResurrectOptions {
    /** The rez to cast; default our strongest (resurrectSpell). */
    spell?: Spell;
    /** How long to wait for the target's answer once the cast is done (default 16 s: its question expires after 15 s). */
    answerMs?: number;
    /** Walk into range (default true). */
    approach?: boolean;
}

export interface ResurrectResult extends ActionResult {
    spell: Spell | null;
    target: NearbyPlayer | null;
    /** The cast itself. A finished cast only asks the target. */
    cast: CastResult | null;
}

export interface AcceptResurrectionResult extends ActionResult {
    offer: ResurrectionOffer | null;
}

export interface CastOptions {
    /** Walk into range first (default true). */
    approach?: boolean;
    /** Spell range override (default: data spell range, else 1500). */
    range?: number;
    /** Wait for this long beyond the cast time for completion (default 2500 ms). */
    timeout?: number;
    /**
     * Re-select the target and cast once more on "You must select a target" (default true). Only
     * when the refusal came before the cast began and the target is still the one we chose: no
     * death since we selected it and the same name under its ID (the server hands a dead mob's ID
     * to the next spawn). Otherwise the result keeps reason 'no_target' and its message ends in
     * " (target gone, not retried)".
     */
    retryNoTarget?: boolean;
}

export interface CastResult extends ActionResult {
    spell: Spell | null;
    /**
     * As it read before the cast: a charmed mob here still has no realm, the pet's entry has its new one. For a Group spell only what was selected: it lands on us and our group whatever that is (SpellHandler.cs:1747-1761).
     */
    target: NearbyNpc | NearbyPlayer | NearbyObject | null;
    /** The real cast time, from the server's animation (0x72). Null when it sent none: an instant spell, or a cast begun right after a jump such as a respawn, when that goes by who is around us and we aren't yet (SpellHandler.cs:1266-1275). */
    castTimeMs: number | null;
    /** The server reported the cast finished ("You cast a <spell> spell!", or an effect, damage or resist once the cast time is up). False with `queued`. */
    completed: boolean;
    /**
     * A servant's spell that all we know of is "will begin casting this spell after its current action is finished" (AI.txt:4): paid, and not yet cast. It holds
     * its current spell and one more, the last wins, and each one dropped was paid for, with no line about it (NecromancerPetBrain.cs:124, CastingComponent.cs:383-386). Cast again only after "cast a X spell!".
     */
    queued?: true;
    /**
     * A resist line naming the target (a player's has the real name, so any name counts there: we know enemies by race), with our own 0x1B at it
     * within 250 ms and no pet's 0x1B nearer: a pet's resist reads the same (SpellHandler.cs:2390, :2446-2456). Always false for a summon, which can't be resisted (SummonSpellHandler.cs:195), and a Self spell.
     */
    resisted: boolean;
    /**
     * The cast went off (success, power spent) but its effect did not land: "Your target is immune to
     * this effect!" (CCSpellHandler.cs:173/288, SpellHandler.cs:571). A player already mezzed or stunned,
     * or within the 60 s immunity that follows one (CrowdControlECSEffect.cs), an NPC's mezz immunity, a
     * snare immunity. `resisted` stays false: the target did not resist, nothing could have landed. So too a mezz at an NPC under
     * 75 % health, "Your target is enraged and resists the spell!" (CCSpellHandler.cs:174-178), which the message reads as `(target enraged)`: the same branch, words apart.
     */
    effectImmune?: boolean;
    /** With reason already_dead: our target died during this cast, or on the walk to it, or its id was gone just after its death: those two with no cast at all. Nothing landed and nothing was paid, and it says nothing against the caster: it is the fight's end. */
    targetDied?: true;
    /** With reason must_wait: the server holds this spell as the follow-up of the cast still running ("You prepare this spell as a follow up!"), and starts it by itself after retryAfterMs, unless another replaces it or that cast fails at its end (its target gone, say), which drops it without a word. This long is its own cast time. */
    followUpMs?: number;
    /**
     * The cast went off but the server refused the effect: "{0} already has that effect. Wait until it expires. Spell
     * failed." The same spell is still on a player (EffectListComponent.cs:689), as for a second root while one holds.
     */
    alreadyOn?: boolean;
    /**
     * Whether the server said its effect landed: the spell's own line for that ("{0} is entranced!", Message2), sent to the
     * caster. false when the spell has one and it never came, undefined when it has none. A monster's repeat replaces the
     * old effect without a word (ECSGameEffect.cs OnEffectStartsMsg).
     */
    effectLanded?: boolean;
    /** The name in that line: an enemy player's real name, which its race-named entry in the world state never shows. */
    landedOn?: string;
    /**
     * Damage from "You hit X for N damage!" / "Your <this spell> hits X for N damage!" lines that
     * arrived once the cast time was up. Other spells' DoT ticks and "extra damage" lines are left
     * out; a damage shield's "You hit X for N damage!" in the same moment cannot be told apart. Always 0 for a summon. A bomber's
     * hit comes when it arrives, up to 4 s later, and reads like any other (BomberBrain.cs:25-30): watch the mob's health for it.
     */
    damage: number;
    messages: GameMessage[];
    /** For reason 'must_wait' / 'interrupted' / 'immune' / 'crowd_controlled': ms until casting is allowed again ("You must wait N seconds"). For reason 'refused', a song with no instrument in hand only: 60 s, as only a change of hand cures it. */
    retryAfterMs?: number;
}

export interface SummonPetOptions extends CastOptions {
    /** The spell's target: a Theurgist's pet, a bomber and a charm take an enemy. Default: the current target. */
    target?: ObjectTarget | null;
    /**
     * Set this ground target first: an Animist's turrets stand on it (SummonAnimistPet.cs:21-40). It must be in the spell's range.
     * Without z the client snaps it to its terrain, under a river the mesh's plane there (else our own height); a z passed goes out as given. The server drops a spot
     * over 16 units off the mesh (PlayerGroundTargetHandler.cs:21-30, :63-85): reason refused. An NPC's coordinates are always valid. That drop wipes the ground target we had as well, and nothing puts it back. With `replace` a spot with no z that its height puts out of range is refused after it was set, and the ground target we had goes back; with none before, the refused spot is wiped too, so a later summon with no spot reads no_ground_target.
     */
    groundTarget?: Point;
    /**
     * Release the window pet we have and wait for the close first: until then the server refuses (default false: reason 'pet_exists').
     * A fire-and-forget pet or a minion replaces nothing. The pet stays when the new cast can't go: the spell's cooldown, power below the most
     * it can cost (a focus item we can't see may lower the real cost, so this can refuse what would go: releasePet by hand goes on regardless), melee for a spell with a cast time (reason in_combat: a mob on us,
     * a mob on the pet near enough to swing at us by the cast's half way, 220 units/s (faster if it reads so) and 250 more, about 910 for 6 s, as the release turns it on us (StandardMobBrain.cs:569-570, CharmECSEffect.cs:87-95), our swing on, a swing of ours within its weapon's interval, which holds the cast back, or a hit on us under 3 s ago, which can interrupt it at its half way, SpellHandler.cs:356-372, :603-620; releasePet by hand goes on regardless), for a turret a ground target
     * that is missing, out of range, within 16 of the range or put beyond it by the mesh where one is loaded (the server moves a spot to the nearest walkable ground, then measures in 3D), or dropped, and for a charm a mob that can't be taken, with the walk to it before the release.
     * In shade the release costs health: PlayerState.isShade.
     */
    replace?: boolean;
    /** How long after the cast the pet gets to appear (default 3000 ms). */
    appearTimeout?: number;
}

/** SummonPetOptions without the target, which charmPet takes itself. */
export interface CharmPetOptions extends Omit<SummonPetOptions, 'target' | 'groundTarget'> {
    /** This charm and no other (default: the best known, then the next when the mob is of the wrong type). */
    spell?: NamePattern;
}

export interface SummonPetResult extends CastResult {
    /** Its NPC entry: the window's, or else the one named by the "under your control" line. Null for a silent summon (a bomber) or when it isn't in view yet. */
    pet: NearbyNpc | null;
    /** Null for a pet the window doesn't list: a fire-and-forget pet or a minion. */
    petState: PetState | null;
}

export interface PetCommandOptions {
    /** How long the server gets to answer (default 3000 ms). */
    timeout?: number;
}

export interface ReleasePetOptions extends PetCommandOptions {
    /** One pet of ours with no window to release: a selected fire-and-forget turret or a minion, which the server accepts (CharacterClassBase.cs:336-341). Default: the window pet. */
    target?: NpcTarget | null;
}

/** A pet order that selects a target first. */
export interface PetTargetOptions extends PetCommandOptions {
    /** Select our previous target again afterwards (default false). The order moves our target, and our own melee reads it on every swing (AttackAction.cs:84). */
    restoreTarget?: boolean;
}

export interface PetCommandResult extends ActionResult {
    command: PetCommand;
    /** Its NPC entry; null when out of view. After a release as it reads then: null when it has gone, or a charm's ex-pet. */
    pet: NearbyNpc | null;
    /** As the server has it after the order; null without a window. */
    petState: PetState | null;
    messages: GameMessage[];
}

export interface PetAttackResult extends PetCommandResult {
    target: NearbyNpc | NearbyPlayer | null;
    /** For reason 'immune' (PvP immunity, ours or the target's): ms until trying again makes sense. */
    retryAfterMs?: number;
}

export interface PetKillOptions {
    /** Give up after this long (default 60000 ms). The pet keeps its order: setPetAggression('passive') calls it off; petFollow only drops the order, and a defensive pet hits back while the mob stays on it. */
    timeout?: number;
    /**
     * Walk within range of an order when the target is beyond it (2000 units from us, not from the pet), or when the server refuses a first order as out of range; never into melee (default true). A turret's owner doesn't walk.
     * A shade walks within 1000 and steps after its servant during the fight, for the tether. False: no walking at all, and the tether is the caller's to mind.
     */
    approach?: boolean;
    /** Fight on while another mob is on us (default false: reason 'attacked'). An ordered pet won't turn to help (ControlledMobBrain.cs:549-552). */
    ignoreAttackers?: boolean;
    /** End the wait as soon as the target stands this near us, reason 'arrived', for a caller with something to do then: grind's melee as a mob on us gets here. The pet keeps its order. Default: no such end. */
    endWithin?: number;
    /** As endWithin, once the target reads on us as well: a pass with the mob on the pet, for a caller who can swing when it turns. Default: no such end. */
    endOnUsWithin?: number;
}

export interface MeleeSlotResult extends ActionResult {
    /** The slot used, 10 or 12; null when no slot fits, or `keepOnTie` left the hand alone (success). */
    slot: number | null;
}

export interface SkillUseResult extends ActionResult {
    name: string;
    messages: GameMessage[];
}

export interface StealthResult extends ActionResult {
    /** Hidden after the call, as the server last said. */
    stealthed: boolean;
    /** With reason `cooldown`: when the server lets the next toggle through. */
    retryAfterMs?: number;
    messages: GameMessage[];
}

/** StealthSpecHandler.cs and GamePlayer.Stealth's refusals (language/EN/Ability.txt:167-174). */
const STEALTH_REFUSALS: readonly [RegExp, string][] = [
    [/too close to an enemy to hide/i, 'enemy_near'],
    [/been in combat recently and can't hide/i, 'in_combat'],
    [/must end your current action before hiding/i, 'busy'],
    [/must wait (\d+) more second to attempt to hide/i, 'cooldown'],
    [/can't hide while (stunned|mesmerized)/i, 'crowd_controlled'],
    [/can't hide when dead/i, 'dead'],
    [/pulsing spell effect and cannot hide|can't stealth while/i, 'refused'],
];
const NOW_HIDDEN = /^You are now hidden!/i;
const NO_LONGER_HIDDEN = /^You are no longer hidden!/i;
/** The server takes a toggle no sooner than 2 s after the last (StealthSpecHandler.cs:35-41). */
const STEALTH_TOGGLE_MS = 2000;

export interface FindKillableOptions {
    /** NPC name filter. */
    pattern?: NamePattern;
    /** Max npc.level - player.level. */
    maxLevelDiff?: number;
    /** Min npc.level - player.level. */
    minLevelDiff?: number;
    /** Con range (-3 grey .. 3 purple; default -2 green .. 0 yellow; grey gives no XP). */
    minCon?: number;
    maxCon?: number;
    /** Max 2D distance from `from` (default 2500). */
    radius?: number;
    /** Measure radius from here (default: the player). */
    from?: Point;
    /** Object ids to skip. */
    exclude?: Iterable<number>;
    /** Also return NPCs already fighting someone else (default false). */
    includeEngaged?: boolean;
}

export interface LootOptions {
    /** 2D search radius (default 500). */
    radius?: number;
    /** Overall deadline (default 20000 ms). */
    timeout?: number;
    /** Wait this long first so autoloot can finish (default 800 ms). */
    settleMs?: number;
}

export interface LootResult extends ActionResult {
    picked: string[];
    skipped: { name: string; reason: string }[];
    itemsGained: InventoryItem[];
    moneyGained: number;
    messages: GameMessage[];
}

export interface RestOptions {
    /** Stand when health reaches this (default 90). */
    healthPercent?: number;
    manaPercent?: number;
    endurancePercent?: number;
    /**
     * Not done until our window pet's health reaches this as well, also with our own health full, as a shade's stays. Ignored with no pet, or none
     * in view. It regains whether we sit or not. Live: after a fight its first real tick comes in anything up to about 37 s, the last in-combat one being 30 s off (GameLiving.cs:2448), then about 10 % per 6 s for most pets, in whole points; the top Necromancer's servant about 0.2 % a second, a low one more, and a Regenerate line heals about 6 % per 3 s for 12 s.
     */
    petHealthPercent?: number;
    timeout?: number;
}

export interface RestResult extends ActionResult {
    healthPercent: number;
    manaPercent: number;
    endurancePercent: number;
    durationMs: number;
}

export interface RespawnResult extends ActionResult {
    position: Vec3 | null;
    regionId: number | null;
}

export interface ItemResult extends ActionResult {
    item: InventoryItem | null;
    messages: GameMessage[];
}

export interface MerchantDelveResult extends Omit<DelveResult, 'item'> {
    item: MerchantItem | null;
}

export interface DelveResult extends ActionResult {
    item: InventoryItem | null;
    /** The delve window as the server sent it, blank lines included. Empty unless it answered. */
    lines: string[];
    bonuses: ItemBonus[];
    /** Lines that are neither a bonus nor known layout: spell text, descriptions, new formats. */
    unknown: string[];
    /** "Bonus Level: N". Nothing enforces it. */
    bonusLevel: number | null;
    /** "Level Requirement: N Level". It gates the item's spells, not its bonuses. */
    levelRequirement: number | null;
}

export interface MerchantResult extends ActionResult {
    merchant: NearbyNpc | null;
    items: MerchantItem[];
}

export interface BuyResult extends ActionResult {
    item: MerchantItem | null;
    /** Units that arrived in the backpack. */
    count: number;
    spent: number;
    itemsGained: InventoryItem[];
}

export interface SellResult extends ActionResult {
    item: InventoryItem | null;
    earned: number;
}

export interface SellItemsResult extends ActionResult {
    sold: InventoryItem[];
    failed: { item: InventoryItem; reason: string }[];
    earned: number;
}

export interface TrainResult extends ActionResult {
    /** The line as the skill list names it, whichever of its names was asked for. */
    spec: string | null;
    fromLevel: number;
    toLevel: number;
    specPointsLeft: number;
}

export interface TrainBuildResult extends ActionResult {
    /** The build's name; null when there is none. */
    build: string | null;
    /** Every line this call raised, by KeyName, also when a later one failed. */
    trained: { spec: string; fromLevel: number; toLevel: number }[];
    /** The line the points are banked for, when that is what stopped the training. */
    waiting: { spec: string; cost: number; points: number } | null;
    /** Nothing left to raise at this level. */
    done: boolean;
    /** Lines with points spent beyond the current target, by KeyName. Only a respec gets those back. */
    over: { spec: string; level: number; target: number }[];
    specPointsLeft: number;
}

export interface RespecResult extends ActionResult {
    /** What player.specPoints rose by. */
    regained: number;
    specPointsLeft: number;
    /** Every line as it stands now, as the skill list names it. */
    specs: { name: string; level: number }[];
}

export interface TravelResult extends WalkResult {
    spawn: NpcSpawnMatch | null;
}

export interface UseZonePointOptions {
    /** Walk to the source when farther than this (default 200). */
    tolerance?: number;
    /** How long to watch for the jump after the request, ms (default 20000). */
    timeout?: number;
}

export interface ZonePointResult extends ActionResult {
    /** The zone point used; null when the id names none. */
    zonePoint: ZonePoint | null;
    /** Where we stand now. */
    regionId: number | null;
    position: Vec3 | null;
    /** Server messages since the request. */
    messages: string[];
}

export interface ChatResult extends ActionResult {
    /** Our own echo was seen ("You say, ..."). */
    echoed: boolean;
}

export interface GroupResult extends ActionResult {
    group: GroupMember[];
}

export interface TradeOfferOptions {
    /** Backpack items, at most 10. A stack always goes whole. */
    give?: Array<InventoryItem | NamePattern | number>;
    /** TOTAL copper our side should show, not an increment. */
    money?: number;
    /** Approach distance (default 100). The server allows 128 in 3D. */
    range?: number;
    /** The whole call (default 30000 ms). Seeing a failure's window close can take up to 2 s more. */
    timeout?: number;
}

/** TradeOfferOptions (give, money, range, timeout) plus the judge of each offer. */
export interface TradeOptions extends TradeOfferOptions {
    /** Judge each new offer before accepting it; false means "not yet". A partner's change can cross our accept in flight, so this is no safeguard against strangers. */
    accept?: (window: TradeWindow) => boolean;
}

export interface AcceptTradeOptions {
    /** Only this partner's window; anyone else's is closed while waiting. Default: whoever opens one. */
    from?: PlayerTarget;
    accept?: (window: TradeWindow) => boolean;
    /** The whole call (default 30000 ms). */
    timeout?: number;
}

export interface TradeOfferResult extends ActionResult {
    partner: NearbyPlayer | null;
    trade: TradeWindow | null;
    /** The server's refusal of an add, and the item it was for (null for money). */
    refused: { item: InventoryItem | null; message: string } | null;
    messages: GameMessage[];
}

export interface TradeResult extends ActionResult {
    partner: string | null;
    /** As they were in our backpack. */
    gave: InventoryItem[];
    /** Real slots of ours, ready for equipItem. */
    received: InventoryItem[];
    /** Offered, completed, not found in our backpack (reason 'item_missing'). */
    missing: InventoryItem[];
    /** Copper. */
    moneyGiven: number;
    /** Copper. */
    moneyReceived: number;
    refused: { item: InventoryItem | null; message: string } | null;
    messages: GameMessage[];
}

export interface FollowOptions {
    /** Keep within this 2D distance (default 150). */
    distance?: number;
    /** Stop after this long (default 60000 ms). */
    durationMs?: number;
    /** Stop (successfully) when this returns true. */
    until?: (state: BotWorldState) => boolean;
}

export interface FollowResult extends ActionResult {
    durationMs: number;
    target: NearbyPlayer | null;
}

/** How grind fights with a pet. */
export interface GrindPetOptions {
    /**
     * The summon (default: the best main or turret one, see summonPet). It must give a pet the window lists. A charm here is reason
     * not_supported, before any cast: grind can't choose its mob, so charm first (charmPet) and pass pet: true. So is a fire-and-forget pet, a
     * bomber or a minion: orders don't reach them, so cast those with summonPet per target, or per spot for an Animist's. So is a known spell that is no summon at all, with its type in the message. A spell that can't be found is reason spell_not_found, up front too, with a pet up or not.
     * A turret needs its ground target set first (sdk.sendSetGroundTarget): with none set, the first try ends the run with reason no_ground_target.
     */
    spell?: NamePattern | Spell;
    /**
     * 'pet' (default): the pet fights and we stand off (petKill). A new pet's threat can take long to take a mob off us, so while a mob on us is within 250, and we have a melee weapon and aren't a shade, we swing as well (killNpc, which orders the pet);
     * one farther off the pet has, until it gets there. There is no health floor in either: a caller that wants one watches from outside. It is the pet's fight in both, so a passive pet is lifted to defensive first, as an order lifts one.
     * 'both': we fight too (killNpc, which orders the pet, and leaves a passive one out of it). With nothing to swing it reads as 'pet': in shade (ClassDisciple.cs:91), and with no melee weapon in slots 10 or 12 (a shield, a left-hand weapon alone and a bow are none), as the server refuses melee with a bow in hand (PlayerAttackRequestHandler.cs:12-18).
     * A summon with a cast time goes with a mob on us only while that is farther off than it can swing from by the cast's half way (220 units/s, faster if it reads so, and 250 more, about 910 for 6 s); nearer, we go to melee as it arrives, not walking out while it runs at us, and with nothing to swing it goes anyway, as the cast is all there is: until it can, the fight waits, with no failure. A Necromancer's goes that way too, weapon or not: melee is no answer for it. A mob our own hit pulled counts as on us for this, by a fight of ours or our hit in the last 10 s, while it closes with no target reading. With no mob on us a wait for a summon of 6 s or less, and any "You must wait N seconds", is waited out rather than spent on a pull; a long recast still pulls under 'both'.
     */
    fight?: 'pet' | 'both';
    /** Summon again after a loss or a respawn (default true). With no main or turret spell to do it with, a lost pet ends the run at once with reason not_supported, a mob on us or not, in a melee pass of ours too; false fights on in melee, and with no melee weapon ends the run at once: stopReason 'error', reason no_pet, and the message says what is on us. */
    resummon?: boolean;
    /**
     * Between fights, with no mob on us or the pet, no pull while our pet is below this: rest instead, up to restToPetHealth (default 50; 0 never, and no rest waits for it). Its health
     * only: a shade's own stays full, so nothing else protects a Necromancer, whose servant's death is its own. A refused rest is a wait. Adds aren't covered: a mob on the pet is fought before any rest, however low the pet is.
     * A rest in progress at the end of a run goes on in the next grind of this script, for the same pet, and the message says so: `; resting our pet (42 %, to 90 %)`. A new script knows nothing of it: it goes by the gate. A run that stops for lack of time before the gate is looked at says `; our pet at 18 %`.
     */
    restBelowPetHealth?: number;
    /**
     * How far a rest takes our pet, however long it takes, once restBelowPetHealth has called for one and on any rest of ours for our own health or mana (default 90; never less than restBelowPetHealth).
     * Most pets are there in a minute. The top Necromancer's servant regains about 0.2 % a second, a low one more, so this can take minutes; a Regenerate line heals about 6 % per 3 s for 12 s. releasePet then summonPet has a fresh one in about 20 s, at the cost of our own
     * health falling to the pet's percent (PlayerState.isShade): grind doesn't do that by itself, because it is the caller's to weigh.
     */
    restToPetHealth?: number;
}

export interface GrindOptions {
    pattern?: NamePattern;
    maxLevelDiff?: number;
    minLevelDiff?: number;
    minCon?: number;
    maxCon?: number;
    /** Hunt within this 2D distance of the anchor (default 2000). */
    radius?: number;
    /** Centre of the hunting area (default: where grind starts). */
    anchor?: Point;
    /** Rest when health falls below this between fights (default 50), up to restToHealth. */
    restBelowHealth?: number;
    /** Rest until this health (default 90; never less than restBelowHealth). */
    restToHealth?: number;
    /** Also rest below this mana percent (casters). */
    restBelowMana?: number;
    /**
     * Total run time (default 180000 ms). No new target is pulled once less than
     * `minEngageMs` remains, and a fight still going at the deadline is given up
     * at most 30 s after it, so a run overshoots by at most about 30 s, or 40 s with a mob below 5 % then. A pet's fight
     * has the same time, and so has a mob from a fight left unfinished by a lost pet or a mob on us (GrindOptions.pet). A pet's fight still standing then is called off (passive, defensive, follow),
     * and the message says so with both numbers, `called off at 17 % with giant wolf at 37 %`, as does GrindResult.calledOff; a pet on an enemy player is left to the caller, at the deadline.
     * No order takes a mob off a pet, though: one still on it gets an answer at its next swing, and that fight goes on with nobody watching.
     */
    durationMs?: number;
    /**
     * Do not pull a new target when less than this much of `durationMs` remains
     * (default: the average kill time of this run, 15000 ms before the first kill,
     * at most half of `durationMs`).
     * Monsters already attacking us are still fought.
     */
    minEngageMs?: number;
    /** Stop after this many kills. A pet on another mob by then is called off and the message says so, as at the deadline (durationMs). */
    maxKills?: number;
    /** Pick up loot after each kill (default true). */
    loot?: boolean;
    /**
     * Release and walk back after dying instead of stopping (default false). A death
     * in the last fight is also released, so grind never returns dead with this set.
     */
    respawn?: boolean;
    styles?: string[];
    useStyle?: StyleChooser;
    /**
     * Called after each kill; return false to stop, which treats a pet on another mob like maxKills does. `kill` has the whole fight's time, in durationMs and its message, as killLog does, when it took several goes;
     * what it gained is from the last go, which is where a kill's rewards come. A death only seen as the go ran out is a kill too, with xpGained 0 if the XP hadn't come by then.
     */
    onKill?: (kill: KillResult, stats: GrindStats) => void | boolean | Promise<void | boolean>;
    /**
     * One go at a mob (default 60000 ms). The time is only when grind looks: while the mob is wearing down the fight goes on, or in melee while it stays on us,
     * up to 30 s past the deadline. A pet that got nowhere in this time is called off with petFollow, and the mob is left alone for 60 s.
     */
    killTimeout?: number;
    /**
     * Stop with stopReason 'no_targets' after this long near the anchor without a single
     * candidate (default 60000 ms; 0 or Infinity waits out the whole duration, e.g. for respawns).
     * Typical cause: everything around the anchor cons grey after levelling.
     */
    noTargetTimeoutMs?: number;
    /**
     * Fight with a pet: summon it before the first fight and again after a loss, and after a respawn before the walk back (it follows; a window turret, which doesn't, goes up at the anchor), and neither pull
     * nor rest while it fights. Next comes, in this order: a mob on us; the pet's mob; a mob from a fight left
     * unfinished by a lost pet or a mob on us, while it lives within 2500 of us, with a new pet ordered onto it; and only then a fresh one. Without
     * a pet, a mob on us over 250 away gets a try at a summon first, as does one nearer by for a summon with no cast time, or when we have nothing to swing, and mobs on us are fought in melee until it is back: a melee pass lasts until the summon's timer is up, at least 3 s, and the fight goes on from there. A turret is given only what it reaches, one that stays out of that in the fight is let go after about 2 s, and a mob on us beyond that is fought in melee.
     * A mob a lost pet engaged turns on us (StandardMobBrain.cs:569), so one that is hurt, on us or was on the pet at the loss holds the run however short of time we are: it is the next target, and worth a new pet, until it dies, goes beyond 2500 or the overrun is up (durationMs). One the pet never reached has drawn nothing: with time short it holds nothing and gets no summon. If one
     * still stands at the end the message says `; our pet died with X at 17 %, and it is coming for us` (in shade also `: we are at N % health`, unless it is beside us more than 3 s after the loss: our health is melee's by then), when it reads as on us or had the pet as its target at the loss; else `; we lost our pet on its way to X`. Beside us by then: `; our pet died with X at 90 %, and it is on us at 80 %`, the percent at the loss and now. A release or a tether's cut says `we lost our pet` in these.
     * Nothing is said while a new pet has it. A run ended by our own death says `; our pet died first, with X at 84 %`. GrindResult.lastPetLoss has that mob in all of these.
     * Stops with stopReason 'error' when summoning keeps failing with time left. Past the deadline a try that fails ends the run as 'duration', and so does the last one when short of time. In the overrun a recast it can't outlast isn't waited for, unless the mob had the pet as its target. A pet a window doesn't list can't be used here (reason not_supported, see GrindPetOptions.spell). A run that ends with no pet says why: while a recast holds the summon `; waiting on Hunter's Pet (10s)`,
     * short of power `; no pet: short of power for X (it can cost 26, and we have 9)`, and otherwise `; could not summon: <the last line>`. Short of power it rests to the most the summon can cost and 5 points, at most 60 %.
     * A run in shade is this with `true`, from the pass that sees the shade and with or without the option: a shade fights through its servant alone (ClassDisciple.cs:91), and its own full health says nothing of it.
     */
    pet?: boolean | GrindPetOptions;
}

export interface GrindStats {
    kills: number;
    xpGained: number;
    deaths: number;
}

export interface GrindResult extends ActionResult {
    kills: number;
    /** Fights that failed, and each pet lost, once however many passes hear of it, between passes too; not the owner's death, nor a pet that went with a region change. */
    failures: number;
    deaths: number;
    xpGained: number;
    rpGained: number;
    moneyGained: number;
    levelsGained: number;
    durationMs: number;
    /** 'no_targets': nothing in the con window around the anchor for `noTargetTimeoutMs`. 'error': `reason` says what stopped it, not_supported among them. */
    stopReason: 'duration' | 'maxKills' | 'died' | 'onKill' | 'no_targets' | 'error';
    /** Each kill's durationMs covers its whole fight, across a lost pet, a mob that came between or a go that ran out of killTimeout. */
    killLog: { name: string; level: number; xp: number; durationMs: number }[];
    /**
     * The last window pet this run lost, absent when it lost none. `mob` is what it was fighting then, with its health at that moment, if that fight still stands at the end: alive and within
     * 2500 of us, after our own death too. Null otherwise. That mob comes for us (StandardMobBrain.cs:569), and with no script running nothing answers it, so a caller should look here before it stops.
     */
    lastPetLoss?: PetLoss & { mob: { objectId: number; name: string; healthPercent: number } | null };
    /**
     * The fight grind called our pet off at the end of the run, absent when there was none: the mob and both healths as they stood, so a caller can heal, or release while a shade's cut is still the pet's percent. Null for a pet out of view.
     * That doesn't end the fight (GrindOptions.durationMs), and the run can read as a success with its pet about to die.
     */
    calledOff?: { mob: { objectId: number; name: string; healthPercent: number }; petHealthPercent: number | null };
    /** The mob on us as a run ended for its time, with its health as it stood, absent with none: the overrun is over, nothing answers it now, and our swing may still be on. The message says so too, unless its note on the lost pet has said it. */
    stillFighting?: { objectId: number; name: string; healthPercent: number };
}

// ── Internals ───────────────────────────────────────────────────────────────

type Obj = NearbyNpc | NearbyPlayer | NearbyObject;

/** What castSpell's walk asks on top of walkToObject. */
interface WalkInOptions extends WalkToObjectOptions {
    /** End at the first reading within `range`, looking as it goes: a walk with only the arrival radius to stop it goes on past that. */
    firstReading?: boolean;
    /** What's enough when the walk can get no nearer, a height it can't climb say: it was to stop inside this, and did. Default `range`. */
    enough?: number;
    /** Why this walk has no more point, on the target as it now reads. */
    pointless?: (obj: Obj) => { message: string; reason: string } | null;
}

/**
 * How long to wait before an add that opens a window. Two of those in one server tick (33 ms) cross the windows, and
 * then two adds can hang the whole server (learnings/trading.md). The bots have no channel and either can start
 * first, so the clock keeps them apart: the earlier name sends in the first 250 ms of each second, the later name
 * in the 250 ms from the half second. Adds to an open window are safe, because both sides then share one lock.
 */
export function tradeSlotWait(now: number, later: boolean): number {
    const phase = (now + (later ? TRADE_SLOT_CYCLE_MS / 2 : 0)) % TRADE_SLOT_CYCLE_MS;
    return phase < TRADE_SLOT_MS ? 0 : TRADE_SLOT_CYCLE_MS - phase;
}

/** KillResult without the ActionResult fields and the target. */
type KillNumbers = Omit<KillResult, keyof ActionResult | 'npc' | 'retryAfterMs' | 'attacker'>;

/** How near our own 0x1B must fall to a resist line for the line to be ours: they go out together (SpellHandler.cs:2350-2368). */
const RESIST_PAIR_MS = 250;

/** A trade call's whole budget when the caller sets none. */
const TRADE_TIMEOUT_MS = 30_000;
/** How long the server gets to answer one add with a new 0xEA or a refusal line. */
const TRADE_ANSWER_MS = 3000;
/** How long a close gets to show in the snapshots. */
const TRADE_CLOSE_MS = 2000;
/** PlayerTradeWindow.MAX_ITEMS. */
const TRADE_MAX_ITEMS = 10;
/** Where to step when the server calls us too far away after the normal approach. */
const TRADE_CLOSE_RANGE = 64;
/** The wall clock's cycle for an add that opens a window, and the part of it a side may send in. See tradeSlotWait. */
const TRADE_SLOT_CYCLE_MS = 1000;
const TRADE_SLOT_MS = 250;

/** Our half of a window. */
type TradeSide = Pick<TradeWindow, 'mySlots' | 'myMoney'>;
/** What a call that gives nothing may find on our side. */
const NOTHING_OF_OURS: TradeSide = { mySlots: [], myMoney: 0 };
const sameTradeSide = (a: TradeSide, b: TradeSide): boolean =>
    a.myMoney === b.myMoney && a.mySlots.length === b.mySlots.length && a.mySlots.every(slot => b.mySlots.includes(slot));

const noTrade = (message: string, reason: string, partner: string | null, messages: GameMessage[], refused: TradeResult['refused'] = null): TradeResult =>
    fail(message, reason, { partner, gave: [], received: [], missing: [], moneyGiven: 0, moneyReceived: 0, refused, messages });

const noKill = (): KillNumbers => ({ killed: false, xpGained: 0, rpGained: 0, moneyGained: 0, itemsGained: [], durationMs: 0, levelsGained: 0, stylesUsed: 0 });

/** fight()'s end: the kill, or why not. */
type FightOutcome = 'killed' | { message: string; reason: string; retryAfterMs?: number; attacker?: NearbyNpc };

/** What fight() needs from its target: an NPC (killNpc) or an enemy player (killPlayer). */
interface Foe<T extends NearbyNpc | NearbyPlayer> {
    first: T;
    /** Its entry in a snapshot; undefined once it left view. */
    find(s: BotWorldState): T | undefined;
    /** Dead by the snapshot (death events are checked separately). */
    isDown(t: T): boolean;
    /** It left view without a death event at `lastHp` %: true when that still counts as the kill. */
    vanishedKilled(lastHp: number, watch: MessageWatch): boolean;
    chooseStyle?: (t: T, player: PlayerState, state: BotWorldState, styles: Style[]) => StyleChoice;
    /** Why the fight ends here, for something it has no eye on itself. Called each pass, while it stands. */
    endsNow?: (s: BotWorldState, t: T) => FightOutcome | null;
    /** Called each pass of the fight, while it stands. */
    eachPass?: (s: BotWorldState, t: T) => Promise<void>;
}

const npcFoe = (first: NearbyNpc): Foe<NearbyNpc> => ({
    first,
    find: s => s.nearbyNpcs.find(n => n.objectId === first.objectId),
    // Never by its health: the server truncates, so a mob under 1 % reads 0 and fights on (GameLiving.cs:2621). A dead one has its 0xA2 type 0, which also takes the entry.
    isDown: () => false,
    vanishedKilled: (lastHp, watch) => lastHp <= 20 || experienceFromMessages(watch.messages()) > 0,
});

const playerFoe = (first: NearbyPlayer): Foe<NearbyPlayer> => ({
    first,
    find: s => s.nearbyPlayers.find(pl => pl.objectId === first.objectId),
    isDown: pl => pl.isDead,
    // A player's death always comes as 0xAE to everyone in view (GamePlayer.cs:5901-5905).
    vanishedKilled: () => false,
});

/** A summon's result fields before anything is known. */
/** What ends a cast: its refusals, and the line at a dead target, a pattern where the others are substrings for useItem too. */
const CAST_ANSWERS: readonly (string | RegExp)[] = [...CAST_REFUSALS, TARGET_IS_DEAD, CAST_WIPED];

const noSummon = () => ({ spell: null as Spell | null, target: null as Obj | null, castTimeMs: null as number | null, completed: false, resisted: false, damage: 0, messages: [] as GameMessage[], pet: null as NearbyNpc | null, petState: null as PetState | null });

const OLDER_CLIENT_NO_PETS = 'The client runs older code, without pets: restart it with a quit action';

/** The orders that walk a pet: a turret has empty ones (TurretBrain.cs:100-108), though the server still answers them. */
const PET_WALK_ORDERS: ReadonlySet<PetCommand> = new Set<PetCommand>(['follow', 'stay', 'comeHere', 'goTarget']);

/** "You lose control of {0}!" comes as the server drops the brain (CharacterClassBase.cs:305-326, GameLiving.txt:70). */
const LOST_CONTROL = /^You lose control of .+!$/;
/** A charm at what already is one of ours. */
const ALREADY_OUR_PET = 'That is already our pet';

/** Why a summon stops with the pet we have kept: what summonPet's result takes from it. */
type SummonRefusal = { message: string; reason: string; messages?: GameMessage[]; target?: Obj };

/** A charm's level limit, as summonPet judges it with a pet to lose: another charm can have a higher one. */
const CHARM_TOO_STRONG = / is too strong for .+: level \d+, above \d+$/;

/** A Necromancer's cast with its shade effect still up (SummonNecromancerPet.cs:45-49). */
const ALREADY_SHADE = /^You are already a shade!/;

/** A shade's warning, at 10 s and at 5 s (AI.txt:8-9). */
const SERVANT_TOO_FAR = /^Your servant is too far from you/;

/** The end of those 10 s (AI.txt:10). Past the hard limit nothing is said: the server just cuts it (NecromancerPetBrain.cs:307-311). */
const SERVANT_BOND_LOST = /^You have lost your bond to your servant\.$/;

/** What attack and killPlayer say in shade, and killNpc without its pet. */
const SHADE_NO_MELEE = "We are in shade and can't melee: our servant fights, see petKill";

/** A kill that pays nothing: nothing else follows (AbstractServerRules.cs:1019-1022, :1082-1085), no loot either. */
const NO_REWARD = /^(?:You gain no experience from this kill!|This monster has been charmed recently and is worth no experience\.)$/;

/**
 * What a use of the ranged slot says, none of it naming the item: a draw, its end, a shot and the auto-release toggle (AttackComponent.cs:674-689, :1774, :1845; RangeAttackComponent.cs:169; GamePlayer.txt:204-207).
 * A shot its target evades or blocks says only that, in place of "You shoot" (AttackComponent.cs:1712-1716, :1745-1749), with the arrow gone from the quiver. It can't parry one (:1544), and strafing and fumbles are melee's.
 */
const RANGED_USE_LINE = /^(?:You (?:prepare your (?:shot|throw)\b|are ready to fire!|shoot |miss!|will (?:now|no longer) automatically release your shot)|.+ (?:evades|blocks) your attack!$)/;

/**
 * The melee weapons worn in slots 10 and 12, and the one to choose by what is known of them: the only one, the one the first style given needs (its tooltip's weapon; a style both fit says nothing), else the higher spec of its weapon type.
 * `pick` null with two: nothing tells them apart, as for two weapons of one line, and a two-hander's damage isn't in that (AttackComponent.cs:401-409).
 */
const meleeChoice = (s: BotWorldState, styles?: readonly string[]): { worn: InventoryItem[]; pick: number | null } => {
    const worn = [EquipmentSlot.RightHand, EquipmentSlot.TwoHand].flatMap(slot => s.equipment.find(i => i.slot === slot && isWeapon(i.objectType)) ?? []);
    const [first, second] = worn;
    if (!first || !second) return { worn, pick: first?.slot ?? null };
    const need = styles?.[0] === undefined ? undefined : bestNameMatch(s.skills.styles, styles[0])?.details?.weapon;
    const fits = need && !worn.every(w => WEAPON_LINES[w.objectType] === need) ? slotHolding(need, s.equipment) : null;
    if (fits !== null) return { worn, pick: fits };
    const specOf = (item: InventoryItem): number => {
        const line = WEAPON_LINES[item.objectType]?.toLowerCase();
        const spec = s.skills.specializations.find(x => x.name.toLowerCase() === line);
        return spec ? spec.level + spec.bonus : 0;
    };
    return { worn, pick: specOf(first) === specOf(second) ? null : specOf(first) > specOf(second) ? first.slot : second.slot };
};

/**
 * The slot to use to take a melee weapon in hand (GamePlayer.cs:6622-6637). Null with none, and then no swing can ever come: with a bow active the server gives its line (PlayerAttackRequestHandler.cs:12-18), otherwise "no weapon" (AttackComponent.cs:546-550), and a left-hand one alone leaves the right hand empty.
 * Of two: meleeChoice's, else the one we last took in hand, else the right hand. Which is active only the server knows (GameLiving.cs:368).
 */
const meleeSlot = (s: BotWorldState, styles?: readonly string[], last?: number | null): number | null => {
    const { worn, pick } = meleeChoice(s, styles);
    return pick ?? worn.find(i => i.slot === last)?.slot ?? worn[0]?.slot ?? null;
};

/**
 * How long a swing of ours holds a cast back: "You must wait N seconds", for the full interval of the weapon that swung (AttackComponent.cs:1113-1114, WeaponAction.cs:492, SpellHandler.cs:603-620), its SPD_ABS in tenths of a second, in value2 (PacketLib1124.cs:893-896). Quickness and haste only shorten that (AttackComponent.cs:367-369).
 * Which weapon is in hand only the server knows, so this is the slowest melee one worn, and a bow's shot holds nothing (AttackComponent.cs:1113). With no speed to read, as long as a hit counts.
 */
const swingHoldMs = (s: BotWorldState): number => {
    const speed = Math.max(0, ...s.equipment.filter(i => i.slot >= EquipmentSlot.RightHand && i.slot <= EquipmentSlot.TwoHand && isWeapon(i.objectType)).map(i => i.value2));
    return speed > 0 ? speed * 100 : HIT_INTERRUPT_MS;
};

/** A mob on the move with its heading on us: a mob runs straight at what it is after, and one reading gives that with no second look. */
const closesOn = (n: NearbyNpc, p: Point): boolean => n.speed > 0 && headingDiff(n.heading, headingBetween(n, p)) <= GRIND_CLOSING_ARC;

/** Whether a swing or spell of ours landed on this entry lately. */
const hitByUs = (s: BotWorldState, n: NearbyNpc): boolean => {
    const since = Date.now() - GRIND_PULLED_MS;
    return s.combatEvents.some(e => (e.kind === 'melee' || e.kind === 'spellEffect') && e.attackerObjectId === s.player?.objectId && e.targetObjectId === n.objectId && e.receivedAt >= Math.max(since, n.firstSeenAt ?? 0));
};

/** A line that answers a style's send with a no, not an attack's. */
const styleRefused = (text: string): boolean => {
    const t = text.toLowerCase();
    return STYLE_REFUSALS.some(r => t.includes(r)) && !t.includes('combat mode');
};

/** A kill's message, for the time it is given. */
const killedLine = (name: string, ms: number, gained: string): string => `Killed ${name} in ${(ms / 1000).toFixed(1)}s${gained}`;

/** SummonAnimistFnF : SummonAnimistPet stands on a ground target too (SummonAnimistFnF.cs:17-20, SummonAnimistPet.cs:21-40), and takes no other. */
const standsOnGround = (info: SpellInfo): boolean => info.type === 'SummonAnimistFnF';

/** Whether a target names ourselves: our own id is in no nearby list. */
const namesUs = (target: unknown, me: number | undefined): boolean =>
    me !== undefined && (target === me || (typeof target === 'object' && target !== null && 'objectId' in target && target.objectId === me));

/** An NPC nothing can attack, as a refusal: the server says nothing to these (AbstractServerRules.cs:383-384). Null for one that can be. */
function unattackable(t: NearbyNpc): { message: string; reason: string } | null {
    const why = [...(t.isPeaceful ? ['peaceful'] : []), ...(t.isTargetable ? [] : ['not targetable'])];
    return why.length ? { message: `${nameOf(t)} can't be attacked (${why.join(', ')})`, reason: 'not_attackable' } : null;
}

/** petKill's line for a mob on us. A camp's mobs share a name: then level and id tell them apart. */
function onUsLine(attacker: NearbyNpc, target: NearbyNpc | NearbyPlayer): string {
    const alike = nameOf(attacker) === nameOf(target);
    const who = (n: NearbyNpc | NearbyPlayer) => alike ? `${n.name} L${n.level} #${n.objectId}` : nameOf(n);
    return `${who(attacker)} is on us while our pet fights ${who(target)}`;
}

/**
 * How much a spell of the kinds with all sorts in them hurts (fnf and bomber: spell.sql has vents and heals under the same types). 2: its sub-spell goes at
 * an enemy, or it has none (a Theurgist's pet fights by itself). 1: a snare, at an enemy but no harm. 0: a heal or a buff, on the pet or on us.
 */
function summonHarm(info: SpellInfo): number {
    const sub = getSpell(info.subSpellId);
    if (!sub) return 2;
    if (sub.target.toLowerCase() !== 'enemy') return 0;
    return sub.type === 'SpeedDecrease' ? 1 : 2;
}

/**
 * Our modified level in the spec a spell line goes by (PacketLib1112.cs:65). The wire names a spec by its Name where the line has its key: Illusions is under Light, which reads "Light Magic" (specialization.sql:77).
 * A hybrid's lineName is the spec's name already. Null when our list doesn't show it.
 */
function modifiedSpec(lineName: string, specs: readonly Specialization[]): number | null {
    try {
        const key = getSpellLine(lineName)?.spec ?? lineName;
        const name = (getSpecialization(key)?.name ?? key).toLowerCase();
        const spec = specs.find(x => x.name.toLowerCase() === name);
        return spec ? spec.level + spec.bonus : null;
    } catch {
        return null;
    }
}

/** The range a cast is judged by: the spell's, cut by a Nearsight on us (effectiveSpellRange), unless the caller gives one. */
function spellRange(info: SpellInfo | null, options: CastOptions, effects?: readonly Effect[]): number {
    return options.range ?? (info && info.range > 0 ? effectiveSpellRange(info.range, effects) : DEFAULT_SPELL_RANGE);
}

/** Where castSpell's walk stops for this range. */
function spellWalkStop(range: number): number {
    return range - Math.min(range * SPELL_WALK_SHARE, SPELL_WALK_MARGIN);
}

/** Whether the window shows what this command asks for. */
function petShows(pet: PetState, command: PetCommand): boolean {
    return pet.aggression === command || pet.walk === command;
}

/** Message types that are combat/loot spam, never an answer to a skill or item use. */
const COMBAT_CHAT_TYPES = new Set<GameMessage['type']>(['youHit', 'otherCombat', 'damaged', 'resisted', 'action', 'yourDeath', 'otherDeath', 'spellPulse', 'loot', 'say', 'send', 'group', 'guild', 'broadcast', 'chat', 'emote']);

/** How near a zone point's source a stopped walk still asks for it: the server checks no distance. */
const ZONE_POINT_RANGE = 400;
/** What the server says when it won't take a zone point (RegionChangeRequestHandler.cs:69, 129, 162; the jump point handlers). */
const ZONE_POINT_REFUSALS = [/region has been disabled/i, /not supported by your client type/i, /exception in jump point/i, /do not meet the requirements/i, /proper mission/i, /another instance/i];

/** A rezzed player stands this near its caster; the margin is for what either of them does right after. */
const REZZED_NEAR = 300;

const fail = <T extends object>(message: string, reason: string, extra: T): ActionResult & T =>
    ({ success: false, message, reason, ...extra });

function headingDiff(a: number, b: number): number {
    const d = Math.abs(((a - b) % 4096 + 4096) % 4096);
    return Math.min(d, 4096 - d);
}

/** Machine reason for a cast refusal text. */
export function castFailureReason(text: string, fallback: string = 'refused'): string {
    const t = text.toLowerCase();
    // First: these name a mob, and a mob's name can hold any word below. This charm refusal passes once the mob is out of combat (CharmSpellHandler.cs:340-344, Spells.txt:84).
    if (/^you can't charm .+ is in combat!$/.test(t)) return 'in_combat';
    if (t.includes(NO_INSTRUMENT)) return 'refused';
    // The 20-concentration-effect cap (CONCENTRATION_CAP): refused, its words kept, so a buff's retry backs off (buffRetryMs).
    if (t.includes('simultaneous concentration spells')) return 'refused';
    if (CAST_WIPED.test(text) || HELD_LINE.test(text)) return 'crowd_controlled';
    // Release Clump at what is no turret of ours (Spells.txt:169, TurretSpellHandler.cs:30). The same words with a full stop are a Pet spell with no pet (Spells.txt:112, SpellHandler.cs:653).
    if (t.endsWith('on a creature you are controlling')) return 'invalid_target';
    if (TARGET_IS_DEAD.test(text)) return 'already_dead';
    if (t.includes(CORPSE_ONLY.toLowerCase())) return 'invalid_target';
    const pet = PET_CAST_REFUSALS.find(([line]) => t.includes(line));
    if (pet) return pet[1];
    if (PULSE_CANCELLED.some(line => t.includes(line))) return 'pulse_cancelled';
    if (isPvpImmunity(t)) return 'immune';
    if (isCrowdControlled(t)) return 'crowd_controlled';
    if (t.includes('you are dead')) return 'died'; // "You are dead and can't cast!" (SpellHandler.cs:881-884)
    if (t.includes('considering a resurrection')) return 'already_considering'; // ResurrectSpellHandler.cs:246, :264
    if (t.includes('interrupt')) return 'interrupted';
    if (t.includes('you must wait')) return 'must_wait';
    if (t.includes('power')) return 'no_power';
    if (t.includes('too far away')) return 'out_of_range';
    if (t.includes('not visible') || t.includes("can't see")) return 'not_visible';
    if (t.includes('sitting')) return 'sitting';
    if (t.includes('must select a target') || t.includes('invalid target')) return 'no_target';
    return fallback;
}

/** A cast the server is still busy with and castSpell no longer watches, for the next one to wait out: until then, and events after `seen` can end it, or no begin by `beginBy` for a follow-up (castHeldLeft). */
type CastHeld = { until: number; seen: number; beginBy?: number };

/** What's left of our own cast with a cast time: its 0x72 and that time, unless an 0x0B ended it. */
function ownCastLeftMs(s: BotWorldState, me: number): number {
    const cast = s.combatEvents.findLast(e => e.kind === 'spellCast' && e.attackerObjectId === me && (e.castTimeMs ?? 0) > 0);
    if (!cast || s.combatEvents.some(e => e.id > cast.id && e.kind === 'interrupt' && e.attackerObjectId === me)) return 0;
    return Math.max(0, cast.receivedAt + cast.castTimeMs! - Date.now());
}

function retryAfter(text: string): number | undefined {
    if (isPvpImmunity(text)) return PVP_IMMUNE_RETRY_MS;
    if (isCrowdControlled(text) || CAST_WIPED.test(text) || HELD_LINE.test(text)) return CROWD_CONTROLLED_RETRY_MS;
    if (text.toLowerCase().includes(NO_INSTRUMENT)) return NO_INSTRUMENT_RETRY_MS;
    const m = /must wait (\d+(?:\.\d+)?) seconds?/i.exec(text);
    if (m) return Math.ceil(Number(m[1]) * 1000);
    return /interrupt/i.test(text) ? INTERRUPT_RETRY_MS : undefined;
}

/** The object id a target names, if it does: a name matches whoever bears it now, and that says nothing of what became of an earlier one. */
function namedId(target: unknown): number | null {
    if (typeof target === 'number') return target;
    return typeof target === 'object' && target !== null && 'objectId' in target && typeof target.objectId === 'number' ? target.objectId : null;
}

/** 2D length of the route from `from` through `points`. */
function routeLength(from: { x: number; y: number }, points: readonly { x: number; y: number }[]): number {
    let total = 0;
    let prev = from;
    for (const w of points) { total += Math.hypot(w.x - prev.x, w.y - prev.y); prev = w; }
    return total;
}

function stripKeyword(keyword: string): string {
    return keyword.replace(/^\[|\]$/g, '').trim();
}

export class BotActions {
    private helpers: ActionHelpers;
    private lastWhisperAt = 0;
    private lastSayAt = 0;
    /** The window of an offerTrade, for the acceptTrade that finishes it. */
    private lastOffer: TradeWindow | null = null;
    /** The pet grind's gate has called a rest for, until it is back at restToPetHealth: one grind often ends before that, and the next goes on with it. */
    private restingPet: number | null = null;
    /** The melee slot we last took in hand. */
    private lastMeleeSlot: number | null = null;
    private castHeld: CastHeld | null = null;
    /** Ends the watch on our last attack's swing (endSwingAtDeath). */
    private swingWatch: (() => void) | null = null;
    /** Our last cast the server called too far away, until one at that target lands (SPELL_TOO_FAR_MS): the target, what it read as the cast began, and when. */
    private tooFar: { id: number; reading: number; at: number } | null = null;

    constructor(public sdk: BotSDK) {
        this.helpers = new ActionHelpers(sdk);
    }

    // ============ Movement ============

    /**
     * Walk to region coordinates x,y. Re-issues the move after server
     * corrections or stops, fails on death, region change, no progress
     * (`stuckMs`) or the deadline.
     */
    async walkTo(x: number, y: number, options: WalkOptions = {}): Promise<WalkResult> {
        return this.route({ x, y, z: options.z }, [], options);
    }

    /**
     * Walk until within `range` (3D) of an NPC, player or object; follows a target that moves. A target that dies on the way ends the walk at once: reason already_dead, with targetDied, by its death event or a player's dead flag. So does an id gone just after its death, asked for or come to.
     * A corpse we set out for is no such target, and one merely out of view reads not_found, where it was last seen.
     */
    async walkToObject(target: ObjectTarget, options: WalkToObjectOptions = {}): Promise<WalkToObjectResult> {
        return this.walkInto(target, options);
    }

    /** walkToObject's walk, with castSpell's say in how it ends. */
    private async walkInto(target: ObjectTarget, options: WalkInOptions): Promise<WalkToObjectResult> {
        const range = options.range ?? 100;
        let obj = this.helpers.resolveAny(target);
        if (!obj) {
            const dead = this.deadAndGone(target);
            return { ...(dead ? fail(dead, 'already_dead', { targetDied: true as const }) : fail(`Target not found: ${describeTarget(target)}`, 'not_found', {})), position: this.position(), distance: Infinity, reissues: 0, target: null };
        }
        let last: WalkResult = { success: true, message: 'Already in range', position: this.position(), distance: obj.distance2d, reissues: 0 };
        const tolerance = Math.max(16, Math.min(range * 0.6, range - 20));
        const deadline = options.timeout === undefined ? null : Date.now() + options.timeout;
        const id = obj.objectId;
        const name = nameOf(obj);
        const baseline = maxCombatEventId(this.helpers.state());
        const dead0 = obj.kind === 'player' && obj.isDead;
        const entryIn = (s: BotWorldState): Obj | undefined => s.nearbyNpcs.find(n => n.objectId === id) ?? s.nearbyPlayers.find(n => n.objectId === id) ?? s.nearbyObjects.find(n => n.objectId === id);
        // What ends the walk, whatever it has left. A healer doesn't go on to where its friend fell, and a mob's death is no reason to arrive at its spot.
        const over = (s: BotWorldState): { message: string; reason: string } | null => {
            const now = entryIn(s);
            const pointless = now && options.pointless?.(now);
            if (pointless) return pointless;
            const died = s.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === id) || (!dead0 && now?.kind === 'player' && now.isDead);
            return died ? { message: `${name} died as we came`, reason: 'already_dead' } : null;
        };
        const stopped = (end: { message: string; reason: string }, at: Obj): WalkToObjectResult => ({ ...last, ...fail(end.message, end.reason, end.reason === 'already_dead' ? { targetDied: true as const } : {}), target: at });
        const reached = (s: BotWorldState) => !!options.firstReading && (entryIn(s)?.distance ?? Infinity) <= range;
        for (let attempt = 0; attempt < 4; attempt++) {
            let noLayer = false;
            if (obj.distance <= range) {
                return { ...last, success: true, message: `In range of ${nameOf(obj)} (${obj.distance})`, target: obj };
            }
            const left = deadline === null ? undefined : deadline - Date.now();
            if (left !== undefined && left <= 0) return { ...last, ...fail(`Walk to ${nameOf(obj)} timed out after ${Math.round(options.timeout!)}ms`, 'timeout', {}), target: obj };
            if (obj.distance2d <= tolerance) {
                // Close on the ground but out of range in 3D: our z is off (estimateZ can miss by
                // hundreds) or the target is on another layer (ledge, wall, balcony). route() would
                // return 'Already at destination' without moving, so step onto the target ourselves.
                // The mover adopts its z on arrival (client/movement.ts arriveAt); with ground data
                // (sdk/ground.ts) it takes the layer nearest that z at the target's spot, and there is
                // none when the target is out of reach. The server measures these ranges in 3D
                // (Point3D.cs:114-140).
                const targetZ = obj.z;
                const r = await this.sdk.sendMoveTo(obj.x, obj.y, targetZ, { tolerance: Math.min(tolerance, 24) });
                if (!r.success) return { ...last, ...fail(`Cannot reach ${nameOf(obj)}: ${r.message}`, r.reason ?? 'dispatch_failed', {}), target: obj };
                const adopted = await this.helpers.waitFor(s => (s.player && Math.abs(s.player.z - targetZ) <= 16) || over(s) || reached(s) ? true : null, Math.min(2000, left ?? 2000));
                last = { success: true, message: 'Adopted target height', position: this.position(), distance: obj.distance2d, reissues: last.reissues };
                const now = this.helpers.state();
                const end = now && over(now);
                if (end) {
                    await this.helpers.cleanup(() => this.sdk.sendStop());
                    return stopped(end, obj);
                }
                // No layer near the target's height here, and retrying won't find one. It would go on to the target's spot, after our answer: and a first reading in range ends a walk here as out on the plane.
                noLayer = !adopted;
                if (noLayer || (now && reached(now))) await this.helpers.cleanup(() => this.sdk.sendStop());
            } else {
                const here = obj;
                const walked = await this.walkUntil(here.x, here.y, { z: here.z, tolerance, timeout: left }, s => !!over(s) || reached(s));
                last = walked ?? { success: true, message: `In range of ${nameOf(here)}`, position: this.position(), distance: here.distance2d, reissues: last.reissues };
                const now = this.helpers.state();
                const end = now && over(now);
                if (end) return stopped(end, (now && entryIn(now)) ?? here);
            }
            if (!last.success) return { ...last, message: `Cannot reach ${nameOf(obj)}: ${last.message}`, target: obj };
            const fresh = this.helpers.resolveAny(id);
            if (!fresh) return stopped(this.helpers.diedLately(this.helpers.state(), id) ? { message: `${name} died as we came`, reason: 'already_dead' } : { message: `${name} disappeared`, reason: 'not_found' }, obj);
            obj = fresh;
            if (noLayer) break;
        }
        return obj.distance <= (options.enough ?? range)
            ? { ...last, success: true, message: `In range of ${nameOf(obj)} (${obj.distance})`, target: obj }
            : { ...last, ...fail(`Could not get within ${Math.round(range)} of ${nameOf(obj)} (at ${obj.distance})`, 'out_of_reach', {}), target: obj };
    }

    /** What to say of a target by id that isn't there, gone just after its death; null when nothing says it died. */
    private deadAndGone(target: unknown): string | null {
        const id = namedId(target);
        return id !== null && this.helpers.diedLately(this.helpers.state(), id) ? `${describeTarget(target)} is already dead` : null;
    }

    /** Walk through waypoints in order (one continuous move). */
    async followPath(waypoints: Point[], options: Omit<WalkOptions, 'z' | 'pathProvider'> = {}): Promise<WalkResult> {
        const last = waypoints[waypoints.length - 1];
        if (!last) return { success: true, message: 'Empty path', position: this.position(), distance: 0, reissues: 0 };
        return this.route(last, waypoints.slice(0, -1), options);
    }

    /** Stop moving; observed when the mover reports it is idle. */
    async stop(): Promise<ActionResult> {
        const r = await this.sdk.sendStop();
        if (!r.success) return r;
        const idle = await this.helpers.waitFor(s => !s.movement.moving, 2000);
        return idle ? { success: true, message: 'Stopped' } : fail('Still moving after stop', 'timeout', {});
    }

    /**
     * Turn to a raw heading (a number, 0..4095), toward a point, or toward an object
     * (NPC/player/object, name pattern, or `{ objectId }`). A bare number is always a
     * heading: object ids are small per-region integers (Region.cs:886) that overlap it.
     */
    async face(target: Exclude<ObjectTarget, number> | Point | number | { objectId: number }): Promise<FaceResult> {
        const player = this.helpers.player();
        if (!player) return { ...fail('Not in game', 'not_in_game', {}), heading: 0 };
        let expected: number;
        let r: ActionResult;
        if (typeof target === 'number') {
            expected = ((Math.round(target) % 4096) + 4096) % 4096;
            r = await this.sdk.sendFace(expected);
        } else if (typeof target === 'object' && !(target instanceof RegExp) && !('objectId' in target)) {
            expected = headingBetween(player, target);
            r = await this.sdk.sendFace(expected);
        } else {
            const obj = this.helpers.resolveAny(target as ObjectTarget);
            if (!obj) return { ...fail(`Target not found: ${describeTarget(target)}`, 'not_found', {}), heading: player.heading };
            expected = headingBetween(player, obj);
            r = await this.sdk.sendFaceObject(obj.objectId);
        }
        if (!r.success) return { ...r, heading: player.heading };
        const s = await this.helpers.waitFor(st => st.player && headingDiff(st.player.heading, expected) <= 64 ? st : null, 2000);
        const heading = this.helpers.player()?.heading ?? 0;
        return s ? { success: true, message: `Facing ${heading}`, heading } : { ...fail(`Heading ${heading}, wanted ${expected}`, 'timeout', {}), heading };
    }

    // ============ Targeting / interaction ============

    /** Select a target (NPC, player, object, or our own objectId) and observe it in player.targetObjectId. */
    async target(target: ObjectTarget | null): Promise<TargetResult> {
        if (target === null) {
            const r = await this.sdk.sendSetTarget(null);
            return { ...r, target: null };
        }
        const me = this.helpers.player()?.objectId;
        if (target === me && me !== undefined) {
            const r = await this.sdk.sendSetTarget(me);
            if (!r.success) return { ...r, target: null };
            const ok = await this.helpers.waitFor(s => s.player?.targetObjectId === me, 2000);
            return ok ? { success: true, message: 'Targeted ourselves', target: null } : { ...fail('Target did not change', 'timeout', {}), target: null };
        }
        const obj = this.helpers.resolveAny(target);
        if (!obj) return { ...fail(`Target not found: ${describeTarget(target)}`, 'not_found', {}), target: null };
        const r = await this.sdk.sendSetTarget(obj.objectId);
        if (!r.success) return { ...r, target: obj };
        const ok = await this.helpers.waitFor(s => s.player?.targetObjectId === obj.objectId, 2000);
        return ok ? { success: true, message: `Targeted ${nameOf(obj)}`, target: obj } : { ...fail(`Target did not change to ${nameOf(obj)}`, 'timeout', {}), target: obj };
    }

    /**
     * Walk within ~150 of an NPC/object and interact (right-click). Success
     * needs a response: merchant/trainer window, NPC dialog, dialog box, text
     * window or a message from the NPC.
     */
    async interactWith(target: ObjectTarget, options: InteractOptions = {}): Promise<InteractResult> {
        const range = options.range ?? INTERACT_APPROACH;
        const empty = { target: null, response: null, dialog: null, messages: [] as GameMessage[] };
        let obj = this.helpers.resolveAny(target);
        if (!obj) return { ...fail(`Target not found: ${describeTarget(target)}`, 'not_found', empty) };
        if (obj.distance > range) {
            const walk = await this.walkToObject(obj, { range });
            if (!walk.success) return { ...fail(walk.message, walk.reason ?? 'out_of_reach', empty), target: obj };
            obj = walk.target ?? obj;
        }
        const before = this.helpers.state();
        const prevDialog = before?.npcDialog?.receivedAt ?? 0;
        const prevBox = before?.dialog?.receivedAt ?? 0;
        const prevText = before?.textWindow?.receivedAt ?? 0;
        const trainerWasOpen = before?.trainer.isOpen ?? false;
        const prevVault = before?.vaultOpenedAt;
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendInteract(obj.objectId);
            if (!r.success) return { ...fail(r.message, r.reason ?? 'dispatch_failed', empty), target: obj };
            const id = obj.objectId;
            const name = obj.name.toLowerCase();
            const response = await this.helpers.waitFor<InteractResponse | 'refused'>(s => {
                if (watch.find(INTERACT_REFUSALS)) return 'refused';
                if (s.merchant.isOpen && s.merchant.merchantObjectId === id) return 'merchant';
                if (s.npcDialog && s.npcDialog.receivedAt !== prevDialog && (s.npcDialog.npcObjectId === id || s.npcDialog.npcName?.toLowerCase() === name)) return 'dialog';
                if (s.dialog?.isOpen && s.dialog.receivedAt !== prevBox) return 'dialogBox';
                if (s.textWindow && s.textWindow.receivedAt !== prevText) return 'textWindow';
                if (s.trainer.isOpen && !trainerWasOpen) return 'trainer';
                if (s.vaultOpenedAt && s.vaultOpenedAt !== prevVault) return 'vault';
                if (name && watch.messages().some(m => m.text.toLowerCase().startsWith(name))) return 'message';
                return null;
            }, options.timeout ?? 4000);
            // NPCs often answer in several lines; let the rest land.
            if (response === 'dialog' || response === 'message') await this.helpers.sleep(400);
            const s = this.helpers.state();
            const fresh = this.helpers.resolveAny(id) ?? obj;
            if (response === 'refused') return { ...fail(watch.findText(INTERACT_REFUSALS)!, 'refused', empty), target: fresh, messages: watch.messages().slice() };
            if (!response) return { ...fail(`No response from ${nameOf(obj)}`, 'no_response', empty), target: fresh, messages: watch.messages().slice() };
            const dialog = response === 'dialog' ? s?.npcDialog ?? null : null;
            return { success: true, message: `${obj.name} responded (${response})`, target: fresh, response, dialog, messages: watch.messages().slice() };
        } finally {
            watch.dispose();
        }
    }

    /** Interact with an NPC and return its dialog text and [keywords]. */
    async talkTo(npc: NpcTarget, options: InteractOptions = {}): Promise<DialogResult> {
        const resolved = this.helpers.resolveNpc(npc);
        if (!resolved) return fail(`NPC not found: ${describeTarget(npc)}`, 'not_found', { npc: null, dialog: null, keywords: [], text: '', messages: [] });
        const prevDialog = this.helpers.state()?.npcDialog?.receivedAt;
        const r = await this.interactWith(resolved, options);
        const n = (r.target?.kind === 'npc' ? r.target : resolved) as NearbyNpc;
        // Never report an older conversation's text and keywords as this answer.
        const dialog = r.success ? this.mergeDialog(n, r.messages, r.dialog ?? this.dialogFrom(n, prevDialog)) : null;
        const text = dialog?.text ?? r.messages.map(m => m.text).join('\n');
        if (!r.success) return { success: false, message: r.message, reason: r.reason, npc: n, dialog: null, keywords: [], text, messages: r.messages };
        return { success: true, message: dialog ? `${n.name}: ${dialog.text.slice(0, 120)}` : r.message, npc: n, dialog, keywords: dialog?.keywords ?? [], text, messages: r.messages };
    }

    /**
     * Whisper a [keyword] to an NPC (targets it first) and observe its reply:
     * new dialog text, a message from the NPC, a window, or an item. Spaces
     * whispers 1.6 s apart (NPCs ignore faster ones) and resends once after
     * the server's "Slow down!". A teleporter's answer isn't a jump: it can still refuse for combat ("You can't use this item in combat!", UniPortal.cs:41, :82), after the answer and with
     * success already read. Its InCombat counts the pet and lasts 2 s longer than player.inCombat (GamePlayer.cs:6045-6047), so wait 10 s after a fight and watch the position. In shade a jump to another region costs health: PlayerState.isShade.
     */
    async whisper(npc: NpcTarget, keyword: string, options: { timeout?: number } = {}): Promise<DialogResult> {
        const empty = { npc: null, dialog: null, keywords: [] as string[], text: '', messages: [] as GameMessage[] };
        let n = this.helpers.resolveNpc(npc);
        if (!n) return fail(`NPC not found: ${describeTarget(npc)}`, 'not_found', empty);
        if (n.distance > WHISPER_APPROACH + 100) {
            const walk = await this.walkToObject(n, { range: WHISPER_APPROACH });
            if (!walk.success) return { ...fail(walk.message, walk.reason ?? 'out_of_reach', empty), npc: n };
            n = this.helpers.resolveNpc(n.objectId) ?? n;
        }
        const word = stripKeyword(keyword);
        const before = this.helpers.state();
        const prevDialog = before?.npcDialog?.receivedAt ?? 0;
        const prevBox = before?.dialog?.receivedAt ?? 0;
        const prevText = before?.textWindow?.receivedAt ?? 0;
        const inv0 = before?.inventory ?? [];
        let watch = this.helpers.watch();
        try {
            const id = n.objectId;
            const name = n.name.toLowerCase();
            let got: string | null = null;
            for (let attempt = 0; ; attempt++) {
                const wait = this.lastWhisperAt + WHISPER_SPACING_MS - Date.now();
                if (wait > 0) await this.helpers.sleep(wait);
                const r = await this.sdk.sendWhisper(n.objectId, word);
                if (!r.success) return { ...fail(r.message, r.reason ?? 'dispatch_failed', empty), npc: n };
                got = await this.helpers.waitFor(s => {
                    if (watch.messages().some(m => WHISPER_RATE_LIMIT.test(m.text))) return 'slow';
                    if (s.npcDialog && s.npcDialog.receivedAt !== prevDialog && (s.npcDialog.npcObjectId === id || s.npcDialog.npcName?.toLowerCase() === name)) return 'dialog';
                    if (s.dialog?.isOpen && s.dialog.receivedAt !== prevBox) return 'box';
                    if (s.textWindow && s.textWindow.receivedAt !== prevText) return 'text';
                    if (s.merchant.isOpen && s.merchant.merchantObjectId === id) return 'merchant';
                    if (watch.messages().some(m => m.text.toLowerCase().startsWith(name) || /you (get|receive)|gives you|you have been/i.test(m.text))) return 'message';
                    if (diffInventory(inv0, s.inventory).gained.length) return 'item';
                    return null;
                }, options.timeout ?? 4000);
                if (got !== 'slow') {
                    this.lastWhisperAt = Date.now();
                    break;
                }
                if (attempt > 0) return { ...fail(`${n.name} did not hear "${word}": whispering too fast`, 'rate_limited', empty), npc: n };
                // Another script whispered just now; the next try waits a full spacing.
                this.lastWhisperAt = Date.now();
                watch.dispose();
                watch = this.helpers.watch();
            }
            // Let trailing lines of a multi-line reply land.
            if (got) await this.helpers.sleep(300);
            const s = this.helpers.state();
            const messages = watch.messages().slice();
            const dialog = this.mergeDialog(n, messages, got === 'dialog' ? s?.npcDialog ?? null : this.dialogFrom(n, prevDialog));
            const text = dialog?.text ?? messages.map(m => m.text).join('\n');
            if (!got) return { success: false, message: `${n.name} did not answer "${word}"`, reason: 'no_response', npc: n, dialog: null, keywords: [], text, messages };
            return { success: true, message: `${n.name} answered "${word}"`, npc: n, dialog, keywords: dialog?.keywords ?? [], text, messages };
        } finally {
            watch.dispose();
        }
    }

    /**
     * Talk to an NPC, then whisper each keyword in turn. A RegExp picks the
     * first matching [keyword] from the current dialog.
     */
    async navigateDialog(npc: NpcTarget, keywords: (string | RegExp)[], options: { timeout?: number } = {}): Promise<DialogResult> {
        let result = await this.talkTo(npc);
        if (!result.success) return result;
        for (const k of keywords) {
            let word: string | undefined;
            if (typeof k === 'string') word = k;
            else word = result.keywords.find(kw => k.test(kw));
            if (!word) return { ...result, success: false, message: `No keyword matching ${k} in [${result.keywords.join(', ')}]`, reason: 'keyword_not_found' };
            result = await this.whisper(result.npc ?? npc, word, options);
            if (!result.success) return result;
        }
        return result;
    }

    /** Answer the open dialog box (group invite, quest offer, yes/no). Waits up to `timeout` for one to open. */
    async respondToDialog(accept: boolean, options: { timeout?: number } = {}): Promise<RespondDialogResult> {
        const box = await this.helpers.waitFor(s => s.dialog?.isOpen ? s.dialog : null, options.timeout ?? 3000);
        if (!box) return fail('No dialog box open', 'no_dialog', { dialog: null });
        const r = await this.sdk.sendRespondDialog(accept);
        if (!r.success) return { ...r, dialog: box };
        const closed = await this.helpers.waitFor(s => !s.dialog?.isOpen || s.dialog.receivedAt !== box.receivedAt, 2000);
        return closed ? { success: true, message: `Dialog ${accept ? 'accepted' : 'declined'}: ${box.text.slice(0, 80)}`, dialog: box } : fail('Dialog still open', 'timeout', { dialog: box });
    }

    /**
     * Wait for a resurrection offer, say yes and observe the revive. We come back standing at the caster, with
     * the spell's health and power (10 % and none for a baseline rez). That saves the release's XP loss, grave
     * and constitution loss; resurrection illness comes all the same.
     * Reasons: not_in_game, not_dead, timeout (no offer came), expired (the offer was gone when we answered).
     */
    async acceptResurrection(options: { timeout?: number } = {}): Promise<AcceptResurrectionResult> {
        const none = { offer: null };
        const p = this.helpers.player();
        if (!p) return fail('Not in game', 'not_in_game', none);
        if (!p.isDead) return fail('Not dead', 'not_dead', none);
        const offer = await this.helpers.waitFor(s => (s.dialog?.isOpen ? s.dialog.resurrection : null) ?? null, options.timeout ?? 30_000);
        if (!offer) return fail('No resurrection offer arrived', 'timeout', none);
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendRespondDialog(true);
            if (!r.success) return { ...r, offer };
            // "No one is currently trying to resurrect you." (:95): the expiry beat our answer, or an earlier box left unanswered undid this one.
            const end = await this.helpers.waitFor(s => (!s.player?.isDead ? 'revived' : watch.find(['no one is currently trying']) ? 'expired' : null), 5000);
            if (end !== 'revived') return fail(end ? `${offer.caster}'s offer was gone when we answered` : `Said yes to ${offer.caster}, still dead`, end ?? 'timeout', { offer });
            // The server moves us to the caster along with the revive (:163): a caller must not walk on from the corpse.
            await this.helpers.waitFor(s => s.player && Math.hypot(s.player.x - p.x, s.player.y - p.y) > 50, 1000);
            return { success: true, message: `Resurrected by ${offer.caster} at ${offer.healthPercent} % health`, offer };
        } finally {
            watch.dispose();
        }
    }

    // ============ Combat ============

    /**
     * Approach, target, face and switch melee on against an NPC or a player (enemy players are
     * named by race: pass the objectId); observed via attack mode or a swing. Reason 'immune'
     * (with retryAfterMs) when PvP immunity, ours or the target's, refuses the swing,
     * 'crowd_controlled' (with retryAfterMs) when we are mezzed or stunned, and 'already_dead' when it died as we came, with attack mode switched off again (attack mode carried over from another target says that line of that one, so then only with this one dead or gone in our view). In shade: reason 'refused', with no walk; with no melee weapon in slots 10 or 12 too (a shield, a left-hand weapon alone and a bow are none). With a bow
     * in hand the server's line comes once in range: this takes a melee slot in hand once, as killNpc does (takeMeleeSlot), and tries again; if the line stays, reason 'refused' with it.
     * The walk ends at the target's death, at once, and an id gone just after its death reads already_dead as well; one merely out of view reads not_found.
     * The swing goes off by itself at the target's death, also after this has returned, as long as our selection is on it or went with it: the server's would stand there, at a player's corpse with "X is already dead!" each round, at a mob's with no line at all, as the client clears the selection at its remove (client/session.ts:496), and player.inCombat with it. A call that comes to nothing leaves a swing on another target on, and that one still goes off at that target's death. A refusal for good goes the same way, reason 'refused': a player of our realm says so only with the next round (a duel takes the id, and the client can't tell one), so at one this waits a weapon's interval before it reads success. A line we can walk or turn out of ("not in view") keeps the swing.
     */
    async attack(target: LivingTarget, options: { timeout?: number } = {}): Promise<AttackResult> {
        const t = this.helpers.resolveLiving(target);
        if (!t) {
            const dead = this.deadAndGone(target);
            if (!dead) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', { npc: null, target: null });
            await this.swingOffAt(namedId(target));
            return fail(dead, 'already_dead', { npc: null, target: null });
        }
        const targets = (o: NearbyNpc | NearbyPlayer) => ({ npc: o.kind === 'npc' ? o : null, target: o });
        if (this.isDeadTarget(t)) {
            await this.swingOffAt(t.objectId);
            return fail(`${nameOf(t)} is already dead`, 'already_dead', targets(t));
        }
        // A name that matched no monster falls back to players: never one of our realm (a duel takes the id).
        if (t.kind === 'player' && (typeof target === 'string' || target instanceof RegExp) && t.realm === this.helpers.player()?.realm) {
            return fail(`${t.name} is a player of our realm`, 'not_attackable', targets(t));
        }
        // The server says so only at the first swing (ClassDisciple.cs:85-94), by which time we stand beside the mob: the last place for a shade, whose servant's death leaves it at 10 % (:149).
        if (this.helpers.player()?.isShade) return fail(SHADE_NO_MELEE, 'refused', targets(t));
        const state = this.helpers.state();
        if (state && meleeSlot(state) === null) return fail(`We have no weapon to fight ${nameOf(t)} with`, 'refused', targets(t));
        const first = await this.swingAt(t, options);
        // The model can't tell which weapon is active, and only this line says so.
        if (first.reason !== 'refused' || !first.message.toLowerCase().includes(RANGED_IN_HAND)) return first;
        const slot = this.bestMeleeSlot(this.helpers.state());
        if (slot === null) return first;
        await this.takeInHand(slot);
        return this.swingAt(t, options);
    }

    /** attack's approach and its swing. */
    private async swingAt(t: NearbyNpc | NearbyPlayer, options: { timeout?: number }): Promise<AttackResult> {
        const targets = (o: NearbyNpc | NearbyPlayer) => ({ npc: o.kind === 'npc' ? o : null, target: o });
        const p0 = this.helpers.player();
        const carried = !!p0?.attacking && p0.targetObjectId !== t.objectId;
        const engaged = await this.engage(t);
        if (!engaged.success) {
            // The client's model has dropped it and the snapshot still holds it (client.ts:380): the one without it has its death too, if it died.
            if (engaged.reason === 'unknown_object') await this.helpers.waitFor(() => this.helpers.resolveLiving(t.objectId) ? null : true, SNAPSHOT_GAP_MS);
            const dead = engaged.reason === 'already_dead' || (engaged.reason === 'unknown_object' && this.helpers.diedLately(this.helpers.state(), t.objectId));
            if (dead) {
                // Our walk for it had the swing to itself. With no select to go with it, one on another target is that target's, as for one dead before we set out.
                await (engaged.reason === 'already_dead' ? this.swingOff() : this.swingOffAt(t.objectId));
                return fail(engaged.reason === 'already_dead' ? engaged.message : `${nameOf(t)} is already dead`, 'already_dead', targets(t));
            }
            return engaged.reason === 'unknown_object' ? fail(`${nameOf(t)} disappeared`, 'not_found', targets(t)) : { ...engaged, ...targets(t) };
        }
        // Only now: if this came to nothing the swing we had stays, and so does the watch on it.
        this.swingWatch?.();
        const watch = this.helpers.watch();
        const baseline = maxCombatEventId(this.helpers.state());
        try {
            const r = await this.sdk.sendAttack(true);
            if (!r.success) return { ...r, ...targets(t) };
            const me = this.helpers.player()?.objectId;
            const swung = (s: BotWorldState) => s.combatEvents.some(e => e.id > baseline && e.kind === 'melee' && e.attackerObjectId === me && e.targetObjectId === t.objectId);
            // Attack mode came from another target, with a round at it due: until the select reaches the server its "X is already dead!" is that one's (a corpse's, as the swing stood on it), and says nothing of this one while it stands alive for us. Names don't tell: an enemy player's entry has none, and mobs share theirs.
            const heard = (m: GameMessage): boolean => {
                if (!carried || !m.text.toLowerCase().includes(ALREADY_DEAD)) return true;
                const now = this.helpers.resolveLiving(t.objectId);
                return !now || this.isDeadTarget(now);
            };
            let evidence = await this.helpers.waitFor(s => {
                if (watch.find(ATTACK_REFUSALS, heard)) return 'refused';
                if (swung(s)) return 'swing';
                if (s.player?.attacking) return 'attacking';
                return null;
            }, options.timeout ?? 5000);
            // Attack mode comes on before the server checks the rules: a PvP refusal arrives with the
            // first swing round right after it (AttackComponent.cs:710, WeaponAction.cs:411). That round
            // also says "too far away" / "not in view" when the target stepped off (AttackComponent.cs:1725-1737):
            // retryable, so attack mode stands and fight() re-approaches.
            const fatal = () => watch.messages().find(m => heard(m) && isFatalAttackRefusal(m.text));
            if (evidence === 'attacking' && t.kind === 'player') {
                // Of our realm that round is the whole answer, at the weapon's interval, and a reading of attack mode says nothing: 'You can't attack a member of your realm!' came 1496 ms in, with success read at 1000. Only a duel gets a swing there (NormalServerRules.cs:50-52).
                const state = this.helpers.state();
                const round = state && t.realm === p0?.realm ? swingHoldMs(state) + SNAPSHOT_GAP_MS : 1000;
                evidence = await this.helpers.waitFor(s => fatal() ? 'refused' : swung(s) ? 'swing' : null, round) ?? 'attacking';
            }
            if (evidence === 'refused') {
                const text = watch.findText(PVP_IMMUNE_REFUSALS) ?? watch.findText(CROWD_CONTROL_REFUSALS) ?? fatal()?.text ?? watch.findText(ATTACK_REFUSALS, heard)!;
                if (isPvpImmunity(text)) return fail(text, 'immune', { ...targets(t), retryAfterMs: PVP_IMMUNE_RETRY_MS });
                if (isCrowdControlled(text)) return fail(text, 'crowd_controlled', { ...targets(t), retryAfterMs: CROWD_CONTROLLED_RETRY_MS });
                // Attack mode stands on the corpse, the line again each round (AttackComponent.cs:1712): 8 s live with the pet's order held behind it.
                if (text.toLowerCase().includes(ALREADY_DEAD)) {
                    await this.sdk.sendAttack(false);
                    return fail(text, 'already_dead', targets(t));
                }
                // Attack mode came with the select, and the server's refusal doesn't end it: the round before the swing has already returned (WeaponAction.cs:424-433), so it says this again at each one, to whatever we select next. A line we can walk or turn out of keeps it, and with a bow in hand there was none to end.
                if (isFatalAttackRefusal(text)) await this.swingOff();
                return fail(text, 'refused', targets(t));
            }
            if (!evidence) return fail(`No attack observed on ${t.name}`, 'timeout', targets(t));
            this.endSwingAtDeath(t, baseline);
            return { success: true, message: `Attacking ${t.name}`, ...targets(this.helpers.resolveLiving(t.objectId) ?? t) };
        } finally {
            watch.dispose();
        }
    }

    /** Our swing off, if the model has one on. */
    private async swingOff(): Promise<void> {
        if (this.helpers.player()?.attacking) await this.sdk.sendAttack(false);
    }

    /** That, if it stands on this target or on none: one on another is about that one. */
    private async swingOffAt(id: number | null): Promise<void> {
        const on = this.helpers.player()?.targetObjectId;
        if (on === null || on === id) await this.swingOff();
    }

    /**
     * attack returns with the swing on, and nothing watches it after that. The server's goes on standing at a dead target, attack mode and all (WeaponAction.cs:424-433), and player.inCombat reads true for as long: 30 s live, beside a pet's kill, with target null and no line, as the client clears the selection at a mob's remove (client/session.ts:496). At a player's corpse the line comes again each round (AttackComponent.cs:1712).
     * So it goes off at the target's death, for as long as our selection is on it or has gone with it. A swing that has moved on to another target is that one's, and the next attack call takes over from this.
     */
    private endSwingAtDeath(t: NearbyNpc | NearbyPlayer, baseline: number): void {
        let seenOn = false;
        const end = () => {
            unsubscribe();
            if (this.swingWatch === end) this.swingWatch = null;
        };
        const unsubscribe = this.sdk.onStateUpdate(s => {
            const p = s.player;
            if (!p || p.isDead) return end();
            seenOn ||= p.attacking;
            if (seenOn && !p.attacking) return end();
            if (p.targetObjectId !== null && p.targetObjectId !== t.objectId) return end();
            const died = s.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === t.objectId) || (t.kind === 'player' && !!s.nearbyPlayers.find(n => n.objectId === t.objectId)?.isDead);
            if (!died || !p.attacking) return;
            end();
            this.sdk.sendAttack(false).catch(() => {});
        });
        this.swingWatch = end;
    }

    /**
     * Fight an NPC to the death: walk into melee range (adopting its z), face,
     * target, attack, re-approach when it moves, use styles, and wait for the
     * death (the remove packet, never 0 %: a mob under 1 % reads 0 and fights on, GameLiving.cs:2621).
     * Reports XP, RP, money, items and the duration up to the death. Reason
     * 'crowd_controlled' (with retryAfterMs) when a mezz or stun refuses our swing. A window
     * pet that isn't passive gets the order too (`usePet`), as soon as we are within range of
     * one and again if it ends up on another mob; a passive one stays out of it. A shade can't
     * melee (ClassDisciple.cs:91), so in shade this is petKill, with its reasons and only `timeout`
     * of these options, and with `usePet: false` reason 'refused', with no walk. With no melee weapon in
     * slots 10 or 12 (a shield, a left-hand weapon alone and a bow are none) reason 'refused' at once, with no walk: the server would only say so at the first
     * swing (AttackComponent.cs:548). A pet we would order still gets its order, and fights on after
     * this returns: the message says so. With a bow in hand the server refuses melee: this takes a melee slot in hand once and fights on: the one the first of `styles` needs, else as takeMeleeSlot picks. On "This style requires a X weapon!" it uses the slot holding X, once per fight.
     * Reason 'pet_died' only with `endOnPetLoss`. `npc` is the entry as it ended, or the one we began with if it has gone.
     */
    async killNpc(target: NpcTarget, options: KillOptions = {}): Promise<KillResult> {
        const s0 = this.helpers.state();
        const p0 = s0?.player;
        const base = { npc: null as NearbyNpc | null, ...noKill() };
        if (!s0 || !p0) return fail('Not in game', 'not_in_game', base);
        if (p0.isDead) return fail('We are dead', 'dead', base);
        const n0 = this.helpers.resolveNpc(target);
        if (!n0) {
            const dead = this.deadAndGone(target);
            return dead ? fail(dead, 'already_dead', base) : fail(`NPC not found: ${describeTarget(target)}`, 'not_found', base);
        }
        if (this.isDeadTarget(n0)) return fail(`${nameOf(n0)} is already dead`, 'already_dead', { ...base, npc: n0 });
        // An enemy realm's pet is no monster to go looking for (isKillable), but it can be fought: it pays nothing (GameNPC.cs:2731-2732), and it may be what's killing us.
        if (!options.force && !isKillable(n0, p0) && !(n0.isPet && isAttackable(n0, p0))) return fail(`${nameOf(n0)} is not something we can kill (realm ${n0.realm}, role ${n0.role}, peaceful ${n0.isPeaceful})`, 'not_attackable', { ...base, npc: n0 });
        if (p0.isShade) {
            if (options.usePet === false) return fail(SHADE_NO_MELEE, 'refused', { ...base, npc: n0 });
            const r = await this.petKill(n0, { timeout: options.timeout });
            return { ...r, npc: r.npc ?? n0 };
        }
        if (meleeSlot(s0) === null) return this.killWithNoWeapon(n0, options);

        const useStyle = options.useStyle;
        const foe: Foe<NearbyNpc> = {
            ...npcFoe(n0),
            chooseStyle: useStyle && ((npc, player, state, styles) => useStyle({ npc, target: npc, player, state, styles })),
            eachPass: options.usePet === false ? undefined : this.petJoiner(n0.objectId),
            endsNow: options.endOnPetLoss && s0.pet ? (s, t) => s.pet ? null : { message: `Our pet is gone${s.lastPetLoss ? ` (${s.lastPetLoss.cause})` : ''} with ${nameOf(t)} at ${t.healthPercent}% health`, reason: 'pet_died' } : undefined,
        };
        const fightFor = (timeout: number | undefined) => this.fightToDeath<NearbyNpc>(foe, s0, p0, { ...options, timeout }, watch => this.settleNpcKill(watch), k => ` (+${k.xpGained} xp)`);
        const started = Date.now();
        let r = await fightFor(options.timeout);
        // The model can't tell which weapon is active, and only this line says so.
        if (r.reason === 'refused' && r.message.toLowerCase().includes(RANGED_IN_HAND)) {
            const slot = this.bestMeleeSlot(this.helpers.state() ?? s0, options.styles);
            if (slot === null) return this.killWithNoWeapon(n0, options);
            await this.takeInHand(slot);
            r = await fightFor(Math.max(1, (options.timeout ?? DEFAULT_KILL_TIMEOUT_MS) - (Date.now() - started)));
        }
        return { ...r, npc: this.latestNpc(n0) };
    }

    /**
     * Use a melee slot, which switches the hand (GamePlayer.cs:6622-6637), and wait for its attempt line (:6564). That comes after what the bow's last attack request earned, on one stream,
     * and the next fight's watch would read that for a refusal of its own: the off that ended the refused fight gets the line as well (PlayerAttackRequestHandler.cs:12-18). Whether the line came.
     */
    private async takeInHand(slot: number): Promise<boolean> {
        const name = this.sdk.getEquipmentItem(slot)?.name.toLowerCase() ?? '';
        this.lastMeleeSlot = slot;
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendUseItem(slot, 0);
            return r.success && !!await this.helpers.waitFor(() => watch.find([name]) ? true : null, HAND_SWITCH_MS);
        } finally {
            watch.dispose();
        }
    }

    /** meleeSlot, with what we took in hand last. */
    private bestMeleeSlot(s: BotWorldState | null, styles?: readonly string[]): number | null {
        return s && meleeSlot(s, styles, this.lastMeleeSlot);
    }

    /**
     * Take a melee weapon in hand, for a fighter who may stand with the wrong one or a bow: the state can't say which is active, and the server swings what it is. The weapon the first of `styles` needs, else the higher spec of the two weapon types worn, else the one we took last, else the right hand. With `weapon`
     * (a style tooltip's word, as "This style requires a X weapon!" has it) the slot holding that. Observed by the server's "You attempt to use" (GamePlayer.cs:6564), which comes for a weapon in hand as well: that one changes nothing, and a swing going stops only at a real switch (:4995-4996). A cast going stops with it too (:5004-5008).
     * With `keepOnTie`, two weapons that neither the style nor the spec tells apart (in Midgard a sword and a great sword, one object type and one line, and so with axes and hammers; in Albion and Hibernia a two-hander has a line of its own, so a mace and a two-hander at equal spec, and the higher spec takes the hand whatever the damage) stay as the owner left them: success, slot null, and nothing sent. Equipping a two-hander brings it out by itself, and nothing here knows its damage. A bow left in hand then goes at the first swing (attack, killNpc, killPlayer).
     * Reasons: not_in_game, dead, refused (no melee weapon worn), not_found (none of that `weapon`), no_response.
     */
    async takeMeleeSlot(options: { styles?: readonly string[]; weapon?: string; keepOnTie?: boolean } = {}): Promise<MeleeSlotResult> {
        const s = this.helpers.state();
        if (!s?.player) return fail('Not in game', 'not_in_game', { slot: null });
        if (s.player.isDead) return fail('We are dead', 'dead', { slot: null });
        if (options.keepOnTie && options.weapon === undefined) {
            const { worn, pick } = meleeChoice(s, options.styles);
            if (worn.length === 2 && pick === null) return { success: true, message: `${worn[0]!.name} and ${worn[1]!.name} are alike by style and spec: the hand stays as it is`, slot: null };
        }
        const slot = options.weapon === undefined ? this.bestMeleeSlot(s, options.styles) : slotHolding(options.weapon, s.equipment);
        if (slot === null) return options.weapon === undefined ? fail('We have no melee weapon', 'refused', { slot }) : fail(`We wear no ${options.weapon} weapon`, 'not_found', { slot });
        const name = this.sdk.getEquipmentItem(slot)?.name ?? `slot ${slot}`;
        return await this.takeInHand(slot) ? { success: true, message: `${name} in hand`, slot } : fail(`No answer to using ${name}`, 'no_response', { slot });
    }

    /** killNpc with nothing to swing. A pet that is on this mob already keeps its order: a repeat only gets a line. */
    private async killWithNoWeapon(n: NearbyNpc, options: KillOptions): Promise<KillResult> {
        const pet = options.usePet === false ? null : this.helpers.state()?.pet;
        const onIt = !!pet && this.petCanJoin(pet, n)
            && (pet.targetObjectId === n.objectId || (await this.petAttack(n, { timeout: Math.min(options.timeout ?? PET_ANSWER_MS, PET_ANSWER_MS) })).success);
        return fail(`We have no weapon to fight ${nameOf(n)} with${onIt ? ': our pet fights on' : ''}`, 'refused', { npc: this.latestNpc(n), ...noKill() });
    }

    /** The entry as it is now, for a result; the one we hold if it has gone, or its id has gone to something else (Region.cs:955, :779). */
    private latestNpc(n: NearbyNpc): NearbyNpc {
        const now = this.sdk.getNearbyNpc(n.objectId);
        return now && now.name === n.name ? now : n;
    }

    /** XP, loot and money messages trail the remove packet. A kill that pays nothing says so, and that is the end of it. */
    private async settleNpcKill(watch: MessageWatch): Promise<void> {
        const paid = await this.helpers.waitFor(() => experienceFromMessages(watch.messages()) > 0 ? 'xp' : watch.find([NO_REWARD]) ? 'nothing' : null, 2000);
        if (paid !== 'nothing') await this.helpers.sleep(400);
    }

    /** Dead by what the server said: a player's entry has it, and an NPC goes by its death event (npcJustDied). */
    private isDeadTarget(t: NearbyNpc | NearbyPlayer): boolean {
        return t.kind === 'player' ? t.isDead : this.helpers.npcJustDied(this.helpers.state(), t);
    }

    /** killNpc's orders to a window pet: one when the fight starts, another for a new pet or if it ends up on another mob. */
    private petJoiner(id: number): (s: BotWorldState, t: NearbyNpc) => Promise<void> {
        let ordered: number | null = null;
        let lastOrderAt = 0;
        return async (s, t) => {
            const pet = s.pet;
            if (!pet) return;
            // Already on it: a repeat changes nothing, and only earns a line (ControlledMobBrain.cs:216-217).
            if (pet.targetObjectId === id) {
                ordered = pet.objectId;
                return;
            }
            if (ordered === pet.objectId && pet.targetObjectId === null) return;
            if (!this.petCanJoin(pet, t) || Date.now() - lastOrderAt < PET_REORDER_MS) return;
            ordered = pet.objectId;
            lastOrderAt = Date.now();
            await this.sdk.sendPetCommand('attack', id);
        };
    }

    /**
     * Whether killNpc gives a window pet an order onto this target. It would lift a passive pet to Defensive (ControlledMobBrain.cs:213-214), beyond the range it is refused,
     * and one a turret can't carry out would only stop the fight it has (ControlledMobBrain.cs:216-225).
     */
    private petCanJoin(pet: PetState, t: NearbyNpc): boolean {
        return pet.aggression !== 'passive' && t.distance <= PET_ORDER_RANGE && !this.turretCantReach(pet, t);
    }

    /**
     * Fight an enemy player to the death, like killNpc: walk into melee range (adopting its z),
     * face, target, attack, chase while it moves (players are not extrapolated: we follow the
     * latest position) and use styles. Enemy players are named by race, so pass the objectId
     * (or the NearbyPlayer); a name is only a fallback. Success on its death: the death event or
     * isDead, never 0 % health, which is truncated (GameLiving.cs:2621): a living player with a few
     * hit points reads 0 %. Reasons: 'not_found', 'already_dead', 'not_attackable' (our realm),
     * 'immune' (PvP immunity, ours or its; retryAfterMs), 'crowd_controlled' (we are mezzed or
     * stunned; retryAfterMs), 'target_lost' (left view alive: stealth, range), 'out_of_reach'
     * (beyond maxChaseDistance), 'refused' (also in shade, with no walk: see petKill; with no melee weapon in slots 10 or 12 too), 'died', 'timeout'.
     * With a bow in hand the server refuses melee: this takes a melee slot in hand once and fights on, as killNpc does.
     * Does not wait for XP after the kill: rpGained counts the realm points that arrived by then.
     */
    async killPlayer(target: PlayerTarget, options: KillPlayerOptions = {}): Promise<KillPlayerResult> {
        const s0 = this.helpers.state();
        const p0 = s0?.player;
        const base = { player: null as NearbyPlayer | null, ...noKill() };
        if (!s0 || !p0) return fail('Not in game', 'not_in_game', base);
        if (p0.isDead) return fail('We are dead', 'dead', base);
        const t0 = this.helpers.resolvePlayer(target);
        if (!t0) return fail(`Player not found: ${describeTarget(target)}`, 'not_found', base);
        if (t0.isDead) return fail(`${t0.name} is already dead`, 'already_dead', { ...base, player: t0 });
        if (t0.realm === p0.realm) return fail(`${t0.name} is of our realm (${t0.realm})`, 'not_attackable', { ...base, player: t0 });
        if (p0.isShade) return fail(SHADE_NO_MELEE, 'refused', { ...base, player: t0 });
        if (meleeSlot(s0) === null) return fail(`We have no weapon to fight ${nameOf(t0)} with`, 'refused', { ...base, player: t0 });

        const useStyle = options.useStyle;
        const foe: Foe<NearbyPlayer> = {
            ...playerFoe(t0),
            chooseStyle: useStyle && ((pl, player, state, styles) => useStyle({ target: pl, player, state, styles })),
        };
        const fightFor = (timeout: number | undefined) => this.fightToDeath<NearbyPlayer>(foe, s0, p0, { ...options, timeout }, async () => {}, k => k.rpGained ? ` (+${k.rpGained} rp)` : '');
        const started = Date.now();
        let r = await fightFor(options.timeout);
        // The model can't tell which weapon is active, and only this line says so. A style's "requires a X weapon!" goes as it does for a monster (fight).
        if (r.reason === 'refused' && r.message.toLowerCase().includes(RANGED_IN_HAND)) {
            const slot = this.bestMeleeSlot(this.helpers.state() ?? s0, options.styles);
            if (slot !== null) {
                await this.takeInHand(slot);
                r = await fightFor(Math.max(1, (options.timeout ?? DEFAULT_KILL_TIMEOUT_MS) - (Date.now() - started)));
            }
        }
        return { ...r, player: t0 };
    }

    /** What every kill method shares: deadline, cleanup and what the fight gained. `run` replaces our own melee: the pet's fight. */
    private async fightToDeath<T extends NearbyNpc | NearbyPlayer>(
        foe: Foe<T>, s0: BotWorldState, p0: PlayerState, options: Omit<KillOptions, 'useStyle' | 'force' | 'usePet'>,
        settle: (watch: MessageWatch) => Promise<void>, gains: (k: KillNumbers) => string,
        run?: (watch: MessageWatch, sent: { attack: boolean; move: boolean }) => Promise<FightOutcome>,
    ): Promise<ActionResult & KillNumbers & { retryAfterMs?: number; attacker?: NearbyNpc }> {
        const started = Date.now();
        let diedAt: number | null = null;
        const name = nameOf(foe.first);
        const watch = this.helpers.watch();
        const timeout = options.timeout ?? DEFAULT_KILL_TIMEOUT_MS;
        // Our own melee ends its own swing, and an off from an attack before it would only cut the first of this one.
        if (!run) this.swingWatch?.();
        let stylesUsed = 0;
        const numbers = (killed: boolean): KillNumbers => {
            const s = this.helpers.state();
            const p = s?.player;
            const msgXp = experienceFromMessages(watch.messages());
            const deltaXp = p ? (p.experience - p0.experience) : 0;
            return {
                killed,
                xpGained: Math.max(msgXp, deltaXp, 0),
                rpGained: p ? Math.max(0, p.realmPoints - p0.realmPoints) : 0,
                moneyGained: Math.max(0, totalCopper(s) - p0.money.totalCopper),
                itemsGained: diffInventory(s0.inventory, s?.inventory ?? []).gained,
                durationMs: (diedAt ?? Date.now()) - started,
                levelsGained: p ? Math.max(0, p.level - p0.level) : 0,
                // A send isn't a style: "This style requires a Spear weapon!" and the like answer it, and a pet's own "You perform" can't count for ours (AttackComponent.cs:1785-1789).
                stylesUsed: Math.max(0, stylesUsed - watch.messages().filter(m => styleRefused(m.text)).length),
            };
        };
        // What fight() dispatched, set before each send: the snapshot trails dispatches (attack
        // mode only shows after the server's AttackMode echo), so cleanup must not rely on it.
        const sent = { attack: false, move: false };
        let left = false;
        // Leave the bot neither swinging nor chasing. Both are harmless when already idle (PlayerAttackRequestHandler.cs:23 StopAttack; the mover's stop is a no-op).
        // A pet's fight swings nothing of ours, so a swing going then is the caller's, and it stays: this may be the mob on us that ended the fight.
        const leaveFight = async () => {
            if (left) return;
            left = true;
            if (sent.attack || (!run && this.helpers.player()?.attacking)) await this.helpers.cleanup(() => this.sdk.sendAttack(false));
            if (sent.move || this.sdk.getMovement()?.moving) await this.helpers.cleanup(() => this.sdk.sendStop());
        };
        try {
            const outcome = await withExecutionDeadline<FightOutcome>(timeout,
                () => run ? run(watch, sent) : this.fight(foe, p0, watch, options, () => stylesUsed++, sent),
                () => ({ message: `Timed out after ${Math.round(timeout)}ms fighting ${name}`, reason: 'timeout' }));
            if (outcome !== 'killed') return { success: false, ...outcome, ...numbers(false) };
            diedAt = Date.now();
            // Before the settling: a swing still going only earns "X is already dead!" meanwhile.
            await leaveFight();
            await settle(watch);
            const result = numbers(true);
            return { success: true, message: killedLine(name, result.durationMs, gains(result)), ...result };
        } finally {
            watch.dispose();
            // Also after a timeout or an abort.
            await leaveFight();
        }
    }

    private async fight<T extends NearbyNpc | NearbyPlayer>(
        foe: Foe<T>, p0: PlayerState, watch: MessageWatch, options: Omit<KillOptions, 'useStyle' | 'force' | 'usePet'>,
        onStyle: () => void, sent: { attack: boolean; move: boolean },
    ): Promise<FightOutcome> {
        const name = nameOf(foe.first);
        const id = foe.first.objectId;
        const chase = options.chase ?? true;
        const maxChase = options.maxChaseDistance ?? 2500;
        const stood = { x: foe.first.x, y: foe.first.y };
        const baseline = maxCombatEventId(this.helpers.state());
        let lastHp = foe.first.healthPercent;
        let lastMoveAt = 0;
        let lastMoveDest: Point | null = null;
        let lastAttackAt = 0;
        let lastFaceAt = 0;
        let lastStyleAt = 0;
        let lastSwing: number | null = null;
        let styleIndex = 0;
        let refusalsSeen = 0;
        let lastTick = -1;
        let targeted = false;
        const tookInHand = new Set<string>();
        const failWith = (message: string, reason: string): FightOutcome => ({ message, reason });
        const deathCount0 = p0.deathCount;

        for (;;) {
            throwIfExecutionAborted();
            const s = await this.helpers.waitFor(st => st.tick !== lastTick ? st : null, 1000) ?? this.helpers.state();
            if (!s?.player) return failWith('Lost game state', 'not_in_game');
            lastTick = s.tick;
            const p = s.player;
            if (p.isDead || p.deathCount !== deathCount0) return failWith(`Died fighting ${name}`, 'died');

            const t = foe.find(s);
            const died = s.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === id);
            if (died || (t && foe.isDown(t))) return 'killed';
            if (!t) {
                if (foe.vanishedKilled(lastHp, watch)) return 'killed';
                return failWith(`${name} disappeared at ${lastHp}% health`, 'target_lost');
            }
            lastHp = t.healthPercent;
            const ended = foe.endsNow?.(s, t);
            if (ended) return ended;
            await foe.eachPass?.(s, t);

            const msgs = watch.messages();
            if (msgs.length > refusalsSeen) {
                const fresh = msgs.slice(refusalsSeen);
                refusalsSeen = msgs.length;
                for (const m of fresh) {
                    const text = m.text.toLowerCase();
                    const needs = STYLE_NEEDS_WEAPON.exec(m.text)?.[1];
                    if (needs && !tookInHand.has(needs)) {
                        // Once each: two styles for two weapons mustn't swap hands at every swing. The swing stops with a real switch (GamePlayer.cs:4995-4996), and starts again below.
                        tookInHand.add(needs);
                        const slot = slotHolding(needs, s.equipment);
                        if (slot !== null) {
                            await this.takeInHand(slot);
                            lastAttackAt = 0;
                            lastStyleAt = 0;
                        }
                    }
                    if (text.includes(ALREADY_DEAD)) return lastHp <= 30 ? 'killed' : failWith(m.text, 'already_dead');
                    // Before the fatal refusals: ours reads "You can't attack players until ...", and
                    // a mezz or stun "You can't attack when you are ...": both wear off by themselves.
                    if (isPvpImmunity(text)) return { message: m.text, reason: 'immune', retryAfterMs: PVP_IMMUNE_RETRY_MS };
                    if (isCrowdControlled(text)) return { message: m.text, reason: 'crowd_controlled', retryAfterMs: CROWD_CONTROLLED_RETRY_MS };
                    if (RETRYABLE_ATTACK_REFUSALS.some(r => text.includes(r))) {
                        lastFaceAt = 0; // re-face and re-approach on the next pass
                        lastMoveAt = 0;
                    } else if (ATTACK_REFUSALS.some(r => text.includes(r))) {
                        return failWith(m.text, 'refused');
                    }
                }
            }

            const dist = t.distance;
            const now = Date.now();
            if (dist > MELEE_REAPPROACH || (dist > MELEE_APPROACH && !p.attacking && !s.movement.moving)) {
                if (!chase && p.attacking) continue;
                if (Math.hypot(t.x - stood.x, t.y - stood.y) > maxChase) return failWith(`${name} ran beyond ${maxChase} units`, 'out_of_reach');
                const destMoved = !lastMoveDest || Math.hypot(t.x - lastMoveDest.x, t.y - lastMoveDest.y) > 40;
                if (!s.movement.moving || (destMoved && now - lastMoveAt > 400)) {
                    lastMoveDest = { x: t.x, y: t.y, z: t.z };
                    lastMoveAt = now;
                    sent.move = true;
                    await this.sdk.sendMoveTo(t.x, t.y, t.z, { tolerance: 50 });
                }
                continue;
            }

            if (s.movement.moving) await this.sdk.sendStop();
            // Select the target at least once per fight even when the model already shows it:
            // the server clears it on our death without a ChangeTarget (GamePlayer.cs:5743/:5900).
            if (!targeted || p.targetObjectId !== id) {
                targeted = true;
                await this.sdk.sendSetTarget(id);
            }
            if (headingDiff(p.heading, headingBetween(p, t)) > 200 && now - lastFaceAt > 500) {
                lastFaceAt = now;
                await this.sdk.sendFaceObject(id);
            }
            if (!p.attacking && now - lastAttackAt > 1500) {
                lastAttackAt = now;
                sent.attack = true;
                await this.sdk.sendAttack(true);
            }
            // A swing empties the server's queue, so one seen means the next choice can go in now. Until then a
            // queue already holds: sending again only gets "You have already selected your styles for this round!".
            const swing = s.combatEvents.findLast(e => e.kind === 'melee' && e.attackerObjectId === p.objectId)?.id ?? null;
            if (swing !== lastSwing) { lastSwing = swing; lastStyleAt = 0; }
            if ((options.styles?.length || foe.chooseStyle) && now - lastStyleAt > STYLE_RESEND_MS && p.attacking) {
                const styles = s.skills.styles;
                let choice: StyleChoice;
                if (foe.chooseStyle) choice = foe.chooseStyle(t, p, s, styles);
                else {
                    choice = options.styles![styleIndex % options.styles!.length];
                    styleIndex++;
                }
                const queue = styleQueue(choice, styles);
                if (queue.length && p.endurancePercent >= 15) {
                    lastStyleAt = now;
                    let sent = false;
                    for (const style of queue) sent = (await this.sdk.sendUseSkill(style.skillIndex)).success || sent;
                    if (sent) onStyle();
                }
            }
        }
    }

    /**
     * Cast a spell (name, RegExp or Spell) on a target, or on the current
     * target when none is given; a friendly spell with no target given lands on
     * ourselves, whatever is selected. Selects the target every time (the server
     * drops it on death without telling the client) and re-selects and retries
     * once on "You must select a target" while that target is still there
     * (CastOptions.retryNoTarget). Observes the cast start ("You begin
     * casting", cast animation) and completion ("You cast a <spell> spell!", or
     * an effect/damage/resist once the cast time is up). Reason 'died' when we
     * die mid-cast; 'dead' when already dead before casting; 'crowd_controlled'
     * (with retryAfterMs) when we are mezzed, stunned or silenced. A cast whose
     * target is immune to its effect succeeds with effectImmune. A spell that targets
     * Pet, with no target given, lands on the pet whatever is selected: no walk, select or
     * face, and reason 'no_pet' without one. A Necromancer's servant spell succeeds once the servant takes it on: the
     * server says nothing of the owner's half. If all we know is that the servant will get to it, the result has `queued`:
     * a later cast replaces it, and each is paid, so cast again only after the last one lands. Its refusals: out_of_range (the
     * servant is too far from the target or can't see it), invalid_target (power transferred to ourselves), no_pet (it went).
     * An Enemy spell with no target given while we have selected ourselves or a pet of ours: 'no_target', uncast (the server moves
     * a servant's new target onto us when we have none, NecromancerPet.cs:27-29). Reason 'pulse_cancelled': that pulsing spell
     * was running, and the cast only stopped it. An Enemy spell that can't land is refused before any walk, send or selection, a target given or selected: no_target at our
     * own id, not_attackable at a peace flag or an untargetable NPC (the server would say nothing), invalid_target at anything of our realm, our pets too, and a duel partner: the
     * client can't tell a duel (NormalServerRules.cs:50-52). An Enemy spell with range 0, a point-blank area spell, needs none of that with no target given: it goes off around us, and the server
     * looks at no selection (SpellHandler.cs:682-686, :918, :1591). What is selected stays selected, and the result names it only if the spell could hit it. A target given is judged as above.
     * Reason already_dead: a player the model knows is dead, before anything is sent, or the server's answer (SpellHandler.cs:783), not for a Corpse spell, nor for a Group spell, which has no such
     * check and lands on the living with a corpse named (HealSpellHandler.cs:76-78): its message names nobody, and `target` is only what was selected. An NPC's 0 % is no such knowledge: it is truncated (GameLiving.cs:2621).
     * A Corpse spell at a player the model holds alive, with health to show for it, at any NPC or at our own id: reason invalid_target before any walk, in the server's words (SpellHandler.cs:759-766), and its answer for what the model hasn't seen has the same reason.
     * A target that dies during the cast ends the wait at its death: reason already_dead, with targetDied, also with "You must select a target for this spell!" beside it, which is all a cast gets as it ends with its target gone. The server says nothing to a cast at the dead (SpellHandler.cs:852-1007, AbstractServerRules.cs:337) and goes on until the cast's end, so a cast sent in that time is held as a follow-up. A walk doesn't break it: the client's mover holds for the cast's time + 250 ms (client/session.ts:501), so an owner running after this stands up to about 2.8 s of a 2.5 s cast. A sit does, and a swing request at once, "Your spell is cancelled!" (AttackComponent.cs:661-665). The next castSpell with a cast time therefore waits for that end, at most what the cast had left, unless an 0x0B ended it; an instant goes beside it (CastingComponent.cs:376-377), and nothing else is held. Not for what lands on ourselves, on the pet or on a group, nor for a Corpse spell, and not for what doesn't hang on the mob selected: an Area spell, a Cone or an Enemy spell with range 0 goes on and lands on what is there (SpellHandler.cs:908-918).
     * A cast sent during one that is still running (a raw send's, say) reads must_wait, at once, with retryAfterMs what's left of that one: never no_response, and the running cast's own lines are no answer to it. With "You prepare this spell as a follow up!" the server holds this spell and starts it by itself, so the result has followUpMs, and the next castSpell waits that out as well; unless that cast fails at its end (its target gone, say): the server then drops what it holds without a word, and the next castSpell goes once no begin has come 500 ms past that end.
     * A pet's attack order refused just before ("You can't attack ...", PvP immunity) answers on the same stream: within 500 ms of sdk.sendPetCommand('attack'), and with this cast's begin line there or in the same tick, that line is the order's. With no begin line by then it is this cast's too.
     * Release Clump (TurretsRelease) needs a turret of ours selected where other Pet spells go to the pet by themselves (TurretSpellHandler.cs:20-41): with no target given this selects the window pet or a summon, unless one of ours is selected; its refusal is invalid_target. What was selected before comes back with the cast's end, if it is still there, else nothing is selected.
     * The walk into range stops inside it by the smaller of 10 % of the range and 150, in 3D, by what the target reads as it goes. A target that moves on from there gets the server's "That target is too far away!" at the cast's end: reason out_of_range, and the caller goes again: for 30 s or until a cast at it lands, the next walk at it stops short by as much again as it left in a cast, by our own readings, at most at half the range. A height it can't climb leaves the first reading inside the range good enough, and the cast goes from there.
     * A target that dies on the way ends the walk at once, with nothing cast: reason already_dead, with targetDied, a friend's too. A corpse that gets up ends it as well, reason invalid_target in the Corpse spell's own words. An id gone just after its death reads already_dead with targetDied, and one merely out of view not_found.
     * Reason refused for a song with no instrument in hand, naming the song and the instrument we wear, with retryAfterMs of 60 s: only a change of hand cures it. Reason interrupted has retryAfterMs 2200, the server's own wait (SpellHandler.cs:372). A mezz's or a stun's line beside the 0x0B reads crowd_controlled, and so does Amnesia's, which ends a cast with no 0x0B and no line of the cast's own (AmnesiaSpellHandler.cs:50). An item's recast line ("... to discharge this item!") answers the useItem and says nothing of the cast.
     * Reason not_visible: "You can't see your target from here!", a hill between us by the client's LoS answer (sdk/vision.ts lineOfSight). castSpell then steps toward the target to the first spot that sees it over the terrain (sightStep), up to SIGHT_STEP_MAX (with `approach: false` only up to SIGHT_STEP_SHORT, and only when such a spot is that near), and casts once more; its message then says so.
     */
    async castSpell(spell: NamePattern | Spell, target?: ObjectTarget | null, options: CastOptions = {}): Promise<CastResult> {
        const base = { spell: null as Spell | null, target: null as Obj | null, castTimeMs: null as number | null, completed: false, resisted: false, damage: 0, messages: [] as GameMessage[] };
        const player = this.helpers.player();
        if (!player) return fail('Not in game', 'not_in_game', base);
        if (player.isDead) return fail('We are dead', 'dead', base);
        const sp = typeof spell === 'object' && !(spell instanceof RegExp) ? spell : this.sdk.findSpell(spell);
        if (!sp) return fail(`Spell not found: ${describeTarget(spell)} (known: ${this.sdk.getSkills().spells.map(x => x.name).join(', ') || 'none'})`, 'spell_not_found', base);
        if (sp.cooldownRemaining > 0) return fail(`${sp.name} is on cooldown (${sp.cooldownRemaining}s)`, 'cooldown', { ...base, spell: sp });

        let obj: Obj | null = null;
        const info = this.getSpellInfo(sp);
        const kind = info?.target.toLowerCase() ?? '';
        const friendly = kind === 'realm' || kind === 'group';
        const noTarget = target === undefined || target === null;
        const pointBlank = kind === 'enemy' && info?.range === 0;
        // The target to (re)select before casting. Always sent, never skipped because the model
        // already shows it: the server clears TargetObject on our death without telling the client
        // (GamePlayer.cs:5743 and :5900; GameLiving.cs:2842 is a plain property, no SendChangeTarget),
        // so after a release the model can still hold a target the server no longer has.
        let targetId: number | null = null;
        // Release Clump's select of a turret, which goes with the turret: what to put back as the cast ends.
        let reselect: { previous: number | null; turret: number } | null = null;
        const onPet = kind === 'pet' && noTarget;
        if (kind === 'self') {
            // Self buffs: no approach, keep the current target.
        } else if (onPet) {
            // The server redirects it to the pet, unless the target is another pet of ours (SpellHandler.cs:463-473): selecting costs a swing.
            const selected = player.targetObjectId !== null ? this.sdk.getNearbyNpc(player.targetObjectId) : null;
            const oursSelected = !!selected?.isPet && selected.realm === player.realm;
            const s = this.helpers.state();
            // This one has to be told (TurretSpellHandler.cs:20-41). Its Radius goes from the one selected, and the window pet or any summon of ours will do.
            const turret = info?.type === 'TurretsRelease' && !oursSelected ? s?.pet?.objectId ?? s?.summons?.find(id => this.sdk.getNearbyNpc(id)) : undefined;
            if (s?.pet === null && !oursSelected && turret === undefined) return fail('No pet to cast this on', 'no_pet', { ...base, spell: sp });
            if (turret !== undefined) {
                targetId = turret;
                reselect = { previous: player.targetObjectId, turret };
            }
            obj = this.sdk.getPet() ?? (turret !== undefined ? this.sdk.getNearbyNpc(turret) : null);
        } else if (friendly && (noTarget || target === player.objectId)) {
            // Heals/buffs default to ourselves ("You must select a target for this spell!" otherwise).
            targetId = player.objectId;
        } else if (!noTarget) {
            // Our id is in no nearby list. The server would only say "You can't attack yourself!".
            if (kind === 'enemy' && namesUs(target, player.objectId)) return fail(`${sp.name} needs an enemy, and that is us`, 'no_target', { ...base, spell: sp });
            if (kind === 'corpse' && namesUs(target, player.objectId)) return fail(CORPSE_ONLY, 'invalid_target', { ...base, spell: sp });
            obj = this.helpers.resolveAny(target!);
            if (!obj) {
                const dead = this.deadAndGone(target);
                return dead ? fail(dead, 'already_dead', { ...base, spell: sp, targetDied: true as const }) : fail(`Target not found: ${describeTarget(target)}`, 'not_found', { ...base, spell: sp });
            }
            if (friendly && obj.kind !== 'object' && obj.realm !== player.realm) {
                return fail(`${sp.name} targets ${info!.target}, not the enemy ${nameOf(obj)}`, 'invalid_target', { ...base, spell: sp, target: obj });
            }
        } else if (player.targetObjectId !== null) {
            const selected = player.targetObjectId;
            const ours = kind === 'enemy' && (selected === player.objectId || this.helpers.ownPets(this.helpers.state()).has(selected));
            // It would only earn "You can't attack yourself!". A servant's new target becomes ours when we have none, and a spell of ours on it can leave it there (NecromancerPet.cs:27-29).
            if (ours && !pointBlank) return fail(`${sp.name} needs an enemy, and ${selected === player.objectId ? 'that is us' : 'we have our own pet selected'}`, 'no_target', { ...base, spell: sp });
            if (kind === 'corpse' && selected === player.objectId) return fail(CORPSE_ONLY, 'invalid_target', { ...base, spell: sp });
            obj = ours ? null : this.sdk.getObject(selected);
            // The server skips every target check at range 0 (SpellHandler.cs:682-686, :918): what it can't hit is no refusal, and nothing to walk to or face.
            if (pointBlank && obj && this.castTargetRefusal(sp, info, obj, player)) obj = null;
        }
        if (obj && !onPet) {
            const refused = this.castTargetRefusal(sp, info, obj, player);
            if (refused) return fail(refused.message, refused.reason, { ...base, spell: sp, target: obj });
            const range = spellRange(info, options, this.helpers.state()?.effects);
            if (obj.distance > range && options.approach !== false) {
                const walk = await this.walkIntoSpellRange(obj, range, info?.castTime ?? 0, o => this.castTargetRefusal(sp, info, o, player));
                if (!walk.success) return { ...fail(walk.message, walk.reason ?? 'out_of_reach', base), spell: sp, target: walk.target ?? obj, ...(walk.targetDied ? { targetDied: true as const } : {}) };
                obj = walk.target ?? obj;
            }
            if (obj.objectId !== player.objectId) targetId = obj.objectId;
        }
        if (info?.castTime !== 0) await this.castHeldOver();
        const baseline = maxCombatEventId(this.helpers.state());
        if (targetId !== null) await this.sdk.sendSetTarget(targetId);
        const p = this.helpers.player()!;
        if (p.isSitting) await this.sdk.sendSit(false);
        if (this.sdk.getMovement()?.moving) await this.sdk.sendStop();
        if (obj && !onPet && obj.objectId !== p.objectId) await this.sdk.sendFaceObject(obj.objectId);

        const from = { reading: obj?.distance ?? 0, at: Date.now() };
        let cast = await this.castOnce(sp, obj, info, options, targetId, baseline, p);
        // A hill between us (the client answers the server's LoS check from the terrain): step to where we see it, and once more.
        if (cast.reason === 'not_visible' && obj && !onPet && targetId !== null && obj.objectId !== p.objectId && await this.stepIntoSight(obj, options.approach === false)) {
            const seen = this.sdk.getObject(targetId);
            if (seen) {
                obj = seen;
                await this.sdk.sendFaceObject(targetId);
                const again = await this.castOnce(sp, obj, info, options, targetId, maxCombatEventId(this.helpers.state()), this.helpers.player() ?? p);
                cast = { ...again, message: `${again.message} (stepped into sight after "${cast.message}")` };
            }
        }
        if (targetId !== null) this.tooFar = cast.reason === 'out_of_range' ? { id: targetId, ...from } : this.tooFar?.id === targetId ? null : this.tooFar;
        // The turret goes with the spell, and the server's selection stays on the deleted NPC where a later Pet spell would land (backToTarget).
        if (reselect) await this.backToTarget(reselect.previous, reselect.turret);
        return cast;
    }

    /** After a cast refused for sight: walk to sightStep's spot, a short one that sees the target when `holding`. False with no step to take or a walk that failed. */
    private async stepIntoSight(obj: Obj, holding: boolean): Promise<boolean> {
        const me = this.helpers.player();
        if (!me) return false;
        const spot = holding ? sightStep(me.regionId, me, obj, terrainGround, SIGHT_STEP_SHORT, true) : sightStep(me.regionId, me, obj);
        if (!spot) return false;
        const w = await this.walkTo(spot.x, spot.y, { z: spot.z, tolerance: 40, timeout: 8000 });
        return w.success;
    }

    /** castSpell's cast, and its one more try on "You must select a target". */
    private async castOnce(sp: Spell, obj: Obj | null, info: SpellInfo | null, options: CastOptions, targetId: number | null, baseline: number, p: PlayerState): Promise<CastResult> {
        const first = await this.observeCast(sp, obj, info, options);
        if (first.reason !== 'no_target' || targetId === null || options.retryNoTarget === false) return first;
        // "You must select a target" before the cast began: the server lost our target after all
        // (e.g. it cleared it while this cast was being set up). Select it again and try once more,
        // but only while it is the target we chose. A refusal after "You begin casting", a death,
        // or another name under the ID (the server reuses a dead mob's ID for the next spawn) means
        // it is gone, and a retry would land on whatever holds the ID now.
        const s = this.helpers.state();
        const began = first.castTimeMs !== null
            || first.messages.some(m => /you begin casting/i.test(m.text))
            || !!s?.combatEvents.some(e => e.id > baseline && e.kind === 'spellCast' && e.attackerObjectId === p.objectId);
        const died = !!s?.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === targetId);
        // No obj: a friendly spell on ourselves, which cannot be replaced.
        const same = !obj || this.sdk.getObject(targetId)?.name === obj.name;
        if (began || died || !same) return { ...first, message: `${first.message} (target gone, not retried)` };
        await this.sdk.sendSetTarget(targetId);
        return this.observeCast(sp, obj, info, options);
    }

    /** Why this spell can never land on this target, from what we can see of it; the server's answer would come after a walk, or not at all. */
    private castTargetRefusal(sp: Spell, info: SpellInfo | null, obj: Obj, player: PlayerState): { message: string; reason: string } | null {
        if (obj.kind === 'object') return null;
        const kind = info?.target.toLowerCase();
        const enemy = kind === 'enemy';
        // SpellHandler.cs:759-766. Alive is what the entry shows, with health to go with it: a living player can read 0 % (GameLiving.cs:2621), and so can a corpse whose death we didn't see.
        if (kind === 'corpse') return obj.kind === 'npc' || (!obj.isDead && obj.healthPercent > 0) ? { message: CORPSE_ONLY, reason: 'invalid_target' } : null;
        // SpellHandler.cs:780-783, in its case for Realm, Enemy and Corpse: a spell for the dead has a target kind of its own, and a Group spell no check at all (:640-686). An NPC's 0 % doesn't tell (GameLiving.cs:2621).
        if (obj.kind === 'player' && obj.isDead && (enemy || kind === 'realm')) return { message: `${obj.name} is dead!`, reason: 'already_dead' };
        if (!enemy) return null;
        const barred = obj.kind === 'npc' ? unattackable(obj) : null;
        if (barred) return barred;
        // The mirror of the friendly spell on an enemy above. The server's answer is "You can't attack a member of your realm!" once in range (NormalServerRules.cs:47-67).
        if (obj.realm !== 'none' && obj.realm === player.realm) return { message: `${sp.name} needs an enemy, and ${nameOf(obj)} is of our realm`, reason: 'invalid_target' };
        return null;
    }

    /**
     * How long the next castSpell of `spell` would wait for a cast the server runs on and castSpell no longer watches (see castSpell), in ms: 0 with none, and for an instant, which goes beside it. Without `spell`, for one with a cast time.
     * For a caller whose reasons for a cast can go stale in that wait: it can come back after it and look again.
     */
    castHeldLeftMs(spell?: Spell): number {
        if (spell && this.getSpellInfo(spell)?.castTime === 0) return 0;
        const s = this.helpers.state();
        return this.castHeld && s ? this.castHeldLeft(this.castHeld, s) : 0;
    }

    /** What's left of that cast: to its end, unless we died, an 0x0B ended it, or a follow-up's begin is overdue. */
    private castHeldLeft(held: CastHeld, s: BotWorldState): number {
        const now = Date.now();
        const me = s.player?.objectId;
        const ours = (kind: string) => s.combatEvents.some(e => e.id > held.seen && e.kind === kind && e.attackerObjectId === me);
        if (s.player?.isDead || ours('interrupt') || (held.beginBy !== undefined && now >= held.beginBy && !ours('spellCast'))) return 0;
        return Math.max(0, held.until - now);
    }

    /** Wait out castHeld, if any. */
    private async castHeldOver(): Promise<void> {
        const held = this.castHeld;
        this.castHeld = null;
        if (!held || held.until <= Date.now()) return;
        await this.helpers.waitFor(s => this.castHeldLeft(held, s) === 0, held.until - Date.now());
    }

    /**
     * The walk castSpell does: inside the range by a margin, in 3D, by what the target reads as it goes. It used to stop at half of it: 85 % of the range for a margin, and walkToObject's arrival radius, 60 % of that, meant for a melee range, with nothing to end the walk sooner.
     * `pointless` ends it on the target as it reads then (castTargetRefusal).
     */
    private walkIntoSpellRange(obj: Obj, range: number, castSeconds: number, pointless?: WalkInOptions['pointless']): Promise<WalkToObjectResult> {
        const margin = spellWalkStop(range);
        const nearest = range * SPELL_WALK_NEARER_SHARE;
        const far = this.tooFar?.id === obj.objectId ? this.tooFar : null;
        const age = far ? Date.now() - far.at : Infinity;
        const leaving = far && age < SPELL_TOO_FAR_MS ? Math.max(0, obj.distance - far.reading) / (Math.max(1, age) / 1000) : 0;
        return this.walkInto(obj, { range: leaving > 0 ? Math.max(nearest, margin - leaving * castSeconds) : margin, firstReading: true, enough: range, pointless });
    }

    /** Dispatch one cast and observe it: refusal, death, start, and completion. */
    private async observeCast(sp: Spell, obj: Obj | null, info: SpellInfo | null, options: CastOptions): Promise<CastResult> {
        const base = { spell: sp, target: obj, castTimeMs: null as number | null, completed: false, resisted: false, damage: 0, messages: [] as GameMessage[] };
        const p = this.helpers.player();
        if (!p) return fail('Not in game', 'not_in_game', base);
        const deathCount0 = p.deathCount;
        const watch = this.helpers.watch();
        const baseline = maxCombatEventId(this.helpers.state());
        const me = p.objectId;
        const spellName = sp.name.toLowerCase();
        // Whole, in the server's words (Spells.txt:5-6): 'Ice Cloud' is inside 'Ice Cloud (Minor)'.
        const quoted = sp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const ownBegin = new RegExp(`^you begin casting an? ${quoted} spell`, 'i');
        const ownCast = new RegExp(`^you cast an? ${quoted} spell`, 'i');
        const servantSpell = info?.type === 'PetSpell';
        const summonKind = info ? petSpellKind(info.type) : null;
        // A charm has a roll of its own (CharmSpellHandler.cs:419-436), and the others no direct effect: a summon can't be resisted (SummonSpellHandler.cs:195), and what lands meanwhile is someone else's.
        const summon = summonKind !== null && summonKind !== 'charm';
        const canResist = !summon && info?.target.toLowerCase() !== 'self';
        const castStart = Date.now();
        try {
            const r = sp.lineIndex >= 0 ? await this.sdk.sendCastSpell(sp.lineIndex, sp.spellIndex) : await this.sdk.sendUseSkill(sp.skillIndex ?? -1);
            if (!r.success) return fail(r.message, r.reason ?? 'dispatch_failed', base);
            const castEvent = (s: BotWorldState) => s.combatEvents.find(e => e.id > baseline && e.kind === 'spellCast' && e.attackerObjectId === me);
            // When this cast can land. Hits, effects and resists before then belong to something
            // else: a running DoT ticks "Your <dot> hits X for N damage!" (DoTSpellHandler.cs:87,
            // Spells.txt:99) and a damage shield answers every melee hit with "You hit X for N damage!"
            // (DamageAddAndShield.cs:74, Spells.txt:93). The cast animation carries the real cast time;
            // without it, the static cast time less a margin for dexterity/quickcast.
            const landsAt = (s: BotWorldState): number => {
                const ev = castEvent(s);
                if (ev?.castTimeMs !== undefined) return castStart + ev.castTimeMs - 250;
                return castStart + (info?.castTime ?? 0) * 1000 * 0.6;
            };
            const landed = (s: BotWorldState) => {
                const t = landsAt(s);
                return watch.messages().filter(m => m.receivedAt >= t);
            };
            // A servant's spell has no "You cast" (PetSpellHandler.cs:41-70 skips the base FinishSpellCast) and, instant, no animation
            // (SpellHandler.cs:1062). The servant casts the sub-spell once our half is over, so the signs of it name the pet (an earlier cast of its can run through ours).
            const servantCasts = (s: BotWorldState): boolean => {
                if (!servantSpell) return false;
                if (landed(s).some(m => isServantCast(m.text, sp.name))) return true;
                const pet = s.pet?.objectId;
                const t = landsAt(s);
                return pet !== undefined && s.combatEvents.some(e => e.id > baseline && (e.kind === 'spellCast' || e.kind === 'spellEffect') && e.attackerObjectId === pet && e.receivedAt >= t);
            };
            const servantQueued = (s: BotWorldState): boolean => servantSpell && !servantCasts(s) && landed(s).some(m => isServantQueued(m.text));
            /**
             * A resist line of this cast. The line names only who resisted, and a pet's spell gets the same one (SpellHandler.cs:2390, :2446-2456),
             * so it goes by the 0x1B the server sends with it (:2365-2368): ours at the target beside it, and no pet's nearer. An area spell has no one target to pair it with;
             * anything else with no target is on ourselves, and has nothing to resist. A player's line has the real name, which an enemy's entry doesn't (PacketLib1124.cs:404, NormalServerRules.cs:292-297): for them the 0x1B alone says.
             */
            const ourResist = (m: GameMessage, s: BotWorldState): boolean => {
                if (!canResist || !isResistOf(m.text, obj?.kind === 'player' ? null : obj?.name ?? null)) return false;
                if (!obj) return !info || info.radius > 0 || info.target.toLowerCase() === 'area';
                const pets = this.helpers.ownPets(s);
                const gap = (by: (attacker: number) => boolean): number => Math.min(...s.combatEvents
                    .filter(e => e.kind === 'spellEffect' && e.targetObjectId === obj.objectId && e.attackerObjectId !== null && by(e.attackerObjectId))
                    .map(e => Math.abs(e.receivedAt - m.receivedAt)));
                const ours = gap(id => id === me);
                return ours <= RESIST_PAIR_MS && gap(id => pets.has(id)) >= ours;
            };
            /** 'cast' = "You cast a <spell> spell!" (SpellHandler.cs:1337); 'hit' = weaker evidence after landing. */
            const evidence = (s: BotWorldState): 'cast' | 'hit' | null => {
                if (watch.messages().some(m => ownCast.test(m.text))) return 'cast';
                if (servantCasts(s) || servantQueued(s)) return 'cast';
                for (const m of landed(s)) {
                    if (/extra damage|for an additional/i.test(m.text)) continue; // damage add / procs
                    const named = /^your (.+?) (?:critically )?hits .+? for \d+/i.exec(m.text);
                    if (named) {
                        if (named[1]!.toLowerCase() === spellName) return 'hit';
                        continue; // another spell's DoT tick
                    }
                    if (/^you hit .+? for \d+/i.test(m.text) || ourResist(m, s) || /your target is immune/i.test(m.text) || ENRAGED_REFUSAL.test(m.text)) return 'hit';
                }
                const t = landsAt(s);
                return s.combatEvents.some(e => e.id > baseline && e.kind === 'spellEffect' && e.attackerObjectId === me && e.receivedAt >= t) ? 'hit' : null;
            };
            const died = (s: BotWorldState) => !!s.player && (s.player.isDead || s.player.deathCount !== deathCount0);
            // InterruptSpellCast (0x0B) names the interrupted caster.
            const interruptEvent = (s: BotWorldState) => s.combatEvents.some(e => e.id > baseline && e.kind === 'interrupt' && e.attackerObjectId === me);
            // Whether what our cast aims at still stands: a spell on ourselves or on the pet has no target to lose (SpellHandler.cs:918-920).
            const aimStands = (s: BotWorldState): boolean => {
                if (!obj) return ['self', 'realm', 'group', 'pet'].includes(info?.target.toLowerCase() ?? '');
                return !s.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === obj.objectId) && this.sdk.getObject(obj.objectId)?.name === obj.name;
            };
            // A casting pet's "You must select a target" reaches us too: its target went (SpellHandler.cs:923-926, relayed at :2450-2455).
            // Our cast gets that line before it begins or as it ends with its own target gone (CheckDuringCast, :1014-1032, has no such check).
            const begun = (s: BotWorldState): boolean => !!castEvent(s) || !!watch.find(['you begin casting']);
            const petLostTarget = (m: GameMessage, s: BotWorldState): boolean =>
                /you must select a target/i.test(m.text) && begun(s) && aimStands(s);
            // A 0xEC answered while we cast (PlayerGroundTargetHandler.cs:30-33): the server goes on, and what stands at the end of the cast decides (SummonAnimistPet.cs:50-58).
            const spotDroppedInCast = (m: GameMessage, s: BotWorldState): boolean => m.text.toLowerCase().includes(GROUND_TARGET_DROPPED) && begun(s);
            // A Group spell gets it per dead member, and lands on the others all the same (HealSpellHandler.cs:76-78).
            const deadOfOurs = (m: GameMessage): boolean => !!obj && info?.target.toLowerCase() !== 'group' && isDeadLineOf(m.text, obj.kind === 'player' && obj.realm !== p.realm ? null : obj.name);
            // With its target dead the cast comes to nothing, and the server doesn't say so: a corpse is refused in silence, and only one gone from the world at its end gets a line (SpellHandler.cs:923-926, :977-978, AbstractServerRules.cs:337). What the spell did to it first came before this.
            // Only what asks for a living target at its end: a spot for AREA, and none at all for CONE or at Range 0 (SpellHandler.cs:908-918).
            const hangsOnAim = !['self', 'group', 'pet', 'corpse', 'area', 'cone'].includes(info?.target.toLowerCase() ?? '') && info?.range !== 0;
            const aimDied = (s: BotWorldState): boolean => !!obj && hangsOnAim
                && s.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === obj.objectId);
            // That line comes k x 33 ms behind the 0xA2 (reaper, then the cast's tick: GameLoop.cs:152-161), so one snapshot can hold both: the death's, and no refusal.
            const lineOfTheDeath = (m: GameMessage, s: BotWorldState): boolean => /you must select a target/i.test(m.text) && aimDied(s);
            // Amnesia at a cast with a cast time, once it has begun: nothing else will say it ended. Before that it found nothing to clear, and it leaves a song alone.
            const wipedCast = (m: GameMessage, s: BotWorldState): boolean => {
                if ((info?.instrumentRequirement ?? 0) !== 0 || info?.castTime === 0) return false;
                const lines = watch.messages();
                const begin = lines.findIndex(l => /you begin casting/i.test(l.text));
                return (castEvent(s)?.receivedAt ?? Infinity) <= m.receivedAt || (begin >= 0 && begin < lines.indexOf(m));
            };
            // What the rest of the group's fight earns on this stream: the side tick's attack order answers beside any cast, and only an Enemy spell can earn these itself (ATTACK_ONLY_REFUSALS). A servant's spell goes by its own rules.
            const earnsNoAttackLine = !!info && !servantSpell && info.target.toLowerCase() !== 'enemy';
            const notOurAttack = (m: GameMessage): boolean => earnsNoAttackLine && ATTACK_ONLY_REFUSALS.some(r => m.text.toLowerCase().includes(r));
            // A line only an attack earns, just after our pet was ordered to one: the side tick's order goes between turns, so its refusal lands in this cast's first tick (20261104-045249, one snapshot with "You begin casting", and the cast landed).
            const answersOrder = (m: GameMessage): boolean => {
                if (!ATTACK_ONLY_REFUSALS.some(r => m.text.toLowerCase().includes(r))) return false;
                const order = this.sdk.getPetAttackSentAt();
                return order !== null && m.receivedAt >= order && m.receivedAt - order <= PET_ORDER_ANSWER_MS;
            };
            // With this cast's begin there or due in this tick. By then with none, an attack this cast earned as well: a shade, say, for both.
            const orderNotCast = (m: GameMessage, s: BotWorldState): boolean => answersOrder(m) && (begun(s) || Date.now() - m.receivedAt < BEGIN_LINE_TICK_MS);
            // A line from before our send answers something else. A game line waits for the client's next publish, up to 250 ms (client.ts:163-168), and the watch goes by id, so the last cast's end line can come in here, the wait for that cast over, with nothing else sent yet (20261104-050819: 'Petcab: petBuff: no_target', 60 s of buffRetryMs, the cast running).
            const refusal = (s: BotWorldState): string | null =>
                watch.findText(CAST_ANSWERS, m => m.receivedAt >= castStart && !ITEM_RECAST.test(m.text) && (!CAST_WIPED.test(m.text) || wipedCast(m, s)) && !petLostTarget(m, s) && !spotDroppedInCast(m, s) && !lineOfTheDeath(m, s) && !notOurAttack(m) && !orderNotCast(m, s) && (!TARGET_IS_DEAD.test(m.text) || deadOfOurs(m))) ?? (interruptEvent(s) ? watch.findText([HELD_LINE]) ?? 'Your spell is interrupted.' : null);
            // Sent during a cast that runs on: that cast's own lines are no answer to this one (20261104-050819: the line and "You must select a target for this spell!" in one snapshot), nor what it lands as, under the same name. Until this one's own begin line: it was held, and now it goes.
            const heldBehind = (): GameMessage | null => (watch.messages().some(m => ownBegin.test(m.text)) ? null : watch.find([ALREADY_CASTING]));
            const msgs = () => watch.messages().slice();
            const diedResult = (castTimeMs: number | null) => fail(`Died while casting ${sp.name}`, 'died', { ...base, castTimeMs, messages: msgs() });
            const ownCastMs = () => (info ? info.castTime * 1000 : 3000);
            const aimDiedResult = (castTimeMs: number | null) => {
                const s = this.helpers.state()!;
                const ev = castEvent(s);
                // The server goes on to the cast's end (see castSpell): the next cast is told when that is. With no sign it began, it can't have gone far enough to hold anything.
                if (ev || watch.find(['you begin casting'])) this.castHeld = { until: (ev?.receivedAt ?? castStart) + (ev?.castTimeMs ?? castTimeMs ?? ownCastMs()) + CAST_END_MARGIN_MS, seen: baseline };
                return fail(`${nameOf(obj!)} died before ${sp.name} could land`, 'already_dead', { ...base, castTimeMs, messages: msgs(), targetDied: true as const });
            };

            // The line says nothing of what it wants: which song, and what we could bring out for it (a melee slot's club is the usual reason, gear-template.ts).
            const answer = (text: string): string => {
                if (!text.toLowerCase().includes(NO_INSTRUMENT)) return text;
                const worn = this.helpers.state()?.equipment.find(i => i.objectType === ObjectType.Instrument);
                return `${text} ${sp.name} needs one in hand: ${worn ? `${worn.name}, in slot ${worn.slot}` : 'we wear none'}`;
            };

            const heldResult = () => {
                const line = heldBehind()!;
                const s = this.helpers.state()!;
                const left = ownCastLeftMs(s, me) || ALREADY_CASTING_UNREAD_MS;
                const queued = line.text.toLowerCase().includes(FOLLOW_UP);
                // What it holds runs after that: the next cast sent during it would be queued in turn, and read must_wait with its own spell landing, for as long as the turns go on casting. If it begins: the server drops it with a running cast that fails at its end.
                if (queued) this.castHeld = { until: Date.now() + left + ownCastMs() + CAST_END_MARGIN_MS, seen: maxCombatEventId(s), beginBy: Date.now() + left + FOLLOW_UP_BEGINS_MS };
                return { ...fail(line.text, 'must_wait', base), messages: msgs(), retryAfterMs: left, ...(queued ? { followUpMs: ownCastMs() } : {}) };
            };

            const started = await this.helpers.waitFor<'died' | 'held' | 'refused' | 'cast' | 'hit' | 'started' | 'aimDied'>(s => {
                if (died(s)) return 'died';
                if (heldBehind()) return 'held';
                if (refusal(s)) return 'refused';
                const e = evidence(s);
                if (e) return e;
                if (aimDied(s)) return 'aimDied';
                if (castEvent(s) || watch.find(['you begin casting'])) return 'started';
                return null;
            }, 3000);
            if (started === 'died') return diedResult(null);
            if (started === 'aimDied') return aimDiedResult(castEvent(this.helpers.state()!)?.castTimeMs ?? null);
            if (started === 'held') return heldResult();
            if (started === 'refused') {
                const text = refusal(this.helpers.state()!)!;
                return { ...fail(answer(text), castFailureReason(text), base), messages: msgs(), retryAfterMs: retryAfter(text) };
            }
            // Dead between our read and the baseline: no event for aimDied, and the server stays silent (SpellHandler.cs:923-926). Only after the silence: an id comes back fast, and a new mob on it is no corpse.
            if (!started && obj && hangsOnAim && this.helpers.diedLately(this.helpers.state(), obj.objectId)) return aimDiedResult(null);
            if (!started) return fail(`No cast observed for ${sp.name}`, 'no_response', { ...base, messages: msgs() });
            let castTimeMs = castEvent(this.helpers.state()!)?.castTimeMs ?? null;
            let done: 'cast' | 'hit' | null = started === 'started' ? null : started;
            if (!done) {
                const end = await this.helpers.waitFor<'died' | 'held' | 'refused' | 'cast' | 'hit' | 'aimDied'>(s => {
                    if (died(s)) return 'died';
                    // The running cast's 0x72 can come in after we sent this one, and read as its start.
                    if (heldBehind()) return 'held';
                    if (refusal(s)) return 'refused';
                    return evidence(s) ?? (aimDied(s) ? 'aimDied' : null);
                }, (castTimeMs ?? (info ? info.castTime * 1000 : 3000)) + (options.timeout ?? 2500));
                // The 0x72 can come after what told us the cast began.
                castTimeMs = castEvent(this.helpers.state()!)?.castTimeMs ?? castTimeMs;
                if (end === 'died') return diedResult(castTimeMs);
                if (end === 'held') return heldResult();
                if (end === 'aimDied') return aimDiedResult(castTimeMs);
                if (end === 'refused') {
                    const text = refusal(this.helpers.state()!)!;
                    return { ...fail(answer(text), castFailureReason(text, 'interrupted'), base), castTimeMs, messages: msgs(), retryAfterMs: retryAfter(text) };
                }
                done = end;
            }
            await this.helpers.sleep(250);
            const s = this.helpers.state()!;
            castTimeMs = castEvent(s)?.castTimeMs ?? castTimeMs;
            if (died(s) && done !== 'cast') return diedResult(castTimeMs);
            if (done === 'hit' || servantSpell) {
                // Weak evidence: an interrupt that landed right behind it still means no cast. A servant's line can be an earlier cast's, with the refusal of this one right behind it.
                const late = refusal(s);
                if (late) return { ...fail(late, castFailureReason(late, 'interrupted'), base), castTimeMs, messages: msgs(), retryAfterMs: retryAfter(late) };
            }
            const queued = servantQueued(s);
            // That line also comes as a servant goes, with no spell behind it (NpcAttackAction.cs:238-239).
            if (queued && s.pet === null) return fail(`Our pet went before it could cast ${sp.name}`, 'no_pet', { ...base, castTimeMs, messages: msgs() });
            const messages = msgs();
            // What landed meanwhile can't be this spell's, then.
            const ours = summon || queued ? [] : landed(s).filter(m => !/extra damage/i.test(m.text));
            const resisted = ours.some(m => ourResist(m, s));
            let damage = 0;
            // The crit line names nobody and follows its hit, a pet's too (SpellHandler.cs:3078-3084).
            let ourHit = false;
            for (const m of ours) {
                const hit = /^(?:you hit .+?|your (.+?) hits .+?) for (\d+)/i.exec(m.text);
                if (hit) {
                    ourHit = hit[1] === undefined || hit[1].toLowerCase() === spellName;
                    if (ourHit) damage += Number(hit[2]);
                }
                const crit = /^you critically hit for an additional (\d+)/i.exec(m.text);
                if (crit && ourHit) damage += Number(crit[1]);
            }
            if (!done) {
                // No completion after all: the line we took for the pet's was ours, about a target the model still shows.
                const lost = watch.findText(['you must select a target']);
                if (lost) return fail(lost, 'no_target', { ...base, castTimeMs, messages });
                return fail(`${sp.name} started but no completion was observed`, 'timeout', { ...base, castTimeMs, messages });
            }
            // Sent right after "You cast a ..." when the effect can't take (CCSpellHandler.CheckSpellResist).
            const enraged = ours.some(m => ENRAGED_REFUSAL.test(m.text));
            const effectImmune = enraged || ours.some(m => /your target is immune to this effect/i.test(m.text));
            const alreadyOn = ours.some(m => /already has that effect/i.test(m.text));
            // A Group spell's list is us and our group, whatever is selected (SpellHandler.cs:1747-1761).
            const cast = `Cast ${sp.name}${obj && info?.target.toLowerCase() !== 'group' ? ` ${info?.radius ? 'around' : 'on'} ${nameOf(obj)}` : ''}`;
            if (queued) {
                return {
                    success: true, message: `${cast}, queued: the servant gets to it after its current action, unless a later cast replaces it, and each is paid`,
                    spell: sp, target: obj, castTimeMs, completed: false, queued, resisted, effectImmune, damage, messages,
                };
            }
            // A summon lands on nothing: what comes meanwhile is someone else's, as above.
            const starts = !summon && info?.effectStarts?.includes('{0}') ? spellMessagePattern(info.effectStarts) : null;
            // Another member's line of the same spell can come first: a monster's name must match (a player's is its real one, which we don't see).
            const npcName = obj && 'kind' in obj && obj.kind === 'npc' ? obj.name.toLowerCase() : null;
            const landedLine = starts && !resisted && !effectImmune && !alreadyOn ? await this.helpers.waitFor(st => {
                for (const m of landed(st)) {
                    const hit = starts.exec(m.text);
                    if (hit && (!npcName || hit[1]!.toLowerCase().endsWith(npcName))) return hit;
                }
                return null;
            }, 500) : null;
            const outcome = resisted ? ' (resisted)' : enraged ? ' (target enraged)' : effectImmune ? ' (target immune)' : alreadyOn ? ' (already has it)' : damage ? ` for ${damage} damage` : '';
            return {
                success: true, message: `${cast}${outcome}`,
                spell: sp, target: obj, castTimeMs, completed: true, resisted, effectImmune, alreadyOn, damage, messages: msgs(),
                ...(starts ? { effectLanded: !!landedLine, ...(landedLine ? { landedOn: landedLine[1]! } : {}) } : {}),
            };
        } finally {
            watch.dispose();
        }
    }

    /** Queue a combat style for the next swing; observed by "You prepare to perform a ...". */
    async useStyle(name: NamePattern): Promise<SkillUseResult> {
        const style = this.sdk.findStyle(name);
        if (!style) return fail(`Style not found: ${describeTarget(name)} (known: ${this.sdk.getSkills().styles.map(s => s.name).join(', ') || 'none'})`, 'not_found', { name: String(name), messages: [] });
        // By its name: a pet's styled hit sends us "You perform your X perfectly!" as well (AttackComponent.cs:1785-1789).
        const performed = new RegExp(`^you perform your ${style.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} perfectly`, 'i');
        return this.useSkillObserved(style.name, style.skillIndex, [/you prepare to perform/i, /preparing to perform/i, performed], STYLE_REFUSALS);
    }

    /** Use an ability (e.g. Sprint); success when the server answers without a refusal or an effect appears. */
    async useAbility(name: NamePattern): Promise<SkillUseResult> {
        const ability = this.sdk.findAbility(name);
        if (!ability) return fail(`Ability not found: ${describeTarget(name)}`, 'not_found', { name: String(name), messages: [] });
        return this.useSkillObserved(ability.name, ability.skillIndex, null, ABILITY_REFUSALS);
    }

    /**
     * Hide: a click on the Stealth spec, success when the server says "You are now hidden!" (or its 0x8D). Already hidden
     * succeeds at once. Reasons: `not_found` (no Stealth line), `enemy_near` (an enemy inside 1024 - 896 x stealth / its
     * level, twice that for Detect Hidden), `in_combat` (the server's 10 s), `busy` (attack mode or casting: we stop
     * attacking first), `cooldown` (2 s since the last toggle; `retryAfterMs`), `crowd_controlled`, `dead`, `no_response`.
     * Hidden we move slower, speed buffs pause, and a swing, a cast or a mob that spots us ("X uncovers you!") ends it.
     */
    async stealth(): Promise<StealthResult> {
        return this.toggleStealth(true);
    }

    /** Show again: the same click. Not hidden succeeds at once. */
    async unstealth(): Promise<StealthResult> {
        return this.toggleStealth(false);
    }

    private async toggleStealth(want: boolean): Promise<StealthResult> {
        const specs = this.sdk.getSkills().specializations;
        const index = specs.findIndex(s => /^stealth$/i.test(s.name));
        if (index < 0) return { ...fail('No Stealth line', 'not_found', {}), stealthed: this.sdk.isStealthed(), messages: [] };
        if (this.sdk.isStealthed() === want) return { success: true, message: want ? 'already hidden' : 'not hidden', stealthed: want, messages: [] };
        if (want && this.sdk.getPlayer()?.attacking) await this.sdk.sendAttack(false);
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendUseSpec(index);
            if (!r.success) return { ...r, stealthed: this.sdk.isStealthed(), messages: [] };
            const refusal = () => STEALTH_REFUSALS.find(([re]) => watch.find([re]));
            const got = await this.helpers.waitFor(() => {
                if (watch.find([want ? NOW_HIDDEN : NO_LONGER_HIDDEN]) || this.sdk.isStealthed() === want) return 'ok';
                return refusal() ? 'refused' : null;
            }, 2500);
            const messages = watch.messages().slice();
            const stealthed = got === 'ok' ? want : this.sdk.isStealthed();
            if (got === 'ok') return { success: true, message: want ? 'You are now hidden!' : 'You are no longer hidden!', stealthed, messages };
            if (got === 'refused') {
                const [re, reason] = refusal()!;
                const text = watch.findText([re])!;
                const wait = reason === 'cooldown' ? Math.max(1, Number(/(\d+) more second/.exec(text)?.[1] ?? 1)) * 1000 : undefined;
                return { ...fail(text, reason, {}), stealthed, messages, ...(wait !== undefined && { retryAfterMs: Math.min(wait, STEALTH_TOGGLE_MS) }) };
            }
            return { ...fail(`No answer to the Stealth click`, 'no_response', {}), stealthed, messages };
        } finally {
            watch.dispose();
        }
    }

    /**
     * Best monster to fight nearby: killable, not engaged with someone else,
     * within the con (or level-difference) window, nearest first. A pet we just lost counts as our own fight for 10 s, hurt as it is.
     */
    findKillableNpc(options: FindKillableOptions = {}): NearbyNpc | null {
        return this.findKillableNpcs(options)[0] ?? null;
    }

    /** All candidates findKillableNpc considers, best first. */
    findKillableNpcs(options: FindKillableOptions = {}): NearbyNpc[] {
        const s = this.helpers.state();
        const p = s?.player;
        if (!s || !p) return [];
        const from = options.from ?? p;
        const radius = options.radius ?? 2500;
        const minCon = options.minCon ?? -2;
        const maxCon = options.maxCon ?? 0;
        const exclude = new Set(options.exclude ?? []);
        const matches = options.pattern !== undefined ? nameMatcher(options.pattern) : () => true;
        const onUs = new Set(this.helpers.attackers(s).map(n => n.objectId));
        // A mob our pet fights is ours: the server credits its damage to us (GameLiving.cs:1299-1300).
        const petMobs = this.helpers.petMobIds(s);
        // A charm's ex-pet stays: not one of ours any more, and its wounds are from our fight. Its id can go to something else (Region.cs:955), so the name has to fit.
        const loss = s.lastPetLoss;
        const exPet = (n: NearbyNpc) => !!loss && n.objectId === loss.objectId && n.name === loss.name && Date.now() - loss.at < EX_PET_MS;
        const ours = (n: NearbyNpc) => petMobs.has(n.objectId) || exPet(n);
        return s.nearbyNpcs
            .filter(n => {
                if (exclude.has(n.objectId) || !isKillable(n, p) || !matches(n.name)) return false;
                if (n.healthPercent < 100 && !onUs.has(n.objectId) && !ours(n) && !options.includeEngaged) return false;
                if (!options.includeEngaged && n.targetObjectId !== null && n.targetObjectId !== p.objectId && !ours(n)) return false;
                const diff = n.level - p.level;
                if (options.maxLevelDiff !== undefined && diff > options.maxLevelDiff) return false;
                if (options.minLevelDiff !== undefined && diff < options.minLevelDiff) return false;
                if (options.maxLevelDiff === undefined && options.minLevelDiff === undefined) {
                    const con = conLevel(p.level, n.level);
                    if (con < minCon || con > maxCon) return false;
                }
                return Math.hypot(n.x - from.x, n.y - from.y) <= radius;
            })
            .sort((a, b) => (a.distance2d + Math.abs(a.z - p.z)) - (b.distance2d + Math.abs(b.z - p.z)));
    }

    /** In combat: attack mode on, recently hit, an NPC is fighting us (getAttackers) or targets our pet or a summon, or an enemy player hit us (getPlayerAttackers). */
    isInCombat(): boolean {
        const p = this.helpers.player();
        return !!p && (p.inCombat || p.attacking || this.helpers.attackers().length > 0 || this.helpers.playerAttackers().length > 0);
    }

    /**
     * NPCs fighting us, nearest first: their reported target is us, or their swing or spell landed on us within the last 6 s.
     * The server reports a target only for a mob standing within its attack range and in attack state, so the hits are what shows a caster at range or a mob running at us.
     */
    getAttackers(): NearbyNpc[] {
        return this.helpers.attackers().sort((a, b) => a.distance - b.distance);
    }

    /**
     * Enemy-realm players whose melee swing or spell effect landed on us within `windowMs`
     * (default 6 s, longer than a two-handed weapon's or a bow's swing), nearest first. The server never sends a player's target, so these combat events are the evidence.
     */
    getPlayerAttackers(windowMs: number = PLAYER_AIM_MS): NearbyPlayer[] {
        return this.helpers.playerAttackers(this.helpers.state(), windowMs).sort((a, b) => a.distance - b.distance);
    }

    // ============ Pets ============

    /**
     * Best known spell of a kind, by its static type: pet names say nothing, a Druid's are random (NpcTemplateMgr.cs:164-174).
     * The highest level wins; null if none. Kinds: 'main' a pet in the window, 'turret' an Animist's main pet, in the window
     * too, on a ground target, 'fnf' a Theurgist's pet or a fire-and-forget turret, outside the window, 'bomber' one that flies
     * at its target and is gone, outside it too, 'minion' a Bonedancer's, under its commander, 'charm' a mob taken over, in the window.
     * Vents and heals share 'fnf' and 'bomber' (an Animist's Vent of Physical Protection buffs, its Meliorating Spirit heals the pet), so for those two what hurts an enemy
     * comes first, then a snare, then the rest: to get a particular one, name it.
     */
    findSummonSpell(kind: PetSpellKind = 'main'): Spell | null {
        return this.summonSpells(kind)[0]?.sp ?? null;
    }

    /** The known spells of a kind, best first. */
    private summonSpells(kind: PetSpellKind): { sp: Spell; info: SpellInfo; harm: number }[] {
        return this.sdk.getSkills().spells.flatMap(sp => {
            const info = this.getSpellInfo(sp);
            return info && petSpellKind(info.type) === kind ? [{ sp, info, harm: kind === 'fnf' || kind === 'bomber' ? summonHarm(info) : 0 }] : [];
        }).sort((a, b) => b.harm - a.harm || b.sp.level - a.sp.level);
    }

    /**
     * Cast a summon, or the best main one (an Animist: its best turret) with none given, and observe the pet: the window
     * (state.pet) for one it lists, else the "under your control" line, whose name finds its NPC. A bomber's summon is
     * silent, so it succeeds on the cast and reports no pet, with damage 0 and resisted false: its hit comes up to 4 s later
     * (BomberBrain.cs:25-30). Commands reach window pets only, and releasePet({ target }) one with no window. Reasons:
     * castSpell's, and spell_not_found, bad_args (a spell that is no summon: nothing is cast), pet_exists (a window pet is
     * up, without `replace`; or the server still holds one that just died, after one more try a second on; a shade's line gets that try too), no_ground_target,
     * out_of_range (a ground target beyond the spell, a charm's mob), refused (a spot off the walkable surface, and the
     * server's other refusals), resisted (a charm), in_combat (a charm's mob, for now), timeout (cast, but no pet within `appearTimeout`),
     * unknown_action (the client runs older code). A refusal reports the pet that stands. With `replace` the pet stays unless the cast can go: reasons cooldown,
     * no_power below the most the spell can cost, in_combat for a spell with a cast time with melee on us or on the pet within what it covers by the half way (SummonPetOptions.replace; a swing of ours holds any such cast back for its weapon's interval, up to about 5 s on a staff, with "You must wait N seconds", so wait that out, and so does a cast a hit has broken, for 2.2 s; a hit alone holds none back, and interrupts it at its half way while its timer runs, so that needs the mob gone, SpellHandler.cs:356-372, :603-620), and for a turret no_ground_target,
     * out_of_range (within 16 of the range too, or where a loaded mesh would put the spot beyond it: the server moves a spot to the nearest walkable ground and then measures in 3D), refused, all before anything is released, and for a charm what charmPet says. A charm goes at what was judged, not at what a release leaves selected.
     * That no_power goes by the worst case, 120 % of the price for a focus caster: a focus item can lower the real cost, so it can refuse a cast that would have gone, at the price
     * of some regen with the pet kept. releasePet by hand goes on regardless. With no pet up nothing is judged: there is nothing to lose, and the server answers. With a cast the server still runs (see castSpell) `replace` waits for its end first, the pet there for the wait, and judges what stands then.
     * A spot with no z refused that way goes back to the one before it; with none before, the refused one is wiped, so a later summon with no spot reads no_ground_target.
     */
    async summonPet(spell?: NamePattern | Spell, options: SummonPetOptions = {}): Promise<SummonPetResult> {
        const s0 = this.helpers.state();
        if (!s0?.player) return fail('Not in game', 'not_in_game', noSummon());
        if (s0.player.isDead) return fail('We are dead', 'dead', noSummon());
        const sp = this.summonSpellOf(spell);
        if (!sp) return fail(spell === undefined ? this.noMainSummonMessage() : `Spell not found: ${describeTarget(spell)}`, 'spell_not_found', this.noNewPet());
        const found = { ...noSummon(), spell: sp };
        const info = this.getSpellInfo(sp);
        const kind = info ? petSpellKind(info.type) : null;
        // What isn't one would be cast and paid for, and then read as a pet that never came. The state stays as it is either way.
        if (info && !kind) return fail(`${sp.name} is no summon spell (its type is ${info.type})`, 'bad_args', { ...found, pet: this.sdk.getPet(), petState: this.sdk.getPetState() });
        // These never use the window (SetBrainToOwner is empty, SummonTheurgistPet.cs:130, or the commander holds them, SummonMinionHandler.cs:147).
        const windowed = kind !== 'fnf' && kind !== 'bomber' && kind !== 'minion';
        const toRelease = windowed && !!s0.pet;
        // What keeps the pet we have, as long as it is there to keep.
        const kept = (refusal: SummonRefusal) => fail(refusal.message, refusal.reason, { ...found, ...refusal, pet: this.sdk.getPet(), petState: this.sdk.getPetState() });
        // Only a charm's preflight looks at a target, and the walk and the release can move our selection: the cast goes where it looked.
        const aimed = toRelease && kind === 'charm' ? { ...options, target: options.target ?? s0.player.targetObjectId } : options;
        if (windowed) {
            if (s0.pet === undefined) return fail(OLDER_CLIENT_NO_PETS, 'unknown_action', found);
            if (s0.pet) {
                if (!options.replace) return kept({ message: 'We already have a pet: release it first, or pass replace', reason: 'pet_exists' });
                // castSpell would wait for a cast the server runs on with the pet already gone, and melee can reach us in that time: seconds, behind a follow-up. Wait first, and judge what stands then.
                if (info?.castTime !== 0) await this.castHeldOver();
                // A release can't be taken back: a summon that can't go yet leaves the pet we have (a Hunter's recast is 120 s).
                const cannot = this.summonCantGo(sp, info, kind, this.helpers.state() ?? s0, options);
                if (cannot) return kept(cannot);
            }
        }
        if (options.groundTarget) {
            const dropped = await this.placeGroundTarget(options.groundTarget);
            if (dropped) return kept(dropped);
            // A spot with no z is judged at last, with the height the client gave it. The server goes by 3D (SummonAnimistPet.cs:35), and a hill can put it out of range.
            if (toRelease && kind === 'turret') {
                const far = this.groundSpotTooFar(sp, info, this.helpers.state()!.player!, this.placedSpot(options.groundTarget), options);
                if (far) {
                    // With a z the same refusal comes before any placing. A later summon with no spot goes by what stands.
                    if (s0.groundTarget) await this.sdk.sendSetGroundTarget(s0.groundTarget.x, s0.groundTarget.y, s0.groundTarget.z);
                    // Nothing stood: a later summon with no spot should read no_ground_target, not "closer ground target" of this one.
                    else await this.placeGroundTarget(NO_ZONE_SPOT);
                    return kept(far);
                }
            }
        }
        // A death or a stuck walk on the way shouldn't cost the pet as well.
        if (toRelease && kind === 'charm') {
            const late = await this.walkToCharm(sp, info!, aimed);
            if (late) return kept(late);
        }
        if (toRelease) {
            const released = await this.releasePet();
            if (!released.success && released.reason !== 'no_pet') return fail(`Could not release our pet: ${released.message}`, released.reason ?? 'refused', { ...found, pet: released.pet, petState: released.petState, messages: released.messages });
        }
        const before = new Set(this.sdk.getNearbyNpcs().map(n => n.objectId));
        const watch = this.helpers.watch();
        try {
            let cast = await this.castSpell(sp, aimed.target, aimed);
            // A charm song still rolling, after a resist say: that cast only stopped it. Now one can start.
            if (kind === 'charm' && cast.reason === 'pulse_cancelled') cast = await this.castSpell(sp, aimed.target, aimed);
            // The 0xA2 of a pet's death took it from the model, but the server's brain holds until the close on a later tick (EffectListComponent.cs:914-921).
            // A Necromancer hears of its shade instead, which goes with that same close (SummonNecromancerPet.cs:45-54, ClassDisciple.cs:59-64).
            if ((cast.reason === 'pet_exists' || ALREADY_SHADE.test(cast.message)) && !this.sdk.getPetState()) {
                await this.helpers.waitFor(() => watch.find([LOST_CONTROL]) ? true : null, PET_CLOSE_MS);
                cast = await this.castSpell(sp, aimed.target, aimed);
            }
            if (!cast.success) {
                const message = cast.message.toLowerCase().includes(GROUND_TARGET_DROPPED) ? offMeshMessage(cast.message, options.groundTarget?.z !== undefined) : cast.message;
                return { ...cast, message, pet: this.sdk.getPet(), petState: this.sdk.getPetState() };
            }
            // BomberSpellHandler.cs:13: m_isSilent, so no line, and no window either.
            if (kind === 'bomber') return { ...cast, pet: null, petState: null };
            const got = await this.helpers.waitFor<PetState | ReasonLine | 'line' | 'died'>(s => {
                if (s.player?.isDead) return 'died';
                if (windowed && s.pet) return s.pet;
                return firstReasonLine(watch.messages(), SUMMON_FAILURES) ?? (watch.find([PET_UNDER_CONTROL]) ? 'line' : null);
            }, options.appearTimeout ?? 3000);
            const ended = (message: string, reason: string, resisted = false): SummonPetResult =>
                ({ ...cast, ...fail(message, reason, { resisted, messages: watch.messages().slice(), pet: this.sdk.getPet(), petState: this.sdk.getPetState() }) });
            if (got === 'died') return ended(`Died while summoning with ${sp.name}`, 'died');
            if (!got) return ended(`Cast ${sp.name}, but no pet appeared`, 'timeout');
            if (typeof got === 'object' && 'reason' in got) return ended(got.text, got.reason, got.reason === 'resisted');
            let pet: NearbyNpc | null;
            if (got === 'line') {
                // The name is all the server gives: the owner is on no packet, and a groupmate's pet can have the same one.
                const name = PET_UNDER_CONTROL.exec(watch.findText([PET_UNDER_CONTROL])!)![1]!.toLowerCase();
                const ownNamed = (s: BotWorldState) => s.nearbyNpcs
                    .filter(n => n.isPet && n.realm === s.player?.realm && n.name.toLowerCase() === name)
                    .sort((a, b) => Number(before.has(a.objectId)) - Number(before.has(b.objectId)) || a.distance - b.distance)[0];
                pet = await this.helpers.waitFor(ownNamed, PET_SETTLE_MS);
            } else {
                pet = await this.helpers.waitFor(() => this.sdk.getPet(), PET_SETTLE_MS);
            }
            return {
                ...cast, message: `${cast.message}: ${pet?.name ?? 'pet'} is under our control`,
                messages: watch.messages().slice(), pet, petState: windowed ? this.sdk.getPetState() : null,
            };
        } finally {
            watch.dispose();
        }
    }

    /** The spell a summon goes by: the one named, or the best main one (an Animist: its best turret). */
    private summonSpellOf(spell: NamePattern | Spell | undefined): Spell | null {
        if (spell === undefined) return this.findSummonSpell() ?? this.findSummonSpell('turret');
        return typeof spell === 'object' && !(spell instanceof RegExp) ? spell : this.sdk.findSpell(spell);
    }

    /** A summon result's fields with nothing cast, and the pet we have still there to report. */
    private noNewPet() {
        return { ...noSummon(), pet: this.sdk.getPet(), petState: this.sdk.getPetState() };
    }

    /** Why a summon can't go, with the pet we have kept for it. Null when nothing we can see stops it. */
    private summonCantGo(sp: Spell, info: SpellInfo | null, kind: PetSpellKind | null, s: BotWorldState, options: SummonPetOptions): SummonRefusal | null {
        if (sp.cooldownRemaining > 0) return { message: `${sp.name} is on cooldown (${sp.cooldownRemaining}s)`, reason: 'cooldown' };
        const p = s.player!;
        if (info && p.maxMana > 0) {
            // A release can't be taken back, so this goes by the worst case (SpellHandler.cs:1221). Live, on the lowest cost: 12 of 57 mana passed, the pet went, and the cast was refused.
            const cost = worstPowerCost(info.power, p);
            if (p.mana < cost) return { message: `Too little power to replace our pet with ${sp.name}: ${p.mana}, and it can cost ${cost}${isFocusCaster(p) ? ' (a focus item may lower that)' : ''}. releasePet by hand goes on regardless`, reason: 'no_power' };
        }
        const melee = info && info.castTime > 0 && !info.uninterruptible ? this.meleeOnUs(s, info) : null;
        if (melee) return { message: `Melee stops ${sp.name} (${melee}), so our pet stays. releasePet by hand goes on regardless`, reason: 'in_combat' };
        if (kind === 'charm') return this.charmCantGo(sp, info!, s, options);
        if (kind !== 'turret') return null;
        const spot = options.groundTarget ?? s.groundTarget;
        if (!spot) return { message: `${sp.name} needs a ground target: pass groundTarget`, reason: 'no_ground_target' };
        return this.groundSpotTooFar(sp, info, p, spot, options);
    }

    /**
     * What melee does to a cast with a cast time, in words, or null: a mob on us will swing, a mob on the pet turns on us at the release and swings before the half way if it is that near (castRoom; StandardMobBrain.cs:569-570), our own swing goes on, a swing of ours holds any such cast back with "You must wait N seconds" (swingHoldMs),
     * and a hit on us holds none back but can interrupt it at its half way (HIT_INTERRUPT_MS). A mob on us may be far off yet, and a hit can roll no interrupt (GameLiving.cs:707), but a false refusal costs seconds and a false pass the pet.
     * A spell's damage comes as an 0xBC with result 'other' (SpellHandler.cs:3092): ours holds no cast back, and one on us counts as a hit does. What it can't see is a DoT's tick or a spell's hit with its caster gone: they count too (DamageOverTimeECSEffect.cs:62, AttackComponent.cs:70).
     */
    private meleeOnUs(s: BotWorldState, info: SpellInfo): string | null {
        const p = s.player!;
        // By what it reads: a hit from one that doesn't name us goes by its own clock below.
        const attacker = s.nearbyNpcs.find(n => n.targetObjectId === p.objectId);
        if (attacker) return `${nameOf(attacker)} is on us`;
        const onPet = s.nearbyNpcs.filter(n => n.targetObjectId === s.pet?.objectId && n.distance <= castRoom(info.castTime, n.speed)).sort((a, b) => a.distance - b.distance)[0];
        if (onPet) return `${nameOf(onPet)} on our pet turns on us at the release`;
        if (p.attacking) return 'our swing is on';
        const now = Date.now();
        const within = (who: 'attackerObjectId' | 'targetObjectId', ms: number) => s.combatEvents.some(e => e.kind === 'melee' && e[who] === p.objectId && now - e.receivedAt < ms && (who === 'targetObjectId' || e.result !== 'other'));
        const hold = swingHoldMs(s);
        if (within('attackerObjectId', hold)) return `our swing holds a cast back for up to ${hold / 1000} s`;
        return within('targetObjectId', HIT_INTERRUPT_MS) ? 'a hit on us under 3 s ago can stop it at its half way' : null;
    }

    /**
     * A spot beyond the spell or at its edge, with a pet to lose: in 3D for the server (SummonAnimistPet.cs:35), and on the ground plane for a spot with no z yet. The server moves a spot first, on a slope away from
     * us as well (PlayerGroundTargetHandler.cs:63-85), and our z is the client's, so anything within GROUND_TARGET_SNAP of the limit may fall outside it. A refusal there costs only a step. Beside a gap in the mesh it can move much further (groundTargetSnap): with a mesh loaded, and a z to ask it with, its answer counts too.
     */
    private groundSpotTooFar(sp: Spell, info: SpellInfo | null, p: PlayerState, spot: Point, options: SummonPetOptions): SummonRefusal | null {
        const range = options.range ?? info?.range ?? 0;
        if (range <= 0) return null;
        const d = this.helpers.distance(p, spot);
        if (d > range) return { message: `The ground target is ${Math.ceil(d)} from us, beyond the ${range} of ${sp.name}`, reason: 'out_of_range' };
        if (d + GROUND_TARGET_SNAP > range) return { message: `The ground target is ${Math.round(d)} from us, and the server can move it by ${GROUND_TARGET_SNAP} or more: too near the ${range} of ${sp.name} to risk our pet`, reason: 'out_of_range' };
        const snapped = spot.z === undefined ? null : groundTargetSnap(p.regionId, { x: spot.x, y: spot.y, z: spot.z });
        const moved = snapped ? this.helpers.distance(p, snapped) : 0;
        return moved > range ? { message: `The ground target is ${Math.round(d)} from us, and the server would move it to the nearest walkable ground, ${Math.round(moved)} from us: beyond the ${range} of ${sp.name}, so our pet stays`, reason: 'out_of_range' } : null;
    }

    /** The spot as the model has it after placeGroundTarget, with the client's z: the server's move isn't echoed (sdk.sendSetGroundTarget), so one further off than this is a snapshot from before our set. */
    private placedSpot(spot: Point): Point {
        const placed = this.helpers.state()?.groundTarget;
        return placed && Math.hypot(placed.x - spot.x, placed.y - spot.y) <= GROUND_TARGET_SNAP + 1 ? placed : spot;
    }

    /** Set the ground target and give the server a moment to drop it: it says so to the 0xEC, and only then (PlayerGroundTargetHandler.cs:30-33). Null when it stands. */
    private async placeGroundTarget(spot: Point): Promise<SummonRefusal | null> {
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendSetGroundTarget(spot.x, spot.y, spot.z);
            if (!r.success) return { message: r.message, reason: r.reason ?? 'dispatch_failed', messages: [] };
            const dropped = await this.helpers.waitFor(() => watch.findText([GROUND_TARGET_DROPPED]), GROUND_TARGET_ANSWER_MS);
            return dropped ? { message: offMeshMessage(dropped, spot.z !== undefined), reason: 'refused', messages: watch.messages().slice() } : null;
        } finally {
            watch.dispose();
        }
    }

    /**
     * Why this charm can't take its mob, with a pet to lose by trying: the server only says so at the end of the cast, after the release. Its checks, in its order: CharmSpellHandler.cs:151 (a realm),
     * :212 (a capital name, under spell_charm_named_check: on by default, ServerProperties.cs:2224, and the client can't read it), :293-309 (a pulsing charm: above the spell's value or 110 % of our modified spec),
     * :322-345 (the others: above our level or the spell's value, in combat: mobInCombatLately for what its entry doesn't show). What we can't see stays: its body type, a resist, a fight we saw none of.
     */
    private charmCantGo(sp: Spell, info: SpellInfo, s: BotWorldState, options: SummonPetOptions): SummonRefusal | null {
        const p = s.player!;
        const wanted = options.target ?? p.targetObjectId;
        if (wanted === null) return { message: 'No target to charm', reason: 'no_target' };
        if (namesUs(wanted, p.objectId)) return { message: `${sp.name} needs an enemy, and that is us`, reason: 'no_target' };
        const t = this.helpers.resolveAny(wanted);
        if (!t) return { message: `Target not found: ${describeTarget(wanted)}`, reason: 'not_found' };
        const pets = this.helpers.ownPets(s);
        if (pets.has(t.objectId)) return { message: ALREADY_OUR_PET, reason: 'pet_exists', target: t };
        const refused = this.castTargetRefusal(sp, info, t, p);
        if (refused) return { ...refused, target: t };
        const name = nameOf(t);
        if (t.kind !== 'npc' || t.realm !== 'none' || /^\p{Lu}/u.test(t.name)) return { message: `${name} can't be charmed!`, reason: 'refused', target: t };
        const pulsing = info.pulse === 1;
        const spec = pulsing ? modifiedSpec(sp.lineName, s.skills.specializations) : null;
        const bySpec = spec === null ? Infinity : Math.floor(spec * 1.1);
        const limit = pulsing ? Math.min(info.value, bySpec) : Math.min(p.level, info.value);
        if (t.level > limit) return { message: `${name} is too strong for ${sp.name}: level ${t.level}, above ${limit}${limit === bySpec ? `, which is 110 % of our spec of ${spec}` : ''}`, reason: 'refused', target: t };
        if (!pulsing && (t.inCombat || (t.targetObjectId !== null && pets.has(t.targetObjectId)) || mobInCombatLately(s, t.objectId))) return { message: `We can't charm ${name} while it is in combat`, reason: 'in_combat', target: t };
        const range = spellRange(info, options, this.helpers.state()?.effects);
        const within = range - CHARM_REPLACE_MARGIN;
        if (options.approach === false && t.distance > within) return { message: `${name} is ${t.distance} from us: with a pet to lose ${sp.name} wants it within ${within} of its ${range}`, reason: 'out_of_range', target: t };
        return null;
    }

    /** Into a charm's range with the pet still ours, and a last look at what the walk changed. Null when the charm can go now. */
    private async walkToCharm(sp: Spell, info: SpellInfo, options: SummonPetOptions): Promise<SummonRefusal | null> {
        const wanted = options.target ?? this.helpers.player()?.targetObjectId;
        const t = wanted === null || wanted === undefined ? null : this.helpers.resolveAny(wanted);
        const range = spellRange(info, options, this.helpers.state()?.effects);
        const within = range - CHARM_REPLACE_MARGIN;
        if (!t || t.distance <= within) return null;
        const stop = Math.max(range * SPELL_WALK_NEARER_SHARE, Math.min(within, spellWalkStop(range), range - MOB_ROAM_SPEED * info.castTime - CHARM_WALK_SLACK));
        const walk = await this.walkInto(t, { range: stop, firstReading: true, enough: within });
        if (!walk.success) return { message: walk.message, reason: walk.reason ?? 'out_of_reach', target: t };
        return this.summonCantGo(sp, info, 'charm', this.helpers.state()!, options);
    }

    /** What summonPet() says with no main or turret spell: what is known, and how to call it. */
    private noMainSummonMessage(): string {
        const known = (kind: PetSpellKind, how: string, only: (info: SpellInfo) => boolean = () => true): string[] => {
            const names = this.summonSpells(kind).filter(({ info }) => only(info)).map(({ sp }) => sp.name);
            return names.length ? [`${names.join(', ')} (${kind}: ${how})`] : [];
        };
        const others = [
            ...known('fnf', 'summonPet(spell, { target })', info => !standsOnGround(info)),
            ...known('fnf', 'summonPet(spell, { groundTarget })', standsOnGround),
            ...known('bomber', 'summonPet(spell, { target })'),
            ...known('minion', 'summonPet(spell), with a commander up'),
            ...known('charm', 'charmPet(target)'),
        ];
        return others.length ? `No main or turret summon known. Known: ${others.join('; ')}` : 'No summon spell known: name one, see findSummonSpell';
    }

    /**
     * Charm a mob with the best charm spell, as summonPet does (approaching it, and with `replace`), or `options.spell`. Charms can
     * go by body type, which the client can't see (a Hunter's by insect or animal, CharmSpellHandler.cs:221-283), so on "This spell does
     * not charm that type of monster!", which costs no power, it goes on to the next known one, and so with `replace` on a level limit, where nothing was cast yet. Reasons: summonPet's; no_target
     * (a null target: never the current one), not_attackable (our own id), refused for a mob it can't take, before any walk when it has a
     * realm (CharmSpellHandler.cs:151), in_combat for a mob that can be tried again out of combat, and resisted when it resists. A
     * pulsing charm (Minstrel, Mentalist) keeps rolling after a resist, so state.pet can still open. A cast with one rolling stops it
     * (SpellHandler.cs:501-513), so this casts once more then; releasePet stops it as well. Reason pet_exists also for our own pet as the target: that is already ours.
     * With `replace` the pet stays through what we can see, all before the release: in_combat (the mob on our pet, or in any fight, mez or stun we saw in the last 10 s or that may still run: to
     * the server all of that is combat, GameLiving.cs:227), refused (a named mob, one above our level or the spell's value, for a pulsing charm above 110 % of our modified spec), out_of_range with
     * approach off, and a walk into range that fails or dies; only then is it released. A mez that ended early or was resisted still reads as held, so the refusal can come too soon; try again later.
     * In range for a replace means within the range less 60: the server measures at the end of the cast, in 3D, and readings of 994 and 999 of 1000 lost the pet. Beyond that it walks in first, to the range less 70 units/s for the cast and 20 (about 700 of 1000), so a mob roaming away all the way still lands, and with approach off it is out_of_range, the pet kept. A mob that roams that far from within the range less 60, with no walk, can still lose it, and so can one faster than a roam.
     * What we can't see can still lose the pet: a wrong type, a resist, and a fight or a hold we saw nothing of, out of view or past the last 200 events. For a Hunter that costs a 120 s recast.
     * A mob on its way to us reads as in combat, though the server, which goes by swings, might take the charm (GameLiving.cs:227): its first swing would stop the cast anyway. With no spell named, a mob too strong for them all names the highest limit among them.
     */
    async charmPet(target: NpcTarget | null | undefined, options: CharmPetOptions = {}): Promise<SummonPetResult> {
        const player = this.helpers.player();
        if (!player) return fail('Not in game', 'not_in_game', noSummon());
        if (target === null || target === undefined) return fail('No target to charm', 'no_target', this.noNewPet());
        const { spell: named, ...summon } = options;
        const known = this.summonSpells('charm').map(({ sp }) => sp);
        let spells = known;
        if (named !== undefined) {
            const sp = this.sdk.findSpell(named);
            if (!sp) return fail(`Spell not found: ${describeTarget(named)}`, 'spell_not_found', this.noNewPet());
            if (!known.some(k => k.name === sp.name)) return fail(`${sp.name} is no charm`, 'bad_args', { ...this.noNewPet(), spell: sp });
            spells = [sp];
        }
        if (!spells.length) return fail('No charm spell known', 'spell_not_found', this.noNewPet());
        if (namesUs(target, player.objectId)) return fail("We can't charm ourselves", 'not_attackable', this.noNewPet());
        const t = this.helpers.resolveNpc(target);
        if (!t) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', this.noNewPet());
        const refused = { ...this.noNewPet(), spell: spells[0]!, target: t };
        // It reads our realm, so this comes first: "can't be charmed" would be no answer.
        if (this.helpers.ownPets(this.helpers.state()).has(t.objectId)) return fail(ALREADY_OUR_PET, 'pet_exists', refused);
        if (t.realm !== 'none') return fail(`${nameOf(t)} can't be charmed!`, 'refused', refused);
        let r: SummonPetResult | null = null;
        // Best first goes by the spell's level, and a Hunter's lower one can have the higher limit (Compel Insect 14, Lesser Call of Gleipnir 10).
        let strongest: SummonPetResult | null = null;
        const limit = (result: SummonPetResult) => Number(/above (\d+)$/.exec(result.message)?.[1]);
        for (const spell of spells) {
            r = await this.summonPet(spell, { ...summon, target: t });
            if (r.success || r.reason !== 'refused' || !(/^This spell does not charm /.test(r.message) || CHARM_TOO_STRONG.test(r.message))) return r;
            if (CHARM_TOO_STRONG.test(r.message) && (!strongest || limit(r) > limit(strongest))) strongest = r;
        }
        return CHARM_TOO_STRONG.test(r!.message) ? strongest! : r!;
    }

    /**
     * Release our window pet and observe the window close: any close counts, the server sends the same one for each cause. The pet
     * is selected in the same order unless it is already, or our target cleared with its entry out of view: the server releases its target if that is a
     * controlled NPC of ours, a deleted one too, silently (CharacterClassBase.cs:336-341, GameLiving.cs:3841-3853). A previous target
     * comes back afterwards, unless it has gone, and otherwise our target is cleared. An entry that stays in view, a charm's ex-pet, gets up to 500 ms to read realm none, so a
     * killable check finds it so. With `target`, one pet of ours with no window instead: observed by its NPC leaving.
     * A pulsing charm (Minstrel, Mentalist) has its song stopped first, by casting it again: the mob turns on us either way.
     * A Necromancer's release ends its shade: our health becomes min(current, max(10, the pet's %)) (PlayerState.isShade).
     * Reasons: no_pet (no window and no target), no_response, unknown_action; crowd_controlled when we can't cast to stop that song:
     * nothing is released then. With `target`: not_found, bad_args (it is no pet), refused (no pet we can tell is ours, with a window up:
     * the server would release that one instead).
     */
    async releasePet(options: ReleasePetOptions = {}): Promise<PetCommandResult> {
        const { target, ...order } = options;
        const window = this.helpers.state()?.pet;
        if (target !== undefined && target !== null) {
            const named = this.summonOf(target);
            if (!window || named?.objectId !== window.objectId) return this.releaseSummon(target, named, order);
        }
        const song = this.charmSong();
        const refused = song && await this.stopCharmSong(song, order);
        if (refused) return refused;
        const pet = this.sdk.getPet();
        const previous = this.helpers.player()?.targetObjectId ?? null;
        try {
            if (window && !pet) await this.sdk.sendSetTarget(null);
            // Selected already it needs no 0xB0, whose answer is an 0xA1 built before the release and landing after it (PlayerTargetHandler.cs:56, PacketProcessor.cs:273-274).
            return await this.petOrder('release', order, pet && pet.objectId !== previous ? pet : undefined);
        } finally {
            if (window) await this.backToTarget(previous, window.objectId, !!pet);
        }
    }

    /**
     * After a release: our target back if we had one other than the pet and it is still there, else none. Naming the pet moved the server's, which stays on the deleted NPC
     * while the model's goes, and a Pet spell with no target would land there, paid, with the new pet beside us (SpellHandler.cs:468-470, :648-658, :918-920). `named`: it did move.
     * The next cast with no target reads the model's (castSpell), so this waits for that to show it: a charm's ex-pet stays in view, and would take the cast.
     */
    private async backToTarget(previous: number | null, petId: number, named = true): Promise<void> {
        const back = previous !== null && previous !== petId && this.sdk.getObject(previous) ? previous : null;
        if (back === null && !named) return;
        await this.selectAgain(back);
    }

    /** Select this again, an abort or not, and give the model time to show it: what comes next reads the model's. */
    private async selectAgain(id: number | null): Promise<void> {
        await this.helpers.cleanup(async () => {
            const r = await this.sdk.sendSetTarget(id);
            if (r.success) await this.helpers.waitFor(s => (s.player?.targetObjectId ?? null) === id ? true : null, TARGET_SETTLE_MS);
        });
    }

    /** A walk that ends as soon as a snapshot reads `over`, null then, the mover stopped: walkTo looks at nothing but itself. Else its result. */
    private async walkUntil(x: number, y: number, options: WalkOptions, over: (s: BotWorldState) => boolean): Promise<WalkResult | null> {
        const now = this.helpers.state();
        if (now && over(now)) return null;
        const parent = executionContext.getStore();
        const controller = new AbortController();
        const ended = new Error('Walk over');
        const onParent = () => controller.abort(parent?.signal.reason);
        parent?.signal.addEventListener('abort', onParent, { once: true });
        const unsubscribe = this.sdk.onStateUpdate(s => { if (over(s)) controller.abort(ended); });
        try {
            return await executionContext.run({ ...parent, signal: controller.signal }, () => abortable(this.walkTo(x, y, options)));
        } catch (error) {
            if (error === ended) return null;
            throw error;
        } finally {
            unsubscribe();
            parent?.signal.removeEventListener('abort', onParent);
        }
    }

    /** What a release's target names: by name, our own come first. */
    private summonOf(target: NpcTarget): NearbyNpc | null {
        const own = typeof target === 'string' || target instanceof RegExp ? bestNameMatch(this.sdk.getSummons(), target) : null;
        return own ?? this.helpers.resolveNpc(target);
    }

    /** One pet with no window: the server takes a selected one (CharacterClassBase.cs:336-341), and says nothing: the 0xA2 is all there is. */
    private async releaseSummon(target: NpcTarget, npc: NearbyNpc | null, options: PetCommandOptions): Promise<PetCommandResult> {
        const base = { command: 'release' as const, pet: npc, petState: this.sdk.getPetState(), messages: [] as GameMessage[] };
        // With nothing released `pet` is the pet that stands, as in petState: what we named is in the message, and may be no pet at all.
        const refused = { ...base, pet: this.sdk.getPet() };
        const s = this.helpers.state();
        if (!s?.player) return fail('Not in game', 'not_in_game', refused);
        if (s.pet === undefined) return fail(OLDER_CLIENT_NO_PETS, 'unknown_action', refused);
        if (!npc) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', refused);
        if (!npc.isPet || npc.realm !== s.player.realm) return fail(`${nameOf(npc)} is no pet of ours`, 'bad_args', refused);
        // A target that isn't ours falls through to the window pet (CharacterClassBase.cs:334-336).
        if (s.pet && !s.summons?.includes(npc.objectId)) return fail(`${nameOf(npc)} can't be told to be ours, and the server would release our window pet instead`, 'refused', refused);
        const previous = s.player.targetObjectId;
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendPetCommand('release', npc.objectId);
            if (!r.success) return { ...base, ...r };
            const gone = await this.helpers.waitFor(st => st.nearbyNpcs.some(n => n.objectId === npc.objectId) ? null : true, options.timeout ?? PET_ANSWER_MS);
            const after = { ...base, pet: this.sdk.getNearbyNpc(npc.objectId), petState: this.sdk.getPetState(), messages: watch.messages().slice() };
            return gone ? { success: true, message: `Released ${theName(npc.name)}`, ...after } : fail(`No answer to releasing ${nameOf(npc)}`, 'no_response', after);
        } finally {
            watch.dispose();
            await this.backToTarget(previous, npc.objectId);
        }
    }

    /**
     * The pulsing charm holding our window pet, if one does. The client sees no song (a pulse has no icon on us, PacketLib1110.cs:68,
     * and a charm no concentration), but it is the only pet those classes get, and its effect's icon in the window names the rank (PacketLib181.cs:157-163).
     */
    private charmSong(): Spell | null {
        const pet = this.helpers.state()?.pet;
        if (!pet) return null;
        const songs = this.sdk.getSkills().spells.flatMap(sp => {
            const info = this.getSpellInfo(sp);
            return info && petSpellKind(info.type) === 'charm' && info.pulse > 0 && info.frequency > 0 ? [{ sp, icon: info.icon }] : [];
        });
        return (songs.find(s => pet.icons.includes(s.icon)) ?? songs.sort((a, b) => b.sp.level - a.sp.level)[0])?.sp ?? null;
    }

    /**
     * Stop a charm's song, before the release. After one alone it plays on while the mob lives nearby (CharmECSEffect.cs:113-120),
     * and its next pulse charms that mob again (EffectService.cs:201, CharmSpellHandler.cs:81-82). Casting the spell again is the
     * only way to end it, and it casts nothing. Null when it stopped, else the failure.
     */
    private async stopCharmSong(song: Spell, options: PetCommandOptions): Promise<PetCommandResult | null> {
        const base = { command: 'release' as const, pet: this.sdk.getPet(), petState: this.sdk.getPetState(), messages: [] as GameMessage[] };
        const watch = this.helpers.watch();
        try {
            const r = song.lineIndex >= 0 ? await this.sdk.sendCastSpell(song.lineIndex, song.spellIndex) : await this.sdk.sendUseSkill(song.skillIndex ?? -1);
            if (!r.success) return fail(r.message, r.reason ?? 'dispatch_failed', base);
            const answer = await this.helpers.waitFor(() => watch.findText([...PULSE_CANCELLED, ...CROWD_CONTROL_REFUSALS]), options.timeout ?? PET_ANSWER_MS);
            const after = { ...base, messages: watch.messages().slice() };
            if (!answer) return fail(`No answer to stopping the song of ${song.name}`, 'no_response', after);
            const reason = castFailureReason(answer);
            return reason === 'pulse_cancelled' ? null : fail(answer, reason, after);
        } finally {
            watch.dispose();
        }
    }

    /**
     * Order our pet onto a target (selected first) and observe the "You command ... to kill" line, or a refusal: reason
     * out_of_range (over 2000 from us, wherever the pet is: the server refuses that order, and our target has moved all the same; or beyond a turret's spell: an order there would only stop the
     * fight it has, so none goes out), immune (with retryAfterMs), not_attackable (also at once for a peace flag, an untargetable
     * NPC, our own id or a pet of ours: the server says nothing to the first two), no_target (also for a null target), already_dead (the server
     * says nothing to that), no_response, not_found, no_pet, unknown_action. It also lifts a passive pet to defensive
     * (ControlledMobBrain.cs:213-214). Our own target stays moved unless `restoreTarget`.
     */
    async petAttack(target: LivingTarget | null | undefined, options: PetTargetOptions = {}): Promise<PetAttackResult> {
        const base = { command: 'attack' as const, pet: this.sdk.getPet(), petState: this.sdk.getPetState(), messages: [] as GameMessage[], target: null as NearbyNpc | NearbyPlayer | null };
        const none = this.noPetCommand(base);
        if (none) return none;
        if (target === null || target === undefined) return fail('No target for our pet', 'no_target', base);
        if (namesUs(target, this.helpers.player()?.objectId)) return fail("Our pet can't attack us", 'not_attackable', base);
        const t = this.helpers.resolveLiving(target);
        if (!t) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', base);
        const refusal = this.petTargetRefusal(t);
        if (refusal) return fail(refusal.message, refusal.reason, { ...base, target: t });
        const beyond = this.turretCantReach(base.petState!, t);
        if (beyond) return fail(beyond, 'out_of_range', { ...base, target: t });
        const r = await this.petOrder('attack', options, t);
        return { ...r, target: this.helpers.resolveLiving(t.objectId) ?? t, ...(r.reason === 'immune' ? { retryAfterMs: PVP_IMMUNE_RETRY_MS } : {}) };
    }

    /**
     * Have our pet kill a target while we stand off: order it, and wait for the death, ordering again when it has dropped
     * the target for over 5 s, never while its order stands. We walk only into range of the order, never into melee, and not at
     * all for a turret: to 1500, and for a mob 1000 or more above or below us until it reads within 1900, on a slope too. A first order the server refuses as out of range gets that walk, at least 100 nearer than it read, and one more try: our reading lags a mob on the move (GamePlayer.cs:12185), so a refusal can come at a reading short of 2000.
     * An NPC at 0 % is not dead: the fight goes on to its death (GameLiving.cs:2621).
     * A shade is on its servant's tether, 1500 for 10 s and 2000 at once (NecromancerPetBrain.cs:300-326), so it walks within 1000 of the
     * target first, and steps after a servant over 1200 away or at the server's warning (`approach`).
     * Reports XP, money and items by delta, like killNpc, and the duration up to the death. Reasons: petAttack's, attacked (another
     * mob is on us, `attacker` on the result: the pet keeps fighting, or with no order out yet has none, and the message says which. The caller decides, or passes `ignoreAttackers`), arrived (only with `endWithin` or `endOnUsWithin`),
     * pet_died (the pet is gone, however: state.lastPetLoss tells, and the message says when the tether took it), died,
     * target_lost (it left view alive), timeout, out_of_range (also a turret's target that stays beyond its reach for about 2 s in the fight: the message says it left, and the turret's order stands), out_of_reach (the pet isn't getting there: at a standstill over 200 from the target, with no swing or spell by it or on it and no
     * health lost by the target for over 8 s; the follow order that frees it has gone out, and a long mezz can read as this. Never for a turret). Our own target stays moved, and a swing
     * of our own that was going stays on, but no longer lands on its old mob: melee reads the selection at each swing (AttackAction.cs:84). `npc` as in killNpc. A pet's kill is ours: it earns us XP (GameNPC.cs:2768-2769).
     */
    async petKill(target: LivingTarget | null | undefined, options: PetKillOptions = {}): Promise<KillResult> {
        const s0 = this.helpers.state();
        const p0 = s0?.player;
        const base = { npc: null as NearbyNpc | null, ...noKill() };
        if (!s0 || !p0) return fail('Not in game', 'not_in_game', base);
        if (p0.isDead) return fail('We are dead', 'dead', base);
        if (s0.pet === undefined) return fail(OLDER_CLIENT_NO_PETS, 'unknown_action', base);
        if (!s0.pet) return fail('We have no pet', 'no_pet', base);
        if (target === null || target === undefined) return fail('No target for our pet', 'no_target', base);
        if (namesUs(target, p0.objectId)) return fail("Our pet can't attack us", 'not_attackable', base);
        const t0 = this.helpers.resolveLiving(target);
        if (!t0) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', base);
        const npc = t0.kind === 'npc' ? t0 : null;
        const refusal = this.petTargetRefusal(t0);
        if (refusal) return fail(refusal.message, refusal.reason, { ...base, npc });
        const petId = s0.pet.objectId;
        const r = t0.kind === 'npc'
            ? await this.fightToDeath<NearbyNpc>(npcFoe(t0), s0, p0, options, watch => this.settleNpcKill(watch), k => ` (+${k.xpGained} xp)`, (watch, sent) => this.petFight(npcFoe(t0), p0, petId, watch, options, sent))
            : await this.fightToDeath<NearbyPlayer>(playerFoe(t0), s0, p0, options, async () => {}, k => k.rpGained ? ` (+${k.rpGained} rp)` : '', (watch, sent) => this.petFight(playerFoe(t0), p0, petId, watch, options, sent));
        return { ...r, npc: npc && this.latestNpc(npc) };
    }

    /** Why no order can go at this target, whatever the pet: the server says nothing to these, so they would read as no_response, after a walk with petKill. */
    private petTargetRefusal(t: NearbyNpc | NearbyPlayer): { message: string; reason: string } | null {
        // The order would select it, and leave our target on it when it goes.
        if (this.helpers.ownPets(this.helpers.state()).has(t.objectId)) return { message: `${nameOf(t)} is a pet of ours`, reason: 'not_attackable' };
        // IsAllowedToAttack returns without a word for a dead target and a peace flag (AbstractServerRules.cs:337, :383-384).
        if (this.isDeadTarget(t)) return { message: `${nameOf(t)} is already dead`, reason: 'already_dead' };
        return t.kind === 'npc' ? unattackable(t) : null;
    }

    /**
     * Our window pet as a turret, with how far it reaches; null for a pet that walks. Only an Animist knows a turret spell, and a turret is
     * the only pet its window can list, so that is the test. The effect's icon names which one (each has its own, spell.sql), its sub-spell the reach (TurretBrain.cs:9-18).
     */
    private windowTurret(pet: PetState): { range: number } | null {
        const turrets = this.sdk.getSkills().spells.flatMap(sp => {
            const info = this.getSpellInfo(sp);
            return info && petSpellKind(info.type) === 'turret' ? [info] : [];
        });
        if (!turrets.length) return null;
        const sub = getSpell(turrets.find(info => pet.icons.includes(info.icon))?.subSpellId ?? 0);
        return { range: sub?.range || TURRET_RANGE };
    }

    /** Why a turret can't carry out an order onto this target, or null: a pet that walks can, and so can a turret in reach. */
    private turretCantReach(pet: PetState, t: Point & { name: string; objectId: number }): string | null {
        const turret = this.windowTurret(pet);
        if (!turret) return null;
        const entry = this.sdk.getNearbyNpc(pet.objectId);
        if (!entry) return `Our turret is out of view, so it can't be told to reach ${nameOf(t)}`;
        const d = this.helpers.distance(entry, t);
        return d > turret.range ? `Our ${entry.name} doesn't walk, and ${nameOf(t)} is ${Math.round(d)} from it, beyond its ${turret.range}` : null;
    }

    /**
     * A clock on a pet with an order, true once it has stood idle for PET_STUCK_MS: at speed 0 and on one spot, over PET_STUCK_RANGE from the target in 3D, with no swing (0xBC) or spell
     * (0x1B) by it or on it, which covers a caster standing and a mezz as it starts, and no health lost by the target: one regaining it has nobody on it. One out of view can't be told.
     * Orders don't touch the clock: one every PET_REORDER_MS would keep it from ever running out.
     */
    private petIdleClock(petId: number, baseline: number): (s: BotWorldState, t: NearbyNpc | NearbyPlayer) => boolean {
        let since = 0;
        let spot: Point = { x: 0, y: 0, z: 0 };
        let health = 0;
        let seen = baseline;
        return (s, t) => {
            const now = Date.now();
            const pet = s.nearbyNpcs.find(n => n.objectId === petId);
            const events = s.combatEvents.filter(e => e.id > seen);
            seen = events.at(-1)?.id ?? seen;
            const happening = !since || !pet || pet.speed > 0 || this.helpers.distance(pet, t) <= PET_STUCK_RANGE || this.helpers.distance(pet, spot) > PET_STUCK_MOVED || t.healthPercent < health
                || events.some(e => (e.kind === 'melee' || e.kind === 'spellEffect') && (e.attackerObjectId === petId || e.targetObjectId === petId));
            health = t.healthPercent;
            if (happening) {
                since = now;
                if (pet) spot = pet;
            }
            return now - since > PET_STUCK_MS;
        };
    }

    /** petKill's loop. */
    private async petFight<T extends NearbyNpc | NearbyPlayer>(
        foe: Foe<T>, p0: PlayerState, petId: number, watch: MessageWatch, options: PetKillOptions, sent: { attack: boolean; move: boolean },
    ): Promise<FightOutcome> {
        const name = nameOf(foe.first);
        const id = foe.first.objectId;
        const baseline = maxCombatEventId(this.helpers.state());
        let lastHp = foe.first.healthPercent;
        let lastTick = -1;
        let lastOrderAt = 0;
        let lastSeenAt = 0;
        let linesSeen = 0;
        let servantAway = 0;
        let beyondSince = 0;
        // One walk per order: a cliff in the way mustn't loop.
        let walkedForOrder = false;
        const idle = this.petIdleClock(petId, baseline);
        const targetDied = (st: BotWorldState) => st.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === id);
        // Into range of an order. A shade's walk is for the tether, not for the order: with no way there, the order still reaches, and the servant has a way of its own. The order's limit is 3D (GamePlayer.cs:12185, Point3D.cs:126-158), and a mob above or below us leaves that much less of it on the plane.
        // Null to go on: also at the mob's death, which the next pass reads as its kill.
        const walkIntoRange = async (from: PlayerState, to: T, refused = false): Promise<FightOutcome | null> => {
            sent.move = true;
            const dz = to.z - from.z;
            const high = !from.isShade && Math.abs(dz) >= PET_ORDER_HIGH;
            const reach = from.isShade ? SHADE_ORDER_APPROACH : high ? PET_ORDER_HIGH_REACH : PET_ORDER_APPROACH;
            const range = refused ? Math.min(reach, to.distance - PET_ORDER_RETRY_NEARER) : reach;
            // High up it aims all the way to the floor: the reading ends it, and an aim worked out on the plane from the start ended at a mob that had moved on, still out of reach.
            const stop = this.helpers.approachPoint(from, to, high ? PET_ORDER_APPROACH_MIN : Math.max(PET_ORDER_APPROACH_MIN, Math.sqrt(Math.max(0, range ** 2 - dz ** 2))));
            // By what it reads as we go: on a slope the height falls as we climb, and a plane worked out at the start would take us nearly under it. That close to the limit the reading has to end it, not an arrival radius.
            const inReach = (st: BotWorldState) => { const mob = foe.find(st); return !!mob && mob.distance <= range; };
            const walk = await this.walkUntil(stop.x, stop.y, { z: stop.z, tolerance: high ? 16 : 100 }, st => targetDied(st) || inReach(st));
            if (!walk) return null;
            const orderReaches = to.distance <= PET_ORDER_RANGE && (walk.reason === 'stuck' || walk.reason === 'no_path');
            return walk.success || orderReaches ? null : { message: walk.message, reason: walk.reason ?? 'out_of_reach' };
        };
        for (;;) {
            throwIfExecutionAborted();
            const s = await this.helpers.waitFor(st => st.tick !== lastTick ? st : null, 1000) ?? this.helpers.state();
            if (!s?.player) return { message: 'Lost game state', reason: 'not_in_game' };
            lastTick = s.tick;
            if (s.player.isDead || s.player.deathCount !== p0.deathCount) return { message: `Died while our pet fought ${name}`, reason: 'died' };
            const t = foe.find(s);
            const died = s.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === id);
            if (died || (t && foe.isDown(t))) return 'killed';
            // Before the pet's check: its last swing comes in the snapshot that shows it gone.
            if (t) lastHp = t.healthPercent;
            if (s.pet?.objectId !== petId) {
                const loss = s.lastPetLoss?.objectId === petId ? s.lastPetLoss : null;
                // A cut at the hard limit says nothing and shows as a release (Brain.Stop() before the death, NecromancerPet.cs:496-503), so that one goes by how far off it was.
                const tether = !!watch.find([SERVANT_BOND_LOST]) || (loss?.cause === 'released' && servantAway > SHADE_TETHER);
                return { message: `Our pet is gone${tether ? ' (tether: it got too far from us)' : loss ? ` (${loss.cause})` : ''} with ${name} at ${lastHp}% health`, reason: 'pet_died' };
            }
            if (!t) {
                if (foe.vanishedKilled(lastHp, watch)) return 'killed';
                return { message: `${name} disappeared at ${lastHp}% health`, reason: 'target_lost' };
            }
            if (options.endWithin !== undefined && t.distance <= options.endWithin) return { message: `${name} is ${t.distance} from us`, reason: 'arrived' };
            // By a swing's naming: a spell's, a DoT's tick above all, says nothing of where the mob stands (client/model CombatAnimation).
            if (options.endOnUsWithin !== undefined && t.distance <= options.endOnUsWithin && t.kind === 'npc' && t.targetObjectId === s.player.objectId && !t.targetBySpell) return { message: `${name} is on us, ${t.distance} from us`, reason: 'arrived' };

            // An ordered pet won't turn to help (ControlledMobBrain.cs:549-552), so standing by would be dying: the pet fights on, and the caller decides.
            if (!options.ignoreAttackers) {
                const attacker = this.helpers.attackers(s).find(n => n.objectId !== id);
                // With no order out yet, unless one stands from an earlier pass, there is no fight of its to go on with.
                if (attacker) return { message: lastOrderAt === 0 && s.pet.targetObjectId !== id ? `${nameOf(attacker)} is on us: our pet got no order` : onUsLine(attacker, t), reason: 'attacked', attacker };
            }

            // The tether runs from us, and the servant goes where the mob goes. A step stops well short of it, and is short: the fight goes on meanwhile, and the next pass looks again.
            const servant = s.player.isShade ? s.nearbyNpcs.find(n => n.objectId === petId) : undefined;
            if (servant) servantAway = servant.distance;
            const lines = watch.messages();
            const warned = lines.slice(linesSeen).some(m => SERVANT_TOO_FAR.test(m.text));
            linesSeen = lines.length;
            if (servant && options.approach !== false && (servant.distance > SHADE_STEP_BEYOND || (warned && servant.distance > SHADE_ORDER_APPROACH))) {
                sent.move = true;
                const stop = this.helpers.approachPoint(s.player, servant, SHADE_ORDER_APPROACH);
                await this.walkUntil(stop.x, stop.y, { tolerance: 100, timeout: SHADE_STEP_MS }, st => st.pet?.objectId !== petId);
            }

            // The model holds its target through a run-in and between casts, and an order calling it off clears it (PetState.targetObjectId).
            // An order that stands is never repeated: only one it has really dropped.
            const now = Date.now();
            if (s.pet.targetObjectId === id) lastSeenAt = now;
            // A turret just stops at what leaves its spell's range, seen live (TurretBrain.cs:16 looks no further), and the model holds its aim for seconds after that, so no order would find out. The order stands: the mob can come back.
            const beyond = this.turretCantReach(s.pet, t);
            beyondSince = beyond ? beyondSince || now : 0;
            if (beyond && now - beyondSince >= TURRET_BEYOND_MS) return { message: `${name} left the reach of our turret: ${beyond}`, reason: 'out_of_range' };
            // A follow frees it, seen live. A turret has its reach check, and walks nowhere.
            if ((lastOrderAt > 0 || lastSeenAt > 0) && idle(s, t) && !this.windowTurret(s.pet)) {
                await this.petFollow();
                return { message: `Our pet isn't getting to ${name}`, reason: 'out_of_reach' };
            }
            if (now - Math.max(lastSeenAt, lastOrderAt) < PET_REORDER_MS) continue;

            const turret = this.windowTurret(s.pet) !== null;
            if (!turret && !walkedForOrder && t.distance > (s.player.isShade ? SHADE_ORDER_APPROACH : PET_ORDER_RANGE) && options.approach !== false) {
                walkedForOrder = true;
                const stopped = await walkIntoRange(s.player, t);
                if (stopped) return stopped;
                // That took seconds: the next pass looks at everything again, a death first.
                continue;
            }
            const first = lastOrderAt === 0;
            lastOrderAt = Date.now();
            const order = await this.petAttack(id);
            if (order.success) {
                walkedForOrder = false;
                continue;
            }
            // The server goes by where the mob is now (IsWithinRadius 2000, GamePlayer.cs:12185), and our reading of one on the move lags that: at the edge this says nothing against the mob.
            // One walk, on the latest reading, and the next pass orders once more, as a first order, having looked at everything else again.
            if (first && order.reason === 'out_of_range' && !turret && options.approach !== false && !walkedForOrder) {
                walkedForOrder = true;
                lastOrderAt = 0;
                const late = this.helpers.state();
                const mob = late && foe.find(late);
                const stopped = late?.player && mob ? await walkIntoRange(late.player, mob, true) : null;
                if (stopped) return stopped;
                continue;
            }
            // Later orders can fail while the fight stands: the mob stepped out of range for a moment, or just died. A turret won't go after it.
            if (first || order.reason === 'immune' || order.reason === 'not_attackable' || order.reason === 'no_target' || (turret && order.reason === 'out_of_range')) {
                return { message: order.message, reason: order.reason ?? 'refused', retryAfterMs: order.retryAfterMs };
            }
        }
    }

    /**
     * Have our pet follow us. It only drops its order: a defensive pet hits back while the mob stays on it. setPetAggression('passive') is what
     * calls a pet off (ControlledMobBrain.cs:189-204). Reasons of all these simple orders: no_pet, no_response, unknown_action, and those
     * named per order; immobile for a walk order to a turret (this, petStay, petComeHere, petGoTo), with the server's line in `messages`:
     * it doesn't move (TurretBrain.cs:100-108), but follow and stay still call off its order (GamePlayer.cs:12209, :12225).
     */
    async petFollow(options: PetCommandOptions = {}): Promise<PetCommandResult> {
        return this.petOrder('follow', options);
    }

    /** Have our pet stay where it is. */
    async petStay(options: PetCommandOptions = {}): Promise<PetCommandResult> {
        return this.petOrder('stay', options);
    }

    /** Have our pet come to us. It stays there until a follow order (ControlledMobBrain.cs:258-276). */
    async petComeHere(options: PetCommandOptions = {}): Promise<PetCommandResult> {
        return this.petOrder('comeHere', options);
    }

    /**
     * Send our pet to a target (selected first) within 1250 of us on the ground plane (GamePlayer.cs:12263-12265).
     * Reasons: out_of_range, no_target (also for a null target), not_found, bad_args (our own id: that is petComeHere). It stays there until a follow order. Our own target stays moved unless `restoreTarget`.
     */
    async petGoTo(target: ObjectTarget | null | undefined, options: PetTargetOptions = {}): Promise<PetCommandResult> {
        const base = { command: 'goTarget' as const, pet: this.sdk.getPet(), petState: this.sdk.getPetState(), messages: [] as GameMessage[] };
        const none = this.noPetCommand(base);
        if (none) return none;
        if (target === null || target === undefined) return fail('No target for our pet', 'no_target', base);
        if (namesUs(target, this.helpers.player()?.objectId)) return fail('petGoTo needs a target other than us: use petComeHere', 'bad_args', base);
        const t = this.helpers.resolveAny(target);
        if (!t) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', base);
        return this.petOrder('goTarget', options, t);
    }

    /**
     * Set our pet's stance. Passive also has it break off its fight; a new pet starts defensive, so this does not outlive a release (ControlledMobBrain.cs:56-57).
     * A group run's end lifts the passive it set. A run another controller took a member from can't: that connection is cut, so the pet stays passive, its log says `<member>'s pet left passive`, and the next run lifts it, or this.
     */
    async setPetAggression(mode: PetAggression, options: PetCommandOptions = {}): Promise<PetCommandResult> {
        return this.petOrder(mode, options);
    }

    /** NPCs currently targeting our window pet or a summon of ours (a pet with no window: sdk.getSummons), nearest first. */
    getPetAttackers(): NearbyNpc[] {
        return this.helpers.petAttackers().sort((a, b) => a.distance - b.distance);
    }

    /** Why no pet order can go out, as a failure in the result's shape: without a window the server wouldn't answer (GamePlayer.cs:12170-12315). */
    private noPetCommand<T extends object>(base: T): (ActionResult & T) | null {
        const s = this.helpers.state();
        if (!s?.player) return fail('Not in game', 'not_in_game', base);
        if (s.pet === undefined) return fail(OLDER_CLIENT_NO_PETS, 'unknown_action', base);
        return s.pet ? null : fail('We have no pet', 'no_pet', base);
    }

    /**
     * One order and its answer, what every pet command shares. Evidence: the server's line first, because a repeat changes
     * nothing and sends no 0x88 (ControlledMobBrain.cs:179-180, :194-195), then the window; for a release, its close.
     */
    private async petOrder(command: PetCommand, options: PetTargetOptions, target?: Obj): Promise<PetCommandResult> {
        const base = { command, pet: this.sdk.getPet(), petState: this.sdk.getPetState(), messages: [] as GameMessage[] };
        const none = this.noPetCommand(base);
        if (none) return none;
        const before = base.petState!;
        // A turret answers these too, and nothing changes (TurretBrain.cs:100-108, GamePlayer.cs:12207, :12223, :12239, :12269).
        const immobile = PET_WALK_ORDERS.has(command) && this.windowTurret(before) !== null;
        const previousTarget = this.helpers.player()!.targetObjectId;
        // Set before the send: an abort can land with the order in flight, and the client still selects the target.
        const moved = target !== undefined && target.objectId !== previousTarget;
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendPetCommand(command, target?.objectId);
            if (!r.success) return { ...base, ...r };
            const got = await this.helpers.waitFor<ReasonLine | 'answered' | 'gone'>(s => {
                const refusal = firstReasonLine(watch.messages(), PET_REFUSALS);
                if (refusal) return refusal;
                const gone = s.pet?.objectId !== before.objectId;
                if (command === 'release') return gone ? 'answered' : null;
                if (gone) return 'gone';
                if (watch.find([PET_ANSWERS[command]])) return 'answered';
                return petShows(s.pet!, command) && !petShows(before, command) ? 'answered' : null;
            }, options.timeout ?? PET_ANSWER_MS);
            // The 0x88 follows the line on the next tick (PlayerEffectListComponent.cs:100): report what the order did.
            if (got === 'answered' && command !== 'release' && command !== 'attack' && !immobile && !petShows(before, command)) {
                await this.helpers.waitFor(s => !s.pet || petShows(s.pet, command), PET_SETTLE_MS);
            }
            // A charm's ex-pet: the close comes first, the 0xDA with its realm on the same tick, and a killable check has to find that (CharmECSEffect.cs:100-113).
            if (got === 'answered' && command === 'release') {
                await this.helpers.waitFor(s => {
                    const entry = s.nearbyNpcs.find(n => n.objectId === before.objectId);
                    return !entry || entry.realm === 'none';
                }, PET_SETTLE_MS);
            }
            // Gone means gone: read it again, a charm's ex-pet stays in view as a mob. Otherwise an entry out of view keeps the last we saw.
            const closed = this.helpers.state()?.pet?.objectId !== before.objectId;
            const after = { ...base, pet: closed ? this.sdk.getNearbyNpc(before.objectId) : this.sdk.getPet() ?? base.pet, petState: this.sdk.getPetState(), messages: watch.messages().slice() };
            if (!got) return fail(`No answer to the pet order ${command}`, 'no_response', after);
            if (got === 'gone') return fail(`The pet went before the order ${command} was answered`, 'no_pet', after);
            if (typeof got === 'object') return fail(got.text, got.reason, after);
            const name = base.pet?.name ?? before.name;
            if (command === 'release') {
                // A release has just written lastPetLoss: anything else would find the pet before this one there.
                const released = name ?? this.helpers.state()?.lastPetLoss?.name;
                return { success: true, message: `Released ${released ? theName(released) : 'our pet'}`, ...after };
            }
            if (immobile) {
                const answered = /^You command (?:the )?(.+?) to /.exec(watch.findText([PET_ANSWERS[command]]) ?? '')?.[1] ?? name;
                return fail(`${answered ? `Our ${answered} is a turret and doesn't walk` : "Our turret doesn't walk"}: the order only called off what it was doing`, 'immobile', after);
            }
            return { success: true, message: watch.findText([PET_ANSWERS[command]]) ?? `Pet order ${command} done`, ...after };
        } finally {
            watch.dispose();
            if (moved && options.restoreTarget) await this.selectAgain(previousTarget);
        }
    }

    // ============ Loot ============

    /**
     * Pick up loot on the ground within `radius` and report what changed in
     * the backpack and purse (autoloot usually already took it during the kill).
     */
    async lootNearby(options: LootOptions = {}): Promise<LootResult> {
        const radius = options.radius ?? 500;
        const s0 = this.helpers.state();
        if (!s0?.player) return fail('Not in game', 'not_in_game', { picked: [], skipped: [], itemsGained: [], moneyGained: 0, messages: [] });
        const watch = this.helpers.watch();
        const picked: string[] = [];
        const skipped: { name: string; reason: string }[] = [];
        try {
            await withExecutionDeadline(options.timeout ?? 20_000, async () => {
                await this.helpers.sleep(options.settleMs ?? 800);
                const tried = new Set<number>();
                for (let i = 0; i < 12; i++) {
                    const loot = this.sdk.getNearbyLoot().filter(o => !tried.has(o.objectId) && o.distance2d <= radius);
                    const o = loot[0];
                    if (!o) break;
                    tried.add(o.objectId);
                    if (o.distance2d > PICKUP_APPROACH) {
                        const walk = await this.walkTo(o.x, o.y, { z: o.z, tolerance: PICKUP_APPROACH * 0.6 });
                        if (!walk.success) { skipped.push({ name: o.name, reason: walk.message }); continue; }
                    }
                    const mark = watch.messages().length;
                    const r = await this.sdk.sendPickup(o.objectId);
                    if (!r.success) { skipped.push({ name: o.name, reason: r.message }); continue; }
                    const outcome = await this.helpers.waitFor(s => {
                        const refusal = watch.messages().slice(mark).find(m => PICKUP_REFUSALS.some(p => m.text.toLowerCase().includes(p)));
                        if (refusal) return refusal.text;
                        return s.nearbyObjects.some(x => x.objectId === o.objectId) ? null : 'gone';
                    }, 3000);
                    if (outcome === 'gone') picked.push(o.name);
                    else skipped.push({ name: o.name, reason: outcome ?? 'no response' });
                }
            }, () => undefined);
            await this.helpers.sleep(300);
            const s = this.helpers.state();
            const itemsGained = diffInventory(s0.inventory, s?.inventory ?? []).gained;
            const moneyGained = Math.max(0, totalCopper(s) - totalCopper(s0));
            const messages = watch.messages().filter(m => /you (pick up|get)|loot|drops/i.test(m.text));
            const nothing = picked.length === 0 && itemsGained.length === 0 && moneyGained === 0;
            if (nothing && skipped.length) return { success: false, message: `Could not loot: ${skipped.map(x => `${x.name} (${x.reason})`).join(', ')}`, reason: 'refused', picked, skipped, itemsGained, moneyGained, messages };
            const what = [...itemsGained.map(i => `${i.count}× ${i.name}`), moneyGained ? `${moneyGained}c` : ''].filter(Boolean).join(', ');
            return { success: true, message: nothing ? 'Nothing to loot' : `Looted ${what || picked.join(', ')}`, picked, skipped, itemsGained, moneyGained, messages };
        } finally {
            watch.dispose();
        }
    }

    // ============ Recovery ============

    /**
     * Sit until health (and optionally mana, endurance and our pet's health) reach the thresholds, then stand. Reason 'in_combat' while a pet
     * of ours fights or a mob is on one, also on its way to a mob, a summon as well, also with nothing to rest for, and also when it starts while we
     * sit: the server counts its fight as ours, so regen ticks every 10 s (GamePlayer.cs:2314-2322, :6045-6047), and a sit wouldn't stop that fight.
     * A mob on us counts only if there is something to rest for: 'in_combat' at the start, 'attacked' while sitting. So does a summon that has only just come, which may well be in its fight
     * with nothing to show for it yet: 'in_combat' whenever it holds up a rest, with the message saying so (BotWorldState.freshSummons).
     */
    async rest(options: RestOptions = {}): Promise<RestResult> {
        const started = Date.now();
        const hp = options.healthPercent ?? 90;
        const petHealth = (): number | undefined => options.petHealthPercent === undefined ? undefined : this.sdk.getPet()?.healthPercent;
        const done = (p: PlayerState) => p.healthPercent >= hp &&
            (options.manaPercent === undefined || p.maxMana === 0 || p.manaPercent >= options.manaPercent) &&
            (options.endurancePercent === undefined || p.endurancePercent >= options.endurancePercent) &&
            (petHealth() ?? 100) >= (options.petHealthPercent ?? 0);
        // All that was asked for, as it stands: health alone can read full on a rest that waits for mana.
        const levels = (verb: string): string => {
            const p = this.helpers.player();
            const health = petHealth();
            return [
                `${p?.healthPercent}% health`,
                ...(options.manaPercent !== undefined && p?.maxMana ? [`${p.manaPercent}% mana`] : []),
                ...(options.endurancePercent !== undefined ? [`${p?.endurancePercent}% endurance`] : []),
                ...(health !== undefined ? [`our pet ${verb} ${health}%`] : []),
            ].join(', ');
        };
        const result = (success: boolean, message: string, reason?: string): RestResult => {
            const p = this.helpers.player();
            return { success, message, reason, healthPercent: p?.healthPercent ?? 0, manaPercent: p?.manaPercent ?? 0, endurancePercent: p?.endurancePercent ?? 0, durationMs: Date.now() - started };
        };
        // A fight of our pets comes first, and a summon that has only just come holds up only a rest with something to do.
        const petLine = (s: BotWorldState | null, p: PlayerState): string | null => this.helpers.petFightLine(s) ?? (done(p) ? null : this.helpers.freshSummonLine(s));
        const p0 = this.helpers.player();
        if (!p0) return result(false, 'Not in game', 'not_in_game');
        if (p0.isDead) return result(false, 'We are dead', 'dead');
        const petFight = petLine(this.helpers.state(), p0);
        if (petFight) return result(false, `Cannot rest: ${petFight}`, 'in_combat');
        if (done(p0)) return result(true, 'Already rested');
        if (this.helpers.attackers().length) return result(false, `Cannot rest: attacked by ${this.helpers.attackers().map(n => n.name).join(', ')}`, 'in_combat');
        if (this.sdk.getMovement()?.moving) await this.sdk.sendStop();

        const watch = this.helpers.watch();
        // Counted before each sendSit(true): an abort can land while that sit is still in flight.
        let sits = 0;
        try {
            return await withExecutionDeadline(options.timeout ?? 120_000, async () => {
                let lastHealth = p0.health;
                const sit = async (): Promise<RestResult | null> => {
                    sits++;
                    const mark = watch.messages().length;
                    const r = await this.sdk.sendSit(true);
                    if (!r.success) return result(false, r.message, r.reason ?? 'dispatch_failed');
                    // The client marks us sitting as soon as it sends the request, so the
                    // server's answer (GamePlayer.Sit) is the evidence; isSitting is only a fallback.
                    const sat = await this.helpers.waitFor(() => {
                        const fresh = watch.messages().slice(mark);
                        const refusal = fresh.find(m => SIT_REFUSALS.some(x => m.text.toLowerCase().includes(x)));
                        if (refusal) return refusal.text;
                        return fresh.some(m => /you sit down|you are already sitting/i.test(m.text)) ? 'sitting' : null;
                    }, 3000) ?? (this.helpers.player()?.isSitting ? 'sitting' : null);
                    if (sat !== 'sitting') return result(false, sat ?? 'Did not sit down', sat ? 'refused' : 'timeout');
                    return null;
                };
                const failed = await sit();
                if (failed) return failed;
                for (;;) {
                    const s = await this.helpers.nextState(1000);
                    const p = s?.player ?? this.helpers.player();
                    if (!p) return result(false, 'Lost game state', 'not_in_game');
                    if (p.isDead) return result(false, 'Died while resting', 'died');
                    const fight = petLine(s, p);
                    if (fight) return result(false, `Stopped resting: ${fight}`, 'in_combat');
                    if (done(p)) return result(true, `Rested to ${levels('to')}`);
                    const attackers = this.helpers.attackers(s);
                    if (attackers.length || p.health < lastHealth - 1) return result(false, `Attacked while resting${attackers.length ? ` by ${attackers.map(n => n.name).join(', ')}` : ''}`, 'attacked');
                    lastHealth = p.health;
                    if (!p.isSitting) {
                        if (sits >= 3) return result(false, 'Keeps standing up', 'interrupted');
                        const again = await sit();
                        if (again) return again;
                    }
                    await this.helpers.sleep(500);
                }
            }, () => result(false, `Rest timed out at ${levels('at')}`, 'timeout'));
        } finally {
            watch.dispose();
            if (sits > 0 || this.helpers.player()?.isSitting) {
                await this.helpers.cleanup(async () => {
                    await this.sdk.sendSit(false);
                    await this.helpers.waitFor(s => !s.player?.isSitting, 2000);
                });
            }
        }
    }

    /** Wait (without sitting) until health reaches `percent`. */
    async waitForHealth(percent: number, timeout: number = 60_000): Promise<ActionResult> {
        const ok = await this.helpers.waitFor(s => s.player && s.player.healthPercent >= percent, timeout);
        return ok ? { success: true, message: `Health ${this.helpers.player()?.healthPercent}%` } : fail(`Health still ${this.helpers.player()?.healthPercent}%`, 'timeout', {});
    }

    /**
     * Release after death and observe being alive at the bind point. In the server's first 10 s the request arms its automatic release,
     * and a second one would disarm it (GamePlayer.cs:1438-1449), so that one is waited out, and asked again only 2 s past its time. One that finds it armed already, by an earlier call, has disarmed it, so another goes at once and arms it again with the right time. Any other refusal is retried until the server allows it.
     */
    async releaseAndRespawn(options: { timeout?: number } = {}): Promise<RespawnResult> {
        const p0 = this.helpers.player();
        const extra = () => {
            const p = this.helpers.player();
            return { position: p ? { x: p.x, y: p.y, z: p.z } : null, regionId: p?.regionId ?? null };
        };
        if (!p0) return { ...fail('Not in game', 'not_in_game', {}), ...extra() };
        if (!p0.isDead) return { ...fail('Not dead', 'not_dead', {}), ...extra() };
        const watch = this.helpers.watch();
        try {
            return await withExecutionDeadline(options.timeout ?? 45_000, async () => {
                for (;;) {
                    const mark = watch.messages().length;
                    const r = await this.sdk.sendRelease();
                    if (!r.success && r.reason !== 'not_dead') return { ...fail(r.message, r.reason ?? 'dispatch_failed', {}), ...extra() };
                    const answer = await this.helpers.waitFor<'alive' | 'wait' | 'disarmed' | { armedFor: number }>(s => {
                        if (s.player && !s.player.isDead) return 'alive';
                        const fresh = watch.messages().slice(mark);
                        const armed = fresh.map(m => AUTO_RELEASE_ARMED.exec(m.text)).find(m => m);
                        if (armed) return { armedFor: Number(armed[1]) * 1000 };
                        if (fresh.some(m => AUTO_RELEASE_DISARMED.test(m.text))) return 'disarmed';
                        return fresh.some(m => RELEASE_REFUSALS.some(x => m.text.toLowerCase().includes(x))) ? 'wait' : null;
                    }, 5000);
                    if (answer === 'alive') break;
                    if (answer === 'disarmed') continue;
                    if (answer && answer !== 'wait') {
                        if (await this.helpers.waitFor(s => s.player && !s.player.isDead, answer.armedFor + AUTO_RELEASE_MARGIN_MS)) break;
                        continue;
                    }
                    await this.helpers.sleep(2000);
                }
                await this.helpers.waitFor(s => s.player && (Math.hypot(s.player.x - p0.x, s.player.y - p0.y) > 50 || s.player.regionId !== p0.regionId), 5000);
                // The health update trails the position.
                await this.helpers.waitFor(s => s.player && s.player.healthPercent > 0, 5000);
                const p = this.helpers.player();
                return { success: true, message: `Respawned at ${p?.regionId}:${p?.x},${p?.y}`, ...extra() };
            }, () => ({ ...fail('Release timed out', 'timeout', {}), ...extra() }));
        } finally {
            watch.dispose();
        }
    }

    /** Our strongest resurrection spell, or null. The higher its level, the more it restores: 10 %, then 30, 50 and 100 % on a spec line. */
    resurrectSpell(): Spell | null {
        return this.sdk.getSkills().spells.filter(s => this.getSpellInfo(s)?.type === 'Resurrect').sort((a, b) => b.level - a.level)[0] ?? null;
    }

    /**
     * Resurrect a dead player of our realm: walk into range, cast, and wait for its answer. Success means it
     * is alive again: a finished cast only asks, and a corpse no script controls never answers (the power is
     * gone then). It comes back at our feet. It must be in view. Costs half our full power at equal level
     * (resurrectCost), paid when the cast ends.
     * Reasons: those of castSpell, plus spell_not_found, not_found, invalid_target, not_dead (alive, or released
     * meanwhile), no_power, already_considering (someone else's rez waits for its answer), no_answer.
     */
    async resurrect(target: PlayerTarget, options: ResurrectOptions = {}): Promise<ResurrectResult> {
        const none = { spell: null, target: null, cast: null };
        const me = this.helpers.player();
        if (!me) return fail('Not in game', 'not_in_game', none);
        if (me.isDead) return fail('We are dead', 'dead', none);
        const spell = options.spell ?? this.resurrectSpell();
        if (!spell) return fail('We know no resurrection spell', 'spell_not_found', none);
        const t = this.helpers.resolvePlayer(target);
        if (!t) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', { ...none, spell });
        const base = { spell, target: t, cast: null };
        if (t.realm !== me.realm) return fail(`${t.name} is of another realm`, 'invalid_target', base);
        if (!t.isDead) return fail(`${t.name} is not dead`, 'not_dead', base);
        const cost = resurrectCost(me.maxMana, me.level, t.level || me.level);
        if (me.mana < cost) return fail(`Resurrecting ${t.name} costs ${cost} power, we have ${me.mana}`, 'no_power', base);
        const cast = await this.castSpell(spell, t.objectId, options.approach === undefined ? {} : { approach: options.approach });
        // The realm is checked above, so the Corpse line says it is alive by now (SpellHandler.cs:764).
        if (!cast.success) return fail(cast.message, cast.message === CORPSE_ONLY ? 'not_dead' : cast.reason ?? 'refused', { ...base, cast });
            // 0x89 goes to the revived player alone: we see its health come back in its relayed position. Alive
            // isn't enough, since a release shows the same when the bind point is in view: a rez puts it at our feet (:163).
            const back = await this.helpers.waitFor(s => {
                const seen = s.nearbyPlayers.find(n => n.objectId === t.objectId);
                return seen && !seen.isDead && s.player && Math.hypot(seen.x - s.player.x, seen.y - s.player.y) <= REZZED_NEAR ? true : null;
            }, options.answerMs ?? 16_000);
            if (back) return { success: true, message: `${t.name} is back`, ...base, cast };
            const seen = this.helpers.resolvePlayer(t.objectId);
            return seen && !seen.isDead
                ? fail(`${t.name} is alive elsewhere: it released`, 'not_dead', { ...base, cast })
                : fail(`${t.name} did not answer ${spell.name}`, 'no_answer', { ...base, cast });
    }

    /** Static data for a known spell (type, target, range, cast time, power), from the DB dump; null when unknown. */
    getSpellInfo(spell: NamePattern | Spell): SpellInfo | null {
        const sp = typeof spell === 'object' && !(spell instanceof RegExp) ? spell : this.sdk.findSpell(spell);
        if (!sp) return null;
        try {
            const byId = getSpell(sp.internalId);
            if (byId && byId.name.toLowerCase() === sp.name.toLowerCase()) return byId;
            return getSpells().find(s => s.name.toLowerCase() === sp.name.toLowerCase()) ?? null;
        } catch {
            return null;
        }
    }

    /** Our character is dead. */
    isDead(): boolean {
        return this.helpers.player()?.isDead ?? false;
    }

    // ============ Items ============

    /**
     * Equip a backpack item; the server picks its slot, or takes `options.slot` when given (a worn
     * item there swaps into the backpack). Observed in state.equipment: with a slot, that slot must
     * hold this item, so an equal-named item already worn elsewhere doesn't count. What it replaces lands
     * in the backpack slot this one left, so only this very item still there means it didn't move. A swap
     * with a piece that reads the same changes no reading, so a magical piece counts on the server's "The
     * magic of X flows through you". A plain one has nothing that tells them apart and no message: `timeout`.
     * A weapon put in the ranged slot (13) also takes the hand ("You wield it in both hands"),
     * and melee is refused until a melee slot is used (sendUseItem(10 or 12, 0); killNpc does that itself).
     */
    async equipItem(target: InventoryItem | NamePattern | number, options: { slot?: number } = {}): Promise<ItemResult> {
        const item = this.helpers.resolveInventoryItem(target);
        if (!item) return fail(`Item not found in backpack: ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        const { slot } = options;
        const worn = (e: InventoryItem) => e.name === item.name && e.level === item.level;
        const left = (s: BotWorldState) => !s.inventory.some(i => i.slot === item.slot && sameItem(i, item));
        const saysSo = this.helpers.state()?.equipment.some(e => sameItem(e, item)) ? `${item.name.toLowerCase()} flows through you` : undefined;
        if (slot !== undefined) {
            return this.moveObserved(item, slot, s => s.equipment.some(e => e.slot === slot && worn(e)) && left(s), `Equipped ${item.name} in slot ${slot}`, saysSo);
        }
        return this.moveObserved(item, PAPER_DOLL_SLOT, s => s.equipment.some(worn) && left(s), `Equipped ${item.name}`, saysSo);
    }

    /** Move an equipped item (by slot or name) back into the backpack. */
    async unequipItem(target: number | NamePattern): Promise<ItemResult> {
        const item = typeof target === 'number' ? this.sdk.getEquipmentItem(target) : this.sdk.findEquipmentItem(target);
        if (!item) return fail(`Nothing equipped matching ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        if (this.sdk.getFreeInventorySlots() <= 0) return fail('Backpack is full', 'inventory_full', { item, messages: [] });
        return this.moveObserved(item, PAPER_DOLL_SLOT, s => !s.equipment.some(e => e.slot === item.slot && e.name === item.name), `Unequipped ${item.name}`);
    }

    /** Drop a backpack item on the ground. */
    async dropItem(target: InventoryItem | NamePattern | number): Promise<ItemResult> {
        const item = this.helpers.resolveInventoryItem(target);
        if (!item) return fail(`Item not found: ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        return this.slotGone(item, () => this.sdk.sendDropItem(item.slot), `Dropped ${item.name}`);
    }

    /** Destroy a backpack item. */
    async destroyItem(target: InventoryItem | NamePattern | number): Promise<ItemResult> {
        const item = this.helpers.resolveInventoryItem(target);
        if (!item) return fail(`Item not found: ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        return this.slotGone(item, () => this.sdk.sendDestroyItem(item.slot), `Destroyed ${item.name}`);
    }

    /**
     * Use (right-click) a backpack or equipped item: potions, charged items. A number is a
     * backpack (40-79) or equipment (10-37) slot. Success needs evidence about this item: a
     * message naming it ("You attempt to use <item>.", GamePlayer.cs:6564), its stack count
     * changing, or a new effect, and no refusal in the following ~400 ms. That attempt line alone means only that the attempt is known: the server sends it before it knows whether the item does anything. Reason in_combat: a recall stone that says we were in combat recently (GatewayPersonalBind.cs:105), else refused,
     * also for "You are already casting a spell." (GamePlayer.cs:7169-7173). A stone used while walking starts, as the client's use prefix says speed 0 (client.ts prefix, UseSlotHandler.cs:21, GatewayPersonalBind.cs:32), and its cast stops the walk (session.ts:501): a walkTo under way reads stuck, so stop first.
     * Success only says its 10 s cast began: an interrupt later comes after this returns, so watch for the jump.
     * On the ranged slot (13) the draw's and the shot's lines count too, an evaded or blocked shot's as well, as they name no item: one use draws ("You prepare your shot", then "You are ready to fire!") and the next fires, or, used before it is ready, sets it to fire by itself; with another weapon in hand a use first takes the bow in hand (GamePlayer.cs:6649-6698).
     */
    async useItem(target: InventoryItem | NamePattern | number, options: { useType?: number } = {}): Promise<ItemResult> {
        const item = this.resolveUsableItem(target);
        if (!item) return fail(`Item not found: ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        const equipped = item.slot < 40;
        const name = item.name.toLowerCase();
        const watch = this.helpers.watch();
        const effects0 = this.sdk.getEffects().map(e => e.name).join('|');
        const refusalOf = (msgs: GameMessage[]) => msgs.find(m => USE_ITEM_REFUSALS.some(x => m.text.toLowerCase().includes(x)));
        const aboutIt = (m: GameMessage) => m.text.toLowerCase().includes(name) || (item.slot === EquipmentSlot.Ranged && RANGED_USE_LINE.test(m.text));
        try {
            const r = await this.sdk.sendUseItem(item.slot, options.useType);
            if (!r.success) return { ...r, item, messages: [] };
            const got = await this.helpers.waitFor(s => {
                const msgs = watch.messages();
                if (refusalOf(msgs)) return 'refused';
                if (msgs.some(aboutIt)) return 'message';
                // The item was resolved from a snapshot where it sat in this slot, so any change is the server's doing.
                const now = (equipped ? s.equipment : s.inventory).find(i => i.slot === item.slot);
                if (!now || now.name !== item.name || now.count !== item.count) return 'changed';
                if (s.effects.map(e => e.name).join('|') !== effects0) return 'effect';
                return null;
            }, 3000);
            // Refusals can trail the first evidence (charge/level checks after "You attempt to use"):
            // wait longer than one ~250 ms snapshot interval before deciding.
            if (got && got !== 'refused') await this.helpers.sleep(400);
            const messages = watch.messages().slice();
            const refusal = refusalOf(messages);
            if (refusal) return { ...fail(refusal.text, /in combat recently/i.test(refusal.text) ? 'in_combat' : 'refused', {}), item, messages };
            if (!got) return { ...fail(`No response using ${item.name}`, 'no_response', {}), item, messages };
            return { success: true, message: messages.find(aboutIt)?.text ?? `Used ${item.name}`, item, messages };
        } finally {
            watch.dispose();
        }
    }

    /**
     * Read an item's real bonuses: a backpack or equipped item, by item, name or slot. Reason
     * 'empty_slot' for an empty slot asked by number, 'not_found' for a name nothing matches,
     * 'no_response' when no window named after the item came within `timeout`: only the caption says
     * a 0xC4 window is ours (NPC text and commands send them too, DetailDisplayHandler.cs:114), and
     * the snapshot holds only the latest one, so another window landing right after it loses the answer.
     */
    async delveMerchantItem(merchant: NpcTarget, item: NamePattern | { page: number; slot: number }, options: { timeout?: number } = {}): Promise<MerchantDelveResult> {
        const none = (wanted: MerchantItem | null) => ({ item: wanted, lines: [], ...parseDelve([]) });
        const open = await this.openMerchant(merchant);
        if (!open.success) return fail(open.message, open.reason ?? 'no_merchant', none(null));
        const wanted = typeof item === 'object' && !(item instanceof RegExp)
            ? open.items.find(i => i.page === item.page && i.slot === item.slot) ?? null
            : bestNameMatch(open.items, item);
        if (!wanted) return fail(`${open.merchant?.name} does not sell ${describeTarget(item)}`, 'item_not_sold', none(null));
        const before = this.sdk.getTextWindow()?.receivedAt ?? 0;
        const r = await this.sdk.sendDelveMerchantItem(wanted.page, wanted.slot);
        if (!r.success) return { ...r, ...none(wanted) };
        const window = await this.helpers.waitFor(s => {
            const w = s.textWindow;
            return w && w.receivedAt !== before && isDelveOf(w.caption, wanted.name) ? w : null;
        }, options.timeout ?? 3000);
        if (!window) return fail(`No delve answer for ${wanted.name}`, 'no_response', none(wanted));
        const parsed = parseDelve(window.lines);
        return { success: true, message: `Delved ${wanted.name}: ${parsed.bonuses.length} bonuses`, item: wanted, lines: window.lines, ...parsed };
    }

    async delveItem(target: InventoryItem | NamePattern | number, options: { timeout?: number } = {}): Promise<DelveResult> {
        const none = (item: InventoryItem | null) => ({ item, lines: [], ...parseDelve([]) });
        const item = this.resolveUsableItem(target);
        if (!item) {
            return typeof target === 'number'
                ? fail(`No item in slot ${target}`, 'empty_slot', none(null))
                : fail(`Item not found: ${describeTarget(target)}`, 'not_found', none(null));
        }
        const before = this.sdk.getTextWindow()?.receivedAt ?? 0;
        const r = await this.sdk.sendDelve(item.slot);
        if (!r.success) return { ...r, ...none(item) };
        const window = await this.helpers.waitFor(s => {
            const w = s.textWindow;
            return w && w.receivedAt !== before && isDelveOf(w.caption, item.name) ? w : null;
        }, options.timeout ?? 3000);
        if (!window) return fail(`No delve answer for ${item.name} in slot ${item.slot}`, 'no_response', none(item));
        const parsed = parseDelve(window.lines);
        return { success: true, message: `Delved ${item.name}: ${parsed.bonuses.length} bonuses`, item, lines: window.lines, ...parsed };
    }

    /** A backpack item, else an equipped one (by equipment slot 10-37, name or a stale snapshot item). */
    private resolveUsableItem(target: InventoryItem | NamePattern | number): InventoryItem | null {
        if (typeof target === 'number') return target < 40 ? this.sdk.getEquipmentItem(target) : this.sdk.getInventoryItem(target);
        if (typeof target === 'string' || target instanceof RegExp) return this.sdk.findInventoryItem(target) ?? this.sdk.findEquipmentItem(target);
        if (target.slot < 40) {
            const eq = this.sdk.getEquipmentItem(target.slot);
            if (eq && eq.name === target.name) return eq;
        }
        return this.helpers.resolveInventoryItem(target) ?? this.sdk.findEquipmentItem(target.name);
    }

    /** Backpack item by name (shortest match wins). */
    findInventoryItem(pattern: NamePattern): InventoryItem | null {
        return this.sdk.findInventoryItem(pattern);
    }

    /** Free backpack slots (of 40). */
    freeBackpackSlots(): number {
        return this.sdk.getFreeInventorySlots();
    }

    // ============ Merchants / trainers ============

    /** Walk to a merchant and open its window; observed via state.merchant. */
    async openMerchant(merchant: NpcTarget): Promise<MerchantResult> {
        const n = this.helpers.resolveNpc(merchant);
        if (!n) return fail(`Merchant not found: ${describeTarget(merchant)}`, 'not_found', { merchant: null, items: [] });
        const open = this.sdk.getMerchant();
        if (open && open.merchantObjectId === n.objectId && n.distance <= MERCHANT_APPROACH + 50) {
            return { success: true, message: `${n.name}'s shop is open`, merchant: n, items: open.items };
        }
        // The client merges window pages arriving within 1 s into the open window (keeping the old
        // merchantObjectId), so close another merchant's window first.
        if (open) await this.sdk.sendCloseMerchant();
        const r = await this.interactWith(n, { range: MERCHANT_APPROACH });
        const m = this.sdk.getMerchant();
        if (m && m.merchantObjectId === n.objectId) return { success: true, message: `Opened ${n.name}'s shop (${m.items.length} items)`, merchant: n, items: m.items };
        return fail(r.success ? `${n.name} answered but no shop opened (${r.response})` : r.message, r.success ? 'not_a_merchant' : r.reason ?? 'no_response', { merchant: n, items: [] });
    }

    /** Close the merchant window (client-side state). */
    async closeMerchant(): Promise<ActionResult> {
        return this.sdk.sendCloseMerchant();
    }

    /** Buy `count` of an item (name or page/slot) and observe the backpack and purse. */
    async buyItem(merchant: NpcTarget, item: NamePattern | { page: number; slot: number }, count: number = 1): Promise<BuyResult> {
        const empty = { item: null, count: 0, spent: 0, itemsGained: [] as InventoryItem[] };
        const open = await this.openMerchant(merchant);
        if (!open.success) return { ...fail(open.message, open.reason ?? 'no_merchant', empty) };
        const wanted = typeof item === 'object' && !(item instanceof RegExp)
            ? open.items.find(i => i.page === item.page && i.slot === item.slot) ?? null
            : bestNameMatch(open.items, item);
        if (!wanted) return fail(`${open.merchant?.name} does not sell ${describeTarget(item)}`, 'item_not_sold', empty);
        const s0 = this.helpers.state()!;
        const money0 = totalCopper(s0);
        if (wanted.price * count > money0) return fail(`${wanted.name} costs ${wanted.price * count}c, we have ${money0}c`, 'insufficient_funds', { ...empty, item: wanted });
        if (this.sdk.getFreeInventorySlots() <= 0) return fail('Backpack is full', 'inventory_full', { ...empty, item: wanted });
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendBuy(wanted.page, wanted.slot, count);
            if (!r.success) return { ...fail(r.message, r.reason ?? 'dispatch_failed', empty), item: wanted };
            const got = await this.helpers.waitFor(s => {
                if (watch.find(BUY_REFUSALS)) return 'refused';
                const gained = diffInventory(s0.inventory, s.inventory).gained;
                return gained.length && totalCopper(s) < money0 ? 'bought' : null;
            }, 4000);
            await this.helpers.sleep(200);
            const s = this.helpers.state()!;
            const itemsGained = diffInventory(s0.inventory, s.inventory).gained;
            const spent = Math.max(0, money0 - totalCopper(s));
            const units = itemsGained.reduce((t, i) => t + i.count, 0);
            if (got === 'refused') return { ...fail(watch.findText(BUY_REFUSALS)!, 'refused', empty), item: wanted, spent, itemsGained };
            if (!got && !itemsGained.length) return { ...fail(`No purchase observed for ${wanted.name}`, 'timeout', empty), item: wanted };
            return { success: true, message: `Bought ${units}× ${wanted.name} for ${spent}c`, item: wanted, count: units, spent, itemsGained };
        } finally {
            watch.dispose();
        }
    }

    /** Sell one backpack item (whole stack) to a merchant and observe the purse. */
    async sellItem(merchant: NpcTarget, item: InventoryItem | NamePattern | number): Promise<SellResult> {
        const inv = this.helpers.resolveInventoryItem(item);
        if (!inv) return fail(`Item not found: ${describeTarget(item)}`, 'not_found', { item: null, earned: 0 });
        const open = await this.openMerchant(merchant);
        if (!open.success) return fail(open.message, open.reason ?? 'no_merchant', { item: inv, earned: 0 });
        const money0 = totalCopper(this.helpers.state());
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendSell(inv.slot);
            if (!r.success) return { ...fail(r.message, r.reason ?? 'dispatch_failed', {}), item: inv, earned: 0 };
            const got = await this.helpers.waitFor(s => {
                if (watch.find(SELL_REFUSALS)) return 'refused';
                const now = s.inventory.find(i => i.slot === inv.slot);
                const gone = !now || now.name !== inv.name || now.count < inv.count;
                return gone || totalCopper(s) > money0 ? 'sold' : null;
            }, 4000);
            await this.helpers.sleep(250);
            const earned = Math.max(0, totalCopper(this.helpers.state()) - money0);
            if (got === 'refused') return { ...fail(watch.findText(SELL_REFUSALS)!, 'refused', {}), item: inv, earned };
            if (!got) return { ...fail(`No sale observed for ${inv.name}`, 'timeout', {}), item: inv, earned };
            return { success: true, message: `Sold ${inv.name} for ${earned}c`, item: inv, earned };
        } finally {
            watch.dispose();
        }
    }

    /** Sell every backpack item matching a predicate or name pattern. */
    async sellItems(merchant: NpcTarget, filter: NamePattern | ((item: InventoryItem) => boolean)): Promise<SellItemsResult> {
        const test = typeof filter === 'function' ? filter : (i: InventoryItem) => nameMatcher(filter)(i.name);
        const items = this.sdk.getInventory().filter(test);
        const sold: InventoryItem[] = [];
        const failed: { item: InventoryItem; reason: string }[] = [];
        let earned = 0;
        for (const item of items) {
            const r = await this.sellItem(merchant, item);
            if (r.success) { sold.push(item); earned += r.earned; }
            else {
                failed.push({ item, reason: r.message });
                if (r.reason === 'not_found' && !this.helpers.resolveNpc(merchant)) break;
            }
        }
        return {
            success: sold.length > 0 || items.length === 0,
            message: items.length === 0 ? 'Nothing to sell' : `Sold ${sold.length}/${items.length} for ${earned}c`,
            reason: sold.length === 0 && items.length > 0 ? 'none_sold' : undefined,
            sold, failed, earned,
        };
    }

    // ============ Smiths and the vault ============

    /**
     * Have a smith repair one item, worn or in the backpack: walk within 128 (3D), hand it over, read
     * the price off the yes/no box, say yes, and observe the smith's answer. Costs the Durability it
     * restores, and when too little is left it charges in full and restores only that much. Reasons:
     * `not_found`, `out_of_range`, `no_need` (already whole), `not_repairable`, `too_expensive` (over
     * `options.maxCost`, declined), `insufficient_funds`, `no_response` (not a smith, or no answer).
     * A smith takes no jewellery, instruments or stacks: an instrument only through repairAll.
     */
    async repairItem(smith: NpcTarget, target: InventoryItem | NamePattern | number, options: { maxCost?: number } = {}): Promise<RepairResult> {
        const item = this.resolveUsableItem(target);
        const empty = { item, repaired: null, cost: 0, messages: [] as GameMessage[] };
        if (!item) return fail(`Item not found: ${describeTarget(target)}`, 'not_found', empty);
        let n = this.helpers.resolveNpc(smith);
        if (!n) return fail(`Smith not found: ${describeTarget(smith)}`, 'not_found', empty);
        if (n.distance > GIVE_APPROACH) {
            const walk = await this.walkToObject(n, { range: GIVE_APPROACH });
            if (!walk.success) return fail(walk.message, walk.reason ?? 'out_of_reach', empty);
            n = this.helpers.resolveNpc(n.objectId) ?? n;
        }
        const objectId = n.objectId;
        if (GIVE_TO_OBJECT + objectId > 0xffff) return fail(`${n.name}'s object id ${objectId} doesn't fit the packet`, 'bad_args', empty);
        const r = await this.answerRepairBox(n.name, options, () => this.sdk.sendMoveItem(item.slot, GIVE_TO_OBJECT + objectId), 4000);
        // The item's own update can trail the smith's line by a snapshot.
        if (r.success) await this.helpers.waitFor(() => (this.resolveUsableItem(item.slot)?.condition ?? 0) > item.condition, 1000);
        return { ...r, item, repaired: this.resolveUsableItem(item.slot) };
    }

    /**
     * Have a smith repair everything at once: worn, backpack and vault, whatever its type, and 20 % over the
     * single prices (Blacksmith.cs:14, :219-228). The only way to repair an instrument. Success with
     * cost 0 means nothing needed it. Reasons as repairItem.
     */
    async repairAll(smith: NpcTarget, options: { maxCost?: number } = {}): Promise<RepairResult> {
        const empty = { item: null, repaired: null, cost: 0, messages: [] as GameMessage[] };
        const n = this.helpers.resolveNpc(smith);
        if (!n) return fail(`Smith not found: ${describeTarget(smith)}`, 'not_found', empty);
        let nothingDue = false;
        const r = await this.answerRepairBox(n.name, options, async () => {
            const said = await this.whisper(n, 'repair all');
            nothingDue = NOTHING_TO_REPAIR.test(said.text);
            return said;
        }, 2000, () => nothingDue);
        return nothingDue ? { success: true, message: `${n.name}: nothing to repair`, ...empty, messages: r.messages } : r;
    }

    /**
     * Send what brings the smith's box, then answer it: only a box that opened since and names a repair,
     * because an answer goes to whatever box is open. The next hand-over needs this one answered:
     * another box in between makes the smith forget the item (Blacksmith.cs:138, PacketLib168.cs:1511-1513).
     */
    private async answerRepairBox(smith: string, options: { maxCost?: number }, send: () => Promise<ActionResult>, timeout: number, nothingDue?: () => boolean): Promise<RepairResult> {
        const empty = { item: null, repaired: null, cost: 0 };
        const before = this.helpers.state();
        const money0 = totalCopper(before);
        const box0 = before?.dialog?.receivedAt;
        const watch = this.helpers.watch();
        try {
            const failed = (message: string, reason: string): RepairResult => ({ ...fail(message, reason, empty), messages: watch.messages().slice() });
            // Left open by a run that was cut off: a no now, or the smith forgets what comes next.
            if (before?.dialog?.isOpen && REPAIR_OFFER.test(before.dialog.text)) await this.sdk.sendRespondDialog(false);
            const sent = await send();
            if (!sent.success) return failed(sent.message, sent.reason ?? 'dispatch_failed');
            if (nothingDue?.()) return failed('', 'no_need');
            const box = await this.helpers.waitFor(s => {
                if (firstReasonLine(watch.messages(), REPAIR_REFUSALS)) return 'refused' as const;
                return s.dialog?.isOpen && s.dialog.receivedAt !== box0 && REPAIR_OFFER.test(s.dialog.text) ? s.dialog : null;
            }, timeout);
            if (box === 'refused') {
                const line = firstReasonLine(watch.messages(), REPAIR_REFUSALS)!;
                return failed(line.text, line.reason);
            }
            if (!box) return failed(`${smith} did not offer a repair`, 'no_response');
            const price = parseMoneyText(REPAIR_OFFER.exec(box.text)![1]!);
            const decline = async (message: string, reason: string) => {
                await this.sdk.sendRespondDialog(false);
                return failed(message, reason);
            };
            if (options.maxCost !== undefined && price > options.maxCost) return decline(`${smith} asks ${price}c, over the ${options.maxCost}c allowed`, 'too_expensive');
            if (price > money0) return decline(`${smith} asks ${price}c, we have ${money0}c`, 'insufficient_funds');
            const yes = await this.sdk.sendRespondDialog(true);
            if (!yes.success) return failed(yes.message, yes.reason ?? 'dispatch_failed');
            const answer = await this.helpers.waitFor(() => firstReasonLine(watch.messages(), REPAIR_ANSWERS), 4000);
            if (answer && answer.reason !== 'done') return failed(answer.text, answer.reason);
            if (!answer) return failed(`No answer from ${smith} after the yes`, 'no_response');
            // The purse and the item's update come with or just after that line.
            await this.helpers.waitFor(s => price === 0 || totalCopper(s) < money0, 1000);
            await this.helpers.sleep(250);
            const cost = Math.max(0, money0 - totalCopper(this.helpers.state()));
            return { success: true, message: `${smith} repaired it for ${cost}c`, ...empty, cost, messages: watch.messages().slice() };
        } finally {
            watch.dispose();
        }
    }

    /**
     * Walk to a vault keeper and open the character's vault. Until then, in each client session,
     * `sdk.getVault()` is empty whatever the vault holds. Reason `not_a_vault_keeper` for an NPC that answers
     * some other way. The vault is the character's own: 40 slots, not shared with other bots.
     */
    async openVault(keeper: NpcTarget): Promise<VaultResult> {
        const n = this.helpers.resolveNpc(keeper);
        if (!n) return fail(`Vault keeper not found: ${describeTarget(keeper)}`, 'not_found', { keeper: null, items: [] });
        const before = this.helpers.state()?.vaultOpenedAt;
        if (before === undefined) return fail('This game client is too old to report the vault window: restart it with a quit action', 'unknown_action', { keeper: n, items: [] });
        const r = await this.interactWith(n, { range: INTERACT_APPROACH });
        // A keeper can speak first: Interact's ambient line goes out before the window (VaultKeeper.cs:66-78; Jarl Yuliwyf says one every time).
        const opened = r.response === 'vault' || (r.success && await this.helpers.waitFor(s => !!s.vaultOpenedAt && s.vaultOpenedAt !== before, 1500));
        if (!opened) return fail(r.success ? `${n.name} answered but no vault opened (${r.response})` : r.message, r.success ? 'not_a_vault_keeper' : r.reason ?? 'no_response', { keeper: n, items: [] });
        // Past max_items_per_packet (30) the rest comes in a second packet, with window 0 (PacketLib168.cs:1752-1763).
        await this.helpers.sleep(300);
        const items = this.sdk.getVault();
        return { success: true, message: `Opened ${n.name}'s vault (${items.length} items)`, keeper: n, items };
    }

    /**
     * Put a backpack item in the vault, at a vault keeper. Vaulted items don't wear, count toward no
     * weight and can't be sold by `sellItems`, but `repairAll` charges for them if they're worn. A stack goes
     * onto a partial stack first, and what doesn't fit stays in the backpack: check the count if that matters.
     * Reasons: `not_found`, `vault_full`, those of openVault, `timeout`.
     */
    async depositItem(keeper: NpcTarget, target: InventoryItem | NamePattern | number): Promise<ItemResult> {
        const item = this.helpers.resolveInventoryItem(target);
        if (!item) return fail(`Item not found: ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        const open = await this.openVault(keeper);
        if (!open.success) return fail(open.message, open.reason ?? 'no_response', { item, messages: [] });
        const merges = item.count > 1 && open.items.some(i => i.name === item.name);
        if (open.items.length >= VAULT_SLOTS && !merges) return fail(`The vault is full (${VAULT_SLOTS})`, 'vault_full', { item, messages: [] });
        return this.moveObserved(item, GENERAL_VAULT_SLOT, s => !s.inventory.some(i => i.slot === item.slot && i.name === item.name && i.count === item.count) && s.vault.some(i => i.name === item.name), `Put ${item.name} in the vault`);
    }

    /**
     * Take an item out of the vault into the backpack, at a vault keeper. A number is a vault slot
     * (110-149). A stack behaves as in depositItem. Reasons: `not_found`, `inventory_full`, those of openVault, `timeout`.
     */
    async withdrawItem(keeper: NpcTarget, target: InventoryItem | NamePattern | number): Promise<ItemResult> {
        const open = await this.openVault(keeper);
        if (!open.success) return fail(open.message, open.reason ?? 'no_response', { item: null, messages: [] });
        const item = typeof target === 'number' ? open.items.find(i => i.slot === target)
            : typeof target === 'string' || target instanceof RegExp ? bestNameMatch(open.items, target)
            : open.items.find(i => i.slot === target.slot && i.name === target.name) ?? open.items.find(i => i.name === target.name);
        if (!item) return fail(`Not in the vault: ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        const merges = item.count > 1 && this.sdk.getInventory().some(i => i.name === item.name);
        if (this.sdk.getFreeInventorySlots() <= 0 && !merges) return fail('Backpack is full', 'inventory_full', { item, messages: [] });
        return this.moveObserved(item, GENERAL_VAULT_SLOT, s => !s.vault.some(i => i.slot === item.slot && i.name === item.name && i.count === item.count) && s.inventory.some(i => i.name === item.name), `Took ${item.name} out of the vault`);
    }

    /**
     * Train a specialization: open the trainer window (falling back to '/train') and observe the spec level rise.
     * With a trainer of our class, it walks into reach and targets it first. With `null` it stays where it stands: the
     * server trains anywhere while allow_train_anywhere is on, as by default and here (train.cs:143), and with it off the
     * answer is `needs_trainer`. `specName` is any name of the line (sdk.findSpecialization); a name no line answers to
     * gives 'spec_not_found'.
     */
    async trainSpec(trainer: NpcTarget | null, specName: NamePattern, levels: number = 1): Promise<TrainResult> {
        const empty = { spec: null, fromLevel: 0, toLevel: 0, specPointsLeft: this.helpers.player()?.specPoints ?? 0 };
        const n = trainer === null ? null : this.helpers.resolveNpc(trainer);
        if (trainer !== null && !n) return fail(`Trainer not found: ${describeTarget(trainer)}`, 'not_found', empty);
        const spec0 = this.sdk.findSpecialization(specName);
        if (!spec0) return fail(`No specialization matching ${describeTarget(specName)} (known: ${this.sdk.getSkills().specializations.map(s => s.name).join(', ') || 'none'})`, 'spec_not_found', empty);
        const walk = n && await this.targetTrainer(n);
        if (walk) return fail(walk.message, walk.reason ?? 'out_of_reach', { ...empty, spec: spec0.name, fromLevel: spec0.level, toLevel: spec0.level });
        const watch = this.helpers.watch();
        try {
            const window0 = this.helpers.state()?.trainer.receivedAt;
            await this.sdk.sendOpenTrainer();
            // A new window, not one already open: a promotion sends none and moves the lines (GameTrainer.cs:333-365), so an old index raises another line.
            const win = await this.helpers.waitFor(s => {
                if (watch.find([TRAINER_WANTED])) return 'refused' as const;
                return s.trainer.isOpen && s.trainer.specs.length && s.trainer.receivedAt !== window0 ? s.trainer : null;
            }, 3000);
            const ts = win && win !== 'refused' ? bestNameMatch(win.specs, spec0.name) : null;
            // The new window's level, where it has one: the skill list can be stale (see trainBuild).
            const from = ts?.level ?? spec0.level;
            const target = from + Math.max(1, Math.floor(levels));
            const sentWindow = this.helpers.state()?.trainer.receivedAt;
            if (win !== 'refused') {
                if (ts) await this.sdk.sendTrainSpec(ts.index, target - ts.level);
                // /train takes a key prefix (train.cs:57-66): 'Light Magic' isn't one, 'Light' is.
                else await this.sdk.sendCommand(`/train ${specKey(spec0.name)} ${target}`);
            }
            // The raise shows in the window the server sends after it (train.cs:169-170), and in the skill list unless that
            // list already disagreed with the window: then the list is stale for this line and only windows count.
            const listStale = !!ts && ts.level !== spec0.level;
            const level = (s: BotWorldState) => {
                const shown = s.trainer.receivedAt !== sentWindow ? bestNameMatch(s.trainer.specs, spec0.name)?.level : undefined;
                const listed = listStale ? undefined : s.skills.specializations.find(x => x.name === spec0.name)?.level;
                return Math.max(shown ?? 0, listed ?? 0);
            };
            const got = await this.helpers.waitFor(s => {
                if (watch.find(TRAIN_REFUSALS)) return 'refused';
                return level(s) >= target ? 'trained' : null;
            }, 4000);
            const s1 = this.helpers.state();
            const extra = { spec: spec0.name, fromLevel: from, toLevel: s1 ? Math.max(from, level(s1)) : from, specPointsLeft: this.helpers.player()?.specPoints ?? 0 };
            if (got === 'trained') return { success: true, message: `Trained ${spec0.name} ${from} → ${extra.toLevel}`, ...extra };
            if (got !== 'refused') return fail(`No training observed for ${spec0.name}`, 'timeout', extra);
            const refusal = watch.findText(TRAIN_REFUSALS)!;
            return fail(refusal, !n && refusal.toLowerCase().includes(TRAINER_WANTED) ? 'needs_trainer' : 'refused', extra);
        } finally {
            watch.dispose();
        }
    }

    /**
     * Walk into reach of a trainer and target it. A respec goes by the target (respec.cs:62-67), and training too on a
     * server with allow_train_anywhere off (train.cs:143-150). Returns the walk when it failed.
     */
    private async targetTrainer(n: NearbyNpc): Promise<WalkToObjectResult | null> {
        if (n.distance > INTERACT_APPROACH) {
            const walk = await this.walkToObject(n, { range: INTERACT_APPROACH });
            if (!walk.success) return walk;
        }
        await this.sdk.sendSetTarget(n.objectId);
        await this.helpers.waitFor(s => s.player?.targetObjectId === n.objectId, 1500);
        return null;
    }

    /**
     * Talk to a trainer in reach, and give the points about a second to change. A promotion sends none (GameTrainer.cs:335-349)
     * and talking does (:134, GamePlayer.cs:4430), while the window that trainSpec asks for doesn't (PlayerTrainWindowHandler).
     */
    private async refreshSpecPoints(trainer: NpcTarget | null): Promise<void> {
        const n = trainer === null ? null : this.helpers.resolveNpc(trainer);
        if (!n || n.distance > INTERACT_APPROACH) return;
        const points0 = this.helpers.player()?.specPoints;
        const r = await this.sdk.sendInteract(n.objectId);
        if (r.success) await this.helpers.waitFor(s => s.player?.specPoints !== points0, 1000);
    }

    /**
     * Whether the lines' levels and the points left fit in what the class has earned by its level (VerifySpecPoints,
     * GamePlayer.cs:9949-9968), half level counted. A stale skill list after a GM's /player class shows levels the
     * server took back with the points still there, so it doesn't.
     */
    private specsAddUp(state: BuildState): boolean {
        const p = this.helpers.player();
        const cls = p && getClass(p.className, p.realm);
        if (!cls) return true;
        const free = freeLevels(state.level);
        const spent = state.specs.reduce((sum, s) => sum + specCost(1, s.level, state.autotrain?.includes(specKey(s.name)) ? free : 0), 0);
        return spent + state.points <= earnedSpecPoints(cls.specializationMultiplier, state.level, { halfLevel: true });
    }

    /** Ask for the trainer window where the character stands and give it 3 s to come; a server that wants a trainer sends none. */
    private async askTrainerWindow(since: number): Promise<void> {
        const watch = this.helpers.watch();
        try {
            await this.sdk.sendOpenTrainer();
            await this.helpers.waitFor(s => watch.find([TRAINER_WANTED]) || (s.trainer.receivedAt ?? 0) !== since, 3000);
        } finally {
            watch.dispose();
        }
    }

    /**
     * What the build rule reads. Autotrain is the current class's: a base class has none. A trainer window that came
     * after `windowSince` gives the levels: the skill list can be stale, and the window never is (see trainBuild).
     */
    private buildState(windowSince?: number): BuildState | null {
        const s = this.helpers.state();
        const p = s?.player;
        if (!p) return null;
        const fresh = windowSince !== undefined && (s.trainer.receivedAt ?? 0) !== windowSince ? s.trainer.specs : [];
        const specs = this.sdk.getSkills().specializations.map(x => {
            const shown = fresh.find(t => t.name === x.name);
            return shown && shown.level !== x.level ? { ...x, level: shown.level } : x;
        });
        return { level: p.level, specs, points: p.specPoints, autotrain: getClass(p.className, p.realm)?.autotrainSpecs };
    }

    /**
     * Spend the points on a build, as far as they reach: the rule in data/builds/rule.ts names each line and trainSpec
     * raises it, at a trainer of the class or, with `null`, where the character stands (trainSpec). Without `build` it is
     * the bot's own `bots/<bot>/build.ts` (loadBuild in sdk/build.ts), and a broken file throws. Success means it stopped
     * for a good reason: `done` (nothing to raise at this level) or `waiting` (the next line costs more than there is, and
     * the points stay banked for it). `done` sends nothing. Before `waiting` with nothing raised it talks once to a trainer
     * in reach, because a promotion sends no points and player.specPoints can still be the base class's number. A trainer
     * out of reach or not found gets nothing, and the number stands. A base class trains the lines it has of its advanced
     * class's build. After a GM's `/player class` the server's skill list keeps each line's old level for the session
     * (its cache swaps an entry only when Skill's ID-comparing `!=` says so, GamePlayerUtils.cs:650), while the trainer
     * window is right: so a window that came during this call gives the levels, and trainSpec counts a raise by it. It
     * asks for one before its first raise, and before stopping when the levels and points cost more than the class has
     * earned (specsAddUp); otherwise `done` and `waiting` send nothing. A relog clears the old levels. Reasons:
     * `no_build`, `invalid_build` (buildProblems of a build passed in), `wrong_class`,
     * `not_in_game`, `too_many_steps`, and those of trainSpec.
     */
    async trainBuild(trainer: NpcTarget | null, build?: Build): Promise<TrainBuildResult> {
        const nothing = { build: null, trained: [], waiting: null, done: false, over: [], specPointsLeft: this.helpers.player()?.specPoints ?? 0 };
        const bot = this.sdk.config.botUsername;
        const chosen = build ?? await loadBuild(bot);
        if (!chosen) {
            const folder = botFolder(bot);
            return fail(`${bot} has no bots/${folder}/build.ts: bun bots/choose-build.ts ${folder} lists the builds of its class`, 'no_build', nothing);
        }
        const named = { ...nothing, build: chosen.name };
        const player = this.helpers.player();
        const problems = buildProblems(chosen, player?.realm);
        if (problems.length) return fail(`${chosen.name}: ${problems.join(' ')}`, 'invalid_build', named);
        if (!player) return fail('Not in game', 'not_in_game', named);
        // By id: a female character's className can be a name of its own, and two realms share "Rogue".
        const wanted = getClass(chosen.className, player.realm) ?? getClass(chosen.className)!;
        const mine = getClass(player.className, player.realm);
        if (mine?.id !== wanted.id && mine?.id !== wanted.baseClassId) return fail(`${chosen.name} is a build for ${wanted.name}, this character is a ${player.className}`, 'wrong_class', named);

        const trained: TrainBuildResult['trained'] = [];
        const raised = () => trained.map(t => `${t.spec} ${t.fromLevel} → ${t.toLevel}`).join(', ');
        const failed = (message: string, reason: string, state: BuildState | null) => fail(trained.length ? `${raised()}, then: ${message}` : message, reason, {
            ...named, trained, over: state ? linesOverTarget(chosen, state) : [], specPointsLeft: state?.points ?? 0,
        });
        let refreshed = false;
        let asked = false;
        const windowSince = this.helpers.state()?.trainer.receivedAt ?? 0;
        for (let i = 0; i < TRAIN_BUILD_MAX_STEPS; i++) {
            const state = this.buildState(windowSince);
            if (!state) return failed('Not in game', 'not_in_game', null);
            const step = nextBuildStep(chosen, state);
            // Before the first raise, the window's levels, so that the step and trainSpec count from the same ones. Before
            // stopping, too, when the levels and points cost more than the class has earned: they can't be the server's.
            if (!asked && (this.helpers.state()?.trainer.receivedAt ?? 0) === windowSince && (step.kind === 'train' || !this.specsAddUp(state))) {
                asked = true;
                await this.askTrainerWindow(windowSince);
                i--; // Once only, and no step.
                continue;
            }
            if (step.kind === 'wait' && !trained.length && !refreshed) {
                refreshed = true;
                await this.refreshSpecPoints(trainer);
                continue;
            }
            if (step.kind !== 'train') {
                const over = linesOverTarget(chosen, state);
                const stopped = step.kind === 'wait' ? `saving for ${step.spec} ${step.from + 1}: ${step.points}/${step.cost} points` : `on target for level ${state.level}`;
                const said = trained.length ? `${raised()}, ${stopped}` : stopped[0]!.toUpperCase() + stopped.slice(1);
                return {
                    success: true,
                    message: over.length ? `${said}. Over target: ${over.map(o => `${o.spec} ${o.level} (target ${o.target})`).join(', ')}` : said,
                    ...named, trained, over, specPointsLeft: state.points,
                    waiting: step.kind === 'wait' ? { spec: step.spec, cost: step.cost, points: step.points } : null,
                    done: step.kind === 'done',
                };
            }
            const r = await this.trainSpec(trainer, step.spec, step.to - step.from);
            if (r.toLevel > r.fromLevel) trained.push({ spec: step.spec, fromLevel: r.fromLevel, toLevel: r.toLevel });
            if (!r.success) return failed(r.message, r.reason ?? 'refused', this.buildState(windowSince));
        }
        return failed(`Still training after ${TRAIN_BUILD_MAX_STEPS} steps`, 'too_many_steps', this.buildState(windowSince));
    }

    /**
     * Take the points back out of every line, or with `line` (any of its names) out of that one, at a trainer of the
     * class: sends /respec, says yes to the server's box and watches the points come back. It is free, at any level and
     * any number of times, because the stone check can never hold (respec.cs:96, 153 test TimeSpan.Hours > 24). A line
     * falls to 1, an autotrain line to its free levels. A respec ends the character's own buffs and kills its pet
     * (respec.cs:247). Reasons: `not_found` (trainer), `spec_not_found`, `no_need` (nothing trained above that floor;
     * nothing is sent), `refused` (the server's words in `message`), `timeout`, `not_in_game`, and those of the walk there.
     */
    async respec(trainer: NpcTarget, line?: NamePattern): Promise<RespecResult> {
        const report = (regained = 0) => ({
            regained,
            specPointsLeft: this.helpers.player()?.specPoints ?? 0,
            specs: this.sdk.getSkills().specializations.map(s => ({ name: s.name, level: s.level })),
        });
        const state0 = this.buildState();
        if (!state0) return fail('Not in game', 'not_in_game', report());
        const n = this.helpers.resolveNpc(trainer);
        if (!n) return fail(`Trainer not found: ${describeTarget(trainer)}`, 'not_found', report());
        const spec = line === undefined ? null : this.sdk.findSpecialization(line);
        if (line !== undefined && !spec) return fail(`No specialization matching ${describeTarget(line)} (known: ${report().specs.map(s => s.name).join(', ') || 'none'})`, 'spec_not_found', report());
        // RespecSingleLine's floor (GamePlayer.cs:3052-3056); points only come back from above it.
        const floor = (name: string) => state0.autotrain?.includes(specKey(name)) ? freeLevels(state0.level) : 1;
        const lines0 = this.sdk.getSkills().specializations;
        if (!(spec ? [spec] : lines0).some(s => s.level > floor(s.name))) return fail(spec ? `${spec.name} has nothing trained to give back` : 'No line has anything trained to give back', 'no_need', report());
        const walk = await this.targetTrainer(n);
        if (walk) return fail(walk.message, walk.reason ?? 'out_of_reach', report());

        const before = this.helpers.state();
        const points0 = before?.player?.specPoints ?? 0;
        const box0 = before?.dialog?.receivedAt;
        const window0 = before?.trainer.receivedAt;
        const watch = this.helpers.watch();
        try {
            // Left open by a run that was cut off: a no, so that our yes goes to our own box. A no doesn't clear what that box
            // was for (respec.cs:188): if it was /respec all, our yes runs that too, seen live. `message` and `specs` show what fell.
            if (before?.dialog?.isOpen && RESPEC_OFFER.test(before.dialog.text)) await this.sdk.sendRespondDialog(false);
            // By KeyName: GetSpecializationByName takes no other name (GamePlayer.cs:3102).
            const sent = await this.sdk.sendCommand(spec ? `/respec ${specKey(spec.name)}` : '/respec all');
            if (!sent.success) return fail(sent.message, sent.reason ?? 'dispatch_failed', report());
            const box = await this.helpers.waitFor(s => {
                if (watch.find(RESPEC_REFUSALS)) return 'refused' as const;
                // The last box stays in the state, closed, and another may be open: only a new one that names a respec.
                return s.dialog?.isOpen && s.dialog.receivedAt !== box0 && RESPEC_OFFER.test(s.dialog.text) ? s.dialog : null;
            }, 3000);
            if (box === 'refused') return fail(watch.findText(RESPEC_REFUSALS)!, 'refused', report());
            if (!box) return fail(`${n.name} offered no respec`, 'timeout', report());
            const yes = await this.sdk.sendRespondDialog(true);
            if (!yes.success) return fail(yes.message, yes.reason ?? 'dispatch_failed', report());
            const back = await this.helpers.waitFor(s => (s.player?.specPoints ?? 0) > points0, 4000);
            if (!back) return fail(`Said yes to ${n.name}, but no points came back`, 'timeout', report());
            // The window comes after the points (respec.cs:239-241), and trainSpec counts levels from it.
            await this.helpers.waitFor(s => s.trainer.receivedAt !== window0, 1000);
            const result = report((this.helpers.player()?.specPoints ?? 0) - points0);
            const lowered = lines0.flatMap(s => {
                const now = result.specs.find(x => x.name === s.name);
                return now && now.level !== s.level ? [`${s.name} ${s.level} → ${now.level}`] : [];
            });
            return { success: true, message: `Regained ${result.regained} points${lowered.length ? `: ${lowered.join(', ')}` : ''}`, ...result };
        } finally {
            watch.dispose();
        }
    }

    // ============ Travel / data ============

    /** Nearest static spawn (DB `mob` table) in our region matching a name, or null. */
    findNpcSpawn(pattern: NamePattern, options: { regionId?: number; guild?: NamePattern } = {}): NpcSpawnMatch | null {
        const p = this.helpers.player();
        const regionId = options.regionId ?? p?.regionId;
        return findNpcSpawns({ name: pattern, guild: options.guild, regionId, near: p ? { x: p.x, y: p.y } : undefined, limit: 1 })[0] ?? null;
    }

    /** Walk (same region, through walkTo: navmesh route when built, else a straight line) to a named spawn from static data or to a point. */
    async travelTo(destination: NamePattern | (Point & { regionId?: number }), options: WalkOptions = {}): Promise<TravelResult> {
        const p = this.helpers.player();
        if (!p) return { ...fail('Not in game', 'not_in_game', {}), position: null, distance: Infinity, reissues: 0, spawn: null };
        if (typeof destination === 'string' || destination instanceof RegExp) {
            const spawn = this.findNpcSpawn(destination);
            if (!spawn) return { ...fail(`No spawn matching ${describeTarget(destination)} in region ${p.regionId}`, 'not_found', {}), position: this.position(), distance: Infinity, reissues: 0, spawn: null };
            const walk = await this.walkTo(spawn.x, spawn.y, { tolerance: 200, z: spawn.z, ...options });
            return { ...walk, message: walk.success ? `Arrived at ${spawn.name}` : walk.message, spawn };
        }
        if (destination.regionId !== undefined && destination.regionId !== p.regionId) {
            return { ...fail(`Destination is in region ${destination.regionId}, we are in ${p.regionId}`, 'other_region', {}), position: this.position(), distance: Infinity, reissues: 0, spawn: null };
        }
        return { ...(await this.walkTo(destination.x, destination.y, { z: destination.z, ...options })), spawn: null };
    }

    /**
     * Use a zone point, by its id or as static data (getZonePointsFrom): walk to its source when
     * farther than `tolerance`, send 0x90 and watch for the jump. Reasons: 'not_found' (no such id),
     * 'wrong_region', 'wrong_realm', 'refused' (a server message said so), 'timeout' (no jump and
     * no word: the server ignores a request it won't take, RegionChangeRequestHandler.cs:41-45),
     * 'dead', and the walk's own ('stuck', 'died', ...).
     *
     * The server checks no distance (the handler reads only the id), so the walk is ours: a real
     * client asks when it steps on the zone point, and a walk that stopped within 400 still asks.
     * The realm is the zone point's in the DB, as for a PrivLevel-1 account (:33-37), and an id with
     * a row per realm means our realm's row. The one other rule (:28, Trials of Atlantis regions go
     * by the zone's realm) has no zone point in the dump. In shade a zone change costs health: PlayerState.isShade; releasePet first.
     */
    async useZonePoint(target: number | ZonePoint, options: UseZonePointOptions = {}): Promise<ZonePointResult> {
        const zonePoint = typeof target === 'number' ? getZonePoint(target, this.helpers.player()?.realm) ?? null : target;
        const where = (messages: string[] = []) => ({ zonePoint, regionId: this.helpers.player()?.regionId ?? null, position: this.position(), messages });
        if (!zonePoint) return fail(`No zone point with id ${String(target)}`, 'not_found', where());
        const p = this.helpers.player();
        if (!p) return fail('Not in game', 'not_in_game', where());
        if (p.isDead) return fail('Cannot use a zone point while dead', 'dead', where());
        const { id, sourceRegion, sourceX, sourceY, sourceZ, targetRegion, targetX, targetY, realm } = zonePoint;
        if (p.regionId !== sourceRegion) return fail(`Zone point ${id} is in region ${sourceRegion}, we are in ${p.regionId}`, 'wrong_region', where());
        if (realm !== 0 && realm !== realmId(p.realm)) return fail(`Zone point ${id} is for realm ${realm}, we are ${p.realm}`, 'wrong_realm', where());

        const tolerance = options.tolerance ?? 200;
        // The session can go during the walk (a relogin starts with no player, client.ts:218): then the walk's reason stands.
        const away = () => { const q = this.helpers.player(); return q ? Math.hypot(q.x - sourceX, q.y - sourceY) : Infinity; };
        if (away() > tolerance) {
            const walk = await this.walkTo(sourceX, sourceY, { z: sourceZ, tolerance });
            const stopped = walk.reason === 'died' || walk.reason === 'region_changed' || away() > ZONE_POINT_RANGE;
            if (!walk.success && stopped) return fail(`Walk to zone point ${id}: ${walk.message}`, walk.reason ?? 'stuck', where());
        }

        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendRegionChangeRequest(id);
            if (!r.success) return fail(r.message, r.reason ?? 'dispatch_failed', where());
            // Done once the client is back in the game: other actions are refused during its region change.
            const outcome = await this.helpers.waitFor(s => {
                if (watch.find(ZONE_POINT_REFUSALS)) return 'refused';
                const q = s.player;
                // One zone point in the dump stays in its region: the jump shows at the target.
                return s.inGame && q && (q.regionId !== sourceRegion || Math.hypot(q.x - targetX, q.y - targetY) < 500) ? 'jumped' : null;
            }, options.timeout ?? 20_000);
            const messages = watch.messages().map(m => m.text);
            if (outcome === 'refused') return fail(watch.findText(ZONE_POINT_REFUSALS)!, 'refused', where(messages));
            if (!outcome) return fail(`No jump after asking for zone point ${id} (to region ${targetRegion}), and no answer from the server`, 'timeout', where(messages));
            return { success: true, message: `Zone point ${id}: now in region ${this.helpers.player()!.regionId}`, ...where(messages) };
        } finally {
            watch.dispose();
        }
    }

    // ============ Social ============

    /**
     * Say text (chunked) and observe our echo. Spaces calls SAY_SPACING_MS apart: the server
     * drops a say < 500 ms after the last accepted one with "Slow down! Think before you say
     * each word!" (commands/playercommands/say.cs:49-53); that answer retries once, then
     * fails with 'rate_limited'.
     */
    async say(text: string): Promise<ChatResult> {
        for (let attempt = 0; ; attempt++) {
            const wait = this.lastSayAt + SAY_SPACING_MS - Date.now();
            if (wait > 0) await this.helpers.sleep(wait);
            const watch = this.helpers.watch();
            try {
                const results = await this.sdk.say(text);
                this.lastSayAt = Date.now();
                const bad = results.find(r => !r.success);
                if (bad) return { ...bad, echoed: false };
                const answer = await this.helpers.waitFor(() => watch.find([/^you say,/i, WHISPER_RATE_LIMIT]), 3000);
                if (answer && WHISPER_RATE_LIMIT.test(answer.text)) {
                    // Another script spoke just now. Resend only a single line: resending several
                    // chunks would repeat the ones that got through.
                    if (attempt === 0 && results.length <= 1) continue;
                    return { ...fail(answer.text, 'rate_limited', {}), echoed: false };
                }
                return { success: true, message: answer ? 'Said' : 'Said (no echo seen)', echoed: !!answer };
            } finally {
                watch.dispose();
            }
        }
    }

    /** Private message a player ('/send'); fails on "not online"-style answers. */
    async send(to: string, text: string): Promise<ChatResult> {
        for (let attempt = 0; ; attempt++) {
            const watch = this.helpers.watch();
            try {
                const results = await this.sdk.send(to, text);
                const bad = results.find(r => !r.success);
                if (bad) return { ...bad, echoed: false };
                // Social.SendMessage.* in language/EN/Social.txt
                const answer = await this.helpers.waitFor(() => watch.find([/^you send,/i, /is not in the game|not a unique character name|can't message yourself|slow down, you're typing/i]), 3000);
                if (answer && /slow down/i.test(answer.text) && attempt === 0) {
                    await this.helpers.sleep(1600);
                    continue;
                }
                if (answer && !/^you send,/i.test(answer.text)) return { ...fail(answer.text, /slow down/i.test(answer.text) ? 'rate_limited' : 'refused', {}), echoed: false };
                return { success: true, message: answer ? `Sent to ${to}` : `Sent to ${to} (no echo seen)`, echoed: !!answer };
            } finally {
                watch.dispose();
            }
        }
    }

    /** Group chat; fails with 'not_grouped' when the server says we are not in a group. */
    async groupSay(text: string): Promise<ChatResult> {
        // Our own group list can trail the invite by a moment; the server's answer decides.
        if (this.sdk.getGroup().length === 0) await this.helpers.waitFor(s => s.group.length > 0, 1500);
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendGroupSay(text);
            if (!r.success) return { ...r, echoed: false };
            // GCommandHandler (commands/playercommands/group.cs)
            const answer = await this.helpers.waitFor(() => watch.find([/you are not part of a group/i, /slow down! think before/i, text.trim().slice(0, 40).toLowerCase()]), 3000);
            if (answer && /you are not part of a group/i.test(answer.text)) return { ...fail('Not in a group', 'not_grouped', {}), echoed: false };
            if (answer && /slow down! think before/i.test(answer.text)) return { ...fail(answer.text, 'rate_limited', {}), echoed: false };
            return { success: true, message: answer ? 'Group message sent' : 'Group message sent (no echo seen)', echoed: !!answer };
        } finally {
            watch.dispose();
        }
    }

    /** Invite a player to our group ('/invite name'). */
    async invite(player: string): Promise<ActionResult> {
        const watch = this.helpers.watch();
        try {
            await this.sdk.sendCommand(`/invite ${player}`);
            const m = await this.helpers.waitFor(() => watch.find([/you have invited|added .* to your group/i, /not (the )?leader|no players online|can't invite|still in a group|not selected a valid/i]), 3000);
            if (!m) return fail('No answer to the invite', 'no_response', {});
            return /you have invited|added/i.test(m.text) ? { success: true, message: m.text } : fail(m.text, 'refused', {});
        } finally {
            watch.dispose();
        }
    }

    /** Wait for a group invite dialog, accept it and observe group membership. */
    async acceptGroupInvite(options: { timeout?: number } = {}): Promise<GroupResult> {
        const box = await this.helpers.waitFor(s => s.dialog?.isOpen && (s.dialog.code === GROUP_INVITE_DIALOG || /invited you to join/i.test(s.dialog.text)) ? s.dialog : null, options.timeout ?? 30_000);
        if (!box) return fail('No group invite arrived', 'timeout', { group: [] });
        const r = await this.sdk.sendRespondDialog(true);
        if (!r.success) return { ...r, group: [] };
        const group = await this.helpers.waitFor(s => s.group.length > 0 ? s.group : null, 5000);
        return group ? { success: true, message: `Joined group (${group.map(g => g.name).join(', ')})`, group } : fail('Accepted, but no group membership observed', 'timeout', { group: [] });
    }

    /**
     * Trade with a player. With `give` or `money` this walks up and offers them first (the partner must be
     * in view; a string must be its exact name, and a pattern is refused); without, it only waits for that
     * player's window, and closes one that holds anything of ours. Then it accepts every new offer until the
     * server commits, and reads the outcome from the backpack. Both sides call this, in any order, and must
     * stay within 128 units. An add that opens a window waits for this side's slot on the clock, up to 750 ms. Between hunts only: a second controller aborts a group run. Afterwards, or after
     * an abort, no window of ours stays open, and when a failure returns the close has been seen.
     * Reasons: those of offerTrade and acceptTrade.
     */
    async trade(partner: PlayerTarget, options: TradeOptions = {}): Promise<TradeResult> {
        const deadline = Date.now() + (options.timeout ?? TRADE_TIMEOUT_MS);
        const watch = this.helpers.watch();
        const before = this.sdk.getInventory();
        this.lastOffer = null;
        try {
            if (!options.give?.length && (options.money ?? 0) === 0) {
                const matches = this.tradePartnerMatcher(partner);
                if (!matches) {
                    if (this.sdk.getTrade()) await this.closeTrade();
                    return noTrade(`Player not found: ${describeTarget(partner)}`, 'not_found', null, watch.messages());
                }
                return await this.settleTrade(matches, options.accept, watch, before, deadline, null, NOTHING_OF_OURS);
            }
            const offer = await this.offerOnWatch(partner, options, watch, deadline);
            if (!offer.success) return noTrade(offer.message, offer.reason ?? 'refused', offer.partner?.name ?? null, offer.messages, offer.refused);
            const name = offer.partner!.name;
            return await this.settleTrade(n => n === name, options.accept, watch, before, deadline, offer.trade, offer.trade);
        } finally {
            watch.dispose();
        }
    }

    /**
     * Put `give` and `money` on our side of a window with a player and leave it open for acceptTrade. The
     * offer describes our whole side: a window that holds anything else of ours is closed first. Evidence is
     * the server's 0xEA, because items stay in the backpack until the commit. On any failure the window is
     * closed. Reasons: not_in_game, dead, bad_args (also a pattern as the partner), not_found, too_many_items,
     * insufficient_funds, timeout, out_of_reach (or the walk's reason), out_of_range, busy, wrong_realm, refused,
     * empty_slot, no_response, cancelled, wrong_partner, trade_accepted.
     */
    async offerTrade(partner: PlayerTarget, options: TradeOfferOptions): Promise<TradeOfferResult> {
        const watch = this.helpers.watch();
        this.lastOffer = null;
        try {
            const offer = await this.offerOnWatch(partner, options, watch, Date.now() + (options.timeout ?? TRADE_TIMEOUT_MS));
            if (offer.success) this.lastOffer = offer.trade;
            return offer;
        } finally {
            watch.dispose();
        }
    }

    /**
     * Finish the window of this bot's offerTrade, or else whatever window opens: accept each new offer until
     * the server commits. After an offerTrade it is that window or nothing: one closed since is cancelled at
     * once, and our side must still be what we offered. Without one, in a new script say, it takes a window as
     * it stands, our side included. Afterwards, or after an abort, no window of ours stays open, and when a
     * failure returns the close has been seen. Reasons: timeout (no window), offer_rejected (`accept` never said
     * yes), offer_changed (it said no after a yes, or our side changed), partner_no_accept, cancelled (a partner's
     * cancel and a range close alike: the server gives no cause), inventory_full, partner_inventory_full,
     * insufficient_funds, partner_insufficient_funds, item_missing, not_found (`from` names nobody in view),
     * not_in_game, unknown_action (the client runs older code).
     */
    async acceptTrade(options: AcceptTradeOptions = {}): Promise<TradeResult> {
        const deadline = Date.now() + (options.timeout ?? TRADE_TIMEOUT_MS);
        const watch = this.helpers.watch();
        const before = this.sdk.getInventory();
        const offered = this.lastOffer;
        this.lastOffer = null;
        try {
            const matches = options.from === undefined ? () => true : this.tradePartnerMatcher(options.from);
            if (!matches) {
                if (this.sdk.getTrade()) await this.closeTrade();
                return noTrade(`Player not found: ${describeTarget(options.from)}`, 'not_found', null, watch.messages());
            }
            return await this.settleTrade(matches, options.accept, watch, before, deadline, offered, offered);
        } finally {
            watch.dispose();
        }
    }

    /** Close the trade window and observe it gone. Also cures a window the server holds but never told us about, so no window at all is a success. Reasons: timeout, already_completed. */
    async cancelTrade(): Promise<ActionResult> {
        const watch = this.helpers.watch();
        this.lastOffer = null;
        try {
            const r = await this.sdk.sendTradeCancel();
            if (!r.success) return r;
            const closed = await this.helpers.waitFor(s => !s.trade, TRADE_CLOSE_MS);
            const completed = watch.findText([TRADE_COMPLETED]);
            if (completed) return fail(completed, 'already_completed', {});
            return closed ? { success: true, message: 'Trade closed' } : fail('The trade window is still open', 'timeout', {});
        } finally {
            watch.dispose();
        }
    }

    /**
     * Follow a player client-side (OpenDAoC has no /follow or /stick; the
     * retail client does it locally): keep within `distance` until `until`,
     * the duration ends, or the player is lost for 5 s.
     */
    async follow(player: PlayerTarget, options: FollowOptions = {}): Promise<FollowResult> {
        const started = Date.now();
        const distance = options.distance ?? 150;
        const first = this.helpers.resolvePlayer(player);
        if (!first) return fail(`Player not found: ${describeTarget(player)}`, 'not_found', { durationMs: 0, target: null });
        const id = first.objectId;
        let last: NearbyPlayer = first;
        let lostSince = 0;
        let lastDest: Point | null = null;
        const done = (success: boolean, message: string, reason?: string): FollowResult => ({ success, message, reason, durationMs: Date.now() - started, target: last });
        try {
            return await withExecutionDeadline(options.durationMs ?? 60_000, async () => {
                for (;;) {
                    const s = await this.helpers.nextState(1000);
                    if (!s?.player) return done(false, 'Lost game state', 'not_in_game');
                    if (s.player.isDead) return done(false, 'Died while following', 'died');
                    if (options.until?.(s)) return done(true, `Stopped following ${last.name}: condition met`);
                    const t = s.nearbyPlayers.find(p => p.objectId === id);
                    if (!t) {
                        lostSince ||= Date.now();
                        if (Date.now() - lostSince > 5000) return done(false, `Lost sight of ${last.name}`, 'lost_target');
                        continue;
                    }
                    lostSince = 0;
                    last = t;
                    if (t.distance2d > distance) {
                        const moved = !lastDest || Math.hypot(t.x - lastDest.x, t.y - lastDest.y) > 40;
                        if (moved || !s.movement.moving) {
                            lastDest = { x: t.x, y: t.y, z: t.z };
                            await this.sdk.sendMoveTo(t.x, t.y, t.z, { tolerance: Math.max(20, distance * 0.6) });
                        }
                    }
                }
            }, () => done(true, `Followed ${last.name} for ${options.durationMs ?? 60_000}ms`));
        } finally {
            // lastDest: a move was dispatched, even if no snapshot shows it moving yet.
            if (lastDest || this.sdk.getMovement()?.moving) await this.helpers.cleanup(() => this.sdk.sendStop());
        }
    }

    // ============ Grinding ============

    /**
     * Hunt around an anchor: pick a killable target (attackers first), kill,
     * loot, rest when low, walk back when drifted. Stops on death unless
     * `respawn` is set, and with stopReason 'no_targets' after
     * `noTargetTimeoutMs` (default 60 s) without any candidate. With `pet`, or in shade,
     * a window pet fights: see GrindOptions, and GrindPetOptions for reason not_supported. Other
     * errors keep their own reason. A kill that fails at once waits 1 s before the next pass, so no refusal can spin. With no pet plan and no melee weapon the first target ends the run: stopReason 'error', reason 'refused', and no order goes to a pet that is up: the message says to pass `pet: true`.
     * A mob of a fight of ours that dies while a pass looks elsewhere, the pet's kill while we swing at another, counts, with its killLog entry and onKill, at xp 0: the XP goes to the run's total. `failures` counts a lost pet once, lost between two passes too: the owner's death and a shade's wait for its icon to go are none.
     * Started on a corpse: reason 'dead', stopReason 'error', with nothing sent, as summonPet, castSpell and rest answer. With `respawn` it releases and goes on, and says so in the message; that death came before the run, and isn't in `deaths`.
     */
    async grind(options: GrindOptions = {}): Promise<GrindResult> {
        const started = Date.now();
        const p0 = this.helpers.player();
        const stats: GrindStats = { kills: 0, xpGained: 0, deaths: 0 };
        const result: GrindResult = {
            success: false, message: '', kills: 0, failures: 0, deaths: 0, xpGained: 0, rpGained: 0, moneyGained: 0,
            levelsGained: 0, durationMs: 0, stopReason: 'duration', killLog: [],
        };
        if (!p0) return { ...result, message: 'Not in game', reason: 'not_in_game', stopReason: 'error' };
        const anchor = options.anchor ?? { x: p0.x, y: p0.y, z: p0.z };
        const radius = options.radius ?? 2000;
        const duration = options.durationMs ?? 180_000;
        const deadline = started + duration;
        const restBelow = options.restBelowHealth ?? 50;
        const restTo = options.restToHealth ?? 90;
        const avoid = new Map<number, number>();
        const noTargetTimeout = options.noTargetTimeoutMs ?? 60_000;
        const planOf = (o: GrindPetOptions) => {
            const petRestBelow = o.restBelowPetHealth ?? 50;
            return { spell: o.spell, fight: o.fight ?? 'pet', resummon: o.resummon ?? true, restBelow: petRestBelow, restTo: Math.max(o.restToPetHealth ?? 90, petRestBelow) };
        };
        let petPlan = options.pet ? planOf(options.pet === true ? {} : options.pet) : null;
        let summonedYet = !!this.sdk.getPetState();
        let summonRetryAt = 0;
        let summonFailures = 0;
        // What a recast holds back: its name, and when it is over.
        let summonWait: { name: string; until: number; mustWait: boolean } | null = null;
        // The last try that failed for anything else, until one goes, for the end note: with the power it had then, and whether a rest went for it.
        let summonFailed: { message: string; reason: string | undefined; spell: Spell | null; mana: number; rested: boolean } | null = null;
        const lossAtStart = this.helpers.state()?.lastPetLoss?.at;
        // The last loss a pass or the loop head has looked at.
        let lossSeen = lossAtStart;
        // The last one failures has counted: however many passes hear of it, it is one.
        let lossCounted = lossAtStart;
        // As it read before the last look: the shade's icon goes a tick or two after the servant (EffectListComponent.cs:914-921).
        let shadeBefore = !!p0.isShade;
        // A new pet the last pass of the run hasn't sent yet, at a mob on us.
        let newPetPass = false;
        // The mob a pass just ended at as it arrived. It swings at a new pet in passing and reads on that until its next swing, still running at us: for the next pass it is on us.
        let cameOn: number | null = null;
        // A mob on us we are letting come, since when it has read no speed.
        let standing = null as { id: number; since: number } | null;
        // On a corpse from before the run, with `respawn`: that death isn't this run's.
        let corpseAtStart = p0.isDead;
        // The fight the last lost pet went down in. Engaged: it read as on the pet or on us at the loss, so it is coming; a pet lost on its way hasn't drawn it.
        let lostWith: { objectId: number; name: string; baseline: number; healthPercent: number; shade: boolean; engaged: boolean } | null = null;
        let idleSince: number | null = null;
        let endNote = '';
        const diedSince = (s: BotWorldState | null, id: number, baseline: number): boolean => !!s?.combatEvents.some(e => e.id > baseline && e.kind === 'death' && e.targetObjectId === id);
        // A fight's mob while the fight stands: alive and near. The server gives a dead mob's id to the next object it adds (Region.cs:955, :779), so a death since and another name both end one.
        const standingMob = (s: BotWorldState | null, id: number, fight: { name: string; baseline: number }): NearbyNpc | null => {
            const n = s?.nearbyNpcs.find(x => x.objectId === id);
            return n && !diedSince(s, id, fight.baseline) && n.name === fight.name && n.distance <= GRIND_FOE_RANGE ? n : null;
        };
        const finish = (stopReason: GrindResult['stopReason'], message?: string, reason?: string): GrindResult => {
            const s = this.helpers.state();
            const p = s?.player;
            result.durationMs = Date.now() - started;
            result.stopReason = stopReason;
            result.deaths = stats.deaths;
            if (p) {
                result.xpGained = Math.max(stats.xpGained, p.experience - p0.experience);
                result.rpGained = p.realmPoints - p0.realmPoints;
                result.moneyGained = p.money.totalCopper - p0.money.totalCopper;
                result.levelsGained = p.level - p0.level;
            }
            result.success = stopReason !== 'error' && stopReason !== 'died' && result.kills > 0;
            const lost = lostWith;
            const left = lost && p ? standingMob(s, lost.objectId, lost) : null;
            const loss = s?.lastPetLoss && s.lastPetLoss.at !== lossAtStart ? s.lastPetLoss : null;
            if (loss) result.lastPetLoss = { ...loss, mob: left ? { objectId: left.objectId, name: left.name, healthPercent: lost!.healthPercent } : null };
            const lossNote = (): string => {
                if (!left) return '';
                // A tether's cut reads as a release (petFight), so that isn't called a death.
                const how = loss?.cause === 'released' ? 'we lost our pet' : 'our pet died';
                const at = `${nameOf(left)} at ${lost!.healthPercent} %`;
                // It is us it has come for by now. A pet that went with us didn't go first.
                if (stopReason === 'died' || p!.isDead) return loss?.cause === 'owner_died' ? '' : `; ${how} first, with ${at}`;
                const onUs = left.targetObjectId === p!.objectId;
                // With a new pet on it nothing is coming yet.
                if (s?.pet && !onUs) return '';
                // The overrun can have held the run for 30 s since, and beside us our health is melee's by then, not a shade's cut.
                const beside = onUs && left.distance <= MELEE_REACH;
                const cost = lost!.shade && !(beside && Date.now() - (loss?.at ?? 0) > HIT_INTERRUPT_MS) ? `: we are at ${p!.healthPercent} % health` : '';
                if (beside) return `; ${how} with ${at}, and it is on us at ${left.healthPercent} %${cost}`;
                return onUs || lost!.engaged ? `; ${how} with ${nameOf(left)} at ${left.healthPercent} %, and it is coming for us${cost}` : `; we lost our pet on its way to ${nameOf(left)}${cost}`;
            };
            const fighting = stopReason === 'duration' && p && !p.isDead ? this.helpers.attackers(s).sort((a, b) => a.distance - b.distance)[0] : undefined;
            if (fighting) result.stillFighting = { objectId: fighting.objectId, name: nameOf(fighting), healthPercent: fighting.healthPercent };
            const fightNote = fighting && fighting.objectId !== left?.objectId ? `; still fighting ${nameOf(fighting)} at ${fighting.healthPercent} %` : '';
            const held = summonWait && !s?.pet ? summonWait.until - Date.now() : 0;
            const waitNote = held > 0 ? `; waiting on ${summonWait!.name} (${Math.ceil(held / 1000)}s)` : '';
            const failed = s?.pet || !p ? null : summonFailed;
            const summonNote = !failed ? '' : failed.reason === 'no_power' ? `; no pet: ${this.shortOfPower(failed.spell, p!, failed.mana, failed.rested && stopReason === 'duration')}` : `; could not summon: ${failed.message}`;
            const petNow = petPlan ? this.sdk.getPet() : null;
            const restNote = petNow && petNow.objectId === this.restingPet && petNow.healthPercent < petPlan!.restTo ? `; resting our pet (${petNow.healthPercent} %, to ${petPlan!.restTo} %)`
                // A run short of time stops before the gate is looked at, and a call-off has said it.
                : petNow && petNow.healthPercent < petPlan!.restBelow && !result.calledOff ? `; our pet at ${petNow.healthPercent} %` : '';
            result.message = message !== undefined
                ? `${message}${lossNote()}`
                : `${result.kills} kills, +${result.xpGained} xp, ${stats.deaths} deaths in ${Math.round(result.durationMs / 1000)}s (${stopReason})${endNote}${lossNote()}${fightNote}${summonNote}${restNote}${waitNote}`;
            if (!result.success) result.reason = reason ?? (stopReason === 'died' || stopReason === 'no_targets' ? stopReason : result.kills === 0 ? 'no_kills' : stopReason);
            return result;
        };
        // As summonPet, castSpell and rest answer. With `respawn` that is what was asked for, and the loop's first look releases it.
        if (p0.isDead && !options.respawn) return finish('error', 'We are dead', 'dead');
        if (petPlan) {
            const refusal = this.grindPetRefusal(petPlan.spell);
            if (refusal) return finish('error', refusal.message, refusal.reason);
        }

        // Pulling a new target needs about one kill's time; a fight in progress at the
        // deadline may run this much past it before killNpc gives up, a pet's fight too.
        const FIGHT_OVERRUN_MS = 30_000;
        let fightEnd = deadline + FIGHT_OVERRUN_MS;
        let finishing = false;
        // Capped at half the run so a short grind still fights.
        const minEngage = (): number => options.minEngageMs
            ?? Math.min(duration / 2, result.killLog.length > 0 ? result.killLog.reduce((s, k) => s + k.durationMs, 0) / result.killLog.length : 15_000);
        const remaining = (): number => deadline - Date.now();
        // Walks back to the anchor share the run's deadline (at least 5 s, to make progress).
        const backToAnchor = () => this.walkTo(anchor.x, anchor.y, { z: anchor.z, tolerance: 150, timeout: Math.max(5000, remaining()) });
        // A melee slot with a weapon is what a swing takes (killNpc's way to it from a bow, meleeSlot): only a pet can fight without one.
        const noMelee = (): boolean => {
            const s = this.helpers.state();
            return !s || meleeSlot(s) === null;
        };
        // A shade can't melee (ClassDisciple.cs:91), so its 'both' is 'pet', and with a pet to fight so is that of one with nothing to swing.
        const petOnly = (): boolean => !!this.helpers.player()?.isShade || (!!petPlan && (petPlan.fight === 'pet' || noMelee()));
        // A turret doesn't walk, and an order beyond its reach would only stop the fight it has (ControlledMobBrain.cs:216-225).
        const beyondTurret = (n: NearbyNpc): boolean => {
            const pet = petOnly() ? this.sdk.getPetState() : null;
            return !!pet && this.turretCantReach(pet, n) !== null;
        };
        // Fights that haven't ended, the latest last: what comes next after a lost pet, a mob on us or a go that ran out of killTimeout, and how long they took for killLog.
        const fights = new Map<number, { name: string; level: number; since: number; baseline: number }>();
        // Fights of mobs that have left a turret's reach, which an order still stands on: the next record of one goes on from there.
        const beyondReach = new Map<number, { name: string; since: number; baseline: number }>();
        const newFight = (n: NearbyNpc) => {
            const s = this.helpers.state();
            const before = beyondReach.get(n.objectId);
            beyondReach.delete(n.objectId);
            const goesOn = before?.name === n.name && !diedSince(s, n.objectId, before.baseline);
            return { name: n.name, level: n.level, since: goesOn ? before.since : Date.now(), baseline: maxCombatEventId(s) };
        };
        const comingForUs = (n: NearbyNpc): boolean => lostWith?.objectId === n.objectId && lostWith.engaged;
        // Short of time that is only a fight that stands. A mob at full health on nobody is none: a lost pet that never reached it has drawn nothing, as a mob adds aggro only from an attack (StandardMobBrain.cs:548-575).
        const unfinished = (s: BotWorldState | null): NearbyNpc | null => {
            const short = remaining() < minEngage();
            for (const [id, fight] of [...fights].reverse()) {
                const n = standingMob(s, id, fight);
                if (!n) {
                    // A death is creditDeaths' to count.
                    if (!diedSince(s, id, fight.baseline)) fights.delete(id);
                    continue;
                }
                const on = n.targetObjectId;
                if (!short || n.healthPercent < 100 || (on !== null && (on === s?.player?.objectId || on === s?.pet?.objectId)) || comingForUs(n)) return n;
            }
            return null;
        };
        // A mob the pet is on, that grind would fight. An enemy player is left to the caller, as is one beyond a turret that can't answer it.
        const petFightStands = (): NearbyNpc | null => {
            if (!petPlan || !this.sdk.getPetState()) return null;
            const foe = this.helpers.petFoe();
            return foe?.kind === 'npc' && !beyondTurret(foe) ? foe : null;
        };
        // Nobody would be watching it, and its death can be ours (ClassDisciple.cs:149). Passive breaks off a fight, defensive leaves it able to hit
        // back, and follow fetches it (ControlledMobBrain.cs:189-204): it would not leave at a follow alone while the mob stays on it. It answers that mob's next swing all the same (StandardMobBrain.cs:545-574), so the note says so.
        const callOffPet = async (): Promise<void> => {
            const standing = this.helpers.player()?.isDead ? null : petFightStands();
            if (!standing) return;
            const petHealth = this.sdk.getPet()?.healthPercent ?? null;
            const name = nameOf(standing);
            await this.setPetAggression('passive');
            await this.setPetAggression('defensive');
            await this.petFollow();
            result.calledOff = { mob: { objectId: standing.objectId, name, healthPercent: standing.healthPercent }, petHealthPercent: petHealth };
            endNote += `; our pet was still fighting: called off${petHealth === null ? '' : ` at ${petHealth} %`} with ${name} at ${standing.healthPercent} %, and it hits back if that mob stays on it`;
        };
        // A mob of a fight that died while a pass looked elsewhere: the pet's kill while we swing at another. Looked at between passes and as the run ends. Its XP goes to the run's total (finish).
        const creditDeaths = async (): Promise<GrindResult | null> => {
            const s = this.helpers.state();
            for (const [id, fight] of [...fights]) {
                const death = s?.combatEvents.find(e => e.id > fight.baseline && e.kind === 'death' && e.targetObjectId === id);
                if (!death) continue;
                fights.delete(id);
                // With no pet up it was somebody else's: a mob we left, or one its pet went down on.
                if (!s?.pet && !s?.summons?.length) continue;
                const whole = death.receivedAt - fight.since;
                result.kills++;
                stats.kills++;
                result.killLog.push({ name: fight.name, level: fight.level, xp: 0, durationMs: whole });
                if (options.loot !== false && !this.isDead() && !this.getAttackers().length) await this.lootNearby({ radius: PET_ORDER_RANGE, settleMs: 300 });
                const keepGoing = await options.onKill?.({ ...noKill(), success: true, killed: true, npc: null, durationMs: whole, message: killedLine(fight.name || `#${id}`, whole, '') }, { ...stats });
                const stop = keepGoing === false ? 'onKill' : options.maxKills !== undefined && result.kills >= options.maxKills ? 'maxKills' : null;
                if (stop) {
                    await callOffPet();
                    return finish(stop);
                }
            }
            return null;
        };
        /**
         * The fight a lost pet leaves, if one stands: the first mob that read as on it, else what it aimed at, with its health now. On it, it has our 30 % of the threat (StandardMobBrain.cs:569-570), and a mob hurt or naming us has seen us too; one it never reached has drawn nothing. Null with none.
         */
        const lossFight = (loss: PetLoss, shade: boolean): typeof lostWith => {
            const s = this.helpers.state();
            const baseline = s?.combatEvents.findLast(e => e.receivedAt < loss.at)?.id ?? 0;
            for (const id of [...loss.targetedBy ?? [], ...loss.targetObjectId === undefined ? [] : [loss.targetObjectId]]) {
                const known = fights.get(id);
                const n = s?.nearbyNpcs.find(x => x.objectId === id);
                if (!n || !standingMob(s, id, { name: known?.name ?? n.name, baseline: known?.baseline ?? baseline })) continue;
                return { objectId: id, name: n.name, baseline: known?.baseline ?? baseline, healthPercent: n.healthPercent, shade, engaged: !!loss.targetedBy?.includes(id) || n.healthPercent < 100 || n.targetObjectId === s?.player?.objectId };
            }
            return null;
        };
        // Set by a try that was the last this run has time for.
        let summonSpent = false;
        // One go at the summon: a result ends the run. With a mob on us a failure only sets the timer: the pass goes to melee, and what it takes to try again is for one with nothing on us.
        const summonOnce = async (mobOnUs: boolean): Promise<GrindResult | null> => {
            summonSpent = false;
            const plan = petPlan!;
            const summon = await this.summonPet(plan.spell);
            // Only a spell our data doesn't know gets this far (grindPetRefusal).
            if (summon.success && !summon.petState) return finish('error', `${summon.spell?.name} gives a pet no window lists: grind can't order it`, 'not_supported');
            if (summon.success || summon.reason === 'pet_exists') {
                summonedYet = true;
                summonFailures = 0;
                summonWait = null;
                summonFailed = null;
                return null;
            }
            const held = summon.reason === 'cooldown' ? (summon.spell?.cooldownRemaining ?? 0) * 1000 : summon.reason === 'must_wait' ? summon.retryAfterMs ?? 0 : 0;
            if (held > 0) summonWait = { name: summon.spell?.name ?? 'our summon', until: Date.now() + held, mustWait: summon.reason === 'must_wait' };
            // The time a melee pass lasts while we wait (GRIND_MELEE_PASS_MS), so a long recast doesn't cut one up every few seconds.
            summonRetryAt = Date.now() + Math.max(summon.retryAfterMs ?? PET_SUMMON_RETRY_MS, held);
            // A recast has its own note, and a death says itself.
            if (summon.reason !== 'cooldown' && summon.reason !== 'must_wait' && summon.reason !== 'died') summonFailed = { message: summon.message, reason: summon.reason, spell: summon.spell ?? null, mana: this.helpers.player()?.mana ?? 0, rested: false };
            // Neither cures itself, so these end the run with a mob on us too, before melee can take us in: a charmed pet that got lost has nothing to summon it back with, and a window turret has no spot until one is set.
            if (summon.reason === 'spell_not_found' && plan.spell === undefined) return finish('error', `Could not summon a pet: ${summon.message}`, 'not_supported');
            if (summon.reason === 'no_ground_target' && !this.helpers.state()?.groundTarget) return finish('error', `Could not summon a pet: ${summon.message}`, summon.reason);
            if (mobOnUs) return null;
            // Wait these out and try again; a swing's timer still running at its half way stops a cast of ours (SpellHandler.cs:342-372), and a Hunter's has a 120 s recast.
            const passing = summon.reason === 'died' || summon.reason === 'cooldown' || summon.reason === 'must_wait' || summon.reason === 'interrupted' || summon.reason === 'crowd_controlled';
            if (!passing) summonFailures++;
            // These don't cure themselves.
            if (summon.reason === 'spell_not_found' || summon.reason === 'unknown_action' || summon.reason === 'bad_args') return finish('error', `Could not summon a pet: ${summon.message}`, summon.reason);
            // A run that has used up its time has ended as it should, whatever this last try came to: no rest for it and no error. The end note says why there is no pet.
            if (!passing && (Date.now() >= deadline || (summonFailures >= PET_SUMMON_ATTEMPTS && remaining() < minEngage()))) {
                summonSpent = true;
                return null;
            }
            if (summonFailures >= PET_SUMMON_ATTEMPTS) return finish('error', `Could not summon a pet: ${summon.message}`, summon.reason);
            if (summon.reason === 'no_power') {
                const rested = await this.rest({ healthPercent: restTo, manaPercent: this.summonRestMana(summon.spell ?? null), timeout: Math.max(5000, Math.min(120_000, remaining())) });
                // One that waited for nothing is no rest (GRIND_RETRY_MS).
                if (summonFailed && (rested.success || rested.durationMs >= GRIND_RETRY_MS)) summonFailed.rested = true;
                summonRetryAt = 0;
            }
            return null;
        };
        const wantsPet = (s: BotWorldState | null): boolean => !!petPlan && !s?.pet && (!summonedYet || petPlan.resummon);
        const summonInfo = (): SpellInfo | null => {
            const sp = this.summonSpellOf(petPlan!.spell);
            return sp && this.getSpellInfo(sp);
        };
        // Melee is no answer for a Necromancer: 3-7 a swing, with the run-in it would spend walking to the mob, and 980 units of that live, into its death 8.9 s on; a summon from there lasted about 8 s longer. And its cast is 20 s, whose room (2406) a tether's cut at about 2100 never has. So it goes as one with no weapon does.
        const noMeleeWorthGoing = (): boolean => noMelee() || summonInfo()?.type === 'SummonNecroPet';
        // How far off a mob on us must be for the summon to go: a swing's timer still running at its half way stops it, and one that has arrived keeps one running (SpellHandler.cs:356-372). Less than any with no cast time, or nothing to summon with, which ends the run; and with no melee of ours to go to, the cast is all we have.
        const summonRoom = (mob: NearbyNpc): number => {
            if (!this.summonSpellOf(petPlan!.spell) || noMeleeWorthGoing()) return -1;
            const info = summonInfo();
            return !info ? GRIND_SUMMON_ROOM : info.uninterruptible || info.castTime <= 0 ? -1 : castRoom(info.castTime, mob.speed);
        };
        // What our last swing holds back (SpellHandler.cs:603-620), for seconds and no more: the next summon is worth waiting for, with nothing beside us.
        const summonJustHeld = (): boolean => !!summonWait?.mustWait;

        let deathCountSeen = p0.deathCount;
        while (Date.now() < deadline || (Date.now() < fightEnd && (petFightStands() || unfinished(this.helpers.state()) || (newPetPass && this.getAttackers().length > 0)))) {
            throwIfExecutionAborted();
            const p = this.helpers.player();
            if (!p) return finish('error', 'Lost game state', 'not_in_game');
            // A shade has no other way to fight (ClassDisciple.cs:91), and its health stays full until the servant's death takes it (:149): whatever was asked, this is a pet grind from here on.
            if (p.isShade) petPlan ??= planOf({});
            // deathCount also catches a death the server auto-released ("release automatically
            // in 8 more seconds") while we were busy looting, resting or in onKill.
            if (p.isDead || p.deathCount !== deathCountSeen) {
                if (corpseAtStart && p.deathCount === deathCountSeen) endNote = '; we began on a corpse, and released it';
                else stats.deaths += Math.max(1, p.deathCount - deathCountSeen);
                corpseAtStart = false;
                deathCountSeen = p.deathCount;
                fights.clear();
                if (!options.respawn) return finish('died');
                lostWith = null;
                const rel = p.isDead ? await this.releaseAndRespawn() : null;
                if (rel && !rel.success && rel.reason !== 'not_dead') return finish('error', `Could not respawn: ${rel.message}`, rel.reason);
                if (remaining() > minEngage()) {
                    // The way back can take the whole run, and a pet follows on it, to answer what comes for us there. A window turret doesn't (TurretBrain.cs:100-108): that one goes up at the anchor, on the way in.
                    if (wantsPet(this.helpers.state()) && Date.now() >= summonRetryAt && petSpellKind(summonInfo()?.type ?? '') !== 'turret') {
                        const ended = await summonOnce(false);
                        if (ended) return ended;
                    }
                    await backToAnchor();
                }
                continue;
            }
            for (const [id, until] of avoid) if (until < Date.now()) avoid.delete(id);
            const credited = await creditDeaths();
            if (credited) return credited;

            const s = this.helpers.state();
            // A pet lost while nothing looked: in the loot wait, in onKill or in a rest. The pass's own look is below.
            const loss = s?.lastPetLoss;
            if (loss && loss.at !== lossSeen) {
                lossSeen = loss.at;
                if (loss.cause !== 'owner_died' && loss.cause !== 'region_change') {
                    lostWith = lossFight(loss, shadeBefore || !!p.isShade);
                    // One loss, one failure, with no pass to hear of it: the next summon means none will.
                    if (loss.at !== lossCounted) result.failures++;
                    lossCounted = loss.at;
                }
            }
            shadeBefore = !!p.isShade;
            // No weapon, no pet and none to come: nothing is left to fight with, and a pass could only be refused, one failure a second with the mob swinging. lossNote says the rest of a lost pet's mob.
            if (petPlan && !this.sdk.getPetState() && !wantsPet(s) && noMelee()) {
                const on = this.getAttackers().filter(n => n.objectId !== lostWith?.objectId).sort((a, b) => a.distance - b.distance)[0];
                return finish('error', `We have no weapon, and no pet left to fight with${on ? `: ${nameOf(on)} is on us` : ''}`, 'no_pet');
            }
            const attackers = this.getAttackers();
            // A mob our own nuke pulled reads no target on its way (0xFFFF, PacketLib168.cs:820-828), so nothing above names it: while we want a pet its room counts, if a fight of ours or a hit of ours says it is ours and it closes.
            const pulled = wantsPet(s) ? (s?.nearbyNpcs ?? []).filter(n => n.targetObjectId === null && n.inCombat && !n.isPet && !attackers.some(a => a.objectId === n.objectId) && closesOn(n, p) && (fights.has(n.objectId) || hitByUs(s!, n))) : [];
            // A failed fight rules out a mob hitting us from where we can't get at it, not one in melee range.
            // Its target doesn't tell them apart: the client shows a spell's hit as its target until its next update.
            const fightable = [...attackers, ...pulled].filter(n => n.distance <= MELEE_RANGE || !avoid.has(n.objectId));
            // Until one has arrived the pet stays on the one it has: a pass with it lasts only a run-in, and the next would have it swap onto a nearer one for nothing. Among them a fight of ours or a hurt one first: one at full health can be an add on the pet that was never hit, on its way home, not to us (StandardMobBrain.cs:566-571).
            const beside = fightable.filter(n => n.distance <= GRIND_SUMMON_ROOM);
            const pool = beside.length ? beside : fightable;
            let target = (beside.length ? undefined : fightable.find(n => n.objectId === s?.pet?.targetObjectId)) ?? pool.find(n => fights.has(n.objectId)) ?? pool.find(n => n.healthPercent < 100) ?? pool[0] ?? null;
            const short = remaining() < minEngage();
            // A mob still on its way to us leaves room for what a mob beside us would interrupt.
            if (target && wantsPet(s) && Date.now() >= summonRetryAt && target.distance > summonRoom(target)) {
                idleSince = null;
                const ended = await summonOnce(true);
                if (ended) return ended;
                newPetPass = !!this.sdk.getPetState();
                continue;
            }
            // With nothing to swing there is nothing else to do about it until the next try: killNpc would only refuse. It stays our fight, for killLog and the overrun.
            if (target && wantsPet(s) && noMeleeWorthGoing()) {
                idleSince = null;
                if (!fights.has(target.objectId)) fights.set(target.objectId, newFight(target));
                const wait = summonRetryAt - Date.now();
                if (Date.now() >= deadline && wait >= fightEnd - Date.now()) break;
                await this.helpers.sleep(Math.min(wait, 500));
                continue;
            }
            if (!target && petPlan) {
                // Short of time a new pet is only for a fight that stands: a mob the lost pet engaged turns on us (StandardMobBrain.cs:569).
                const left = wantsPet(s) ? unfinished(s) : null;
                if (wantsPet(s) && (!short || left)) {
                    idleSince = null;
                    const wait = summonRetryAt - Date.now();
                    if (wait <= 0) {
                        const ended = await summonOnce(attackers.length > 0);
                        if (ended) return ended;
                        if (summonSpent) break;
                        continue;
                    }
                    if (petOnly() || noMeleeWorthGoing() || wait <= 2 * PET_SUMMON_RETRY_MS || summonJustHeld()) {
                        // The overrun is for a fight, and a recast it can't outlast leaves us none to wait for, unless the mob is coming: that one is ours to fight when it reads so.
                        if (Date.now() >= deadline && wait >= fightEnd - Date.now() && !(left && comingForUs(left))) break;
                        await this.helpers.sleep(Math.min(wait, 500));
                        continue;
                    }
                }
                // Its mob is the next target, so its kill counts: no new pull and no rest. An enemy player can only be waited out here,
                // and so can a mob we called it off that it hasn't let go yet. One still on the pet stays in the fight: a pet on follow hits back.
                // One beyond a turret's reach it can't answer, and that doesn't hold up what it can reach.
                const petsFoe = this.helpers.petFoe(s);
                const foe = petsFoe?.kind === 'npc' && beyondTurret(petsFoe) ? null : petsFoe;
                if (foe?.kind === 'npc' && (!avoid.has(foe.objectId) || foe.targetObjectId === s?.pet?.objectId)) target = foe;
                else if (foe && (foe.kind === 'npc' || !short)) {
                    idleSince = null;
                    await this.helpers.sleep(500);
                    continue;
                }
            }
            // However short of time, if it is a fight (unfinished): it is ours to end.
            if (!target) {
                const left = unfinished(s);
                if (left && !beyondTurret(left)) target = left;
            }
            // Too little time left to pull, walk back or rest: stop rather than overshoot.
            if (!target && short) break;
            if (!target) {
                const lowMana = options.restBelowMana !== undefined && p.maxMana > 0 && p.manaPercent < options.restBelowMana;
                const pet = petPlan ? this.sdk.getPet() : null;
                // Once the gate has called for a rest it goes on to restTo, over the end of a rest (one stops at 120 s, and a servant's 50 to 90 % takes longer) and of a run. A pet out of view can't say.
                const petResting = !!pet && pet.healthPercent < (petPlan!.restBelow > 0 && this.restingPet === pet.objectId ? petPlan!.restTo : petPlan!.restBelow);
                if (pet) this.restingPet = petResting ? pet.objectId : null;
                const hurt = p.healthPercent < restBelow || lowMana || petResting;
                if (hurt && !attackers.length) {
                    const rested = await this.rest({ healthPercent: Math.max(restTo, restBelow), manaPercent: lowMana ? Math.min(100, options.restBelowMana! + 40) : undefined, petHealthPercent: petPlan?.restBelow ? petPlan.restTo : undefined, timeout: Math.max(5000, Math.min(120_000, deadline - Date.now())) });
                    if (!rested.success && rested.reason !== 'attacked') await this.helpers.sleep(1000);
                    idleSince = null; // resting is not idling: count the search time afresh
                    // One that waited for nothing has let no timer or snapshot through, so going round again could spin for the rest of the run. Nothing has changed: pick.
                    if (!rested.success || rested.durationMs >= GRIND_RETRY_MS) continue;
                }
                if (Math.hypot(p.x - anchor.x, p.y - anchor.y) > radius) {
                    await backToAnchor();
                    continue;
                }
                // Hurt under fire from a mob ruled out: rest refuses, and no new fight now. It waits for no_targets, the deadline or that mob's 60 s to run out.
                if (!hurt || !attackers.length) target = this.findKillableNpcs({
                    pattern: options.pattern, maxLevelDiff: options.maxLevelDiff, minLevelDiff: options.minLevelDiff,
                    minCon: options.minCon, maxCon: options.maxCon, radius, from: anchor, exclude: avoid.keys(),
                }).find(n => !beyondTurret(n)) ?? null;
            }
            if (!target) {
                if (Math.hypot(p.x - anchor.x, p.y - anchor.y) > 300) {
                    await backToAnchor();
                    continue;
                }
                idleSince ??= Date.now();
                const idle = Date.now() - idleSince;
                if (noTargetTimeout > 0 && idle >= noTargetTimeout) {
                    const window = options.maxLevelDiff !== undefined || options.minLevelDiff !== undefined
                        ? `level diff ${options.minLevelDiff ?? '-∞'}..${options.maxLevelDiff ?? '∞'}`
                        : `con ${options.minCon ?? -2}..${options.maxCon ?? 0}`;
                    const pet = petOnly() ? this.sdk.getPetState() : null;
                    const reach = pet && this.windowTurret(pet) ? ', and in reach of our turret,' : '';
                    return finish('no_targets', `No killable target (${window}, level ${p.level}) within ${radius} of the anchor${reach} for ${Math.round(idle / 1000)}s; ${result.kills} kills so far`);
                }
                const untilIdleStop = noTargetTimeout > 0 ? noTargetTimeout - idle : Infinity;
                await this.helpers.sleep(Math.max(0, Math.min(3000, deadline - Date.now(), untilIdleStop)));
                continue;
            }
            idleSince = null;
            // A plain run has no other way to fight, and every mob would read the same. Nothing has gone out: killNpc would have ordered a pet up onto each in turn.
            if (!petPlan && noMelee()) return finish('error', `We have no weapon to fight ${nameOf(target)} with${this.sdk.getPetState() ? ': pass pet: true to have our pet fight' : ''}`, 'refused');
            newPetPass = false;
            // Not a record under an id that has since gone to another mob (standingMob's rule): that mob's next timeout would read as the old one's death.
            const known = fights.get(target.objectId);
            const fight = known && known.name === target.name && !diedSince(this.helpers.state(), target.objectId, known.baseline) ? known : newFight(target);
            fights.delete(target.objectId);
            fights.set(target.objectId, fight);
            // By its hits too: one at range reads no target. As a turret's fight it would come straight back from the refusal, with no wait.
            const onUs = target.targetObjectId === p.objectId || attackers.some(n => n.objectId === target!.objectId) || pulled.includes(target) || cameOn === target.objectId;
            cameOn = null;
            // Below the room with no pet yet, and it is coming: walking out to meet it spends the distance the next try wants, and took a caster into the bandit camp it came from. Melee as it arrives. One with no speed gets a moment: it may be turning, or a caster mob that means to stand, and that one we go to.
            if (wantsPet(s) && onUs && target.distance > MELEE_REACH) {
                if (standing?.id !== target.objectId) standing = { id: target.objectId, since: Date.now() };
                if (target.speed > 0 ? closesOn(target, p) : Date.now() - standing.since < GRIND_LET_COME_MS) {
                    await this.helpers.sleep(GRIND_LET_COME_LOOK_MS);
                    continue;
                }
            }
            const passStart = Date.now();
            const lossBefore = s?.lastPetLoss?.at;
            // A pass is when we look: while the pet wears the mob down it goes on to the end of the overrun. Its order stands from pass to pass: petFight gives none while the model has it on the mob.
            const killTimeout = Math.max(0, Math.min(options.killTimeout ?? 60_000, fightEnd - passStart));
            const arrived = target.distance <= GRIND_SUMMON_ROOM;
            // A mob on us that a turret can't reach is ours to fight, and so is one that has arrived, if we can swing: a new pet's threat can take long to take it off us, and killNpc orders the pet as well.
            const petFights = petOnly() && !!this.sdk.getPetState() && !(onUs && (beyondTurret(target) || (arrived && !p.isShade && !noMelee())));
            // A look sooner than that: with the pet when a mob on us should have arrived, in melee when the next try at a summon is due. An attack that stops and starts costs no swing (GRIND_MELEE_PASS_MS), and an order stands.
            const lookIn = petFights
                ? onUs && !arrived ? mobRunInMs(target.distance, target.healthPercent) : Infinity
                : wantsPet(this.helpers.state()) ? Math.max(GRIND_MELEE_PASS_MS, summonRetryAt - passStart) : Infinity;
            const passTimeout = Math.min(killTimeout, lookIn);
            const cutShort = passTimeout < killTimeout;
            // killNpc leaves a passive pet out (petCanJoin), and on this plan the fight is the pet's all the same: a petKill's order would have lifted it (ControlledMobBrain.cs:213-214). 'both' is killNpc's plan, stance and all.
            if (!petFights && petPlan?.fight === 'pet' && this.sdk.getPetState()?.aggression === 'passive' && !beyondTurret(target)) await this.setPetAggression('defensive');
            const kill = petFights
                // A mob on us is already the answer to the others on us: they wait their turn. `attacked` would only swap between them, with no order standing.
                // As it arrives the pass is over: the mob is ours to swing at as well, whatever it ran at.
                // Whatever it read at the start: a mob that turns on us during the pass is under us for the rest of it, with nothing in petFight to end that (attackers leaves out its own target), and 3 of 3 live cost the owner his fight.
                ? await this.petKill(target, { timeout: passTimeout, ignoreAttackers: onUs, ...(onUs && !arrived ? { endWithin: GRIND_SUMMON_ROOM } : {}), ...(!p.isShade && !noMelee() ? { endOnUsWithin: GRIND_SUMMON_ROOM } : {}) })
                // With a new pet to get, or a run to end for want of one, its loss ends the pass: nothing else in it would look, and the next goes on with the fight.
                : await this.killNpc(target, { timeout: passTimeout, styles: options.styles, useStyle: options.useStyle, force: true, endOnPetLoss: !!petPlan?.resummon && !!this.sdk.getPetState() });
            // A pass can run out with the death in the last snapshot gap: the kill is the same, its XP may just not have come yet (finish() still counts it). A snapshot is about 250 ms apart.
            if (kill.reason === 'timeout' && !diedSince(this.helpers.state(), target.objectId, fight.baseline)) await this.helpers.nextState(300);
            if (kill.killed || (kill.reason === 'timeout' && diedSince(this.helpers.state(), target.objectId, fight.baseline))) {
                fights.delete(target.objectId);
                const whole = passStart - fight.since + kill.durationMs;
                result.kills++;
                stats.kills++;
                stats.xpGained += kill.xpGained;
                result.killLog.push({ name: target.name, level: target.level, xp: kill.xpGained, durationMs: whole });
                // The pet may have made the kill out where it stood, up to an order's range from us.
                if (options.loot !== false && !this.isDead()) await this.lootNearby({ radius: petFights ? PET_ORDER_RANGE : 400, settleMs: 300 });
                const keepGoing = await options.onKill?.({ ...kill, success: true, killed: true, reason: undefined, durationMs: whole, message: killedLine(nameOf(target), whole, ` (+${kill.xpGained} xp)`) }, { ...stats });
                const stop = keepGoing === false ? 'onKill' : options.maxKills !== undefined && result.kills >= options.maxKills ? 'maxKills' : null;
                if (stop) {
                    await callOffPet();
                    return finish(stop);
                }
            } else {
                // Also in a fight of ours beside it, which goes on without it.
                if (kill.reason === 'pet_died' || this.helpers.state()?.lastPetLoss?.at !== lossBefore) {
                    // The model hands a mob on the pet over to us at the loss (a hold of seconds), or clears it with another to turn to, which targetedBy still knows, and the reading from before the pass covers one it let go of just then.
                    const loss = this.helpers.state()?.lastPetLoss;
                    lossSeen = loss?.at;
                    const engaged = !!loss?.targetedBy?.includes(target.objectId) || [target.targetObjectId, this.sdk.getNearbyNpc(target.objectId)?.targetObjectId].some(id => id === p.objectId || (typeof id === 'number' && id === loss?.objectId));
                    // In a fight of ours beside the pet's, the one that took it comes next, and the note is about that one.
                    const besidePet = loss?.targetedBy?.length && !loss.targetedBy.includes(target.objectId) ? lossFight(loss, !!p.isShade) : null;
                    lostWith = besidePet ?? { objectId: target.objectId, name: fight.name, baseline: fight.baseline, healthPercent: kill.npc?.healthPercent ?? target.healthPercent, shade: !!p.isShade, engaged };
                }
                if (kill.reason === 'timeout') {
                    // Our wait ended, the fight did not. It goes on while the mob wears down, or in melee while it stays on us, and its kill counts on the next pass, with the whole of it in killLog.
                    const now = this.sdk.getNearbyNpc(target.objectId);
                    const overrunUp = Date.now() >= fightEnd || passStart + passTimeout >= fightEnd;
                    // Under 1 % it reads 0, for seconds before it goes: calling it off here would lose the kill.
                    if (overrunUp && !finishing && now && now.healthPercent < GRIND_FINISHING_PERCENT) {
                        finishing = true;
                        fightEnd += GRIND_FINISHING_MS;
                        continue;
                    }
                    const goesOn = !!now && (now.healthPercent < target.healthPercent || ((!petFights || cutShort) && now.targetObjectId === p.objectId));
                    // A look of ours came first, and not killTimeout: nothing to judge the go by yet.
                    const lookAgain = cutShort && !!now && Date.now() - fight.since < (options.killTimeout ?? 60_000);
                    if (petPlan && this.sdk.getPetState()) {
                        // The end of the overrun: out of the loop, to the call-off below.
                        if (overrunUp) break;
                        // A weak pet takes longer than killTimeout over many a mob.
                        if (goesOn || lookAgain) continue;
                        // Getting nowhere: call it off (GamePlayer.cs:12208-12210), or it would hold this run on a mob it can't kill.
                        await this.petFollow();
                    } else if (goesOn || lookAgain) {
                        continue;
                    }
                }
                // It has got here. Melee, or the pet's fight with no such end: both have to go by what the next pass reads, with this on the mob's side of it.
                if (kill.reason === 'arrived') {
                    cameOn = target.objectId;
                    continue;
                }
                const atOnce = Date.now() - passStart < GRIND_RETRY_MS;
                // Another mob on us is next, and says nothing against this one. Should it let go of us first, it still comes before a fresh one.
                if (kill.reason === 'attacked') {
                    if (kill.attacker && !fights.has(kill.attacker.objectId)) fights.set(kill.attacker.objectId, newFight(kill.attacker));
                    if (atOnce) await this.helpers.sleep(GRIND_RETRY_MS);
                    continue;
                }
                // It walked out of a turret's reach during the fight. That says nothing against it either: no failure and no wait, and the picks pass it over until it is back.
                const gone = kill.reason === 'out_of_range' && petFights ? this.sdk.getNearbyNpc(target.objectId) : null;
                if (gone && beyondTurret(gone)) {
                    beyondReach.set(target.objectId, fight);
                    fights.delete(target.objectId);
                    continue;
                }
                // A death counts itself, as a death.
                if (kill.reason === 'died') continue;
                if (kill.reason === 'pet_died' || kill.reason === 'no_pet') {
                    // One loss is one failure, whether a pass hears of it as this or as that (an order can be what finds it gone), and however many hear.
                    const lossAt = this.helpers.state()?.lastPetLoss?.at;
                    if (lossAt === undefined ? kill.reason === 'pet_died' : lossAt !== lossCounted) result.failures++;
                    lossCounted = lossAt;
                    // Losing the pet says nothing against the mob, and has something to do next.
                    if (kill.reason === 'pet_died') continue;
                    // No pet with the shade's icon still up: it goes a tick or two after the 0xA2 (EffectListComponent.cs:914-921), and killNpc hands over to petKill until then, at once. The snapshot that ends this only comes if we wait.
                    const over = await this.helpers.waitFor(st => !st.player?.isShade || st.player.isDead, GRIND_RETRY_MS);
                    // A shade that stays with no pet has nothing to fight with, and the overrun isn't for waiting on that.
                    if (!over && Date.now() >= deadline) break;
                    continue;
                }
                result.failures++;
                avoid.set(target.objectId, Date.now() + 60_000);
                fights.delete(target.objectId);
                // No refusal may spin: a mob on us in melee range or on the pet comes straight back, avoided or not.
                if (atOnce && kill.reason !== 'timeout') await this.helpers.sleep(GRIND_RETRY_MS);
                // What failed is no fight in progress: the overrun isn't for trying again.
                if (Date.now() >= deadline) break;
            }
        }
        const last = await creditDeaths();
        if (last) return last;
        // finish() tells a shade what its servant's death cost, and that comes after the death: the close ends the shade on a later tick (EffectListComponent.cs:914-921), its cut of our health
        // goes out a tick after that (ClassDisciple.cs:147-150, GamePlayer.cs:2441), and only a later snapshot has it. A release or a tether can cut less, or nothing: the wait has its bound.
        const lastLoss = this.helpers.state()?.lastPetLoss;
        const cutDue = lostWith?.shade && lastLoss && !this.sdk.getPetState() ? lastLoss.at + GRIND_RETRY_MS - Date.now() : 0;
        if (cutDue > 0) await this.helpers.waitFor(st => !st.player || st.player.isDead || (!st.player.isShade && st.player.healthPercent <= SHADE_DEATH_HEALTH), cutDue);
        // A death in the last fight (killNpc ran past the deadline) is otherwise never counted.
        const pEnd = this.helpers.player();
        if (pEnd && (pEnd.isDead || pEnd.deathCount !== deathCountSeen)) {
            stats.deaths += Math.max(1, pEnd.deathCount - deathCountSeen);
            if (!options.respawn) return finish('died');
            lostWith = null;
        }
        // respawn promises a living bot: release a death from the last fight before returning.
        if (options.respawn && this.helpers.player()?.isDead) {
            const rel = await this.releaseAndRespawn();
            if (!rel.success && rel.reason !== 'not_dead') return finish('error', `Could not respawn: ${rel.message}`, rel.reason);
        }
        await callOffPet();
        return finish('duration');
    }

    /** Why grind can't fight with this pet plan, before it spends anything, with what to do instead. Null when it can. */
    private grindPetRefusal(spell: NamePattern | Spell | undefined): { message: string; reason: string } | null {
        const no = (message: string) => ({ message, reason: 'not_supported' });
        if (spell === undefined) return this.sdk.getPetState() || this.summonSpellOf(undefined) ? null : no(this.noMainSummonMessage());
        const sp = this.summonSpellOf(spell);
        // Up front, these too, or a pet already up would hide them for the whole run, and with none each try would wait out the retry timer.
        if (!sp) return { message: `Spell not found: ${describeTarget(spell)}`, reason: 'spell_not_found' };
        const info = this.getSpellInfo(sp);
        const kind = info ? petSpellKind(info.type) : null;
        if (info && !kind) return no(`${sp.name} is no summon spell (its type is ${info.type}): name one that summons a pet (findSummonSpell), or pass pet: true`);
        if (kind === 'charm') return no(`${sp.name} is a charm, and grind can't choose its mob: charm first with charmPet, then pass pet: true`);
        if (kind === 'fnf' || kind === 'bomber') return no(`${sp.name} gives a pet no window lists, so grind can't order it: cast it ${standsOnGround(info!) ? 'per spot with summonPet(spell, { groundTarget })' : 'per target with summonPet(spell, { target })'}`);
        if (kind === 'minion') return no(`${sp.name} is a minion, under its commander, so grind can't order it: summon it with summonPet(spell), and grind with the commander`);
        return null;
    }

    /** How far grind rests for a summon that lacks power: the most it can cost and a margin, as a percent of our pool (worstPowerCost), at most PET_SUMMON_MANA; that where we can't tell. */
    private summonRestMana(sp: Spell | null): number {
        const p = this.helpers.player();
        const info = sp && this.getSpellInfo(sp);
        if (!p || !info || p.maxMana <= 0) return PET_SUMMON_MANA;
        return Math.min(PET_SUMMON_MANA, Math.ceil((worstPowerCost(info.power, p) + PET_SUMMON_MANA_MARGIN) / p.maxMana * 100));
    }

    /** What a summon that lacked power comes to at the end of a run, in words: a rest can have seen to it with no time left for the cast, and plain regen can have too, in a fight, with no rest at all. `manaThen` is what it had at the failure. */
    private shortOfPower(sp: Spell | null, p: PlayerState, manaThen: number, rested: boolean): string {
        const info = sp && this.getSpellInfo(sp);
        const cost = info ? worstPowerCost(info.power, p) : null;
        const name = sp?.name ?? 'our summon';
        if (cost === null || p.mana < cost) return `short of power for ${name}${cost !== null ? ` (it can cost ${cost}, and we have ${p.mana})` : ''}`;
        return rested ? `rested for ${sp!.name}, no time left to cast it` : `short of power for ${name} at the time (it can cost ${cost}, and we had ${manaThen})`;
    }

    // ============ Internals ============

    /** Who a window we wait for may be from. The window carries a name and nothing else. Null when `target` names nobody. */
    private tradePartnerMatcher(target: PlayerTarget): ((name: string) => boolean) | null {
        if (typeof target === 'string') {
            const wanted = target.toLowerCase();
            return name => name.toLowerCase() === wanted;
        }
        if (target instanceof RegExp) return nameMatcher(target);
        const wanted = typeof target === 'number' ? this.helpers.resolvePlayer(target)?.name : target.name;
        return wanted === undefined ? null : name => name === wanted;
    }

    /** offerTrade's body, on the caller's watch and deadline. */
    private async offerOnWatch(partner: PlayerTarget, options: TradeOfferOptions, watch: MessageWatch, deadline: number): Promise<TradeOfferResult> {
        const refuse = (message: string, reason: string, extra: Partial<TradeOfferResult> = {}): TradeOfferResult =>
            fail(message, reason, { partner: null, trade: null, refused: null, messages: watch.messages(), ...extra });

        let sent = false;
        let succeeded = false;
        let windowId: number | null = null;
        try {
            const player = this.helpers.player();
            if (!player) return refuse('Not in game', 'not_in_game');
            if (player.isDead) return refuse('Dead', 'dead');
            const items: InventoryItem[] = [];
            for (const ref of options.give ?? []) {
                const item = this.tradeItem(ref);
                if (!item) return refuse(`Item not found: ${describeTarget(ref)}`, 'not_found');
                items.push(item);
            }
            const slots = items.map(i => i.slot);
            if (new Set(slots).size !== slots.length) return refuse('Two of the items are the same backpack slot', 'bad_args');
            if (items.length > TRADE_MAX_ITEMS) return refuse(`A trade holds ${TRADE_MAX_ITEMS} items per side, not ${items.length}`, 'too_many_items');
            const money = options.money ?? 0;
            if (!Number.isSafeInteger(money) || money < 0) return refuse(`Bad money amount: ${money}`, 'bad_args');
            if (items.length === 0 && money === 0) return refuse('Nothing to offer', 'bad_args');
            if (money > player.money.totalCopper) return refuse(`Offering ${money}c with ${player.money.totalCopper}c in the purse`, 'insufficient_funds');
            if (partner instanceof RegExp) return refuse(`An offer needs a player's exact name, not the pattern ${partner}: it could match anyone in view`, 'bad_args');
            const p = this.tradeReceiver(partner);
            if (!p) return refuse(`Player not found: ${describeTarget(partner)}`, 'not_found');

            /** One add: dispatch it, then the 0xEA that shows it or a refusal line, curing what can be cured once. */
            const add = async (send: () => Promise<ActionResult>, done: (t: TradeWindow) => boolean, item: InventoryItem | null): Promise<TradeOfferResult | null> => {
                let stepped = false;
                let cured = false;
                for (;;) {
                    if (Date.now() >= deadline) return refuse(`Out of time for the offer to ${p.name}`, 'timeout', { partner: p });
                    while (!this.sdk.getTrade()) {
                        const wait = tradeSlotWait(Date.now(), player.name.toLowerCase() > p.name.toLowerCase());
                        if (wait === 0) break;
                        if (Date.now() + wait >= deadline) return refuse(`Out of time for the offer to ${p.name}`, 'timeout', { partner: p });
                        await this.helpers.sleep(wait);
                    }
                    const mark = watch.messages().length;
                    sent = true;
                    const r = await send();
                    if (!r.success) return refuse(r.message, r.reason ?? 'dispatch_failed', { partner: p });
                    const got = await this.helpers.waitFor<TradeWindow | ReasonLine>(
                        s => s.trade && done(s.trade) ? s.trade : firstReasonLine(watch.messages().slice(mark), TRADE_REFUSALS),
                        Math.min(TRADE_ANSWER_MS, Math.max(0, deadline - Date.now())),
                    );
                    if (!got) return refuse(`No answer to the offer to ${p.name}`, 'no_response', { partner: p });
                    if ('id' in got) {
                        windowId ??= got.id;
                        return null;
                    }
                    if (got.reason === 'out_of_range' && !stepped) {
                        stepped = true;
                        const walk = await this.walkToObject(p, { range: TRADE_CLOSE_RANGE, timeout: Math.max(1, deadline - Date.now()) });
                        if (!walk.success) return refuse(walk.message, walk.reason ?? 'out_of_reach', { partner: p });
                        continue;
                    }
                    if (got.reason === 'self_busy' && !cured && !this.sdk.getTrade()) {
                        // The server opens a window before it checks the item, and a refused first item leaves it open unseen.
                        cured = true;
                        await this.sdk.sendTradeCancel();
                        await this.helpers.nextState(500);
                        continue;
                    }
                    return refuse(got.text, got.reason === 'self_busy' ? 'busy' : got.reason, { partner: p, refused: { item, message: got.text } });
                }
            };

            const open = this.sdk.getTrade();
            if (open && (open.partnerName !== p.name || open.mySlots.some(s => !slots.includes(s)) || open.myMoney > money)) {
                sent = true;
                const cancel = await this.cancelTrade();
                if (!cancel.success) return refuse(cancel.message, cancel.reason ?? 'timeout', { partner: p });
            }
            if (this.helpers.state()?.movement.moving) await this.stop();
            const walk = await this.walkToObject(p, { range: options.range ?? 100, timeout: Math.max(1, deadline - Date.now()) });
            if (!walk.success) return refuse(walk.message, walk.reason ?? 'out_of_reach', { partner: p });

            // A partner's cancel or a range close: the next add would open a new window, without the items before it.
            const closed = (): boolean => windowId !== null && this.sdk.getTrade()?.id !== windowId;
            for (const item of items) {
                if (this.sdk.getTrade()?.mySlots.includes(item.slot)) continue;
                if (closed()) return refuse('The trade window closed during the offer', 'cancelled', { partner: p });
                const refused = await add(() => this.sdk.sendTradeOfferItem(p.objectId, item.slot), t => t.mySlots.includes(item.slot), item);
                if (refused) return refused;
            }
            if ((this.sdk.getTrade()?.myMoney ?? 0) !== money) {
                if (closed()) return refuse('The trade window closed during the offer', 'cancelled', { partner: p });
                const refused = await add(() => this.sdk.sendTradeOfferMoney(p.objectId, money - (this.sdk.getTrade()?.myMoney ?? 0)), t => t.myMoney === money, null);
                if (refused) return refused;
            }

            // Closed in the same snapshot as our last add: that add silently opened a new window without the earlier items.
            const t = this.sdk.getTrade();
            if (!t || (windowId !== null && t.id !== windowId) || slots.some(s => !t.mySlots.includes(s)) || t.myMoney !== money) {
                return refuse('The trade window closed during the offer', 'cancelled', { partner: p, trade: t });
            }
            if (t.partnerName !== p.name) return refuse(`The window is with ${t.partnerName}, not ${p.name}`, 'wrong_partner', { partner: p, trade: t });
            succeeded = true;
            return { success: true, message: `Offered ${slots.length} items and ${money}c to ${p.name}`, partner: p, trade: t, refused: null, messages: watch.messages() };
        } finally {
            if (!succeeded && (sent || this.sdk.getTrade())) await this.closeTrade();
        }
    }

    /**
     * An item to give, as the caller means it. An item object names that item in that slot: resolveInventoryItem
     * falls back to a substring of its name, and that would give away another one once the first has gone.
     */
    private tradeItem(ref: InventoryItem | NamePattern | number): InventoryItem | null {
        if (typeof ref === 'number' || typeof ref === 'string' || ref instanceof RegExp) return this.helpers.resolveInventoryItem(ref);
        return this.sdk.getInventory().find(i => i.slot === ref.slot && i.name === ref.name) ?? null;
    }

    /**
     * Who gets an offer. A name must be exact: resolvePlayer falls back to a substring, and that would hand items
     * to another player. A snapshot object goes by its name too: its id can be a newcomer's by now, because the
     * server hands a freed id to the next object in the region (Region.cs:779, :955).
     */
    private tradeReceiver(partner: NearbyPlayer | string | number): NearbyPlayer | null {
        if (typeof partner === 'number') return this.helpers.resolvePlayer(partner);
        const wanted = (typeof partner === 'string' ? partner : partner.name).toLowerCase();
        return this.sdk.getNearbyPlayers().find(pl => pl.name.toLowerCase() === wanted) ?? null;
    }

    /** Close the window and see it gone, so a retry can't take the one that is closing. The dispatch survives an abort; the wait ends there. */
    private async closeTrade(): Promise<void> {
        const open = this.sdk.getTrade();
        await this.helpers.cleanup(() => this.sdk.sendTradeCancel());
        if (!open) return;
        try {
            await this.helpers.waitFor(s => !s.trade || s.trade.id !== open.id, TRADE_CLOSE_MS);
        } catch {
            // aborted: the abort is the answer
        }
    }

    /**
     * Accept every new revision of the window until it closes. The window is the only channel between the two
     * sides: order is free, the second accept commits, and every 0xEA means both accepts were reset. A commit
     * failure is terminal, before any re-accept: a failed money check zeroes that side's money and leaves the items
     * in the window, so a blind re-accept could give an item away for nothing (PlayerTradeWindow.cs:430, :443, :455).
     * `offered` is the window this call must finish, if any. `ourSide` is what we may give: an inventory move drops
     * an item from the offer as one more revision (GamePlayerInventory.cs:335, :542-543), and accepting that would
     * give the partner's side for nothing, or ours in a window a call that gives nothing never meant to finish.
     */
    private async settleTrade(
        matches: (name: string) => boolean,
        accept: ((window: TradeWindow) => boolean) | undefined,
        watch: MessageWatch,
        before: readonly InventoryItem[],
        deadline: number,
        offered: TradeWindow | null,
        ourSide: TradeSide | null,
    ): Promise<TradeResult> {
        let seen = offered;
        let sentFor = -1;
        let sentAny = false;
        let closed = false;
        let closing = -1;
        const failure = (message: string, reason: string) => noTrade(message, reason, seen?.partnerName ?? null, watch.messages());
        /**
         * Leave the window ourselves and see how it ended: our accept may stand, a partner's can commit on it before
         * the close lands (PlayerTradeWindow.cs:408-414), and the close is then a no-op. That is a completed trade.
         */
        const giveUp = async (message: string, reason: string): Promise<TradeResult> => {
            closed = true;
            await this.closeTrade();
            return seen && watch.find([TRADE_COMPLETED]) ? await this.completedTrade(seen, before, watch) : failure(message, reason);
        };
        try {
            for (;;) {
                const s = this.helpers.state();
                if (!s?.player) return failure('Not in game', 'not_in_game');
                // The field is null while no window is open, so only a client without the trade code leaves it out.
                if (s.trade === undefined) return failure('The client runs older code, without trades: restart it with a quit action', 'unknown_action');
                const t = s.trade;
                const bad = firstReasonLine(watch.messages(), TRADE_COMMIT_FAILURES);
                if (bad) return await giveUp(bad.text, bad.reason);
                if (seen && (!t || t.id !== seen.id)) {
                    closed = true;
                    // A window that came up in its place isn't ours to hold, whatever became of the first.
                    if (t) await this.closeTrade();
                    if (watch.find([TRADE_COMPLETED])) return await this.completedTrade(seen, before, watch);
                    return failure(`The trade with ${seen.partnerName} closed without a trade`, 'cancelled');
                }
                if (t) {
                    const notOurSide = ourSide !== null && !sameTradeSide(t, ourSide);
                    if (t.partnerName === null || !matches(t.partnerName) || (notOurSide && !seen)) {
                        // A stranger, a self-craft window or a leftover of ours: never hold it, or the real partner gets "still trading". Once per window, so a late cancel can't hit the next one.
                        if (t.id !== closing) {
                            closing = t.id;
                            await this.sdk.sendTradeCancel();
                        }
                        await this.helpers.nextState(250);
                    } else {
                        seen = t;
                        if (notOurSide) return await giveUp(`Our side of the trade with ${t.partnerName} is no longer what we offered`, 'offer_changed');
                        if (t.revision !== sentFor) {
                            if (accept?.(t) ?? true) {
                                const r = await this.sdk.sendTradeAccept(t.revision, t.id);
                                if (r.success) {
                                    sentFor = t.revision;
                                    sentAny = true;
                                } else if (r.reason !== 'trade_changed' && r.reason !== 'no_trade') {
                                    return await giveUp(r.message, r.reason ?? 'dispatch_failed');
                                }
                            } else if (sentAny) {
                                return await giveUp(`Not accepting the changed offer from ${t.partnerName}`, 'offer_changed');
                            }
                        }
                    }
                }
                if (Date.now() >= deadline) {
                    if (!seen) return await giveUp('No trade window opened', 'timeout');
                    return sentAny ? await giveUp(`${seen.partnerName} did not accept`, 'partner_no_accept') : await giveUp(`The offer from ${seen.partnerName} was not accepted`, 'offer_rejected');
                }
                await this.helpers.nextState(Math.min(250, deadline - Date.now()));
            }
        } finally {
            if (!closed) await this.helpers.cleanup(() => this.sdk.sendTradeCancel());
        }
    }

    /**
     * The commit happened; the backpack says what came of it. The server only logs a failed add and still prints
     * "Trade Completed" (PlayerTradeWindow.cs:614-617, :657-660). No diff by slot or name: an identical swap lands
     * in the slot it left (:552-583, :607-611), so each partner item claims an entry that matches it. What we had
     * and kept is out of the running, or it would hide a lost item and take the place of the one that came.
     */
    private async completedTrade(seen: TradeWindow, before: readonly InventoryItem[], watch: MessageWatch): Promise<TradeResult> {
        const key = (i: InventoryItem) => `${i.name}|${i.model}|${i.count}`;
        const kept = (i: InventoryItem) => !seen.mySlots.includes(i.slot) && before.some(b => b.slot === i.slot && key(b) === key(i));
        const claim = (inventory: readonly InventoryItem[]) => {
            const free = inventory.filter(i => !kept(i));
            const received: InventoryItem[] = [];
            const missing: InventoryItem[] = [];
            for (const wanted of seen.partnerItems) {
                const found = free.find(i => key(i) === key(wanted));
                if (found) {
                    free.splice(free.indexOf(found), 1);
                    received.push(found);
                } else {
                    missing.push(wanted);
                }
            }
            return { received, missing };
        };
        let outcome = claim(this.sdk.getInventory());
        await this.helpers.waitFor(s => {
            outcome = claim(s.inventory);
            return outcome.missing.length === 0;
        }, 1000);
        const result = {
            partner: seen.partnerName,
            gave: before.filter(i => seen.mySlots.includes(i.slot)),
            received: outcome.received,
            missing: outcome.missing,
            moneyGiven: seen.myMoney,
            moneyReceived: seen.partnerMoney,
            refused: null,
            messages: watch.messages(),
        };
        return outcome.missing.length
            ? fail(`Trade completed, but ${outcome.missing.map(i => i.name).join(', ')} never reached our backpack`, 'item_missing', result)
            : { success: true, message: watch.findText([TRADE_COMPLETED])!, ...result };
    }

    private position(): Vec3 | null {
        const p = this.helpers.player();
        return p ? { x: p.x, y: p.y, z: p.z } : null;
    }

    /** NPC dialog from the current state when it is (newer than `after` and) from this NPC. */
    private dialogFrom(npc: NearbyNpc, after?: number): NpcDialog | null {
        const d = this.helpers.state()?.npcDialog;
        if (!d || (after !== undefined && d.receivedAt === after)) return null;
        return d.npcObjectId === npc.objectId || d.npcName?.toLowerCase() === npc.name.toLowerCase() ? d : null;
    }

    /** One dialog from every '<npc> says, "..."' line in `messages` (keywords from all of them), else `fallback`. */
    private mergeDialog(npc: NearbyNpc, messages: GameMessage[], fallback: NpcDialog | null): NpcDialog | null {
        const prefix = `${npc.name.toLowerCase()} `;
        const lines = messages.filter(m => m.text.toLowerCase().startsWith(prefix) && /\b(says|whispers|tells you)/i.test(m.text));
        if (lines.length === 0) return fallback;
        const texts = lines.map(m => /"([\s\S]*)"\s*$/.exec(m.text)?.[1] ?? m.text);
        const keywords: string[] = [];
        for (const t of texts) for (const k of t.matchAll(/\[([^\]]+)\]/g)) if (!keywords.includes(k[1]!)) keywords.push(k[1]!);
        return { npcObjectId: npc.objectId, npcName: npc.name, text: texts.join('\n'), keywords, receivedAt: lines[lines.length - 1]!.receivedAt };
    }


    /** Walk into melee range of an NPC or player (adopting its z), target it and face it. */
    private async engage(target: NearbyNpc | NearbyPlayer): Promise<ActionResult> {
        if (target.distance > MELEE_APPROACH) {
            const walk = await this.walkToObject(target, { range: MELEE_APPROACH });
            if (!walk.success) return { success: false, message: walk.message, reason: walk.reason ?? 'out_of_reach' };
        }
        const t = await this.sdk.sendSetTarget(target.objectId);
        if (!t.success) return t;
        return this.sdk.sendFaceObject(target.objectId);
    }

    private async useSkillObserved(name: string, skillIndex: number, confirm: RegExp[] | null, refusals: readonly string[]): Promise<SkillUseResult> {
        const watch = this.helpers.watch();
        const effects0 = this.sdk.getEffects().map(e => e.name).join('|');
        try {
            const r = await this.sdk.sendUseSkill(skillIndex);
            if (!r.success) return { ...r, name, messages: [] };
            // Without explicit confirm patterns, evidence is an answer about this skill: a message
            // naming it or a non-combat answer (combat spam must not count), or an effect change.
            const key = name.toLowerCase().split(/\s+/).find(w => w.length >= 4) ?? name.toLowerCase();
            const answers = (m: GameMessage) => m.text.toLowerCase().includes(key) || !COMBAT_CHAT_TYPES.has(m.type);
            const got = await this.helpers.waitFor(s => {
                if (watch.find(refusals)) return 'refused';
                if (confirm) return watch.find(confirm) ? 'ok' : null;
                return watch.messages().some(answers) || s.effects.map(e => e.name).join('|') !== effects0 ? 'ok' : null;
            }, 2500);
            // A refusal can trail the first answer by a snapshot.
            if (got === 'ok' && !confirm) await this.helpers.sleep(300);
            if (got === 'ok' && !confirm && watch.find(refusals)) {
                const messages = watch.messages().slice();
                return { ...fail(watch.findText(refusals)!, 'refused', {}), name, messages };
            }
            const messages = watch.messages().slice();
            if (got === 'refused') return { ...fail(watch.findText(refusals)!, 'refused', {}), name, messages };
            if (!got) return { ...fail(`No response using ${name}`, 'no_response', {}), name, messages };
            return { success: true, message: (confirm ? watch.find(confirm) : messages.find(answers))?.text ?? `Used ${name}`, name, messages };
        } finally {
            watch.dispose();
        }
    }

    private async moveObserved(item: InventoryItem, toSlot: number, done: (s: BotWorldState) => boolean, okMessage: string, saysDone?: string): Promise<ItemResult> {
        const watch = this.helpers.watch();
        try {
            const r = await this.sdk.sendMoveItem(item.slot, toSlot);
            if (!r.success) return { ...r, item, messages: [] };
            const got = await this.helpers.waitFor(s => done(s) || (saysDone && watch.find([saysDone])) ? 'ok' : watch.find(MOVE_REFUSALS) ? 'refused' : null, 3000);
            const messages = watch.messages().slice();
            if (got === 'ok') return { success: true, message: okMessage, item, messages };
            return { ...fail(got === 'refused' ? watch.findText(MOVE_REFUSALS)! : `No change observed for ${item.name}`, got === 'refused' ? 'refused' : 'timeout', {}), item, messages };
        } finally {
            watch.dispose();
        }
    }

    private async slotGone(item: InventoryItem, send: () => Promise<ActionResult>, okMessage: string): Promise<ItemResult> {
        const watch = this.helpers.watch();
        try {
            const r = await send();
            if (!r.success) return { ...r, item, messages: [] };
            const gone = await this.helpers.waitFor(s => !s.inventory.some(i => i.slot === item.slot && i.name === item.name && i.count === item.count), 3000);
            const messages = watch.messages().slice();
            return gone ? { success: true, message: okMessage, item, messages } : { ...fail(messages.at(-1)?.text ?? `${item.name} is still in slot ${item.slot}`, 'timeout', {}), item, messages };
        } finally {
            watch.dispose();
        }
    }

    /** Shared walk loop for walkTo / followPath / walkToObject. */
    private async route(dest: Point, via: Point[], options: Omit<WalkOptions, 'z'> & { z?: number }): Promise<WalkResult> {
        const tolerance = options.tolerance ?? 64;
        const s0 = this.helpers.state();
        const p0 = s0?.player;
        const at = (extra: Partial<WalkResult> = {}): WalkResult => {
            const p = this.helpers.player();
            return {
                success: false, message: '', position: p ? { x: p.x, y: p.y, z: p.z } : null,
                distance: p ? Math.round(Math.hypot(dest.x - p.x, dest.y - p.y)) : Infinity, reissues: 0, ...extra,
            };
        };
        if (![dest.x, dest.y].every(Number.isFinite) || via.some(w => ![w.x, w.y].every(Number.isFinite))) {
            return at({ message: `walkTo needs finite coordinates, got (${dest.x}, ${dest.y})`, reason: 'bad_args' });
        }
        if (!Number.isFinite(tolerance) || tolerance < 0) return at({ message: 'tolerance must be a non-negative number', reason: 'bad_args' });
        if (!p0 || !s0.inGame) return at({ message: 'Not in game', reason: 'not_in_game' });
        if (p0.isDead) return at({ message: 'Cannot walk while dead', reason: 'dead' });
        if (Math.hypot(dest.x - p0.x, dest.y - p0.y) <= tolerance && via.length === 0) {
            // Still heading somewhere else (an earlier sendMoveTo or follow): stay here.
            if (s0.movement.moving) await this.sdk.sendStop();
            return at({ success: true, message: 'Already at destination' });
        }

        // The slowest the route can be: the planner doesn't know which parts of it are water.
        const speed = (p0.maxSwimSpeed || 85) * (options.speedFactor ?? 1);
        const provider = options.pathProvider ?? getDefaultPathProvider();
        // An explicit timeout covers planning and never moves. The default is 1.5 × the swimming ETA
        // along the planned route + 15 s (stuckMs ends a stalled walk long before), set once a plan exists (navmesh detours can be several times
        // the straight distance) and extended when a correction re-plans a longer way.
        const started = Date.now();
        let deadline = options.timeout !== undefined ? started + options.timeout : 0;
        let reissues = 0;
        const timedOut = () => at({ message: `Walk timed out after ${Math.round(deadline - started)}ms`, reason: 'timeout', reissues });
        let remainingVia = via.slice();
        const plan = (from: Vec3) => withExecutionDeadline<Vec3[] | string | null>(options.timeout !== undefined ? deadline - Date.now() : PLAN_TIMEOUT_MS, async () => {
            const pts: Vec3[] = [];
            let cur = from;
            for (const leg of [...remainingVia, dest]) {
                const path = await provider.findPath({ regionId: p0.regionId, from: cur, to: leg });
                if (!path.success || path.waypoints.length === 0) return path.message ?? 'no path';
                pts.push(...path.waypoints);
                cur = pts[pts.length - 1]!;
            }
            if (options.timeout === undefined) deadline = Math.max(deadline, Date.now() + Math.round((routeLength(from, pts) / Math.max(30, speed)) * 1500 + 15_000));
            return pts;
        }, () => null);
        const planTimedOut = () => options.timeout !== undefined ? timedOut() : at({ message: `Path planning timed out after ${PLAN_TIMEOUT_MS}ms`, reason: 'timeout', reissues });

        const deathCount0 = p0.deathCount;
        const region0 = p0.regionId;
        const stuckMs = options.stuckMs ?? 8000;
        let remaining: Vec3[] = [];
        let best = Infinity;
        let lastProgressAt = 0;

        // One move until it ends: a result, a position to re-plan from (corrected), or undefined to re-issue.
        const leg = async (): Promise<WalkResult | Vec3 | undefined> => {
            const last = remaining[remaining.length - 1]!;
            const r = await this.sdk.sendMoveTo(last.x, last.y, last.z, { tolerance, waypoints: remaining.slice(0, -1), speedFactor: options.speedFactor });
            if (!r.success) return at({ message: `Move refused: ${r.message}`, reason: r.reason ?? 'dispatch_failed', reissues });
            // The move guard (stayDry) cut it at the bank: the end of what the mover got is not `dest`.
            const held = r.heldAt ?? null;
            // Wait until a snapshot shows the new move (or arrival) before reading stop reasons.
            await this.helpers.waitFor(s => s.movement.moving || (s.player && Math.hypot(dest.x - s.player.x, dest.y - s.player.y) <= tolerance), 2000);
            let lastSeenRemaining: Vec3[] = remaining;
            for (;;) {
                const s = await this.helpers.nextState(1000);
                const p = s?.player;
                if (!s || !p) return at({ message: 'Lost game state', reason: 'not_in_game', reissues });
                if (p.isDead || p.deathCount !== deathCount0) return at({ message: `Died en route to (${dest.x}, ${dest.y})`, reason: 'died', reissues });
                if (p.regionId !== region0) return at({ message: `Region changed to ${p.regionId} en route`, reason: 'region_changed', reissues });
                const d = Math.hypot(dest.x - p.x, dest.y - p.y);
                if (d <= tolerance + 2 && (!s.movement.moving || remainingVia.length === 0)) return at({ success: true, message: 'Arrived', reissues });
                if (s.movement.moving && s.movement.waypoints.length) lastSeenRemaining = s.movement.waypoints;
                // Progress is the route still ahead, not the straight distance: a path that
                // first leads away from the destination (followPath detours) is not stuck.
                const left = routeLength(p, lastSeenRemaining);
                if (left < best - 10) { best = left; lastProgressAt = Date.now(); }
                if (s.movement.moving) {
                    if (Date.now() - lastProgressAt > stuckMs) {
                        await this.sdk.sendStop();
                        const why = p.maxSpeed === 0 ? ' (max speed 0: rooted, stunned or overloaded)' : '';
                        return at({ message: `No progress for ${stuckMs}ms at (${p.x}, ${p.y})${why}`, reason: 'stuck', reissues });
                    }
                    continue;
                }
                // Stopped at the bank the guard held us at: a re-issue goes there again and "arrives" at once. Hibernia, rounds 139
                // and 172: 8 such re-issues in 2 s, then 'stuck', which the behaviours' water rules (noteWet, slotWet) don't read.
                if (held && Math.hypot(held.x - p.x, held.y - p.y) <= tolerance + 2) {
                    return at({ message: `(${Math.round(dest.x)}, ${Math.round(dest.y)}) is in deep water: held at the bank`, reason: 'water', reissues });
                }
                // Stopped short: corrected by the server, interrupted, or arrived outside tolerance.
                if (++reissues > 8) return at({ message: `Gave up after ${reissues - 1} re-issues at (${p.x}, ${p.y}); last stop: ${s.movement.lastStopReason}`, reason: 'stuck', reissues });
                if (Date.now() - lastProgressAt > stuckMs) return at({ message: `No progress for ${stuckMs}ms at (${p.x}, ${p.y})`, reason: 'stuck', reissues });
                if (s.movement.lastStopReason === 'teleported') {
                    // Corrected: re-plan from where the server put us, dropping vias already passed.
                    remainingVia = remainingVia.filter(w => lastSeenRemaining.some(r2 => Math.hypot(r2.x - w.x, r2.y - w.y) < 2));
                    return { x: p.x, y: p.y, z: p.z };
                }
                remaining = lastSeenRemaining.length ? lastSeenRemaining : remaining;
                return undefined;
            }
        };

        const walk = async (): Promise<WalkResult> => {
            const first = await plan({ x: p0.x, y: p0.y, z: p0.z });
            if (first === null) return planTimedOut();
            if (typeof first === 'string') return at({ message: `No path to (${dest.x}, ${dest.y}): ${first}`, reason: 'no_path' });
            remaining = first;
            lastProgressAt = Date.now();
            for (;;) {
                const r = await withExecutionDeadline<WalkResult | Vec3 | undefined>(deadline - Date.now(), leg, timedOut);
                if (r && 'success' in r) return r;
                if (!r) continue;
                // Re-planned outside the move's deadline, so the plan can extend it first.
                const replanned = await plan(r);
                if (replanned === null) return planTimedOut();
                if (typeof replanned === 'string') return at({ message: `No path after correction: ${replanned}`, reason: 'no_path', reissues });
                remaining = replanned;
                best = Infinity; // measured along the new route; the re-issue cap bounds repeated snaps
            }
        };
        let result: WalkResult;
        try {
            result = await walk();
        } catch (error) {
            // Cancelled (MCP cancel / runScript timeout): don't leave the mover running to the destination.
            // Unconditional: a moveTo may still be in flight when no snapshot shows us moving yet
            // (stopping an idle mover is a no-op). A caller with stopOnAbort may keep it going.
            let stop = true;
            try { stop = options.stopOnAbort?.() ?? true; } catch { /* stop */ }
            if (stop) await this.helpers.cleanup(() => this.sdk.sendStop());
            throw error;
        }
        if (!result.success && result.reason === 'timeout') await this.helpers.cleanup(() => this.sdk.sendStop());
        return result;
    }
}
