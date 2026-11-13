import { describe, expect, test } from 'bun:test';
import type { Behavior } from '../member';
import { hasRealmSpeed, hasten, hastenBlock, HASTENER_REACH, nearestHastener, SPEED_OF_THE_REALM, withHasten, withHastener } from './hasten';

const b = (name: string): Behavior => ({ name, run: () => false });
const names = (l: Behavior[]) => l.map(x => x.name);
const me = { isDead: false, inCombat: false, x: 19_000, y: 19_000, maxSpeedPercent: 100 };
const quiet = { me, phase: 'recover', effects: [], hastener: { distance2d: 400 }, threats: 0, foes: [], retryAt: 0, now: 1000 };

describe('hasten: the rule', () => {
    test('the speed by its spell id, its name, or a max speed only it gives', () => {
        expect(hasRealmSpeed([{ spellId: SPEED_OF_THE_REALM, name: '' }])).toBe(true);
        expect(hasRealmSpeed([{ spellId: 0, name: 'Speed of the Realm' }])).toBe(true);
        expect(hasRealmSpeed([], { maxSpeedPercent: 247 })).toBe(true);
        // A Skald's or Bard's speed is no reason to skip it.
        expect(hasRealmSpeed([{ spellId: 1, name: 'Battle Rhythm' }], { maxSpeedPercent: 140 })).toBe(false);
    });

    test('the nearest hastener in reach, by name', () => {
        const npcs = [{ objectId: 1, name: 'Hastener', distance2d: 900 }, { objectId: 2, name: 'Hastener', distance2d: 300 }, { objectId: 3, name: 'Armsman', distance2d: 50 }];
        expect(nearestHastener(npcs)?.objectId).toBe(2);
        expect(nearestHastener([{ objectId: 1, name: 'Hastener', distance2d: HASTENER_REACH + 1 }])).toBeNull();
    });

    test('goes only when quiet, unsped, with one in reach and no enemy near', () => {
        expect(hastenBlock(quiet)).toBeNull();
        expect(hastenBlock({ ...quiet, phase: 'travel' })).toBeNull();
        expect(hastenBlock({ ...quiet, hastener: null })).toBe('no hastener in reach');
        expect(hastenBlock({ ...quiet, effects: [{ spellId: SPEED_OF_THE_REALM, name: 'Speed of the Realm' }] })).toBe('sped already');
        expect(hastenBlock({ ...quiet, phase: 'engage' })).toBe('orders say engage');
        expect(hastenBlock({ ...quiet, phase: 'retreat' })).toBe('orders say retreat');
        expect(hastenBlock({ ...quiet, threats: 1 })).toBe('in a fight');
        expect(hastenBlock({ ...quiet, me: { ...me, inCombat: true } })).toBe('in a fight');
        expect(hastenBlock({ ...quiet, foes: [{ x: 21_000, y: 19_000 }] })).toBe('an enemy near');
        expect(hastenBlock({ ...quiet, foes: [{ x: 22_000, y: 19_000 }] })).toBeNull();
        expect(hastenBlock({ ...quiet, retryAt: 5000 })).toBe('tried lately');
        expect(hastenBlock({ ...quiet, me: { ...me, isDead: true } })).toBe('dead');
        // A Bard's Clear Road (173 %) keeps the hastener's weaker buff off: the server refuses it (live 2026-11-13, 890 no_effect).
        expect(hastenBlock({ ...quiet, me: { ...me, maxSpeedPercent: 173 } })).toBe('a speed song already');
        expect(hastenBlock({ ...quiet, me: { ...me, maxSpeedPercent: 140 } })).toBeNull();
    });
});

