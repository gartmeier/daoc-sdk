// Bot SDK - porcelain layer (bot.*).
// Each method resolves its target, dispatches low-level sdk.send* actions and
// then OBSERVES evidence (position, HP, inventory, messages) before reporting
// success. Game failures come back as { success: false, reason } and never
// throw; only an execution abort (MCP cancel, runScript timeout) throws.

import { BotSDK, bestNameMatch, headingBetween, nameMatcher, type NamePattern } from './index';
import { throwIfExecutionAborted, withExecutionDeadline } from './execution-context';
import {
    ABILITY_REFUSALS,
    ActionHelpers,
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
    maxCombatEventId,
    NOTHING_TO_REPAIR,
    parseMoneyText,
    PICKUP_REFUSALS,
    PLAYER_AIM_MS,
    PVP_IMMUNE_REFUSALS,
    PVP_IMMUNE_RETRY_MS,
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
    STYLE_REFUSALS,
    TRAIN_REFUSALS,
    TRAINER_WANTED,
    TRADE_COMMIT_FAILURES,
    TRADE_COMPLETED,
    TRADE_REFUSALS,
    USE_ITEM_REFUSALS,
    describeTarget,
    firstTradeLine,
    totalCopper,
    type LivingTarget,
    type MessageWatch,
    type NpcTarget,
    type ObjectTarget,
    type PlayerTarget,
    type TradeLine,
    type Point,
} from './actions-helpers';
import { spellMessagePattern } from './actions-helpers';
import { getDefaultPathProvider, type PathProvider } from './pathfinding';
import { isDelveOf, parseDelve } from './delve';
import { botFolder, loadBuild } from './build';
import { findNpcSpawns, getClass, getSpell, getSpells, getZonePoint, realmId, specKey, type NpcSpawnMatch, type SpellInfo, type ZonePoint } from '../data/index';
import { buildProblems, freeLevels, linesOverTarget, nextBuildStep, type BuildState } from '../data/builds/rule';
import type { Build } from '../data/builds/types';
import type {
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
    PlayerState,
    Spell,
    Style,
    TradeWindow,
    Vec3,
} from './types';

export { conLevel, conColor, isKillable } from './actions-helpers';
export { parseDelve } from './delve';
export type { ConColor, LivingTarget, NpcTarget, ObjectTarget, PlayerTarget, Point } from './actions-helpers';
export { StraightLinePathProvider, NavmeshPathProvider, getDefaultPathProvider, setDefaultPathProvider, navmeshGroundZ } from './pathfinding';
export type { PathProvider, PathRequest, PathResult } from './pathfinding';
export { NavmeshStore, NavMesh, getNavmeshStore, PolyFlags } from './navmesh';
export { groundAt, GROUND_TUNING, type Ground } from './ground';
export { TerrainStore, getTerrainStore, type TerrainSample } from './terrain';

// Server ranges (world/WorldMgr.cs, GamePlayer.cs) and the margins we approach to.
const MELEE_APPROACH = 90;       // AttackRange 128 (+32 per moving side), 3D
const MELEE_RANGE = 128;
const MELEE_REAPPROACH = 118;
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
/** A 0xDD to an object has toSlot = 1000 + objectId (PlayerMoveItemRequestHandler.cs:20-23). */
const GIVE_TO_OBJECT = 1000;
/** No target has this many lines: a trainBuild past it isn't getting anywhere. */
const TRAIN_BUILD_MAX_STEPS = 32;
/** eInventorySlot.GeneralVault: the server picks an empty slot on the other side, or a partial stack (PlayerMoveItemRequestHandler.cs:306-337). A full side fails without a word. */
const GENERAL_VAULT_SLOT = 601;
/** Personal vault slots 110-149. */
const VAULT_SLOTS = 40;
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
    /** Stop chasing beyond this 2D distance from where the fight began (default 2500). */
    maxChaseDistance?: number;
    /** Allow NPCs isKillable() rejects (realm NPCs, peaceful flags) (default false). */
    force?: boolean;
}

export interface KillResult extends ActionResult {
    npc: NearbyNpc | null;
    killed: boolean;
    xpGained: number;
    rpGained: number;
    moneyGained: number;
    itemsGained: InventoryItem[];
    durationMs: number;
    levelsGained: number;
    stylesUsed: number;
    /** For reason 'immune' (PvP immunity, ours or the target's) and 'crowd_controlled' (we are mezzed or stunned): ms until trying again makes sense. */
    retryAfterMs?: number;
}

/** killPlayer's options: KillOptions' timeout, styles, chase and maxChaseDistance, with a style chooser for players. */
export interface KillPlayerOptions extends Omit<KillOptions, 'useStyle' | 'force'> {
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
    target: NearbyNpc | NearbyPlayer | NearbyObject | null;
    castTimeMs: number | null;
    /** The server reported the cast finished ("You cast a <spell> spell!", or an effect, damage or resist once the cast time is up). */
    completed: boolean;
    resisted: boolean;
    /**
     * The cast went off (success, power spent) but its effect did not land: "Your target is immune to
     * this effect!" (CCSpellHandler.cs:173/288, SpellHandler.cs:571). A player already mezzed or stunned,
     * or within the 60 s immunity that follows one (CrowdControlECSEffect.cs), an NPC's mezz immunity, a
     * snare immunity. `resisted` stays false: the target did not resist, nothing could have landed.
     */
    effectImmune?: boolean;
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
     * out; a damage shield's "You hit X for N damage!" in the same moment cannot be told apart.
     */
    damage: number;
    messages: GameMessage[];
    /** For reason 'must_wait' / 'interrupted' / 'immune' / 'crowd_controlled': ms until casting is allowed again ("You must wait N seconds"). */
    retryAfterMs?: number;
}

