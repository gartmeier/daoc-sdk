import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import { enemy, report } from '../group/fixtures';
import type { Behavior } from '../group/member';
import { packBehaviors } from '../group/pack';
import { rvrBehaviors } from '../group/rvr';
import { minstrel, stunTarget } from './minstrel';
import { reachOfBuild } from './reach';

const build = reachOfBuild(getBuild('Minstrel', 'Group thrust')!, 24);
const ME = { name: 'Tristan', x: 0, y: 0, regionId: 1 };
const members = [
    report('Tristan', { role: 'support', x: 0, y: 0, regionId: 1 }),
    report('Elaine', { role: 'healer', x: 1000, y: 0, regionId: 1 }),
    report('Merlin', { role: 'nuker', x: 0, y: 1000, regionId: 1 }),
    report('Gawain', { role: 'tank', x: 500, y: 500, regionId: 1 }),
];
const near = () => 500;
const foe = (id: number, over = {}) => enemy(id, 'midgard', { regionId: 1, ...over });

describe('minstrel kit', () => {
    test('at 24 the support list mezzes with Constraining Cadence and sings; Stunning Shout and Dischordant Wail are instants', () => {
        expect(build.cc?.spell.name).toBe('Constraining Cadence');
        expect(build.songs.map(s => s.kind).sort()).toEqual(['health', 'power', 'speed']);
        const shout = build.known.filter(k => k.info.type === 'Stun').at(-1)!;
        expect([shout.name, shout.info.castTime, shout.info.range]).toEqual(['Stunning Shout', 0, 700]);
        expect(build.nukes.map(n => [n.spell.name, n.castTime])).toContainEqual(['Dischordant Wail', 0]);
    });

    test('support; the shout and the Wail above flee, interrupt above position, in every list', () => {
        expect(minstrel().role).toBe('support');
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withCharacter(lists.support as Behavior<any>[], minstrel()).map(b => b.name);
            const flee = list.indexOf('flee');
            expect(flee).toBeGreaterThan(0);
            expect(list.indexOf('stunShout')).toBeLessThan(flee);
            expect(list.indexOf('interruptOnTheRun')).toBeLessThan(flee);
            expect(list.indexOf('interrupt')).toBeGreaterThan(flee);
        }
    });

    test('the stun goes on the one hitting our healer before the one on him, him before another soft member, then a caster', () => {
        const onHealer = foe(1, { target: 'Elaine', x: 1100, y: 0 });
        const onMe = foe(2, { target: 'Tristan', x: 100, y: 0 });
        const onNuker = foe(3, { target: 'Merlin', x: 0, y: 1100 });
        const casting = foe(4, { castingAt: Date.now() });
        const all = [casting, onNuker, onMe, onHealer];
        expect(stunTarget(all, members, ME, near, 700, new Map())?.objectId).toBe(1);
        expect(stunTarget(all.slice(0, 3), members, ME, near, 700, new Map())?.objectId).toBe(2);
        expect(stunTarget(all.slice(0, 2), members, ME, near, 700, new Map())?.objectId).toBe(3);
        expect(stunTarget(all.slice(0, 1), members, ME, near, 700, new Map())?.objectId).toBe(4);
    });

    test('never on one on the tank alone, out of range, crowd-controlled, immune, or stunned by us lately', () => {
        const now = Date.now();
        const onMe = (over = {}) => foe(2, { target: 'Tristan', x: 100, y: 0, ...over });
        expect(stunTarget([foe(5, { target: 'Gawain', x: 500, y: 500 })], members, ME, near, 700, new Map())).toBeNull();
        expect(stunTarget([onMe()], members, ME, () => 800, 700, new Map())).toBeNull();
        expect(stunTarget([onMe({ cc: { by: 'x', kind: 'mezz', until: now + 9000 } })], members, ME, near, 700, new Map())).toBeNull();
        expect(stunTarget([onMe({ ccImmune: { stun: now + 30_000 } })], members, ME, near, 700, new Map())).toBeNull();
        expect(stunTarget([onMe()], members, ME, near, 700, new Map([[2, now + 30_000]]))).toBeNull();
        // Its target is the healer, but it stands far from her: a spell, not a melee on her.
        expect(stunTarget([foe(1, { target: 'Elaine', x: -2000, y: 0 })], members, ME, near, 700, new Map())).toBeNull();
    });
});
