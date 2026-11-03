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
import { ANYTIME_STYLE, fighterStyle, tankStyles } from './styles';
import { abortable, executionContext } from '../execution-context';
import { isAlive } from './blackboard';
import { clearOf, keepDangers, type KeepSettings } from './keeps';
import { type BuffTask, nextBuff, planBuffs, surplusConcentration } from './buffs';
import { combatSpot, dangerStops, effectiveLimits, focusSettled, safeSpot, trackFocus } from './positioning';
import { dotFamily } from './spells';
import { keepForLater } from './gear-care';
import { chooseSong, SONG_SETTINGS, type SongSettings } from './songs';
import type { Behavior, MemberContext } from './member';
import { safePath } from './terrain';
import type { BotWorldState, InventoryItem, NearbyNpc, NearbyPlayer, PlayerState, Style } from '../types';
import type { BuffSlot, Contact, Point, Role } from './types';

/** Settings the behaviours read; strategies extend this. */
export interface TacticsSettings {
    /** How far a member walks to a healer for lost constitution or sickness (default 4000). */
    healerRadius?: number;
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

/** The circles round the keeps whose guards attack us, here (none outside a battleground). */
function keepCircles(ctx: MemberContext<TacticsSettings>) {
    const me = ctx.me();
    return keepDangers(me.regionId, me.realm, ctx.settings as Partial<KeepSettings>);
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const QUIET_PHASES = new Set(['recover', 'gather', 'idle']);
/** During a fight, holdFormation walks a member back to the anchor only from farther than this (tank and melee: the chase leash, if shorter). */
const FIGHT_REJOIN = 3000;
/** A member walking back to a fight it stands beyond the leash of goes in legs this long, so its fight behaviours get a turn on the way. */
const LEASH_REJOIN_LEG = 1000;
/** An enemy player this close to a member can be hitting it in melee (melee range plus position lag). */
const MELEE_REACH = 400;
/** A target that answered "Your target is immune to this effect!" stays so this long (IMMUNITY_TIMER_FLAT_LENGTH, NpcImmunityEffect). */
const CC_IMMUNE_MS = 60_000;

/**
 * Whether `t` is on member `m` the way an add is: it targets `m` and isn't crowd-controlled, and an
 * enemy player also stands in melee reach. A player's target is inferred from its latest swing or
 * hostile spell (observeState), so a caster nuking `m` from 1500 targets it too; but players have no
 * aggro table, so running to the tank or a taunt doesn't take that one off. flee() drew casters into
 * the melee with every nuke on them. A monster targeting `m` by its spell alone is the same for flee(),
 * though a taunt does take it off: peelTarget counts it wherever it stands.
 */
export function onMember(t: Contact, m: Point & { name: string }): boolean {
    return t.target === m.name && !t.cc && ((t.kind !== 'player' && !t.targetBySpell) || dist(t, m) <= MELEE_REACH);
}

const alive = isAlive;

/** Not under a crowd-control assignment, or under one for longer than peelAfterMs (the mezz didn't land). */
function uncontrolled(ctx: MemberContext<TacticsSettings>, t: Contact, now: number): boolean {
    return !ctx.orders().cc.some(a => a.targetId === t.objectId) || now - t.hostileSince > ctx.settings.peelAfterMs;
}

/** A foe as our own client sees it now: a monster or an enemy player; null when it is out of our view. */
export function foeInView(ctx: MemberContext, id: number): NearbyNpc | NearbyPlayer | null {
    return ctx.sdk.getNearbyNpc(id) ?? ctx.sdk.getNearbyPlayer(id);
}

/** Dead in our own client: a player by its dead flag or death event only (see alive), a monster at 0 %. */
const isDown = (f: NearbyNpc | NearbyPlayer) => (f.kind === 'player' ? f.isDead : f.healthPercent <= 0);

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

async function stopSwinging(ctx: MemberContext): Promise<void> {
    if (ctx.me().attacking) await ctx.sdk.sendAttack(false);
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
function claimedBy(ctx: MemberContext, kind: string, targetId: number, withinMs: number): string[] {
    const now = Date.now();
    return ctx.members().filter(m => m.name !== ctx.name && m.activity.kind === kind && m.activity.targetId === targetId && now - m.activity.since < withinMs).map(m => m.name);
}

/** Our slot around `anchor`: `back` units away from `facing`, roles fanned out by angle, same-role members on alternating sides. */
export function formationSlot(ctx: MemberContext<TacticsSettings>, anchor: Point, facing: Point | null): Point {
    const same = ctx.members().filter(m => m.role === ctx.role).map(m => m.name);
    const away = facing && dist(anchor, facing) > 1 ? Math.atan2(anchor.y - facing.y, anchor.x - facing.x) : 0;
    const o = formationOffset(ctx.settings.formation, ctx.role, Math.max(0, same.indexOf(ctx.name)), away);
    return { x: Math.round(anchor.x + o.x), y: Math.round(anchor.y + o.y) };
}

/** Offset of the `index`-th member of `role` from the anchor, with `away` the angle from the facing point to the anchor. */
export function formationOffset(formation: TacticsSettings['formation'], role: Role, index: number, away: number): Point {
    const f = formation[role] ?? { back: 200, angle: 0 };
    const spread = f.angle || (index ? 0.4 : 0);
    const angle = spread * (index % 2 ? -1 : 1) * (1 + Math.floor(index / 2) * 0.6);
    return { x: Math.cos(away + angle) * f.back, y: Math.sin(away + angle) * f.back };
}

/** Dead: release and respawn at the bind point (holdFormation walks back). */
export const release = (): Behavior => ({
    name: 'release',
    interruptible: false,
    async run(ctx) {
        if (!ctx.bot.isDead()) return false;
        ctx.doing('release');
        ctx.result('release', await ctx.bot.releaseAndRespawn());
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
        const sick = (ctx.sdk.getState()?.effects ?? []).some(e => /Resurrection Illness/i.test(e.name));
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

/**
 * Not the tank and a monster is on us, or an enemy player in melee reach (onMember): run to the tank
 * so it can take it back (peelTarget). A player nuking us from range is left to crowd control and the focus.
 */
export const flee = (): Behavior => ({
    name: 'flee',
    async run(ctx) {
        if (ctx.isTank()) return false;
        const tank = ctx.tank();
        const me = ctx.me();
        if (!tank || !ctx.threats().some(t => onMember(t, me))) return false;
        if (dist(me, tank) < 150) return ctx.skip('attacked, already at the tank');
        await stopSwinging(ctx);
        ctx.doing('flee', null, `to ${tank.name}`);
        await ctx.bot.walkTo(tank.x, tank.y, { z: tank.z, tolerance: 60, timeout: 6000 });
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
        if (!sp) return ctx.skip('heal: not enough power');
        await stopSwinging(ctx);
        ctx.doing('heal', hurt.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, hurt.objectId);
        ctx.result('heal', c, hurt.objectId);
        if (!(await waitOutSelfCc(c)) && !c.success && c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
        return true;
    },
});

/**
 * Mezz (or, without a mezz, root) our crowd-control assignment; without `assignedOnly`,
 * also any add (not the focus) attacking the group that nobody controls or is mezzing yet.
 */
export const crowdControl = (opts: { assignedOnly?: boolean } = {}): Behavior<TacticsSettings> => ({
    name: 'crowdControl',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' && o.phase !== 'pull' && o.phase !== 'retreat') return false;
        // Targets that answered "Your target is immune to this effect!", by ckey: left alone for CC_IMMUNE_MS.
        const immune: Map<string, number> = ctx.memory.get('ccImmune') ?? new Map();
        ctx.memory.set('ccImmune', immune);
        for (const [k, until] of immune) if (until <= Date.now()) immune.delete(k);
        // Also what another member found immune (the board's mark).
        const immuneNow = (c: Contact) => immune.has(ckey(c)) || (c.ccImmuneUntil ?? 0) > Date.now();
        const live = (id: number) => { const c = ctx.contact(id); return c && !c.stale && alive(c) && !c.cc && !immuneNow(c) ? c : undefined; };
        const assigned = o.cc.filter(a => a.by === ctx.name).map(a => live(a.targetId)).filter(c => !!c);
        const extra = opts.assignedOnly ? [] : ctx.threats()
            .filter(t => t.objectId !== o.focus && !t.cc && !immuneNow(t) && !o.cc.some(a => a.targetId === t.objectId) && !claimedBy(ctx, 'cc', t.objectId, 4000).length);
        // Others see some, we don't (an assignment while we walk back from a release): the first we can cast on.
        const visible = (c: Contact) => !!foeInView(ctx, c.objectId);
        const target = assigned.find(visible) ?? extra.find(visible);
        if (!target) return assigned.length || extra.length ? ctx.skip('cc: target not in view') : false;
        const sp = ctx.spells.cc({ aoe: ctx.settings.aoe });
        if (!sp) return ctx.skip('cc: no mezz or root ready');
        await stopSwinging(ctx);
        ctx.doing('cc', target.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId);
        ctx.result('cc', c, target.objectId);
        // The cast went off, but the target is already mezzed or still immune from the last one (a player for 60 s
        // after a mezz ends, a mob after repeated ones: CCSpellHandler.CheckSpellResist): not controlled, and
        // recasting on it would only repeat that.
        if (c.effectImmune) {
            immune.set(ckey(target), Date.now() + CC_IMMUNE_MS);
            // The coordinator would otherwise hand it to the next mezzer every few seconds. Only a mezz's: the
            // server keeps mezz and snare immunity apart (EffectHelper.GetImmunityEffectFromSpell), so a root's
            // "immune" says nothing about the mezzers' chances, and it stays in our own memory.
            if (sp.kind === 'mezz') ctx.markCcImmune(target.objectId, CC_IMMUNE_MS);
        }
        else if (c.success && !c.resisted) ctx.markCc(target.objectId, sp.kind, Math.max(3000, sp.duration * 900));
        else if (await waitOutSelfCc(c)) return true;
        // PvP immunity (reason 'immune': up to 10 s after a port, login or release) and "You must wait": try again shortly.
        else if (c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
        // The spell list's power cost can trail the server's ("You don't have enough power"): don't retry every turn.
        else if (c.reason === 'no_power') await Bun.sleep(2000);
        return true;
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
            await ctx.bot.walkTo(o.anchor.x, o.anchor.y, { tolerance: 80, timeout: 20_000 });
            return true;
        }
        if (!ctx.sdk.getNearbyNpc(mob.objectId)) {
            ctx.doing('pull', mob.objectId, 'to its last position');
            await ctx.bot.walkTo(mob.x, mob.y, { z: mob.z, tolerance: 300, timeout: 20_000 });
            return true;
        }
        ctx.doing('pull', mob.objectId, mob.name);
        const a = await ctx.bot.attack(mob.objectId, { timeout: 15_000 });
        ctx.result('pull', a, mob.objectId);
        if (!a.success) return true;
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
 * Run `work` until it settles or `stop()` turns true (checked every 500 ms): null when stopped.
 * Waits for the work's own cleanup (killNpc turns melee off) before returning. A parent
 * cancellation still throws.
 */
async function until<T>(stop: () => boolean, work: () => Promise<T>): Promise<T | null> {
    const parent = executionContext.getStore();
    const controller = new AbortController();
    const stopped = new Error('Stopped');
    const abort = () => controller.abort(parent?.signal.reason);
    parent?.signal.addEventListener('abort', abort, { once: true });
    const timer = setInterval(() => { if (stop()) controller.abort(stopped); }, 500);
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
 */
export function peelTarget(ctx: MemberContext<TacticsSettings>): Contact | null {
    const o = ctx.orders();
    const now = Date.now();
    const soft = new Map(ctx.members().filter(m => !m.isDead && m.role !== 'tank' && m.role !== 'melee').map(m => [m.name, m]));
    return ctx.threats()
        .filter(t => t.objectId !== o.focus && !t.stale && alive(t) && t.target !== null && soft.has(t.target) && (onMember(t, soft.get(t.target)!) || (t.kind === 'npc' && t.targetBySpell && !t.cc)) && !beyondLeash(ctx, t))
        .filter(t => uncontrolled(ctx, t, now))
        .sort((a, b) => a.hostileSince - b.hostileSince)[0] ?? null;
}

/**
 * Tank and melee while the focus stands beyond the chase leash: the nearest enemy fighting the group
 * inside it that nobody controls (a mezz ordered on it gets peelAfterMs, as for a peel), monsters too.
 * Null without a leash or without such an enemy: then they let the focus go, and holdFormation walks
 * them back from beyond the leash. decideRvr engages up to engageRadius + 1000 from the centre, so
 * a focus beyond the leash is common at first contact.
 */
export function leashFallback(ctx: MemberContext<TacticsSettings>): Contact | null {
    const leash = ctx.settings.chaseLeash;
    const o = ctx.orders();
    const anchor = o.anchor;
    if (leash === undefined || !anchor) return null;
    const me = ctx.me();
    const now = Date.now();
    return ctx.threats()
        .filter(t => t.objectId !== o.focus && !t.cc && !t.stale && alive(t) && dist(t, anchor) <= leash && uncontrolled(ctx, t, now))
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
            ctx.doing('move', mob.objectId, add ? `to the add on ${add.target}` : stand ? 'to the nearest enemy inside the leash' : 'to the focus');
            await ctx.bot.walkTo(mob.x, mob.y, { z: mob.z, tolerance: 200, timeout: 10_000 });
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
            // Let it go the moment it runs beyond the leash, measured from the anchor every 500 ms. The chase
            // limit counts from where WE started, so it stays a wide backstop: capped at the leash, a focus
            // inside the leash of a moved anchor but 2000+ from us failed out_of_reach before the first step.
            const gone = () => { const c = ctx.contact(mob.objectId); return !!c && beyondLeash(ctx, c); };
            const k = await until(add ? () => held() || gone() : () => peelTarget(ctx) !== null || gone() || focusBack(),
                () => ctx.bot.killPlayer(mob.objectId, { useStyle: seen => opts.style ? opts.style(seen) : damage, timeout: add || stand ? 20_000 : 90_000, maxChaseDistance: 3000 + (ctx.settings.chaseLeash ?? 0) }));
            if (k) ctx.result('kill', k, mob.objectId);
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
            const k = await until(held, () => ctx.bot.killNpc(add.objectId, { force: true, useStyle, timeout: 20_000, maxChaseDistance: 3000 }));
            if (k) ctx.result('kill', k, add.objectId);
            await waitOutSelfCc(k);
            return true;
        }
        ctx.doing('melee', mob.objectId, 'tank');
        const k = await until(() => peelTarget(ctx) !== null || focusBack(), () => ctx.bot.killNpc(mob.objectId, { force: true, useStyle, timeout: 90_000, maxChaseDistance: 3000 }));
        if (k) ctx.result('kill', k, mob.objectId);
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
            // The effect shows a snapshot after the server applies it: don't toggle it off again meanwhile.
            if (Date.now() - (ctx.memory.get(`${ability}At`) ?? 0) < 10_000) continue;
            ctx.memory.set(`${ability}At`, Date.now());
            await stopSwinging(ctx);
            await ctx.sdk.sendSetTarget(m.objectId);
            ctx.doing('guard', null, `${ability} ${m.name}`);
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
 */
export function holdState(mob: Pick<Contact, 'target' | 'targetSince' | 'movedAt' | 'engagedAt' | 'hostileSince'>, tankName: string | null, holdMs: number, assistAfterMs: number, now: number): { held: boolean; dueAt: number } {
    if (!tankName) return { held: true, dueAt: now };
    // A carried mob keeps its last target (and so stays hostile) all the way home: both clocks start at the engage order.
    const floor = (t: number) => (mob.movedAt > 0 ? Math.max(t, mob.engagedAt || now) : t);
    const dueAt = Math.min(mob.target === tankName ? floor(mob.targetSince) + holdMs : Infinity, mob.hostileSince > 0 ? floor(mob.hostileSince) + assistAfterMs : Infinity);
    return { held: now >= dueAt, dueAt };
}

/**
 * Damage dealer: once the tank has held the focus (holdState, holdMs or opts.holdMs; a holdMs of 0
 * doesn't wait at all), nuke it (the best DoT family once, then direct damage), or melee with `melee`.
 * Never touches crowd-controlled mobs.
 * Melee leaves a focus beyond the chase leash for the nearest enemy inside it (leashFallback).
 * `style` picks the styles of its melee (fighterStyle, or a character's own); without one it swings plain.
 */
export const assist = (opts: { melee?: boolean; holdMs?: number; style?: StylePick } = {}): Behavior<TacticsSettings> => ({
    name: opts.melee ? 'assistMelee' : 'assist',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage' || o.focus === null) return false;
        const focus = ctx.focus();
        if (!focus || !alive(focus)) return ctx.skip('assist: focus unknown');
        if (focus.cc) return ctx.skip('assist: focus is crowd-controlled');
        const mob = opts.melee && beyondLeash(ctx, focus) ? leashFallback(ctx) : focus;
        if (!mob) return ctx.skip('assist: focus beyond the chase leash, no enemy inside it');
        // The picture can trail a death by a snapshot; our own client knows first.
        const seen = foeInView(ctx, mob.objectId);
        if (seen && isDown(seen)) return ctx.skip('assist: focus just died');
        if (!seen) {
            // Others see it, we don't (beyond our view): close in on where the group last saw it.
            const me0 = ctx.me();
            const d = dist(me0, mob);
            const stop = (ctx.settings.combatRange[ctx.role]?.[1] ?? 1400) - 200;
            if (d <= stop) return ctx.skip('assist: focus not in view');
            const f = (d - stop) / d;
            ctx.doing('move', mob.objectId, 'toward the focus');
            await ctx.bot.walkTo(me0.x + (mob.x - me0.x) * f, me0.y + (mob.y - me0.y) * f, { tolerance: 100, timeout: 6000 });
            return true;
        }
        const tankM = ctx.tank();
        const now = Date.now();
        // An enemy player is never "held" by a tank (players have no aggro table): hit it at once.
        const { held } = mob.kind === 'player' || opts.holdMs === 0 ? { held: true } : holdState(mob, tankM?.name ?? null, opts.holdMs ?? ctx.settings.holdMs, ctx.settings.assistAfterMs, now);
        if (!held) return ctx.skip('assist: waiting for the tank to hold it');
        const me = ctx.me();
        if (!opts.melee) {
            // DoT families already on this mob, kept per mob (object ids are reused at once).
            const key = `dotted:${ckey(mob)}`;
            const live = new Set(ctx.picture().contacts.map(c => `dotted:${ckey(c)}`));
            for (const k of [...ctx.memory.keys()]) if (k.startsWith('dotted:') && !live.has(k)) ctx.memory.delete(k);
            const dotted: Set<string> = ctx.memory.get(key) ?? new Set();
            const sp = ctx.spells.nuke({ dotted, targetHp: mob.hp, aoe: ctx.settings.aoe });
            if (sp) {
                await stopSwinging(ctx);
                ctx.doing('nuke', mob.objectId, sp.spell.name);
                const c = await ctx.bot.castSpell(sp.spell, mob.objectId);
                ctx.result('nuke', c, mob.objectId);
                if (sp.type === 'DamageOverTime' && (c.success || /already has that effect/i.test(c.message ?? ''))) { dotted.add(dotFamily(sp)); ctx.memory.set(key, dotted); }
                if (await waitOutSelfCc(c)) return true;
                if (!c.success && c.retryAfterMs) await Bun.sleep(Math.min(c.retryAfterMs, 3000));
                else if (c.reason === 'no_power') await Bun.sleep(2000);
                return true;
            }
            if (!ctx.settings.meleeWhenOom || me.maxMana === 0) return ctx.skip('assist: no power');
        }
        const live = foeInView(ctx, mob.objectId);
        ctx.doing('melee', mob.objectId);
        if (!me.attacking || me.targetObjectId !== mob.objectId || !live || live.distance > 150) {
            const a = await ctx.bot.attack(mob.objectId, { timeout: 8000 });
            if (!a.success) ctx.result('melee', a, mob.objectId);
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
            min, max, safe: safeSpot(me.regionId, me.level, ctx.settings.aggroTolerance ?? -3),
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
        let to: Point = slot;
        const leg = o.phase === 'engage' && fromAnchor < FIGHT_REJOIN ? LEASH_REJOIN_LEG : 2500;
        if (d > leg) {
            // Back from a release across a battleground: round the enemy keeps' guards too.
            const path = safePath(me.regionId, me.level, me, slot, keepCircles(ctx));
            const next = path[0] ?? slot;
            const f = Math.min(1, leg / dist(me, next));
            to = { x: me.x + (next.x - me.x) * f, y: me.y + (next.y - me.y) * f };
        }
        ctx.doing('move', null, o.phase);
        const w = await ctx.bot.walkTo(to.x, to.y, { tolerance: 80 });
        if (!w.success) { ctx.result('walk', w); await Bun.sleep(500); }
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
    return !(o.dSlot < o.slack && o.dAnchor < (o.gatherRadius ?? 1200) - 100 && o.safe);
}

/** While the group waits: sit until rest.hp / rest.mana. */
export const rest = (): Behavior<TacticsSettings> => ({
    name: 'rest',
    async run(ctx) {
        if (!QUIET_PHASES.has(ctx.orders().phase) || ctx.threats().length) return false;
        const me = ctx.me();
        const r = ctx.settings.rest;
        const caster = me.maxMana > 0;
        if (me.healthPercent >= r.hp && (!caster || me.manaPercent >= r.mana)) return false;
        // rest() refuses while any NPC in view targets us, even one leashing home far away.
        const on = ctx.bot.getAttackers()[0] ?? ctx.bot.getPlayerAttackers()[0];
        if (on) return ctx.skip(`rest: ${on.name} targets us (${Math.round(on.distance)} away)`);
        ctx.doing('rest');
        const res = await ctx.bot.rest({ healthPercent: r.hp, manaPercent: caster ? r.mana : undefined, timeout: 120_000 });
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
        const kind = chooseSong(songs.map(s => s.kind), ctx.orders().phase, ctx.members(), ctx.settings.songs ?? SONG_SETTINGS);
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
        ctx.result('song', await ctx.bot.castSpell(want.spell));
        return true;
    },
});

/** How long to leave a (buff, target) alone after a cast, by its outcome. */
function buffRetryMs(c: { success: boolean; reason?: string; message?: string }): number {
    if (c.success) return 20_000;   // the effect shows up in the target's report within a few snapshots
    if (/concentration/i.test(c.message ?? '')) return 300_000;
    if (c.reason === 'out_of_range' || c.reason === 'interrupted' || c.reason === 'must_wait') return 8_000;
    return 60_000;
}

/**
 * While the group waits: keep the group's buffs up by plan (buffs.ts): every
 * member its own self buffs, the Bard/Warden base buffs, the Druid spec buffs,
 * most important first within the caster's concentration. A failed cast is
 * retried after a few seconds (minutes when concentration ran out); when the
 * pool is short, concentration buffs outside the plan are dropped first.
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
        const waiting = (t: BuffTask) => {
            const s = book.get(t.spell.name);
            // Timed buffs cost power; concentration buffs cost none.
            return !s || (Date.now() < (retry.get(`${t.spell.name}:${t.target}`) ?? 0)) || s.spell.cooldownRemaining > 0
                || (s.power > 0 && (lowMana || me.mana < s.power));
        };
        const next = nextBuff(tasks, conc, waiting);
        if (!next) return false;
        const pick = book.get(next.spell.name)!;
        const target = ctx.member(next.target);
        const onOther = next.target !== me.name;
        ctx.doing('buff', target?.objectId ?? null, `${pick.spell.name} on ${next.target}`);
        const c = await ctx.bot.castSpell(pick.spell, pick.target === 'Realm' ? (onOther ? target?.objectId : me.objectId) : undefined);
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
        tank: [release(), healer(), sprint(), retreat(), pull(), tank(), guard(), shedLoad(), holdFormation(), buff(), rest()],
        healer: [release(), healer(), sprint(), retreat(), heal({ emergencyOnly: true }), flee(), heal(), crowdControl({ assignedOnly: true }), position(), shedLoad(), holdFormation(), buff(), rest()],
        support: [release(), healer(), sprint(), retreat(), heal({ emergencyOnly: true }), flee(), crowdControl(), heal(), song(), position(), shedLoad(), holdFormation(), buff(), rest()],
        nuker: [release(), healer(), sprint(), retreat(), flee(), crowdControl({ assignedOnly: true }), heal({ emergencyOnly: true }), position(), assist(), shedLoad(), holdFormation(), buff(), rest()],
        melee: [release(), healer(), sprint(), retreat(), song(), meleeFight(), shedLoad(), holdFormation(), buff(), rest()],
    };
}

