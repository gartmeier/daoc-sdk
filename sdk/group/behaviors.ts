// Behaviour library for group members. A role is a priority list of these;
// strategies reorder, drop, wrap or replace them, and add their own.
//
// The tactics come from live runs of a five-player Hibernian group: the tank
// body-pulls to a base, damage dealers wait until the tank has held the mob for
// ~1.5 s (holdState), whoever pulls aggro runs to the tank, and casters move only
// when outside their limits from the fight (combatRange, positioning.ts): out when
// a mob could reach them mid-cast, in when their spells don't reach.

import { findNpcSpawns } from '../../data/index';
import { styleQueue, type StyleChoice, type StyleChooser } from '../actions';
import { resurrectCost, STYLE_NEEDS_WEAPON } from '../actions-helpers';
import { ANYTIME_STYLE, fighterStyle, tankStyles } from './styles';
import { abortable, executionContext } from '../execution-context';
import { diedLately, isAlive, untouchable } from './blackboard';
import { CC_IMMUNE_MS, CC_WALK, canControl, immuneKinds, isMezzEffect } from './cc';
import { clearOf, keepDangers, type KeepSettings } from './keeps';
import { type BuffTask, nextBuff, planBuffs, surplusConcentration } from './buffs';
import { combatSpot, dangerStops, effectiveLimits, focusSettled, safeSpot, trackFocus } from './positioning';
import { dotFamily } from './spells';
import { keepForLater } from './gear-care';
import { chooseSong, SONG_SETTINGS, type SongSettings } from './songs';
import type { Behavior, MemberContext } from './member';
import { castRunning, instantSummonDue, petOffForCc, petsAllowed, type PetSettings } from './pets';
import { keepOnMap, onMap, safePath } from './terrain';
import type { BotWorldState, InventoryItem, NearbyNpc, NearbyPlayer, PlayerState, Style } from '../types';
import type { BuffSlot, Contact, MemberReport, Point, Role } from './types';

/** Settings the behaviours read; strategies extend this. */
export interface TacticsSettings {
    /** Nobody walks to reach a target: casters cast at what is in range from where they stand, else they wait (hit-and-run, pack.ts). */
    standGround?: boolean;
    /** With standGround: a caster steps up to this far to bring the focus in range, if no free enemy stands within its melee distance there. */
    standStep?: number;
    /**
     * With standGround: the support walks round the fight up to this far (in legs, each turn again) to bring its
     * crowd-control or interrupt target in reach, staying FLANK_CLEAR from every other free enemy player (flankStep);
     * 0: the straight standStep. User, live 2026-11-09: the Bard stood at the back of a long line, out of reach of
     * Midgard's supporters at the back of theirs; human Bards went round and interrupted from the side.
     */
    ccFlank?: number;
    /**
     * While an enemy player is known (Orders.spread), the casters' slots go this many times as far back and as wide
     * (spreadFormation): human groups spread as soon as they saw the other one coming (user, 2026-11-09). 0 or 1: off.
     */
    spreadOnSight?: number;
    /** Open with an area mezz when it catches at least this many free enemies and not the focus (areaMezzCatch). */
    areaMezzMin?: number;
    /** Nuke with the hardest hit rather than the highest spell level (NukeOptions.byDamage). */
    strongestNuke?: boolean;
    /** How far a member walks to a healer for lost constitution or sickness (default 4000). */
    healerRadius?: number;
    /** How a corpse waits for a rez and how far rezzers go for one (default REZ_SETTINGS). */
    rez?: Partial<RezSettings>;
    /** The tank must hold the focus this long before damage dealers open (ms). */
    holdMs: number;
    /** ... unless the focus has been fighting this long without the tank holding it: then open anyway (ms). */
    assistAfterMs: number;
    /** Heal below these health percentages. outOfCombat applies only with ≥ 50 % mana. */
    heal: { tank: number; other: number; emergency: number; outOfCombat: number };
    /** Sit until these percentages while the group waits. */
    rest: { hp: number; mana: number };
    /**
     * Distance limits from the fight per role: a member moves only when closer than the first
     * (a mob could reach it mid-cast) or, once the tank holds the focus, farther than the second
     * (spells out of reach). Inside the limits nobody moves (positioning.ts).
     */
    combatRange: Partial<Record<Role, [number, number]>>;
    /** Between fights, members within this of their slot (and safe, and near the anchor) stay where they are. */
    slotSlack: number;
    /** Aggressive mobs at or below this con to the group are welcome (PveSettings; default -3: only grey). */
    aggroTolerance?: number;
    /** Formation slot per role: distance behind the anchor and angle off the facing line (radians). */
    formation: Partial<Record<Role, { back: number; angle: number }>>;
    /** The puller walks a focus farther than this from the anchor back to it. */
    pullDistance: number;
    /** Timed buffs (they cost power) only above this mana %; concentration buffs cost none. */
    buffMana: number;
    /** Buff slots per role, most important first (default BUFF_NEEDS in buffs.ts). */
    buffNeeds?: Partial<Record<Role, BuffSlot[]>>;
    /** Slots a role takes only from its own spells (default BUFF_SELF_ONLY: casters' AF and bubble). */
    buffSelfOnly?: Partial<Record<Role, BuffSlot[]>>;
    /** When a Bard switches to power or health songs between fights (default SONG_SETTINGS in songs.ts). */
    songs?: SongSettings;
    /** Allow area damage spells (they break mezz on nearby adds). */
    aoe: boolean;
    /** Damage dealers without power melee the focus (default false: cloth casters die in melee). */
    meleeWhenOom: boolean;
    /** shedLoad drops loot at this load % (encumbrance) so the member can keep walking; 0 turns it off. */
    shedLoadAt: number;
    /** ... never dropping items whose name matches this (case-insensitive regexp source). */
    keepItems: string;
    /** Tank: taunt the focus (a taunt style every swing) while it hits someone else, and for this long after he first hits it (ms). */
    tauntOpenMs: number;
    /** Tank: taunt an add off a caster or healer once it has been loose this long (ms): a mezz ordered on it gets that long to land. */
    peelAfterMs: number;
    /** Tank: whom to keep Guard and Protect on, by name or role (empty: nobody). */
    guard: { guard: string; protect: string };
    /**
     * Tank and melee don't chase an enemy player standing farther than this from the anchor (the fight's
     * centre); unset: no limit. With the focus beyond it they fight the nearest enemy inside it
     * (leashFallback), and with none they come back: holdFormation walks them in from beyond it.
     * Live run 20261101-085134: the Hero followed fleeing players away from his group and logged
     * 192 "ran beyond 3000 units".
     */
    chaseLeash?: number;
    /** What the group does with pets: petControl and the rest of pets.ts (default PET_SETTINGS). */
    pet?: PetSettings;
}

/**
 * An enemy player tank and melee leave alone: beyond the leash from the anchor (not worth leaving the
 * group for), or standing under the guards of a keep not ours (keepDangers: casters answer it from outside).
 */
export function beyondLeash(ctx: MemberContext<TacticsSettings>, foe: Contact): boolean {
    if (foe.kind !== 'player') return false;
    const leash = ctx.settings.chaseLeash;
    const anchor = ctx.orders().anchor;
    if (leash !== undefined && !!anchor && dist(foe, anchor) > leash) return true;
    return !clearOf(foe, keepCircles(ctx));
}

/** An enemy player standing under the guards of a keep not ours, here. */
export function underGuards(ctx: MemberContext<TacticsSettings>, foe: Contact): boolean {
    return foe.kind === 'player' && foe.regionId === ctx.me().regionId && !clearOf(foe, keepCircles(ctx));
}

