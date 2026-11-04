// Pets in a group. petControl is the one authority over a window pet: no killNpc in the group orders it
// (usePet false), so it goes where the coordinator's focus goes and nowhere else. summonPet keeps one up,
// petHeal and petBuff look after it, and fnfPet is a Theurgist's, whose pets have no window and fight their
// target alone. withPets puts them in the list of a member that has a use for them.
//
// Server rules they follow (server/core/GameServer):
//  - An attack order acts on the owner's target, within 2000 of him (GamePlayer.cs:12178-12195), so it selects
//    first. The same target again changes nothing (ControlledMobBrain.cs:216-217) and still prints a line.
//  - A defensive pet does nothing unasked until its owner is attacked (ControlledMobBrain.cs:614-638). Only an
//    aggressive one takes what comes near (ControlledMobState.cs:92-93), so one is never left aggressive.
//  - An ordered target isn't checked for a mezz (ControlledMobBrain.cs:528-542), and a swing breaks one even
//    when it misses (GameLiving.cs:1686-1707): no crowd-controlled target, and none a mezz is on its way to.
//  - Passive breaks off the fight and resumes the walk (ControlledMobBrain.cs:199-203), and hits on a passive pet
//    draw no aggro (StandardMobBrain.cs:555). An attack order lifts passive to defensive (:213-214).
//  - A window pet goes with its owner's death, a region change and a quit (GamePlayer.cs:5988-5989, :7886-7887, :927-928):
//    a release leaves no pet, and summonPet casts before the walk back.
//  - A defensive pet answers whoever hits its owner in ~33 ms, unordered (ControlledMobBrain.cs:614-638, live), so a hold reaches a tank's own pet only as passive, and hits on a passive one
//    draw no aggro. Passive doesn't shed a mob already on it (live).
//  - Off every zone the server dereferences a null zone: a pet there is removed, a summon kicks its caster (terrain.ts onMap).
//  - A pet steps in front of its owner within 128, passive too, and every client's 0xBC then names the pet with the mob still on the owner (AttackComponent.cs:1429-1436, :1492-1498): the board reads that as it is (blackboard.ts), and a fresh reading on a pet waits for it (readsOnPet).

import type { BotActions } from '../actions';
import { firstReasonLine, PET_ANSWERS, PET_REFUSALS, PVP_IMMUNE_RETRY_MS } from '../actions-helpers';
import type { BotSDK } from '../index';
import type { NearbyNpc, NearbyPlayer, PetCommand, PetState, PlayerState } from '../types';
import { beyondLeash, buffRetryMs, ccHolds, claimedBy, farFromFight, foeInView, holdState, isDown, QUIET_PHASES, REST_MANA_UP_TO, SAVING_POWER, stopSwinging, underGuards, type TacticsSettings } from './behaviors';
import { isAlive, readsOnPet } from './blackboard';
import { ROLE_FIGHT, type Character } from './character';
import type { Behavior, MemberContext } from './member';
import { Spellbook } from './spells';
import { onMap } from './terrain';
import type { Contact, MemberReport } from './types';

export interface PetSettings {
    /** false: the run has no pets. No pet behaviours on a list, none to keep up in a member's capabilities (so nobody waits on its power or its pet, and the report has none), and the run's end leaves one that is up alone. */
    enabled: boolean;
    /** The tank must hold the focus this long before a pet goes in; 0 doesn't wait (default: holdMs). A focus on someone else: assistAfterMs, or this if longer. */
    holdMs?: number;
    /** Summon a main pet only at or above this power %: most cost 25 %, 30 % for a focus caster with no focus (worstPowerCost). */
    summonMana: number;
    /** petHeal below this pet health % in a fight (between fights: QUIET_HEAL_BELOW). */
    healBelow: number;
    /** fnfPet stops below this power %, or its character's floor if higher (Character.pet). A Theurgist's pets are 12-15 % each, and thrifty wraps only assist. */
    fnfFloor: number;
    /**
     * fnfPet casts only on a focus with this long left after its cast, at the rate it has gone down since its first loss of the fight: a pet pays at the end of its cast, its first hit comes about 3 s later, and it goes
     * with its target. So a fight of 11 s stays on nukes and a long one gets pets. What it weighs at low level: at L10 one pet is 15-18 % of the pool against 6 power for a nuke of 41, for hits of 13-15 per 2.8 s (10 pets 72 damage against 15 nukes 505).
     */
    fnfLifeMs: number;
    /** Hold pulls for a member with no main pet (Orders.waiting, why 'pet'). Off: a member that can't summon would hold them for good. */
    waitForSummon: boolean;
    /**
     * Unset, outside a fight a pet comes off a fight only with no threats about: what it fights stays a threat for as long as it does (Blackboard petsOn), and decidePve and decideRvr turn a threat into an engage on their next tick.
     * On, for a strategy whose orders don't: decidePack walks off and rests with one in sight, with the pet fighting on alone and nobody able to sit. It comes off whatever the threats, and stays passive until the next fight.
     */
    strayFightsOff?: boolean;
}

export const PET_SETTINGS: PetSettings = { enabled: true, summonMana: 30, healBelow: 50, fnfFloor: 20, fnfLifeMs: 10_000, waitForSummon: false };

