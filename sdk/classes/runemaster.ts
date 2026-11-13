// The standard Runemaster: a starting point a bot imports into bots/<bot>/character.ts and tunes. roleForClass makes it a
// nuker. Its fight is the Spiritmaster kit's (steppingAssist, then nukeInReach) and Quickcast under fire, the Cabalist kit's.
// What is the class's own: which lines it nukes from. A Runemaster is given every baseline spell up to its level, spec or
// not, and a spell from a line it has 1 point in rolls its damage down to about 60 % (SpellHandler.CalculateLowerVarianceBound
// at spec 1 against a level-24 target) and costs 120 % (no focus discount). At Darkness 24 the Spellbook still ranks them
// alongside: Symbol of Destruction (Runecarving 23) ties Rune of Obscurity (Runes of Darkness 23, 108) on spell level, and with
// the pack's strongestNuke Greater Runebolt (115 on paper, about 69 at spec 1, 20 s timer) wins. runemaster({ lines }) keeps
// the nukes to the lines it is built in; the default is the Darkness nuker's.
// learnings/classes/runemaster.md has the spells, the server code and what is open.

import type { TacticsSettings } from '../group/behaviors';
import type { Character } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import type { SpellPick } from '../group/spells';
import { quickcastUnderFire } from './cabalist';
import { nukeInReach, steppingAssist } from './spiritmaster';
import { wallStep } from './healer-stand';

/** The Darkness nuker's lines (bots/gudrun/build.ts: Darkness 24): baseline Darkness and the spec line, Runes of Darkness. */
export const DARKNESS_LINES: readonly string[] = ['Darkness', 'Runes of Darkness'];

/** Whether a damage spell is one to cast: from one of `lines`, or not damage at all (debuffs, buffs, the root stay as they are). */
export function onLines(s: Pick<SpellPick, 'type' | 'target'> & { spell: { lineName: string } }, lines: readonly string[]): boolean {
    const damage = s.target === 'Enemy' && /Damage|Bolt|Lifedrain/i.test(s.type);
    return !damage || lines.includes(s.spell.lineName);
}

/**
 * `inner` with a Spellbook that sees only damage spells from `lines`: everything that picks a nuke (assist, nukeInReach,
 * quickcast) reads ctx.spells.all() through it. The member context and its book are left as they are; this is a view.
 */
export function onlyLines<S extends TacticsSettings>(inner: Behavior<S>, lines: readonly string[]): Behavior<S> {
    const views = new WeakMap<object, MemberContext<S>>();
    const view = (ctx: MemberContext<S>): MemberContext<S> => {
        let v = views.get(ctx);
        if (!v) {
            const book = ctx.spells;
            const spells = Object.create(book, { all: { value: () => book.all().filter(s => onLines(s, lines)) } });
            v = Object.create(ctx, { spells: { value: spells } }) as MemberContext<S>;
            views.set(ctx, v);
        }
        return v;
    };
    return { ...inner, run: ctx => inner.run(view(ctx)) };
}

export function runemaster(opts: { lines?: readonly string[] } = {}): Character {
    const lines = opts.lines ?? DARKNESS_LINES;
    return {
        role: 'nuker',
        instant: [onlyLines(quickcastUnderFire(), lines)],
        urgent: [wallStep()],
        fight: [onlyLines(steppingAssist(), lines), onlyLines(nukeInReach(), lines)],
    };
}