/** The circles round the keeps whose guards attack us, here (none outside a battleground). */
function keepCircles(ctx: MemberContext<TacticsSettings>) {
    const me = ctx.me();
    return keepDangers(me.regionId, me.realm, ctx.settings as Partial<KeepSettings>);
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** A strategy's settings with no gatherRadius of their own go by this. */
const DEFAULT_GATHER_RADIUS = 1200;
/** The phases the group waits in, between fights. */
export const QUIET_PHASES: ReadonlySet<string> = new Set(['recover', 'gather', 'idle']);
/** During a fight, holdFormation walks a member back to the anchor only from farther than this (tank and melee: the chase leash, if shorter). */
const FIGHT_REJOIN = 3000;
/** A member walking back to a fight it stands beyond the leash of goes in legs this long, so its fight behaviours get a turn on the way. */
const LEASH_REJOIN_LEG = 1000;
/** Farther than this from the fight's anchor a member walks back (rejoinFight) before anything else: its fight behaviours would go straight there, or fail. */
const FAR_FROM_FIGHT = 5000;
/** In a fight and too far from it to take part: rejoinFight's walk is due. */
export const farFromFight = (ctx: MemberContext<TacticsSettings>): boolean => {
    const o = ctx.orders();
    return o.phase === 'engage' && !!o.anchor && dist(ctx.me(), o.anchor) > FAR_FROM_FIGHT;
};
/**
 * How far from where it stood a target may run before the tank's kill ends in out_of_reach and the next turn takes it up from there
 * (KillOptions.maxChaseDistance). Against a monster that is all it does: nothing else ends that chase but the orders. Against a player
 * the leash ends it, so with a leash this much more: a player inside the leash of an anchor can have moved twice the leash, and it's the
 * leash that should let it go.
 */
const CHASE_LIMIT = 3000;
/** A melee member's walk to its target looks up this often: our pet's order waits behind it, so a snapshot and no more. */
const MELEE_WALK_CHECK_MS = 250;
/** An enemy player this close to a member can be hitting it in melee (melee range plus position lag). */
const MELEE_REACH = 400;
/** rest answered in_combat (our pet in a fight, seen by nothing above): that is a fact for a while, not something to ask again every turn. */
const REST_BUSY_MS = 2000;
/** In a member's memory: the power % a chore above rest waits for (summonPet), for this turn's rest to stop at. */
export const REST_MANA_UP_TO = 'restManaUpTo';
/** What a member low on power with no pet up says it is doing: rest's activity detail, which the coordinator reads for Orders.waiting. */
export const SAVING_POWER = 'pet: saving power';
/** A walk into spell range goes in steps this long, with a turn in between: a nuke's, so a heal above it on the list (petHeal, a member's) waits no longer than that, and crowd control's, so a dropped assignment drops the cast. */
const CAST_STEP_MS = 2500;
/** An NPC under this health takes no mezz: "Your target is enraged and resists the spell!", with the power spent (CCSpellHandler.cs:174-178). Only a mezz, and no player. */
const MEZZ_MIN_HP = 75;
/** Whether a mezz at this contact can only be refused like that. */
export const mezzRefuses = (c: Pick<Contact, 'kind' | 'hp'>): boolean => c.kind === 'npc' && c.hp < MEZZ_MIN_HP;

/**
 * Whether `t` is on member `m` the way an add is: it targets `m` and isn't crowd-controlled, and an
 * enemy player also stands in melee reach. A player's target is inferred from its latest swing or
 * hostile spell (observeState), so a caster nuking `m` from 1500 targets it too; but players have no
 * aggro table, so running to the tank or a taunt doesn't take that one off. flee() drew casters into
 * the melee with every nuke on them. An enemy pet goes the same way: a taunt doesn't move an ordered
 * pet (ControlledMobBrain.cs:549-552), and a caster pet nukes from range. A monster targeting `m` by its
 * spell alone is the same for flee(), though a taunt does take it off: see casterToPeel.
 */
export function onMember(t: Contact, m: Point & { name: string }): boolean {
    return t.target === m.name && !t.cc && ((t.kind !== 'player' && !t.isPet && !t.targetBySpell) || dist(t, m) <= MELEE_REACH);
}

/**
 * A monster casting at a member from where it stands, worth the tank's walk: not mezzed, not while the focus is
 * an enemy player (the orders ignore monsters while players are about, rvr.ts), and like an enemy player inside
 * the leash and clear of a keep's guards. Nothing else stops the walk, since it won't come to us. Not an enemy
 * pet: a taunt doesn't move an ordered one (ControlledMobBrain.cs:549-552).
 */
function casterToPeel(ctx: MemberContext<TacticsSettings>, t: Contact): boolean {
    if (t.kind !== 'npc' || t.isPet || !t.targetBySpell || t.cc || ctx.focus()?.kind === 'player') return false;
    const leash = ctx.settings.chaseLeash;
    const anchor = ctx.orders().anchor;
    if (leash !== undefined && !!anchor && dist(t, anchor) > leash) return false;
    return clearOf(t, keepCircles(ctx));
}

const alive = isAlive;

/**
 * Whether crowd control on `c` keeps our hands off it: on an add, or on a focus with something else free in the fight, while the coordinator moves the focus. Any swing breaks a mezz, a miss too (GameLiving.cs:1700-1704).
 * With nothing else free, the coordinator chose it to be broken: a root has done its job (live a sole rooted Celt stood untouched from +4.2 to +32.3 while its pet killed a member, run 20261103-174453),
 * and with every enemy mezzed the group picks them off one at a time (pack.ts pickOff, decideRvr) instead of standing by them, rebuffing, until they wake (user, live in Thidranki).
 */
export function ccHolds(ctx: MemberContext, c: Contact): boolean {
    if (!c.cc) return false;
    return !loneFocus(ctx, c);
}

/** It is the focus, and nothing else in the fight is free. */
export function loneFocus(ctx: MemberContext, c: Contact): boolean {
    return c.objectId === ctx.orders().focus && !ctx.threats().some(t => t.objectId !== c.objectId && !t.cc && !t.stale && alive(t));
}

/** A leg of a longer walk: its own timeout is how it hands the next turn the decision, so only a real failure (stuck, no way there) is one. */
function reportLeg(ctx: MemberContext, w: { success: boolean; reason?: string; message?: string }): void {
    if (!w.success && w.reason !== 'timeout') ctx.result('walk', w);
}

/** Not under a crowd-control assignment, or under one for longer than peelAfterMs (the mezz didn't land). */
function uncontrolled(ctx: MemberContext<TacticsSettings>, t: Contact, now: number): boolean {
    return !ctx.orders().cc.some(a => a.targetId === t.objectId) || now - t.hostileSince > ctx.settings.peelAfterMs;
}

/** A foe as our own client sees it now: a monster or an enemy player; null when it is out of our view. */
export function foeInView(ctx: MemberContext, id: number): NearbyNpc | NearbyPlayer | null {
    return ctx.sdk.getNearbyNpc(id) ?? ctx.sdk.getNearbyPlayer(id);
}

/**
 * Dead in our own client: a player by its dead flag, a monster at 0 % with a fresh death event.
 * Under 1 % reads 0 alive (GameLiving.cs:2621): stopping on that loses the kill's last seconds.
 */
export function isDown(ctx: MemberContext, f: NearbyNpc | NearbyPlayer): boolean {
    if (f.kind === 'player') return f.isDead;
    const state = ctx.sdk.getState();
    return f.healthPercent <= 0 && !!state && diedLately(state, f.objectId);
}

/**
 * An action refused because we are mezzed or stunned (reason 'crowd_controlled': "You can't attack when
 * you are mesmerized!", "You can't cast while stunned!"): wait its retryAfterMs (2 s without one) instead
 * of retrying every turn. True when it waited, so callers skip their own retry wait. Live runs
 * 20261101-0843xx: enemy mezzers held both tanks, who logged 63 and 84 refusals in a few minutes.
 */
async function waitOutSelfCc(r: { success: boolean; reason?: string; retryAfterMs?: number } | null | undefined): Promise<boolean> {
    if (!r || r.success || r.reason !== 'crowd_controlled') return false;
    await Bun.sleep(Math.min(r.retryAfterMs ?? 2000, 3000));
    return true;
}

export async function stopSwinging(ctx: MemberContext): Promise<void> {
    // A relog can take `me` away by now: until's stop ends here too.
    if (ctx.me()?.attacking) await ctx.sdk.sendAttack(false);
}

/** A character's choice for its next swing: a style by name, or a style and its backup; null for a plain one. For monsters and players alike. */
export type StylePick = (ctx: { target: NearbyNpc | NearbyPlayer; player: PlayerState; state: BotWorldState; styles: Style[] }) => StyleChoice;
/** killNpc's limit: below this much endurance a style isn't worth sending. */
const STYLE_MIN_ENDURANCE = 15;
/** killNpc's spacing between styles. */
const STYLE_SPACING_MS = 2500;

/** What `pick` chooses, as far as they are styles we have and can pay for. */
export function pickStyleFromSeen(pick: StylePick, seen: Parameters<StylePick>[0]): Style[] {
    if (seen.player.endurancePercent < STYLE_MIN_ENDURANCE) return [];
    return styleQueue(pick(seen), seen.styles);
}

/** Members (by name) busy with `kind` on `targetId`, started within `withinMs`. */
export function claimedBy(ctx: MemberContext, kind: string, targetId: number, withinMs: number): string[] {
    const now = Date.now();
    return ctx.members().filter(m => m.name !== ctx.name && m.activity.kind === kind && m.activity.targetId === targetId && now - m.activity.since < withinMs).map(m => m.name);
}

/** Our slot around `anchor`: `back` units away from `facing`, roles fanned out by angle, same-role members on alternating sides. */
export function formationSlot(ctx: MemberContext<TacticsSettings>, anchor: Point, facing: Point | null): Point {
    const same = ctx.members().filter(m => m.role === ctx.role).map(m => m.name);
    const away = facing && dist(anchor, facing) > 1 ? Math.atan2(anchor.y - facing.y, anchor.x - facing.x) : 0;
    const scale = ctx.orders().spread ? ctx.settings.spreadOnSight ?? 0 : 0;
    const o = formationOffset(spreadFormation(ctx.settings.formation, scale), ctx.role, Math.max(0, same.indexOf(ctx.name)), away);
    return keepOnMap(ctx.me().regionId, anchor, { x: Math.round(anchor.x + o.x), y: Math.round(anchor.y + o.y) });
}

/** A spread caster's slot turns no further than this off the line back from the facing point. */
const SPREAD_MAX_ANGLE = 1.2;

/**
 * The formation with the casters (nukers, healers) `scale` times as far back and as wide; the tank and the support keep
 * theirs. 1 or less: unchanged. A role with no angle of its own gets 0.4 to scale, as formationOffset gives its second.
 */
export function spreadFormation(formation: TacticsSettings['formation'], scale: number): TacticsSettings['formation'] {
    if (scale <= 1) return formation;
    const out = { ...formation };
    for (const role of ['nuker', 'healer'] as const) {
        const f = formation[role] ?? { back: 200, angle: 0 };
        out[role] = { back: f.back * scale, angle: Math.min(SPREAD_MAX_ANGLE, (f.angle || 0.4) * scale) };
    }
    return out;
}

/** Offset of the `index`-th member of `role` from the anchor, with `away` the angle from the facing point to the anchor. */
export function formationOffset(formation: TacticsSettings['formation'], role: Role, index: number, away: number): Point {
    const f = formation[role] ?? { back: 200, angle: 0 };
    const spread = f.angle || (index ? 0.4 : 0);
    const angle = spread * (index % 2 ? -1 : 1) * (1 + Math.floor(index / 2) * 0.6);
    return { x: Math.cos(away + angle) * f.back, y: Math.sin(away + angle) * f.back };
}

export interface RezSettings {
    /**
     * A corpse with a rezzer near waits this long before it releases (ms); 0: everyone releases at once. A rez
     * saves the release's XP loss, grave and constitution loss, and in RvR the walk back. A rezzer short of
     * power has to sit first: a rez costs half its full power at equal level.
     */
    holdMs: number;
    /** A corpse waits only for a rezzer this near, and a rezzer goes this far for one. */
    radius: number;
    /** A rezzer short of power sits for it while the group waits. Without this it passes, and a corpse doesn't wait for it. */
    sit: boolean;
    /** Without `sit`: the power a rezzer must have left after paying, in % of its pool. */
    reserve: number;
    /** Cast during a fight too, while the group is not under pressure (rezPressure). */
    inFight: boolean;
    /**
     * A corpse doesn't release while its group still fights (fightGoesOn), up to this long after its death (ms);
     * 0: it doesn't wait. In RvR a release mid-fight lands at the portal keep and walks back alone into the fight,
     * and a rezzer can't spare the cast before it ends. holdMs then counts from the fight's end, not the death.
     */
    fightHoldMs: number;
}

export const REZ_SETTINGS: RezSettings = { holdMs: 120_000, radius: 4000, sit: true, reserve: 0, inFight: false, fightHoldMs: 0 };
/** A rez being cast on us holds the release this long past holdMs: the cast, then its 15 s question (ResurrectSpellHandler.cs:47). */
const REZ_CLAIM_MS = 20_000;
/** Sitting for the power or walking into range keeps a corpse ours this long: as long as a rest may take, and a little. */
const REZ_PREP_MS = 130_000;
/** After a rez, the illness is left to run out rather than walking away from the group to a town healer (60 s, GamePlayer.OnRevive). */
const REZ_ILLNESS_MS = 70_000;
/** How long to wait for a member's answer: it says yes on its next turn. */
const REZ_ANSWER_MS = 4000;
/** A rez stands this far inside its range, so a corpse lying at the limit doesn't refuse it. */
const REZ_RANGE_MARGIN = 150;

const rezSettings = (settings: Pick<TacticsSettings, 'rez'>): RezSettings => ({ ...REZ_SETTINGS, ...settings.rez });

/**
 * Whether a rezzer with this much power (%) would pay for this corpse. The level gap can price a rez out of a
 * whole pool: at a level 12 caster, anything from level 19. Without `sit` it has to be there now, reserve and all.
 */
function willPayRez(manaPercent: number, casterLevel: number, corpseLevel: number, s: RezSettings): boolean {
    const cost = resurrectCost(100, casterLevel, corpseLevel);
    return cost <= 100 && (s.sit || manaPercent - cost >= s.reserve);
}

/** A living member near the corpse who would rez it: its list casts a rez, and it would pay. */
export function rezzerNear(members: MemberReport[], corpse: Pick<MemberReport, 'name' | 'regionId' | 'x' | 'y' | 'level'>, s: RezSettings): MemberReport | undefined {
    return members.find(m => m.name !== corpse.name && !m.isDead && m.capabilities.rez && m.regionId === corpse.regionId && dist(m, corpse) <= s.radius && willPayRez(m.mana, m.level, corpse.level, s));
}

/**
 * Why a rezzer can't spare the 4 s of a rez in this fight, or null. What the board can tell of pressure: someone
 * within heal reach is below the healing limit, more free enemies than living members, an enemy on a caster or
 * healer, or one on or next to the rezzer, whose cast it would interrupt. A fight of even numbers on the tank is
 * none of these; and the member comes back beside the rezzer, so a safe rezzer means a safe landing.
 */
export function rezPressure(me: Point & { name: string; regionId: number }, members: MemberReport[], threats: Contact[], heal: TacticsSettings['heal']): string | null {
    const here = members.filter(m => !m.isDead && m.regionId === me.regionId);
    const hurt = here.find(m => dist(me, m) < 2000 && m.hp < (m.role === 'tank' ? heal.tank : heal.other));
    if (hurt) return `${hurt.name} is hurt`;
    const free = threats.filter(t => !t.cc);
    if (free.length > here.length) return `${free.length} enemies on ${here.length}`;
    const soft = here.find(m => m.role !== 'tank' && m.role !== 'melee' && free.some(t => onMember(t, m)));
    if (soft) return `${soft.name} is under attack`;
    const onUs = free.find(t => t.target === me.name || dist(t, me) <= MELEE_REACH);
    return onUs ? `${onUs.name} is on us` : null;
}

/**
 * A corpse is waiting for a rezzer near it, or still holds its release for a fight (its report says so until its
 * next turn after the fight): a run that is ending lets that finish.
 */
export function awaitingRez(members: MemberReport[], settings: Pick<TacticsSettings, 'rez'>): boolean {
    const s = rezSettings(settings);
    if (members.some(m => m.isDead && m.activity?.kind === AWAIT_FIGHT)) return true;
    return s.holdMs > 0 && members.some(m => m.isDead && !!rezzerNear(members, m, s));
}

/** What a corpse holding its release for the fight shows as its activity. */
export const AWAIT_FIGHT = 'await_fight';
/** Phases that are a fight still going on: a pull back or a bolt in RvR is part of it. */
const FIGHT_PHASES = new Set(['engage', 'retreat', 'pull']);

/**
 * Whether the fight a corpse holds its release for goes on: the orders are a fight's, or something is a threat
 * to us. Not with nobody of ours alive in the corpse's region: a wipe ends it for us, and nobody there could rez.
 */
export function fightGoesOn(phase: string, threats: readonly Pick<Contact, 'stale' | 'regionId'>[], members: readonly Pick<MemberReport, 'isDead' | 'regionId'>[], regionId: number): boolean {
    if (!members.some(m => !m.isDead && m.regionId === regionId)) return false;
    return FIGHT_PHASES.has(phase) || threats.some(t => !t.stale && t.regionId === regionId);
}

/**
 * Dead: say yes to a rez; while the group still fights, wait for the fight to end (rez.fightHoldMs, RvR); with a
 * rezzer near, wait for one a while (REZ_SETTINGS); otherwise release and respawn at the bind point (holdFormation
 * walks back). Returning true keeps a corpse out of the rest of the list.
 */
export const release = (): Behavior => ({
    name: 'release',
    interruptible: false,
    async run(ctx) {
        if (!ctx.bot.isDead()) return false;
        // Always answered: a box left open would make the next rez fail (learnings/death-and-rest.md).
        if (ctx.sdk.getResurrectionOffer()) {
            ctx.doing('accept_rez');
            const r = await ctx.bot.acceptResurrection({ timeout: 0 });
            ctx.result('accept_rez', r);
            if (r.success) ctx.memory.set('rezzedAt', Date.now());
            return true;
        }
        const me = ctx.me();
        const s = rezSettings(ctx.settings);
        const now = Date.now();
        const diedAt = me.lastDeathAt ?? 0;
        // Nobody releases until the fight is over: a rez can come then, and nobody walks back into it alone.
        if (s.fightHoldMs > 0 && now - diedAt < s.fightHoldMs && fightGoesOn(ctx.orders().phase, ctx.threats(), ctx.members(), me.regionId)) {
            ctx.memory.set('fightHeldAt', now);
            ctx.doing(AWAIT_FIGHT, null, ctx.orders().phase);
            return true;
        }
        // A rezzer's wait counts from the fight's end: in a long one, holdMs from the death would be gone by then.
        const heldAt: number = ctx.memory.get('fightHeldAt') ?? 0;
        const waited = now - Math.max(diedAt, heldAt > diedAt ? heldAt : 0);
        const coming = claimedBy(ctx, 'rez', me.objectId, REZ_CLAIM_MS).length > 0;
        const rezzer = s.holdMs > 0 && waited < s.holdMs ? rezzerNear(ctx.members(), { name: ctx.name, regionId: me.regionId, x: me.x, y: me.y, level: me.level }, s) : undefined;
        if (coming || rezzer) {
            ctx.doing('await_rez', null, rezzer?.name ?? '');
            return true;
        }
        ctx.memory.delete('rezzedAt');
        ctx.doing('release');
        ctx.result('release', await ctx.bot.releaseAndRespawn());
        return true;
    },
});

/**
 * Phases a rez may interrupt: nothing is being fought, pulled or run from, and the group is staying. Not travel:
 * in RvR that is also falling back from a force still out of reach, with nothing on the board as a threat.
 */
const REZ_PHASES = new Set(['recover', 'gather', 'idle']);
/** Too near a corpse to walk up to it: an enemy player's reach, with a cast's worth of its walking. */
const REZ_FOE_CLEARANCE = 1500;
/** Who comes back first: another rezzer can help with the rest, then whoever the next fight needs most. */
const REZ_ORDER: Role[] = ['healer', 'tank', 'support', 'nuker', 'melee'];

/**
 * Bring back a dead member near us: sit for the power if we are short and `rez.sit` allows it (a rez costs half of
 * it at equal level), walk into range round known danger, cast. The rezzed member appears at our feet, so we need
 * not stand at the corpse, and never do. In PvE only between fights: 4 s of casting, then a member back with a
 * tenth of its health. With `rez.inFight` (RvR) also during one, from where we stand, while the group is not under
 * pressure. Gated on knowing a rez, not on the role: Bards and Wardens know one too.
 */
export const rez = (): Behavior<TacticsSettings> => ({
    name: 'rez',
    async run(ctx) {
        const spell = ctx.spells.rez();
        const s = rezSettings(ctx.settings);
        const { radius, holdMs } = s;
        const phase = ctx.orders().phase;
        const threats = ctx.threats();
        const fight = phase === 'engage' || threats.length > 0;
        if (!spell || ctx.bot.isDead() || (fight ? !s.inFight : !REZ_PHASES.has(phase))) return false;
        // A fight that is a retreat or a pull is no moment for it either.
        if (fight && phase !== 'engage' && !REZ_PHASES.has(phase)) return false;
        const me = ctx.me();
        const now = Date.now();
        // Holding off: the corpses are all busy releasing, and a release doesn't look at offers.
        if (holdMs <= 0) return false;
        const corpse = ctx.members()
            .filter(m => m.isDead && m.regionId === me.regionId && dist(me, m) <= radius && m.activity.kind !== 'release')
            .filter(m => now >= (ctx.memory.get(`rezRetry:${m.objectId}`) ?? 0))
            .filter(m => !claimedBy(ctx, 'rez', m.objectId, REZ_CLAIM_MS).length && !claimedBy(ctx, 'rez_prep', m.objectId, REZ_PREP_MS).length)
            .filter(m => willPayRez(me.manaPercent, me.level, m.level, s))
            .sort((a, b) => Number(!!b.capabilities.rez) - Number(!!a.capabilities.rez) || REZ_ORDER.indexOf(a.role) - REZ_ORDER.indexOf(b.role) || dist(me, a) - dist(me, b))[0];
        if (!corpse) return false;
        const on = ctx.bot.getAttackers()[0] ?? ctx.bot.getPlayerAttackers()[0];
        if (on) return ctx.skip(`rez: ${on.name} is on us`);
        if (fight) {
            const why = rezPressure(me, ctx.members(), threats, ctx.settings.heal) ?? (ctx.orders().cc.some(a => a.by === ctx.name) ? 'crowd control comes first' : null);
            if (why) return ctx.skip(`rez: ${why}`);
        }
        // Every branch claims the corpse before its first await, and the runner shares one board: no two rezzers on one.
        const cost = resurrectCost(me.maxMana, me.level, corpse.level);
        if (me.mana < cost) {
            if (fight || !s.sit) return ctx.skip('rez: short of power');
            ctx.doing('rez_prep', corpse.objectId, `sitting for ${corpse.name}`);
            const res = await ctx.bot.rest({ healthPercent: 1, manaPercent: Math.min(100, Math.ceil(cost / me.maxMana * 100) + 1), timeout: 120_000 });
            if (!res.success) { ctx.result('rest', res); return ctx.skip(`rez: ${res.reason}`); }
            return true;
        }
        const reach = spell.range - REZ_RANGE_MARGIN;
        const away = dist(me, corpse);
        if (away > reach || !ctx.sdk.getObject(corpse.objectId)) {
            if (fight) return ctx.skip(`rez: ${corpse.name} out of reach`);
            const f = Math.max(0, (away - reach + 50) / Math.max(1, away));
            const spot = { x: me.x + (corpse.x - me.x) * f, y: me.y + (corpse.y - me.y) * f };
            const foes = ctx.picture().contacts.filter(c => c.kind === 'player' && !c.stale && dist(c, spot) < REZ_FOE_CLEARANCE);
            if (foes.length || !safeSpot(me.regionId, me.level, ctx.settings.aggroTolerance ?? -3)(spot)) {
                ctx.memory.set(`rezRetry:${corpse.objectId}`, now + 10_000);
                return ctx.skip(`rez: no safe spot in reach of ${corpse.name}`);
            }
            ctx.doing('rez_prep', corpse.objectId, `walking to ${corpse.name}`);
            const next = safePath(me.regionId, me.level, me, spot, keepCircles(ctx))[0] ?? spot;
            const leg = Math.min(1, 2500 / Math.max(1, dist(me, next)));
            const w = await ctx.bot.walkTo(me.x + (next.x - me.x) * leg, me.y + (next.y - me.y) * leg, { tolerance: 80 });
            if (!w.success) { ctx.result('walk', w); ctx.memory.set(`rezRetry:${corpse.objectId}`, Date.now() + 5000); }
            return true;
        }
        // The corpse's own report beats its death event to our client by a moment; the server would only refuse.
        const seen = ctx.sdk.getObject(corpse.objectId);
        if (seen?.kind === 'player' && !seen.isDead) return ctx.skip(`rez: ${corpse.name} not dead in our view yet`);
        ctx.doing('rez', corpse.objectId, `${spell.spell.name} on ${corpse.name}`);
        ctx.finishTurn();
        await stopSwinging(ctx);
        const r = await ctx.bot.resurrect(corpse.objectId, { spell: spell.spell, answerMs: REZ_ANSWER_MS, approach: false });
        ctx.result('rez', r, corpse.objectId);
        if (r.success) ctx.note(`${ctx.name} resurrected ${corpse.name}`);
        // No answer: its question stays open for 15 s, and a second cast would only be refused.
        else ctx.memory.set(`rezRetry:${corpse.objectId}`, Date.now() + (r.reason === 'no_answer' ? 15_000 : 3000));
        return true;
    },
});

/**
 * After a death: visit a town healer (GameHealer) within `radius`, usually next to
 * the bind point we respawned at. Interacting cures resurrection illness; lost
 * Constitution (every PvE death from level 6, `pve_con_loss_level`) comes back
 * for money through a yes/no dialog (`Healer.cs`). Not while the group fights.
 */
export const healer = (opts: { radius?: number } = {}): Behavior<TacticsSettings> => ({
    name: 'healer',
    // A walk aborted by an orders change left the healer out of view ("Target not found"):
    // the visit is short and happens in town, so it runs to the end.
    interruptible: false,
    async run(ctx) {
        const phase = ctx.orders().phase;
        if (phase === 'engage' || phase === 'retreat' || ctx.bot.isDead()) return false;
        const me = ctx.me();
        const rezzed = Date.now() - (ctx.memory.get('rezzedAt') ?? 0) < REZ_ILLNESS_MS;
        const sick = !rezzed && (ctx.sdk.getState()?.effects ?? []).some(e => /Resurrection Illness/i.test(e.name));
        const lost = me.constitutionLost ?? 0;
        if (!sick && lost <= 0) return false;
        if (Date.now() < (ctx.memory.get('healerRetry') ?? 0)) return false;
        const spot = findNpcSpawns({ regionId: me.regionId, near: me, radius: opts.radius ?? ctx.settings.healerRadius ?? 4000, classType: /GameHealer/, limit: 1 })[0];
        if (!spot) { ctx.memory.set('healerRetry', Date.now() + 60_000); return ctx.skip('healer: none near'); }
        ctx.doing('move', null, `to ${spot.name} (healer)`);
        if (Math.hypot(spot.x - me.x, spot.y - me.y) > 600) await ctx.bot.walkTo(spot.x, spot.y, { z: spot.z, tolerance: 200 });
        if (!ctx.sdk.findNearbyNpc(spot.name)) {
            // Not there (stuck, attacked on the way): try again soon.
            ctx.memory.set('healerRetry', Date.now() + 20_000);
            return ctx.skip(`healer: ${spot.name} not in view`);
        }
        const since = ctx.sdk.getGameMessages().at(-1)?.id ?? 0;
        const hi = await ctx.bot.interactWith(spot.name);
        let outcome = hi.success ? 'cured' : hi.message;
        if (hi.success && lost > 0) {
            // "It will cost N to have your lost constitution restored. Do you accept?"
            const asked = await ctx.sdk.waitForCondition(s => !!s.dialog, 4000).then(() => true).catch(() => false);
            if (asked) {
                await ctx.bot.respondToDialog(true);
                await ctx.sdk.waitForCondition(() => ctx.sdk.getGameMessages().some(g => g.id > since && /restores \d+ points? of your lost constitution|You don't have that much/i.test(g.text)), 4000).catch(() => null);
            }
            outcome = ctx.sdk.getGameMessages().filter(g => g.id > since && /constitution|resurrection/i.test(g.text)).map(g => g.text).join(' | ') || 'no answer';
        }
        const left = ctx.me().constitutionLost ?? 0;
        const ok = hi.success && left < lost || (lost === 0 && hi.success);
        // Out of money: try again much later, not every turn; anything else in a minute.
        const broke = /don't have that much/i.test(outcome);
        ctx.memory.set('healerRetry', Date.now() + (ok && left === 0 ? 5_000 : broke ? 600_000 : 60_000));
        ctx.result('healer', { success: ok, message: `${outcome} (con lost ${lost} → ${left})`, reason: ok ? undefined : 'refused' } as any);
        return true;
    },
});

/** Sprint's effect icon (SprintECSGameEffect); its name is a translation key's text. */
const SPRINT_ICON = 0x199;

/**
 * Sprint while the orders say retreat, else not. Sprint is x1.3 run speed
 * (MaxSpeedCalculator), and monsters run as fast as a player who doesn't sprint:
 * without it every retreat ended with members caught "en route". Outside a
 * retreat it is turned off, to keep endurance for styles. The server stops it at
 * low endurance or after ~30 idle ticks. Toggling doesn't end the turn, so
 * `retreat` (next in the list) starts running at once.
 */
export const sprint = (): Behavior<TacticsSettings> => ({
    name: 'sprint',
    interruptible: false,
    async run(ctx) {
        if (ctx.bot.isDead()) return false;
        const on = (ctx.sdk.getState()?.effects ?? []).some(e => e.icon === SPRINT_ICON || /^sprint$/i.test(e.name));
        const want = ctx.orders().phase === 'retreat';
        if (on === want || (want && ctx.me().endurance <= 10)) return false;
        // The effect shows a moment after the toggle: don't toggle it straight back.
        if (Date.now() - (ctx.memory.get('sprintAt') ?? 0) < 3000) return false;
        ctx.memory.set('sprintAt', Date.now());
        ctx.result('sprint', await ctx.bot.useAbility('Sprint'));
        return false;
    },
});

/** Orders say retreat: run to our slot at the retreat point. */
export const retreat = (): Behavior<TacticsSettings> => ({
    name: 'retreat',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'retreat' || !o.retreatTo) return false;
        const me = ctx.me();
        const slot = formationSlot(ctx, o.retreatTo, { x: 2 * o.retreatTo.x - me.x, y: 2 * o.retreatTo.y - me.y });
        if (dist(me, slot) < 150) return ctx.skip('at the retreat point');
        await stopSwinging(ctx);
        ctx.doing('flee', null, 'retreat');
        // Round aggressive mobs and enemy keeps on the way (just the point itself when the straight line is clear):
        // a straight run toward home crossed a bwca camp in Thidranki (round 7).
        const route = safePath(me.regionId, me.level, me, slot, keepCircles(ctx));
        const w = await ctx.bot.followPath(route, { tolerance: 100, timeout: 20_000 });
        if (!w.success) ctx.result('retreat', w);
        return true;
    },
});

/** The tank there is to run to: alive, in our region and inside the fight's reach. Released to his bind he is 9000 off and in no fight (run 20261104-052629), and the 6 s of that walk are lost to the fight here. */
function tankToRunTo(ctx: MemberContext<TacticsSettings>): MemberReport | undefined {
    const tank = ctx.tank();
    const me = ctx.me();
    return tank && tank.regionId === me.regionId && dist(me, tank) <= FAR_FROM_FIGHT ? tank : undefined;
}

/**
 * Not the tank and a monster is on us, or an enemy player in melee reach (onMember): run to the tank
 * so it can take it back (peelTarget). A player nuking us from range is left to crowd control and the focus.
 * A rooted one with us in its reach too: it swings on, and can't follow. The tank leaves it be, so this is all it takes.
 */
export const flee = (): Behavior => ({
    name: 'flee',
    async run(ctx) {
        if (ctx.isTank()) return false;
        const tank = tankToRunTo(ctx);
        const me = ctx.me();
        const rootedOnUs = (t: Contact) => t.cc?.kind === 'root' && t.target === me.name && dist(t, me) <= MELEE_REACH;
        if (!tank || !ctx.threats().some(t => onMember(t, me) || rootedOnUs(t))) return false;
        if (dist(me, tank) < 150) return ctx.skip('attacked, already at the tank');
        await stopSwinging(ctx);
        ctx.doing('flee', null, `to ${tank.name}`);
        reportLeg(ctx, await ctx.bot.walkTo(tank.x, tank.y, { z: tank.z, tolerance: 60, timeout: 6000 }));
        return true;
    },
});

/**
 * Heal the most hurt member below its threshold. Skips a target another healer
 * is already casting on, unless it is below the emergency threshold.
 */
export const heal = (opts: { emergencyOnly?: boolean; limits?: Partial<TacticsSettings['heal']> } = {}): Behavior<TacticsSettings> => ({
    name: opts.emergencyOnly ? 'emergencyHeal' : 'heal',
    interruptible: false,
    async run(ctx) {
        const s = { ...ctx.settings.heal, ...opts.limits };
        const me = ctx.me();
        const o = ctx.orders();
        const fighting = ctx.threats().length > 0 || o.phase === 'engage' || o.phase === 'pull' || o.phase === 'retreat';
        const limit = (role: Role) => opts.emergencyOnly ? s.emergency
            : fighting ? (role === 'tank' ? s.tank : s.other)
            : me.manaPercent >= 50 ? s.outOfCombat : 0;
        const hurt = ctx.members()
            .filter(m => !m.isDead && m.regionId === me.regionId && dist(me, m) < 2000 && m.hp < limit(m.role))
            .filter(m => m.hp < s.emergency || !claimedBy(ctx, 'heal', m.objectId, 3500).length)
            .sort((a, b) => a.hp - b.hp)[0];
        if (!hurt) return false;
        const sp = ctx.spells.heal(hurt.maxHp ? hurt.maxHp * (100 - hurt.hp) / 100 : undefined);
        // None at all is no shortage of power (spells.heal reads null for both).
        if (!sp) return ctx.spells.capabilities().heal ? ctx.skip('heal: not enough power') : false;
        await stopSwinging(ctx);
        ctx.doing('heal', hurt.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, hurt.objectId);
        ctx.result('heal', c, hurt.objectId);
        if (!(await waitOutSelfCc(c)) && !c.success && c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
        return true;
    },
});

/** A member casting crowd control at a target holds it this long (a cast is 2.5-3 s). */
const CC_CLAIM_MS = 4000;
/** A crowd-control spell without a length still counts this long. */
const CC_MIN_MS = 3000;
/** The phases crowd control goes on in. */
const CC_PHASES: ReadonlySet<string> = new Set(['engage', 'pull', 'retreat']);
/** How often a mezzer behind a cast the server runs on looks up: the coordinator's tick moves the orders. */
const CC_HELD_LOOK_MS = 250;
/** A crowd-control walk with this little to show for it (route's stuckMs: a step of CAST_STEP_MS never gets there) gets stuck reported. */
const CC_WALK_STUCK_MS = 8000;
/** ... from where it stood: less than this is standing. */
const CC_WALK_MOVED = 50;

/** Why that walk is getting nowhere, once per CC_WALK_STUCK_MS, read at the start of each step; null while it isn't. As route says it, for 'cc: stuck' in the reports (observer's movement finding). */
function ccWalkStuck(ctx: MemberContext, targetId: number): string | null {
    const me = ctx.me();
    if (!me) return null;
    const now = Date.now();
    const was: { targetId: number; x: number; y: number; since: number; last: number } | undefined = ctx.memory.get('ccWalk');
    if (!was || was.targetId !== targetId || now - was.last > CAST_STEP_MS * 2 || dist(me, was) >= CC_WALK_MOVED) {
        ctx.memory.set('ccWalk', { targetId, x: me.x, y: me.y, since: now, last: now });
        return null;
    }
    was.last = now;
    if (now - was.since < CC_WALK_STUCK_MS) return null;
    was.since = now;
    return `No progress for ${CC_WALK_STUCK_MS}ms at (${me.x}, ${me.y})${me.maxSpeed === 0 ? ' (max speed 0: rooted, stunned or overloaded)' : ''}`;
}

/** Who a mezz cure frees first: the healer, then the tank, then the most hurt, within its range. Never ourselves: a mezzed member can't cast. */
export function mezzedMember(me: Point & { name: string; regionId: number }, members: readonly MemberReport[], range: number, mezzed: (effect: string) => boolean = isMezzEffect): MemberReport | null {
    const rank = (m: MemberReport) => (m.role === 'healer' ? 0 : m.role === 'tank' ? 1 : 2);
    return members
        .filter(m => m.name !== me.name && !m.isDead && m.regionId === me.regionId && dist(me, m) <= range && m.effects.some(mezzed))
        .sort((a, b) => rank(a) - rank(b) || a.hp - b.hp)[0] ?? null;
}

/** A member held by a mezz is a member lost for its whole length: a cure (Clear Mind) frees it, in a fight. A cast is 3 s, and one a target at a time. */
const CURE_SPACING_MS = 4000;
export const cureMezz = (): Behavior<TacticsSettings> => ({
    name: 'cureMezz',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' && o.phase !== 'retreat') return false;
        const sp = ctx.spells.all().find(s => s.type === 'CureMezz' && s.radius === 0);
        if (!sp || sp.spell.cooldownRemaining > 0 || ctx.me().manaPercent < 10) return false;
        const m = mezzedMember(ctx.me(), ctx.members(), sp.range);
        if (!m) return false;
        const key = `cured:${m.objectId}`;
        if (Date.now() - (ctx.memory.get(key) ?? 0) < CURE_SPACING_MS) return false;
        ctx.memory.set(key, Date.now());
        await stopSwinging(ctx);
        ctx.doing('cure', m.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, m.objectId, { approach: false });
        ctx.result('cure', c, m.objectId);
        await waitOutSelfCc(c);
        return true;
    },
});

/** Whether a mezz at it can only be refused, by our own snapshot too: a falling mob can be under 75 % there with the board's reading from before (m4: 80, then the mezz begun, 67 and "enraged"), or the other way round. */
function refusesMezzNow(ctx: MemberContext, c: Contact): boolean {
    return mezzRefuses(c) || mezzRefuses({ kind: c.kind, hp: foeInView(ctx, c.objectId)?.healthPercent ?? c.hp });
}

/** What it can take, of what is ready. A mezz at an NPC under 75 % only costs the power (a6: six casts at 68-63 %), and a root takes it all the same. An assignment can be older than the health: the coordinator's next tick drops one we can't carry out (assignCc). */
export function ccSpellFor(ctx: MemberContext<TacticsSettings>, c: Contact) {
    const except = immuneKinds(c);
    const sp = ctx.spells.cc({ aoe: ctx.settings.aoe, except });
    return sp?.kind === 'mezz' && refusesMezzNow(ctx, c) ? (except.includes('root') ? null : ctx.spells.root()) : sp;
}

/**
 * Mezz (or, without a mezz or at an NPC a mezz can't take, root) our crowd-control assignment; without `assignedOnly`,
 * also any add (not the focus) attacking the group that nobody controls or is mezzing yet. With a pet to order, out of range it walks in steps announced
 * as a walk, back to the list after each, and casts from where it got to: 'cc' stands for the cast alone. In one turn with the walk that held our pet's order
 * for its length, 15-25 s in a roam (selectFree), and cast at a target whose assignment had lapsed on the way, onto the new focus or a passive mob.
 * With none, nothing waits behind that turn, and castSpell walks and casts in one as ever. Either way a cast the server runs on (castHeldLeftMs) is waited out before anything here is read for the cast.
 */
export const crowdControl = (opts: { assignedOnly?: boolean } = {}): Behavior<TacticsSettings> => ({
    name: 'crowdControl',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (!CC_PHASES.has(o.phase)) return false;
        // The board knows what's on each target and what it is immune to, whoever found out.
        const kinds = ctx.spells.capabilities().ccKinds;
        // Targets castSpell knows without a send it can't land on, by ckey: left alone for CC_IMMUNE_MS. In our own memory: another mezzer may yet be told otherwise by the server, and the board's mark is for a real immunity.
        const cantLand: Map<string, number> = ctx.memory.get('ccCantLand') ?? new Map();
        ctx.memory.set('ccCantLand', cantLand);
        for (const [k, until] of cantLand) if (until <= Date.now()) cantLand.delete(k);
        const open = (c: Contact) => !c.cc && !cantLand.has(ckey(c)) && canControl(c, kinds) && !claimedBy(ctx, 'cc', c.objectId, CC_CLAIM_MS).length;
        const live = (id: number) => { const c = ctx.contact(id); return c && !c.stale && alive(c) && open(c) ? c : undefined; };
        const assigned = o.cc.filter(a => a.by === ctx.name).map(a => live(a.targetId)).filter(c => !!c);
        // Not an enemy pet: a mezz is worth more on its owner, and a Theurgist's are immune (MezzImmunity in npctemplate.sql).
        const extra = opts.assignedOnly ? [] : ctx.threats()
            .filter(t => t.objectId !== o.focus && !t.isPet && open(t) && !o.cc.some(a => a.targetId === t.objectId));
        const area = ctx.settings.areaMezzMin ? ctx.spells.areaMezz() : null;
        const ready = assigned.length || extra.length ? ctx.spells.cc({ aoe: ctx.settings.aoe }) : null;
        const refusesMezz = (c: Contact) => refusesMezzNow(ctx, c);
        const spellFor = (c: Contact) => ccSpellFor(ctx, c);
        const takes = (c: Contact) => !ready || !!area || !!spellFor(c);
        const mine = assigned.filter(takes), others = extra.filter(takes);
        // Others see some, we don't (an assignment while we walk back from a release): the first we can cast on.
        const visible = (c: Contact) => !!foeInView(ctx, c.objectId);
        const stand = !!ctx.settings.standGround;
        const catches = (c: Contact) => area && !refusesMezz(c) && !immuneKinds(c).includes('mezz') ? areaMezzCatch(c, ctx.picture().contacts, area.radius, o.focus) : [];
        const usesArea = (c: Contact) => !!area && catches(c).length >= ctx.settings.areaMezzMin!;
        const spellOn = (c: Contact) => usesArea(c) ? { ...area!, kind: 'mezz' as const } : spellFor(c);
        const distanceTo = (c: Contact) => foeInView(ctx, c.objectId)?.distance ?? Infinity;
        const seen = [...mine, ...others].filter(visible);
        // Holding its ground, a member mezzes what it can reach: the farthest enemy, assigned first, can be out of it for a whole raid.
        const inReach = (c: Contact) => { const sp = spellOn(c); return !!sp && distanceTo(c) <= sp.range; };
        const target = (stand ? seen.find(inReach) : undefined) ?? seen[0];
        if (!target) return mine.length || others.length ? ctx.skip('cc: target not in view') : false;
        const caught = catches(target);
        const useArea = usesArea(target);
        const sp = spellOn(target);
        if (!sp) return ctx.skip('cc: no mezz or root ready');
        if (stand && distanceTo(target) > sp.range) {
            // The Bard leads the pack to mezz: a short step like a caster's, the others hold.
            const view = foeInView(ctx, target.objectId);
            const flank = ctx.settings.ccFlank ?? 0;
            const step = ctx.role !== 'support' || !view ? null
                : flank ? flankStep(ctx.me(), view, sp.range, flank, ctx.picture().contacts, target.objectId)
                : standStepTo(ctx.me(), view, sp.range, ctx.settings.standStep ?? 0, ctx.picture().contacts);
            if (!step) return ctx.skip('cc: out of reach, holding ground');
            ctx.doing('move', target.objectId, flank ? 'round the fight into range' : 'step in range');
            await ctx.bot.walkTo(step.x, step.y, { tolerance: 40, timeout: 3000 });
            return true;
        }
        // A root that lands on a mezzed enemy wakes it (GameLiving.cs:1716-1727): not while a mezz is on its way there.
        if (stand && sp.kind === 'root' && mezzComing(ctx, target)) return ctx.skip('cc: a mezz is on its way there');
        await stopSwinging(ctx);
        const inSteps = petsAllowed(ctx.settings) && !!ctx.sdk.getState()?.pet;
        // A step, back to the list: the next turn reads the orders again. A select of our pet's order disturbs a walk in nothing.
        if (inSteps && distanceTo(target) > sp.range) {
            const view = foeInView(ctx, target.objectId);
            if (view && !stand) {
                const stuck = ccWalkStuck(ctx, target.objectId);
                if (stuck) ctx.result('cc', { success: false, reason: 'stuck', message: `Cannot reach ${target.name}: ${stuck}` }, target.objectId);
                ctx.doing('move', target.objectId, `${CC_WALK}${sp.spell.name}`);
                reportLeg(ctx, await ctx.bot.walkToObject(view, { range: Math.max(100, sp.range * 0.85), timeout: CAST_STEP_MS }));
            }
            return true;
        }
        // The server's last cast runs on: castSpell would wait for it with all of this read already, and the assignment can go in that time, with the mezz then at the new focus. Back to the list, and read again: unannounced, as our pet's order goes meanwhile.
        const held = ctx.bot.castHeldLeftMs(sp.spell);
        if (held > 0) {
            await Bun.sleep(Math.min(held, CC_HELD_LOOK_MS));
            return true;
        }
        ctx.doing('cc', target.objectId, sp.spell.name);
        await petOffForCc(ctx, target, sp.kind);
        // An area mezz goes on its neighbours too, and our pet's next swing would wake the one it is on.
        if (useArea) for (const n of caught) if (n.objectId !== target.objectId) await petOffForCc(ctx, n, 'mezz');
        // Those sends took a moment, and a cast is never cut: it goes only at what is still ours to control, and in reach.
        const now = ctx.orders();
        const still = !CC_PHASES.has(now.phase) ? false : mine.includes(target) ? now.cc.some(a => a.by === ctx.name && a.targetId === target.objectId) : target.objectId !== now.focus && !now.cc.some(a => a.targetId === target.objectId);
        if (!still || (inSteps && distanceTo(target) > sp.range)) return true;
        const c = await ctx.bot.castSpell(sp.spell, target.objectId, inSteps || stand ? { approach: false } : {});
        const fullMs = Math.max(CC_MIN_MS, sp.duration * 1000);
        // A cast that went off isn't one that landed, and the reports count it as what the server answered.
        const refused = !c.success ? null : c.effectImmune ? 'immune' : c.alreadyOn ? 'already_on' : c.resisted ? 'resisted' : c.effectLanded === false && target.kind === 'player' ? 'no_effect' : null;
        ctx.result('cc', refused ? { ...c, success: false, reason: refused } : c, target.objectId);
        // Answers that say how long it is out of reach, for every member: the coordinator would otherwise hand it to
        // the next one every few seconds. Only this kind: the others have their own immunity (cc.ts). An NPC that fell
        // under 75 % during the cast answers the same way (CastResult.effectImmune).
        if (refused === 'immune') ctx.markCcImmune(target.objectId, sp.kind, CC_IMMUNE_MS);
        // The same spell still on it: at most its whole length, then the immunity.
        else if (refused === 'already_on') ctx.markCcImmune(target.objectId, sp.kind, fullMs + CC_IMMUNE_MS);
        else if (refused === 'resisted') return true;
        else if (refused === 'no_effect') await Bun.sleep(1500);
        // A monster's repeat replaces the old effect without a word (CastResult.effectLanded), so it landed too.
        else if (c.success) {
            ctx.markCc(target.objectId, sp.kind, fullMs, c.landedOn);
            if (useArea) for (const n of caught) if (n.objectId !== target.objectId) ctx.markCc(n.objectId, sp.kind, fullMs);
        }
        // castSpell knows without a send that this can't land (a peace flag, our realm, ourselves): the next add gets the turn.
        else if (c.reason === 'invalid_target' || c.reason === 'not_attackable' || c.reason === 'no_target') cantLand.set(ckey(target), Date.now() + CC_IMMUNE_MS);
        else if (await waitOutSelfCc(c)) return true;
        // Our client said in range and the server didn't: not again on the next tick. A live round tried 17 times in 5 s.
        else if (stand && c.reason === 'out_of_range') await Bun.sleep(1000);
        // PvP immunity (reason 'immune': up to 10 s after a port, login or release) and "You must wait": try again shortly.
        else if (c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
        // The spell list's power cost can trail the server's ("You don't have enough power"): don't retry every turn.
        else if (c.reason === 'no_power') await Bun.sleep(2000);
        return true;
    },
});

/** Where a caster steps to bring `focus` in range, or null when it is too far off or the step ends next to a free enemy. */
export function standStepTo(me: Point, focus: Point & { distance: number }, range: number, step: number, contacts: readonly Contact[]): Point | null {
    const need = focus.distance - range + 100;
    if (step <= 0 || need > step) return null;
    const d = dist(me, focus);
    if (d < 1) return null;
    const to = { x: me.x + (focus.x - me.x) * need / d, y: me.y + (focus.y - me.y) * need / d };
    return contacts.some(c => c.kind === 'player' && !c.stale && alive(c) && !c.cc && dist(c, to) <= STEP_CLEAR) ? null : to;
}
/** A step in stays this far from any free enemy player. */
const STEP_CLEAR = 500;

/** A flank (flankStep) keeps this far from every free enemy player but its target ... */
export const FLANK_CLEAR = 700;
/** ... walks this far a turn, then looks again ... */
const FLANK_LEG = 600;
/** ... and stands this share of its spell's range from the target. */
const FLANK_REACH = 0.85;

const toSegment = (p: Point, a: Point, b: Point) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/**
 * The next leg of a walk round the fight to a spot `range` × FLANK_REACH from `target`: of the spots on that circle
 * FLANK_CLEAR from every other free enemy player, the nearest (one the straight way to which passes such a player counts
 * double), within `budget`. The leg turns up to 90° off the straight way, the least that keeps it clear, so turn by turn
 * the walk curves round the middle. Null when no spot or leg is clear, or the spot is beyond `budget`.
 */
export function flankStep(me: Point, target: Point, range: number, budget: number, contacts: readonly Contact[], targetId: number): Point | null {
    const others = contacts.filter(c => c.kind === 'player' && !c.stale && alive(c) && !c.cc && c.objectId !== targetId);
    const clear = (p: Point) => others.every(c => dist(c, p) >= FLANK_CLEAR);
    const passes = (a: Point, b: Point, k = 1) => others.some(c => toSegment(c, a, b) < FLANK_CLEAR * k);
    const r = range * FLANK_REACH;
    let best: { p: Point; cost: number } | null = null;
    for (let i = 0; i < 24; i++) {
        const a = i * Math.PI / 12;
        const p = { x: target.x + Math.cos(a) * r, y: target.y + Math.sin(a) * r };
        if (!clear(p)) continue;
        const cost = dist(me, p) * (passes(me, p) ? 2 : 1);
        if (cost <= budget && (!best || cost < best.cost)) best = { p, cost };
    }
    if (!best) return null;
    const d = dist(me, best.p);
    if (d < 1) return null;
    const leg = Math.min(FLANK_LEG, d);
    const base = Math.atan2(best.p.y - me.y, best.p.x - me.x);
    for (const off of [0, 0.5, -0.5, 1, -1, Math.PI / 2, -Math.PI / 2]) {
        const to = { x: Math.round(me.x + Math.cos(base + off) * leg), y: Math.round(me.y + Math.sin(base + off) * leg) };
        if (clear(to) && !passes(me, to, 0.8)) return to;
    }
    return null;
}

/**
 * The free enemy players an area mezz on `target` would catch, `target` first, or none at all when the
 * focus stands in its radius: mezzing what we are about to hit wastes the spell. A shade is no catch: the server's area selection leaves it out (SpellHandler.cs:1477, :1599).
 * None either with a monster that isn't fighting us near it (NEUTRAL_SPLASH): the mezz takes it in too, and it comes for us when it wakes.
 * Round 1 of the pair rounds (2026-11-08): Captivate Audience round a Dwarf by a camp of black wolves (aggro level 0) at +0:36, and at
 * +0:57, as it wore off, the wolves were on the Bard and the healers; they cut ~15 heals and killed three.
 */
export function areaMezzCatch(target: Contact, contacts: readonly Contact[], radius: number, focus: number | null, now = Date.now()): Contact[] {
    const near = contacts.filter(c => c.kind === 'player' && !c.stale && alive(c) && !untouchable(c, now) && dist(c, target) <= radius);
    if (near.some(c => c.objectId === focus)) return [];
    if (contacts.some(c => c.kind !== 'player' && !c.isPet && !c.threat && !c.stale && alive(c) && dist(c, target) <= radius + NEUTRAL_SPLASH)) return [];
    return near.filter(c => !c.cc && !immuneKinds(c).includes('mezz'));
}

/** areaMezzCatch keeps this much farther from a monster than the spell's radius: the target walks while the mezz is cast. */
const NEUTRAL_SPLASH = 150;

/** How near another member's mezz may be for a root to wait: the largest radius an area mezz has at these levels. */
const MEZZ_SPLASH = 350;

/** Another member is casting crowd control at `target` or next to it, or has been told to. */
function mezzComing(ctx: MemberContext<TacticsSettings>, target: Contact): boolean {
    const near = (id: number | null | undefined) => { const c = id ? ctx.contact(id) : undefined; return !!c && dist(c, target) <= MEZZ_SPLASH; };
    return ctx.orders().cc.some(a => a.by !== ctx.name && near(a.targetId))
        || ctx.members().some(m => m.name !== ctx.name && !m.isDead && m.activity.kind === 'cc' && near(m.activity.targetId));
}

/** An enemy player started a cast this long ago at most, so an interrupt can still catch it. */
const INTERRUPT_WINDOW_MS = 2000;

/**
 * Stop an enemy's cast with an instant spell, healers before others: Lullaby from far, a shout from close. Never at
 * one that is mezzed (it would wake it), nor at a shade, which the server refuses at the cast's start and which would take the turn from the mezz below. Instant, so it costs the Bard no crowd control time.
 */
export const interrupt = (): Behavior<TacticsSettings> => ({
    name: 'interrupt',
    interruptible: false,
    async run(ctx) {
        if (ctx.orders().phase !== 'engage') return false;
        const spells = ctx.spells.interrupts();
        if (!spells.length) return false;
        const now = Date.now();
        const casting = ctx.picture().contacts
            .filter(c => c.kind === 'player' && !c.stale && alive(c) && !c.cc && !untouchable(c, now) && now - (c.castingAt ?? 0) <= INTERRUPT_WINDOW_MS)
            .sort((a, b) => Number(!!b.healer) - Number(!!a.healer));
        for (const foe of casting) {
            const d = foeInView(ctx, foe.objectId)?.distance ?? Infinity;
            const sp = spells.find(s => d <= s.range);
            if (!sp) continue;
            ctx.doing('interrupt', foe.objectId, sp.spell.name);
            ctx.result('interrupt', await ctx.bot.castSpell(sp.spell, foe.objectId, { approach: false }), foe.objectId);
            return true;
        }
        // None in reach: a support with ccFlank walks round the fight toward the first that is (spells: longest range first).
        if (ctx.role !== 'support') return false;
        const flank = ctx.settings.ccFlank ?? 0;
        if (!flank) return false;
        for (const foe of casting) {
            const view = foeInView(ctx, foe.objectId);
            const step = view && flankStep(ctx.me(), view, spells[0]!.range, flank, ctx.picture().contacts, foe.objectId);
            if (!step) continue;
            ctx.doing('move', foe.objectId, `round the fight to interrupt`);
            await ctx.bot.walkTo(step.x, step.y, { tolerance: 40, timeout: 3000 });
            return true;
        }
        return false;
    },
});

/**
 * Nothing to mezz: keep a known healer or caster from casting with a confusion. It has a long cast and wakes a mezzed
 * target, so it goes on free ones only, and one at a time (it lasts a minute on a monster, but a player only loses the cast). Not on a shade, however long it has been known a caster: a refused cast is a turn the song below doesn't get.
 */
export const confuse = (): Behavior<TacticsSettings> => ({
    name: 'confuse',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage') return false;
        const sp = ctx.spells.confuse();
        if (!sp) return false;
        const now = Date.now();
        const target = ctx.picture().contacts
            .filter(c => c.kind === 'player' && !c.stale && alive(c) && !c.cc && !untouchable(c, now) && (c.healer || c.caster) && c.objectId !== o.focus && (foeInView(ctx, c.objectId)?.distance ?? Infinity) <= sp.range && !o.cc.some(a => a.targetId === c.objectId))
            .sort((a, b) => Number(!!b.healer) - Number(!!a.healer))[0];
        if (!target) return false;
        ctx.doing('confuse', target.objectId, sp.spell.name);
        ctx.result('confuse', await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false }), target.objectId);
        return true;
    },
});

