import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { withCharacter } from '../group/character';
import { rvrBehaviors } from '../group/rvr';
import { selfBuffDue } from './paladin';
import { reachOfBuild } from './reach';
import { sorcerer, SORCERER_SELF_BUFFS } from './sorcerer';

const picks = () => reachOfBuild(getBuild('Sorcerer', 'Balanced body and mind')!, 24).known
    .map(k => ({ spell: { name: k.name, level: k.level } as any, type: k.info.type, target: k.info.target }));

describe('the sorcerer kit', () => {
    test('keeps Shield Mind up: mezzes on him 10 % shorter', () => {
        expect(selfBuffDue(picks(), [], SORCERER_SELF_BUFFS)?.spell.name).toBe('Shield Mind');
        expect(selfBuffDue(picks(), ['Shield Mind'], SORCERER_SELF_BUFFS)).toBeNull();
    });

    test('selfBuff goes below the group\'s chores', () => {
        const list = withCharacter(rvrBehaviors().nuker, sorcerer({ saveBelow: 0, chores: [{ name: 'song', run: () => false }] })).map(b => b.name);
        expect(list.indexOf('selfBuff')).toBe(list.indexOf('song') + 1);
        expect(list.indexOf('selfBuff')).toBeGreaterThan(list.indexOf('assist'));
    });
});
