// The standard Mentalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list
// already picks nukes, heals, mezzes and buffs from whatever the bot knows. What is the class's own is Prismatic
// Flash (Light, stun, 2.5 s, range 1500, 5 s): `stunCaster` throws it at an enemy player casting at or swinging at our
// Bard or Druid, then at one casting at any of us, then at a casting healer. Spec points aren't here: they are the character's
// bots/<bot>/build.ts, copied from data/builds/mentalist.ts. learnings/classes/mentalist.md says why.

import { foeInView, hammeredBy, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import { nukerFight, QUICKCAST_REUSE_MS, quickcastUnderFire } from './cabalist';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import type { Contact, MemberReport, Role } from '../group/types';
import { wallStep } from './healer-stand';
import { unlessAimedAt } from './druid';
import { selfBuffDue } from './paladin';
import { modifiedSpec } from '../actions';
import { petControl, petsAllowed } from '../group/pets';
import type { NearbyNpc } from '../types';
import { conLevel } from '../actions-helpers';
import { aggroAt, factionAt } from '../group/terrain';
import { segDist } from '../group/baseplan';
import type { Point } from '../group/types';

export interface MentalistKit {
    character: Character;
}

/** A cast seen this recently is one under way, or the caster's next. */
const CASTING_MS = 2500;
/** A stun's length plus the player's 60 s immunity after it (immunity_timer_flat_length, CrowdControlECSEffect.cs:20). */
const STUN_IMMUNE_MS = 60_000;
/**
 * The server measures a spell's range in 3D, at the cast's end: a foe at the edge by our view, or one walking off during
 * the 2.5 s cast, is out of it (round 9: 1 stun:out_of_range at a margin of 0, round 20: 2 of 5 at 60). castSpell's own
 * walk into range stops 10 % of the range inside, at most 150 (actions.ts castSpell).
 */
const RANGE_MARGIN = 150;
/** How long the server's "too far" at a target holds, unless our view puts it TOO_FAR_CLOSER nearer than then. */
const TOO_FAR_MS = 10_000;
const TOO_FAR_CLOSER = 200;
/** Where the server last said "That target is too far away!", by target id: our view's distance then, and when. */
export type TooFar = Map<number, { at: number; d: number }>;

/**
 * Our view's distance to a target, or Infinity while the server's last "too far" at it holds (arena round 35: Niamh's Flash
 * 18 and Ciaran's debuffs 42 times out of range, each retried at once, with our view saying in range throughout).
 */
export function viewDistance(log: TooFar, id: number, d: number, now: number): number {
    const t = log.get(id);
    if (!t) return d;
    if (now - t.at > TOO_FAR_MS || d < t.d - TOO_FAR_CLOSER) { log.delete(id); return d; }
    return Infinity;
}

/** Record a cast's "too far" at a target, at our view's distance then. "You can't see your target" the same: castSpell
 * already looked for a step into sight, and the next try from here would be refused again (Lugh's stun 13 times, 16:34). */
export function noteTooFar(log: TooFar, id: number, reason: string | undefined, d: number, now: number): void {
    if (reason === 'out_of_range' || reason === 'not_visible') log.set(id, { at: now, d });
}

/** The member's own TooFar, shared by its kit's behaviours (the server's range is the same truth for each). */
export const tooFarOf = (memory: Map<string, any>): TooFar => { let t = memory.get('tooFar'); if (!t) memory.set('tooFar', t = new Map()); return t; };

/** Who it saves first: the roles that hold the group up, then anyone, then a healer of theirs at work. */
const SAVE_FIRST: readonly Role[] = ['support', 'healer'];

/**
 * The player to stun: within `range` less a margin by `distanceTo` (our view's 3D distance; Infinity when out of view),
 * not crowd-controlled, not stun-immune by the board. First one casting at or swinging at our support or healer (round 13:
 * Midgard's melee dove Oisin and killed him in 11 s, then Brigid), then one casting at any member, then a casting healer of
 * theirs; the nearest of each.
 */
export function stunTarget(contacts: readonly Contact[], members: readonly Pick<MemberReport, 'name' | 'role'>[], regionId: number, distanceTo: (c: Contact) => number, range: number, now: number): Contact | null {
    const roleOf = new Map(members.map(m => [m.name, m.role]));
    const casting = (c: Contact) => now - (c.castingAt ?? -Infinity) <= CASTING_MS;
    const rank = (c: Contact) => {
        const on = c.target ? roleOf.get(c.target) : undefined;
        const spell = !!c.targetBySpell && casting(c);
        const swing = !c.targetBySpell && c.swinging;
        if (on && SAVE_FIRST.includes(on) && (spell || swing)) return 0;
        if (on && spell) return 1;
        return c.healer && casting(c) ? 2 : 3;
    };
    const d = (c: Contact) => distanceTo(c);
    return contacts
        .filter(c => c.kind === 'player' && !c.stale && c.regionId === regionId && !c.cc && (c.ccImmune?.stun ?? 0) <= now
            && d(c) <= range - RANGE_MARGIN && rank(c) < 3)
        .sort((a, b) => rank(a) - rank(b) || d(a) - d(b))[0] ?? null;
}

/**
 * The single-target stun to cast: the highest rank that is ready and, given `mana`, paid for. Both the Mentalist and the
 * Eldritch know Prismatic Flare (Light 5, a 3 s stun, 4 power) and Prismatic Flash (Light 15, 5 s, 9 power) on the same line;
 * the book lists Flare first, and a plain find took it (2026-11-10 night: Lugh "Died while casting Prismatic Flare").
 */
export function bestStun<T extends Pick<SpellPick, 'type' | 'target' | 'radius' | 'power'> & { spell: { level: number; cooldownRemaining: number } }>(all: readonly T[], mana = Infinity): T | null {
    return all.filter(s => s.type === 'Stun' && s.target === 'Enemy' && s.radius === 0 && s.power <= mana && s.spell.cooldownRemaining <= 0)
        .sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;
}

/**
 * Prismatic Flash at stunTarget, in a fight, above `floor` % power. A stun ends a cast at once (OnHardCCStart). It is
 * marked on the board as stun immunity only, not as crowd control, so the group keeps hitting what it stunned.
 */
export const stunCaster = (floor = 15): Behavior => ({
    name: 'stunCaster',
    interruptible: false,
    async run(ctx) {
        if (ctx.orders().phase !== 'engage') return false;
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < floor) return false;
        const sp = bestStun(ctx.spells.all(), me.mana);
        if (!sp) return false;
        // A melee on her would only interrupt the 2.5 s cast: flee's (quickFlash's, with Quickcast). An enemy pet too
        // (round 105: Albion's pets on her, stun:interrupted); hammeredBy counts players only.
        if (hammeredBy(ctx) || petOnMe(ctx.threats(), me.name)) return false;
        const self = ctx.members().find(m => m.name === me.name);
        const far = tooFarOf(ctx.memory);
        const raw = (c: Contact) => { const v = foeInView(ctx, c.objectId); return !v || ('isDead' in v && v.isDead) ? Infinity : v.distance; };
        const seen = (c: Contact) => viewDistance(far, c.objectId, raw(c), Date.now());
        const foe = stunTarget(ctx.picture().contacts, ctx.members(), self?.regionId ?? me.regionId, seen, sp.range, Date.now());
        if (!foe) return false;
        ctx.doing('stun', foe.objectId, `${sp.spell.name}${foe.target ? `, casting at ${foe.target}` : ''}`);
        const c = await ctx.bot.castSpell(sp.spell, foe.objectId, { approach: false });
        ctx.result('stun', c, foe.objectId);
        noteTooFar(far, foe.objectId, c.reason, raw(foe), Date.now());
        if (c.success) ctx.markCcImmune(foe.objectId, 'stun', sp.duration * 1000 + STUN_IMMUNE_MS);
        else if (c.reason === 'immune') ctx.markCcImmune(foe.objectId, 'stun', STUN_IMMUNE_MS);
        return true;
    },
});