/**
 * Whether a member with crowd control as its main job should heal now: nobody else can (no healer alive, or the healer
 * is under attack), the group is taking a lot of damage (two members low), or the one who is hurt is out of the healer's reach.
 */
export function backupHealWanted(me: Pick<MemberReport, 'regionId' | 'x' | 'y'>, members: readonly MemberReport[], threats: readonly Contact[], emergency: number): boolean {
    const living = members.filter(m => !m.isDead && m.regionId === me.regionId);
    const healer = living.find(m => m.role === 'healer');
    const hurt = living.filter(m => m.hp < emergency + 20);
    if (!hurt.length) return false;
    if (!healer || threats.some(t => t.target === healer.name) || hurt.length >= 2) return true;
    return hurt.some(m => dist(m, healer) >= 2000 && dist(m, me) < 2000);
}

/** heal() only when backupHealWanted says so. */
export const backupHeal = (): Behavior<TacticsSettings> => {
    const h = heal();
    return {
        ...h, name: 'backupHeal',
        run: ctx => (backupHealWanted(ctx.me(), ctx.members(), ctx.threats(), ctx.settings.heal.emergency) ? h.run(ctx) : Promise.resolve(false)),
    };
};

/**
 * A melee or tank member's weapon. As the run starts its best melee slot goes in hand, once (bot.takeMeleeSlot): the state can't say which is active, a login leaves whichever was last, and a Hunter with Sword 1 and Spear 10 fought with the sword.
 * For a tank that goes by the style it will open with. Two weapons that style and spec don't tell apart stay as the owner left them (keepOnTie): one of them can be a two-hander it equipped on purpose, which comes out by itself, and no style line would bring it back. Later, on "This style requires a X weapon!", which a style picked by what is worn can earn (styles.ts canWield), the slot holding X, once for each X: killNpc does the same in its fight, and assist's melee has only this. It takes no turn.
 */
