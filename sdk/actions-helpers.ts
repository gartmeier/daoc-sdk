// Portions (ConLevelGrid, refusal texts) ported from OpenDAoC (https://github.com/OpenDAoC/OpenDAoC-Core), GPL; see LICENSES/OpenDAoC-GPL-3.0.txt.
// Bot SDK - action helpers: target resolution, message watching, refusal
// scanning, con levels and inventory/money deltas used by BotActions.

import { BotSDK, bestNameMatch, distanceBetween, isAttackable, nameMatcher, type NamePattern } from './index';
import { executionContext, executionWait, throwIfExecutionAborted } from './execution-context';
import type {
    BotWorldState,
    GameMessage,
    InventoryItem,
    NearbyNpc,
    NearbyObject,
    NearbyPlayer,
    PlayerState,
    Vec3,
} from './types';

// ── Refusals (lowercase substrings of server messages) ──────────────────────
// Sources: GameServer/language/EN/*.txt and spells/SpellHandler.cs.

/**
 * PvP immunity (AbstractServerRules.IsAllowedToAttack, AbstractServerRules.cs:350-375), for melee
 * and spells alike: ours ("You can't attack players until your PvP invulnerability timer wears
 * off!") or the target's ("X is temporarily immune to PvP attacks!", "X is entering the game and
 * cannot be attacked!"). Under this server's Normal rules (GAME_TYPE in docker-compose.yml) the
 * timers run 10 s after entering the game (TIMER_GAME_ENTERED), a region change (TIMER_REGION_CHANGED,
 * the port into a battleground) and a release (TIMER_KILLED_BY_MOB, AbstractServerRules.OnReleased:257;
 * a same-region release fires Released at once, GamePlayer.cs:1690-1697). A teleport within the region
 * starts none: TIMER_PVP_TELEPORT is used only by the PvP rules (PvPServerRules.OnPlayerTeleport:90).
 * So these mean "try again shortly", not "never". Anchored to the refusals: the notice that ours
 * ended ("Your temporary PvP invulnerability timer has expired.", AbstractServerRules.cs:301) is none.
 */
export const PVP_IMMUNE_REFUSALS = [
    'until your pvp invulnerability timer wears off',
    'is temporarily immune to pvp attacks',
    'is entering the game and cannot be attacked',
] as const;

/** retryAfterMs reported with reason 'immune'. */
export const PVP_IMMUNE_RETRY_MS = 2000;

export function isPvpImmunity(text: string): boolean {
    const t = text.toLowerCase();
    return PVP_IMMUNE_REFUSALS.some(r => t.includes(r));
}

/**
 * Refusals because we are crowd-controlled: mesmerized or stunned, for melee (AttackComponent.cs:495-505;
 * GamePlayer.txt:36-37) and spells (PlayerCastingComponent.cs:44-53; Spells.txt:18-19), and silenced
 * for spells ("You are fumbling for your words, and cannot cast!", Spells.txt:20). The effect wears
 * off by itself, so retrying every moment only repeats the refusal: reason 'crowd_controlled' with
 * retryAfterMs CROWD_CONTROLLED_RETRY_MS.
 */
export const CROWD_CONTROL_REFUSALS = [
    "you can't attack when you are mesmerized",
    "you can't attack when you are stunned",
    "you can't cast while mesmerized",
    "you can't cast while stunned",
    'you are fumbling for your words',
] as const;

/** retryAfterMs reported with reason 'crowd_controlled'. */
export const CROWD_CONTROLLED_RETRY_MS = 2000;

export function isCrowdControlled(text: string): boolean {
    const t = text.toLowerCase();
    return CROWD_CONTROL_REFUSALS.some(r => t.includes(r));
}

/**
 * An enemy player's swing or hostile spell counts as aimed at its target this long. The server never
 * sends another player's target, only its swings, and a swing round lasts the weapon's speed
 * (AttackComponent.AttackSpeed): two-handed weapons and bows of levels 18-26 mostly swing every
 * 4-5.4 s (SPD_ABS 40-54 in itemtemplate.sql), so a shorter window drops the target between two
 * swings at the same victim. attackers() keeps an NPC on us this long after a hit too.
 */