/** offFocus (the Cabalist kit's): nukes on a free enemy in reach while the focus is out of it. Arena round 10: Niamh 1 nuke in a 79 s wipe. */
/**
 * In the instant slot: with a melee on her, Quickcast and Prismatic Flash on that melee, a 5 s stun that can't be
 * interrupted, and flee walks her off it. Arena round 15: dived 51 % of the fight, 4 nukes, nothing to answer with
 * (Flash 2.5 s, Cripple Mind 3 s). Shares quickcastUnderFire's 31 s timer (memory 'quickcastReadyAt'), which comes next
 * for when the Flash can't go (stun-immune, out of reach): her nuke on the focus.
 */
/** An enemy pet swinging at us (not a spell: Contact.targetBySpell), not crowd-controlled. */
export function petOnMe(threats: readonly Contact[], name: string): Contact | undefined {
    return threats.find(t => !!t.isPet && !t.stale && !t.cc && t.target === name && !t.targetBySpell && t.swinging);
}

export const quickFlash = (): Behavior => ({
    name: 'quickFlash',
    interruptible: false,
    async run(ctx) {
        if (ctx.orders().phase !== 'engage') return false;
        const now = Date.now();
        if (now < (ctx.memory.get('quickcastReadyAt') ?? 0) || !ctx.sdk.findAbility('Quickcast')) return false;
        const me = ctx.me();
        // hammeredBy takes players only; an enemy pet swinging at her (Midgard's spirit warrior, round 39) interrupts as well.
        const foe = hammeredBy(ctx) ?? petOnMe(ctx.threats(), me.name);
        if (!foe || foe.cc || (foe.ccImmune?.stun ?? 0) > now) return false;
        const sp = bestStun(ctx.spells.all());
        if (!sp || me.mana < 2 * ctx.spells.powerOf(sp)) return false;
        const view = foeInView(ctx, foe.objectId);
        const far = tooFarOf(ctx.memory);
        if (!view || ('isDead' in view && view.isDead) || viewDistance(far, foe.objectId, view.distance, now) > sp.range - RANGE_MARGIN) return false;
        ctx.memory.set('quickcastReadyAt', now + QUICKCAST_REUSE_MS);
        const q = await ctx.bot.useAbility('Quickcast');
        ctx.result('quickcast', q);
        if (!q.success) return true;
        ctx.doing('stun', foe.objectId, `${sp.spell.name} (quickcast, on the melee at her)`);
        const c = await ctx.bot.castSpell(sp.spell, foe.objectId, { approach: false });
        ctx.result('stun', c, foe.objectId);
        noteTooFar(far, foe.objectId, c.reason, view.distance, Date.now());
        if (c.success) ctx.markCcImmune(foe.objectId, 'stun', sp.duration * 1000 + STUN_IMMUNE_MS);
        else if (c.reason === 'immune') ctx.markCcImmune(foe.objectId, 'stun', STUN_IMMUNE_MS);
        return true;
    },
});