export const hand = (): Behavior<TacticsSettings> => ({
    name: 'hand',
    async run(ctx) {
        const me = ctx.me();
        if (!me || me.isDead) return false;
        const messages = ctx.sdk.getGameMessages();
        const seen: number | undefined = ctx.memory.get('handSeen');
        ctx.memory.set('handSeen', messages.at(-1)?.id ?? seen ?? 0);
        if (seen === undefined) {
            const { taunt, damage } = ctx.isTank() ? tankStyles(ctx.sdk.getSkills().styles ?? [], ctx.sdk.getState()?.equipment ?? []) : { taunt: null, damage: null };
            const opener = damage ?? taunt;
            const r = await ctx.bot.takeMeleeSlot({ ...(opener ? { styles: [opener] } : {}), keepOnTie: true });
            ctx.note(`hand: ${r.message}`);
            return false;
        }
        const took: Set<string> = ctx.memory.get('handTook') ?? new Set();
        ctx.memory.set('handTook', took);
        for (const m of messages) {
            const weapon = m.id > seen ? STYLE_NEEDS_WEAPON.exec(m.text)?.[1] : undefined;
            if (!weapon || took.has(weapon)) continue;
            took.add(weapon);
            const r = await ctx.bot.takeMeleeSlot({ weapon });
            ctx.note(`hand: ${r.message}`);
        }
        return false;
    },
});

