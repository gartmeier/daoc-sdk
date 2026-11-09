// The standard Mentalist: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list
// already picks nukes, heals, mezzes and buffs from whatever the bot knows. What is the class's own is Prismatic
// Flash (Light, stun, 2.5 s, range 1500, 5 s): `stunCaster` throws it at an enemy player casting at our Bard or
// Druid, then at any of us, then at a casting healer. Spec points aren't here: they are the character's
// bots/<bot>/build.ts, copied from data/builds/mentalist.ts. learnings/classes/mentalist.md says why.

import { foeInView } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { Contact, MemberReport, Role } from '../group/types';

export interface MentalistKit {
    character: Character;
}

/** A cast seen this recently is one under way, or the caster's next. */
const CASTING_MS = 2500;
/** A stun's length plus the player's 60 s immunity after it (immunity_timer_flat_length, CrowdControlECSEffect.cs:20). */
const STUN_IMMUNE_MS = 60_000;
/** Who it saves first: the roles that hold the group up, then anyone, then a healer of theirs at work. */
const SAVE_FIRST: readonly Role[] = ['support', 'healer'];

/**
 * The player to stun: casting now, in range, not crowd-controlled, not stun-immune by the board. First one whose spell
 * is on our support or healer, then one on any member, then a casting healer of theirs; the nearest of each.
 */
export function stunTarget(contacts: readonly Contact[], members: readonly Pick<MemberReport, 'name' | 'role'>[], me: { x: number; y: number; regionId: number }, range: number, now: number): Contact | null {
    const roleOf = new Map(members.map(m => [m.name, m.role]));
    const rank = (c: Contact) => {
        const on = c.target && c.targetBySpell ? roleOf.get(c.target) : undefined;
        return on && SAVE_FIRST.includes(on) ? 0 : on ? 1 : c.healer ? 2 : 3;
    };
    const d = (c: Contact) => Math.hypot(c.x - me.x, c.y - me.y);
    return contacts
        .filter(c => c.kind === 'player' && !c.stale && c.regionId === me.regionId && !c.cc && (c.ccImmune?.stun ?? 0) <= now
            && now - (c.castingAt ?? -Infinity) <= CASTING_MS && d(c) <= range && rank(c) < 3)
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
        const self = ctx.members().find(m => m.name === me.name);
        const foe = stunTarget(ctx.picture().contacts, ctx.members(), { x: me.x, y: me.y, regionId: self?.regionId ?? me.regionId }, sp.range, Date.now());
        if (!foe) return false;
        const view = foeInView(ctx, foe.objectId);
        if (!view || ('isDead' in view && view.isDead)) return false;
        ctx.doing('stun', foe.objectId, `${sp.spell.name}${foe.target ? `, casting at ${foe.target}` : ''}`);
        const c = await ctx.bot.castSpell(sp.spell, foe.objectId, { approach: false });
        ctx.result('stun', c, foe.objectId);
        if (c.success) ctx.markCcImmune(foe.objectId, 'stun', sp.duration * 1000 + STUN_IMMUNE_MS);
        else if (c.reason === 'immune') ctx.markCcImmune(foe.objectId, 'stun', STUN_IMMUNE_MS);
        return true;
    },
});

export function mentalist(): MentalistKit {
    return { character: { role: 'nuker', react: [stunCaster()] } };
}
