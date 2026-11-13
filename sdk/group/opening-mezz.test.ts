// The opening mezz (behaviors.ts openingMezz, run by crowdControl before an engage): the Bard steps up and mezzes an
// incoming group one by one, casters first; a kit with an area mezz opens where it catches two.
import { describe, expect, test } from 'bun:test';
import { crowdControl, OPEN_STEP, openingTargets } from './behaviors';
import { enemy, picture, report } from './fixtures';
import type { MemberContext } from './member';
import { PVE_SETTINGS } from './pve';
import type { Contact, Orders, Point, Role } from './types';

const R = 9999;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const MEZZ = { spell: { name: 'Mesmerizing Hymn' }, range: 1500, radius: 0, duration: 30, castTime: 2.5 };
const AREA = { spell: { name: 'Captivate Audience' }, range: 1500, radius: 350, duration: 30, castTime: 3 };
const foe = (id: number, x: number, y: number, over: Partial<Contact> = {}) => enemy(id, 'midgard', { regionId: R, x, y, ...over });
const caster = { classGuess: { role: 'caster' } } as Partial<Contact>;
const healerKind = { classGuess: { role: 'healer' } } as Partial<Contact>;

function stub(o: { role: Role; at: Point; contacts: Contact[]; orders?: Partial<Orders>; mezz?: unknown; area?: unknown; members?: Point[]; cast?: () => object }) {
    const calls = { cast: [] as number[], walk: [] as Point[] };
    const marks: number[] = [];
    const me = report('Fiacra', { role: o.role, regionId: R, x: o.at.x, y: o.at.y, objectId: 1 });
    const others = (o.members ?? []).map((p, i) => report(`M${i}`, { role: 'melee', regionId: R, x: p.x, y: p.y, objectId: 10 + i }));
    const pic = picture([me, ...others], o.contacts, { phase: 'travel', objective: 'stalk 5 round (0, 0)', ...o.orders });
    const ctx = {
        name: 'Fiacra', role: o.role, settings: { ...PVE_SETTINGS, areaMezzMin: 2 }, memory: new Map<string, any>(),
        me: () => ({ name: 'Fiacra', objectId: 1, regionId: R, realm: 'hibernia', x: o.at.x, y: o.at.y, z: 0, attacking: false }),
        picture: () => pic, orders: () => pic.orders, members: () => pic.members, threats: () => [],
        contact: (id: number) => pic.contacts.find(c => c.objectId === id),
        spells: { mezz: () => o.mezz ?? null, areaMezz: () => o.area ?? null, capabilities: () => ({ ccKinds: ['mezz'] }) },
        sdk: {
            getState: () => ({ combatEvents: [] }),
            getNearbyPlayer: (id: number) => { const c = pic.contacts.find(x => x.objectId === id); return c ? { ...c, distance: dist(c, o.at) } : null; },
            getNearbyNpc: () => null,
        },
        bot: {
            castSpell: async (_s: unknown, id: number) => { calls.cast.push(id); return { success: true, message: 'Cast', ...(o.cast?.() ?? {}) }; },
            walkTo: async (x: number, y: number) => { calls.walk.push({ x, y }); return { success: true, message: 'arrived' }; },
        },
        doing: () => {}, skip: () => false, result: () => {}, note: () => {},
        markCc: (id: number) => { marks.push(id); }, markCcImmune: () => {},
    } as unknown as MemberContext<any>;
    return { ctx, calls, marks };
}

describe('openingTargets', () => {
    test('casters first, then healers but the one nearest our group (the kill), then fighters; nearest first', () => {
        const foes = [foe(1, 1000, 0), foe(2, 1200, 0, healerKind), foe(3, 1400, 0, caster), foe(4, 900, 0, healerKind), foe(5, 1100, 0, caster)];
        expect(openingTargets(foes, { x: 0, y: 0 }, { x: 0, y: 0 }).map(c => c.objectId)).toEqual([5, 3, 2, 1]);
    });
});

describe('the opening mezz before an engage', () => {
    test('in a stalk the Bard mezzes a caster in range, one at a time, and marks it', async () => {
        const s = stub({ role: 'support', at: { x: 0, y: 0 }, mezz: MEZZ, contacts: [foe(1, 1200, 0), foe(2, 1300, 0, caster)] });
        expect(await crowdControl().run(s.ctx)).toBe(true);
        expect(s.calls.cast).toEqual([2]);
        expect(s.marks).toEqual([2]);
    });

    test('out of range it steps toward the target, at most OPEN_STEP, to just inside the mezz range', async () => {
        const s = stub({ role: 'support', at: { x: 0, y: 0 }, mezz: MEZZ, contacts: [foe(2, 1900, 0, caster)] });
        expect(await crowdControl().run(s.ctx)).toBe(true);
        expect(s.calls.cast).toEqual([]);
        expect(s.calls.walk[0]!.x).toBeCloseTo(1900 - 1350, -1);
        const far = stub({ role: 'support', at: { x: 0, y: 0 }, mezz: MEZZ, contacts: [foe(2, 1500 + OPEN_STEP + 100, 0, caster)] });
        expect(await crowdControl().run(far.ctx)).toBe(false);
    });

    test('not in a refusal, an ambush or the rest, and not a single mezz from a kit other than the support', async () => {
        const refuse = stub({ role: 'support', at: { x: 0, y: 0 }, mezz: MEZZ, contacts: [foe(2, 1000, 0)], orders: { objective: 'keep away' } });
        expect(await crowdControl().run(refuse.ctx)).toBe(false);
        const ambush = stub({ role: 'support', at: { x: 0, y: 0 }, mezz: MEZZ, contacts: [foe(2, 1000, 0)], orders: { objective: 'lie in wait for 3 stragglers' } });
        expect(await crowdControl().run(ambush.ctx)).toBe(false);
        const nuker = stub({ role: 'nuker', at: { x: 0, y: 0 }, mezz: MEZZ, contacts: [foe(2, 1000, 0)] });
        expect(await crowdControl({ assignedOnly: true }).run(nuker.ctx)).toBe(false);
    });

    test('an area mezz opens where it catches two, from any kit, and marks all it caught', async () => {
        const s = stub({ role: 'nuker', at: { x: 0, y: 0 }, area: AREA, contacts: [foe(1, 1000, 0), foe(2, 1100, 100), foe(3, 1000, 1400)] });
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.calls.cast.length).toBe(1);
        expect(s.marks.sort()).toEqual([1, 2]);
        const lone = stub({ role: 'nuker', at: { x: 0, y: 0 }, area: AREA, contacts: [foe(1, 1000, 0)] });
        expect(await crowdControl({ assignedOnly: true }).run(lone.ctx)).toBe(false);
    });

    test('an enemy already mezzed is left', async () => {
        const s = stub({ role: 'support', at: { x: 0, y: 0 }, mezz: MEZZ, contacts: [foe(2, 1000, 0, { cc: { kind: 'mezz', by: 'X', until: Date.now() + 20_000 } as Contact['cc'] })] });
        expect(await crowdControl().run(s.ctx)).toBe(false);
    });
});
