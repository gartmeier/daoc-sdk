import { describe, expect, test } from 'bun:test';
import { beyondLeash, ckey, defaultBehaviors, hand, holdState, mezzedMember, needsSlot, openingOf, shedLoad } from './behaviors';
import { ObjectType } from '../types';
import { contact, enemy, report } from './fixtures';
import type { MemberReport, Role } from './types';
import { MemberContext } from './member';
import { PVE_SETTINGS } from './pve';
import { rvrBehaviors, rvrRoaming } from './rvr';

describe('holdState: when damage dealers may open', () => {
    const now = 100_000;
    test('a mob fought where it stood: from when it targeted the tank', () => {
        const mob = { target: 'Tank', targetSince: now - 2000, movedAt: 0, engagedAt: now - 2000, hostileSince: now - 2000 };
        expect(holdState(mob, 'Tank', 2500, 6000, now)).toEqual({ held: false, dueAt: now + 500 });
        expect(holdState(mob, 'Tank', 2500, 6000, now + 500).held).toBe(true);
    });

    test('a mob carried home on a pull: not before holdMs after the engage order, fallback included', () => {
        // Its kept target says "Tank" (and it stayed hostile) since the pull hit 10 s ago; the engage order came 1 s ago.
        const mob = { target: 'Tank', targetSince: now - 10_000, movedAt: now - 1500, engagedAt: now - 1000, hostileSince: now - 10_000 };
        for (const holdMs of [1500, 2500, 4000]) {
            expect(holdState(mob, 'Tank', holdMs, 6000, now - 1000 + holdMs - 1).held).toBe(false);
            expect(holdState(mob, 'Tank', holdMs, 6000, now - 1000 + holdMs).held).toBe(true);
        }
        // On someone else: the fallback also counts from the engage order.
        expect(holdState({ ...mob, target: 'Druid' }, 'Tank', 2500, 6000, now + 4900).held).toBe(false);
        expect(holdState({ ...mob, target: 'Druid' }, 'Tank', 2500, 6000, now + 5000).held).toBe(true);
    });

    test('fallbacks: fighting for assistAfterMs on anyone, or no living tank', () => {
        const onHealer = { target: 'Druid', targetSince: now - 1000, movedAt: 0, engagedAt: now - 7000, hostileSince: now - 7000 };
        expect(holdState(onHealer, 'Tank', 2500, 6000, now).held).toBe(true);
        expect(holdState({ ...onHealer, hostileSince: now - 1000 }, 'Tank', 2500, 6000, now).held).toBe(false);
        expect(holdState({ ...onHealer, hostileSince: 0 }, null, 2500, 6000, now).held).toBe(true);
    });
});

describe('needsSlot: walking back to the formation slot', () => {
    const base = { dAnchor: 1000, phase: 'recover', slack: 350, gatherRadius: 1200, safe: true };
    test('after a fight, a caster within the slack of its slot stays put', () => {
        expect(needsSlot({ ...base, dSlot: 100 })).toBe(false);
        expect(needsSlot({ ...base, dSlot: 300 })).toBe(false);
        expect(needsSlot({ ...base, dSlot: 400 })).toBe(true);
    });
    test('but walks back near the gather radius (no "gather: waiting for ...") or in aggressive reach', () => {
        expect(needsSlot({ ...base, dSlot: 300, dAnchor: 1150 })).toBe(true);
        expect(needsSlot({ ...base, dSlot: 300, safe: false })).toBe(true);
    });
    test('travelling: from 250 off the slot, as before', () => {
        expect(needsSlot({ ...base, phase: 'travel', dSlot: 200 })).toBe(false);
        expect(needsSlot({ ...base, phase: 'travel', dSlot: 300, slack: 1000 })).toBe(true);
    });
});

describe('openingOf: the tank\'s taunt window per mob', () => {
    function ctxWith(contacts: ReturnType<typeof contact>[]) {
        const memory = new Map<string, any>();
        const ctx = { memory, picture: () => ({ contacts }) } as unknown as MemberContext;
        return { ctx, set: (c: ReturnType<typeof contact>[]) => { contacts = c; } };
    }
    test('a new mob under a reused object id gets a fresh window; gone mobs are forgotten', () => {
        const wolf1 = contact(21167, { firstSeen: 1000 });
        const { ctx, set } = ctxWith([wolf1]);
        expect(openingOf(ctx, wolf1, 5000)).toBe(5000);
        expect(openingOf(ctx, wolf1, 9000)).toBe(5000);
        // The server deleted wolf1 and gave 21167 to the next wolf: a new contact, a new window.
        const wolf2 = contact(21167, { firstSeen: 20_000 });
        set([wolf2]);
        expect(ckey(wolf2)).not.toBe(ckey(wolf1));
        expect(openingOf(ctx, wolf2, 21_000)).toBe(21_000);
        expect([...(ctx.memory.get('firstHit') as Map<string, number>).keys()]).toEqual([ckey(wolf2)]);
    });
});

