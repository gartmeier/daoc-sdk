import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { enemy, report } from '../group/fixtures';
import { reachOfBuild } from './reach';
import { isNearsightEffect, nearsightCalm, nearsightedMember, slowSpell, slowTarget } from './healer';

const at = (x: number) => ({ x, y: 1000, z: 0 });
const me = report('Sigrid', { role: 'healer', ...at(1000) });
const members = [me, report('Thorgrim', { role: 'tank', ...at(3000) }), report('Hrafna', { role: 'nuker', ...at(2000) })];
const near = () => 500;

describe('healer kit: Hinder Spirit', () => {
    test('Mending first has the instant slow at 24, and slowSpell picks it', () => {
        const k = reachOfBuild(getBuild('Healer', 'Mending first')!, 24).known.find(k => k.name === 'Hinder Spirit')!;
        expect(k.info.type).toBe('CombatSpeedDebuff');
        const pick = { spell: { name: 'Hinder Spirit', level: 2, cooldownRemaining: 0 }, type: 'CombatSpeedDebuff', target: 'Enemy', range: 1500, radius: 0, power: 2, castTime: 0, duration: 20 } as any;
        expect(slowSpell([pick], 10)?.spell.name).toBe('Hinder Spirit');
        expect(slowSpell([{ ...pick, spell: { ...pick.spell, cooldownRemaining: 3 } }], 10)).toBeNull();
        expect(slowSpell([pick, { ...pick, radius: 350, spell: { ...pick.spell, name: 'Field', level: 20 } }], 10)?.spell.name).toBe('Hinder Spirit');
    });

    test('the melee on her first, then one on a caster; never the tank\'s, nor one still slowed', () => {
        const onMe = enemy(1, 'hibernia', { target: 'Sigrid', ...at(1050) });
        const onCaster = enemy(2, 'hibernia', { target: 'Hrafna', ...at(2050) });
        const onTank = enemy(3, 'hibernia', { target: 'Thorgrim', ...at(3050) });
        const now = 1_000_000;
        expect(slowTarget(me, members, [onTank, onCaster, onMe], new Map(), near, 1500, now)?.objectId).toBe(1);
        expect(slowTarget(me, members, [onTank, onCaster], new Map(), near, 1500, now)?.objectId).toBe(2);
        expect(slowTarget(me, members, [onTank], new Map(), near, 1500, now)).toBeNull();
        expect(slowTarget(me, members, [onCaster], new Map([[2, now + 5000]]), near, 1500, now)).toBeNull();
        expect(slowTarget(me, members, [onCaster], new Map(), () => 1600, 1500, now)).toBeNull();
        const pet = { ...enemy(4, 'albion', { target: 'Sigrid', ...at(1050) }), kind: 'npc' as const, isPet: true, name: 'emerald simulacrum' };
        expect(slowTarget(me, members, [onCaster, pet], new Map(), near, 1500, now)?.objectId).toBe(4);
        expect(slowTarget(me, members, [{ ...pet, isPet: false }], new Map(), near, 1500, now)).toBeNull();
    });
});

describe('healer kit: Cure Nearsight', () => {
    test('Obscuring Dust reads as Nearsight, a buff does not', () => {
        expect(isNearsightEffect('Obscuring Dust')).toBe(true);
        expect(isNearsightEffect('Evasion')).toBe(false);
    });

    test('our nuker first, then a healer; only in 3D reach', () => {
        const dusted = { effects: ['Obscuring Dust'] };
        const nuker = report('Hrafna', { role: 'nuker', ...at(2000), ...dusted });
        const shaman = report('Ulfgar', { role: 'healer', ...at(1500), ...dusted });
        expect(nearsightedMember(me, [me, shaman, nuker], 1500)?.name).toBe('Hrafna');
        expect(nearsightedMember(me, [me, shaman], 1500)?.name).toBe('Ulfgar');
        expect(nearsightedMember(me, [me, { ...nuker, z: 1400 }], 1500)).toBeNull();
        expect(nearsightedMember(me, [me, { ...nuker, effects: [] }], 1500)).toBeNull();
    });

    test('only when nobody of ours is under half health', () => {
        expect(nearsightCalm([me, report('Hrafna', { hp: 60 })])).toBe(true);
        expect(nearsightCalm([me, report('Hrafna', { hp: 45 })])).toBe(false);
        expect(nearsightCalm([me, report('Hrafna', { hp: 45, isDead: true })])).toBe(true);
    });
});