/** The owner's reach for an attack order (GamePlayer.cs:12183): beyond it the order only gets "Your target is too far away to attack with your pet!". */
const PET_ORDER_RANGE = 2000;
/** The same stance or walk order again no sooner than this: the answer shows a snapshot later, and every order prints a line whether it changes anything or not. */
const ORDER_THROTTLE_MS = 1500;
/** The same attack order again no sooner than this: a pet on its way can read no target. */
const ATTACK_THROTTLE_MS = 3000;
/** How long another member's crowd-control cast counts as on its way (crowdControl's own claim). */
const CC_CLAIM_MS = 4000;
/** A summon stands still for 6 s: not with an enemy player this near. */
const SUMMON_ENEMY_RADIUS = 2500;
/** Between fights, petHeal tops the pet up below this: its own regen is nothing for ~20 s after a fight, then ~10 % per 6 s (live). */
const QUIET_HEAL_BELOW = 80;
/** ... but only with this much power, as for a heal on a member out of combat. */
const QUIET_HEAL_MANA = 50;
/** In a fight a heal on friends goes on the pet only with this % of the pool left after it: those are the group's heals, out of one pool. A Pet-target heal is a tenth of that. */
const PET_HEAL_RESERVE = 25;
/** After a refused fire-and-forget summon or pet heal: the fight goes on without one this long. */
const PET_SPELL_RETRY_MS = 5000;
/** fnfPet judges a focus's rate after this much damage and not before. */
const FNF_JUDGE_MS = 2000;
/** A summon's pet comes up 64 ahead of its caster (SummonSpellHandler.cs:76-77): it stands this far in from the map's edge. */
const SUMMON_MAP_MARGIN = 100;
/** The answer to an attack order comes in a snapshot or two. None by now: the server says nothing to a dead target or a peace flag (PET_REFUSALS). */
const ATTACK_ANSWER_MS = 2000;
/** An accepted order to a pet that hasn't closed or hit for this long goes once more: the server drops an order whose target stops being allowed, a login's immunity say (ControlledMobBrain.cs:528-542). */
const PET_STANDS_MS = 5000;
/** Nearer by less than this is no closing. */
const PET_CLOSING = 30;
/** A heal shows on the pet's entry 400-600 ms after it lands (live): until the reading changes, or this long, another would go on the one from before. */
const PET_HEAL_READING_MS = 1000;
/** ... this long with "is fully healed" on top. */
const PET_FULLY_HEALED_MS = 3000;
/** A turn doing these uses no selection of the server's, so an attack order's select disturbs nothing in it. */
const SELECTS_NOTHING: ReadonlySet<string> = new Set(['move', 'flee', 'release', 'rest', 'drop']);

/** Why a summon doesn't go. */
const OFF_THE_MAP = 'pet: off the map, no summon';

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
/** A setting that can come in as a flag's text (--pet.enabled=false). */
const isOn = (v: unknown) => v === true || v === 'true';

function petSettings(ctx: MemberContext<TacticsSettings>): PetSettings {
    const s = { ...PET_SETTINGS, ...ctx.settings.pet };
    return { ...s, enabled: isOn(s.enabled) };
}

/** Whether a run has pets at all, from its settings (PetSettings.enabled). Strategies' own settings needn't have any: on. */
export function petsAllowed(settings: unknown): boolean {
    const on = (settings as { pet?: Partial<PetSettings> } | null | undefined)?.pet?.enabled;
    return on === undefined || isOn(on);
}

/** Whether the coordinator holds pulls for this member's pet (PetSettings.waitForSummon). */
export function waitsForPet(m: Pick<MemberReport, 'capabilities' | 'pet'>, s: Partial<PetSettings> | undefined): boolean {
    return petsAllowed({ pet: s }) && isOn(s?.waitForSummon) && m.capabilities.pet === 'main' && m.pet === null;
}

/** Whether it has crowd control on it that holds (ccHolds), or on its way to it (orders, another member's cast, or our own turn's): a swing would break that. */
function underCc(ctx: MemberContext<TacticsSettings>, c: Contact): boolean {
    const turn = ctx.turn();
    return ccHolds(ctx, c) || ctx.orders().cc.some(a => a.targetId === c.objectId) || claimedBy(ctx, 'cc', c.objectId, CC_CLAIM_MS).length > 0 || (turn?.kind === 'cc' && turn.targetId === c.objectId);
}

/** Whether this member brings the mob itself: the tank, or the puller of this focus, through the fight its pull became (the orders name no puller then). */
function bringsIt(ctx: MemberContext<TacticsSettings>): boolean {
    const o = ctx.orders();
    return ctx.isTank() || (o.focus !== null && (o.puller === ctx.name || ctx.memory.get('pulled') === o.focus));
}

/** Our first swing on this focus since the engage order: a carried pull's came long before. Null without one. */
function firstSwingAt(ctx: MemberContext, mob: Contact): number | null {
    const me = ctx.me().objectId;
    return ctx.sdk.getState()?.combatEvents.find(e => e.kind === 'melee' && e.attackerObjectId === me && e.targetObjectId === mob.objectId && e.receivedAt >= mob.engagedAt)?.receivedAt ?? null;
}

/**
 * Whether the hold on `mob` is done, for our pet: pet.holdMs, by holdState (an enemy player at once, a mob on this very pet too: nothing gets it off, and the pet's swings only hold it).
 * For the member who brings the mob, also pet.holdMs after its own first swing, whoever the mob is on.
 */
function holdDone(ctx: MemberContext<TacticsSettings>, s: PetSettings, mob: Contact): boolean {
    const hold = s.holdMs ?? ctx.settings.holdMs;
    const now = Date.now();
    if (mob.kind === 'player' || hold === 0 || readsOnPet(mob, now, ctx.name)) return true;
    // holdState's fallback would cap a hold set above it, on a mob the tank holds too.
    if (holdState(mob, ctx.tank()?.name ?? null, hold, Math.max(hold, ctx.settings.assistAfterMs), now).held) return true;
    if (!bringsIt(ctx)) return false;
    const swing = firstSwingAt(ctx, mob);
    return swing !== null && now >= swing + hold;
}