describe('PvE defaults stay consistent', () => {
    test('the tank carries home exactly the mobs the coordinator keeps in the pull phase', () => {
        expect(PVE_SETTINGS.pullDistance).toBe(PVE_SETTINGS.engageRadius);
    });
    test('a fight at the anchor moves nobody: every formation slot lies within its role\'s limits', () => {
        for (const [role, band] of Object.entries(PVE_SETTINGS.combatRange)) {
            const f = PVE_SETTINGS.formation[role as keyof typeof PVE_SETTINGS.formation];
            if (!f || !band) continue;
            expect(f.back).toBeGreaterThanOrEqual(band[0]);
            expect(f.back).toBeLessThanOrEqual(band[1]);
        }
    });
});

describe('beyondLeash: tank and melee stay with the fight', () => {
    const ctxWith = (chaseLeash: number | undefined, anchor: { x: number; y: number; z: number } | null) =>
        ({ settings: { ...PVE_SETTINGS, chaseLeash }, orders: () => ({ anchor }), me: () => ({ regionId, realm: 'hibernia' }) }) as unknown as MemberContext<typeof PVE_SETTINGS>;
    // Region 9999 has no keeps; 252's Faste is Albion's.
    let regionId = 9999;
    const anchor = { x: 10_000, y: 10_000, z: 0 };
    test('an enemy player farther than chaseLeash from the anchor is let go; nearer ones and monsters are not', () => {
        expect(beyondLeash(ctxWith(2000, anchor), enemy(7, 'albion', { x: 12_500, y: 10_000 }))).toBe(true);
        expect(beyondLeash(ctxWith(2000, anchor), enemy(7, 'albion', { x: 11_500, y: 10_000 }))).toBe(false);
        expect(beyondLeash(ctxWith(2000, anchor), contact(8, { x: 12_500, y: 10_000 }))).toBe(false);
    });
    test('no leash (PvE settings) or no anchor: never', () => {
        expect(beyondLeash(ctxWith(undefined, anchor), enemy(7, 'albion', { x: 20_000, y: 10_000 }))).toBe(false);
        expect(beyondLeash(ctxWith(2000, null), enemy(7, 'albion', { x: 20_000, y: 10_000 }))).toBe(false);
    });
    test('an enemy player under the guards of a keep not ours is let go, leash or not (review: tank into the Faste)', () => {
        regionId = 252;
        try {
            const faste = { x: 33_089, y: 38_271 };
            // 1700 west of the Faste's centre (its circle is 4500) and 500 from the anchor: inside the leash, under the guards.
            const near = { x: faste.x - 1700, y: faste.y, z: 0 };
            expect(beyondLeash(ctxWith(2000, { x: near.x - 500, y: near.y, z: 0 }), enemy(7, 'albion', { regionId: 252, ...near }))).toBe(true);
            expect(beyondLeash(ctxWith(undefined, null), enemy(7, 'albion', { regionId: 252, ...near }))).toBe(true);
            // Outside the circle: only the leash counts.
            expect(beyondLeash(ctxWith(2000, { x: faste.x - 5500, y: faste.y, z: 0 }), enemy(7, 'albion', { regionId: 252, x: faste.x - 5000, y: faste.y }))).toBe(false);
        } finally {
            regionId = 9999;
        }
    });
});

