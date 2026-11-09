// The standard Cleric: a starting point a bot imports into bots/<bot>/character.ts and tunes. The healer's list
// has no fight, and with no mezz a Cleric with nothing to heal stands idle; what is the class's own is her baseline
// stun, Stunning Flare (5 s, 9 power), on an enemy player beating on one of our casters or on the enemy healer while
// our focus is low, and casting Smite at monsters in the time left, above a floor of power for the heals.
// learnings/classes/cleric.md says what that reaches, and what the arena rounds showed.

import { assist, foeInView, isDown, onMember, stopSwinging, type TacticsSettings } from '../group/behaviors';
import { dist } from '../group/battleground';
import { ccImmuneTo, CC_IMMUNE_MS } from '../group/cc';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { SpellPick } from '../group/spells';
import type { Contact, MemberReport } from '../group/types';
import { thrifty } from './thrifty';

export interface ClericOptions {
    /** No nukes below this % power. A guess: Greater Revival costs 52. */
    saveBelow?: number;
    /** Stun peels and the enemy healer (stunPeel). On by default. */
    stun?: boolean;
}

/** Stunning Flare's length at 24; a player is immune to stuns for 60 s after one ends (immunity_timer_flat_length). */
const STUN_MS = 5000;
/** Its enemy healer is worth a stun once our focus is this low. */
export const STUN_HEALER_BELOW = 60;
/** The server measures in 3D and from where it last had us: 2 of 6 stuns at the edge came back out of range (arena round 11). */
const STUN_RANGE_MARGIN = 50;
/** Not with less power than this left: the heals come first. */
const STUN_MIN_MANA = 15;

type Who = Pick<MemberReport, 'name' | 'role' | 'isDead' | 'regionId' | 'x' | 'y'>;

/**
 * Whom to stun, if anyone: an enemy player in melee on a member who isn't the tank (a healer first, then the nearest
 * to us; an enemy pet doing so counts), else the enemy healer while our focus is at or below `healerBelow` %, or with no healer in reach the focus itself. Otherwise only players: a monster's stun
 * shortens with every repeat. Never one under crowd control (a stun would
 * wake a mezz, and a stun on a stun is wasted), nor one immune to stuns, nor one beyond `range` of us.
 */
export function stunTarget(me: Who, members: readonly Who[], threats: readonly Contact[], focus: Contact | undefined, range: number, healerBelow = STUN_HEALER_BELOW, now = Date.now()): { target: Contact; why: 'peel' | 'healer' | 'focus' } | null {
    const free = (c: Contact) => !c.stale && !c.cc && !ccImmuneTo(c, 'stun', now) && c.regionId === me.regionId && dist(me, c) <= range;
    const open = threats.filter(c => c.kind === 'player' && !c.isPet && free(c));
    // A peel takes an enemy pet too: a Spiritmaster's spirit warrior interrupted Morgana and Taliesin to death in arena round 8.
    const pets = threats.filter(c => c.kind !== 'player' && c.isPet && free(c));
    const soft = members.filter(m => !m.isDead && m.role !== 'tank' && m.regionId === me.regionId);
    const onSoft = [...open, ...pets]
        .map(c => ({ c, on: soft.find(m => onMember(c, m)) }))
        .filter((x): x is { c: Contact; on: Who } => !!x.on)
        .sort((a, b) => Number(b.on.role === 'healer') - Number(a.on.role === 'healer') || dist(me, a.c) - dist(me, b.c));
    if (onSoft[0]) return { target: onSoft[0].c, why: 'peel' };
    if (!focus || focus.kind !== 'player' || focus.hp > healerBelow) return null;
    const healer = open.filter(c => c.healer && c.objectId !== focus.objectId).sort((a, b) => dist(me, a) - dist(me, b))[0];
    if (healer) return { target: healer, why: 'healer' };
    // No healer to stop: the focus itself, so it can't heal itself, cast or run while the nukes land. A stun doesn't break on damage.
    return open.some(c => c.objectId === focus.objectId) ? { target: focus, why: 'focus' } : null;
}

/** The top rank of a single-target stun we can cast now. */
export function stunSpell(all: readonly SpellPick[], mana: number): SpellPick | null {
    return all.filter(s => s.type === 'Stun' && s.target === 'Enemy' && s.range > 0 && s.radius === 0 && s.power <= mana && s.spell.cooldownRemaining <= 0)
        .sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;
}

/**
 * In a fight, Stunning Flare on stunTarget's pick, from where she stands: no walk out of her healing reach. Below heal()
 * in her list, so a member who needs healing always comes first. A stun doesn't break on damage, so a stun on the focus
 * isn't marked as crowd control (the nukers would hold off it); on anyone else it is, for its length. Either way the
 * target is marked immune to stuns for its length and the minute after.
 */
export const stunPeel = (opts: { healerBelow?: number; minMana?: number } = {}): Behavior<TacticsSettings> => ({
    name: 'stunPeel',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage') return false;
        const me = ctx.me();
        if (me.maxMana > 0 && me.manaPercent < (opts.minMana ?? STUN_MIN_MANA)) return false;
        const sp = stunSpell(ctx.spells.all(), me.mana);
        if (!sp) return false;
        const pick = stunTarget({ ...me, name: ctx.name, role: ctx.role, isDead: false }, ctx.members(), ctx.threats(), ctx.focus(), sp.range, opts.healerBelow, Date.now());
        if (!pick) return false;
        const seen = foeInView(ctx, pick.target.objectId);
        if (!seen || isDown(ctx, seen) || seen.distance > sp.range - STUN_RANGE_MARGIN) return ctx.skip('stunPeel: target out of reach');
        await stopSwinging(ctx);
        ctx.doing('stun', pick.target.objectId, `${sp.spell.name} (${pick.why})`);
        const c = await ctx.bot.castSpell(sp.spell, pick.target.objectId, { approach: false });
        const refused = !c.success ? null : c.effectImmune || c.alreadyOn ? 'immune' : c.resisted ? 'resisted' : null;
        ctx.result('stun', refused ? { ...c, success: false, reason: refused } : c, pick.target.objectId);
        if (refused === 'immune') ctx.markCcImmune(pick.target.objectId, 'stun', CC_IMMUNE_MS);
        else if (c.success) {
            const ms = Math.max(STUN_MS, sp.duration * 1000);
            if (pick.target.objectId !== ctx.orders().focus) ctx.markCc(pick.target.objectId, 'stun', ms, c.landedOn);
            ctx.markCcImmune(pick.target.objectId, 'stun', ms + CC_IMMUNE_MS);
        } else if (c.reason === 'crowd_controlled' || c.reason === 'no_power') await Bun.sleep(Math.min(c.retryAfterMs ?? 2000, 3000));
        return true;
    },
});

/** Smite at monsters only: against players her spare power is the group's heals (spareNuke above 75 % still smites them). */
const notOnPlayers = (inner: Behavior<TacticsSettings>): Behavior<TacticsSettings> => ({
    ...inner,
    run: ctx => (ctx.focus()?.kind === 'player' ? ctx.skip(`${inner.name}: no smite at players below spareNuke's floor`) : inner.run(ctx)),
});

export function cleric({ saveBelow = 50, stun = true }: ClericOptions = {}): Character {
    return { role: 'healer', fight: [...(stun ? [stunPeel()] : []), notOnPlayers(thrifty(assist(), saveBelow))] };
}