/**
 * A tank's or puller's own pet: passive through its own pull and until the hold is done, as a defensive one would take the mob unordered with the first hit on its owner; the attack order lifts that.
 * Not with the mob already on this pet (passive wouldn't shed it), and only for a monster: nothing holds a player, and an enemy pet's owner is what we're after.
 * Nor once its order has gone: the mob turning to the tank inside the hold restarts targetSince and un-does holdDone, and passive would break the fight off only for the order to go again a moment later.
 * A reading on this pet too fresh to act on (readsOnPet) changes no stance either way: it neither lifts a passive pet nor turns a defensive one passive.
 */
function heldBack(ctx: MemberContext<TacticsSettings>, s: PetSettings, focus: Contact | undefined): boolean {
    if (!focus || focus.kind !== 'npc' || focus.isPet) return false;
    if (focus.targetPet === ctx.name && (readsOnPet(focus, Date.now(), ctx.name) || ctx.sdk.getPetState()?.aggression !== 'passive')) return false;
    const o = ctx.orders();
    if (o.phase === 'pull') return o.puller === ctx.name;
    return o.phase === 'engage' && bringsIt(ctx) && !orderInForce(ctx, focus.objectId) && !holdDone(ctx, s, focus);
}

/** Our attack order on this target stands: the pet is on it, or on its way, as one on its way can read no target. A refused one doesn't. */
function orderInForce(ctx: MemberContext, id: number): boolean {
    const pet = ctx.sdk.getPetState();
    const last: AttackOrder | undefined = ctx.memory.get('petAttack');
    if (!pet || last?.id !== id || last.until !== undefined) return false;
    return pet.targetObjectId === id || (pet.targetObjectId === null && Date.now() - last.at < ATTACK_THROTTLE_MS);
}

/**
 * The orders' focus if a pet may go for it now: engaged, alive, in our region and our client's view, not under crowd control (a root with nothing else free in the fight has done its job: ccHolds), inside the leash,
 * and held by the tank for pet.holdMs (an enemy player at once, as for assist). A pet takes nothing else: no add, no stand-in for a
 * focus beyond the leash. Ids are per region (Region.cs:151, :779), so from a bind elsewhere an NPC beside us can hold the focus's.
 */
function prey(ctx: MemberContext<TacticsSettings>, s: PetSettings): { mob: Contact; seen: NearbyNpc | NearbyPlayer } | null {
    const mob = ctx.focus();
    if (ctx.orders().phase !== 'engage' || !mob || mob.regionId !== ctx.me().regionId || mob.stale || !isAlive(mob) || underCc(ctx, mob) || beyondLeash(ctx, mob)) return null;
    const seen = foeInView(ctx, mob.objectId);
    if (!seen || isDown(ctx, seen)) return null;
    return holdDone(ctx, s, mob) ? { mob, seen } : null;
}

/**
 * How long a focus has left at the rate it has gone down since its first loss of the fight: what's on it already, pets too, is in that rate. Null until there have been FNF_JUDGE_MS of damage to tell by.
 * Not from when it turned hostile: on a body pull that's seconds before any damage, and at hp 52-79 it read well over what a pet needs with the mob 3-6 s from dead (c1on).
 */
function lifeLeftMs(mob: Contact, now: number): number | null {
    if (mob.lossSince === undefined || mob.lossFromHp === undefined || now - mob.lossSince < FNF_JUDGE_MS || mob.hp >= mob.lossFromHp) return null;
    return (now - mob.lossSince) * mob.hp / (mob.lossFromHp - mob.hp);
}

/**
 * Our own cast still running: its 0x72 (the event castSpell watches) plus its cast time, unless an 0x0B ended it. No behaviour of
 * ours overlaps one (a cast doesn't get interrupted, and the list waits for it), but a routine's raw send or a cast that came back early can.
 */
export function castRunning(ctx: MemberContext): boolean {
    const me = ctx.me().objectId;
    const events = ctx.sdk.getState()?.combatEvents ?? [];
    const cast = events.findLast(e => e.kind === 'spellCast' && e.attackerObjectId === me);
    if (!cast || Date.now() - cast.receivedAt >= (cast.castTimeMs ?? 0)) return false;
    return !events.some(e => e.id > cast.id && e.kind === 'interrupt' && e.attackerObjectId === me);
}

/**
 * Whether an attack order's select may go now: it moves the server's target (0xB0), which a cast's end check reads and a swing follows. So not while the turn runs on another target, whose cast
 * would land where the select went (castSpell selects, then sends), and not in our own cast or swing at anything else. With that target selected already there is nothing to disturb: a tank's killNpc has the focus.
 * A swing with nothing to hit, on a corpse or at what has left the world, is nothing to disturb either: 8 s of it held an order live, with the pet following while the focus stood free (run 20261104-044005).
 */
function selectFree(ctx: MemberContext, id: number): boolean {
    const turn = ctx.turn();
    if (turn && turn.targetId !== id && !SELECTS_NOTHING.has(turn.kind)) return false;
    const me = ctx.me();
    return me.targetObjectId === id || ((!me.attacking || swingOnNothing(ctx, me)) && !castRunning(ctx));
}

/** Attack mode on at nothing that can be hit: no target, or a dead or gone one. */
function swingOnNothing(ctx: MemberContext, me: PlayerState): boolean {
    const seen = me.targetObjectId === null ? null : foeInView(ctx, me.targetObjectId);
    return !seen || isDown(ctx, seen);
}

/**
 * Send a stance or walk order. Only a repeat waits ORDER_THROTTLE_MS: a retreat's passive can't wait for the defensive of a moment ago when a phase flaps,
 * because retreat's walk then keeps the next turn away for up to 20 s. Dispatch only: the window shows the answer.
 */
async function order(ctx: MemberContext, kind: 'stance' | 'walk', command: PetCommand): Promise<void> {
    const key = `petOrder:${kind}`;
    const last: { command: PetCommand; at: number } | undefined = ctx.memory.get(key);
    if (last?.command === command && Date.now() - last.at < ORDER_THROTTLE_MS) return;
    ctx.memory.set(key, { command, at: Date.now() });
    const r = await ctx.sdk.sendPetCommand(command);
    if (!r.success) ctx.result('petOrder', r);
}