describe('hand: a melee or tank member\'s weapon', () => {
    const style = (name: string, weapon: string, over: object = {}) => ({ name, internalId: 1, specLevel: 5, specName: weapon, skillIndex: 1, prerequisite: 0x100, details: { weapon, stealth: false, opening: 'offensive', result: null, openingStyle: null, followUps: [], fatigue: 10, openingDamage: 40, attackMod: 0, defensiveMod: 0, position: null, procSpellId: null }, ...over });
    const worn = [{ slot: 10, objectType: ObjectType.Sword }, { slot: 12, objectType: ObjectType.Spear }];
    function stub(o: { tank?: boolean; styles?: object[]; messages?: { id: number; text: string }[]; dead?: boolean } = {}) {
        const taken: object[] = [];
        const messages = o.messages ?? [];
        const ctx = {
            memory: new Map<string, any>(),
            me: () => ({ isDead: !!o.dead }),
            isTank: () => !!o.tank,
            note: () => {},
            bot: { takeMeleeSlot: async (options: object) => { taken.push(options); return { success: true, message: 'in hand', slot: 12 }; } },
            sdk: { getSkills: () => ({ styles: o.styles ?? [] }), getState: () => ({ equipment: worn }), getGameMessages: () => messages },
        } as unknown as MemberContext<any>;
        return { ctx, taken, messages };
    }

    test('once, as the run starts, and it takes no turn', async () => {
        // r3 (sword in hand after login, Sword 1, Spear 10): 'You attack the lake serpent with your sword and hit for 3 (-1) damage!', hold 7 %. Spear (bots/pethun/hand.ts 12): 17-40.
        const { ctx, taken } = stub();
        expect(await hand().run(ctx)).toBe(false);
        expect(await hand().run(ctx)).toBe(false);
        expect(taken).toEqual([{ keepOnTie: true }]);
    });

    test('a tank goes by the style it will open with', async () => {
        const { ctx, taken } = stub({ tank: true, styles: [style('Dazzling Spear', 'Spear')] });
        await hand().run(ctx);
        expect(taken).toEqual([{ styles: ['Dazzling Spear'], keepOnTie: true }]);
    });

    test('dead, it waits', async () => {
        const { ctx, taken } = stub({ dead: true });
        await hand().run(ctx);
        expect(taken).toEqual([]);
    });

    test('on "This style requires a X weapon!" the slot holding X, once for each X; a line from before the run says nothing', async () => {
        // r3: 'This style requires a Spear weapon!' 15×, 'opener Engage': tankStyles reads what is worn, not what is in hand.
        const { ctx, taken, messages } = stub({ messages: [{ id: 1, text: 'This style requires a Hammer weapon!' }] });
        await hand().run(ctx);
        expect(taken).toEqual([{ keepOnTie: true }]);
        messages.push({ id: 2, text: 'This style requires a Spear weapon!' }, { id: 3, text: 'This style requires a Spear weapon!' });
        await hand().run(ctx);
        expect(taken).toEqual([{ keepOnTie: true }, { weapon: 'Spear' }]);
        messages.push({ id: 4, text: 'This style requires a Spear weapon!' }, { id: 5, text: 'You hit the rat.' });
        await hand().run(ctx);
        expect(taken).toEqual([{ keepOnTie: true }, { weapon: 'Spear' }]);
    });

    test('it stands on the lists of tank and melee, after release, and on no other', () => {
        const lists = defaultBehaviors();
        for (const role of ['tank', 'melee'] as const) expect(lists[role].map(b => b.name).slice(0, 2)).toEqual(['release', 'hand']);
        for (const role of ['healer', 'support', 'nuker'] as const) expect(lists[role].map(b => b.name)).not.toContain('hand');
    });

    test('the same on the RvR lists: "A melee or tank member takes its best melee slot" has no PvE limit, and midrvr\'s Hunter set its by hand (bots/pethun/hand.ts)', () => {
        const lists = rvrBehaviors();
        for (const role of ['tank', 'melee'] as const) expect(lists[role].map(b => b.name).slice(0, 2)).toEqual(['release', 'hand']);
        for (const role of ['healer', 'support', 'nuker'] as const) expect(lists[role].map(b => b.name)).not.toContain('hand');
        expect(rvrRoaming.behaviors.melee.map(b => b.name)).toContain('hand');
    });
});

describe('ctx.result: a cast whose target died under it is no failure', () => {
    function context() {
        const events: any[] = [];
        const agent = { member: { bot: 'x', role: 'nuker', actions: {}, sdk: { getPlayer: () => ({ name: 'X' }) } }, spells: {}, board: { emit: (e: any) => events.push(e) }, stepFailed: false };
        return { ctx: new MemberContext(agent as any, {}), agent, events };
    }

    test('nothing to count, and no pace of a failed turn', () => {
        // r9: `You begin casting a Murk Blast spell!` at +19.6, `You just killed Petani` at +19.9, then `00:24 Petbon: nuke: timeout (Murk Blast started but no completion was observed)`: 'A failure in the report, and the turn is held meanwhile.'
        const { ctx, agent, events } = context();
        ctx.result('nuke', { success: false, reason: 'already_dead', message: 'Petani died before Murk Blast could land', targetDied: true });
        expect(events).toEqual([]);
        expect(agent.stepFailed).toBe(false);
    });

    test('an already_dead before any cast stays what it was: it can spin', () => {
        const { ctx, agent, events } = context();
        ctx.result('nuke', { success: false, reason: 'already_dead', message: 'Petani is dead!' });
        expect(events).toHaveLength(1);
        expect(agent.stepFailed).toBe(true);
    });
});

