import { describe, expect, test } from 'bun:test';
import { defaultBehaviors } from '../group/behaviors';
import { withCharacter } from '../group/character';
import type { Behavior, MemberContext } from '../group/member';
import { packBehaviors } from '../group/pack';
import { withPets } from '../group/pets';
import { rvrBehaviors } from '../group/rvr';
import { callPet, hunter, petMove, stowPet } from './hunter';

describe('hunter kit: no pet while hidden, the instant summon once shown in a fight', () => {
    test('petMove: stow when hidden with one up, call when shown, fighting, none up and the summon ready', () => {
        expect(petMove({ hidden: true, petUp: true, fighting: false, summonReady: true })).toBe('stow');
        expect(petMove({ hidden: true, petUp: true, fighting: true, summonReady: true })).toBe('stow');
        expect(petMove({ hidden: true, petUp: false, fighting: true, summonReady: true })).toBeNull();
        expect(petMove({ hidden: false, petUp: false, fighting: true, summonReady: true })).toBe('call');
        // A quiet turn out of stealth: no summon (the next hide would release it, and the 120 s recast would miss the fight).
        expect(petMove({ hidden: false, petUp: false, fighting: false, summonReady: true })).toBeNull();
        expect(petMove({ hidden: false, petUp: false, fighting: true, summonReady: false })).toBeNull();
        expect(petMove({ hidden: false, petUp: true, fighting: true, summonReady: true })).toBeNull();
    });

    test("the kit's summonPet and summonOnTheWayBack stand in for pets.ts's: one of each, ours, petControl kept", () => {
        const kit = hunter();
        const ours = (n: string) => kit.instant!.find(b => b.name === n);
        for (const lists of [defaultBehaviors(), rvrBehaviors(), packBehaviors()]) {
            const list = withPets(withCharacter(lists.nuker as Behavior<any>[], kit), { main: true, instantSummon: true } as any);
            const names = list.map(b => b.name);
            expect(names.filter(n => n === 'summonPet')).toHaveLength(1);
            expect(list.find(b => b.name === 'summonPet')).toBe(ours('summonPet'));
            expect(names.filter(n => n === 'summonOnTheWayBack').length).toBeLessThanOrEqual(1);
            if (names.includes('summonOnTheWayBack')) expect(list.find(b => b.name === 'summonOnTheWayBack')).toBe(ours('summonOnTheWayBack'));
            expect(names).toContain('stowPet');
            expect(names).toContain('petControl');
            expect(names.indexOf('stowPet')).toBeGreaterThan(names.indexOf('hide'));
        }
    });

    const ctxOf = (o: { stealthed: boolean; pet: object | null; phase?: string; inCombat?: boolean; cooldown?: number; threats?: object[] }) => {
        const calls: string[] = [];
        const memory = new Map<string, any>();
        const sp = { castTime: 0, spell: { name: "Hunter's Protector", cooldownRemaining: o.cooldown ?? 0 } };
        const ctx = {
            sdk: { isStealthed: () => o.stealthed, getState: () => ({ pet: o.pet }) },
            bot: {
                isDead: () => false,
                releasePet: async () => { calls.push('release'); return { success: true, message: 'released' }; },
                summonPet: async (s: { name: string }) => { calls.push(`summon ${s.name}`); return { success: true, message: 'up' }; },
            },
            settings: {},
            memory,
            spells: { summon: () => sp, powerOf: () => 26 },
            me: () => ({ mana: 100, regionId: 1, x: 0, y: 0, inCombat: o.inCombat ?? false }),
            orders: () => ({ phase: o.phase ?? 'travel' }),
            threats: () => o.threats ?? [],
            doing: () => {},
            result: () => {},
        } as unknown as MemberContext;
        return { ctx, calls };
    };

    test('stowPet releases the pet while hidden, and does nothing shown or with none', async () => {
        let t = ctxOf({ stealthed: true, pet: { name: "hunter's protector" } });
        expect(await stowPet().run(t.ctx)).toBe(true);
        expect(t.calls).toEqual(['release']);
        t = ctxOf({ stealthed: false, pet: { name: "hunter's protector" } });
        expect(await stowPet().run(t.ctx)).toBe(false);
        t = ctxOf({ stealthed: true, pet: null });
        expect(await stowPet().run(t.ctx)).toBe(false);
        expect(t.calls).toEqual([]);
    });

    test('callPet summons once shown in a fight (opened, found, or a threat near), never hidden, quiet or on the recast', async () => {
        for (const fight of [{ phase: 'engage' }, { inCombat: true }, { threats: [{ regionId: 1, x: 800, y: 0 }] }]) {
            const t = ctxOf({ stealthed: false, pet: null, ...fight });
            expect(await callPet().run(t.ctx)).toBe(true);
            expect(t.calls).toEqual(["summon Hunter's Protector"]);
        }
        for (const no of [{ stealthed: true, phase: 'engage' }, { stealthed: false }, { stealthed: false, phase: 'engage', cooldown: 60 }, { stealthed: false, threats: [{ regionId: 1, x: 3000, y: 0 }] }]) {
            const t = ctxOf({ pet: null, ...no });
            expect(await callPet().run(t.ctx)).toBe(false);
            expect(t.calls).toEqual([]);
        }
    });
});
