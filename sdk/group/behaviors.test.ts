import { describe, expect, test } from 'bun:test';
import { beyondLeash, ckey, holdState, needsSlot, openingOf } from './behaviors';
import { contact, enemy } from './fixtures';
import type { MemberContext } from './member';
import { PVE_SETTINGS } from './pve';

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
            // 1700 west of the Faste's centre (its circle is 3000) and 500 from the anchor: inside the leash, under the guards.
            const near = { x: faste.x - 1700, y: faste.y, z: 0 };
            expect(beyondLeash(ctxWith(2000, { x: near.x - 500, y: near.y, z: 0 }), enemy(7, 'albion', { regionId: 252, ...near }))).toBe(true);
            expect(beyondLeash(ctxWith(undefined, null), enemy(7, 'albion', { regionId: 252, ...near }))).toBe(true);
            // Outside the circle: only the leash counts.
            expect(beyondLeash(ctxWith(2000, { x: faste.x - 4000, y: faste.y, z: 0 }), enemy(7, 'albion', { regionId: 252, x: faste.x - 3500, y: faste.y }))).toBe(false);
        } finally {
            regionId = 9999;
        }
    });
});