/**
 * Puller: hit the focus until it turns on us, then walk it back to the anchor
 * (body pull). A focus already near the anchor is just attacked.
 */
export const pull = (): Behavior<TacticsSettings> => ({
    name: 'pull',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'pull' || o.puller !== ctx.name || o.focus === null) return false;
        const mob = ctx.focus();
        if (!mob) return ctx.skip('pull: focus unknown');
        const me = ctx.me();
        const far = !!o.anchor && dist(mob, o.anchor) > ctx.settings.pullDistance;
        // A caster with us as the target of its spell alone stands and casts, and may not follow: go on and hit it.
        if (mob.target === ctx.name && !mob.targetBySpell) {
            if (!o.anchor || dist(me, o.anchor) < 120) return ctx.skip('pull: waiting for it at the anchor');
            await stopSwinging(ctx);
            ctx.doing('pull', mob.objectId, 'back to the anchor');
            // Back to the list for an instant summon come off its recast on the way (summonInOurPull), as for the walk in below: that's up to 20 s of a mob on him with none.
            const w = await until(() => instantSummonDue(ctx), () => ctx.bot.walkTo(o.anchor!.x, o.anchor!.y, { tolerance: 80, timeout: 20_000 }));
            if (w && !w.success) ctx.result('walk', w);
            return true;
        }
        if (!ctx.sdk.getNearbyNpc(mob.objectId)) {
            // Already there and it isn't: a walk would "arrive" every turn until the coordinator gives up on the pull.
            if (dist(me, mob) <= 300) return ctx.skip('pull: focus not at its last position');
            ctx.doing('pull', mob.objectId, 'to its last position');
            const w = await ctx.bot.walkTo(mob.x, mob.y, { z: mob.z, tolerance: 300, timeout: 20_000 });
            if (!w.success) ctx.result('walk', w);
            return true;
        }
        ctx.doing('pull', mob.objectId, mob.name);
        const a = await until(() => instantSummonDue(ctx), () => ctx.bot.attack(mob.objectId, { timeout: 15_000 }));
        if (!a) return true;
        ctx.result('pull', a, mob.objectId);
        if (!a.success) { await waitOutSelfCc(a); return true; }
        await ctx.sdk.waitForCondition(() => ctx.sdk.getNearbyNpc(mob.objectId)?.targetObjectId === ctx.me().objectId, 6000).catch(() => null);
        if (far) await stopSwinging(ctx);
        return true;
    },
});

/** The highest anytime (no prerequisite) style; killNpc uses it every swing. */
export function anytimeStyles(ctx: MemberContext): string[] {
    return (ctx.sdk.getSkills().styles ?? []).filter(s => s.prerequisite === 256).sort((a, b) => b.specLevel - a.specLevel).slice(0, 1).map(s => s.name);
}

/**
 * Run `work` until it settles or `stop()` turns true (checked every `everyMs`): null when stopped.
 * Waits for the work's own cleanup (killNpc turns melee off) before returning. A parent
 * cancellation still throws.
 */
async function until<T>(stop: () => boolean, work: () => Promise<T>, everyMs = 500): Promise<T | null> {
    const parent = executionContext.getStore();
    const controller = new AbortController();
    const stopped = new Error('Stopped');
    const abort = () => controller.abort(parent?.signal.reason);
    parent?.signal.addEventListener('abort', abort, { once: true });
    // In a timer, past the member's every catch: a relog takes away the `me` a stop reads (keepCircles), and that ends the work as well. Thrown here it reaches the process, which under MCP has nothing to keep it up.
    const timer = setInterval(() => {
        let over = true;
        try { over = stop(); } catch { /* over */ }
        if (over) controller.abort(stopped);
    }, everyMs);
    const running: { work?: Promise<T> } = {};
    try {
        return await executionContext.run({ ...parent, signal: controller.signal }, () => abortable(running.work = work()));
    } catch (error) {
        if (error !== stopped) throw error;
        await Promise.race([running.work?.catch(() => {}), Bun.sleep(2000)]);
        return null;
    } finally {
        clearInterval(timer);
        parent?.signal.removeEventListener('abort', abort);
    }
}

/**
 * A contact's identity across object-id reuse: the server deletes a dead mob at once and hands its
 * id to the next new object (Region.cs:955), so per-mob memory keys on the id and when we first saw it.
 */
export const ckey = (c: { objectId: number; firstSeen: number }) => `${c.objectId}:${c.firstSeen}`;

/** When the tank first fought this mob (its taunt window starts there); forgets mobs that are gone. */
export function openingOf(ctx: MemberContext, mob: Contact, now = Date.now()): number {
    const first: Map<string, number> = ctx.memory.get('firstHit') ?? new Map();
    const live = new Set(ctx.picture().contacts.map(ckey));
    for (const k of first.keys()) if (!live.has(k)) first.delete(k);
    const k = ckey(mob);
    if (!first.has(k)) first.set(k, now);
    ctx.memory.set('firstHit', first);
    return first.get(k)!;
}

/**
 * An add hitting one of our casters or healers that nobody controls (a mezz ordered on it had peelAfterMs
 * to land). An enemy player counts only in melee reach of its victim (onMember: one nuking from range never
 * turns on the tank) and inside the chase leash (the tank doesn't go there, so it would stand idle instead).
 * Never an enemy pet: an ordered pet never turns (ControlledMobBrain.cs:549-552), so that fight only ends at its 20 s,
 * and the next turn takes it up again (r4on: Rbwar 44 on players, 619 on pets). As the group's focus, with no player free, it stays decideRvr's: that is no peel.
 */
export function peelTarget(ctx: MemberContext<TacticsSettings>): Contact | null {
    const o = ctx.orders();
    const now = Date.now();
    const soft = new Map(ctx.members().filter(m => !m.isDead && m.role !== 'tank' && m.role !== 'melee').map(m => [m.name, m]));
    return ctx.threats()
        .filter(t => !t.isPet && t.objectId !== o.focus && !t.stale && alive(t) && t.target !== null && soft.has(t.target) && (onMember(t, soft.get(t.target)!) || casterToPeel(ctx, t)) && !beyondLeash(ctx, t))
        .filter(t => uncontrolled(ctx, t, now))
        .sort((a, b) => a.hostileSince - b.hostileSince)[0] ?? null;
}

/**
 * Tank and melee while the focus stands beyond the chase leash: the nearest enemy fighting the group
 * inside it that nobody controls (a mezz ordered on it gets peelAfterMs, as for a peel), monsters too.
 * Null without a leash or without such an enemy: then they let the focus go, and holdFormation walks
 * them back from beyond the leash. decideRvr engages up to engageRadius + 1000 from the centre, so
 * a focus beyond the leash is common at first contact. `also` narrows who may stand in.
 */
export function leashFallback(ctx: MemberContext<TacticsSettings>, also: (t: Contact) => boolean = () => true): Contact | null {
    const leash = ctx.settings.chaseLeash;
    const o = ctx.orders();
    const anchor = o.anchor;
    if (leash === undefined || !anchor) return null;
    const me = ctx.me();
    const now = Date.now();
    return ctx.threats()
        .filter(t => t.objectId !== o.focus && !t.cc && !t.stale && alive(t) && dist(t, anchor) <= leash && uncontrolled(ctx, t, now) && also(t))
        .sort((a, b) => dist(me, a) - dist(me, b))[0] ?? null;
}

/**
 * Tank: fight the focus to the death (an orders change switches targets), with a taunt
 * style while it hits someone else and for tauntOpenMs from the first hit. An add on a
 * caster or healer that nobody controls (peelTarget) gets taunted until it turns on us
 * or is mezzed; then back to the focus. A focus beyond the chase leash gives way to the
 * nearest enemy inside it (leashFallback) until it comes back inside.
 */
export const tank = (opts: { style?: StylePick } = {}): Behavior<TacticsSettings> => ({
    name: 'tank',
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const add = peelTarget(ctx);
        const focus = ctx.focus();
        const away = !!focus && beyondLeash(ctx, focus);
        const stand = !add && away ? leashFallback(ctx) : null;
        const mob = add ?? stand ?? focus;
        if (!mob) return ctx.skip('tank: focus unknown');
        if (mob === focus && away) return ctx.skip('tank: focus beyond the chase leash, no enemy inside it');
        if (!foeInView(ctx, mob.objectId)) {
            // Already there and it isn't: a walk would "arrive" every turn until the board drops it.
            if (dist(ctx.me(), mob) <= 200) return ctx.skip('tank: target not at its last position');
            ctx.doing('move', mob.objectId, add ? `to the add on ${add.target}` : stand ? 'to the nearest enemy inside the leash' : 'to the focus');
            reportLeg(ctx, await ctx.bot.walkTo(mob.x, mob.y, { z: mob.z, tolerance: 200, timeout: 10_000 }));
            return true;
        }
        const { taunt, damage } = tankStyles(ctx.sdk.getSkills().styles ?? [], ctx.sdk.getState()?.equipment ?? []);
        // Fighting a stand-in for a focus beyond the leash: back to the focus once it is inside again.
        const focusBack = () => { const f = ctx.focus(); return !!stand && !!f && !beyondLeash(ctx, f); };
        // Players: taunts move no threat (players have no aggro table), so the damage style every swing.
        if (mob.kind === 'player') {
            ctx.doing('melee', mob.objectId, add ? `peel off ${add.target}` : stand ? 'fight (focus beyond the leash)' : 'fight');
            const held = () => {
                const c = ctx.contact(mob.objectId);
                return !c || !!c.cc || (c.target === ctx.name && Date.now() - c.targetSince > 1500);
            };
            // Let it go the moment it runs beyond the leash, measured from the anchor every 500 ms (the anchor can move,
            // CHASE_LIMIT only counts from where it stood): that ends the chase, and the limit stays a wide backstop.
            const gone = () => { const c = ctx.contact(mob.objectId); return !!c && beyondLeash(ctx, c); };
            const k = await until(add ? () => held() || gone() : () => peelTarget(ctx) !== null || gone() || focusBack(),
                () => ctx.bot.killPlayer(mob.objectId, { useStyle: seen => opts.style ? opts.style(seen) : damage, timeout: add || stand ? 20_000 : 90_000, maxChaseDistance: CHASE_LIMIT + (ctx.settings.chaseLeash ?? 0) }));
            // It died as we came: no failure, as for melee.
            if (k && k.reason !== 'already_dead') ctx.result('kill', k, mob.objectId);
            if (k?.reason === 'immune') await Bun.sleep(1500);
            await waitOutSelfCc(k);
            return true;
        }
        const opening = openingOf(ctx, mob);
        // One note per mob (for the observer): the style the tank opened with.
        const noted: Set<string> = ctx.memory.get('openerNoted') ?? new Set();
        ctx.memory.set('openerNoted', new Set([...noted].filter(k => (ctx.memory.get('firstHit') as Map<string, number>).has(k))));
        const useStyle: StyleChooser = ({ npc, player, state, styles }) => {
            const own = opts.style ? opts.style({ target: npc, player, state, styles }) : damage;
            // The taunt goes in as the backup: a style with an opening to meet runs only if it's met, and
            // a reaction needs the mob swinging at us, so the threat is there whenever it's still needed.
            const first = styleQueue(own, styles)[0];
            const style = taunt && (add || npc.targetObjectId !== player.objectId || Date.now() - opening < ctx.settings.tauntOpenMs)
                ? (first && first.prerequisite !== ANYTIME_STYLE ? [first.name, taunt] : taunt)
                : own;
            const seen: Set<string> = ctx.memory.get('openerNoted');
            const opener = typeof style === 'string' ? style : style?.[0];
            if (opener && !seen.has(ckey(mob))) { seen.add(ckey(mob)); ctx.note(`opener ${opener} on ${mob.name}`); }
            return style;
        };
        if (add) {
            ctx.doing('melee', add.objectId, `taunt off ${add.target}`);
            const held = () => {
                const c = ctx.contact(add.objectId);
                return !c || !!c.cc || (c.target === ctx.name && Date.now() - c.targetSince > 1500);
            };
            // usePet false, here and below: in a group petControl is the one authority over the pet (pets.ts).
            const k = await until(held, () => ctx.bot.killNpc(add.objectId, { force: true, useStyle, timeout: 20_000, maxChaseDistance: CHASE_LIMIT, usePet: false }));
            if (k && k.reason !== 'already_dead') ctx.result('kill', k, add.objectId);
            await waitOutSelfCc(k);
            return true;
        }
        ctx.doing('melee', mob.objectId, 'tank');
        const k = await until(() => peelTarget(ctx) !== null || focusBack(), () => ctx.bot.killNpc(mob.objectId, { force: true, useStyle, timeout: 90_000, maxChaseDistance: CHASE_LIMIT, usePet: false }));
        if (k && k.reason !== 'already_dead') ctx.result('kill', k, mob.objectId);
        await waitOutSelfCc(k);
        return true;
    },
});