/**
 * The role's assist, then offFocus (the Cabalist kit's nukerFight). Rounds 64 and 66 tried the Spiritmaster kit's
 * steppingAssist here and reverted it: its step is 250 (750 after 4 s), shorter than Hibernia's standStep of 900, so the
 * casters stepped in less, not more (Ciaran 2-3 nukes, "focus out of reach, holding ground" 13-14 turns).
 */
export function casterFight(withOffFocus = true): Behavior<TacticsSettings>[] {
    return nukerFight(0, withOffFocus);
}

/** A failed bladeturn cast is left this long. */
const BLADETURN_RETRY_MS = 20_000;

/**
 * Barrier of Negation (Mind 19, a self bladeturn: the next blow does nothing) back up as soon as it pops, in a fight too, as the
 * user kept it playing Niamh (11 recasts in 52 min, 2026-11-13; play/niamh-1113-findings.md). buff() keeps it only in the quiet
 * phases. In a fight below the fight's own work (chores), never with a melee on her (the 4 s cast would only be interrupted),
 * and only while no enemy aims at her (unlessAimedAt).
 */
export const bladeturnUp = (): Behavior<TacticsSettings> => unlessAimedAt({
    name: 'bladeturnUp',
    interruptible: false,
    async run(ctx) {
        if (ctx.bot.isDead() || ctx.orders().phase === 'retreat' || hammeredBy(ctx)) return false;
        if (Date.now() < (ctx.memory.get('bladeturnRetryAt') ?? 0)) return false;
        const effects = (ctx.sdk.getState()?.effects ?? []).map(e => e.name);
        const due = selfBuffDue(ctx.spells.all(), effects, ['Bladeturn']);
        const pick = due && ctx.spells.all().find(s => s.spell.name === due.spell.name);
        if (!pick || pick.spell.cooldownRemaining > 0 || ctx.me().mana < ctx.spells.powerOf(pick)) return false;
        ctx.doing('buff', null, pick.spell.name);
        const c = await ctx.bot.castSpell(pick.spell);
        ctx.result('bladeturn', c);
        if (!c.success) ctx.memory.set('bladeturnRetryAt', Date.now() + BLADETURN_RETRY_MS);
        return true;
    },
});

/**
 * A pulsing charm's chance to lose the mob, in % per pulse (CharmSpellHandler.cs ApplyEffectOnTarget): the "sweet spot" is
 * level x 0.66 + modified spec x 0.33 less the mob's level; at or above 0 it is 10 - 3 x that, at least 1, below 0 it is
 * (10 + 1.5 x the shortfall) x 3, at most 99. The roll comes at the cast and at every pulse (Imaginary Enemy: 4.8 s).
 */
