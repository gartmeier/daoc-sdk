// The standard Skald: a starting point a bot imports into bots/<bot>/character.ts and tunes. roleForClass
// makes it support, which stands at range and never swings; its melee list already sings and fights.
// What is the class's own is Crippling Shout: an instant mezz, range 700, 18 s, 30 s between uses, which a
// melee list never casts. shoutMezz peels an enemy off our soft members with it. learnings/classes/skald.md says
// why, and what has been measured. Its fight is the melee list's own (meleeFight), but swings no taunt at a player.

import { assist, claimedBy, foeInView, type StylePick, type TacticsSettings } from '../group/behaviors';
import { isAlive, untouchable } from '../group/blackboard';
import { immuneKinds } from '../group/cc';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import { fighterStyle, raisesThreat } from '../group/styles';
import type { Contact, MemberReport } from '../group/types';
import type { Style } from '../types';

/** Another member's cc cast on it this recently: leave it to them. */
const CLAIM_MS = 4000;

/**
 * Who an instant mezz goes on: a free enemy player in `range`, not the focus, nobody's cc order, nobody of ours hitting it
 * (the next blow wakes it), and not immune. First one hitting our soft members (healers, casters), then a healer;
 * anyone else is not worth the 30 s timer. Null when none.
 */
export function shoutMezzTarget(contacts: readonly Contact[], members: readonly MemberReport[], o: { focus: number | null; cc: readonly { by: string; targetId: number }[] }, distanceTo: (id: number) => number, range: number, now = Date.now()): Contact | null {
    const soft = new Set(members.filter(m => !m.isDead && m.role !== 'tank' && m.role !== 'melee').map(m => m.name));
    const hit = new Set(members.filter(m => !m.isDead && m.attacking && m.targetId !== null).map(m => m.targetId!));
    for (const m of members) if (m.pet?.targetId) hit.add(m.pet.targetId);
    const rank = (c: Contact) => (c.target && soft.has(c.target) ? 0 : c.healer ? 1 : 2);
    return contacts
        .filter(c => c.kind === 'player' && !c.isPet && !c.stale && isAlive(c) && !c.cc && !untouchable(c, now) && c.objectId !== o.focus
            && !o.cc.some(a => a.targetId === c.objectId) && !hit.has(c.objectId) && !immuneKinds(c, now).includes('mezz') && distanceTo(c.objectId) <= range)
        .filter(c => rank(c) < 2)
        .sort((a, b) => rank(a) - rank(b) || distanceTo(a.objectId) - distanceTo(b.objectId))[0] ?? null;
}

/** Crippling Shout at what shoutMezzTarget picks, in a fight. Instant, so it costs the swing one turn. */
export const shoutMezz = (): Behavior<TacticsSettings> => ({
    name: 'shoutMezz',
    interruptible: false,
    async run(ctx) {
        const o = ctx.orders();
        if (o.phase !== 'engage') return false;
        const sp = ctx.spells.mezz();
        if (!sp || sp.castTime > 0) return false;
        const distanceTo = (id: number) => foeInView(ctx, id)?.distance ?? Infinity;
        const target = shoutMezzTarget(ctx.picture().contacts, ctx.members(), o, distanceTo, sp.range);
        if (!target || claimedBy(ctx, 'cc', target.objectId, CLAIM_MS).length) return false;
        ctx.doing('cc', target.objectId, sp.spell.name);
        const c = await ctx.bot.castSpell(sp.spell, target.objectId, { approach: false });
        const refused = !c.success ? null : c.effectImmune ? 'immune' : c.alreadyOn ? 'already_on' : c.resisted ? 'resisted' : c.effectLanded === false ? 'no_effect' : null;
        ctx.result('cc', refused ? { ...c, success: false, reason: refused } : c, target.objectId);
        if (c.success && !refused) ctx.markCc(target.objectId, 'mezz', sp.duration * 1000, c.landedOn);
        return true;
    },
});

/** A player has no threat table: a taunt (Plague) is a swing that could have been damage. Monsters keep every style. */
export const stylesFor = (styles: readonly Style[], player: boolean): Style[] => (player ? styles.filter(s => !raisesThreat(s)) : [...styles]);

const fighter = fighterStyle();
/** fighterStyle, without taunts against players. */
export const skaldStyle: StylePick = seen => fighter({ ...seen, styles: stylesFor(seen.styles, seen.target.kind === 'player') });

export function skald(): Character {
    return { role: 'melee', react: [shoutMezz()], fight: [assist({ melee: true, holdMs: 0, style: skaldStyle })] };
}