/**
 * Tank: keep Guard and Protect on the members settings.guard names (a name or a role).
 * Guard blocks attacks on them with our shield while we stand within 256 of them
 * (GuardAbilityHandler.GUARD_DISTANCE); Protect moves 10 % per ability level of the
 * threat they cause to us while within 1000 (StandardMobBrain.AddToAggroList). Both
 * last until cancelled or a death, and show in our effects as "Brigid guarded by
 * Cuchulainn" / "Ciaran protected by Cuchulainn". Using one again on the same member
 * cancels it, so this acts only when that effect is missing. Out of fights only: it
 * selects the member as our target.
 */
export const guard = (): Behavior<TacticsSettings> => ({
    name: 'guard',
    async run(ctx) {
        const phase = ctx.orders().phase;
        if ((!QUIET_PHASES.has(phase) && phase !== 'travel') || ctx.threats().length || ctx.bot.isDead()) return false;
        const effects = (ctx.sdk.getState()?.effects ?? []).map(e => e.name);
        for (const [ability, verb] of [['Guard', 'guarded'], ['Protect', 'protected']] as const) {
            const want = ability === 'Guard' ? ctx.settings.guard.guard : ctx.settings.guard.protect;
            if (!want || !ctx.sdk.findAbility(new RegExp(`^${ability}`, 'i'))) continue;
            const m = ctx.members().find(x => !x.isDead && x.name !== ctx.name && (x.name === want || x.role === want));
            if (!m || effects.includes(`${m.name} ${verb} by ${ctx.name}`)) continue;
            // Out of view a select doesn't take, and the ability lands on what we hold: "You can't guard yourself!" (GuardAbilityHandler.cs).
            if (!ctx.sdk.getNearbyPlayers().some(p => p.objectId === m.objectId)) continue;
            // The effect shows a snapshot after the server applies it: don't toggle it off again meanwhile.
            if (Date.now() - (ctx.memory.get(`${ability}At`) ?? 0) < 10_000) continue;
            ctx.memory.set(`${ability}At`, Date.now());
            await stopSwinging(ctx);
            ctx.doing('guard', null, `${ability} ${m.name}`);
            await ctx.sdk.sendSetTarget(m.objectId);
            const r = await ctx.bot.useAbility(new RegExp(`^${ability}`, 'i'));
            // "You are now guarding Brigid, but you must stand closer." is a success (it works once we are near).
            const on = r.messages.find(x => /You are now (guarding|protecting)/.test(x.text));
            ctx.result(ability.toLowerCase(), on ? { ...r, success: true, message: on.text } : r);
            return true;
        }
        return false;
    },
});

/**
 * Whether damage dealers may open on `mob`, and when: once it has targeted the tank for holdMs,
 * counted from the engage order for a mob that ran there (a body pull carried home: the server
 * hides a running mob's target, so its targetSince only starts when it stops), or once it has
 * fought for assistAfterMs whoever it hits. Without a living tank: at once.
 *
 * A mob on a pet counts the same, for casters and pets alike: on the tank's own pet it is held by the tank, and on another member's it is
 * held once it has read on that pet for holdMs. A nuke can pull it off that one, but it no longer waits 6 s with the mob safe (a defensive pet takes a mob in ~33 ms, unordered: ControlledMobBrain.cs:614-638).
 * The report's tank hold % stays strict: only the tank itself (observer.ts).
 */
export function holdState(mob: Pick<Contact, 'target' | 'targetPet' | 'targetSince' | 'movedAt' | 'engagedAt' | 'hostileSince'>, tankName: string | null, holdMs: number, assistAfterMs: number, now: number): { held: boolean; dueAt: number } {
    if (!tankName) return { held: true, dueAt: now };
    // A carried mob keeps its last target (and so stays hostile) all the way home: both clocks start at the engage order.
    const floor = (t: number) => (mob.movedAt > 0 ? Math.max(t, mob.engagedAt || now) : t);
    const dueAt = Math.min(mob.target === tankName || mob.targetPet ? floor(mob.targetSince) + holdMs : Infinity, mob.hostileSince > 0 ? floor(mob.hostileSince) + assistAfterMs : Infinity);
    return { held: now >= dueAt, dueAt };
}

/** With no tank to run to (tankToRunTo), a nuker takes an instant after this many interrupts in a row by one attacker: flee stands aside, and a 3 s nuke took 10 and 11 in a row live with no output for it (20261104-044005, -045536). */
const INTERRUPTS_IN_A_ROW = 2;
/** ... until a spell with a cast time lands, or this long with nothing to say it is still at it. */
const INTERRUPTS_LAST_MS = 10_000;

/** The line names who it was (SpellHandler.cs:410): "The necroservant attacks you and your spell is interrupted!". */
const interrupter = (message: string | undefined) => /^(.+?) attacks you and your spell is interrupted/i.exec(message ?? '')?.[1] ?? message ?? '';

/** What a nuke's end says of the interrupts it has been taking: `memory` the member's. Anything refused before it began says nothing. */
export function noteNukeEnd(memory: Map<string, any>, spell: { castTime: number }, c: { success: boolean; reason?: string; message?: string }, now: number): void {
    const was: { by: string; times: number; at: number } | undefined = memory.get('nukeBroken');
    if (c.reason === 'interrupted') {
        const by = interrupter(c.message);
        memory.set('nukeBroken', { by, times: was?.by === by ? was.times + 1 : 1, at: now });
    } else if (c.success && was) {
        if (spell.castTime > 0) memory.delete('nukeBroken');
        else was.at = now;
    }
}

/** Whether the next nuke should be an instant, by that. */
export function nukeUnderFire(memory: Map<string, any>, now: number): boolean {
    const was: { times: number; at: number } | undefined = memory.get('nukeBroken');
    return !!was && was.times >= INTERRUPTS_IN_A_ROW && now - was.at < INTERRUPTS_LAST_MS;
}

/**
 * Damage dealer: once the tank has held the focus (holdState, holdMs or opts.holdMs; a holdMs of 0
 * doesn't wait at all), nuke it (the best DoT family once, then direct damage), or melee with `melee`.
 * Never touches a mezzed mob, nor a rooted one while anything else in the fight is free (ccHolds).
 * Melee leaves a focus beyond the chase leash for the nearest enemy inside it (leashFallback), and its walk ends where the tank's does: the focus moved, the foe beyond the leash, or the focus back inside it.
 * `style` picks the styles of its melee (fighterStyle, or a character's own); without one it swings plain.
 * `holdGround` casts only from where it stands, or a step of at most that many units, whatever the settings say.
 * A skip leaves no swing on: it holds our pet's order (selectFree), it would break a mezz, and on a corpse it only earns "X is already dead!" every round. Only one on the mob it is waiting to hit stays.
 * With no tank to run to (none alive, or one flee leaves: another region, over 5000 off), under fire (nukeUnderFire), it takes an instant if it has one in reach of the target.
 */
export const assist = (opts: { melee?: boolean; holdMs?: number; style?: StylePick; holdGround?: number } = {}): Behavior<TacticsSettings> => ({
    name: opts.melee ? 'assistMelee' : 'assist',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const skipping = async (why: string, keepOn?: number) => {
            if (ctx.me().targetObjectId !== keepOn) await stopSwinging(ctx);
            return ctx.skip(why);
        };
        const focus = ctx.focus();
        if (!focus || !alive(focus)) return skipping('assist: focus unknown');
        // Ids are per region (Region.cs:151, :779): what holds it in our view here is something else, and its position means nothing here. holdFormation brings us back.
        if (focus.regionId !== ctx.me().regionId) return skipping('assist: focus in another region');
        if (ccHolds(ctx, focus)) return skipping('assist: focus is crowd-controlled');
        // Not one under a keep's guards, inside the leash or not: its walk's check below lets that go every time, and the steps add up to a walk into the circle (moveTo 25, stop 24).
        const mob = opts.melee && beyondLeash(ctx, focus) ? leashFallback(ctx, t => !beyondLeash(ctx, t)) : focus;
        if (!mob) return skipping('assist: focus beyond the chase leash, no enemy inside it');
        // The picture can trail a death by a snapshot; our own client knows first.
        const seen = foeInView(ctx, mob.objectId);
        if (seen && isDown(ctx, seen)) return skipping('assist: focus just died');
        if (!seen) {
            if (ctx.settings.standGround || opts.holdGround !== undefined) return skipping('assist: focus not in view, holding ground');
            // Others see it, we don't (beyond our view): close in on where the group last saw it.
            const me0 = ctx.me();
            const d = dist(me0, mob);
            const stop = (ctx.settings.combatRange[ctx.role]?.[1] ?? 1400) - 200;
            if (d <= stop) return skipping('assist: focus not in view');
            const f = (d - stop) / d;
            ctx.doing('move', mob.objectId, 'toward the focus');
            reportLeg(ctx, await ctx.bot.walkTo(me0.x + (mob.x - me0.x) * f, me0.y + (mob.y - me0.y) * f, { tolerance: 100, timeout: 6000 }));
            return true;
        }
        const tankM = ctx.tank();
        const now = Date.now();
        // An enemy player is never "held" by a tank (players have no aggro table): hit it at once.
        const { held } = mob.kind === 'player' || opts.holdMs === 0 ? { held: true } : holdState(mob, tankM?.name ?? null, opts.holdMs ?? ctx.settings.holdMs, ctx.settings.assistAfterMs, now);
        if (!held) return skipping('assist: waiting for the tank to hold it', mob.objectId);
        const me = ctx.me();
        if (!opts.melee) {
            // DoT families already on this mob, kept per mob (object ids are reused at once).
            const key = `dotted:${ckey(mob)}`;
            const live = new Set(ctx.picture().contacts.map(c => `dotted:${ckey(c)}`));
            for (const k of [...ctx.memory.keys()]) if (k.startsWith('dotted:') && !live.has(k)) ctx.memory.delete(k);
            const dotted: Set<string> = ctx.memory.get(key) ?? new Set();
            const nuke = { dotted, targetHp: mob.hp, aoe: ctx.settings.aoe, byDamage: ctx.settings.strongestNuke };
            const usual = ctx.spells.nuke(nuke);
            const instant = usual && usual.castTime > 0 && !tankToRunTo(ctx) && nukeUnderFire(ctx.memory, now) ? ctx.spells.nuke({ ...nuke, instant: true }) : null;
            const sp = instant && seen.distance <= instant.range ? instant : usual;
            if (sp) {
                const stand = !!ctx.settings.standGround || opts.holdGround !== undefined;
                if (stand && seen.distance > sp.range) {
                    // Just out of reach: a short step in, unless that means walking onto enemies (standStep). Further: hold.
                    const step = standStepTo(ctx.me(), seen, sp.range, opts.holdGround ?? ctx.settings.standStep ?? 0, ctx.picture().contacts);
                    if (!step) return skipping('assist: focus out of reach, holding ground', mob.objectId);
                    ctx.doing('move', mob.objectId, 'step in range');
                    await ctx.bot.walkTo(step.x, step.y, { tolerance: 40, timeout: 3000 });
                    return true;
                }
                await stopSwinging(ctx);
                // castSpell would walk this and cast in one turn, up to 15 s live with a pet going from 49 % to 9 % behind it. A step instead, back to the list; a cast itself is never cut.
                if (seen.distance > sp.range) {
                    ctx.doing('move', mob.objectId, `into range for ${sp.spell.name}`);
                    reportLeg(ctx, await ctx.bot.walkToObject(seen, { range: Math.max(100, sp.range * 0.85), timeout: CAST_STEP_MS }));
                    return true;
                }
                ctx.doing('nuke', mob.objectId, sp.spell.name);
                const c = await ctx.bot.castSpell(sp.spell, mob.objectId, stand ? { approach: false } : {});
                ctx.result('nuke', c, mob.objectId);
                noteNukeEnd(ctx.memory, sp, c, Date.now());
                if (sp.type === 'DamageOverTime' && (c.success || /already has that effect/i.test(c.message ?? ''))) { dotted.add(dotFamily(sp)); ctx.memory.set(key, dotted); }
                if (await waitOutSelfCc(c)) return true;
                if (!c.success && c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
                else if (c.reason === 'no_power') await Bun.sleep(2000);
                return true;
            }
            if (!ctx.settings.meleeWhenOom || me.maxMana === 0) return skipping('assist: no power', mob.objectId);
        }
        const live = foeInView(ctx, mob.objectId);
        ctx.doing('melee', mob.objectId);
        if (!me.attacking || me.targetObjectId !== mob.objectId || !live || live.distance > 150) {
            const far = !live || live.distance > 150;
            // A swing left on the last target hits nothing from where this walk goes, and holds our pet's order for its length. Beside the new one it just follows the select.
            if (far && me.targetObjectId !== mob.objectId) await stopSwinging(ctx);
            // attack's walk has no end of its own: it chased a player who left past the leash and past the focus, 25 s live with the pet's order behind it (run 20261104-045536). As the tank's (killPlayer): let go when that's no more the job.
            const left = () => {
                const now = ctx.orders();
                if (now.phase !== 'engage' || now.focus !== o.focus) return true;
                const c = ctx.contact(mob.objectId);
                if (c && beyondLeash(ctx, c)) return true;
                const f = ctx.focus();
                return mob !== focus && !!f && !beyondLeash(ctx, f);
            };
            const a = await until(left, () => ctx.bot.attack(mob.objectId, { timeout: 8000 }), MELEE_WALK_CHECK_MS);
            if (!a) {
                await stopSwinging(ctx);
                return true;
            }
            // It died as we came, and attack has stopped the swing: no failure, and no pause before the next.
            if (!a.success && a.reason !== 'already_dead') ctx.result('melee', a, mob.objectId);
            await waitOutSelfCc(a);
            if (a.reason === 'immune') await Bun.sleep(1500);
        } else if (opts.style && Date.now() - (ctx.memory.get('styleAt') ?? 0) > STYLE_SPACING_MS) {
            const queue = pickStyleFromSeen(opts.style, { target: live, player: me, state: ctx.sdk.getState()!, styles: ctx.sdk.getSkills().styles });
            if (queue.length) {
                ctx.memory.set('styleAt', Date.now());
                for (const style of queue) await ctx.sdk.sendUseSkill(style.skillIndex);
            }
        }
        await Bun.sleep(400);
        return true;
    },
});

