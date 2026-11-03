// A caster's fight that stops at a floor of power and leaves the kill to the others. Measured on a Theurgist
// and a Sorcerer in groups/camelot, where the group waited a third of each hunt for one caster's power.
// learnings/classes/theurgist.md has the runs.

import type { Behavior } from '../group/member';

/** `inner` only while we have more than `floor` % power, with enemies about. */
export const thrifty = <S>(inner: Behavior<S>, floor: number): Behavior<S> => ({
    ...inner,
    async run(ctx) {
        if (ctx.threats().length && ctx.me().maxMana > 0 && ctx.me().manaPercent < floor) return ctx.skip(`${inner.name}: saving power (< ${floor} %)`);
        return inner.run(ctx);
    },
});