/** The attack order in force, in a member's memory. */
interface AttackOrder {
    id: number;
    at: number;
    /** The last server line when it went out: the answer comes after that. */
    seen: number;
    answered: boolean;
    /** A refusal's: not again before this (else ATTACK_THROTTLE_MS from `at`). */
    until?: number;
    /** When "You command" came. */
    acceptedAt?: number;
    /** How near the pet has come to the target since, and when. */
    gap?: number;
    gapAt?: number;
    /** It stood, and got its one more. */
    resent?: boolean;
}

/** Order the pet onto a target, selected in the same call: always, since the server drops our target on a death without saying so (GamePlayer.cs:5743). This is a dispatch: attackAnswer reads what the server made of it. */
async function orderAttack(ctx: MemberContext, id: number): Promise<void> {
    const last: AttackOrder | undefined = ctx.memory.get('petAttack');
    const now = Date.now();
    if (last?.id === id && now < (last.until ?? last.at + ATTACK_THROTTLE_MS)) return;
    const sent: AttackOrder = { id, at: now, seen: ctx.sdk.getGameMessages().at(-1)?.id ?? -1, answered: false };
    ctx.memory.set('petAttack', sent);
    const r = await ctx.sdk.sendPetCommand('attack', id);
    if (r.success) return;
    sent.answered = true;
    ctx.result('petAttack', r, id);
}

/**
 * The server's answer to the last attack order, on the ticks after it, for ctx.result: "You command", or a refusal from the table bot.petAttack reads, which also sets when the order may go again
 * (the "immune" lines: PVP_IMMUNE_RETRY_MS, as bot.petAttack says; else the flat throttle). No line in ATTACK_ANSWER_MS: no_response, unless the target went meanwhile.
 */
function attackAnswer(ctx: MemberContext): void {
    const order: AttackOrder | undefined = ctx.memory.get('petAttack');
    if (!order || order.answered) return;
    const now = Date.now();
    for (const m of ctx.sdk.getGameMessages()) {
        if (m.id <= order.seen) continue;
        const refusal = firstReasonLine([m], PET_REFUSALS);
        if (!refusal && !PET_ANSWERS.attack.test(m.text)) continue;
        order.answered = true;
        if (refusal) order.until = now + (refusal.reason === 'immune' ? PVP_IMMUNE_RETRY_MS : ATTACK_THROTTLE_MS);
        else order.acceptedAt = now;
        ctx.result('petAttack', refusal ? { success: false, reason: refusal.reason, message: refusal.text } : { success: true }, order.id);
        return;
    }
    if (now - order.at < ATTACK_ANSWER_MS) return;
    order.answered = true;
    if (ctx.contact(order.id)) ctx.result('petAttack', { success: false, reason: 'no_response', message: 'No answer to the attack order' }, order.id);
}

/** An accepted order on this target, and the pet not closing and with no swing or spell on it for PET_STANDS_MS: it stands. Once per order. */
function standsIdle(ctx: MemberContext, pet: PetState, target: NearbyNpc | NearbyPlayer): boolean {
    const order: AttackOrder | undefined = ctx.memory.get('petAttack');
    const entry = ctx.sdk.getPet();
    if (!entry || order?.id !== target.objectId || order.acceptedAt === undefined || order.resent) return false;
    const now = Date.now();
    const gap = dist(entry, target);
    if (order.gap === undefined || gap < order.gap - PET_CLOSING) { order.gap = gap; order.gapAt = now; }
    if (now - Math.max(order.gapAt!, order.acceptedAt) < PET_STANDS_MS) return false;
    return !ctx.sdk.getState()?.combatEvents.some(e => e.attackerObjectId === pet.objectId && now - e.receivedAt < PET_STANDS_MS
        && (e.kind === 'spellCast' || ((e.kind === 'melee' || e.kind === 'spellEffect') && e.targetObjectId === target.objectId)));
}

/** The fight it's in is one petControl sent it into. A pet on its way can read no target, so just after the order that counts too. */
function inOurFight(ctx: MemberContext, pet: PetState): boolean {
    const last: AttackOrder | undefined = ctx.memory.get('petAttack');
    if (!last) return false;
    return pet.targetObjectId === last.id || (pet.targetObjectId === null && Date.now() - last.at < ATTACK_THROTTLE_MS);
}

/**
 * The end of a run. A pet would fight on, and its fight counts as ours: it follows. A passive that petControl ordered goes with the run that asked for it: stance and walk are
 * packets of their own (PetWindowHandler.cs:18-36), only a stance or attack order lifts it, and the next script's killNpc orders no passive pet. `memory`: the member's, if its agent got to run.
 * `leftAlone` (petLeftAlone): a turret or a shade's pet, which petControl never orders either.
 */
export async function petAfterRun(sdk: Pick<BotSDK, 'getPetState' | 'sendPetCommand'>, memory: ReadonlyMap<string, any> | undefined, leftAlone = false): Promise<void> {
    if (leftAlone || !sdk.getPetState()) return;
    if (memory?.get('petOrder:stance')?.command === 'passive') await sdk.sendPetCommand('defensive');
    await sdk.sendPetCommand('follow');
}

/**
 * Whether this pet stays passive for want of petAfterRun: the connection was cut, by another controller taking the bot over or by a lost gateway, so that can't be sent. Only the next run's stance or attack order lifts it.
 * `memory`: as for petAfterRun. What petControl last asked for, as a cut connection's window can trail it.
 */
export function leftPassive(sdk: Pick<BotSDK, 'getPetState'>, memory: ReadonlyMap<string, any> | undefined): boolean {
    return !!sdk.getPetState() && memory?.get('petOrder:stance')?.command === 'passive';
}

