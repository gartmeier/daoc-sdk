import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { withCharacter } from '../group/character';
import { packBehaviors } from '../group/pack';
import { ANYTIME_STYLE } from '../group/styles';
import { EquipmentSlot, ObjectType, type CombatEvent, type CombatResult, type Style } from '../types';
import { BLADEMASTER_STUNS, blademaster, bladeStunQueue, bladeStyle, tripleWieldNow, TRIPLE_WIELD_REUSE_MS, waitOf } from './blademaster';
import { STUN_IMMUNE_MS, type StunLog } from './hero';
import { reachOfBuild } from './reach';

// The styles as the server describes them, from the static data (as hero.test.ts does).
const RESULTS: Record<number, CombatResult> = { 3: 'parry', 4: 'block', 5: 'evade' };
const OPENINGS = ['offensive', 'defensive', 'positional'] as const;
/** A proc as the server describes it (StyleTaunt.cs words a taunt and a detaunt; anything else, its own words, here none). */
const taunt = (id: number) => { const sp = getSpell(id); return !sp || !/taunt/i.test(sp.type) ? '' : `${sp.value! < 0 ? 'decreases' : 'increasing'} your threat`; };
const build = () => reachOfBuild(getBuild('Blademaster', 'Group damage with Slam')!, 24);
const styles: Style[] = build().styles.map(s => ({
    name: s.name, internalId: s.id, specLevel: s.specLevelRequirement, specName: s.specKeyName, skillIndex: s.id,
    prerequisite: s.openingRequirementType === 0 && !s.attackResultRequirement ? ANYTIME_STYLE : 0,
    details: {
        fatigue: s.enduranceCost, attackMod: 0, defensiveMod: 0, openingDamage: s.growthRate * 200, opening: OPENINGS[s.openingRequirementType]!,
        result: RESULTS[s.attackResultRequirement] ?? (s.attackResultRequirement ? 'other' : null), position: null, openingStyle: null, followUps: [],
        weapon: s.specKeyName === 'Shields' ? 'Shield' : s.specKeyName, stealth: false, procSpellId: s.procs?.[0]?.spellId ?? null,
        ...(s.procs?.[0] ? { procSpell: { description: taunt(s.procs[0].spellId) } } : {}),
    },
}) as Style);
const blades = [{ slot: EquipmentSlot.RightHand, objectType: ObjectType.Blades }, { slot: EquipmentSlot.LeftHand, objectType: ObjectType.Blades }] as never;
const oneBlade = [{ slot: EquipmentSlot.RightHand, objectType: ObjectType.Blades }] as never;

const ME = 1, FOE = 2;
const melee = (by: number, on: number, result: CombatResult, at: number): CombatEvent => ({ id: at, kind: 'melee', attackerObjectId: by, targetObjectId: on, result, receivedAt: at });
const pick = (log: StunLog, now: number, o: { events?: CombatEvent[]; messages?: string[]; endurance?: number; kind?: 'player' | 'npc'; equipment?: never } = {}) => bladeStyle(log, () => now)({
    target: { objectId: FOE, kind: o.kind ?? 'player' } as never,
    player: { objectId: ME, endurancePercent: o.endurance ?? 100 } as never,
    state: { equipment: o.equipment ?? blades, combatEvents: o.events ?? [], gameMessages: (o.messages ?? []).map(text => ({ text })) } as never,
    styles,
});