export function charmResist(level: number, spec: number, mobLevel: number): number {
    const sweet = level * 0.66 + spec * 0.33 - mobLevel;
    return sweet >= 0 ? Math.max(1, 10 - 3 * sweet) : Math.min(99, (10 - 1.5 * sweet) * 3);
}

/**
 * The most a pulse may risk by default: the sweet spot at 0 or above, the server's own "a creature his level or lower" (at 24 with
 * Light 22, L23 and under). Verified 2026-11-13 on a throwaway stack: a lost pulse alone breaks nothing (the effect runs 10 s, the
 * pulse comes every 4.8 s), and the server rolls with a pseudo-random dice (GetPseudoDouble) that spreads resists out: a L24 tomte
 * soldier at 34 % a pulse resisted 14 times in about 5 minutes, never twice running, and stayed hers. The user took L24-30 mobs
 * (mature boars, a perturbed bwca); `{ maxResist: 35 }` takes her own level.
 */
export const CHARM_SAFE_RESIST = 10;

/**
 * What a pulsing charm can take: `cap` is the server's refusal (above the spell's value or 110 % of the modified spec,
 * CharmSpellHandler.cs CheckEndCast), `safe` the highest level at or under it that resists at most CHARM_SAFE_RESIST a pulse.
 * At 24 with Light 22: cap 24, safe 23 (9.7 % a pulse; a L24 34 %, a L21 3.7 %, a L20 and under 1 %).
 */
export function charmLimits(level: number, spec: number, value: number, maxResist = CHARM_SAFE_RESIST): { cap: number; safe: number } {
    const cap = Math.min(value, Math.floor(spec * 1.1));
    let safe = cap;
    while (safe > 0 && charmResist(level, spec, safe) > maxResist) safe--;
    return { cap, safe };
}

/** Mobs this near her, on the plane, are what the group has about it: she casts from where she stands (approach: false), well inside the charm's 2000. */
const CHARM_RADIUS = 1500;
/** A mob below this health % has been fought: some fight of ours or another's, which it would carry with it. */
const CHARM_FRESH = 90;
/** After a failed charm, the next try waits this long; the same mob, CHARM_MOB_RETRY_MS. */
const CHARM_RETRY_MS = 10_000;
const CHARM_MOB_RETRY_MS = 60_000;

export interface CharmChoice {
    /** Highest mob level to take (charmLimits().safe). */
    maxLevel: number;
    /** Ids no mob of which to take: the group's members, and what the board has as threats or the focus. */
    busy: ReadonlySet<number>;
    /** Names that can't be charmed (a body type the spell doesn't take, a named or guard one): the server refuses by template. */
    skipNames?: ReadonlySet<string>;
    /** Ids tried lately. */
    skipIds?: ReadonlySet<number>;
    radius?: number;
    /** Where she stands: the charmed mob walks from its spot to her, past whatever stands on that line. */
    from?: Point;
    /** A neighbour's aggro reach, null when it is passive (aggroAt, from the spawn data). Without it every monster counts as aggressive at CHARM_UNKNOWN_AGGRO. */
    aggroOf?: (o: NearbyNpc) => { range: number } | null;
}

/**
 * Room round the mob, past a neighbour's aggro range: mobs roam (pve's aggroPad). Every Thidranki bwca, boar and tomte
 * spawn has AggroRange 500, so that is 800 from its kin.
 */
export const CHARM_LONE_PAD = 300;
/** A neighbour's aggro range when no spawn data says (aggroOf left out). */
export const CHARM_UNKNOWN_AGGRO = 500;

/**
 * The aggressive mob that would set on the charmed one: once it is a player's pet every aggressive monster in its aggro
 * range takes it as a target (StandardMobBrain.CheckNpcAggro), at its spot or on its walk to her. Live 2026-11-13 19:39
 * (field-20261113-193026): a perturbed bwca charmed in its camp, and three more of the camp came for it in 40 s. One that
 * cons grey to the charmed mob never aggroes (CanAggroTarget).
 */
export function charmNeighbour(c: NearbyNpc, npcs: readonly NearbyNpc[], choice: Pick<CharmChoice, 'from' | 'aggroOf'>): NearbyNpc | null {
    return npcs.find(o => {
        if (o.objectId === c.objectId || o.realm !== 'none' || o.isPet || o.isPeaceful || conLevel(c.level, o.level) <= -3) return false;
        const a = choice.aggroOf ? choice.aggroOf(o) : { range: CHARM_UNKNOWN_AGGRO };
        if (!a) return false;
        const reach = a.range + CHARM_LONE_PAD;
        return Math.hypot(o.x - c.x, o.y - c.y) < reach || (!!choice.from && segDist(o, c, choice.from) < reach);
    }) ?? null;
}