/** A spell's message template (Message1..4) as a pattern on what the client reads; `{0}` captures the name. */
export function spellMessagePattern(template: string): RegExp {
    return new RegExp(`^${template.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{0\\}', '(.+?)')}$`, 'i');
}

export const PLAYER_AIM_MS = 6000;

/** Melee refusals: GamePlayer.Attack.*, Skill.Ability.*, AbstractServerRules. */
export const ATTACK_REFUSALS = [
    ...PVP_IMMUNE_REFUSALS,
    "can't see your target",
    'is not in view',
    'target is not in view',
    'is too far away to attack',
    'you are too far away to attack',
    "you can't attack",
    'you cannot attack',
    'is already dead',
    'you must have a target',
    "can't attack when you are",
    "you can't do that while dead",
    'you have not selected a valid',
] as const;

/** Refusals that mean "turn / step closer and try again". */
export const RETRYABLE_ATTACK_REFUSALS = [
    "can't see your target",
    'is not in view',
    'is too far away to attack',
    'you are too far away to attack',
] as const;

/** An ATTACK_REFUSALS text that is not a RETRYABLE_ATTACK_REFUSALS one: the attack is off. */
export function isFatalAttackRefusal(text: string): boolean {
    const t = text.toLowerCase();
    return ATTACK_REFUSALS.some(r => t.includes(r)) && !RETRYABLE_ATTACK_REFUSALS.some(r => t.includes(r));
}

/** Spell refusals and interruptions (SpellHandler.cs, CastingComponent.cs). */
export const CAST_REFUSALS = [
    "you can't cast while sitting",
    "you don't have enough power",
    'you do not have enough power',
    'you have exhausted all of your power',
    'you must select a target for this spell',
    'your target is not visible',
    'that target is too far away',
    "you can't see your target",
    'you must wait',
    'you are dead and can\'t cast',
    ...CROWD_CONTROL_REFUSALS,
    'you move and interrupt your spellcast',
    'your spell was cancelled',
    'invalid target',
    "you can't attack",
    'you cannot attack',
    ...PVP_IMMUNE_REFUSALS,
    'is interrupted',
    'this spell requires',
    'you cannot cast this spell directly',
    'you must have a pet summoned',
    "you're phaseshifted",
    'this spell only works on dead members',
    'is already considering a resurrection',
] as const;

/**
 * What a rez costs: a share of the caster's full power by the level gap, half at equal level, whatever the
 * spell's power column says (ResurrectSpellHandler.PowerCost, :63-70). Paid when the cast ends, refunded on a "no".
 */
export function resurrectCost(maxMana: number, casterLevel: number, targetLevel: number): number {
    return Math.trunc(maxMana * Math.max(0.1, 0.5 + (targetLevel - casterLevel) / casterLevel));
}

/** Style refusals (StyleProcessor.TryToUseStyle.*). */
export const STYLE_REFUSALS = [
    'you are too fatigued',
    'you must have a target for your next attack style',
    'you must perform the',
    'this style requires',
    'you must be dual wielding',
    'you are already preparing to use this style',
    'you have already selected your styles',
    "you can't enter combat mode",
    "you can't enter melee combat mode",
] as const;

/** Ability refusals (Skill.Ability.*, GamePlayer.Sprint.*). */
export const ABILITY_REFUSALS = [
    "you can't",
    'you cannot',
    'you must',
    'is too far away',
    'too far away from your target',
    'you are not',
] as const;

/**
 * Item use refusals (GamePlayer.UseSlot, GamePlayer.cs:6528ff; language/EN/GameObjects/GameObject.txt:44-53,
 * GamePlayer.txt:130/206/254). A charged item's spell can also be refused like a cast (CAST_REFUSALS).
 */
export const USE_ITEM_REFUSALS = [
    "you can't fire or use this item",
    'illegal source object',
    'is out of charges',
    'not powerful enough to use this item',
    'more second before using another potion',
    "you can't use this item",
    "you can't use ",
    'you need to finish your current action',
    'you must dismount first',
    ...CAST_REFUSALS,
] as const;

