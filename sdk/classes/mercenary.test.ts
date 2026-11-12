import { describe, expect, test } from 'bun:test';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { fighterStyle } from '../group/styles';
import { mercenary, mercenaryStyle } from './mercenary';
import { FOE, KIT_WEAPONS, kitStyles, seenBy, swing } from './style-fixtures';

const styles = kitStyles('Mercenary', 'Pure damage');
const swords = KIT_WEAPONS.Mercenary;

describe('mercenary kit', () => {
    test('a melee whose fight is assistMelee, once in every list', () => {
        expect(mercenary().role).toBe('melee');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.melee as Behavior<any>[], mercenary()).map(b => b.name);
            expect(list.filter(n => n === 'assistMelee')).toHaveLength(1);
        }
    });

    test('at a player on someone else: the back positional, and a taunt style\'s damage as the plain swing, not Uppercut', () => {
        const held = seenBy(styles, swords, { events: [swing(FOE, 9, 'hit', Date.now())] });
        expect(fighterStyle()(held)).toEqual(["Shadow's Edge", 'Uppercut']);
        const q = mercenaryStyle(held) as string[];
        expect(q[0]).toBe("Shadow's Edge");
        expect(['Inflame', 'Enrage']).toContain(q[1]!);
    });

    test('a monster on someone else keeps the fighter\'s pick: no taunt pulls it off the tank', () => {
        const held = seenBy(styles, swords, { kind: 'npc', targetOn: 9 });
        expect(mercenaryStyle(held)).toEqual(fighterStyle()(held));
        expect(mercenaryStyle(held)).not.toContain('Inflame');
    });

    test('no shield: the Shields styles are never queued', () => {
        for (const o of [{}, { events: [swing(FOE, 9, 'hit', Date.now())] }]) {
            const q = mercenaryStyle(seenBy(styles, swords, o)) as string[];
            expect(q.some(n => ['Numb', 'Stun', 'Disable'].includes(n))).toBe(false);
        }
    });
});