/**
 * The mob to charm: a monster (realm none, attackable, not a pet, not named: a capital first letter is refused), at most
 * `maxLevel`, near her, at full health and on nobody (not in combat, no target, not busy), with no aggressive mob near it or
 * on its walk to her (charmNeighbour), so its camp stays put. The strongest first, then the nearest.
 */
export function charmTarget(npcs: readonly NearbyNpc[], c: CharmChoice): NearbyNpc | null {
    const radius = c.radius ?? CHARM_RADIUS;
    return npcs
        .filter(n => n.realm === 'none' && !n.isPet && !n.isPeaceful && n.isTargetable && !/^\p{Lu}/u.test(n.name)
            && n.level <= c.maxLevel && n.level > 0 && n.distance <= radius && n.healthPercent >= CHARM_FRESH
            && !n.inCombat && n.targetObjectId === null && !c.busy.has(n.objectId)
            && !c.skipNames?.has(n.name) && !c.skipIds?.has(n.objectId) && !charmNeighbour(n, npcs, c))
        .sort((a, b) => b.level - a.level || a.distance - b.distance)[0] ?? null;
}

/**
 * The pulled mob must be clear of its camp by this far from her: its run in (about 180 a second, live) leaves the 3 s charm
 * time to pass its half way before a swing. Live 2026-11-13, a kin beside the path rather than behind it: clear only 441 from
 * her, under CHARM_TOO_CLOSE a moment on, and the boar killed the solo Mentalist (138 a hit of her 262).
 */
export const CHARM_PULL_CLEAR = 700;
/** A pull nearer than this leaves no room to come clear of the camp before it is on her. */
export const CHARM_PULL_MIN = 600;
/** The pulled mob this near her is on her before the cast's half way (a swing then interrupts it): a fight like any other. */
export const CHARM_TOO_CLOSE = 300;
/** How long she waits for the pulled mob to come clear of its camp. */
const CHARM_PULL_MS = 12_000;

export interface CharmPull extends CharmChoice {
    from: Point;
    /** The mob's faction (factionAt): only 0 is taken, since a mob with one brings friends when hit in a group. */
    factionOf: (n: NearbyNpc) => number | null;
    /** Her nuke's range. */
    range: number;
}

/**
 * The mob to pull with a nuke and charm once it is clear of its camp, as the user did ("I pulled one with a nuke": charmed
 * in its camp, "they attack the charmed pet right away"): what charmTarget takes, but with neighbours, at CHARM_PULL_MIN to her
 * nuke's range, of no faction (the spawn data says 0: a hit on one with a faction brings friends, 50 % for each other group
 * member near, StandardMobBrain.BringFriends), with her own spot and the spot CHARM_PULL_CLEAR from her on its run in both out of
 * every aggressive neighbour's reach (aggro range + CHARM_LONE_PAD), so it is clear of them in time. The strongest first, then the nearest.
 */
export function charmPullTarget(npcs: readonly NearbyNpc[], c: CharmPull): NearbyNpc | null {
    const far = Math.min(c.radius ?? CHARM_RADIUS, c.range);
    return npcs
        .filter(n => n.realm === 'none' && !n.isPet && !n.isPeaceful && n.isTargetable && !/^\p{Lu}/u.test(n.name)
            && n.level <= c.maxLevel && n.level > 0 && n.distance >= CHARM_PULL_MIN && n.distance <= far && n.healthPercent >= CHARM_FRESH
            && !n.inCombat && n.targetObjectId === null && !c.busy.has(n.objectId)
            && !c.skipNames?.has(n.name) && !c.skipIds?.has(n.objectId) && c.factionOf(n) === 0
            && !npcs.some(o => {
                if (o.objectId === n.objectId || o.realm !== 'none' || o.isPet || o.isPeaceful || conLevel(n.level, o.level) <= -3) return false;
                const a = c.aggroOf ? c.aggroOf(o) : { range: CHARM_UNKNOWN_AGGRO };
                if (!a) return false;
                const reach = a.range + CHARM_LONE_PAD;
                const d = Math.hypot(n.x - c.from.x, n.y - c.from.y) || 1;
                const at = { x: c.from.x + (n.x - c.from.x) * CHARM_PULL_CLEAR / d, y: c.from.y + (n.y - c.from.y) * CHARM_PULL_CLEAR / d };
                return Math.hypot(o.x - c.from.x, o.y - c.from.y) < reach || Math.hypot(o.x - at.x, o.y - at.y) < reach;
            }))
        .sort((a, b) => b.level - a.level || a.distance - b.distance)[0] ?? null;
}

