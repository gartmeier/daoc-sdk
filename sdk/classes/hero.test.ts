import { describe, expect, test } from 'bun:test';
import { getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import { packBehaviors } from '../group/pack';
import { withCharacter } from '../group/character';
import { ANYTIME_STYLE } from '../group/styles';
import { EquipmentSlot, ObjectType, type CombatEvent, type CombatResult, type Style } from '../types';
import { hero, heroStyle, HERO_STUNS, noteStun, STUN_IMMUNE_MS, stunQueue, type StunLog } from './hero';
import { reachOfBuild } from './reach';

// The styles as the server describes them, from the static data (as guides.test.ts does).
const RESULTS: Record<number, CombatResult> = { 3: 'parry', 4: 'block' };
const OPENINGS = ['offensive', 'defensive', 'positional'] as const;
/** A taunt's proc as the server describes it (StyleTaunt.cs), so the pick tells taunts and detaunts apart. */
const taunt = (id: number) => { const sp = getSpell(id); return !sp || !/taunt/i.test(sp.type) ? '' : `${sp.value! < 0 ? 'decreases' : 'increasing'} your threat`; };
const styles: Style[] = reachOfBuild(getBuild('Hero', 'Sword and board tank')!, 24).styles.map(s => ({
    name: s.name, internalId: s.id, specLevel: s.specLevelRequirement, specName: s.specKeyName, skillIndex: s.id,
    prerequisite: s.openingRequirementType === 0 && !s.attackResultRequirement ? ANYTIME_STYLE : 0,
    details: {
        fatigue: s.enduranceCost, attackMod: 0, defensiveMod: 0, openingDamage: s.growthRate * 200, opening: OPENINGS[s.openingRequirementType]!,
        result: RESULTS[s.attackResultRequirement] ?? (s.attackResultRequirement ? 'other' : null), position: null, openingStyle: null, followUps: [],
        weapon: s.specKeyName === 'Shields' ? 'Shield' : s.specKeyName, stealth: false, procSpellId: s.procs?.[0]?.spellId ?? null,
        ...(s.procs?.[0] ? { procSpell: { description: taunt(s.procs[0].spellId) } } : {}),
    },
}) as Style);
const sword = [{ slot: EquipmentSlot.RightHand, objectType: ObjectType.Blades }, { slot: EquipmentSlot.LeftHand, objectType: ObjectType.Shield }] as never;
const noShield = [{ slot: EquipmentSlot.RightHand, objectType: ObjectType.Blades }] as never;

const ME = 1, FOE = 2;
const melee = (by: number, on: number, result: CombatResult, at: number, id = at): CombatEvent => ({ id, kind: 'melee', attackerObjectId: by, targetObjectId: on, result, receivedAt: at });
const pick = (log: StunLog, now: number, o: { events?: CombatEvent[]; messages?: string[]; endurance?: number; kind?: 'player' | 'npc' } = {}) => heroStyle(log, () => now)({
    target: { objectId: FOE, kind: o.kind ?? 'player' } as never,
    player: { objectId: ME, endurancePercent: o.endurance ?? 100 } as never,
    state: { equipment: sword, combatEvents: o.events ?? [], gameMessages: (o.messages ?? []).map(text => ({ text })) } as never,
    styles,
});

describe('hero kit', () => {
    test('every stun it names is a StyleStun of that length in reach at 24', () => {
        for (const [name, ms] of Object.entries(HERO_STUNS)) {
            const s = reachOfBuild(getBuild('Hero', 'Sword and board tank')!, 24).styles.find(x => x.name === name);
            expect(s).toBeDefined();
            const spell = getSpell(s!.procs![0]!.spellId)!;
            expect(spell.type).toBe('StyleStun');
            expect(spell.duration * 1000).toBe(ms);
        }
    });

    test('it keeps the tank\'s place in the pack list', () => {
        const list = packBehaviors().tank;
        expect(withCharacter(list, hero()).map(b => b.name)).toEqual(list.map(b => b.name));
    });

    test('at a player: Disable from the side, Numb behind it wherever he stands', () => {
        expect(pick(new Map(), 0)).toEqual(['Disable', 'Numb']);
    });

    test('after a block: the 5 s block reaction first, a stun that always fires behind it', () => {
        expect(pick(new Map(), 0, { events: [melee(FOE, ME, 'block', 0)] })).toEqual(['Incapacitate', 'Numb']);
    });

    test('a stun landed: none at that player until the immunity is over, the damage pick meanwhile', () => {
        const log: StunLog = new Map();
        const landed = { events: [melee(ME, FOE, 'styledHit', 1000)], messages: ['You perform your Disable perfectly!'] };
        const between = pick(log, 2000, landed);
        expect(between).not.toContain('Disable');
        expect(between).not.toContain('Numb');
        expect(between).toContain('Fire Blade');
        expect(pick(log, 1000 + HERO_STUNS.Disable! + STUN_IMMUNE_MS - 1, landed)).not.toContain('Numb');
        expect(pick(log, 1000 + HERO_STUNS.Disable! + STUN_IMMUNE_MS, landed)).toEqual(['Disable', 'Numb']);
    });

    test('a plain style landing is no stun', () => {
        const log: StunLog = new Map();
        noteStun(log, { combatEvents: [melee(ME, FOE, 'styledHit', 1000)], gameMessages: [{ text: 'You perform your Fire Blade perfectly!' }] } as never, ME);
        expect(log.size).toBe(0);
    });

    test('monsters get the damage pick, as before', () => {
        expect(pick(new Map(), 0, { kind: 'npc' })).not.toContain('Numb');
    });

    test('no shield, no shield stun; short of endurance, the cheap reaction only', () => {
        expect(stunQueue(styles, noShield, null, 100)).toBeNull();
        expect(stunQueue(styles, noShield, 'block', 100)).toEqual(['Horizon Blade']);
        expect(stunQueue(styles, sword, 'block', 10)).toEqual(['Horizon Blade']);
        expect(stunQueue(styles, sword, null, 10)).toBeNull();
    });
});
