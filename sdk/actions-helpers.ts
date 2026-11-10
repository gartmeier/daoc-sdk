// Portions (ConLevelGrid, refusal texts) ported from OpenDAoC (https://github.com/OpenDAoC/OpenDAoC-Core), GPL; see LICENSES/OpenDAoC-GPL-3.0.txt.
// Bot SDK - action helpers: target resolution, message watching, refusal
// scanning, con levels and inventory/money deltas used by BotActions.

import { BotSDK, bestNameMatch, distanceBetween, isAttackable, nameMatcher, type NamePattern } from './index';
import { executionContext, executionWait, throwIfExecutionAborted } from './execution-context';
import { getClass, getSpell, getSpells, type StatName } from '../data/index';
import { EquipmentSlot, isWeapon, ObjectType } from './types';
import type {
    BotWorldState,
    GameMessage,
    InventoryItem,
    NearbyNpc,
    NearbyObject,
    NearbyPlayer,
    PetCommand,
    PlayerState,
    Stats,
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

/** How long a pet's last swing or spell says who it fights: past a slow pet's swing (4-5 s, or a 3.5 s cast and a 600 ms think). */
const PET_AIM_MS = 10_000;

/**
 * The answer to every attack request with the ranged weapon active, and all it does: no attack mode comes, and fight() would resend until its timeout (PlayerAttackRequestHandler.cs:12-18).
 * An off gets it too, as encodeAttack always says the user asked. Using a melee slot with type 0 switches (GamePlayer.cs:6622-6637).
 */
export const RANGED_IN_HAND = "you can't enter melee combat mode with a ranged weapon";

/** Melee refusals: GamePlayer.Attack.*, Skill.Ability.*, AbstractServerRules. */
export const ATTACK_REFUSALS = [
    ...PVP_IMMUNE_REFUSALS,
    "can't see your target",
    'is not in view',
    'target is not in view',
    // With its "!": "Your target is too far away to attack with your pet!" answers a pet order and says nothing of our swing.
    'is too far away to attack!',
    'you are too far away to attack',
    "you can't attack",
    'you cannot attack',
    'is already dead',
    'you must have a target',
    "can't attack when you are",
    "you can't do that while dead",
    'you have not selected a valid',
    // A Necromancer in shade (ClassDisciple.cs:91, GamePlayer.txt:39): fight() would resend attack until its timeout.
    'you cannot enter combat',
    RANGED_IN_HAND,
] as const;

/** Refusals that mean "turn / step closer and try again". */
export const RETRYABLE_ATTACK_REFUSALS = [
    "can't see your target",
    'is not in view',
    'is too far away to attack!',
    'you are too far away to attack',
] as const;

/** An ATTACK_REFUSALS text that is not a RETRYABLE_ATTACK_REFUSALS one: the attack is off. */
export function isFatalAttackRefusal(text: string): boolean {
    const t = text.toLowerCase();
    return ATTACK_REFUSALS.some(r => t.includes(r)) && !RETRYABLE_ATTACK_REFUSALS.some(r => t.includes(r));
}

/** The lines whose styles need a weapon in each hand; the tooltip names the line (Style.GetRequiredWeaponName). */
export const DUAL_LINES: ReadonlySet<string> = new Set(['Dual Wield', 'Left Axe', 'Hand to Hand', 'Celtic Dual']);

/** The spec a weapon type swings with, in the words of a style's tooltip (SkillBase.m_objectTypeToSpec); a left axe counts as an axe (StyleProcessor.CheckWeaponType). */
export const WEAPON_LINES: Partial<Record<number, string>> = {
    [ObjectType.CrushingWeapon]: 'Crush', [ObjectType.SlashingWeapon]: 'Slash', [ObjectType.ThrustWeapon]: 'Thrust',
    [ObjectType.TwoHandedWeapon]: 'Two Handed', [ObjectType.PolearmWeapon]: 'Polearm', [ObjectType.Staff]: 'Staff', [ObjectType.Flexible]: 'Flexible',
    [ObjectType.Sword]: 'Sword', [ObjectType.Hammer]: 'Hammer', [ObjectType.Axe]: 'Axe', [ObjectType.LeftAxe]: 'Axe', [ObjectType.Spear]: 'Spear',
    [ObjectType.Blades]: 'Blades', [ObjectType.Blunt]: 'Blunt', [ObjectType.Piercing]: 'Piercing', [ObjectType.LargeWeapons]: 'Large Weapons',
    [ObjectType.CelticSpear]: 'Celtic Spear', [ObjectType.Scythe]: 'Scythe', [ObjectType.HandToHand]: 'Hand to Hand',
};

/** A style that the weapon in hand can't do (StyleProcessor.cs:175; language/EN/GameObjects/GamePlayer.txt:56). The state can't say what is in hand, so this is how we find out. */
export const STYLE_NEEDS_WEAPON = /^This style requires an? (.+) weapon!$/;

/**
 * The melee slot that takes in hand what a style needs, by the name its tooltip and "This style requires a X weapon!" give it (Style.GetRequiredWeaponName, StyleProcessor.cs:175), or null when nothing worn is that. A shield or a second weapon goes with the right hand (GamePlayer.cs:6622-6630). 'Any' names no slot.
 */
export function slotHolding(need: string, equipment: readonly Pick<InventoryItem, 'slot' | 'objectType'>[]): number | null {
    const inSlot = (slot: number) => equipment.find(i => i.slot === slot);
    const right = inSlot(EquipmentSlot.RightHand);
    const hasRight = !!right && isWeapon(right.objectType);
    const left = inSlot(EquipmentSlot.LeftHand);
    if (need === 'Shield') return hasRight && left?.objectType === ObjectType.Shield ? EquipmentSlot.RightHand : null;
    if (need === 'Hand to Hand') return hasRight && right.objectType === ObjectType.HandToHand && left?.objectType === ObjectType.HandToHand ? EquipmentSlot.RightHand : null;
    if (DUAL_LINES.has(need)) return hasRight && !!left && left.objectType !== ObjectType.Shield ? EquipmentSlot.RightHand : null;
    return [right, inSlot(EquipmentSlot.TwoHand)].find(w => w && WEAPON_LINES[w.objectType] === need)?.slot ?? null;
}

/**
 * Refusals of a summon, a charm or a spell on a pet, with their reason. Many come only after the whole cast time
 * (CheckEndCast: the plain pets' "already have", SummonDruidPet.cs:46; a capital, SpellHandler.cs:866-873; every charm
 * line), so each needs its own reason here: at that point an unknown refusal reads as an interrupt. Sources:
 * language/EN/Spells.txt:76-85, :109, :132, :135-146, :162-163, SpellHandler.cs:653, SummonTheurgistPet.cs:69,
 * SummonAnimistFnF.cs:49, SummonMinionHandler.cs:68. A line with nothing of its own here reads 'refused'; the charm that stops
 * only while the mob fights has its own reason in castFailureReason, since it names the mob. The servant's own come from its side of a
 * cast we already paid for (AI.txt:5-6, PowerTransfer.cs:29), and nothing else follows: they would read as no answer.
 */
export const PET_CAST_REFUSALS: ReadonlyArray<readonly [string, string]> = [
    ['you already have a charmed creature', 'pet_exists'],
    ['you must cast this spell on a creature you are controlling', 'no_pet'],
    ['you must have a pet summoned', 'no_pet'],
    ["you can't do that here", 'refused'],
    ['you have too many controlled creatures', 'refused'],
    ["you can't charm", 'refused'],
    ['this spell does not charm', 'refused'],
    ['is too strong for you to charm', 'refused'],
    ['is currently being controlled', 'refused'],
    ["can't be charmed", 'refused'],
    ['you have to set a ground target', 'no_ground_target'],
    ["you can't summon a turret without a ground target", 'no_ground_target'],
    ['your ground target is not visible', 'refused'],
    ['your ground target is not in view', 'refused'],
    ['you have to select a closer ground target', 'out_of_range'],
    ["you can't summon a turret", 'refused'],
    ["you can't summon any more turrets", 'refused'],
    ['you cannot control any more turrets', 'refused'],
    ['cannot summon a turret', 'refused'],
    ['you must have a controlled leader monster', 'refused'],
    ['your general already has as many followers', 'refused'],
    ['your commander is not powerful enough', 'refused'],
    ['you are already a shade', 'refused'],
    ['your servant is too far away from your target', 'out_of_range'],
    ["can't see its target", 'out_of_range'],
    ['you cannot transfer power to yourself', 'invalid_target'],
];

/** What the server says to a ground target it dropped: over 16 units off the mesh (PlayerGroundTargetHandler.cs:21-33, :63-85). */
export const GROUND_TARGET_DROPPED = 'your ground target is not visible';

/** That line with what it means: it says nothing of the mesh. With no z passed the height was the client's own already. */
export function offMeshMessage(line: string, zPassed: boolean): string {
    return `${line} The spot is off the walkable surface: ${zPassed ? "pass no z to take the ground's, or an NPC's coordinates" : "try another spot, or an NPC's coordinates"}`;
}

/** Base classes whose spells cost by focus, and so 1.2 down to 0.8 times the price (ClassDisciple.cs:41, ClassElementalist.cs:46, ClassForester.cs:46, ClassMage.cs:46, ClassMagician.cs:46, ClassMystic.cs:46). */
const FOCUS_BASE_CLASSES = new Set(['Disciple', 'Elementalist', 'Forester', 'Mage', 'Magician', 'Mystic']);
const STATS_KEY: Record<StatName, keyof Stats> = { STR: 'strength', DEX: 'dexterity', CON: 'constitution', QUI: 'quickness', INT: 'intelligence', PIE: 'piety', EMP: 'empathy', CHR: 'charisma' };

/** Whether this player's spells cost by focus (ClassValewalker.cs:24 is none). With no class to read, yes: that errs towards the larger cost. */
export function isFocusCaster(p: PlayerState): boolean {
    const cls = getClass(p.className, p.realm);
    return !cls || (FOCUS_BASE_CLASSES.has(cls.baseClassName) && cls.name !== 'Valewalker');
}

/**
 * The most a spell can cost this player, for what a release has to go by: refusing wrongly costs seconds of regen, passing wrongly the pet (the server knows the real cost).
 * A positive power is a flat cost, a negative one a percent of the pool without items: level * (mana stat + 145) / 41 + 5, the stat without items too
 * (SpellHandler.cs:1190-1199, GamePlayer.cs:2478). A focus caster pays 120 % of that with no focus item, and down to 80 % with one (:1204-1221), by items we can't see.
 * With no such stat yet, or from an older client, maxMana stands in: the most the pool can be, with the items in it (and the pool itself for a class with no mana stat, :1200-1201).
 */
export function worstPowerCost(power: number, p: PlayerState): number {
    const cls = getClass(p.className, p.realm);
    const stat = cls?.manaStat ? p.statsWithoutItems?.[STATS_KEY[cls.manaStat]] : undefined;
    const pool = stat === undefined ? p.maxMana : Math.floor(p.level * (stat + 145) / 41) + 5;
    return Math.floor((power < 0 ? pool * -power / 100 : power) * (isFocusCaster(p) ? 1.2 : 1));
}

/**
 * Casting a pulsing spell that is running ends it and casts nothing (CastingComponent.cs:349-366, SpellHandler.cs:501-513).
 * The first line is for a spell without an instrument, a charm's among them.
 */
export const PULSE_CANCELLED = ['you cancel your effect', 'you stop playing your song'] as const;

/** A Corpse spell at the living, or at anyone of another realm (SpellHandler.cs:759-766). */
export const CORPSE_ONLY = 'This spell only works on dead members of your realm!';

/** Of those below, what only an attack can earn: a spell's own target goes through IsAllowedToAttack for ENEMY alone (SpellHandler.cs:754, :969; a Realm spell's is quiet, :771-775), so beside any other spell they answer something else: a pet's attack order. */
export const ATTACK_ONLY_REFUSALS: readonly string[] = ["you can't attack", 'you cannot attack', ...PVP_IMMUNE_REFUSALS];

/** The server's answer to a cast with a cast time during another (CastingComponent.cs:433-441). No refusal: castSpell reads it apart. */
export const ALREADY_CASTING = 'you are already casting a spell';
/** ... and how it goes on with the spell queue on, as it is unless a player turns it off: the spell starts by itself when the running one ends, unless another replaces it or the running one fails at its end (CastingComponent.cs:224-228). */
export const FOLLOW_UP = 'as a follow up';

/** A song with no instrument in hand (SpellHandler.cs:581, :894): the server asks for the active weapon's type, and any instrument will do (:252-261). */
export const NO_INSTRUMENT = 'you are not wielding the right type of instrument';

/**
 * "You can only cast up to 20 simultaneous concentration spells!" (SpellHandler.cs:31 MAX_CONC_SPELLS, :836-839), sent as a
 * resist, whatever is left of the pool. Read as no_response before: a Cleric with ~32 concentration buffs planned retried each
 * one every 60 s (arena round 26, 2026-11-10: 39 a round).
 */
export const CONCENTRATION_CAP = 'simultaneous concentration spells';

/**
 * A spell's range as the server judges it with the effects on us: max(32, range * SpellRange % / 100), where Nearsight
 * takes its value off the 100 (CastingComponent.cs:183-187, SpellRangePercentCalculator.cs, NearsightECSEffect.cs:17).
 * Effects of a kind don't stack, so the strongest counts. Arena round 35 (2026-11-10): under Albion's Obscuring Dust (-35 %)
 * Hibernia's casters got "That target is too far away!" over 120 times at targets our raw ranges put in reach.
 */
export function effectiveSpellRange(range: number, effects: readonly { spellId: number; isNegative?: boolean }[] | null | undefined): number {
    if (!(range > 0) || !effects?.length) return range;
    let off = 0;
    for (const e of effects) {
        const info = e.spellId ? getSpell(e.spellId) : undefined;
        if (info?.type === 'Nearsight') off = Math.max(off, info.value ?? 0);
    }
    return off > 0 ? Math.max(32, Math.floor(range * Math.max(0, 100 - off) / 100)) : range;
}

/** Spell refusals and interruptions (SpellHandler.cs, CastingComponent.cs). */
export const CAST_REFUSALS = [
    CONCENTRATION_CAP,
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
    "you're phaseshifted",
    CORPSE_ONLY.toLowerCase(),
    ...PET_CAST_REFUSALS.map(([text]) => text),
    ...PULSE_CANCELLED,
    'is already considering a resurrection',
    NO_INSTRUMENT,
] as const;

/**
 * What a rez costs: a share of the caster's full power by the level gap, half at equal level, whatever the
 * spell's power column says (ResurrectSpellHandler.PowerCost, :63-70). Paid when the cast ends, refunded on a "no".
 */
export function resurrectCost(maxMana: number, casterLevel: number, targetLevel: number): number {
    return Math.trunc(maxMana * Math.max(0.1, 0.5 + (targetLevel - casterLevel) / casterLevel));
}

/** "{0} is dead!" to a spell at the dead (SpellHandler.cs:783, HealSpellHandler.cs:78). All before it is a name, so it goes by its end. */
export const TARGET_IS_DEAD = / is dead!$/;

/** How long a death explains an id being gone: the time a group's board and a member's turn take to hear of it. */
const RECENT_DEATH_MS = 5000;

/** GameLiving.IN_COMBAT_DURATION (GameLiving.cs:31). */
const MOB_IN_COMBAT_MS = 10_000;

interface MobEffects {
    /** A mez's or a stun's effect, with the longest it can run in ms. */
    holds: Map<number, number>;
    charms: Set<number>;
}

let mobEffectTable: MobEffects | null = null;

/** A 0x1B's effect is the spell's ClientEffect (SpellHandler.cs:1284-1291), and no spell of another type shares one with these (spell.sql). */
function mobEffects(): MobEffects {
    if (mobEffectTable) return mobEffectTable;
    const table: MobEffects = { holds: new Map(), charms: new Set() };
    try {
        for (const sp of getSpells()) {
            if (sp.type === 'Charm') table.charms.add(sp.clientEffect);
            else if (sp.type === 'Mesmerize' || sp.type === 'Stun' || sp.type === 'StyleStun') table.holds.set(sp.clientEffect, Math.max(table.holds.get(sp.clientEffect) ?? 0, sp.duration * 1000));
        }
    } catch {
        // No spell table on this install: fights count, and a hold for no longer than one.
    }
    return mobEffectTable = table;
}

/**
 * Whether the server still calls this mob in combat, by what we saw of it: a fight in the last 10 s, or a mez or a stun on it, which leaves 10 s more behind when it ends
 * (GameLiving.cs:31, :227, :444; CrowdControlECSEffect.cs:35-46). Its entry can't tell: an 0xA1 names a target only while it attacks and can turn (PacketLib168.cs:820). A charm is no harm to the server (Spell.cs:301-306),
 * and a death gives the id to the next spawn (Region.cs:955). It errs towards yes, as a hold counts for its whole run: a resisted or a broken mez reads the same.
 */
export function mobInCombatLately(s: BotWorldState, mobId: number, now: number = Date.now()): boolean {
    const { holds, charms } = mobEffects();
    for (let i = s.combatEvents.length - 1; i >= 0; i--) {
        const e = s.combatEvents[i]!;
        if (e.kind === 'death' && e.targetObjectId === mobId) return false;
        if ((e.kind !== 'melee' && e.kind !== 'spellCast' && e.kind !== 'spellEffect') || (e.attackerObjectId !== mobId && e.targetObjectId !== mobId)) continue;
        if (e.effectId !== undefined && charms.has(e.effectId)) continue;
        const hold = e.kind === 'spellEffect' && e.targetObjectId === mobId ? holds.get(e.effectId ?? 0) ?? 0 : 0;
        if (now - e.receivedAt <= MOB_IN_COMBAT_MS + hold) return true;
    }
    return false;
}

/** Whether that line is about `target` (null: an enemy player, whose real name we don't have). A pet's cast gets it too, relayed to us (SpellHandler.cs:2450-2455). */
export function isDeadLineOf(text: string, target: string | null): boolean {
    const who = /^(.+) is dead!$/.exec(text)?.[1]?.toLowerCase();
    if (who === undefined) return false;
    return target === null || who.replace(/^the /, '') === target.toLowerCase();
}

/** A mezz at an NPC under 75 % health: no roll, and the power is spent (CCSpellHandler.cs:174-178). */
export const ENRAGED_REFUSAL = /your target is enraged and resists the spell/i;

/**
 * Whether a resist line is about a cast at `target` (null: none named, an area spell say, or an enemy player: the line has the real
 * name, and we know them by race, NormalServerRules.cs:292-297). Text is all there is, and the server sends us others': a spell our
 * pet resisted ("Your wolf cub resists the effect!", SpellHandler.cs:2383), our pet's own spell resisted, relayed with its target's
 * name (:2390, :2446-2456), and one we resisted (:2387). A pet's spell at the same target reads like ours. "Your target is enraged and resists the spell!" is none: nothing was rolled (ENRAGED_REFUSAL).
 */
export function isResistOf(text: string, target: string | null): boolean {
    const who = /^(.+?) resists? the\b/i.exec(text)?.[1]?.toLowerCase();
    if (who === undefined) return false;
    if (who === 'you' || who.startsWith('your ')) return false;
    return target === null || who.replace(/^the /, '') === target.toLowerCase();
}

/**
 * Whether a line shows a Necromancer's servant casting a spell of ours: "{0} begins casting a {1} spell!", "{0} cast a
 * {1} spell!" (Spells.txt:7-8) and "The {0} begins casting the spell!" (AI.txt:7). The sub-spell has the name of the owner's (spell.sql).
 */
export function isServantCast(text: string, spellName: string): boolean {
    if (text.includes('"')) return false; // speech
    const t = text.toLowerCase();
    if (/ begins casting the spell!$/.test(t)) return true;
    return [' begins casting a ', ' begins casting an ', ' cast a ', ' cast an '].some(verb => t.includes(`${verb}${spellName.toLowerCase()} spell!`));
}

/**
 * "The {0} will begin casting this spell after its current action is finished." (AI.txt:4). No promise: a later cast replaces the spell, the last one wins and
 * each is paid (NecromancerPetBrain.cs:50-58, :124, CastingComponent.cs:383-386), and an attack round ending says it with no spell at all, at a death or a release too (NpcAttackAction.cs:238-239, NecromancerPetBrain.cs:113-116).
 */
export function isServantQueued(text: string): boolean {
    return !text.includes('"') && / will begin casting this spell /i.test(text);
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
    'cannot use this item', // a recall stone in combat (GatewayPersonalBind.cs:105), a class's armour (GamePlayerInventory.cs:731)
    'you must be standing still', // a recall stone on the move (GatewayPersonalBind.cs:32, :57, :110)
    'you move and interrupt your focus', // and the same stone's cast, spell 5998 a focus spell, at our next step (spell.sql, PlayerCastingComponent.cs:70)
    'you need to finish your current action',
    'you must dismount first',
    'you are already casting', // any item with a spell during a cast, after its attempt line (GamePlayer.cs:7169-7173)
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

export interface ReasonLine {
    reason: string;
    text: string;
}

/** The first message on a table of lines with their reasons (trade, pets). */
export function firstReasonLine(messages: readonly GameMessage[], table: ReadonlyArray<readonly [RegExp, string]>): ReasonLine | null {
    for (const m of messages) {
        const hit = table.find(([pattern]) => pattern.test(m.text));
        if (hit) return { reason: hit[1], text: m.text };
    }
    return null;
}

/** The server's answer to each pet order (language/EN/GameObjects/GameLiving.txt:54-62): a repeat sends no 0x88, so this is the evidence. A release has its own: the window closes. */
export const PET_ANSWERS: Readonly<Record<Exclude<PetCommand, 'release'>, RegExp>> = {
    attack: /^You command .+ to kill your target!$/,
    follow: /^You command .+ to follow you!$/,
    stay: /^You command .+ to stay in this position!$/,
    comeHere: /^You command .+ to come to you\.$/,
    goTarget: /^You command .+ to go to your target\.$/,
    passive: /^You command .+ to disengage from combat!$/,
    aggressive: /^You command .+ to attack all enemies!$/,
    defensive: /^You command .+ to defend you!$/,
};

/**
 * Refusals of a pet order, with their reason. Sources: GameLiving.txt:36, :53, GamePlayer.cs:12263-12265, and
 * IsAllowedToAttack(player, target, quiet: false) for an attack (GamePlayer.cs:12182): AbstractServerRules.cs:350-375,
 * :450-455, NormalServerRules.cs:38-72. That one says nothing about a dead target or a peace flag.
 */
export const PET_REFUSALS: ReadonlyArray<readonly [RegExp, string]> = [
    [/^Your target is too far away to attack with your pet!$/, 'out_of_range'],
    [/^Your target is too far away for your pet to reach!$/, 'out_of_range'],
    [/^You must select a destination for your controlled creature\.$/, 'no_target'],
    [new RegExp(PVP_IMMUNE_REFUSALS.join('|'), 'i'), 'immune'],
    [/^You can't attack /, 'not_attackable'],
];

/** "The {0} is now under your control." (SummonSpellHandler.cs:66), or the charm's "{0} is now ..." with its article already (CharmECSEffect.cs:34-36). The group is the pet's name. */
export const PET_UNDER_CONTROL = /^(?:The )?(.+) is now under your control\.$/;

/** What can still stop a summon or a charm after "You cast a ... spell!" (SpellHandler.cs:1337): the charm's roll and its range (CharmSpellHandler.cs:419-436, Spells.txt:77, GameLiving.txt:69). */
export const SUMMON_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
    [/ resists the charm! \(/, 'resisted'],
    [/^Your controlled creature is too far away!$/, 'out_of_range'],
];

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

/** A /release inside the server's 10 s wait has armed the automatic one, N seconds off, wherever it goes (GamePlayer.cs:1450-1474, PlayerCommands.txt:591-596). */
export const AUTO_RELEASE_ARMED = /^You will now release .*\bin (\d+) more seconds!/;

/** The same request with one armed already: it is off again, and nothing tells us who armed it (GamePlayer.cs:1442-1448, PlayerCommands.txt:588). */
export const AUTO_RELEASE_DISARMED = /^You will no longer release automatically/;

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

/** A monster we can fight for XP: attackable, realm 'none', not a townsperson, not a pet (killing one is worth nothing, GameNPC.cs:2731-2732). */
export function isKillable(npc: NearbyNpc, player: PlayerState | null): boolean {
    if (npc.isPet || !isAttackable(npc, player)) return false;
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

// ── Pet spells ─────────────────────────────────────────────────────────────

/**
 * What a summon gives. main: a pet in the window. turret: an Animist's main pet, in the window too, on a ground target.
 * fnf: a Theurgist's pet or a fire-and-forget turret, outside the window. bomber: one that flies at its target and is
 * gone, outside the window too. minion: a Bonedancer's, under its commander. charm: a mob taken over, in the window.
 */
export type PetSpellKind = 'main' | 'turret' | 'fnf' | 'bomber' | 'minion' | 'charm';

const PET_SPELL_KINDS = new Map<string, PetSpellKind>([
    ['SummonSimulacrum', 'main'], ['SummonSpiritFighter', 'main'], ['SummonUnderhill', 'main'], ['SummonDruidPet', 'main'],
    ['SummonHunterPet', 'main'], ['SummonCommander', 'main'], ['SummonNecroPet', 'main'],
    ['SummonAnimistPet', 'turret'],
    ['SummonTheurgistPet', 'fnf'], ['SummonAnimistFnF', 'fnf'],
    ['Bomber', 'bomber'],
    ['SummonMinion', 'minion'],
    ['Charm', 'charm'],
]);

/** The kind of a spell's static type (SpellInfo.type, eSpellType.cs), or null when it is none of these. */
export function petSpellKind(type: string): PetSpellKind | null {
    return PET_SPELL_KINDS.get(type) ?? null;
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

/** What a message calls an object: some NPCs have no name, and the line would start with nothing. */
export function nameOf(o: { name: string; objectId: number }): string {
    return o.name || `#${o.objectId}`;
}

export function describeTarget(target: unknown): string {
    if (typeof target === 'number') return `#${target}`;
    if (typeof target === 'string') return `"${target}"`;
    if (target instanceof RegExp) return String(target);
    if (target && typeof target === 'object' && 'name' in target) return `"${(target as { name: string }).name}"`;
    return String(target);
}

/** A monster's name with the article the server gives it (GameObject.GetName): "the ruby simulacrum", but "Spore Spewer". */
export function theName(name: string): string {
    return isMonsterName(name) ? `the ${name}` : name;
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

    /** First message containing one of `phrases` (lowercase substrings or RegExps), of those `where` accepts. */
    find(phrases: readonly (string | RegExp)[], where?: (m: GameMessage) => boolean): GameMessage | null {
        for (const m of this.messages()) {
            if (where && !where(m)) continue;
            const text = m.text.toLowerCase();
            if (phrases.some(p => typeof p === 'string' ? text.includes(p) : p.test(m.text))) return m;
        }
        return null;
    }

    /** Text of the first matching message, or null. */
    findText(phrases: readonly (string | RegExp)[], where?: (m: GameMessage) => boolean): string | null {
        return this.find(phrases, where)?.text ?? null;
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

    /** A name match that prefers what isn't a pet, else our own "wolf cub" beats a hostile "young wolf" on length (npctemplate.sql:12736). */
    private bestNonPetMatch<T extends { name: string; distance?: number }>(items: readonly T[], pattern: NamePattern): T | null {
        return bestNameMatch(items.filter(o => !('isPet' in o && o.isPet)), pattern) ?? bestNameMatch(items, pattern);
    }

    resolveNpc(target: NpcTarget, opts: { maxDistance?: number } = {}): NearbyNpc | null {
        const npcs = this.sdk.getNearbyNpcs();
        if (typeof target === 'number') return npcs.find(n => n.objectId === target) ?? null;
        if (typeof target === 'string' || target instanceof RegExp) {
            return this.bestNonPetMatch(npcs.filter(n => opts.maxDistance === undefined || n.distance <= opts.maxDistance), target);
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
            return this.bestNonPetMatch<NearbyNpc | NearbyPlayer | NearbyObject>([...s.nearbyNpcs, ...s.nearbyPlayers, ...s.nearbyObjects], target);
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
     * Nor one from a mob that reads on a pet of ours: a swing of its would have named us, so that is a DoT's tick, with no 0x1B, saying where the spell landed some time ago (the model's own reading, CombatAnimation).
     * One reading 0 % still is one: the percent is truncated (GameLiving.cs:2621). Only its death ends it (npcJustDied).
     */
    attackers(state: BotWorldState | null = this.sdk.getState()): NearbyNpc[] {
        const p = state?.player;
        if (!state || !p) return [];
        const hitBy = this.hitUsBy(state, PLAYER_AIM_MS);
        const pets = this.ownPets(state);
        return state.nearbyNpcs.filter(n => !this.npcJustDied(state, n) && (n.targetObjectId === p.objectId || (hitBy.has(n.objectId) && isAttackable(n, p) && !(n.targetObjectId !== null && pets.has(n.targetObjectId)))));
    }

    /**
     * Dead by what the server said: an NPC's 0 % doesn't tell, it is truncated (GameLiving.cs:2621). A dead one has its 0xA2 type 0, which also
     * takes the entry, so an entry at 0 % with that event is one just going. Only a death since this entry appeared: the server hands a dead mob's id to the next object it adds (Region.cs:955), and the event stays in the ring. With no first sight, from an older client, any: the health keeps a new spawn out then, but not one at 0 %.
     */
    npcJustDied(state: BotWorldState | null, n: NearbyNpc): boolean {
        return n.healthPercent <= 0 && !!state?.combatEvents.some(e => e.kind === 'death' && e.targetObjectId === n.objectId && e.receivedAt > (n.firstSeenAt ?? 0));
    }

    /**
     * Whether an id gone from our view went by a death: its event within RECENT_DEATH_MS. Not for a longer past, as the server hands a dead mob's id to the next object it adds (Region.cs:955). A target merely out of view has none.
     */
    diedLately(state: BotWorldState | null, id: number): boolean {
        const since = Date.now() - RECENT_DEATH_MS;
        return !!state?.combatEvents.some(e => e.kind === 'death' && e.targetObjectId === id && e.receivedAt >= since);
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

    /** Our pets by object id: the window pet and the summons. */
    ownPets(state: BotWorldState | null): Set<number> {
        const ids = new Set(state?.summons ?? []);
        if (state?.pet) ids.add(state.pet.objectId);
        return ids;
    }

    /** NPCs whose current target is our window pet or a summon. */
    petAttackers(state: BotWorldState | null = this.sdk.getState()): NearbyNpc[] {
        const pets = this.ownPets(state);
        return (state?.nearbyNpcs ?? []).filter(n => n.targetObjectId !== null && pets.has(n.targetObjectId));
    }

    /**
     * Who one of our pets last swung or cast at, while that is recent and it hasn't died: the server gives a dead mob's
     * id to the next object it adds (Region.cs:955, :779). A swing has a target; a bow draw in an older client's events has none.
     */
    private lastPetAim(state: BotWorldState, petId: number): number | null {
        const pets = this.ownPets(state);
        const me = state.player?.objectId;
        const last = state.combatEvents.findLast(e => (e.kind === 'melee' || e.kind === 'spellEffect') && e.attackerObjectId === petId && e.targetObjectId !== null && e.targetObjectId !== me && !pets.has(e.targetObjectId));
        if (!last || last.receivedAt < state.timestamp - PET_AIM_MS) return null;
        return state.combatEvents.some(e => e.id > last.id && e.kind === 'death' && e.targetObjectId === last.targetObjectId) ? null : last.targetObjectId;
    }

    /** Who our summons aim at: what a summon's own 0xA1 names, and the last one each swung or cast at. They have no PetState to hold it. */
    private summonAims(state: BotWorldState): number[] {
        const aims: number[] = [];
        for (const id of state.summons ?? []) {
            const named = state.nearbyNpcs.find(n => n.objectId === id)?.targetObjectId;
            if (named) aims.push(named);
            const last = this.lastPetAim(state, id);
            if (last !== null) aims.push(last);
        }
        return aims;
    }

    private livingInView(state: BotWorldState, objectId: number): NearbyNpc | NearbyPlayer | undefined {
        return state.nearbyNpcs.find(n => n.objectId === objectId) ?? state.nearbyPlayers.find(pl => pl.objectId === objectId && !pl.isDead);
    }

    /**
     * Who our pets are fighting, or null: the window pet's target (the model holds it between casts and through a run-in,
     * and an order calling it off clears it), else a mob on it or on a summon, else what a summon aims at, if that is an enemy.
     * Only one in view counts: the model keeps the target of a pet out of view until the pet's next 0xA1, and a pet can stay out of view for a long time.
     */
    petFoe(state: BotWorldState | null = this.sdk.getState()): NearbyNpc | NearbyPlayer | null {
        const id = state?.pet?.targetObjectId;
        const foe = (state && id ? this.livingInView(state, id) : undefined) ?? this.petAttackers(state)[0];
        if (foe || !state) return foe ?? null;
        const realm = state.player?.realm;
        for (const aim of this.summonAims(state)) {
            const summonFoe = this.livingInView(state, aim);
            if (summonFoe && summonFoe.realm !== realm) return summonFoe;
        }
        return null;
    }

    /**
     * A pet of ours in a fight, in words, or null: who it fights (petFoe), else one whose entry reads in combat with nobody
     * to name, such as one running at a mob: its 0xA1 reads 0xFFFF (PacketLib168.cs:820-828). That can trail a kill by a moment: a pet on the move has its next 0xA1 at once (NpcMovementComponent.cs:145-149). The model clears one that named the mob, and the window pet's at the death of its target, whatever it read.
     * Standing still it counts only while our own combat clock runs: a minion of a passive commander can go on reading 0xFFFF after its mob's death, for as long as nothing
     * changes, and the server repeats that every 5 s (ClientService.cs:820, ControlledMobState.cs:124). The window pet's aim the model knows, so that one standing still with none is in no fight, our clock or not:
     * a turret is still IsAttacking after its kill and reads 0xFFFF until its next update, about 5 s on (PacketLib168.cs:820-828, ClientService.cs:816-823). An order sets that aim, a swing too.
     */
    petFightLine(state: BotWorldState | null = this.sdk.getState()): string | null {
        const foe = this.petFoe(state);
        if (foe) return `our pet is fighting ${foe.name}`;
        const pets = this.ownPets(state);
        const noAim = (n: NearbyNpc): boolean => n.objectId === state?.pet?.objectId && state.pet.targetObjectId === null;
        const busy = state?.nearbyNpcs.find(n => n.inCombat && pets.has(n.objectId) && (n.speed > 0 || (state.player?.inCombat && !noAim(n))));
        return busy ? `our ${busy.name} is in a fight` : null;
    }

    /** A summon of ours in its first moments, in words, or null: one that fights by itself is in its fight from the start, with nothing to show for it yet (BotWorldState.freshSummons). */
    freshSummonLine(state: BotWorldState | null = this.sdk.getState()): string | null {
        const fresh = state?.nearbyNpcs.find(n => state.freshSummons?.includes(n.objectId));
        return fresh ? `our ${fresh.name} has just come` : null;
    }

    /**
     * Object ids in a fight with our pets, window pet or summons: the mobs on one, the one the window pet aims at, what a
     * summon aims at, and the last one any of them swung or cast at (a caster pet that isn't swinging reads target 0 in
     * 0xA1, PacketLib168.cs:745, :820), while that is recent and it hasn't died.
     */
    petMobIds(state: BotWorldState | null = this.sdk.getState()): Set<number> {
        const ids = new Set<number>();
        if (!state) return ids;
        for (const n of this.petAttackers(state)) ids.add(n.objectId);
        const pet = state.pet;
        if (pet) {
            if (pet.targetObjectId !== null) ids.add(pet.targetObjectId);
            const last = this.lastPetAim(state, pet.objectId);
            if (last !== null) ids.add(last);
        }
        for (const id of this.summonAims(state)) ids.add(id);
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