/** Not off the map either, as far as there is one to go by where we stand (onMap, keepOnMap). */
function inBounds(me: PlayerState, safe: (p: Point) => boolean): (p: Point) => boolean {
    return onMap(me.regionId, me) ? p => safe(p) && onMap(me.regionId, p) : safe;
}

/** Nukes stop below this % power: a rez at equal level costs half the pool and keeps a reserve of 25 (RVR_SETTINGS.rez), and heals need the rest. */
const SPARE_NUKE_MANA = 75;
/** The most it steps toward a focus just out of range: half its idle fight time went on that without a step (throwaway run, learnings/rvr.md). */
const SPARE_NUKE_STEP = 400;

/**
 * A healer with nothing to heal hits the focus, on spare power only and within a short step of where it
 * stands, so the nuke costs no heal: below heal() in the list, and no walk out of healing reach. Nothing for a
 * member with no nuke. Its own name, so it is no role fight: a character's fight still goes where it did.
 */
export const spareNuke = (minMana = SPARE_NUKE_MANA): Behavior<TacticsSettings> => {
    const inner = assist({ holdGround: SPARE_NUKE_STEP });
    return {
        ...inner,
        name: 'spareNuke',
        async run(ctx) {
            if (ctx.orders().phase !== 'engage' || !ctx.spells.capabilities().nuke) return false;
            if (ctx.me().manaPercent < minMana) return ctx.skip(`spareNuke: saving power (< ${minMana} %)`);
            return inner.run(ctx);
        },
    };
};

/**
 * Stay within our role's limits from the fight (combatRange, narrowed by the spell we cast;
 * positioning.ts): step out when a mob could reach us mid-cast, step in when the settled focus
 * is out of our spells' reach, along our own bearing and never into aggressive reach. Inside
 * the limits we don't move, so assist casts at once. Session 2: with a band to centre in on the
 * tank's side, casters crossed most close fights (1,200-1,400 units) and nuked 5-9 s late.
 */
export const position = (): Behavior<TacticsSettings> => ({
    name: 'position',
    async run(ctx) {
        const o = ctx.orders();
        const band = ctx.settings.combatRange[ctx.role];
        if (o.phase !== 'engage' || !band) return false;
        const mob = ctx.focus();
        if (!mob) return false;
        const now = Date.now();
        if (now < (ctx.memory.get('positionRetryAt') ?? 0)) return ctx.skip('position: walk failed, retrying soon');
        const me = ctx.me();
        // Chased by an add: flee() brings us to the tank for the peel and the mezz; stepping out would undo it.
        if (ctx.threats().some(t => onMember(t, me))) return ctx.skip('position: chased, staying by the tank');
        const live = foeInView(ctx, mob.objectId);
        const at = live ?? mob;
        const trail = trackFocus(ctx.memory.get('focusTrail'), mob.objectId, at, now);
        ctx.memory.set('focusTrail', trail);
        const [min, max] = effectiveLimits(band, ctx.role === 'nuker' ? ctx.spells.nuke() : ctx.spells.heal());
        // Crowd-controlled adds drop out of the threats ~4 s after the mezz lands; they still wake up.
        const around = ctx.picture().contacts.filter(c => !c.stale && alive(c) && (c.threat || c.cc));
        const spot = combatSpot({
            me, anchor: o.anchor, stops: dangerStops(around, ctx.members(), me, now),
            focus: { x: at.x, y: at.y, d3: live?.distance ?? dist(me, at) },
            settled: focusSettled({ focus: mob, at, tank: ctx.tank(), speed: live?.kind === 'npc' ? live.speed : undefined, trail, now }),
            min, max, safe: inBounds(me, safeSpot(me.regionId, me.level, ctx.settings.aggroTolerance ?? -3)),
        });
        if (!spot) return false;
        if (!spot.to) return ctx.skip('position: no safe spot');
        // Already there in 2D (the 'in' check is 3D, so slopes leave a gap a step can't close): cast; castSpell closes in itself.
        if (dist(me, spot.to) <= 60) return false;
        await stopSwinging(ctx);
        ctx.doing('move', mob.objectId, `position ${spot.move} ${Math.round(spot.d)}→${Math.round(spot.want)}`);
        const w = await ctx.bot.walkTo(spot.to.x, spot.to.y, { tolerance: 60, timeout: 1500 + dist(me, spot.to) / (ctx.sdk.getState()?.movement.swimming ? 0.085 : 0.191) });
        if (!w.success) { ctx.result('walk', w); ctx.memory.set('positionRetryAt', Date.now() + 3000); }
        return true;
    },
});

/**
 * In a fight, how far from the anchor a member may stand before holdFormation walks it back. Tank
 * and melee leave enemies beyond the chase leash alone (tank, assist), so beyond it they have
 * nothing to fight: they come back from there. Casters place themselves by the focus (position).
 */
export function fightRejoin(role: Role, chaseLeash: number | undefined): number {
    return chaseLeash !== undefined && (role === 'tank' || role === 'melee') ? Math.min(FIGHT_REJOIN, chaseLeash) : FIGHT_REJOIN;
}

/** One leg toward a slot, around known danger and the enemy keeps' guards. */
async function walkTowardSlot(ctx: MemberContext<TacticsSettings>, slot: Point, leg: number, o: { speedFactor?: number; detail?: string } = {}): Promise<void> {
    const me = ctx.me();
    const d = dist(me, slot);
    let to: Point = slot;
    if (d > leg) {
        const next = safePath(me.regionId, me.level, me, slot, keepCircles(ctx))[0] ?? slot;
        const f = Math.min(1, leg / dist(me, next));
        to = { x: me.x + (next.x - me.x) * f, y: me.y + (next.y - me.y) * f };
    }
    ctx.doing('move', null, o.detail ?? ctx.orders().phase);
    const w = await ctx.bot.walkTo(to.x, to.y, { tolerance: 80, ...(o.speedFactor ? { speedFactor: o.speedFactor } : {}) });
    if (!w.success) { ctx.result('walk', w); await Bun.sleep(500); }
}

/** A follower this close to its place in the column stays where it is ... */
export const COLUMN_BAND = 80;
/** ... and one farther than this walks there by the navmesh, leg by leg, as to a slot: nearer, a straight move does, renewed every turn. */
export const COLUMN_FAR = 1000;
/** The driver's own walk ends this close to the leg's end, as a slot's does when travelling (needsSlot). */
const COLUMN_DRIVER_SLACK = 250;
/** Memory key: the last spot a follower's raw move was sent to. */
const COLUMN_MOVE = 'columnMove';
/** Memory key: the driver's recent reported positions ({x, y, at}), for his velocity. */
const COLUMN_TRACK = 'columnTrack';
/** Full run speed, units per second (client/movement.ts PLAYER_BASE_SPEED). */
const RUN_SPEED = 191;
/** The driver moves when his reports say this fast or faster (units per second) ... */
export const COLUMN_MOVING = 40;
/** ... over reports at least this far apart and at most COLUMN_TRACK_MS old. */
const COLUMN_TRACK_MIN_MS = 300;
const COLUMN_TRACK_MS = 1000;
/**
 * While he moves, a follower aims this far beyond its place, along his way, so its mover never slows down to arrive
 * (it brakes for its end: movement.ts ramp) and the speed keeps it in place instead.
 */
export const COLUMN_LEAD = 400;
/** Speed added per unit behind its place (per second: 100 behind runs 100 faster than the driver), and the slowest it goes. */
const COLUMN_GAIN = 1;
const COLUMN_MIN_SPEED = 0.3;

/**
 * The driver's velocity (units per second) from his last reports, or null standing or with too few: the oldest report
 * within COLUMN_TRACK_MS against the newest, at least COLUMN_TRACK_MIN_MS apart.
 */