/** No pull with a fight this near her: a member in combat, or a contact fighting or a threat. */
export const CHARM_PULL_QUIET = 2000;

/**
 * Why a pull would come at a bad time, or null: an enemy player on the board (the pull would hold her and a pet-to-be in the
 * open), or a fight within CHARM_PULL_QUIET of her. The player-feedback session, 2026-11-13: "Deirdre now the second time
 * got a lot of adds. The first time it caused us big trouble."
 */
export function pullBlocked(contacts: readonly Contact[], members: readonly Pick<MemberReport, 'name' | 'regionId' | 'x' | 'y' | 'inCombat' | 'isDead'>[], me: { name: string; regionId: number; x: number; y: number; realm: string }): string | null {
    const near = (p: { x: number; y: number }) => Math.hypot(p.x - me.x, p.y - me.y) <= CHARM_PULL_QUIET;
    const foe = contacts.find(c => c.kind === 'player' && !c.stale && c.realm !== me.realm && c.regionId === me.regionId);
    if (foe) return `an enemy player in view (${foe.name})`;
    const fight = contacts.find(c => !c.stale && c.regionId === me.regionId && !c.charming && (c.threat || c.inCombat) && near(c));
    if (fight) return `a fight near (${fight.name})`;
    const busy = members.find(m => m.name !== me.name && !m.isDead && m.regionId === me.regionId && m.inCombat && near(m));
    return busy ? `${busy.name} in combat near` : null;
}

/** Map of name or id to when it may be tried again, kept in the member's memory. */
const later = <K>(memory: Map<string, any>, key: string): Map<K, number> => { let m = memory.get(key); if (!m) memory.set(key, m = new Map()); return m; };
const liveKeys = <K>(m: Map<K, number>, now: number): Set<K> => new Set([...m].filter(([, at]) => at > now).map(([k]) => k));

/**
 * A charmed mob as her pet when she has none, as the user played Niamh (6 charms of Imaginary Enemy in 52 min, a bwca and
 * mature boars, to tank the adds; play/niamh-1113-findings.md). The group's petControl, on the kit's list, drives it after.
 * A lone mob she charms where it stands (charmTarget). Else, with no fight on, she pulls one out of its camp with a nuke and
 * charms it once it is clear of the others' reach (charmPullTarget), as the user did. Her activity 'charm' on it marks it on
 * the board (Contact.charming) for CHARM_CLAIM_MS: no threat, no fight of the group's. A Mentalist's charm takes a mob in
 * combat: the server's in-combat refusal is for the Hunter's and Sorcerer's charms only (CharmSpellHandler.cs CheckEndCast).
 * Not in a pull, a travel or a retreat, not with a melee or an enemy aim on her, not with pets off for the run. In a fight only in
 * the chores' turns, when the fight has nothing for her.
 *
 * How it ends (server code, and verified for a release): a Mentalist's charm is a song, pulsing every 4.8 s at 3 power, and each
 * pulse rolls charmResist; the charm itself runs 10 s, so only two resisted pulses running let it lapse. Any end, that lapse, the
 * power running out ("You do not have enough power and your spell was canceled."), a release ("You cancel your effect.", "You lose
 * control of the X!"), puts her on the mob's list at level x 10 and has it attack her, and every mob on the pet turns on her too
 * (CharmECSEffect.cs OnStopEffect). Live, the released L24 tomte soldier hit her at once for 138 of her 262 and killed her 3 s on.
 * A release turns it as surely as a break, so the kit never releases: the safety is the pick (charmLimits().safe or under), and
 * the song, which goes on pulsing over a lapsed charm within 10000 and can take the mob back on its next pulse. A loss that no
 * release explains is noted for the group, and the mob on her is a threat to the board like any other.
 */
