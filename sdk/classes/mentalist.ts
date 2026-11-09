// The standard Mentalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list
// already picks nukes, heals, mezzes and buffs from whatever the bot knows. What is the class's own is Prismatic
// Flash (Light, stun, 2.5 s, range 1500, 5 s): `stunCaster` throws it at an enemy player casting at or swinging at our
// Bard or Druid, then at one casting at any of us, then at a casting healer. Spec points aren't here: they are the character's
// bots/<bot>/build.ts, copied from data/builds/mentalist.ts. learnings/classes/mentalist.md says why.

import { foeInView, hammeredBy } from '../group/behaviors';
import type { Character } from '../group/character';
import { nukerFight } from './cabalist';
import type { Behavior } from '../group/member';
import type { Contact, MemberReport, Role } from '../group/types';

export interface MentalistKit {
    character: Character;
}

/** A cast seen this recently is one under way, or the caster's next. */
const CASTING_MS = 2500;
/** A stun's length plus the player's 60 s immunity after it (immunity_timer_flat_length, CrowdControlECSEffect.cs:20). */
const STUN_IMMUNE_MS = 60_000;
/** The server measures a spell's range in 3D: a foe at the edge by our view can be out of it (round 9: stun:out_of_range). */
const RANGE_MARGIN = 60;
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
        const seen = (c: Contact) => { const v = foeInView(ctx, c.objectId); return !v || ('isDead' in v && v.isDead) ? Infinity : v.distance; };
        const foe = stunTarget(ctx.picture().contacts, ctx.members(), self?.regionId ?? me.regionId, seen, sp.range, Date.now());
        if (!foe) return false;
        ctx.doing('stun', foe.objectId, `${sp.spell.name}${foe.target ? `, casting at ${foe.target}` : ''}`);
        const c = await ctx.bot.castSpell(sp.spell, foe.objectId, { approach: false });
        ctx.result('stun', c, foe.objectId);
        if (c.success) ctx.markCcImmune(foe.objectId, 'stun', sp.duration * 1000 + STUN_IMMUNE_MS);
        else if (c.reason === 'immune') ctx.markCcImmune(foe.objectId, 'stun', STUN_IMMUNE_MS);
        return true;
    },
});

/** offFocus (the Cabalist kit's): nukes on a free enemy in reach while the focus is out of it. Arena round 10: Niamh 1 nuke in a 79 s wipe. */
export function mentalist({ offFocus = true }: { offFocus?: boolean } = {}): MentalistKit {
    return { character: { role: 'nuker', react: [stunCaster()], fight: nukerFight(0, offFocus) } };
}