function driverVelocity(ctx: MemberContext<TacticsSettings>, driver: MemberReport): Point | null {
    const prev: { x: number; y: number; at: number }[] = ctx.memory.get(COLUMN_TRACK) ?? [];
    const track = prev.at(-1)?.at === driver.at ? prev : [...prev, { x: driver.x, y: driver.y, at: driver.at }];
    const recent = track.filter(s => driver.at - s.at <= COLUMN_TRACK_MS);
    ctx.memory.set(COLUMN_TRACK, recent);
    const first = recent[0]!, last = recent.at(-1)!;
    const dt = (last.at - first.at) / 1000;
    if (dt * 1000 < COLUMN_TRACK_MIN_MS) return null;
    const v = { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
    return Math.hypot(v.x, v.y) >= COLUMN_MOVING ? v : null;
}

/**
 * How fast a follower runs (speed factor) and where it aims while the driver moves at `v`: his speed, plus COLUMN_GAIN
 * per unit it is behind its place along his way (less when ahead), toward a point COLUMN_LEAD beyond its place.
 */
export function columnPace(me: Point, spot: Point, v: Point): { to: Point; speedFactor: number } {
    const speed = Math.hypot(v.x, v.y);
    const f = { x: v.x / speed, y: v.y / speed };
    const behind = (spot.x - me.x) * f.x + (spot.y - me.y) * f.y;
    const speedFactor = Math.round(Math.min(1, Math.max(COLUMN_MIN_SPEED, (speed + COLUMN_GAIN * behind) / RUN_SPEED)) * 100) / 100;
    return { to: { x: Math.round(spot.x + f.x * COLUMN_LEAD), y: Math.round(spot.y + f.y * COLUMN_LEAD) }, speedFactor };
}

/**
 * A follower's place in the column: `back` behind the driver, on the line from where he is heading (`ahead`, the leg's end)
 * through him. Standing at the leg's end he heads nowhere: then `back` from him on the follower's own side, as a /stick holds.
 */
export function columnSpot(driver: Point, ahead: Point | null, me: Point, back: number): Point {
    const unit = (dx: number, dy: number) => { const l = Math.hypot(dx, dy); return l < 1 ? null : { x: dx / l, y: dy / l }; };
    const u = (ahead && dist(driver, ahead) > 100 ? unit(driver.x - ahead.x, driver.y - ahead.y) : null) ?? unit(me.x - driver.x, me.y - driver.y) ?? { x: 1, y: 0 };
    return { x: Math.round(driver.x + u.x * back), y: Math.round(driver.y + u.y * back) };
}

/**
 * Travelling in a column (Orders.column): the driver walks the leg a little slower than full speed, and each other member
 * keeps its place behind him, (rank + 1) × gap back. A follower's move is a raw one renewed every turn, as bot.follow does,
 * so it doesn't stop and start at each step; casts stop it (castSpell), and so does leaving the column. While he moves
 * it aims past its place and keeps it by speed (columnPace): aimed at the place itself it braked there, stood until he
 * was COLUMN_BAND on, and started again from rest, so the whole line trailed about 140 too far back (2026-11-09 A/B).
 * Its place is where his last report puts him now, at his velocity. Null: not ours to walk (not in the order, or the
 * driver gone), and the slot round the anchor holds instead.
 */
async function walkInColumn(ctx: MemberContext<TacticsSettings>): Promise<boolean | null> {
    const o = ctx.orders();
    const col = o.column;
    if (!col || !o.anchor) return null;
    const me = ctx.me();
    if (col.driver === ctx.name) {
        if (dist(me, o.anchor) < COLUMN_DRIVER_SLACK) return false;
        await walkTowardSlot(ctx, o.anchor, 2500, { speedFactor: col.speed, detail: 'travel: driving the column' });
        return true;
    }
    const rank = col.order.indexOf(ctx.name);
    const driver = ctx.member(col.driver);
    if (rank < 0 || !driver || driver.isDead || driver.regionId !== me.regionId) return null;
    const v = driverVelocity(ctx, driver);
    const ahead = v ? Math.min(1, Math.max(0, (Date.now() - driver.at) / 1000)) : 0;
    const now = v ? { ...driver, x: driver.x + v.x * ahead, y: driver.y + v.y * ahead } : driver;
    const spot = keepOnMap(me.regionId, driver, columnSpot(now, o.anchor, me, (rank + 1) * col.gap));
    const d = dist(me, spot);
    if (d > COLUMN_FAR) {
        ctx.memory.delete(COLUMN_MOVE);
        await walkTowardSlot(ctx, spot, 2500, { detail: `travel: catching up with ${col.driver}` });
        return true;
    }
    // Standing: to its place, and there it stays. Moving: past it, at the pace that keeps it there.
    if (!v && d <= COLUMN_BAND) return false;
    const pace = v ? columnPace(me, spot, v) : null;
    const to = pace ? keepOnMap(me.regionId, spot, pace.to) : spot;
    const speedFactor = pace?.speedFactor ?? 1;
    const last: { x: number; y: number; speedFactor?: number } | undefined = ctx.memory.get(COLUMN_MOVE);
    if (!last || dist(last, to) > 40 || Math.abs((last.speedFactor ?? 1) - speedFactor) >= 0.05 || !ctx.sdk.getMovement()?.moving) {
        const sent = await ctx.sdk.sendMoveTo(to.x, to.y, driver.z, { tolerance: 40, ...(speedFactor < 1 ? { speedFactor } : {}) });
        if (!sent.success) { ctx.memory.delete(COLUMN_MOVE); ctx.result('walk', sent); return null; }
        ctx.memory.set(COLUMN_MOVE, { x: to.x, y: to.y, speedFactor });
    }
    ctx.doing('move', null, `travel: column behind ${col.driver}`);
    return true;
}

/** Out of the column with a raw move of ours still going: stop it, or it walks on to a place behind a driver nobody follows now. */
async function leaveColumn(ctx: MemberContext<TacticsSettings>): Promise<void> {
    ctx.memory.delete(COLUMN_TRACK);
    if (!ctx.memory.has(COLUMN_MOVE)) return;
    ctx.memory.delete(COLUMN_MOVE);
    if (ctx.sdk.getMovement()?.moving) await ctx.sdk.sendStop();
}

/**
 * In a fight, far from it (back from a release): walk back around known danger before the fight behaviours
 * get a turn. From far off a nuker's assist walks straight at the focus, through any aggro zone on the way, and a
 * tank's killPlayer fails out_of_reach before its first step, turn after turn. Round 10: Niamh died to the perturbed
 * bwca four times on that line, and Thorgrim logged 100 failures walking back.
 */
export const rejoinFight = (): Behavior<TacticsSettings> => ({
    name: 'rejoinFight',
    async run(ctx) {
        if (!farFromFight(ctx)) return false;
        const o = ctx.orders();
        await stopSwinging(ctx);
        await walkTowardSlot(ctx, formationSlot(ctx, o.anchor!, o.facing), 2500);
        return true;
    },
});

/**
 * Outside fights: stand in our formation slot at the anchor. Far away (after a
 * release, or travelling), walk there around known danger.
 */
export const holdFormation = (): Behavior<TacticsSettings> => ({
    name: 'holdFormation',
    async run(ctx) {
        const o = ctx.orders();
        if (!o.anchor || o.phase === 'retreat') return false;
        if (o.phase === 'pull' && o.puller === ctx.name) return false;
        // Nobody walks alone: the group is on its way to pick us up (pack.ts).
        if (o.waiting.some(w => w.name === ctx.name && w.why === 'pickup')) return ctx.skip('waiting to be picked up');
        if (o.phase === 'travel' && o.column) {
            const walked = await walkInColumn(ctx);
            if (walked !== null) return walked;
        }
        await leaveColumn(ctx);
        const me = ctx.me();
        // In a fight only a member far from it moves here (back from a release, or tank and melee left beyond
        // the leash): the others' fight behaviours place them.
        const fromAnchor = dist(me, o.anchor);
        if (o.phase === 'engage' && fromAnchor < fightRejoin(ctx.role, ctx.settings.chaseLeash)) return false;
        const slot = formationSlot(ctx, o.anchor, o.facing);
        const d = dist(me, slot);
        const safe = safeSpot(me.regionId, me.level, ctx.settings.aggroTolerance ?? -3);
        if (!needsSlot({ dSlot: d, dAnchor: fromAnchor, phase: o.phase, slack: ctx.settings.slotSlack, gatherRadius: (ctx.settings as { gatherRadius?: number }).gatherRadius, safe: safe(me) })) return false;
        await stopSwinging(ctx);
        await walkTowardSlot(ctx, slot, o.phase === 'engage' && fromAnchor < FIGHT_REJOIN ? LEASH_REJOIN_LEG : 2500);
        return true;
    },
});

/**
 * Whether a member walks back to its formation slot. Travelling: from 250 off. Otherwise from
 * 120 off, unless within `slack` of the slot, at a safe spot, and well inside the gather radius
 * (so slack never turns into a "gather: waiting for ..."): after a fight casters stay put.
 */
export function needsSlot(o: { dSlot: number; dAnchor: number; phase: string; slack: number; gatherRadius?: number; safe: boolean }): boolean {
    if (o.phase === 'travel') return o.dSlot >= 250;
    if (o.dSlot < 120) return false;
    return !(o.dSlot < o.slack && o.dAnchor < (o.gatherRadius ?? DEFAULT_GATHER_RADIUS) - 100 && o.safe);
}

/** While the group waits: sit until rest.hp / rest.mana, or until the power summonPet above asks for (REST_MANA_UP_TO), which gets the next turn. */
export const rest = (): Behavior<TacticsSettings> => ({
    name: 'rest',
    async run(ctx) {
        if (!QUIET_PHASES.has(ctx.orders().phase) || ctx.threats().length) return false;
        const busy: { until: number; why: string } | undefined = ctx.memory.get('restBusy');
        if (busy && Date.now() < busy.until) return ctx.skip(busy.why);
        const me = ctx.me();
        const r = ctx.settings.rest;
        const caster = me.maxMana > 0;
        if (me.healthPercent >= r.hp && (!caster || me.manaPercent >= r.mana)) return false;
        // rest() refuses while any NPC in view targets us or just hit us, even one leashing home far away.
        const on = ctx.bot.getAttackers()[0] ?? ctx.bot.getPlayerAttackers()[0];
        if (on) return ctx.skip(`rest: ${on.name} is on us (${Math.round(on.distance)} away)`);
        const upTo: number | undefined = ctx.memory.get(REST_MANA_UP_TO);
        ctx.doing('rest', null, upTo !== undefined ? SAVING_POWER : '');
        const res = await ctx.bot.rest(caster && upTo !== undefined && upTo < r.mana
            ? { healthPercent: 0, manaPercent: upTo, timeout: 120_000 }
            : { healthPercent: r.hp, manaPercent: caster ? r.mana : undefined, timeout: 120_000 });
        // No failure, as for a mob on us above, and it cost no send. The line says who.
        if (res.reason === 'in_combat') {
            const why = `rest: ${res.message}`;
            ctx.memory.set('restBusy', { until: Date.now() + REST_BUSY_MS, why });
            return ctx.skip(why);
        }
        if (!res.success) { ctx.result('rest', res); return ctx.skip(`rest: ${res.reason}`); }
        return true;
    },
});

/**
 * Play the song the moment calls for (songs.ts): speed while travelling, endurance or else
 * added damage while pulling and fighting, power or health between fights when casters are low
 * or someone is hurt. Never re-casts the song that is playing: that stops it.
 */
export const song = (): Behavior<TacticsSettings> => ({
    name: 'song',
    interruptible: false,
    async run(ctx) {
        const songs = ctx.spells.songs();
        if (!songs.length || ctx.bot.isDead()) return false;
        // Refused for what is in hand, say: a try every 10 s only earns a failed turn each (14 in one round live).
        if (Date.now() < (ctx.memory.get('songRetryAt') ?? 0)) return false;
        const kind = chooseSong(songs.map(s => s.kind), ctx.orders().phase, ctx.members(), ctx.settings.songs ?? SONG_SETTINGS, ctx.me().endurancePercent);
        const want = songs.find(s => s.kind === kind);
        if (!want) return false;
        const playing = (ctx.sdk.getState()?.effects ?? []).map(e => e.name);
        const now = Date.now();
        // A pulse's effect can drop out between two pulses, so it counts as playing until a pulse is overdue;
        // and a run can begin in such a gap, so nothing is cast before one such wait has gone by.
        const seen: Map<string, number> = ctx.memory.get('songSeen') ?? new Map();
        ctx.memory.set('songSeen', seen);
        for (const s of songs) if (playing.includes(s.spell.name)) seen.set(s.spell.name, now);
        const overdueMs = want.frequency * 100 + 1000;
        const since: number = ctx.memory.get('songSince') ?? now;
        ctx.memory.set('songSince', since);
        if (now - since < overdueMs || now - (seen.get(want.spell.name) ?? 0) < overdueMs) return false;
        // Just cast: give the effect time to show before trying again (a second cast would stop it).
        const last: { name: string; at: number } | undefined = ctx.memory.get('songCast');
        if (last?.name === want.spell.name && now - last.at < 10_000) return false;
        // Keep a song we started for songs.holdMs (short hops between idle and travel made it flap),
        // except into a fight.
        const holdMs = (ctx.settings.songs ?? SONG_SETTINGS).holdMs;
        if (last && playing.includes(last.name) && Date.now() - last.at < holdMs && ctx.orders().phase !== 'engage') return false;
        if (want.spell.cooldownRemaining > 0) return false;
        // ccFirst: the mezz goes before a song change while we have one to cast (songs.ts).
        const o = ctx.orders();
        if ((ctx.settings.songs ?? SONG_SETTINGS).ccFirst && o.phase === 'engage' && o.cc.some(a => a.by === ctx.name)) return false;
        // A cast would stop the swing; one with a cast time waits for the fight to end.
        if (ctx.me().attacking && want.castTime > 0) return false;
        ctx.doing('song', null, want.spell.name);
        ctx.memory.set('songCast', { name: want.spell.name, at: Date.now() });
        // Swinging: an instant one goes out raw, because castSpell selects us and the swing would lose the mob.
        if (ctx.me().attacking && want.castTime === 0) {
            if (want.spell.skillIndex !== undefined) await ctx.sdk.sendUseSkill(want.spell.skillIndex);
            else await ctx.sdk.sendCastSpell(want.spell.lineIndex, want.spell.spellIndex);
            return false;
        }
        const c = await ctx.bot.castSpell(want.spell);
        ctx.result('song', c);
        if (!c.success && c.reason === 'refused' && c.retryAfterMs) ctx.memory.set('songRetryAt', Date.now() + c.retryAfterMs);
        return true;
    },
});

/** A buff's walk and cast together: over this and the walk ends, as it is a turn the group's heals wait behind: 66 s of one toward a member who kept moving, with none (run 20261104-050639). A cast that has begun finishes. */
const BUFF_TURN_MS = 15_000;

/** What a follow-up's outcome takes to show, past its cast's end. */
const FOLLOW_UP_SHOWS_MS = 1000;

/** How long to leave a (buff, target) alone after a cast, by its outcome. */
export function buffRetryMs(c: { success: boolean; reason?: string; message?: string; retryAfterMs?: number; followUpMs?: number }): number {
    if (c.success) return 20_000;   // the effect shows up in the target's report within a few snapshots
    // The server holds it behind the cast still running, and it goes by itself: nothing failed. Until it has landed, and shows.
    if (c.followUpMs !== undefined) return (c.retryAfterMs ?? 0) + c.followUpMs + FOLLOW_UP_SHOWS_MS;
    if (/concentration/i.test(c.message ?? '')) return 300_000;
    // A mezz or a stun that broke it is an interrupt too, and reads as this since it names itself. While it lasts the next try is refused for free, and a mezz holds the turns anyway (MemberAgent.noteHeld).
    if (c.reason === 'out_of_range' || c.reason === 'interrupted' || c.reason === 'must_wait' || c.reason === 'crowd_controlled') return 8_000;
    return 60_000;
}

/**
 * While the group waits: keep the group's buffs up by plan (buffs.ts): every
 * member its own self buffs, the Bard/Warden base buffs, the Druid spec buffs,
 * most important first within the caster's concentration. A failed cast is
 * retried after a few seconds (minutes when concentration ran out); when the
 * pool is short, concentration buffs outside the plan are dropped first. A member more than gatherRadius beyond
 * the spell's range waits: holdFormation brings it back, or it is gone to its bind, and nothing here should go after it.
 */
export const buff = (): Behavior<TacticsSettings> => ({
    name: 'buff',
    interruptible: false,
    async run(ctx) {
        if (!QUIET_PHASES.has(ctx.orders().phase) || ctx.threats().length) return false;
        const me = ctx.me();
        const tasks = planBuffs(me.name, ctx.members(), { needs: ctx.settings.buffNeeds, selfOnly: ctx.settings.buffSelfOnly });
        if (!tasks.length) return false;
        const conc = { current: me.concentration ?? 0, max: me.maxConcentration ?? 0 };
        const retry: Map<string, number> = ctx.memory.get('buffRetry') ?? new Map();
        ctx.memory.set('buffRetry', retry);
        // Free concentration held by buffs another member should provide (or nobody needs).
        const drop = surplusConcentration(tasks, ctx.sdk.getState()?.concentrationEffects ?? [], conc, ctx.members())
            .find(d => Date.now() >= (retry.get(`drop:${d.name}:${d.ownerName}`) ?? 0));
        if (drop) {
            ctx.doing('buff', null, `drop ${drop.name} on ${drop.ownerName}`);
            const r = await ctx.sdk.sendRemoveConcentrationEffect(drop.index);
            const freed = r.success && await ctx.sdk.waitForCondition(s => (s.player?.concentration ?? 0) > conc.current, 3000).then(() => true).catch(() => false);
            retry.set(`drop:${drop.name}:${drop.ownerName}`, Date.now() + (freed ? 10_000 : 300_000));
            ctx.result('dropConc', freed ? r : { ...r, success: false, message: r.success ? 'concentration did not come back' : r.message });
            return true;
        }
        const book = new Map(ctx.spells.buffs().map(s => [s.spell.name, s]));
        const lowMana = me.maxMana > 0 && me.manaPercent < ctx.settings.buffMana;
        const reach = (ctx.settings as { gatherRadius?: number }).gatherRadius ?? DEFAULT_GATHER_RADIUS;
        const tooFar = (t: BuffTask, s: { range: number }) => {
            const m = t.target === me.name ? undefined : ctx.member(t.target);
            return !!m && (m.regionId !== me.regionId || dist(me, m) > s.range + reach);
        };
        const waiting = (t: BuffTask) => {
            const s = book.get(t.spell.name);
            // Timed buffs cost power; concentration buffs cost none.
            return !s || (Date.now() < (retry.get(`${t.spell.name}:${t.target}`) ?? 0)) || s.spell.cooldownRemaining > 0
                || (s.power > 0 && (lowMana || me.mana < s.power)) || tooFar(t, s);
        };
        const next = nextBuff(tasks, conc, waiting);
        if (!next) return false;
        const pick = book.get(next.spell.name)!;
        const target = ctx.member(next.target);
        const onOther = next.target !== me.name;
        ctx.doing('buff', target?.objectId ?? null, `${pick.spell.name} on ${next.target}`);
        const began = Date.now();
        const c = await until(() => Date.now() - began > BUFF_TURN_MS && !castRunning(ctx), () => ctx.bot.castSpell(pick.spell, pick.target === 'Realm' ? (onOther ? target?.objectId : me.objectId) : undefined))
            ?? { success: false, reason: 'timeout', message: `No cast of ${pick.spell.name} on ${next.target} in ${BUFF_TURN_MS / 1000} s` };
        retry.set(`${next.spell.name}:${next.target}`, Date.now() + buffRetryMs(c));
        ctx.result('buff', c, target?.objectId ?? null);
        return true;
    },
});

/**
 * While the group waits: near the carry limit (shedLoadAt % load), drop the heaviest
 * backpack item not matching keepItems, gear kept for later (gear-care.ts) only when nothing else
 * is left. Overloaded characters cannot move at all; selling needs a town visit, which leveling
 * strategies do not plan yet.
 */
export const shedLoad = (): Behavior<TacticsSettings> => ({
    name: 'shedLoad',
    interruptible: false,
    async run(ctx) {
        const limit = ctx.settings.shedLoadAt;
        const enc = ctx.me().encumbrance;
        if (!limit || !enc || enc.max <= 0 || 100 * enc.current / enc.max < limit) return false;
        const phase = ctx.orders().phase;
        if ((!QUIET_PHASES.has(phase) && phase !== 'travel') || ctx.threats().length) return ctx.skip('shedLoad: not now');
        const keep = new RegExp(ctx.settings.keepItems, 'i');
        const kept = (i: InventoryItem) => Number(keepForLater(i, ctx.me()));
        const item = ctx.sdk.getInventory().filter(i => !keep.test(i.name)).sort((a, b) => kept(a) - kept(b) || b.weight * b.count - a.weight * a.count)[0];
        if (!item) return ctx.skip('shedLoad: nothing droppable');
        ctx.doing('drop', null, item.name);
        const r = await ctx.bot.dropItem(item);
        ctx.result('drop', { ...r, message: `${item.name} (load ${Math.round(100 * enc.current / enc.max)}%)` });
        return true;
    },
});

/**
 * A melee on the role lists: it joins at once, since holdMs is the wait for casters, whose nukes draw the mob
 * further than a swing does. The Warden's idle time in fights went from 19-25 % to 1 % with hold 0 (groups
 * of two, not alternated).
 */
export const meleeFight = () => assist({ melee: true, holdMs: 0, style: fighterStyle() });

/** The behaviour lists the default strategies use, by role. */
export function defaultBehaviors(): Record<Role, Behavior<TacticsSettings>[]> {
    return {
        tank: [release(), hand(), healer(), sprint(), retreat(), rez(), pull(), tank(), guard(), shedLoad(), holdFormation(), buff(), rest()],
        healer: [release(), healer(), sprint(), retreat(), heal({ emergencyOnly: true }), flee(), rez(), heal(), crowdControl({ assignedOnly: true }), position(), shedLoad(), holdFormation(), buff(), rest()],
        support: [release(), healer(), sprint(), retreat(), heal({ emergencyOnly: true }), flee(), rez(), crowdControl(), heal(), song(), position(), shedLoad(), holdFormation(), buff(), rest()],
        nuker: [release(), healer(), sprint(), retreat(), flee(), rez(), crowdControl({ assignedOnly: true }), heal({ emergencyOnly: true }), position(), assist(), shedLoad(), holdFormation(), buff(), rest()],
        melee: [release(), hand(), healer(), sprint(), retreat(), rez(), song(), meleeFight(), shedLoad(), holdFormation(), buff(), rest()],
    };
}