/** What a run's pets wait out on a monster before they are ordered in, from its settings as holdDone goes by them; undefined with neither. */
export function petHoldOf(settings: unknown): number | undefined {
    const s = settings as { holdMs?: unknown; pet?: { holdMs?: unknown } } | null | undefined;
    const hold = Number(s?.pet?.holdMs ?? s?.holdMs);
    return Number.isFinite(hold) ? hold : undefined;
}

/**
 * The window pet follows the orders. In a fight it goes for the focus (prey); off a target it may not have (crowd-controlled, beyond
 * the leash) it comes away. With a focus or a target beyond the leash (or under a keep's guards) and nothing to order it onto, it also stays passive: a defensive pet goes for
 * whoever hits its owner, from any range, and a follow holds only until the next hit (ControlledMobBrain.cs:614-638, GamePlayer.cs:12200-12209). An attack order lifts that.
 * On retreat it turns passive and follows. Otherwise a pet's fight doesn't start on its own: it comes off the focus during a pull (the tank's to bring) and off a stray fight
 * between fights, which would slow our regen (GamePlayer.cs:2318-2320), and in a strategy that walks off with a threat in sight off any (pet.strayFightsOff).
 *
 * It runs on the member's side tick, every 250 ms, between and during turns: as a turn it waited for a tank's killNpc to the mob's death and a nuker's walk and cast, and a pet stayed on an add and
 * broke a root. It only sends, and it never acts. A shade's pet (a Necromancer's tactics are its own)
 * and a turret (an order only stops what it does) are left alone. So is a pet on `stay` until a focus is ordered: that's the character's routine.
 * A fight petControl itself sent a parked pet into stays petControl's to end: an ordered pet keeps walk stay (ControlledMobBrain.cs:211-226).
 * A 0x8A interrupts no cast, so stance and walk orders go at once. The select in an attack order changes the server's target: that order waits for selectFree. It looks for the server's answer on the ticks after (attackAnswer),
 * and an accepted order to a pet that stands goes once more. A tank's or puller's own pet stays passive until its hold is done (heldBack), and any pet with a crowd-controlled mob on it or on its owner stays passive until its order goes out, or stands: it would hit back or answer the hit, in ~33 ms from defensive, and with no order a focus to go for changes nothing. A rooted add goes on swinging at whoever is in its reach.
 * A threat under a keep's guards holds the stance as well, whatever the phase reads: its aim lapses in 6 s and the fight with it (decideRvr), and it can hit again.
 * The last stance order goes with the pet it went to: a new one comes up defensive (ControlledMobBrain.cs:56, CharacterClassBase.cs:317), and petAfterRun and leftPassive read that memory.
 */
export const petControl = (): Behavior<TacticsSettings> => ({
    name: 'petControl',
    side: true,
    interruptible: false,
    async run(ctx) {
        const s = petSettings(ctx);
        const pet = ctx.sdk.getPetState();
        if (!pet) ctx.memory.delete('petOrder:stance');
        if (!s.enabled || !pet || ctx.bot.isDead() || ctx.me().isShade || ctx.spells.knowsTurret()) return false;
        const o = ctx.orders();
        attackAnswer(ctx);
        const parked = pet.walk === 'stay';
        if (parked && o.focus === null && !inOurFight(ctx, pet)) return false;
        if (o.phase === 'retreat') {
            if (pet.aggression !== 'passive') await order(ctx, 'stance', 'passive');
            if (pet.walk !== 'follow' || pet.targetObjectId !== null) await order(ctx, 'walk', 'follow');
            return false;
        }
        const on = pet.targetObjectId;
        const go = prey(ctx, s);
        const fighting = ctx.contact(on);
        const focus = ctx.focus();
        if (o.phase === 'pull' && o.puller === ctx.name) ctx.memory.set('pulled', o.focus);
        const orderGoes = !!go && go.seen.distance <= PET_ORDER_RANGE && selectFree(ctx, go.mob.objectId);
        const strays = isOn(s.strayFightsOff) && o.phase !== 'engage' && o.phase !== 'pull';
        // Only an order that goes now lifts this, or one that stands: passive would break that fight off at every heal turn (ControlledMobBrain.cs:199-203).
        const ccOnIt = ctx.picture().contacts.some(c => (c.targetPet === ctx.name || c.target === ctx.name) && !c.stale && underCc(ctx, c)) && !orderGoes && !(go && (on === go.mob.objectId || orderInForce(ctx, go.mob.objectId)));
        const holdOff = ccOnIt || strays || (!go && ((o.phase === 'engage' && [focus, fighting].some(c => !!c && beyondLeash(ctx, c))) || heldBack(ctx, s, focus) || ctx.threats().some(c => underGuards(ctx, c))));
        const stance = holdOff ? 'passive' : 'defensive';
        if (!parked && pet.aggression !== stance) await order(ctx, 'stance', stance);
        // Calling it off leaves a parked pet parked: both orders end its fight (GamePlayer.cs:12200-12225).
        const away = parked ? 'stay' : 'follow';
        if (o.phase === 'engage') {
            // Read again: the stance order above can have taken a moment, and the turn can have announced itself meanwhile.
            if (go && go.seen.distance <= PET_ORDER_RANGE && selectFree(ctx, go.mob.objectId)) {
                const stands = on === go.mob.objectId && standsIdle(ctx, pet, go.seen);
                if (on !== go.mob.objectId || stands) {
                    await orderAttack(ctx, go.mob.objectId);
                    if (stands) (ctx.memory.get('petAttack') as AttackOrder).resent = true;
                    return false;
                }
            }
            if (fighting && (underCc(ctx, fighting) || beyondLeash(ctx, fighting))) await order(ctx, 'walk', away);
            return false;
        }
        if (on === null) return false;
        // Off the focus in a pull, unless it is on this pet: that can't be walked off, and the coordinator starts the fight there on its next tick.
        if (o.phase === 'pull' ? on === o.focus && focus?.targetPet !== ctx.name : strays || !ctx.threats().length) await order(ctx, 'walk', away);
        return false;
    },
});