describe('hasten: in the lists', () => {
    test('above holdFormation, else buff, else rest, else last; once', () => {
        expect(names(withHasten([b('assist'), b('shedLoad'), b('holdFormation'), b('buff'), b('rest')]))).toEqual(['assist', 'shedLoad', 'hasten', 'holdFormation', 'buff', 'rest']);
        expect(names(withHasten([b('assist'), b('buff'), b('rest')]))).toEqual(['assist', 'hasten', 'buff', 'rest']);
        expect(names(withHasten([b('assist')]))).toEqual(['assist', 'hasten']);
        expect(names(withHasten(withHasten([b('assist'), b('rest')])))).toEqual(['assist', 'hasten', 'rest']);
    });

    test('withHastener: every role list and every member list', () => {
        const s: any = { name: 's', behaviors: { tank: [b('tank'), b('rest')], healer: [b('heal'), b('hasten'), b('rest')] }, memberBehaviors: { ulfgar: [b('heal'), b('holdFormation')] } };
        const out = withHastener(s);
        expect(names(out.behaviors.tank)).toEqual(['tank', 'hasten', 'rest']);
        expect(names(out.behaviors.healer)).toEqual(['heal', 'hasten', 'rest']);
        expect(names(out.memberBehaviors!.ulfgar!)).toEqual(['heal', 'hasten', 'holdFormation']);
        expect(withHastener({ ...s, memberBehaviors: undefined }).memberBehaviors).toBeUndefined();
    });
});

describe('hasten: the behaviour', () => {
    function fake(o: { effectsAfter?: boolean; walkOk?: boolean; npcs?: any[]; phase?: string } = {}) {
        const log: string[] = [];
        let effects: any[] = [];
        const memory = new Map<string, any>();
        const ctx: any = {
            memory,
            me: () => ({ ...me, name: 'Ragnar' }),
            orders: () => ({ phase: o.phase ?? 'recover' }),
            threats: () => [],
            picture: () => ({ contacts: [] }),
            doing: (kind: string, id: number, detail: string) => log.push(`doing ${kind} ${id} ${detail}`),
            result: (kind: string, r: any) => log.push(`result ${kind} ${r.success} ${r.reason ?? ''}`),
            bot: { walkToObject: async (id: number, opt: any) => { log.push(`walk ${id} ${opt.range}`); return o.walkOk === false ? { success: false, reason: 'stuck', message: 'stuck' } : { success: true, message: 'there' }; } },
            sdk: {
                getEffects: () => effects,
                getNearbyNpcs: () => o.npcs ?? [{ objectId: 77, name: 'Hastener', distance2d: 420 }],
                sendInteract: async (id: number) => { log.push(`interact ${id}`); if (o.effectsAfter !== false) effects = [{ spellId: SPEED_OF_THE_REALM, name: 'Speed of the Realm' }]; return { success: true }; },
                waitForCondition: async (pred: (s: any) => boolean) => { if (pred({ effects, player: me })) return {}; throw new Error('timed out'); },
            },
        };
        return { ctx, log, memory };
    }

    test('walks to it, clicks it, and has the speed; the next turn it does nothing', async () => {
        const { ctx, log } = fake();
        const h = hasten();
        expect(await h.run(ctx)).toBe(true);
        expect(log).toEqual(['doing hasten 77 Speed of the Realm, the hastener 420 away', 'walk 77 150', 'interact 77', 'result hasten true ']);
        expect(await h.run(ctx)).toBe(false);
    });

    test('no effect after the click, or a failed walk: it waits HASTEN_RETRY_MS before the next try', async () => {
        const a = fake({ effectsAfter: false });
        expect(await hasten().run(a.ctx)).toBe(true);
        expect(a.log.at(-1)).toBe('result hasten false no_effect');
        expect(a.memory.get('hastenRetry')).toBeGreaterThan(Date.now());
        expect(await hasten().run(a.ctx)).toBe(false);
        const w = fake({ walkOk: false });
        expect(await hasten().run(w.ctx)).toBe(true);
        expect(w.log).not.toContain('interact 77');
        expect(w.memory.get('hastenRetry')).toBeGreaterThan(Date.now());
    });

    test('nothing in a fight, nor with no hastener in reach', async () => {
        expect(await hasten().run(fake({ phase: 'engage' }).ctx)).toBe(false);
        expect(await hasten().run(fake({ npcs: [] }).ctx)).toBe(false);
    });
});

test('hasten: after an interact with no speed, no new try for the rest of the run; after a failed walk, 10 min (live 2026-11-13: 890 no_effect, members walked in and out every 30 s)', async () => {
    const src = await Bun.file(new URL('./hasten.ts', import.meta.url)).text();
    expect(src).toMatch(/HASTEN_GIVE_UP_MS = 24 \* 3_600_000/);
    expect(src).toMatch(/HASTEN_RETRY_MS = 600_000/);
});