export const INTERACT_REFUSALS = [
    'you are too far away to interact',
    'is too far away',
    'gives you a dirty look',
] as const;

export const SIT_REFUSALS = [
    'you must be standing still to sit',
    "you can't sit down now",
    "you can't rest when",
    'you must dismount',
] as const;

export const BUY_REFUSALS = [
    'you need ',
    'not enough inventory space',
    'is too far away',
    'you must target a merchant',
] as const;

export const SELL_REFUSALS = [
    "this item can't be sold",
    "isn't interested in",
    'is too far away',
    'you must target a merchant',
] as const;

/**
 * Refusals of an add to a trade window, with their reason. Anchored, so speech can't match (a speech line
 * starts `X says, "`). Sources: PlayerMoveItemRequestHandler.cs:146-166, NormalServerRules.cs:181,
 * GamePlayer.cs:6270-6286, GamePlayer.txt:102/261/264.
 */
export const TRADE_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Invalid trade target\.$/, 'not_found'],
    [/^Can't trade with inactive players\.$/, 'refused'],
    [/^You can't trade with yourself/, 'refused'],
    [/^You can't trade with enemy realm!$/, 'wrong_realm'],
    [/^You are too far away to give anything to /, 'out_of_range'],
    [/^You are still (trading with |selfcrafting)/, 'self_busy'],
    [/^\S+ is still (trading with |selfcrafting)/, 'busy'],
    [/^You can't trade this item!$/, 'refused'],
];

/** Lines of a commit that failed; the window stays open with both accepts reset (PlayerTradeWindow.cs:437-451, :521-527). */
export const TRADE_COMMIT_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
    [/^You don't have enough money\.$/, 'insufficient_funds'],
    [/^\S+ doesn't have enough money\.$/, 'partner_insufficient_funds'],
    [/^You don't have enough space in your inventory\.$/, 'inventory_full'],
    [/^\S+ doesn't have enough space in his inventory\.$/, 'partner_inventory_full'],
];

/** A smith's price, single item or everything (Blacksmith.txt:10, Blacksmith.cs:231). The text is the box's. */
export const REPAIR_OFFER = /^It will cost (.+) to repair .+\. Do you accept\?$/;

/** A smith's answer to an item handed over: no box follows. Anchored, as TRADE_REFUSALS (Blacksmith.txt:15-17, GamePlayer.txt). */
export const REPAIR_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Your .+ is already in perfect condition\.$/, 'no_need'],
    [/^.+ says, "I can't repair that\."$/, 'not_repairable'],
    [/^.+ doesn't want stacked items\.$/, 'not_repairable'],
    [/^You are too far away to give anything to /, 'out_of_range'],
    [/^Invalid trade target\.$/, 'not_found'],
];

/**
 * The smith's lines after a yes. A repair-all that can't pay reads with its placeholders still in it
 * (Blacksmith.cs:267), and a smith that lost track of the item says it can't (:180-186).
 */
export const REPAIR_ANSWERS: ReadonlyArray<readonly [RegExp, string]> = [
    [/^.+ says, "I can't repair that\."$/, 'not_repairable'],
    [/ says, "There, .+ is ready for combat\."$/, 'done'],
    [/ says, "Uhh, .+ is rather old\. /, 'done'],
    [/It costs .+ to repair .+ You don't have that much/, 'insufficient_funds'],
];

/** "All items are fully repaired already." (Blacksmith.cs:233), in a popup that names the smith. */
export const NOTHING_TO_REPAIR = /all items are fully repaired already/i;

const COIN_COPPER: Record<string, number> = { copper: 1, silver: 100, gold: 10_000, platinum: 10_000_000, mithril: 10_000_000_000 };

/** The copper in a Money.GetString text: "3 gold, 24 silver", "0 copper pieces" (Money.cs:74, money.txt). */
export function parseMoneyText(text: string): number {
    let copper = 0;
    for (const [, n, coin] of text.matchAll(/(\d+) (copper|silver|gold|platinum|mithril)/g)) copper += Number(n) * COIN_COPPER[coin!]!;
    return copper;
}

/** PlayerTradeWindow.cs:676-677. It comes before the close, after the inventory changes. */
export const TRADE_COMPLETED = /^Trade Completed\. \d+ items for \d+ items\.$/;

export interface TradeLine {
    reason: string;
    text: string;
}

/** The first message on one of those tables, with its reason. */
export function firstTradeLine(messages: readonly GameMessage[], table: ReadonlyArray<readonly [RegExp, string]>): TradeLine | null {
    for (const m of messages) {
        const hit = table.find(([pattern]) => pattern.test(m.text));
        if (hit) return { reason: hit[1], text: m.text };
    }
    return null;
}

export const PICKUP_REFUSALS = [
    "that loot doesn't belong to you",
    'your backpack is full',
    'is too far away to pick up',
    "you can't get that",
    'you must have a target to get something',
    'below your battlegroups lootlevel',
] as const;

/** What training gets with no trainer targeted while allow_train_anywhere is off (train.cs:150). */
export const TRAINER_WANTED = 'you must select a valid trainer';

export const TRAIN_REFUSALS = [
    TRAINER_WANTED,
    'specialization points!',
    'you cannot train',
    "you can't train",
    'you have already trained',
    'could not be found',
    'not enough',
] as const;

/** The yes/no box /respec opens (respec.cs:107, 178). */
export const RESPEC_OFFER = /all respec changes are final/i;

/** What /respec says instead of that box (respec.cs:66, 102, 159, 169, 174). */
export const RESPEC_REFUSALS = [
    'you must be speaking with your trainer',
    "you don't seem to have any",
    'no line with name',
    'line is less than 2',
] as const;

export const RELEASE_REFUSALS = [
    'you are not dead',
    'you must wait',
    "you can't release",
] as const;

// ── Con levels (gameutils/ConLevelGrid.cs, data from capnbry.net/daoc/concolors.html) ─

/** Per player level 0..50: spans of [grey(-3), green(-2), blue(-1), yellow(0), orange(1), red(2)]; the rest is purple(3). */
const CON_SPANS: readonly (readonly number[])[] = [
    /* 0*/ [0, 0, 0, 1, 1, 1],
    /* 1*/ [0, 0, 1, 1, 1, 1],
    /* 2*/ [0, 1, 1, 1, 1, 1],
    /* 3*/ [1, 1, 1, 1, 1, 1],
    /* 4*/ [2, 1, 1, 1, 1, 1], [3, 1, 1, 1, 1, 1], [4, 1, 1, 1, 1, 1], [5, 1, 1, 1, 1, 1], [6, 1, 1, 1, 1, 1], [7, 1, 1, 1, 1, 1],
    /*10*/ [7, 1, 2, 1, 1, 2], [7, 1, 2, 2, 2, 2], [7, 2, 2, 2, 2, 2], [8, 2, 2, 2, 2, 2], [9, 2, 2, 2, 2, 2],
    /*15*/ [10, 2, 2, 2, 2, 2], [11, 2, 2, 2, 2, 2], [12, 2, 2, 2, 2, 2], [13, 2, 2, 2, 2, 2], [14, 2, 2, 2, 2, 2],
    /*20*/ [14, 2, 3, 2, 2, 3], [14, 2, 3, 3, 3, 3], [14, 3, 3, 3, 3, 3], [15, 3, 3, 3, 3, 3], [16, 3, 3, 3, 3, 3],
    /*25*/ [17, 3, 3, 3, 3, 3], [18, 3, 3, 3, 3, 3], [19, 3, 3, 3, 3, 3], [20, 3, 3, 3, 3, 3], [21, 3, 3, 3, 3, 3],
    /*30*/ [22, 3, 3, 3, 3, 3], [23, 3, 3, 3, 3, 3], [24, 3, 3, 3, 3, 3], [25, 3, 3, 3, 3, 3], [26, 3, 3, 3, 3, 3],
    /*35*/ [26, 3, 3, 4, 4, 3], [26, 3, 3, 5, 5, 4], [26, 4, 3, 5, 5, 5], [26, 4, 4, 5, 5, 5], [26, 4, 5, 5, 5, 5],
    /*40*/ [26, 5, 5, 5, 5, 5], [27, 5, 5, 5, 5, 5], [28, 5, 5, 5, 5, 5], [29, 5, 5, 5, 5, 5], [30, 5, 5, 5, 5, 5],
    /*45*/ [31, 5, 5, 5, 5, 5], [32, 5, 5, 5, 5, 5], [33, 5, 5, 5, 5, 5], [34, 5, 5, 5, 5, 5], [35, 5, 5, 5, 5, 5],
    /*50*/ [36, 5, 5, 5, 5, 5],
];

export type ConColor = 'grey' | 'green' | 'blue' | 'yellow' | 'orange' | 'red' | 'purple';
const CON_NAMES: readonly ConColor[] = ['grey', 'green', 'blue', 'yellow', 'orange', 'red', 'purple'];

/**
 * Con level of an NPC for a player: -3 grey (no XP), -2 green, -1 blue,
 * 0 yellow, 1 orange, 2 red, 3 purple. Port of CharacterConLevelGrid.
 */
export function conLevel(playerLevel: number, npcLevel: number): number {
    const p = Math.max(0, Math.min(127, Math.floor(playerLevel)));
    const t = Math.max(0, Math.floor(npcLevel));
    let spans = CON_SPANS[p];
    if (!spans) {
        // Above 50: level-50 spans with grey widened by one per level (ConLevelUtility.BuildGrid).
        const last = CON_SPANS[50]!;
        spans = [last[0]! + (p - 50), last[1]!, last[2]!, last[3]!, last[4]!, last[5]!];
    }
    let index = 0;
    for (let con = 0; con < spans.length; con++) {
        index += spans[con]!;
        if (t < index) return con - 3;
    }
    return 3;
}

export function conColor(level: number): ConColor {
    return CON_NAMES[Math.max(-3, Math.min(3, level)) + 3]!;
}

/** NPC roles that are never fight targets. */
const NON_COMBAT_ROLES = new Set(['merchant', 'smith', 'trainer', 'guard', 'healer', 'stablemaster', 'vault', 'teleporter', 'service']);

/** A monster we can fight for XP: attackable, realm 'none', not a townsperson. */
export function isKillable(npc: NearbyNpc, player: PlayerState | null): boolean {
    if (!isAttackable(npc, player)) return false;
    if (npc.realm !== 'none') return false;
    // The role is guessed from name text, so "wood-eater royal guard" or "wood-eater soldier" reads as
    // a town guard. Monster names are lowercase; townspeople ("Sentinel Glynis", "Guard Ulf") are not.
    if (npc.role && NON_COMBAT_ROLES.has(npc.role) && !isMonsterName(npc.name)) return false;
    return npc.name.length > 0;
}

/** DAoC monster names start lowercase ("wood-eater royal guard"); named NPCs start uppercase. */
function isMonsterName(name: string): boolean {
    const c = name.charAt(0);
    return c !== '' && c === c.toLowerCase() && c !== c.toUpperCase();
}

// ── Money / inventory deltas ───────────────────────────────────────────────

export interface InventoryDelta {
    /** Items (or extra stack counts) that appeared. */
    gained: InventoryItem[];
    /** Items (or stack counts) that went away. */
    lost: InventoryItem[];
}

/**
 * Two readings of one item, as far as the client can tell: what tells it from an equal-named one a swap put in
 * its slot. Equal readings can still be two items: bonuses never reach the client, and condition and durability
 * come as whole percents.
 */
export function sameItem(a: InventoryItem, b: InventoryItem): boolean {
    return a.name === b.name && a.level === b.level && a.condition === b.condition && a.durability === b.durability
        && a.quality === b.quality && a.value1 === b.value1 && a.value2 === b.value2 && a.model === b.model && a.weight === b.weight;
}

/** Per-name count deltas between two backpack snapshots. */
export function diffInventory(before: readonly InventoryItem[], after: readonly InventoryItem[]): InventoryDelta {
    const count = (items: readonly InventoryItem[]) => {
        const map = new Map<string, { count: number; sample: InventoryItem }>();
        for (const item of items) {
            const entry = map.get(item.name);
            const n = Math.max(1, item.count);
            if (entry) entry.count += n;
            else map.set(item.name, { count: n, sample: item });
        }
        return map;
    };
    const a = count(before);
    const b = count(after);
    const gained: InventoryItem[] = [];
    const lost: InventoryItem[] = [];
    for (const [name, { count: n, sample }] of b) {
        const prev = a.get(name)?.count ?? 0;
        if (n > prev) gained.push({ ...sample, count: n - prev });
    }
    for (const [name, { count: n, sample }] of a) {
        const next = b.get(name)?.count ?? 0;
        if (n > next) lost.push({ ...sample, count: n - next });
    }
    return { gained, lost };
}

export function totalCopper(state: BotWorldState | null): number {
    return state?.player?.money.totalCopper ?? 0;
}

/** Sum of "You get N experience points" in messages (commas allowed). */
export function experienceFromMessages(messages: readonly GameMessage[]): number {
    let total = 0;
    for (const m of messages) {
        const match = /you get ([\d,]+) experience points/i.exec(m.text);
        if (match) total += Number(match[1]!.replace(/,/g, '')) || 0;
    }
    return total;
}

// ── Target resolution ──────────────────────────────────────────────────────

export type NpcTarget = NearbyNpc | NamePattern | number;
export type PlayerTarget = NearbyPlayer | NamePattern | number;
/** Something to fight: an NPC or a player. */
export type LivingTarget = NearbyNpc | NearbyPlayer | NamePattern | number;
export type ObjectTarget = NearbyNpc | NearbyPlayer | NearbyObject | NamePattern | number;
export type Point = { x: number; y: number; z?: number };

export function describeTarget(target: unknown): string {
    if (typeof target === 'number') return `#${target}`;
    if (typeof target === 'string') return `"${target}"`;
    if (target instanceof RegExp) return String(target);
    if (target && typeof target === 'object' && 'name' in target) return `"${(target as { name: string }).name}"`;
    return String(target);
}

// ── Message watch ──────────────────────────────────────────────────────────

/**
 * Collects every game message that arrives after construction (by monotonic
 * id), so a refusal is not missed when the 100-message window scrolls.
 * Always dispose() it (try/finally).
 */
export class MessageWatch {
    private collected: GameMessage[] = [];
    private lastId: number;
    private readonly unsubscribe: () => void;

    constructor(private readonly sdk: BotSDK) {
        this.lastId = maxMessageId(sdk.getState());
        this.unsubscribe = sdk.onStateUpdate(state => this.collect(state));
    }

    private disposed = false;

    private collect(state: BotWorldState | null): void {
        if (this.disposed) return;
        for (const m of state?.gameMessages ?? []) {
            if (m.id > this.lastId) {
                this.collected.push(m);
                this.lastId = m.id;
            }
        }
    }

    /** Messages since the watch started, oldest first. */
    messages(): GameMessage[] {
        this.collect(this.sdk.getState());
        return this.collected;
    }

    /** First message containing one of `phrases` (lowercase substrings or RegExps). */
    find(phrases: readonly (string | RegExp)[]): GameMessage | null {
        for (const m of this.messages()) {
            const text = m.text.toLowerCase();
            if (phrases.some(p => typeof p === 'string' ? text.includes(p) : p.test(m.text))) return m;
        }
        return null;
    }

    /** Text of the first matching message, or null. */
    findText(phrases: readonly (string | RegExp)[]): string | null {
        return this.find(phrases)?.text ?? null;
    }

    dispose(): void {
        this.collect(this.sdk.getState());
        this.disposed = true;
        this.unsubscribe();
    }
}

export function maxMessageId(state: BotWorldState | null): number {
    const msgs = state?.gameMessages ?? [];
    return msgs.length ? msgs[msgs.length - 1]!.id : 0;
}

export function maxCombatEventId(state: BotWorldState | null): number {
    const events = state?.combatEvents ?? [];
    return events.length ? events[events.length - 1]!.id : 0;
}

// ── ActionHelpers ──────────────────────────────────────────────────────────

export class ActionHelpers {
    constructor(private readonly sdk: BotSDK) {}

    state(): BotWorldState | null {
        return this.sdk.getState();
    }

    player(): PlayerState | null {
        return this.sdk.getState()?.player ?? null;
    }

    watch(): MessageWatch {
        return new MessageWatch(this.sdk);
    }

    /** Abortable sleep. */
    sleep(ms: number): Promise<void> {
        return executionWait<void>(resolve => {
            const t = setTimeout(resolve, Math.max(0, ms));
            return () => clearTimeout(t);
        });
    }

    /**
     * Resolve when `check(state)` returns a non-null/false value, checking the
     * current state first and every new snapshot after. Returns null on timeout;
     * an execution abort still throws.
     */
    waitFor<T>(check: (state: BotWorldState) => T | null | undefined | false, timeout: number): Promise<T | null> {
        throwIfExecutionAborted();
        const current = this.sdk.getState();
        if (current) {
            const value = check(current);
            if (value !== null && value !== undefined && value !== false) return Promise.resolve(value);
        }
        return executionWait<T | null>((resolve, reject) => {
            const timer = setTimeout(() => resolve(null), Math.max(0, timeout));
            const unsubscribe = this.sdk.onStateUpdate(state => {
                try {
                    const value = check(state);
                    if (value !== null && value !== undefined && value !== false) resolve(value);
                } catch (error) {
                    reject(error);
                }
            });
            return () => { clearTimeout(timer); unsubscribe(); };
        });
    }

    /**
     * Run a cleanup dispatch (stop moving, attack off, stand up) outside the
     * execution's abort signal, so it still reaches the client after an MCP
     * cancel or a runScript timeout. Never throws.
     */
    async cleanup(fn: () => Promise<unknown>): Promise<void> {
        try {
            await executionContext.exit(fn);
        } catch {
            // best effort: disconnected or the client refused
        }
    }

    /** The next snapshot to arrive, or the current one after `timeout` ms (never resolves synchronously). */
    nextState(timeout: number = 1000): Promise<BotWorldState | null> {
        return executionWait<BotWorldState | null>(resolve => {
            const timer = setTimeout(() => resolve(this.sdk.getState()), Math.max(0, timeout));
            const unsubscribe = this.sdk.onStateUpdate(state => resolve(state));
            return () => { clearTimeout(timer); unsubscribe(); };
        });
    }

    distance(a: Point, b: Point): number {
        return distanceBetween(a, b);
    }

    distance2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    resolveNpc(target: NpcTarget, opts: { maxDistance?: number } = {}): NearbyNpc | null {
        const npcs = this.sdk.getNearbyNpcs();
        if (typeof target === 'number') return npcs.find(n => n.objectId === target) ?? null;
        if (typeof target === 'string' || target instanceof RegExp) {
            return bestNameMatch(npcs.filter(n => opts.maxDistance === undefined || n.distance <= opts.maxDistance), target);
        }
        // A stale snapshot object: prefer its fresh copy.
        return npcs.find(n => n.objectId === target.objectId) ?? null;
    }

    resolvePlayer(target: PlayerTarget): NearbyPlayer | null {
        const players = this.sdk.getNearbyPlayers();
        if (typeof target === 'number') return players.find(p => p.objectId === target) ?? null;
        if (typeof target === 'string') {
            const exact = players.find(p => p.name.toLowerCase() === target.toLowerCase());
            return exact ?? bestNameMatch(players, target);
        }
        if (target instanceof RegExp) return bestNameMatch(players, target);
        return players.find(p => p.objectId === target.objectId) ?? null;
    }

    /** An NPC or player by object id or snapshot object; a name matches NPCs first, then players. */
    resolveLiving(target: LivingTarget): NearbyNpc | NearbyPlayer | null {
        if (typeof target === 'string' || target instanceof RegExp) return this.resolveNpc(target) ?? this.resolvePlayer(target);
        const obj = this.sdk.getObject(typeof target === 'number' ? target : target.objectId);
        return obj && obj.kind !== 'object' ? obj : null;
    }

    resolveAny(target: ObjectTarget): NearbyNpc | NearbyPlayer | NearbyObject | null {
        if (typeof target === 'number') return this.sdk.getObject(target);
        if (typeof target === 'string' || target instanceof RegExp) {
            const s = this.sdk.getState();
            if (!s) return null;
            return bestNameMatch<NearbyNpc | NearbyPlayer | NearbyObject>([...s.nearbyNpcs, ...s.nearbyPlayers, ...s.nearbyObjects], target);
        }
        return this.sdk.getObject(target.objectId);
    }

    resolveInventoryItem(target: InventoryItem | NamePattern | number): InventoryItem | null {
        if (typeof target === 'number') return this.sdk.getInventoryItem(target);
        if (typeof target === 'string' || target instanceof RegExp) return this.sdk.findInventoryItem(target);
        return this.sdk.getInventory().find(i => i.slot === target.slot && i.name === target.name)
            ?? this.sdk.findInventoryItem(target.name);
    }

    /**
     * NPCs fighting us: their reported target is us, or their swing or spell landed on us within PLAYER_AIM_MS.
     * The target alone misses a caster or a running mob: the server sends it only for a mob in attack state, able to
     * turn, that stands within its attack range (PacketLib168.cs:820-828), and a mob starting a timed cast
     * leaves attack state (StandardMobBrain.cs:442-443). A hit from something we couldn't fight, such as a realm NPC's buff, doesn't count.
     */
    attackers(state: BotWorldState | null = this.sdk.getState()): NearbyNpc[] {
        const p = state?.player;
        if (!state || !p) return [];
        const hitBy = this.hitUsBy(state, PLAYER_AIM_MS);
        return state.nearbyNpcs.filter(n => n.healthPercent > 0 && (n.targetObjectId === p.objectId || (hitBy.has(n.objectId) && isAttackable(n, p))));
    }

    /** Who swung at us (hit or miss) or landed a spell effect on us within `windowMs` of the snapshot. */
    private hitUsBy(state: BotWorldState, windowMs: number): Set<number> {
        const me = state.player?.objectId;
        const since = state.timestamp - windowMs;
        const ids = new Set<number>();
        for (const e of state.combatEvents) {
            // The next object in the region takes a dead mob's id (Region.cs): its hits aren't from that one.
            if (e.kind === 'death' && e.targetObjectId !== null) ids.delete(e.targetObjectId);
            else if ((e.kind === 'melee' || e.kind === 'spellEffect') && e.targetObjectId === me && e.attackerObjectId !== null && e.receivedAt >= since) {
                ids.add(e.attackerObjectId);
            }
        }
        return ids;
    }

    /**
     * Living players of another realm whose melee swing (hit or miss) or spell effect landed on us
     * within `windowMs` of the snapshot (default PLAYER_AIM_MS, longer than a slow weapon's swing).
     * The server never sends another player's target, so these combat events are the only evidence
     * (0xBC, WeaponAction.cs:331-369; 0x1B, SpellHandler.cs:1284-1291).
     */
    playerAttackers(state: BotWorldState | null = this.sdk.getState(), windowMs: number = PLAYER_AIM_MS): NearbyPlayer[] {
        const p = state?.player;
        if (!state || !p) return [];
        const ids = this.hitUsBy(state, windowMs);
        return state.nearbyPlayers.filter(pl => ids.has(pl.objectId) && pl.realm !== p.realm && !pl.isDead);
    }

    matches(pattern: NamePattern | undefined, name: string): boolean {
        return pattern === undefined || nameMatcher(pattern)(name);
    }

    /** Point `range` units short of `to` on the line from `from` (keeps z of `to`). */
    approachPoint(from: Vec3, to: Point, range: number): Point {
        const d = this.distance2d(from, to);
        if (d <= range || d < 1) return { x: from.x, y: from.y, z: to.z };
        const f = (d - range) / d;
        return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, z: to.z };
    }
}