/**
 * Our own crowd control is about to go on `target`: our pet comes off it first, and turns passive as well if the mob is on it, or it hits back (run 163503: root 16:36:00.307, the pet's swing .505, its follow .738).
 * A turret, a shade's pet and a run with no pets stay out of it, as for petControl. It stays off: underCc reads our own turn and the mark that follows it.
 */
export async function petOffForCc(ctx: MemberContext<TacticsSettings>, target: Contact): Promise<void> {
    const pet = ctx.sdk.getState()?.pet;
    if (!pet || pet.targetObjectId !== target.objectId || !petSettings(ctx).enabled || ctx.me().isShade || ctx.spells.knowsTurret()) return;
    if (target.targetPet === ctx.name && pet.walk !== 'stay') await order(ctx, 'stance', 'passive');
    await order(ctx, 'walk', pet.walk === 'stay' ? 'stay' : 'follow');
}

/**
 * Summon the main pet we don't have, before the walk back if we just released. Not with anything hostile within SUMMON_ENEMY_RADIUS of us (the pull's mob on the way, a hostile focus, an
 * enemy player), which is what stops it, and not the phase: a roam's walk to a passive mob is an engage with no threat, and a fight 25000 off is no reason at a bind point. Never in a retreat or our own pull, and never off the map.
 * Below the power for it the turn goes on, and the rest below stops as soon as there is enough (REST_MANA_UP_TO, shown as SAVING_POWER): rested on to rest.mana it would
 * summon only when a pull cut that short, past the ready gate, and go into the fight on what was left. Summon spell, power and timer: Spellbook.summon.
 */
export const summonPet = (): Behavior<TacticsSettings> => ({
    name: 'summonPet',
    interruptible: false,
    async run(ctx) {
        const s = petSettings(ctx);
        ctx.memory.delete(REST_MANA_UP_TO);
        // undefined: a client from before pets.
        if (!s.enabled || ctx.sdk.getState()?.pet !== null || ctx.bot.isDead()) return false;
        const sp = ctx.spells.summon();
        if (!sp || sp.spell.cooldownRemaining > 0) return false;
        const o = ctx.orders();
        if (o.phase === 'retreat' || (o.phase === 'pull' && o.puller === ctx.name)) return false;
        const me = ctx.me();
        const near = (c: Contact) => c.regionId === me.regionId && dist(c, me) < SUMMON_ENEMY_RADIUS;
        if (ctx.threats().some(near)) return false;
        if (Date.now() < (ctx.memory.get('summonRetry') ?? 0)) return false;
        if (ctx.picture().contacts.some(c => c.kind === 'player' && !c.stale && near(c))) return false;
        if (!onMap(me.regionId, me, SUMMON_MAP_MARGIN)) return ctx.skip(OFF_THE_MAP);
        const cost = ctx.spells.powerOf(sp);
        if (me.mana < cost || me.manaPercent < s.summonMana) {
            ctx.memory.set(REST_MANA_UP_TO, Math.max(s.summonMana, Math.ceil(100 * cost / Math.max(1, me.maxMana))));
            return ctx.skip(SAVING_POWER);
        }
        ctx.doing('summon', null, sp.spell.name);
        const c = await ctx.bot.summonPet(sp.spell);
        ctx.result('summon', c);
        ctx.memory.set('summonRetry', Date.now() + buffRetryMs(c));
        return true;
    },
});

/**
 * summonPet on the way back from a release to a fight, where rejoinFight takes every turn and ends beside the fight, where its gate no longer lets a summon go. Near the fight this has no say:
 * summonPet stands in its own place there, below a rez and the heals.
 */
export const summonOnTheWayBack = (): Behavior<TacticsSettings> => {
    const summon = summonPet();
    return { ...summon, name: 'summonOnTheWayBack', run: ctx => (farFromFight(ctx) ? summon.run(ctx) : false) };
};

/**
 * A Theurgist's pet on the focus, by the rules for a window pet's order (prey), while the power is above pet.fnfFloor. No window and no
 * orders: it fights its target and goes when that dies (TheurgistPetBrain.cs:18-39). Counts as a nuke (the observer's opener). A refused
 * one (at most 16 at once, SummonTheurgistPet.cs:67-69) leaves the turn to the rest of the list for a while. Only on a focus with pet.fnfLifeMs left after the cast, by its rate since its
 * first loss of the fight (lifeLeftMs), and not before that has been judged: it pays at the end of the cast (SummonSpellHandler.cs:56) and gets little back from a short fight, and assist's nuke below lands at the end of the same cast.
 * `floor`: its character's own (Character.pet), the higher of that and pet.fnfFloor going.
 */
export const fnfPet = (floor = 0): Behavior<TacticsSettings> => ({
    name: 'fnfPet',
    interruptible: false,
    async run(ctx) {
        const s = petSettings(ctx);
        if (!s.enabled || Date.now() < (ctx.memory.get('fnfRetry') ?? 0)) return false;
        const sp = ctx.spells.fnf();
        if (!sp || sp.spell.cooldownRemaining > 0) return false;
        const me = ctx.me();
        if (me.mana < ctx.spells.powerOf(sp) || me.manaPercent < Math.max(s.fnfFloor, floor)) return false;
        if (!onMap(me.regionId, me, SUMMON_MAP_MARGIN)) return ctx.skip(OFF_THE_MAP);
        const go = prey(ctx, s);
        if (!go || go.seen.distance > sp.range) return false;
        const left = lifeLeftMs(go.mob, Date.now());
        if (left === null || left < sp.castTime * 1000 + s.fnfLifeMs) return false;
        await stopSwinging(ctx);
        ctx.doing('nuke', go.mob.objectId, sp.spell.name);
        const c = await ctx.bot.summonPet(sp.spell, { target: go.mob.objectId });
        ctx.result('nuke', c, go.mob.objectId);
        if (!c.success) ctx.memory.set('fnfRetry', Date.now() + Math.max(c.retryAfterMs ?? 0, PET_SPELL_RETRY_MS));
        return true;
    },
});