export const charmUp = ({ maxResist = CHARM_SAFE_RESIST }: { maxResist?: number } = {}): Behavior<TacticsSettings> => unlessAimedAt({
    name: 'charmUp',
    interruptible: false,
    async run(ctx) {
        noteCharmBreak(ctx);
        if (!petsAllowed(ctx.settings) || ctx.bot.isDead() || ctx.sdk.getPetState() || hammeredBy(ctx)) return false;
        const phase = ctx.orders().phase;
        if (phase === 'pull' || phase === 'travel' || phase === 'retreat') return false;
        const now = Date.now();
        if (now < (ctx.memory.get('charmRetryAt') ?? 0)) return false;
        const sp = ctx.spells.all().filter(s => s.type === 'Charm' && s.pulse).sort((a, b) => b.spell.level - a.spell.level)[0];
        if (!sp) return false;
        const me = ctx.me();
        const spec = modifiedSpec(sp.spell.lineName, ctx.sdk.getSkills().specializations ?? []);
        if (spec === null) return false;
        const { safe } = charmLimits(me.level, spec, sp.value || Infinity, maxResist);
        const busy = new Set<number>([...ctx.members().map(m => m.objectId), ...ctx.threats().map(t => t.objectId)]);
        const focus = ctx.orders().focus;
        if (focus !== null) busy.add(focus);
        const names = later<string>(ctx.memory, 'charmSkipNames');
        const ids = later<number>(ctx.memory, 'charmSkipIds');
        const choice = {
            maxLevel: safe, busy, skipNames: liveKeys(names, now), skipIds: liveKeys(ids, now),
            from: me, aggroOf: (o: NearbyNpc) => aggroAt(me.regionId, o.name, o),
        };
        let mob = charmTarget(ctx.sdk.getNearbyNpcs(), choice);
        let pulled = false;
        if (!mob) {
            // The pull starts a fight of its own: only with none on, near or in view.
            if (phase === 'engage' || ctx.threats().length) return false;
            if (pullBlocked(ctx.picture().contacts, ctx.members() as any, { name: ctx.name, regionId: me.regionId, x: me.x, y: me.y, realm: me.realm })) return false;
            const nuke = ctx.spells.nuke({ targetHp: 0 });
            if (!nuke) return false;
            const pull = charmPullTarget(ctx.sdk.getNearbyNpcs(), { ...choice, factionOf: n => factionAt(me.regionId, n.name, n), range: nuke.range });
            if (!pull) return false;
            const what = `${pull.name} (L${pull.level}, ${pull.distance} away)`;
            ctx.doing('charm', pull.objectId, `pulling ${what} out of its camp with ${nuke.spell.name}`);
            // Every pull leaves a line in the run log, whatever comes of it.
            ctx.note(`charm pull: ${nuke.spell.name} on ${what} at (${Math.round(pull.x)}, ${Math.round(pull.y)}), phase ${phase}`);
            const hit = await ctx.bot.castSpell(nuke.spell, pull.objectId, { approach: false });
            if (!hit.success) {
                ctx.note(`charm pull: ${nuke.spell.name} on ${pull.name} failed (${hit.reason ?? hit.message})`);
                ctx.result('charm', hit, pull.objectId);
                ctx.memory.set('charmRetryAt', Date.now() + CHARM_RETRY_MS);
                ids.set(pull.objectId, Date.now() + CHARM_MOB_RETRY_MS);
                return true;
            }
            mob = await comeClear(ctx, pull, choice.aggroOf);
            if (!mob) {
                // Not clear in time, or on her already: the group's to fight, as any mob on her.
                ctx.note(`charm pull: ${pull.name} came on her before it was clear of its camp, the group's to fight`);
                ctx.doing('idle', null, `pull of ${pull.name} came on her before it was clear of its camp`);
                ctx.memory.set('charmRetryAt', Date.now() + CHARM_RETRY_MS);
                ids.set(pull.objectId, Date.now() + CHARM_MOB_RETRY_MS);
                return true;
            }
            pulled = true;
        }
        const risk = charmResist(me.level, spec, mob.level);
        ctx.doing('charm', mob.objectId, `${sp.spell.name} on ${mob.name} (L${mob.level}, ${risk.toFixed(1)} % a pulse${pulled ? ', pulled' : ''})`);
        const c = await ctx.bot.charmPet(mob.objectId, { spell: sp.spell.name, approach: false });
        ctx.result('charm', c, mob.objectId);
        // A resisted first pulse leaves the song going: live, the pulled boar resisted (34 %) and its next pulse, 5 s on, took it.
        const onPulse = !c.success && c.reason === 'resisted' && sp.pulse ? await nextPulses(ctx, mob, sp.frequency) : false;
        if (c.success || onPulse) {
            if (onPulse) ctx.result('charm', { success: true, message: `${mob.name} taken on a later pulse` } as any, mob.objectId);
            ctx.memory.set('charmed', { objectId: mob.objectId, name: mob.name, at: Date.now() });
            ctx.note(`charmed ${mob.name} (L${mob.level}, ${risk.toFixed(1)} % a pulse${pulled ? ', pulled out of its camp' : ''})`);
            return true;
        }
        ctx.memory.set('charmRetryAt', Date.now() + CHARM_RETRY_MS);
        // By template: a body type the spell doesn't take, or one the server won't charm at all. The rest by this mob.
        if (c.reason === 'refused' && /does not charm|can't be charmed/.test(c.message)) names.set(mob.name, Infinity);
        else ids.set(mob.objectId, Date.now() + CHARM_MOB_RETRY_MS);
        // A pulled one that stayed hers no more: it's on her, the group's to fight.
        if (pulled) {
            ctx.note(`charm pull: the charm on ${mob.name} failed (${c.reason ?? c.message}), the group's to fight`);
            ctx.doing('idle', null, `charm on pulled ${mob.name} failed`);
        }
        return true;
    },
});

/**
 * After a resisted first pulse: the song pulses on (every `frequency` tenths of a second) and each pulse rolls again.
 * True once the mob is her pet within two more pulses; false when it dies, goes, she dies, or they pass. Her claim on it
 * goes on meanwhile (Contact.charming).
 */
async function nextPulses(ctx: Parameters<Behavior['run']>[0], mob: NearbyNpc, frequency: number): Promise<boolean> {
    ctx.doing('charm', mob.objectId, `waiting on the song's next pulse on ${mob.name}`);
    const until = Date.now() + 2 * (frequency || 48) * 100 + 1000;
    while (Date.now() < until) {
        if (ctx.bot.isDead()) return false;
        const pet = ctx.sdk.getPetState();
        if (pet) return pet.objectId === mob.objectId;
        const m = ctx.sdk.getNearbyNpcs().find(n => n.objectId === mob.objectId);
        if (!m || m.healthPercent <= 0) return false;
        await Bun.sleep(250);
    }
    return false;
}

/**
 * The pulled mob once it is out of its camp's reach (charmNeighbour, from where it is now) and still CHARM_TOO_CLOSE or more
 * from her; null when it dies, goes, comes that near first, something else is on her, the group retreats, or CHARM_PULL_MS passes.
 */
async function comeClear(ctx: Parameters<Behavior['run']>[0], pull: NearbyNpc, aggroOf: (o: NearbyNpc) => { range: number } | null): Promise<NearbyNpc | null> {
    const until = Date.now() + CHARM_PULL_MS;
    while (Date.now() < until) {
        if (ctx.bot.isDead() || ctx.orders().phase === 'retreat') return null;
        if (ctx.bot.getAttackers().some(a => a.objectId !== pull.objectId)) return null;
        const npcs = ctx.sdk.getNearbyNpcs();
        const m = npcs.find(n => n.objectId === pull.objectId);
        if (!m || m.healthPercent <= 0 || m.isPet || m.realm !== 'none') return null;
        if (m.distance < CHARM_TOO_CLOSE) return null;
        if (!charmNeighbour(m, npcs, { from: ctx.me(), aggroOf })) return m;
        await Bun.sleep(250);
    }
    return null;
}

/** A pet loss of the charm we cast that no release of ours explains: the mob is on her now (CharmECSEffect.cs OnStopEffect). Once per loss. */
function noteCharmBreak(ctx: Parameters<Behavior['run']>[0]): void {
    const charmed = ctx.memory.get('charmed') as { objectId: number; name: string; at: number } | undefined;
    const loss = ctx.sdk.getState()?.lastPetLoss;
    if (!charmed || !loss || loss.objectId !== charmed.objectId || loss.at < charmed.at) return;
    ctx.memory.delete('charmed');
    if (loss.cause === 'owner_died' || loss.cause === 'region_change') return;
    ctx.note(`charm on ${charmed.name} ended (${loss.cause}) after ${Math.round((loss.at - charmed.at) / 1000)} s: it turns on ${ctx.name}`);
}

/** `charm`: false leaves the charm out; `{ maxResist }` takes mobs that resist up to that % a pulse (default CHARM_SAFE_RESIST). */
export function mentalist({ offFocus = true, charm = true }: { offFocus?: boolean; charm?: boolean | { maxResist?: number } } = {}): MentalistKit {
    // petControl is a side behaviour: on the list from the start, as a run decides its pet behaviours once, when she has no pet yet (withPets, runner.ts).
    const chores = charm ? [bladeturnUp(), charmUp(charm === true ? {} : charm), petControl()] : [bladeturnUp()];
    return { character: { role: 'nuker', instant: [quickFlash(), quickcastUnderFire()], urgent: [stunCaster(), wallStep()], fight: casterFight(offFocus), chores } };
}
