import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { reachOfBuild } from './reach';
import type { Contact } from '../group/types';
import { bard, castersToCut } from './bard';

describe('bard kit', () => {
    test('the support role, with the mezz cure below flee and above interrupt, crowd control and songs in the pack', () => {
        expect(bard().role).toBe('support');
        const names = withCharacter(packBehaviors().support, bard()).map(b => b.name);
        expect(names.indexOf('cureMezz')).toBeGreaterThan(names.indexOf('flee'));
        for (const main of ['interrupt', 'crowdControl', 'song']) expect(names.indexOf('cureMezz')).toBeLessThan(names.indexOf(main));
    });

    test('Nurture support reaches Clarifying Harmonies at 24, single target, which cureMezz casts', () => {
        const cure = reachOfBuild(getBuild('Bard', 'Nurture support')!, 24).unused.find(k => k.info.type === 'CureMezz');
        expect(cure?.name).toBe('Clarifying Harmonies');
        expect(cure!.info.radius).toBe(0);
        expect(cure!.info.range).toBe(1500);
    });
});

describe('bard interruptOnTheRun', () => {
    test('in the pack list above flee, the cure still above interrupt', () => {
        const names = withCharacter(packBehaviors().support, bard()).map(b => b.name);
        expect(names.indexOf('interruptOnTheRun')).toBe(names.indexOf('flee') - 1);
        expect(names.indexOf('cureMezz')).toBeLessThan(names.indexOf('interrupt'));
    });

    const roles = new Map([['Oisin', 'support'], ['Brigid', 'healer'], ['Niamh', 'nuker']] as const);
    const foe = (id: number, o: Partial<Contact> = {}) => ({ objectId: id, kind: 'player', stale: false, cc: null, castingAt: 1000, target: null, targetBySpell: false, ...o }) as Contact;

    test('a cast at our healer before one at a nuker, before the rest; none mezzed or stale', () => {
        const list = [foe(1), foe(2, { target: 'Niamh', targetBySpell: true }), foe(3, { target: 'Brigid', targetBySpell: true }), foe(4, { cc: { by: 'Oisin', kind: 'mezz', until: 9000 } }), foe(5, { castingAt: -2000 })];
        expect(castersToCut(list, roles, true, 2000).map(c => c.objectId)).toEqual([3, 2, 1]);
    });

    test('before the engage only a cast at one of ours', () => {
        expect(castersToCut([foe(1), foe(2, { target: 'Niamh', targetBySpell: true })], roles, false, 2000).map(c => c.objectId)).toEqual([2]);
    });
});