/**
 * Heal our pet below pet.healBelow, or between fights below QUIET_HEAL_BELOW with power to spare, with what covers what it misses (petMaxHp): a Druid's biggest heal on a L7 pet cost more than a new one. Pet-target heals land on the pet with no
 * target given, no walk and no select (castSpell), so only the range counts; with none, a heal on a friend goes at the pet's id (Spellbook.petHeal), in a fight only with PET_HEAL_RESERVE left. After one that landed it waits for the
 * pet's reading (healLanding). The rest doesn't wait for a hurt pet (no petHealthPercent): this is all it gets.
 */
/** Whether the last heal is still on its way to the pet's reading: the reading hasn't changed since, for PET_HEAL_READING_MS, or PET_FULLY_HEALED_MS with the server's "The ruby simulacrum is fully healed." */
function healLanding(ctx: MemberContext, pet: NearbyNpc): boolean {
    const landed: { at: number; hp: number; full: boolean } | undefined = ctx.memory.get('petHealLanded');
    if (!landed) return false;
    const over = () => { ctx.memory.delete('petHealLanded'); return false; };
    if (pet.healthPercent !== landed.hp) return over();
    landed.full ||= ctx.sdk.getGameMessages().some(m => m.receivedAt >= landed.at && isFullyHealed(m.text, pet.name));
    return Date.now() - landed.at < (landed.full ? PET_FULLY_HEALED_MS : PET_HEAL_READING_MS) || over();
}

const isFullyHealed = (line: string, name: string) => line.endsWith(' is fully healed.') && line.toLowerCase().includes(name.toLowerCase());

/** A summoned pet's full health by its level, unbuffed: CON 30 + level - 1, a template's percent aside (MaxHealthCalculator.cs:102, GameSummonedPet.cs SetStats; ServerProperties pet_autoset_con_base, _multiplier). */
export const petMaxHp = (level: number): number => Math.round(17 * (level + 1) + 0.535 * level * level + (30 + Math.max(1, level - 1) - 25) * 3);

export const petHeal = (): Behavior<TacticsSettings> => ({
    name: 'petHeal',
    interruptible: false,
    async run(ctx) {
        const s = petSettings(ctx);
        const pet = ctx.sdk.getPet();
        if (!s.enabled || !pet || ctx.bot.isDead() || Date.now() < (ctx.memory.get('petHealRetry') ?? 0)) return false;
        const me = ctx.me();
        const quiet = QUIET_PHASES.has(ctx.orders().phase) && !ctx.threats().length;
        if (quiet && me.manaPercent < QUIET_HEAL_MANA) return false;
        if (pet.healthPercent >= (quiet ? QUIET_HEAL_BELOW : s.healBelow) || healLanding(ctx, pet)) return false;
        const sp = ctx.spells.petHeal(pet.level ? Math.round(petMaxHp(pet.level) * (100 - pet.healthPercent) / 100) : undefined);
        if (!sp || sp.spell.cooldownRemaining > 0 || pet.distance > sp.range) return false;
        const friends = sp.target === 'Realm' || sp.target === 'Group';
        if (friends && !quiet && me.maxMana > 0 && 100 * (me.mana - ctx.spells.powerOf(sp)) / me.maxMana < PET_HEAL_RESERVE) return false;
        await stopSwinging(ctx);
        ctx.doing('heal', pet.objectId, sp.spell.name);
        const c = await (friends ? ctx.bot.castSpell(sp.spell, pet.objectId) : ctx.bot.castSpell(sp.spell));
        ctx.result('petHeal', c, pet.objectId);
        if (!c.success) ctx.memory.set('petHealRetry', Date.now() + Math.max(c.retryAfterMs ?? 0, PET_SPELL_RETRY_MS));
        else ctx.memory.set('petHealLanded', { at: Date.now(), hp: ctx.sdk.getPet()?.healthPercent ?? pet.healthPercent, full: !!c.messages?.some(m => isFullyHealed(m.text, pet.name)) });
        return true;
    },
});

/**
 * While the group waits, or during another member's pull: keep the pet's buffs up. On when the window shows its icon. The window lists 8 at most (PacketLib181.cs:157-166), so a
 * buff that landed also waits out most of its time, and a failed one buffRetryMs. Those timers go with this pet: ids are reused fast, so a new one is told by the last loss.
 */
