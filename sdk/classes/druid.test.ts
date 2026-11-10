import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import type { MemberReport } from '../group/types';
import type { Contact } from '../group/types';
import { diverTarget, druid, groupHealTargets, hurtOutOfReach } from './druid';
import { reachOfBuild } from './reach';

const member = (name: string, hp: number, o: Partial<MemberReport> = {}) => ({ name, hp, maxHp: 700, x: 0, y: 0, regionId: 238, isDead: false, ...o }) as MemberReport;

describe('druid kit', () => {
    test('the healer role, the group heal in her list', () => {
        const k = druid();
        expect(k.role).toBe('healer');
        expect(k.fight).toBeUndefined();
        const names = withCharacter(packBehaviors().healer, k).map(b => b.name);
        // Above her single heals, below the emergency one.
        expect(names.indexOf('groupHeal')).toBeGreaterThan(names.indexOf('emergencyHeal'));
        expect(names.indexOf('groupHeal')).toBeLessThan(names.indexOf('heal'));
        expect(names.indexOf('rootDiver')).toBe(names.indexOf('groupHeal') - 1);
        // The Nearsight cure in her idle turns, below heal and crowd control.
        expect(names.indexOf('cureNearsight')).toBeGreaterThan(names.indexOf('heal'));
        expect(names.indexOf('cureNearsight')).toBeLessThan(names.indexOf('shedLoad'));
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

describe('druid rootDiver', () => {
    const members = [{ name: 'Cuchulainn', role: 'tank' as const }, { name: 'Oisin', role: 'support' as const }, { name: 'Niamh', role: 'nuker' as const }];
    const dist = (c: Contact) => Math.hypot(c.x, c.y);
    const melee = (id: number, target: string, o: Partial<Contact> = {}) => ({ objectId: id, kind: 'player', regionId: 238, x: 800, y: 0, stale: false, cc: null, swinging: true, target, targetBySpell: false, ...o }) as Contact;
    const orders = { focus: 9, cc: [] as { targetId: number }[] };

    test('the melee on our Bard before the one on a nuker, though farther', () => {
        expect(diverTarget([melee(1, 'Niamh', { x: 300 }), melee(2, 'Oisin', { x: 1200 })], members, 238, dist, 1500, orders, 0)?.objectId).toBe(2);
        expect(diverTarget([melee(1, 'Niamh')], members, 238, dist, 1500, orders, 0)?.objectId).toBe(1);
    });

    test('not one on the tank, a caster, the focus, one being crowd-controlled or assigned, root-immune, or out of reach', () => {
        const none = (c: Contact, o = orders) => expect(diverTarget([c], members, 238, dist, 1500, o, 0)).toBeNull();
        none(melee(1, 'Cuchulainn'));
        none(melee(1, 'Oisin', { targetBySpell: true }));
        none(melee(1, 'Oisin', { swinging: false }));
        none(melee(9, 'Oisin'));
        none(melee(1, 'Oisin', { cc: { by: 'Niamh', kind: 'mezz', until: 9000 } }));
        none(melee(1, 'Oisin'), { focus: 9, cc: [{ targetId: 1 }] });
        none(melee(1, 'Oisin', { ccImmune: { root: 5000 } }));
        none(melee(1, 'Oisin', { x: 1460 }));
    });
});

describe('druid reachHurt', () => {
    const me = { x: 0, y: 0, regionId: 238, name: 'Brigid' };
    const limit = (m: MemberReport) => (m.role === 'tank' ? 80 : 78);
    test('the most hurt member between 2000 and 3500 away, below its threshold', () => {
        const ms = [member('a', 50, { x: 2500 }), member('b', 30, { x: 3000 }), member('c', 20, { x: 1500 }), member('d', 10, { x: 4000 }), member('e', 90, { x: 2200 })];
        expect(hurtOutOfReach(me, ms, limit)?.name).toBe('b');
    });
    test('none when the hurt are in reach, too far, dead, or herself', () => {
        expect(hurtOutOfReach(me, [member('c', 20, { x: 1500 }), member('d', 10, { x: 4000 }), member('f', 10, { x: 2500, isDead: true }), member('Brigid', 10, { x: 2500 })], limit)).toBeNull();
    });
});
