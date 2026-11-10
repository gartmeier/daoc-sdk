import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { withCharacter } from '../group/character';
import { rvrBehaviors } from '../group/rvr';
import { ANYTIME_STYLE, fighterStyle } from '../group/styles';
import { EquipmentSlot, ObjectType, type CombatResult, type Style } from '../types';
import { armsman, lineStyle } from './armsman';
import { reachOfBuild } from './reach';

// Gawain's styles at 24 as the server describes them, from the static data (as hero.test.ts does).
const RESULTS: Record<number, CombatResult> = { 3: 'parry', 4: 'block' };
const OPENINGS = ['offensive', 'defensive', 'positional'] as const;
const taunt = (id: number) => { const sp = getSpell(id); return !sp || !/taunt/i.test(sp.type) ? '' : `${sp.value! < 0 ? 'decreases' : 'increasing'} your threat`; };
const known = reachOfBuild(getBuild('Armsman', 'Polearm hybrid')!, 24).styles;
const nameOf = (id: number) => known.find(s => s.id === id)?.name ?? null;
const styles: Style[] = known.map(s => ({
    name: s.name, internalId: s.id, specLevel: s.specLevelRequirement, specName: s.specKeyName, skillIndex: s.id,
    prerequisite: s.openingRequirementType === 0 && !s.attackResultRequirement ? ANYTIME_STYLE : 0,
    details: {
        fatigue: s.enduranceCost, attackMod: 0, defensiveMod: 0, openingDamage: s.growthRate * 200, opening: OPENINGS[s.openingRequirementType]!,
        result: RESULTS[s.attackResultRequirement] ?? (s.attackResultRequirement === 7 ? 'styledHit' : s.attackResultRequirement ? 'other' : null), position: null,
        openingStyle: s.attackResultRequirement === 7 ? nameOf(s.openingRequirementValue) : null, followUps: [],
        weapon: s.specKeyName === 'Shields' ? 'Shield' : s.specKeyName, stealth: false, procSpellId: s.procs?.[0]?.spellId ?? null,
        ...(s.procs?.[0] ? { procSpell: { description: taunt(s.procs[0].spellId) } } : {}),
    },
}) as Style);
// What the gear template has him wear: sword, large shield, and the halberd in the two-hand slot.
const worn = [
    { slot: EquipmentSlot.RightHand, objectType: ObjectType.SlashingWeapon },
    { slot: EquipmentSlot.LeftHand, objectType: ObjectType.Shield },
    { slot: EquipmentSlot.TwoHand, objectType: ObjectType.PolearmWeapon },
] as never;

const ME = 1, FOE = 2, MATE = 3;
const seen = (o: { on?: number; messages?: string[] } = {}) => ({
    target: { objectId: FOE, kind: 'player', ...(o.on ? { targetObjectId: o.on } : {}) } as never,
    player: { objectId: ME, endurancePercent: 100 } as never,
    state: { equipment: worn, combatEvents: [], gameMessages: (o.messages ?? []).map(text => ({ text })) } as never,
    styles,
});

describe('the armsman kit', () => {
    test('a pick from everything he wears queues the shield\'s Disable beside the halberd: the swap the kit avoids', () => {
        expect(fighterStyle({ saveEndurance: 15 })(seen({ on: MATE }))).toContain('Disable');
    });

    test('from the polearm line: Executioner before Crippling Blow; on someone else, Defender\'s Cross', () => {
        const pick = lineStyle('Polearm');
        expect(pick(seen())).toEqual(['Executioner', 'Crippling Blow']);
        expect(pick(seen({ on: MATE }))).toEqual(["Defender's Cross", 'Crippling Blow']);
        for (const q of [pick(seen()), pick(seen({ on: MATE }))]) for (const n of q as string[]) expect(styles.find(s => s.name === n)?.details?.weapon).toBe('Polearm');
    });

    test('a landed Defender\'s Cross brings Disabler, a landed Defender\'s Faith Defender\'s Courage', () => {
        const after = (style: string) => ({ ...seen(), state: { equipment: worn, combatEvents: [{ id: 1, kind: 'melee', attackerObjectId: ME, targetObjectId: FOE, result: 'styledHit', receivedAt: 1 }], gameMessages: [{ text: `You perform your ${style} perfectly!` }] } as never });
        expect((lineStyle('Polearm')(after("Defender's Cross")) as string[])[0]).toBe('Disabler');
        expect((lineStyle('Polearm')(after("Defender's Faith")) as string[])[0]).toBe("Defender's Courage");
    });

    test('its fight replaces the tank\'s and keeps the role list around it', () => {
        const list = withCharacter(rvrBehaviors().tank, armsman()).map(b => b.name);
        expect(list.filter(n => n === 'tank')).toHaveLength(1);
        expect(list).toEqual(rvrBehaviors().tank.map(b => b.name));
        expect(armsman().role).toBe('tank');
    });
});
