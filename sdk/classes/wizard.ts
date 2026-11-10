// The standard Wizard: a starting point a bot imports into bots/<bot>/character.ts and tunes. The role list already
// casts her one good nuke (Ice Blast, Cold 24), her root and her buffs; what is the class's own is the rest of an
// Albion caster's survival kit: Quickcast under fire (cabalist.ts), and, with every cast of hers 2.5 s or longer,
// giving ground instead of casting while a melee is on her (theurgist.ts). Her nukes leave out the snare nuke, which
// ties Ice Blast on level and is 0.4 s slower for the same damage. learnings/classes/wizard.md says why, and what is open.

import { type TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import type { SpellPick } from '../group/spells';
import { nukerFight, quickcastUnderFire } from './cabalist';
import { giveGround } from './theurgist';

/**
 * Entangling Haze (Minor), Cold 24: 88 damage and a 35 % snare like Ice Blast's 88, but a 3 s cast against 2.6 s, and the
 * snare ends at the next hit, which on the group's focus comes at once. pickNuke ranks by spell level and both are 24, so
 * the skill list's order chose. Kept when it is the only direct damage she knows.
 */
export function plainNukesFirst(all: readonly SpellPick[]): SpellPick[] {
    const plain = all.some(s => s.target === 'Enemy' && s.type === 'DirectDamage' && s.radius === 0 && s.range > 0);
    return plain ? all.filter(s => s.type !== 'DamageSpeedDecrease') : [...all];
}

/** `ctx` with a Spellbook that sees only `view(all)`: every pick it makes (nuke, cc, buffs) comes from those. */
export function withSpellView<S>(ctx: MemberContext<S>, view: (all: readonly SpellPick[]) => SpellPick[]): MemberContext<S> {
    const book = ctx.spells;
    const seen = Object.create(book, { all: { value: () => view(book.all()) } });
    return new Proxy(ctx, { get: (t, p) => (p === 'spells' ? seen : Reflect.get(t, p, t)) });
}

/** `inner` casting from `view` of our spells. */
export const castingFrom = <S>(inner: Behavior<S>, view: (all: readonly SpellPick[]) => SpellPick[]): Behavior<S> => ({
    ...inner,
    run: ctx => inner.run(withSpellView(ctx, view)),
});

export interface WizardOptions {
    /** No nukes below this % power. 0: no floor, as Camelot's casters play the arena. */
    saveBelow?: number;
    /** Its nukes on a free enemy in reach while the focus is out of it (cabalist.ts offFocus). On by default. */
    offFocus?: boolean;
    /** Give ground instead of casting while a melee is on her (theurgist.ts giveGround). On by default. */
    giveGround?: boolean;
}

export function wizard({ saveBelow = 0, offFocus: off = true, giveGround: give = true }: WizardOptions = {}): Character {
    const nukes = (b: Behavior<TacticsSettings>) => castingFrom(b, plainNukesFirst);
    return {
        role: 'nuker',
        // No meleeDebuff: she has no instant spell.
        instant: [nukes(quickcastUnderFire())],
        ...(give ? { react: [giveGround()] } : {}),
        fight: nukerFight(saveBelow, off).map(nukes),
    };
}
