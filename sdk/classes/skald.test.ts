import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter, type Character } from '../group/character';
import { enemy, report } from '../group/fixtures';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { reachOfBuild } from './reach';
import { shoutMezzTarget, skald } from './skald';

const members = [
    report('Thorgrim', { role: 'tank' }),
    report('Sigrid', { role: 'healer' }),
    report('Bragi', { role: 'melee', attacking: true, targetId: 7 }),
];
const near = () => 500;
const none = { focus: null, cc: [] };

describe('skald kit', () => {
    test('Crippling Shout is the instant mezz a Skald has at 24', () => {
        const cc = reachOfBuild(getBuild('Skald', 'Even songs and Hammer')!, 24).cc!;
        expect(cc.spell.name).toBe('Crippling Shout');
        expect(cc.castTime).toBe(0);
        expect(cc.range).toBe(700);
    });

    test('the shout goes into the melee list above its fight', () => {
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.melee as Behavior<any>[], skald() as Character).map(b => b.name);
            expect(list.indexOf('shoutMezz')).toBeGreaterThanOrEqual(0);
            expect(list.indexOf('shoutMezz')).toBeLessThan(list.findIndex(n => n === 'assistMelee' || n === 'assist'));
        }
    });

    test('it peels the enemy on our healer first, then a healer', () => {
        const onHealer = enemy(1, 'hibernia', { target: 'Sigrid' });
        const healer = enemy(2, 'hibernia', { healer: true });
        const onTank = enemy(3, 'hibernia', { target: 'Thorgrim' });
        expect(shoutMezzTarget([onTank, healer, onHealer], members, none, near, 700)?.objectId).toBe(1);
        expect(shoutMezzTarget([onTank, healer], members, none, near, 700)?.objectId).toBe(2);
        expect(shoutMezzTarget([onTank], members, none, near, 700)).toBeNull();
    });

    test('never the focus, an ordered or controlled one, one we hit, or one out of reach', () => {
        const c = (id: number, over = {}) => enemy(id, 'hibernia', { target: 'Sigrid', ...over });
        expect(shoutMezzTarget([c(1)], members, { focus: 1, cc: [] }, near, 700)).toBeNull();
        expect(shoutMezzTarget([c(1)], members, { focus: null, cc: [{ by: 'Sigrid', targetId: 1 }] }, near, 700)).toBeNull();
        expect(shoutMezzTarget([c(1, { cc: { kind: 'mezz', by: 'Sigrid', until: Date.now() + 9000 } })], members, none, near, 700)).toBeNull();
        expect(shoutMezzTarget([c(7)], members, none, near, 700)).toBeNull();
        expect(shoutMezzTarget([c(1)], members, none, () => 900, 700)).toBeNull();
    });
});
