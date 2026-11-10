import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import type { BotActions } from '../actions';
import { withCharacter } from '../group/character';
import type { MemberContext } from '../group/member';
import { rvrBehaviors } from '../group/rvr';
import { Spellbook } from '../group/spells';
import type { BotSDK } from '../index';
import { reachOfBuild } from './reach';
import { castingFrom, plainNukesFirst, withSpellView, wizard } from './wizard';

/** Vivien's Spellbook at 24 (Cold 24), her skill list in `order` of names first: the tie between Ice Blast and Entangling Haze is decided by it. */
function bookOf(first: string[] = []): Spellbook {
    const known = reachOfBuild(getBuild('Wizard', 'Ice')!, 24).known;
    const sorted = [...known].sort((a, b) => Number(first.includes(b.name)) - Number(first.includes(a.name)));
    const spells = sorted.map(k => ({ name: k.name, level: k.level, internalId: k.info.id, lineName: k.line, lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 }));
    const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana: 500, maxHealth: 600, level: 24 }) } as unknown as BotSDK;
    const bot = { getSpellInfo: (s: { internalId: number }) => getSpell(s.internalId) ?? null } as unknown as BotActions;
    return new Spellbook(sdk, bot);
}

const ctxWith = (spells: Spellbook) => ({ spells, name: 'Vivien', hello(this: { name: string }) { return this.name; } }) as unknown as MemberContext;

describe('the wizard kit', () => {
    test('with Entangling Haze first in her skill list the plain book picks it; her view picks Ice Blast', () => {
        const book = bookOf(['Entangling Haze (Minor)']);
        expect(book.nuke()?.spell.name).toBe('Entangling Haze (Minor)');
        const seen = withSpellView(ctxWith(book), plainNukesFirst);
        expect(seen.spells.nuke()?.spell.name).toBe('Ice Blast (Minor)');
        expect(seen.spells.root()?.spell.name).toBe('Fingers Of Ice (Lesser)');
        // The rest of the context is the member's own.
        expect((seen as any).hello()).toBe('Vivien');
    });

    test('the snare nuke stays when it is her only direct damage', () => {
        const all = bookOf().all();
        expect(plainNukesFirst(all).some(s => s.spell.name === 'Entangling Haze (Minor)')).toBe(false);
        const onlyHaze = all.filter(s => s.spell.name !== 'Ice Blast (Minor)' && s.type !== 'DirectDamage');
        expect(plainNukesFirst(onlyHaze).some(s => s.spell.name === 'Entangling Haze (Minor)')).toBe(true);
    });

    test('castingFrom hands the behaviour the view', async () => {
        let picked: string | undefined;
        const b = castingFrom({ name: 'assist', run: async ctx => { picked = ctx.spells.nuke()?.spell.name; return true; } }, plainNukesFirst);
        await b.run(ctxWith(bookOf(['Entangling Haze (Minor)'])));
        expect(picked).toBe('Ice Blast (Minor)');
        expect(b.name).toBe('assist');
    });

    test('quickcast above flee, giveGround above her fight, no melee debuff', () => {
        const list = withCharacter(rvrBehaviors().nuker, wizard()).map(b => b.name);
        expect(list.indexOf('quickcast')).toBe(list.indexOf('flee') - 1);
        expect(list.indexOf('giveGround')).toBeLessThan(list.indexOf('assist'));
        expect(list.indexOf('offFocus')).toBe(list.indexOf('assist') + 1);
        expect(list).not.toContain('meleeDebuff');
        expect(withCharacter(rvrBehaviors().nuker, wizard({ giveGround: false })).map(b => b.name)).not.toContain('giveGround');
    });
});
