// The standard Mentalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list
// already picks nukes, heals, mezzes and buffs from whatever the bot knows. What is the class's own is Prismatic
// Flash (Light, stun, 2.5 s, range 1500, 5 s): `stunCaster` throws it at an enemy player casting at or swinging at our
// Bard or Druid, then at one casting at any of us, then at a casting healer. Spec points aren't here: they are the character's
// bots/<bot>/build.ts, copied from data/builds/mentalist.ts. learnings/classes/mentalist.md says why.

import { foeInView, hammeredBy } from '../group/behaviors';
import type { Character } from '../group/character';
import { nukerFight, QUICKCAST_REUSE_MS, quickcastUnderFire } from './cabalist';
import type { Behavior } from '../group/member';
import type { Contact, MemberReport, Role } from '../group/types';

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

/** Record a cast's "too far" at a target, at our view's distance then. */
export function noteTooFar(log: TooFar, id: number, reason: string | undefined, d: number, now: number): void {
    if (reason === 'out_of_range') log.set(id, { at: now, d });
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
        const sp = ctx.spells.all().find(s => s.type === 'Stun' && s.target === 'Enemy' && s.radius === 0 && s.power <= me.mana && s.spell.cooldownRemaining <= 0);
        if (!sp) return false;
        // A melee on her would only interrupt the 2.5 s cast: flee's.
        if (hammeredBy(ctx)) return false;
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
export const quickFlash = (): Behavior => ({
    name: 'quickFlash',
    interruptible: false,
    async run(ctx) {
        if (ctx.orders().phase !== 'engage') return false;
        const now = Date.now();
        if (now < (ctx.memory.get('quickcastReadyAt') ?? 0) || !ctx.sdk.findAbility('Quickcast')) return false;
        const foe = hammeredBy(ctx);
        if (!foe || foe.kind !== 'player' || foe.cc || (foe.ccImmune?.stun ?? 0) > now) return false;
        const me = ctx.me();
        const sp = ctx.spells.all().find(s => s.type === 'Stun' && s.target === 'Enemy' && s.radius === 0 && s.spell.cooldownRemaining <= 0);
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

export function mentalist({ offFocus = true }: { offFocus?: boolean } = {}): MentalistKit {
    return { character: { role: 'nuker', instant: [quickFlash(), quickcastUnderFire()], urgent: [stunCaster()], fight: nukerFight(0, offFocus) } };
}
