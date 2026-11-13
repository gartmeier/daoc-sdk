import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { withCharacter } from '../group/character';
import { enemy } from '../group/fixtures';
import { packBehaviors } from '../group/pack';
import { pickNuke, type SpellPick } from '../group/spells';
import type { Contact } from '../group/types';
import { ELDRITCH_NUKE_LINES, eldritch, veilTarget } from './eldritch';
import { reachOfBuild } from './reach';
import { onLines } from './runemaster';

// The live line names (Lugh's skills, 2026-11-10): the data's 'Light Magic' baseline is 'Way of the Sun', its spec 'Shadow
// Control'; 'Void Magic' baseline 'Way of the Eclipse'; 'Mana Magic' baseline 'Way of the Moon', its spec 'Vacuumancy'.
const LIVE_LINE: Record<string, [string, string]> = { 'Light Magic': ['Way of the Sun', 'Shadow Control'], 'Void Magic': ['Way of the Eclipse', 'Void Mastery'], 'Mana Magic': ['Way of the Moon', 'Vacuumancy'] };
const picks = (): SpellPick[] => reachOfBuild(getBuild('Eldritch', 'Light nuker')!, 24).known.map(k => ({
    spell: { name: k.name, level: k.level, lineName: LIVE_LINE[k.line]![k.baseline ? 0 : 1], internalId: 0, lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 },
    type: k.info.type, target: k.info.target, range: k.info.range, radius: k.info.radius, power: k.info.power, castTime: k.info.castTime, duration: k.info.duration,
    recast: k.info.recastDelay ?? 0, concentration: k.info.concentration, pulse: false, value: k.info.value ?? 0, damage: k.info.damage ?? 0,
    spellGroup: k.info.spellGroup ?? 0, damageType: k.info.damageType ?? 0, effectGroup: k.info.effectGroup ?? 0, frequency: 0, icon: 0,
}) as unknown as SpellPick);

const foe = (id: number, x: number, y = 10_000, over: Partial<Contact> = {}) => enemy(id, 'albion', { regionId: 1, x, y, ...over });

describe('eldritch kit', () => {
    test('off his lines the pack\'s strongestNuke takes Void Fissure; on them Shadowcrash, by damage and by level', () => {
        expect(pickNuke(picks(), { byDamage: true })?.spell.name).toBe('Void Fissure');
        const mine = picks().filter(s => onLines(s, ELDRITCH_NUKE_LINES));
        expect(pickNuke(mine, { byDamage: true })?.spell.name).toBe('Shadowcrash');
        expect(pickNuke(mine)?.spell.name).toBe('Sun Streak');
        // The stun, the area mezz and the debuffs aren't damage: the view keeps them.
        expect(mine.map(s => s.spell.name)).toEqual(expect.arrayContaining(['Prismatic Flash', 'Paralyzing Veil', 'Nullify Sight']));
    });

    test('the veil: the target that catches most, two at least, never round the focus or another\'s assignment', () => {
        const d = () => 1000;
        const three = [foe(1, 10_000), foe(2, 10_200), foe(3, 10_100, 10_150, { healer: true } as any), foe(9, 14_000)];
        const r = veilTarget(three, { focus: 9, cc: [] }, 'Lugh', 350, 1500, d);
        expect(r?.caught.map(c => c.objectId).sort()).toEqual([1, 2, 3]);
        // The focus in the radius: none (our damage would wake them).
        expect(veilTarget(three, { focus: 2, cc: [] }, 'Lugh', 350, 1500, d)).toBeNull();
        // The Bard's assignment among them: none.
        expect(veilTarget(three, { focus: 9, cc: [{ targetId: 3, by: 'Oisin' }] }, 'Lugh', 350, 1500, d)).toBeNull();
        // One alone: none.
        expect(veilTarget([foe(1, 10_000), foe(9, 14_000)], { focus: 9, cc: [] }, 'Lugh', 350, 1500, d)).toBeNull();
        // Out of range: none.
        expect(veilTarget(three, { focus: 9, cc: [] }, 'Lugh', 350, 1500, () => 1400)).toBeNull();
    });

    test('a nuker: Flash and quickcast above flee, the stun and the veil above his heal, assist and offFocus as the Mentalist\'s', () => {
        const k = eldritch();
        expect(k.role).toBe('nuker');
        const list = withCharacter(packBehaviors().nuker, k).map(b => b.name);
        expect(list.indexOf('quickFlash')).toBeLessThan(list.indexOf('flee'));
        expect(list.indexOf('veil')).toBe(list.indexOf('stunCaster') + 1);
        expect(list.indexOf('veil')).toBeLessThan(list.indexOf('emergencyHeal'));
        expect(list.indexOf('offFocus')).toBe(list.indexOf('assist') + 1);
        expect(eldritch({ areaMezz: false }).urgent!.map(b => b.name)).toEqual(['stunCaster', 'wallStep']);
    });

    test('the veil waits while an enemy aims at him', async () => {
        const v = eldritch().urgent![1]!;
        const ctx: any = { threats: () => [{ stale: false, cc: false, target: 'Lugh' }], name: 'Lugh', orders: () => { throw new Error('ran'); } };
        expect(await v.run(ctx)).toBe(false);
    });
});
