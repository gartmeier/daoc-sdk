import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import type { MemberReport } from '../group/types';
import { druid, groupHealTargets } from './druid';
import { reachOfBuild } from './reach';

const member = (name: string, hp: number, o: Partial<MemberReport> = {}) => ({ name, hp, maxHp: 700, x: 0, y: 0, regionId: 238, isDead: false, ...o }) as MemberReport;

describe('druid kit', () => {
    test('the healer role, the group heal in her list', () => {
        const k = druid();
        expect(k.role).toBe('healer');
        expect(k.fight).toBeUndefined();
        expect(withCharacter(packBehaviors().healer, k).map(b => b.name)).toContain('groupHeal');
    });

    test('Heal druid reaches Renewing Conflux at 24: a group heal, no radius, which heal() never picks over Major Restoration', () => {
        const r = reachOfBuild(getBuild('Druid', 'Heal druid')!, 24);
        const conflux = r.known.find(k => k.name === 'Renewing Conflux')!;
        expect(conflux.info.target).toBe('Group');
        expect(conflux.info.radius).toBe(0);
        const restoration = getSpell(r.known.find(k => k.name === 'Major Restoration')!.info.id)!;
        expect(restoration.value! > conflux.info.value! && restoration.power < conflux.info.power).toBe(true);
    });

    test('a member counts when it misses most of the heal, within its range', () => {
        const ms = [member('a', 100), member('b', 85), member('c', 80, { x: 2500 }), member('d', 50, { isDead: true }), member('e', 70)];
        // 139 * 0.7 = 97 missing: below about 86 % of 700.
        expect(groupHealTargets({ x: 0, y: 0, regionId: 238 }, ms, 2000, 139).map(m => m.name)).toEqual(['b', 'e']);
    });
});