describe('blademaster kit', () => {
    test('Ice Storm is a 4 s StyleStun from the side in reach at 24, and no shield style is in his hands', () => {
        for (const [name, ms] of Object.entries(BLADEMASTER_STUNS)) {
            const s = build().styles.find(x => x.name === name)!;
            expect(s.openingRequirementType).toBe(2);
            const spell = getSpell(s.procs![0]!.spellId)!;
            expect(spell.type).toBe('StyleStun');
            expect(spell.duration * 1000).toBe(ms);
        }
        expect(build().styles.some(s => s.name === 'Slam')).toBe(false);
        expect(pick(new Map(), 0).some(n => ['Numb', 'Stun', 'Disable'].includes(n as string))).toBe(false);
    });

    test('at a player: Ice Storm with Hurricane behind it', () => {
        expect(pick(new Map(), 0)).toEqual(['Ice Storm', 'Hurricane']);
    });

    test('after a landed Ice Storm: no stun queue until the immunity is over, the fighter\'s pick meanwhile', () => {
        const log: StunLog = new Map();
        const landed = { events: [melee(ME, FOE, 'styledHit', 1000)], messages: ['You perform your Ice Storm perfectly!'] };
        expect(pick(log, 2000, landed)).not.toEqual(['Ice Storm', 'Hurricane']);
        expect(pick(log, 2000, landed)).toContain('Hurricane');
        expect(pick(log, 2000, landed).some(n => ['Taunting Blade', 'Squall'].includes(n as string))).toBe(false);
        expect(pick(log, 1000 + 4000 + STUN_IMMUNE_MS - 1, landed)[0]).not.toBe('Ice Storm');
        expect(pick(log, 1000 + 4000 + STUN_IMMUNE_MS, landed)).toEqual(['Ice Storm', 'Hurricane']);
    });

    test('a reaction he earned still goes first between stuns: Blinding Rain after his evade', () => {
        const log: StunLog = new Map([[FOE, 10_000]]);
        expect(pick(log, 11_000, { events: [melee(FOE, ME, 'evade', 10_500)] })[0]).toBe('Blinding Rain');
    });

    test('one blade: no Celtic Dual, so no stun queue; short of endurance, none either', () => {
        expect(bladeStunQueue(styles, oneBlade, 100)).toEqual(null);
        expect(bladeStunQueue(styles, blades, 12)).toBeNull();
        expect(bladeStunQueue(styles, blades, 15)).toEqual(['Ice Storm', 'Hurricane']);
    });

    test('monsters get the fighter\'s pick', () => {
        expect(pick(new Map(), 0, { kind: 'npc' })[0]).not.toBe('Ice Storm');
    });

    test('Triple Wield: in an engage, swinging, a player within melee reach, and only once per reuse', () => {
        const base = { phase: 'engage', attacking: true, readyAt: 0, now: 1000, nearestPlayer: 200 };
        expect(tripleWieldNow(base)).toBe(true);
        expect(tripleWieldNow({ ...base, phase: 'travel' })).toBe(false);
        expect(tripleWieldNow({ ...base, attacking: false })).toBe(false);
        expect(tripleWieldNow({ ...base, nearestPlayer: 900 })).toBe(false);
        expect(tripleWieldNow({ ...base, readyAt: 1000 + TRIPLE_WIELD_REUSE_MS })).toBe(false);
    });

    test('a refusal's wait, as the server words it', () => {
        expect(waitOf('You must wait 14 seconds to use this ability.')).toBe(14_000);
        expect(waitOf('You must wait 1 second to use this ability.')).toBe(1000);
        expect(waitOf('You must wait 6 minutes 12 seconds to use this ability.')).toBe(372_000);
        expect(waitOf('You must wait 7 minutes to use this ability.')).toBe(420_000);
        expect(waitOf('You can't do that now.')).toBeNull();
    });

    test('in the pack lists: his fight stands where the tank\'s or the melee\'s did, Triple Wield above it; no role of its own', () => {
        expect(blademaster().role).toBeUndefined();
        for (const role of ['tank', 'melee'] as const) {
            const list = packBehaviors()[role].map(b => b.name);
            const fight = list.indexOf(role === 'tank' ? 'tank' : 'assistMelee');
            const want = [...list.slice(0, fight), 'tripleWield', 'bladeFight', ...list.slice(fight + 1)];
            expect(withCharacter(packBehaviors()[role], blademaster()).map(b => b.name)).toEqual(want);
        }
    });
});