export interface SkillUseResult extends ActionResult {
    name: string;
    messages: GameMessage[];
}

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
    /** Rest when health falls below this between fights (default 50). */
    restBelowHealth?: number;
    /** Rest until this health (default 90). */
    restToHealth?: number;
    /** Also rest below this mana percent (casters). */
    restBelowMana?: number;
    /**
     * Total run time (default 180000 ms). No new target is pulled once less than
     * `minEngageMs` remains, and a fight still going at the deadline is given up
     * at most 30 s after it, so a run overshoots by at most about 30 s.
     */
    durationMs?: number;
    /**
     * Do not pull a new target when less than this much of `durationMs` remains
     * (default: the average kill time of this run, 15000 ms before the first kill,
     * at most half of `durationMs`).
     * Monsters already attacking us are still fought.
     */
    minEngageMs?: number;
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
    /** Called after each kill; return false to stop. */
    onKill?: (kill: KillResult, stats: GrindStats) => void | boolean | Promise<void | boolean>;
    killTimeout?: number;
    /**
     * Stop with stopReason 'no_targets' after this long near the anchor without a single
     * candidate (default 60000 ms; 0 or Infinity waits out the whole duration, e.g. for respawns).
     * Typical cause: everything around the anchor cons grey after levelling.
     */
    noTargetTimeoutMs?: number;
}

export interface GrindStats {
    kills: number;
    xpGained: number;
    deaths: number;
}

export interface GrindResult extends ActionResult {
    kills: number;
    failures: number;
    deaths: number;
    xpGained: number;
    rpGained: number;
    moneyGained: number;
    levelsGained: number;
    durationMs: number;
    /** 'no_targets': nothing in the con window around the anchor for `noTargetTimeoutMs`. */
    stopReason: 'duration' | 'maxKills' | 'died' | 'onKill' | 'no_targets' | 'error';
    killLog: { name: string; level: number; xp: number; durationMs: number }[];
}

// ── Internals ───────────────────────────────────────────────────────────────

type Obj = NearbyNpc | NearbyPlayer | NearbyObject;

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
type KillNumbers = Omit<KillResult, keyof ActionResult | 'npc' | 'retryAfterMs'>;

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
type FightOutcome = 'killed' | { message: string; reason: string; retryAfterMs?: number };

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
}

/** Message types that are combat/loot spam, never an answer to a skill or item use. */
const COMBAT_CHAT_TYPES = new Set<GameMessage['type']>(['youHit', 'otherCombat', 'damaged', 'resisted', 'yourDeath', 'otherDeath', 'spellPulse', 'loot', 'say', 'send', 'group', 'guild', 'broadcast', 'chat', 'emote']);

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
    if (isPvpImmunity(t)) return 'immune';
    if (isCrowdControlled(t)) return 'crowd_controlled';
    if (t.includes('you are dead')) return 'died'; // "You are dead and can't cast!" (SpellHandler.cs:881-884)
    if (t.includes('only works on dead members')) return 'not_dead'; // SpellHandler.cs:764: alive, or another realm's
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