describe('shedLoad: what an overloaded member drops', () => {
    const item = (name: string, level: number, weight: number, objectType = 13) => ({ slot: 40, name, level, weight, count: 1, objectType });
    const run = async (inventory: object[], keepItems = 'Bind Recall') => {
        const dropped: string[] = [];
        const ctx = {
            settings: { ...PVE_SETTINGS, shedLoadAt: 95, keepItems },
            me: () => ({ level: 22, className: 'Warrior', realm: 'midgard', encumbrance: { current: 96, max: 100 } }),
            orders: () => ({ phase: 'idle' }), threats: () => [], doing: () => {}, result: () => {}, skip: () => false,
            sdk: { getInventory: () => inventory },
            bot: { dropItem: async (i: { name: string }) => { dropped.push(i.name); return { success: true, message: '' }; } },
        } as unknown as Parameters<ReturnType<typeof shedLoad>['run']>[0];
        await shedLoad().run(ctx);
        return dropped;
    };

    test('the heaviest of what it has no use for, before heavier gear kept for later', async () => {
        expect(await run([item('Dragonmight', 51, 40), item('loot axe', 22, 30), item('loot hammer', 22, 10)])).toEqual(['loot axe']);
    });

    test('kept gear goes only when nothing else is left, because a member that can\'t move is worse', async () => {
        expect(await run([item('Dragonmight', 51, 40), item('Bind Recall Stone', 1, 1, 0)])).toEqual(['Dragonmight']);
    });
});

describe('mezzedMember', () => {
    const member = (name: string, role: Role, effects: string[], over: Partial<MemberReport> = {}) => report(name, { role, effects, x: 100, y: 0, regionId: 1, ...over });
    const me = { name: 'Sorc', x: 0, y: 0, regionId: 1 };
    const mezz = (e: string) => e === 'Sedate';

    test('the healer first, then the tank, then the most hurt', () => {
        const a = member('Nuke', 'nuker', ['Sedate'], { hp: 20 }), t = member('Tank', 'tank', ['Sedate']), h = member('Heal', 'healer', ['Sedate']);
        expect(mezzedMember(me, [a, t, h], 1500, mezz)?.name).toBe('Heal');
        expect(mezzedMember(me, [a, t], 1500, mezz)?.name).toBe('Tank');
    });

    test('nobody out of range, dead, in another region, not mezzed, or ourselves', () => {
        const list = [member('Far', 'healer', ['Sedate'], { x: 2000 }), member('Dead', 'healer', ['Sedate'], { isDead: true }), member('Away', 'healer', ['Sedate'], { regionId: 2 }), member('Free', 'healer', ['Root']), member('Sorc', 'nuker', ['Sedate'])];
        expect(mezzedMember(me, list, 1500, mezz)).toBeNull();
    });

    test('range is 3D, with a margin: on a hill a member in reach on the ground plane is out of it (round 8: cure out_of_range)', () => {
        const at = { ...me, z: 0 };
        expect(mezzedMember(at, [member('Heal', 'healer', ['Sedate'], { x: 1400, z: 0 })], 1500, mezz)?.name).toBe('Heal');
        expect(mezzedMember(at, [member('Heal', 'healer', ['Sedate'], { x: 1400, z: 600 })], 1500, mezz)).toBeNull();
        expect(mezzedMember(at, [member('Heal', 'healer', ['Sedate'], { x: 1470, z: 0 })], 1500, mezz)).toBeNull();
    });

    test('knows the real names: every Mesmerize spell in the data', () => {
        expect(mezzedMember(me, [member('Heal', 'healer', ['Greater Mesmerization'])], 1500)?.name).toBe('Heal');
        expect(mezzedMember(me, [member('Heal', 'healer', ['Holding Vines'])], 1500)).toBeNull();
    });
});
