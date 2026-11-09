// The standard Paladin: a starting point a bot imports into bots/<bot>/character.ts and tunes. The tank's
// list has no song, so without this no chant ever plays; what is the class's own is singing while it tanks,
// and his self AF (Aura of Indestructability), which no role list casts.
// learnings/classes/paladin.md says what that plays, and what hasn't been run.

import { QUIET_PHASES, song, tank, type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior } from '../group/member';
import type { TwistSettings } from '../group/songs';
import type { SpellPick } from '../group/spells';
import { twisting } from '../group/twist';

/** The spell types `buff()` doesn't slot, which a kit keeps up on itself: the Paladin's own AF. */
export const SELF_BUFF_TYPES: readonly string[] = ['PaladinArmorFactorBuff'];

/** After a failed cast: out of power or refused, try again in this long. */
const SELF_BUFF_RETRY_MS = 30_000;

/** The top rank of a self buff of `types` that isn't on us now, or null. */
export function selfBuffDue(all: readonly Pick<SpellPick, 'spell' | 'type' | 'target'>[], effects: readonly string[], types: readonly string[] = SELF_BUFF_TYPES): Pick<SpellPick, 'spell' | 'type' | 'target'> | null {
    const own = all.filter(s => types.includes(s.type) && s.target === 'Self').sort((a, b) => b.spell.level - a.spell.level);
    const top = own[0];
    if (!top || own.some(s => effects.includes(s.spell.name))) return null;
    return top;
}

/**
 * Between fights, a self buff of `types` that `buff()` doesn't know: the Paladin's Aura of Indestructability (Chants 24, 37 AF,
 * 17 power, 20 minutes). The server's PaladinArmorFactorBuff is its own effect group in the uncapped "other" category, so it adds
 * to the armor chant and to a Cleric's AF buffs (SingleStatBuff.cs, EffectHelper.cs).
 */
export const selfBuff = (types: readonly string[] = SELF_BUFF_TYPES): Behavior<TacticsSettings> => ({
    name: 'selfBuff',
    interruptible: false,
    async run(ctx) {
        if (!QUIET_PHASES.has(ctx.orders().phase) || ctx.threats().length || ctx.bot.isDead()) return false;
        if (Date.now() < (ctx.memory.get('selfBuffRetryAt') ?? 0)) return false;
        const effects = (ctx.sdk.getState()?.effects ?? []).map(e => e.name);
        const due = ctx.spells.all().find(s => s.spell.name === selfBuffDue(ctx.spells.all(), effects, types)?.spell.name);
        if (!due || due.spell.cooldownRemaining > 0 || ctx.me().mana < due.power) return false;
        ctx.doing('buff', null, due.spell.name);
        const c = await ctx.bot.castSpell(due.spell);
        ctx.result('buff', c);
        if (!c.success) ctx.memory.set('selfBuffRetryAt', Date.now() + SELF_BUFF_RETRY_MS);
        return true;
    },
});

/** `twist`: chants in turn while he swings, instead of the one song() holds. Off by default. */
export function paladin(opts: { twist?: TwistSettings } = {}): Character {
    return { role: 'tank', react: [song()], chores: [selfBuff()], ...(opts.twist ? { fight: [twisting(tank(), opts.twist)] } : {}) };
}
