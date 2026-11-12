// The standard Minstrel: a starting point a bot imports into bots/<bot>/character.ts and tunes. Albion's singer:
// roleForClass makes it support, whose list already mezzes (Constraining Cadence, 3 s, range 1500) and sings (speed
// travelling, health and power between fights). What is the class's own:
// - `stunShout` (instant, above flee): Stunning Shout (Stun, instant, range 700, 5 s, 10 s timer) at an enemy player
//   on one of our soft members (healers first), on him, or casting near him. A stun stops a cast for certain and isn't
//   broken by damage, so the group keeps hitting it. Once per immunity (60 s after it ends, CrowdControlECSEffect.cs:20), told
//   to the board with markCcImmune. Not markCc: that is how a mezz is held back from, and a stunned enemy is one to hit.
// - `interruptOnTheRun` (the Bard kit's, instant, above flee): Dischordant Wail (46 damage, instant, range 700) at a casting
//   enemy while a melee is on him, when flee would have every turn.
// - `interrupt()` above position: the same shout at a casting enemy when nothing is on him (the RvR support list has none).
// learnings/classes/minstrel.md says why, and what is open.

import { claimedBy, foeInView, interrupt, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import { ccImmuneTo } from '../group/cc';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { Contact, MemberReport } from '../group/types';
import { interruptOnTheRun } from './bard';
import { STUN_IMMUNE_MS } from './hero';

/** An enemy this near a member counts as on it in melee. */
const ON_MEMBER = 350;
/** It started a cast this recently: the shout still catches it. */
const CASTING_MS = 2000;
/** Another member's crowd control on it this recently: leave it to them. */
const CLAIM_MS = 4000;

/**
 * Who the stun goes on, best first, or null: a free enemy player in `range` that can take a stun (not immune by the board or
 * our log), ranked 0 on one of our healers in melee, 1 on him, 2 on another soft member (support, nuker), 3 casting.
 * One doing none of that isn't worth the timer: the melee have their own stuns.
 */
export function stunTarget(contacts: readonly Contact[], members: readonly MemberReport[], me: { name: string; x: number; y: number; regionId: number }, distanceTo: (id: number) => number, range: number, stunnedUntil: ReadonlyMap<number, number>, now = Date.now()): Contact | null {
    const near = (c: Contact, m: { x: number; y: number; regionId: number }) => m.regionId === c.regionId && Math.hypot(c.x - m.x, c.y - m.y) <= ON_MEMBER;
    const healers = members.filter(m => !m.isDead && m.role === 'healer' && m.name !== me.name);
    const soft = members.filter(m => !m.isDead && (m.role === 'support' || m.role === 'nuker') && m.name !== me.name);
    const rank = (c: Contact) => {
        const on = (m: MemberReport) => c.target === m.name && near(c, m);
        if (healers.some(on)) return 0;
        if (c.target === me.name && near(c, me)) return 1;
        if (soft.some(on)) return 2;
        if (now - (c.castingAt ?? -Infinity) <= CASTING_MS) return 3;
        return 4;
    };
    return contacts
        .filter(c => c.kind === 'player' && !c.isPet && !c.stale && isAlive(c) && !c.cc && !untouchable(c, now) && !ccImmuneTo(c, 'stun', now)
            && now >= (stunnedUntil.get(c.objectId) ?? -Infinity) && distanceTo(c.objectId) <= range)
        .filter(c => rank(c) < 4)
        .sort((a, b) => rank(a) - rank(b) || distanceTo(a.objectId) - distanceTo(b.objectId))[0] ?? null;
}

export const stunShout = (): Behavior<TacticsSettings> => ({
    name: 'stunShout',
    interruptible: false,
    async run(ctx) {
        const phase = ctx.orders().phase;
        if (phase !== 'engage' && !ctx.threats().length) return false;
        const sp = ctx.spells.all()
            .filter(s => s.type === 'Stun' && s.target === 'Enemy' && s.castTime === 0 && s.radius === 0 && s.range > 0 && s.spell.cooldownRemaining <= 0 && (ctx.me().mana ?? 0) >= ctx.spells.powerOf(s))
            .sort((a, b) => b.spell.level - a.spell.level)[0];
        if (!sp) return false;
        const log: Map<number, number> = ctx.memory.get('stunnedUntil') ?? new Map();
        ctx.memory.set('stunnedUntil', log);
        const me = ctx.me();
        const distanceTo = (id: number) => foeInView(ctx, id)?.distance ?? Infinity;
        const target = stunTarget(ctx.picture().contacts, ctx.members(), me, distanceTo, sp.range, log);
        if (!target || claimedBy(ctx, 'cc', target.objectId, CLAIM_MS).length) return false;
        ctx.doing('stun', target.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false });
        const refused = !c.success ? null : c.effectImmune ? 'immune' : c.resisted ? 'resisted' : c.effectLanded === false ? 'no_effect' : null;
        ctx.result('stun', refused ? { ...c, success: false, reason: refused } : c, target.objectId);
        const lasts = sp.duration * 1000;
        if (c.success && !refused) {
            log.set(target.objectId, Date.now() + lasts + STUN_IMMUNE_MS);
            ctx.markCcImmune(target.objectId, 'stun', lasts + STUN_IMMUNE_MS);
        } else if (refused === 'immune') {
            log.set(target.objectId, Date.now() + STUN_IMMUNE_MS);
            ctx.markCcImmune(target.objectId, 'stun', STUN_IMMUNE_MS);
        } else if (refused === 'resisted') log.set(target.objectId, Date.now() + 3000);
        return true;
    },
});

export function minstrel(): Character {
    return { role: 'support', instant: [stunShout(), interruptOnTheRun()], react: [interrupt()] };
}
