import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { reachOfBuild } from './reach';
import { bard } from './bard';

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