function retryAfter(text: string): number | undefined {
    if (isPvpImmunity(text)) return PVP_IMMUNE_RETRY_MS;
    if (isCrowdControlled(text)) return CROWD_CONTROLLED_RETRY_MS;
    const m = /must wait (\d+(?:\.\d+)?) seconds?/i.exec(text);
    if (m) return Math.ceil(Number(m[1]) * 1000);
    return /interrupt/i.test(text) ? 2000 : undefined;
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

    /** Walk until within `range` (3D) of an NPC, player or object; follows a target that moves. */
    async walkToObject(target: ObjectTarget, options: WalkToObjectOptions = {}): Promise<WalkToObjectResult> {
        const range = options.range ?? 100;
        let obj = this.helpers.resolveAny(target);
        if (!obj) return { ...fail(`Target not found: ${describeTarget(target)}`, 'not_found', {}), position: this.position(), distance: Infinity, reissues: 0, target: null };
        let last: WalkResult = { success: true, message: 'Already in range', position: this.position(), distance: obj.distance2d, reissues: 0 };
        const tolerance = Math.max(16, Math.min(range * 0.6, range - 20));
        const deadline = options.timeout === undefined ? null : Date.now() + options.timeout;
        for (let attempt = 0; attempt < 4; attempt++) {
            if (obj.distance <= range) {
                return { ...last, success: true, message: `In range of ${obj.name} (${obj.distance})`, target: obj };
            }
            const left = deadline === null ? undefined : deadline - Date.now();
            if (left !== undefined && left <= 0) return { ...last, ...fail(`Walk to ${obj.name} timed out after ${options.timeout}ms`, 'timeout', {}), target: obj };
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
                if (!r.success) return { ...last, ...fail(`Cannot reach ${obj.name}: ${r.message}`, r.reason ?? 'dispatch_failed', {}), target: obj };
                const adopted = await this.helpers.waitFor(s => s.player && Math.abs(s.player.z - targetZ) <= 16 ? true : null, Math.min(2000, left ?? 2000));
                last = { success: true, message: 'Adopted target height', position: this.position(), distance: obj.distance2d, reissues: last.reissues };
                if (!adopted) break; // no layer near the target's height here: retrying won't find one
            } else {
                last = await this.route({ x: obj.x, y: obj.y, z: obj.z }, [], { tolerance, timeout: left });
            }
            if (!last.success) return { ...last, message: `Cannot reach ${obj.name}: ${last.message}`, target: obj };
            const fresh = this.helpers.resolveAny(obj.objectId);
            if (!fresh) return { ...last, ...fail(`${obj.name} disappeared`, 'not_found', {}), target: obj };
            obj = fresh;
        }
        return obj.distance <= range
            ? { ...last, success: true, message: `In range of ${obj.name} (${obj.distance})`, target: obj }
            : { ...last, ...fail(`Could not get within ${range} of ${obj.name} (at ${obj.distance})`, 'out_of_reach', {}), target: obj };
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
        return ok ? { success: true, message: `Targeted ${obj.name}`, target: obj } : { ...fail(`Target did not change to ${obj.name}`, 'timeout', {}), target: obj };
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
            if (!response) return { ...fail(`No response from ${obj.name}`, 'no_response', empty), target: fresh, messages: watch.messages().slice() };
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
     * the server's "Slow down!".
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
     * (with retryAfterMs) when PvP immunity, ours or the target's, refuses the swing, and
     * 'crowd_controlled' (with retryAfterMs) when we are mezzed or stunned.
     */
    async attack(target: LivingTarget, options: { timeout?: number } = {}): Promise<AttackResult> {
        const t = this.helpers.resolveLiving(target);
        if (!t) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', { npc: null, target: null });
        const targets = (o: NearbyNpc | NearbyPlayer) => ({ npc: o.kind === 'npc' ? o : null, target: o });
        // A player's health is truncated (GameLiving.cs:2621): one with a few hit points left reads 0 %.
        if (t.kind === 'player' ? t.isDead : t.healthPercent <= 0) return fail(`${t.name} is already dead`, 'already_dead', targets(t));
        // A name that matched no monster falls back to players: never one of our realm (a duel takes the id).
        if (t.kind === 'player' && (typeof target === 'string' || target instanceof RegExp) && t.realm === this.helpers.player()?.realm) {
            return fail(`${t.name} is a player of our realm`, 'not_attackable', targets(t));
        }
        const engaged = await this.engage(t);
        if (!engaged.success) return { ...engaged, ...targets(t) };
        const watch = this.helpers.watch();
        const baseline = maxCombatEventId(this.helpers.state());
        try {
            const r = await this.sdk.sendAttack(true);
            if (!r.success) return { ...r, ...targets(t) };
            const me = this.helpers.player()?.objectId;
            const swung = (s: BotWorldState) => s.combatEvents.some(e => e.id > baseline && e.kind === 'melee' && e.attackerObjectId === me && e.targetObjectId === t.objectId);
            let evidence = await this.helpers.waitFor(s => {
                if (watch.find(ATTACK_REFUSALS)) return 'refused';
                if (swung(s)) return 'swing';
                if (s.player?.attacking) return 'attacking';
                return null;
            }, options.timeout ?? 5000);
            // Attack mode comes on before the server checks the rules: a PvP refusal arrives with the
            // first swing round right after it (AttackComponent.cs:710, WeaponAction.cs:411). That round
            // also says "too far away" / "not in view" when the target stepped off (AttackComponent.cs:1725-1737):
            // retryable, so attack mode stands and fight() re-approaches.
            const fatal = () => watch.messages().find(m => isFatalAttackRefusal(m.text));
            if (evidence === 'attacking' && t.kind === 'player') {
                evidence = await this.helpers.waitFor(s => fatal() ? 'refused' : swung(s) ? 'swing' : null, 1000) ?? 'attacking';
            }
            if (evidence === 'refused') {
                const text = watch.findText(PVP_IMMUNE_REFUSALS) ?? watch.findText(CROWD_CONTROL_REFUSALS) ?? fatal()?.text ?? watch.findText(ATTACK_REFUSALS)!;
                if (isPvpImmunity(text)) return fail(text, 'immune', { ...targets(t), retryAfterMs: PVP_IMMUNE_RETRY_MS });
                if (isCrowdControlled(text)) return fail(text, 'crowd_controlled', { ...targets(t), retryAfterMs: CROWD_CONTROLLED_RETRY_MS });
                return fail(text, 'refused', targets(t));
            }
            if (!evidence) return fail(`No attack observed on ${t.name}`, 'timeout', targets(t));
            return { success: true, message: `Attacking ${t.name}`, ...targets(this.helpers.resolveLiving(t.objectId) ?? t) };
        } finally {
            watch.dispose();
        }
    }

    /**
     * Fight an NPC to the death: walk into melee range (adopting its z), face,
     * target, attack, re-approach when it moves, use styles, and wait for the
     * death (remove packet / 0 HP). Reports XP, RP, money, items and duration. Reason
     * 'crowd_controlled' (with retryAfterMs) when a mezz or stun refuses our swing.
     */
    async killNpc(target: NpcTarget, options: KillOptions = {}): Promise<KillResult> {
        const s0 = this.helpers.state();
        const p0 = s0?.player;
        const base = { npc: null as NearbyNpc | null, ...noKill() };
        if (!s0 || !p0) return fail('Not in game', 'not_in_game', base);
        if (p0.isDead) return fail('We are dead', 'dead', base);
        const n0 = this.helpers.resolveNpc(target);
        if (!n0) return fail(`NPC not found: ${describeTarget(target)}`, 'not_found', base);
        if (n0.healthPercent <= 0) return fail(`${n0.name} is already dead`, 'already_dead', { ...base, npc: n0 });
        if (!options.force && !isKillable(n0, p0)) return fail(`${n0.name} is not something we can kill (realm ${n0.realm}, role ${n0.role}, peaceful ${n0.isPeaceful})`, 'not_attackable', { ...base, npc: n0 });

        const useStyle = options.useStyle;
        const r = await this.fightToDeath<NearbyNpc>({
            first: n0,
            find: s => s.nearbyNpcs.find(n => n.objectId === n0.objectId),
            isDown: n => n.healthPercent <= 0,
            vanishedKilled: (lastHp, watch) => lastHp <= 20 || experienceFromMessages(watch.messages()) > 0,
            chooseStyle: useStyle && ((npc, player, state, styles) => useStyle({ npc, target: npc, player, state, styles })),
        }, s0, p0, options, async watch => {
            // XP, loot and money messages trail the remove packet.
            await this.helpers.waitFor(() => experienceFromMessages(watch.messages()) > 0 ? true : null, 2000);
            await this.helpers.sleep(400);
        }, k => ` (+${k.xpGained} xp)`);
        return { ...r, npc: n0 };
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
     * (beyond maxChaseDistance), 'refused', 'died', 'timeout'. Does not wait for XP after the
     * kill: rpGained counts the realm points that arrived by then.
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

        const useStyle = options.useStyle;
        const r = await this.fightToDeath<NearbyPlayer>({
            first: t0,
            find: s => s.nearbyPlayers.find(pl => pl.objectId === t0.objectId),
            isDown: pl => pl.isDead,
            // A player's death always comes as 0xAE to everyone in view (GamePlayer.cs:5901-5905).
            vanishedKilled: () => false,
            chooseStyle: useStyle && ((pl, player, state, styles) => useStyle({ target: pl, player, state, styles })),
        }, s0, p0, options, async () => {}, k => k.rpGained ? ` (+${k.rpGained} rp)` : '');
        return { ...r, player: t0 };
    }

    /** The fight both kill methods share: deadline, cleanup and what the fight gained. */
    private async fightToDeath<T extends NearbyNpc | NearbyPlayer>(
        foe: Foe<T>, s0: BotWorldState, p0: PlayerState, options: Omit<KillOptions, 'useStyle' | 'force'>,
        settle: (watch: MessageWatch) => Promise<void>, gains: (k: KillNumbers) => string,
    ): Promise<ActionResult & KillNumbers & { retryAfterMs?: number }> {
        const started = Date.now();
        const name = foe.first.name;
        const watch = this.helpers.watch();
        const timeout = options.timeout ?? 60_000;
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
                durationMs: Date.now() - started,
                levelsGained: p ? Math.max(0, p.level - p0.level) : 0,
                stylesUsed,
            };
        };
        // What fight() dispatched, set before each send: the snapshot trails dispatches (attack
        // mode only shows after the server's AttackMode echo), so cleanup must not rely on it.
        const sent = { attack: false, move: false };
        try {
            const outcome = await withExecutionDeadline<FightOutcome>(timeout,
                () => this.fight(foe, p0, watch, options, () => stylesUsed++, sent),
                () => ({ message: `Timed out after ${timeout}ms fighting ${name}`, reason: 'timeout' }));
            if (outcome !== 'killed') return { success: false, ...outcome, ...numbers(false) };
            await settle(watch);
            const result = numbers(true);
            return { success: true, message: `Killed ${name} in ${(result.durationMs / 1000).toFixed(1)}s${gains(result)}`, ...result };
        } finally {
            watch.dispose();
            // Also after a timeout or an abort: leave the bot neither swinging nor chasing.
            // Both are harmless when already idle (PlayerAttackRequestHandler.cs:23 StopAttack; the mover's stop is a no-op).
            if (sent.attack || this.helpers.player()?.attacking) await this.helpers.cleanup(() => this.sdk.sendAttack(false));
            if (sent.move || this.sdk.getMovement()?.moving) await this.helpers.cleanup(() => this.sdk.sendStop());
        }
    }

    private async fight<T extends NearbyNpc | NearbyPlayer>(
        foe: Foe<T>, p0: PlayerState, watch: MessageWatch, options: Omit<KillOptions, 'useStyle' | 'force'>,
        onStyle: () => void, sent: { attack: boolean; move: boolean },
    ): Promise<FightOutcome> {
        const name = foe.first.name;
        const id = foe.first.objectId;
        const chase = options.chase ?? true;
        const maxChase = options.maxChaseDistance ?? 2500;
        const origin = { x: p0.x, y: p0.y };
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

            const msgs = watch.messages();
            if (msgs.length > refusalsSeen) {
                const fresh = msgs.slice(refusalsSeen);
                refusalsSeen = msgs.length;
                for (const m of fresh) {
                    const text = m.text.toLowerCase();
                    if (text.includes('is already dead')) return lastHp <= 30 ? 'killed' : failWith(m.text, 'already_dead');
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
                if (Math.hypot(t.x - origin.x, t.y - origin.y) > maxChase) return failWith(`${name} ran beyond ${maxChase} units`, 'out_of_reach');
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
     * target when none is given. Selects the target every time (the server
     * drops it on death without telling the client) and re-selects and retries
     * once on "You must select a target" while that target is still there
     * (CastOptions.retryNoTarget). Observes the cast start ("You begin
     * casting", cast animation) and completion ("You cast a <spell> spell!", or
     * an effect/damage/resist once the cast time is up). Reason 'died' when we
     * die mid-cast; 'dead' when already dead before casting; 'crowd_controlled'
     * (with retryAfterMs) when we are mezzed, stunned or silenced. A cast whose
     * target is immune to its effect succeeds with effectImmune.
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
        // The target to (re)select before casting. Always sent, never skipped because the model
        // already shows it: the server clears TargetObject on our death without telling the client
        // (GamePlayer.cs:5743 and :5900; GameLiving.cs:2842 is a plain property, no SendChangeTarget),
        // so after a release the model can still hold a target the server no longer has.
        let targetId: number | null = null;
        if (kind === 'self') {
            // Self buffs: no approach, keep the current target.
        } else if (friendly && (noTarget || target === player.objectId)) {
            // Heals/buffs default to ourselves ("You must select a target for this spell!" otherwise).
            targetId = player.objectId;
        } else if (!noTarget) {
            obj = this.helpers.resolveAny(target!);
            if (!obj) return fail(`Target not found: ${describeTarget(target)}`, 'not_found', { ...base, spell: sp });
            if (friendly && obj.kind !== 'object' && obj.realm !== player.realm) {
                return fail(`${sp.name} targets ${info!.target}, not the enemy ${obj.name}`, 'invalid_target', { ...base, spell: sp, target: obj });
            }
        } else if (player.targetObjectId !== null) {
            obj = this.sdk.getObject(player.targetObjectId);
        }
        if (obj) {
            const range = options.range ?? (info && info.range > 0 ? info.range : DEFAULT_SPELL_RANGE);
            if (obj.distance > range && options.approach !== false) {
                const walk = await this.walkToObject(obj, { range: Math.max(100, range * 0.85) });
                if (!walk.success) return { ...fail(walk.message, walk.reason ?? 'out_of_reach', base), spell: sp, target: obj };
                obj = walk.target ?? obj;
            }
            if (obj.objectId !== player.objectId) targetId = obj.objectId;
        }
        const baseline = maxCombatEventId(this.helpers.state());
        if (targetId !== null) await this.sdk.sendSetTarget(targetId);
        const p = this.helpers.player()!;
        if (p.isSitting) await this.sdk.sendSit(false);
        if (this.sdk.getMovement()?.moving) await this.sdk.sendStop();
        if (obj && obj.objectId !== p.objectId) await this.sdk.sendFaceObject(obj.objectId);

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
            /** 'cast' = "You cast a <spell> spell!" (SpellHandler.cs:1337); 'hit' = weaker evidence after landing. */
            const evidence = (s: BotWorldState): 'cast' | 'hit' | null => {
                if (watch.messages().some(m => /^you cast an? /i.test(m.text) && m.text.toLowerCase().includes(spellName))) return 'cast';
                for (const m of landed(s)) {
                    if (/extra damage|for an additional/i.test(m.text)) continue; // damage add / procs
                    const named = /^your (.+?) (?:critically )?hits .+? for \d+/i.exec(m.text);
                    if (named) {
                        if (named[1]!.toLowerCase() === spellName) return 'hit';
                        continue; // another spell's DoT tick
                    }
                    if (/^you hit .+? for \d+/i.test(m.text) || /resists the|resist the effect|your target is immune/i.test(m.text)) return 'hit';
                }
                const t = landsAt(s);
                return s.combatEvents.some(e => e.id > baseline && e.kind === 'spellEffect' && e.attackerObjectId === me && e.receivedAt >= t) ? 'hit' : null;
            };
            const died = (s: BotWorldState) => !!s.player && (s.player.isDead || s.player.deathCount !== deathCount0);
            // InterruptSpellCast (0x0B) names the interrupted caster.
            const interruptEvent = (s: BotWorldState) => s.combatEvents.some(e => e.id > baseline && e.kind === 'interrupt' && e.attackerObjectId === me);
            const refusal = (s: BotWorldState): string | null => watch.findText(CAST_REFUSALS) ?? (interruptEvent(s) ? 'Your spell is interrupted.' : null);
            const msgs = () => watch.messages().slice();
            const diedResult = (castTimeMs: number | null) => fail(`Died while casting ${sp.name}`, 'died', { ...base, castTimeMs, messages: msgs() });

            const started = await this.helpers.waitFor<'died' | 'refused' | 'cast' | 'hit' | 'started'>(s => {
                if (died(s)) return 'died';
                if (refusal(s)) return 'refused';
                const e = evidence(s);
                if (e) return e;
                if (castEvent(s) || watch.find(['you begin casting'])) return 'started';
                return null;
            }, 3000);
            if (started === 'died') return diedResult(null);
            if (started === 'refused') {
                const text = refusal(this.helpers.state()!)!;
                return { ...fail(text, castFailureReason(text), base), messages: msgs(), retryAfterMs: retryAfter(text) };
            }
            if (!started) return fail(`No cast observed for ${sp.name}`, 'no_response', { ...base, messages: msgs() });
            const castTimeMs = castEvent(this.helpers.state()!)?.castTimeMs ?? null;
            let done: 'cast' | 'hit' | null = started === 'started' ? null : started;
            if (!done) {
                const end = await this.helpers.waitFor<'died' | 'refused' | 'cast' | 'hit'>(s => {
                    if (died(s)) return 'died';
                    if (refusal(s)) return 'refused';
                    return evidence(s);
                }, (castTimeMs ?? (info ? info.castTime * 1000 : 3000)) + (options.timeout ?? 2500));
                if (end === 'died') return diedResult(castTimeMs);
                if (end === 'refused') {
                    const text = refusal(this.helpers.state()!)!;
                    return { ...fail(text, castFailureReason(text, 'interrupted'), base), castTimeMs, messages: msgs(), retryAfterMs: retryAfter(text) };
                }
                done = end;
            }
            await this.helpers.sleep(250);
            const s = this.helpers.state()!;
            if (died(s) && done !== 'cast') return diedResult(castTimeMs);
            if (done === 'hit') {
                // Weak evidence: an interrupt that landed right behind it still means no cast.
                const late = refusal(s);
                if (late) return { ...fail(late, castFailureReason(late, 'interrupted'), base), castTimeMs, messages: msgs(), retryAfterMs: retryAfter(late) };
            }
            const messages = msgs();
            const ours = landed(s).filter(m => !/extra damage/i.test(m.text));
            const resisted = ours.some(m => /resists the|resist the effect/i.test(m.text));
            let damage = 0;
            for (const m of ours) {
                const hit = /^(?:you hit .+?|your (.+?) hits .+?) for (\d+)/i.exec(m.text);
                if (hit && (hit[1] === undefined || hit[1].toLowerCase() === spellName)) damage += Number(hit[2]);
                const crit = /^you critically hit for an additional (\d+)/i.exec(m.text);
                if (crit) damage += Number(crit[1]);
            }
            if (!done) return fail(`${sp.name} started but no completion was observed`, 'timeout', { ...base, castTimeMs, messages });
            // Sent right after "You cast a ..." when the effect can't take (CCSpellHandler.CheckSpellResist).
            const effectImmune = ours.some(m => /your target is immune to this effect/i.test(m.text));
            const alreadyOn = ours.some(m => /already has that effect/i.test(m.text));
            const starts = info?.effectStarts?.includes('{0}') ? spellMessagePattern(info.effectStarts) : null;
            // Another member's line of the same spell can come first: a monster's name must match (a player's is its real one, which we don't see).
            const npcName = obj && 'kind' in obj && obj.kind === 'npc' ? obj.name.toLowerCase() : null;
            const landedLine = starts && !resisted && !effectImmune && !alreadyOn ? await this.helpers.waitFor(st => {
                for (const m of landed(st)) {
                    const hit = starts.exec(m.text);
                    if (hit && (!npcName || hit[1]!.toLowerCase().endsWith(npcName))) return hit;
                }
                return null;
            }, 500) : null;
            const outcome = resisted ? ' (resisted)' : effectImmune ? ' (target immune)' : alreadyOn ? ' (already has it)' : damage ? ` for ${damage} damage` : '';
            return {
                success: true, message: `Cast ${sp.name}${obj ? ` on ${obj.name}` : ''}${outcome}`,
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
        return this.useSkillObserved(style.name, style.skillIndex, [/you prepare to perform/i, /preparing to perform/i, /you perform your/i], STYLE_REFUSALS);
    }

    /** Use an ability (e.g. Sprint); success when the server answers without a refusal or an effect appears. */
    async useAbility(name: NamePattern): Promise<SkillUseResult> {
        const ability = this.sdk.findAbility(name);
        if (!ability) return fail(`Ability not found: ${describeTarget(name)}`, 'not_found', { name: String(name), messages: [] });
        return this.useSkillObserved(ability.name, ability.skillIndex, null, ABILITY_REFUSALS);
    }

    /**
     * Best monster to fight nearby: killable, not engaged with someone else,
     * within the con (or level-difference) window, nearest first.
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
        return s.nearbyNpcs
            .filter(n => {
                if (exclude.has(n.objectId) || !isKillable(n, p) || !matches(n.name)) return false;
                if (n.healthPercent < 100 && !onUs.has(n.objectId) && !options.includeEngaged) return false;
                if (!options.includeEngaged && n.targetObjectId !== null && n.targetObjectId !== p.objectId) return false;
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

    /** In combat: attack mode on, recently hit, an NPC is fighting us (getAttackers) or an enemy player hit us (getPlayerAttackers). */
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

    /** Sit until health (and optionally mana/endurance) reach the thresholds, then stand. Fails if attacked. */
    async rest(options: RestOptions = {}): Promise<RestResult> {
        const started = Date.now();
        const hp = options.healthPercent ?? 90;
        const done = (p: PlayerState) => p.healthPercent >= hp &&
            (options.manaPercent === undefined || p.maxMana === 0 || p.manaPercent >= options.manaPercent) &&
            (options.endurancePercent === undefined || p.endurancePercent >= options.endurancePercent);
        const result = (success: boolean, message: string, reason?: string): RestResult => {
            const p = this.helpers.player();
            return { success, message, reason, healthPercent: p?.healthPercent ?? 0, manaPercent: p?.manaPercent ?? 0, endurancePercent: p?.endurancePercent ?? 0, durationMs: Date.now() - started };
        };
        const p0 = this.helpers.player();
        if (!p0) return result(false, 'Not in game', 'not_in_game');
        if (p0.isDead) return result(false, 'We are dead', 'dead');
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
                    if (done(p)) return result(true, `Rested to ${p.healthPercent}% health`);
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
            }, () => result(false, `Rest timed out at ${this.helpers.player()?.healthPercent}% health`, 'timeout'));
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

    /** Release after death (retrying until the server allows it) and observe being alive at the bind point. */
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
                    const alive = await this.helpers.waitFor(s => {
                        if (s.player && !s.player.isDead) return 'alive';
                        const refusal = watch.messages().slice(mark).find(m => RELEASE_REFUSALS.some(x => m.text.toLowerCase().includes(x)));
                        return refusal ? 'wait' : null;
                    }, 5000);
                    if (alive === 'alive') break;
                    await this.helpers.sleep(2000);
                }
                await this.helpers.waitFor(s => s.player && (Math.hypot(s.player.x - p0.x, s.player.y - p0.y) > 50 || s.player.regionId !== p0.regionId), 5000);
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
        if (!cast.success) return fail(cast.message, cast.reason ?? 'refused', { ...base, cast });
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
     * changing, or a new effect, and no refusal in the following ~400 ms.
     */
    async useItem(target: InventoryItem | NamePattern | number, options: { useType?: number } = {}): Promise<ItemResult> {
        const item = this.resolveUsableItem(target);
        if (!item) return fail(`Item not found: ${describeTarget(target)}`, 'not_found', { item: null, messages: [] });
        const equipped = item.slot < 40;
        const name = item.name.toLowerCase();
        const watch = this.helpers.watch();
        const effects0 = this.sdk.getEffects().map(e => e.name).join('|');
        const refusalOf = (msgs: GameMessage[]) => msgs.find(m => USE_ITEM_REFUSALS.some(x => m.text.toLowerCase().includes(x)));
        try {
            const r = await this.sdk.sendUseItem(item.slot, options.useType);
            if (!r.success) return { ...r, item, messages: [] };
            const got = await this.helpers.waitFor(s => {
                const msgs = watch.messages();
                if (refusalOf(msgs)) return 'refused';
                if (msgs.some(m => m.text.toLowerCase().includes(name))) return 'message';
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
            if (refusal) return { ...fail(refusal.text, 'refused', {}), item, messages };
            if (!got) return { ...fail(`No response using ${item.name}`, 'no_response', {}), item, messages };
            const named = messages.find(m => m.text.toLowerCase().includes(name));
            return { success: true, message: named?.text ?? `Used ${item.name}`, item, messages };
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
                if (firstTradeLine(watch.messages(), REPAIR_REFUSALS)) return 'refused' as const;
                return s.dialog?.isOpen && s.dialog.receivedAt !== box0 && REPAIR_OFFER.test(s.dialog.text) ? s.dialog : null;
            }, timeout);
            if (box === 'refused') {
                const line = firstTradeLine(watch.messages(), REPAIR_REFUSALS)!;
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
            const answer = await this.helpers.waitFor(() => firstTradeLine(watch.messages(), REPAIR_ANSWERS), 4000);
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
        const target = spec0.level + Math.max(1, Math.floor(levels));
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
            if (win !== 'refused') {
                const ts = win ? bestNameMatch(win.specs, spec0.name) : null;
                if (ts) await this.sdk.sendTrainSpec(ts.index, target - ts.level);
                // /train takes a key prefix (train.cs:57-66): 'Light Magic' isn't one, 'Light' is.
                else await this.sdk.sendCommand(`/train ${specKey(spec0.name)} ${target}`);
            }
            const got = await this.helpers.waitFor(s => {
                if (watch.find(TRAIN_REFUSALS)) return 'refused';
                const now = s.skills.specializations.find(x => x.name === spec0.name);
                return now && now.level >= target ? 'trained' : null;
            }, 4000);
            const now = this.sdk.getSkills().specializations.find(x => x.name === spec0.name);
            const extra = { spec: spec0.name, fromLevel: spec0.level, toLevel: now?.level ?? spec0.level, specPointsLeft: this.helpers.player()?.specPoints ?? 0 };
            if (got === 'trained') return { success: true, message: `Trained ${spec0.name} ${spec0.level} → ${extra.toLevel}`, ...extra };
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

    /** What the build rule reads. Autotrain is the current class's: a base class has none. */
    private buildState(): BuildState | null {
        const p = this.helpers.player();
        return p && { level: p.level, specs: this.sdk.getSkills().specializations, points: p.specPoints, autotrain: getClass(p.className, p.realm)?.autotrainSpecs };
    }

    /**
     * Spend the points on a build, as far as they reach: the rule in data/builds/rule.ts names each line and trainSpec
     * raises it, at a trainer of the class or, with `null`, where the character stands (trainSpec). Without `build` it is
     * the bot's own `bots/<bot>/build.ts` (loadBuild in sdk/build.ts), and a broken file throws. Success means it stopped
     * for a good reason: `done` (nothing to raise at this level) or `waiting` (the next line costs more than there is, and
     * the points stay banked for it). `done` sends nothing. Before `waiting` with nothing raised it talks once to a trainer
     * in reach, because a promotion sends no points and player.specPoints can still be the base class's number. A trainer
     * out of reach or not found gets nothing, and the number stands. A base class trains the lines it has of its advanced
     * class's build. Reasons: `no_build`, `invalid_build` (buildProblems of a build passed in), `wrong_class`,
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
        for (let i = 0; i < TRAIN_BUILD_MAX_STEPS; i++) {
            const state = this.buildState();
            if (!state) return failed('Not in game', 'not_in_game', null);
            const step = nextBuildStep(chosen, state);
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
            if (!r.success) return failed(r.message, r.reason ?? 'refused', this.buildState());
        }
        return failed(`Still training after ${TRAIN_BUILD_MAX_STEPS} steps`, 'too_many_steps', this.buildState());
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
     * by the zone's realm) has no zone point in the dump.
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
     * `noTargetTimeoutMs` (default 60 s) without any candidate.
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
        let idleSince: number | null = null;
        const finish = (stopReason: GrindResult['stopReason'], message?: string): GrindResult => {
            const p = this.helpers.player();
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
            result.message = message ?? `${result.kills} kills, +${result.xpGained} xp, ${stats.deaths} deaths in ${Math.round(result.durationMs / 1000)}s (${stopReason})`;
            if (!result.success) result.reason = stopReason === 'died' || stopReason === 'no_targets' ? stopReason : result.kills === 0 ? 'no_kills' : stopReason;
            return result;
        };

        // Pulling a new target needs about one kill's time; a fight in progress at the
        // deadline may run this much past it before killNpc gives up.
        const FIGHT_OVERRUN_MS = 30_000;
        // Capped at half the run so a short grind still fights.
        const minEngage = (): number => options.minEngageMs
            ?? Math.min(duration / 2, result.killLog.length > 0 ? result.killLog.reduce((s, k) => s + k.durationMs, 0) / result.killLog.length : 15_000);
        const remaining = (): number => deadline - Date.now();
        // Walks back to the anchor share the run's deadline (at least 5 s, to make progress).
        const backToAnchor = () => this.walkTo(anchor.x, anchor.y, { z: anchor.z, tolerance: 150, timeout: Math.max(5000, remaining()) });

        let deathCountSeen = p0.deathCount;
        while (Date.now() < deadline) {
            throwIfExecutionAborted();
            const p = this.helpers.player();
            if (!p) return finish('error', 'Lost game state');
            // deathCount also catches a death the server auto-released ("release automatically
            // in 8 more seconds") while we were busy looting, resting or in onKill.
            if (p.isDead || p.deathCount !== deathCountSeen) {
                stats.deaths += Math.max(1, p.deathCount - deathCountSeen);
                deathCountSeen = p.deathCount;
                if (!options.respawn) return finish('died');
                const rel = p.isDead ? await this.releaseAndRespawn() : null;
                if (rel && !rel.success && rel.reason !== 'not_dead') return finish('error', `Could not respawn: ${rel.message}`);
                if (remaining() > minEngage()) await backToAnchor();
                continue;
            }
            for (const [id, until] of avoid) if (until < Date.now()) avoid.delete(id);

            // A failed fight rules out a mob hitting us from where we can't get at it, not one in melee range.
            // Its target doesn't tell them apart: the client shows a spell's hit as its target until its next update.
            const attackers = this.getAttackers();
            let target = attackers.find(n => n.distance <= MELEE_RANGE || !avoid.has(n.objectId)) ?? null;
            // Too little time left to pull, walk back or rest: stop rather than overshoot.
            if (!target && remaining() < minEngage()) break;
            if (!target) {
                const lowMana = options.restBelowMana !== undefined && p.maxMana > 0 && p.manaPercent < options.restBelowMana;
                const hurt = p.healthPercent < restBelow || lowMana;
                if (hurt && !attackers.length) {
                    const rested = await this.rest({ healthPercent: restTo, manaPercent: lowMana ? Math.min(100, options.restBelowMana! + 40) : undefined, timeout: Math.max(5000, Math.min(120_000, deadline - Date.now())) });
                    if (!rested.success && rested.reason !== 'attacked') await this.helpers.sleep(1000);
                    idleSince = null; // resting is not idling: count the search time afresh
                    continue;
                }
                if (Math.hypot(p.x - anchor.x, p.y - anchor.y) > radius) {
                    await backToAnchor();
                    continue;
                }
                // Hurt under fire from a mob ruled out: rest refuses, and no new fight now. It waits for no_targets, the deadline or that mob's 60 s to run out.
                if (!hurt) target = this.findKillableNpc({
                    pattern: options.pattern, maxLevelDiff: options.maxLevelDiff, minLevelDiff: options.minLevelDiff,
                    minCon: options.minCon, maxCon: options.maxCon, radius, from: anchor, exclude: avoid.keys(),
                });
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
                    return finish('no_targets', `No killable target (${window}, level ${p.level}) within ${radius} of the anchor for ${Math.round(idle / 1000)}s; ${result.kills} kills so far`);
                }
                const untilIdleStop = noTargetTimeout > 0 ? noTargetTimeout - idle : Infinity;
                await this.helpers.sleep(Math.max(0, Math.min(3000, deadline - Date.now(), untilIdleStop)));
                continue;
            }
            idleSince = null;
            const killTimeout = Math.min(options.killTimeout ?? 60_000, Math.max(0, remaining()) + FIGHT_OVERRUN_MS);
            const kill = await this.killNpc(target, { timeout: killTimeout, styles: options.styles, useStyle: options.useStyle, force: true });
            if (kill.killed) {
                result.kills++;
                stats.kills++;
                stats.xpGained += kill.xpGained;
                result.killLog.push({ name: target.name, level: target.level, xp: kill.xpGained, durationMs: kill.durationMs });
                if (options.loot !== false && !this.isDead()) await this.lootNearby({ radius: 400, settleMs: 300 });
                const keepGoing = await options.onKill?.(kill, { ...stats });
                if (keepGoing === false) return finish('onKill');
                if (options.maxKills !== undefined && result.kills >= options.maxKills) return finish('maxKills');
            } else {
                result.failures++;
                if (kill.reason !== 'died') avoid.set(target.objectId, Date.now() + 60_000);
            }
        }
        // A death in the last fight (killNpc ran past the deadline) is otherwise never counted.
        const pEnd = this.helpers.player();
        if (pEnd && (pEnd.isDead || pEnd.deathCount !== deathCountSeen)) {
            stats.deaths += Math.max(1, pEnd.deathCount - deathCountSeen);
            if (!options.respawn) return finish('died');
        }
        // respawn promises a living bot: release a death from the last fight before returning.
        if (options.respawn && this.helpers.player()?.isDead) {
            const rel = await this.releaseAndRespawn();
            if (!rel.success && rel.reason !== 'not_dead') return finish('error', `Could not respawn: ${rel.message}`);
        }
        return finish('duration');
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
                    const got = await this.helpers.waitFor<TradeWindow | TradeLine>(
                        s => s.trade && done(s.trade) ? s.trade : firstTradeLine(watch.messages().slice(mark), TRADE_REFUSALS),
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
                const bad = firstTradeLine(watch.messages(), TRADE_COMMIT_FAILURES);
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
        const speed = (p0.maxSwimSpeed || 85) * (options.speedFactor ?? 0.9);
        const provider = options.pathProvider ?? getDefaultPathProvider();
        // An explicit timeout covers planning and never moves. The default is 1.5 × the swimming ETA
        // along the planned route + 15 s (stuckMs ends a stalled walk long before), set once a plan exists (navmesh detours can be several times
        // the straight distance) and extended when a correction re-plans a longer way.
        const started = Date.now();
        let deadline = options.timeout !== undefined ? started + options.timeout : 0;
        let reissues = 0;
        const timedOut = () => at({ message: `Walk timed out after ${deadline - started}ms`, reason: 'timeout', reissues });
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
            // (stopping an idle mover is a no-op).
            await this.helpers.cleanup(() => this.sdk.sendStop());
            throw error;
        }
        if (!result.success && result.reason === 'timeout') await this.helpers.cleanup(() => this.sdk.sendStop());
        return result;
    }
}