export const petBuff = (): Behavior<TacticsSettings> => ({
    name: 'petBuff',
    interruptible: false,
    async run(ctx) {
        const s = petSettings(ctx);
        const state = ctx.sdk.getPetState();
        const pet = ctx.sdk.getPet();
        const o = ctx.orders();
        if (!s.enabled || !state || !pet || ctx.bot.isDead() || ctx.threats().length || !(QUIET_PHASES.has(o.phase) || (o.phase === 'pull' && o.puller !== ctx.name))) return false;
        const whose = `${pet.objectId}:${ctx.sdk.getState()?.lastPetLoss?.at ?? 0}`;
        if (ctx.memory.get('petBuffsOf') !== whose) { ctx.memory.set('petBuffsOf', whose); ctx.memory.set('petBuffRetry', new Map()); }
        const retry: Map<string, number> = ctx.memory.get('petBuffRetry');
        const me = ctx.me();
        const low = me.maxMana > 0 && me.manaPercent < ctx.settings.buffMana;
        const now = Date.now();
        const next = ctx.spells.petBuffs().find(b => !(b.icon > 0 && state.icons.includes(b.icon))
            && now >= (retry.get(b.spell.name) ?? 0) && b.spell.cooldownRemaining <= 0 && pet.distance <= b.range
            // Timed buffs cost power; concentration buffs cost none.
            && (b.power === 0 || (!low && me.mana >= ctx.spells.powerOf(b)))
            && b.concentration <= (me.concentration ?? 0));
        if (!next) return false;
        ctx.doing('buff', pet.objectId, `${next.spell.name} on ${pet.name}`);
        const c = await ctx.bot.castSpell(next.spell);
        ctx.result('petBuff', c, pet.objectId);
        retry.set(next.spell.name, Date.now() + (c.success ? next.duration * 900 : buffRetryMs(c)));
        return true;
    },
});

/** What a member can do with pets, as withPets asks. Left as it is: a Necromancer in shade and an Animist's turret, whose own tactics these aren't. */
export interface PetKit {
    /** It summons a window pet by itself (Spellbook.summon). */
    main?: boolean;
    /** It casts a Theurgist's pets (Spellbook.fnf). */
    fnf?: boolean;
    /** A window pet is up that petControl can order: a charm from an earlier script, say. */
    window?: boolean;
    /** Its character's floor for fnfPet (Character.pet). */
    fnfFloor?: number;
}

/** Left to their own tactics: a shade's pet and a turret. */
export function petLeftAlone(sdk: Pick<BotSDK, 'getSkills' | 'getPlayer'>, bot: Pick<BotActions, 'getSpellInfo'>): boolean {
    return !!sdk.getPlayer()?.isShade || new Spellbook(sdk as BotSDK, bot as BotActions).knowsTurret();
}

/** A member's kit as it stands now, from its spell list and its window. */
export function petKit(sdk: Pick<BotSDK, 'getSkills' | 'getPlayer' | 'getPetState'>, bot: Pick<BotActions, 'getSpellInfo'>): PetKit {
    const book = new Spellbook(sdk as BotSDK, bot as BotActions);
    const p: PlayerState | null = sdk.getPlayer();
    return { main: !!book.summon(), fnf: !!book.fnf(), window: !!sdk.getPetState() && !p?.isShade && !book.knowsTurret() };
}

/** A member's kit as its character has it: none with pet false, whatever it knows or has up. */
export function memberPetKit(sdk: Pick<BotSDK, 'getSkills' | 'getPlayer' | 'getPetState'>, bot: Pick<BotActions, 'getSpellInfo'>, character: Pick<Character, 'pet'> | null | undefined): PetKit | null {
    if (character?.pet === false) return null;
    const kit = petKit(sdk, bot);
    return character?.pet?.fnfFloor === undefined ? kit : { ...kit, fnfFloor: character.pet.fnfFloor };
}

const nameIndex = <S>(list: Behavior<S>[], ...names: string[]): number => {
    for (const n of names) {
        const i = list.findIndex(b => b.name === n);
        if (i >= 0) return i;
    }
    return list.length;
};

/** Where petControl reads on the list, as it runs on the side tick: right after sprint, else before retreat, else after release. */
function aboveTheFight<S>(list: Behavior<S>[]): number {
    const sprint = list.findIndex(b => b.name === 'sprint');
    if (sprint >= 0) return sprint + 1;
    const retreat = list.findIndex(b => b.name === 'retreat');
    if (retreat >= 0) return retreat;
    return list.findIndex(b => b.name === 'release') + 1;
}

/** Above what walks every turn of the way back from a release, as well as the fight: `position`. */
function beforeTheWalk<S>(list: Behavior<S>[]): number {
    const position = list.findIndex(b => b.name === 'position');
    return position >= 0 ? position : beforeTheFight(list);
}

/** Before the first fight of the role, or where a list with none has its chores. */
function beforeTheFight<S>(list: Behavior<S>[]): number {
    const fight = list.findIndex(b => ROLE_FIGHT.has(b.name));
    return fight >= 0 ? fight : nameIndex(list, 'shedLoad', 'holdFormation', 'buff', 'rest');
}

/**
 * A member's list with what it has a use for in it, by name, in the style of withCharacter: role lists and a strategy's memberBehaviors alike,
 * which default lists alone wouldn't reach. A member with none of it gets its list back as it is; one that has one already keeps it where it is.
 */
export function withPets<S>(list: Behavior<S>[], kit: PetKit | null | undefined): Behavior<S>[] {
    if (!kit || (!kit.main && !kit.fnf && !kit.window)) return list;
    const steps: [() => Behavior<TacticsSettings>, (l: Behavior<S>[]) => number][] = [];
    if (kit.main || kit.window) steps.push([petControl, aboveTheFight]);
    if (kit.fnf) steps.push([() => fnfPet(kit.fnfFloor), beforeTheFight]);
    if (kit.main) steps.push(
        [petHeal, beforeTheFight],
        // Above what walks: holdFormation in every travel turn, position and the fight on the way back from a release. Its gate is what's hostile near us, so in a fight it falls through.
        [summonPet, beforeTheWalk],
        [petBuff, l => nameIndex(l, 'buff', 'rest')],
    );
    if (kit.main && list.some(b => b.name === 'rejoinFight')) steps.push([summonOnTheWayBack, l => nameIndex(l, 'rejoinFight')]);
    let out = list;
    for (const [make, place] of steps) {
        const b = make() as unknown as Behavior<S>;
        if (out.some(x => x.name === b.name)) continue;
        const at = place(out);
        out = [...out.slice(0, at), b, ...out.slice(at)];
    }
    return out;
}
