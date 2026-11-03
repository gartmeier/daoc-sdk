// Behaviours against enemy players, run on a stub MemberContext: a fixed picture and orders,
// our own client's view (getNearbyPlayer / getNearbyNpc), and bot actions that answer with
// canned results. Region 9999 has no spawns, so safeSpot and safePath see no danger.
import { describe, expect, test } from 'bun:test';
import type { CastResult, KillPlayerOptions, KillPlayerResult } from '../actions';
import { executionContext } from '../execution-context';
import type { NearbyNpc, NearbyPlayer } from '../types';
import { assist, ckey, crowdControl, fightRejoin, flee, holdFormation, leashFallback, onMember, peelTarget, pull, tank, type TacticsSettings } from './behaviors';
import { contact, enemy, picture, report } from './fixtures';
import type { MemberContext } from './member';
import { PVE_SETTINGS } from './pve';
import type { Contact, MemberReport, Orders, Point, Role } from './types';

const R = 9999;
const ANCHOR = { x: 10_000, y: 10_000, z: 0 };
/** RvR's leash on the PvE settings (rvr.ts sets chaseLeash 2000). */
const LEASHED: TacticsSettings = { ...PVE_SETTINGS, chaseLeash: 2000 };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

interface StubOptions {
    name: string;
    role: Role;
    at: Point;
    /** The other members. */
    members?: MemberReport[];
    contacts?: Contact[];
    orders?: Partial<Orders>;
    settings?: TacticsSettings;
    /** Contacts our own client sees (default: all of them). */
    inView?: number[];
    /** Our own client's health and dead flag for a player in view, by id (default: the contact's hp, alive). */
    seen?: Record<number, { healthPercent: number; isDead: boolean }>;
    killPlayer?: (id: number, opts: KillPlayerOptions) => Promise<Partial<KillPlayerResult>>;
    castSpell?: (targetId: number) => Promise<Partial<CastResult>>;
}

function stub(o: StubOptions) {
    const calls = { killPlayer: [] as { id: number; opts: KillPlayerOptions }[], castSpell: [] as number[], walkTo: [] as Point[], attack: [] as number[] };
    const results: { kind: string; success: boolean; reason?: string; targetId: number | null }[] = [];
    const marks: { targetId: number; kind: string; ms: number }[] = [];
    const skips: string[] = [];
    const meReport = report(o.name, { role: o.role, regionId: R, x: o.at.x, y: o.at.y, level: 20, objectId: 1 });
    const pic = picture([meReport, ...(o.members ?? [])], o.contacts ?? [], { phase: 'engage', anchor: ANCHOR, facing: { x: ANCHOR.x + 1000, y: ANCHOR.y }, ...o.orders });
    const me = () => ({ name: o.name, objectId: 1, regionId: R, x: o.at.x, y: o.at.y, z: 0, level: 20, attacking: false, targetObjectId: null, maxMana: 100, mana: 100, manaPercent: 100, healthPercent: 100 });
    const visible = (id: number) => (o.inView ?? pic.contacts.map(c => c.objectId)).includes(id);
    const nearby = (c: Contact) => ({
        objectId: c.objectId, name: c.name, x: c.x, y: c.y, z: c.z, heading: 0, distance: dist(c, o.at), distance2d: dist(c, o.at), lastSeenAgo: 0,
        level: c.level, realm: c.realm, healthPercent: o.seen?.[c.objectId]?.healthPercent ?? c.hp,
    });
    const sdk = {
        getNearbyPlayer: (id: number) => {
            const c = pic.contacts.find(x => x.objectId === id && x.kind === 'player');
            return c && visible(id) ? { ...nearby(c), kind: 'player', isDead: o.seen?.[id]?.isDead ?? false, isSitting: false, inCombat: true, sessionId: 0, guildName: '', lastName: '' } as NearbyPlayer : null;
        },
        getNearbyNpc: (id: number) => {
            const c = pic.contacts.find(x => x.objectId === id && x.kind === 'npc');
            return c && visible(id) ? { ...nearby(c), kind: 'npc', speed: 0, model: 0, guildName: '', targetObjectId: null } as unknown as NearbyNpc : null;
        },
        sendAttack: async () => ({ success: true, message: '' }),
        waitForCondition: async () => null,
        getSkills: () => ({ styles: [] }),
        getState: () => ({ effects: [] }),
    };
    const bot = {
        killPlayer: async (id: number, opts: KillPlayerOptions) => {
            calls.killPlayer.push({ id, opts });
            return { success: true, message: 'Killed', killed: true, ...(await (o.killPlayer?.(id, opts) ?? {})) };
        },
        castSpell: async (_spell: unknown, targetId: number) => {
            calls.castSpell.push(targetId);
            return { success: true, message: 'Cast', resisted: false, completed: true, messages: [], ...(await (o.castSpell?.(targetId) ?? {})) };
        },
        walkTo: async (x: number, y: number) => { calls.walkTo.push({ x, y }); return { success: true, message: 'arrived' }; },
        attack: async (id: number) => { calls.attack.push(id); return { success: true, message: 'attacking' }; },
    };
    const ctx = {
        name: o.name, role: o.role, settings: o.settings ?? LEASHED, memory: new Map<string, any>(), sdk, bot,
        spells: { cc: () => ({ spell: { name: 'Mesmerize' }, kind: 'mezz', duration: 30 }), heal: () => null, nuke: () => null },
        me, picture: () => pic, orders: () => pic.orders, members: () => pic.members,
        member: (n: string) => pic.members.find(m => m.name === n),
        tank: () => pic.members.find(m => m.role === 'tank' && !m.isDead),
        isTank: () => o.role === 'tank',
        contact: (id: number | null | undefined) => pic.contacts.find(c => c.objectId === id),
        focus: () => pic.contacts.find(c => c.objectId === pic.orders.focus),
        threats: () => pic.contacts.filter(c => c.threat),
        doing: () => {},
        skip: (reason: string) => { skips.push(reason); return false as const; },
        result: (kind: string, r: { success: boolean; reason?: string }, targetId: number | null = null) => { results.push({ kind, success: r.success, reason: r.reason, targetId }); },
        note: () => {},
        markCc: (targetId: number, kind: string, ms: number) => { marks.push({ targetId, kind, ms }); },
        markCcImmune: (targetId: number, ms: number) => { const c = pic.contacts.find(x => x.objectId === targetId); if (c) c.ccImmuneUntil = Date.now() + ms; },
    } as unknown as MemberContext<TacticsSettings>;
    return { ctx, calls, results, marks, skips, pic };
}

/** A kill that runs until the behaviour stops it (or `ms` passes): `stopped` says which. */
function stoppable(ms = 5000) {
    const state = { stopped: false };
    const run = () => new Promise<Partial<KillPlayerResult>>(resolve => {
        const signal = executionContext.getStore()?.signal;
        const timer = setTimeout(() => resolve({ success: true }), ms);
        signal?.addEventListener('abort', () => { state.stopped = true; clearTimeout(timer); resolve({ success: false, reason: 'cancelled' }); }, { once: true });
    });
    return { state, run };
}

const healer = (x: number, y: number) => report('Healer', { role: 'healer', regionId: R, x, y, objectId: 2 });
const foe = (id: number, x: number, y: number, over: Partial<Contact> = {}) =>
    enemy(id, 'midgard', { regionId: R, x, y, threat: true, hostileSince: Date.now() - 1000, ...over });

describe('onMember: what counts as an add on a member', () => {
    const nuker = { name: 'Nuker', x: 10_000, y: 10_000 };
    test('an enemy player only in melee reach; a monster at any distance (PvE as before)', () => {
        expect(onMember(foe(52, 10_300, 10_000, { target: 'Nuker' }), nuker)).toBe(true);
        expect(onMember(foe(52, 11_500, 10_000, { target: 'Nuker' }), nuker)).toBe(false);
        expect(onMember(contact(60, { x: 11_500, y: 10_000, target: 'Nuker' }), nuker)).toBe(true);
    });
    test('a monster on a member by its spell alone: only in melee reach, like a player (flee() would draw the member into the melee)', () => {
        const caster = (x: number) => contact(60, { x, y: 10_000, target: 'Nuker', targetBySpell: true });
        expect(onMember(caster(10_300), nuker)).toBe(true);
        expect(onMember(caster(10_446), nuker)).toBe(false);
    });
    test('never one that targets someone else or is crowd-controlled', () => {
        expect(onMember(foe(52, 10_100, 10_000, { target: 'Tank' }), nuker)).toBe(false);
        expect(onMember(foe(52, 10_100, 10_000, { target: 'Nuker', cc: { by: 'Healer', kind: 'mezz', until: Date.now() + 9000 } }), nuker)).toBe(false);
    });
});

describe('pull', () => {
    const pulling = (over: Partial<Contact>) => stub({
        name: 'Tank', role: 'tank', at: { x: ANCHOR.x + 1500, y: ANCHOR.y },
        contacts: [contact(60, { regionId: R, x: ANCHOR.x + 2000, y: ANCHOR.y, target: 'Tank', ...over })],
        orders: { phase: 'pull', puller: 'Tank', focus: 60 }, settings: PVE_SETTINGS,
    });

    test('a mob the server has on the puller is walked back to the anchor', async () => {
        const s = pulling({});
        expect(await pull().run(s.ctx)).toBe(true);
        expect(s.calls.walkTo.length).toBe(1);
        expect(s.calls.attack).toEqual([]);
    });

    test('a caster on the puller by its spell alone is hit: it stands and casts, and walking back would leave the group waiting under its nukes', async () => {
        const s = pulling({ targetBySpell: true });
        expect(await pull().run(s.ctx)).toBe(true);
        expect(s.calls.walkTo).toEqual([]);
        expect(s.calls.attack).toEqual([60]);
    });
});

describe('tank: peels and the chase leash', () => {
    const focusAt = (x: number) => foe(51, x, 10_000, { target: 'Tank' });

    test('a player beyond the leash hitting the healer is no peel: the tank fights the focus inside it, and the peel never stops that fight', async () => {
        // The healer stands 2000 from the anchor; the enemy 300 from it, 2300 from the anchor.
        const s = stub({
            name: 'Tank', role: 'tank', at: ANCHOR, members: [healer(12_000, 10_000)],
            contacts: [focusAt(10_800), foe(52, 12_300, 10_000, { target: 'Healer' })], orders: { focus: 51 },
            killPlayer: async () => { await Bun.sleep(1200); return {}; },
        });
        expect(peelTarget(s.ctx)).toBeNull();
        expect(await tank().run(s.ctx)).toBe(true);
        expect(s.calls.killPlayer.map(k => k.id)).toEqual([51]);
        // Ran past two 500 ms checks of the stop predicate to its end.
        expect(s.results).toEqual([{ kind: 'kill', success: true, reason: undefined, targetId: 51 }]);
        // The chase limit counts from the tank: wide enough for a focus inside the leash of a moved anchor
        // (the leash stop ends the chase, not this backstop).
        expect(s.calls.killPlayer[0]!.opts.maxChaseDistance).toBe(5000);
    });

    test('a player in melee reach of the healer inside the leash is peeled first', async () => {
        const s = stub({
            name: 'Tank', role: 'tank', at: ANCHOR, members: [healer(11_700, 10_000)],
            contacts: [focusAt(10_800), foe(52, 11_500, 10_000, { target: 'Healer' })], orders: { focus: 51 },
        });
        expect(await tank().run(s.ctx)).toBe(true);
        expect(s.calls.killPlayer.map(k => k.id)).toEqual([52]);
    });

    test('a player nuking the healer from range is no peel; a monster add on it still is (PvE as before)', () => {
        const ranged = stub({
            name: 'Tank', role: 'tank', at: ANCHOR, members: [healer(10_000, 11_500)],
            contacts: [focusAt(10_800), foe(52, 11_500, 11_500, { target: 'Healer' })], orders: { focus: 51 },
        });
        expect(peelTarget(ranged.ctx)).toBeNull();
        const mob = contact(60, { regionId: R, x: 11_500, y: 11_500, threat: true, target: 'Healer', hostileSince: Date.now() - 1000 });
        const pve = stub({ name: 'Tank', role: 'tank', at: ANCHOR, members: [healer(10_000, 11_500)], contacts: [contact(51, { regionId: R, x: 10_300, y: 10_000, threat: true }), mob], orders: { focus: 51 }, settings: PVE_SETTINGS });
        expect(peelTarget(pve.ctx)?.objectId).toBe(60);
    });

    test('a monster casting at the healer from range is a peel, since a taunt takes it off; not while it is mezzed', () => {
        const caster = (over: Partial<Contact> = {}) => contact(60, { regionId: R, x: 11_500, y: 11_500, threat: true, target: 'Healer', targetBySpell: true, hostileSince: Date.now() - 1000, ...over });
        const pve = (add: Contact) => stub({ name: 'Tank', role: 'tank', at: ANCHOR, members: [healer(10_000, 11_500)], contacts: [contact(51, { regionId: R, x: 10_300, y: 10_000, threat: true }), add], orders: { focus: 51 }, settings: PVE_SETTINGS });
        expect(peelTarget(pve(caster()).ctx)?.objectId).toBe(60);
        expect(peelTarget(pve(caster({ cc: { by: 'Healer', kind: 'mezz', until: Date.now() + 9000 } })).ctx)).toBeNull();
    });

    test('the focus beyond the leash: the tank fights the nearest enemy inside it instead', async () => {
        const s = stub({
            name: 'Tank', role: 'tank', at: ANCHOR,
            contacts: [focusAt(12_500), foe(53, 10_300, 10_000, { target: 'Tank' }), foe(54, 11_200, 10_000, { target: 'Nuker' })], orders: { focus: 51 },
        });
        expect(leashFallback(s.ctx)?.objectId).toBe(53);
        expect(await tank().run(s.ctx)).toBe(true);
        expect(s.calls.killPlayer.map(k => k.id)).toEqual([53]);
    });

    test('with nothing inside the leash the tank lets the focus go (holdFormation brings it back)', async () => {
        const mezzed = foe(53, 10_300, 10_000, { target: 'Tank', cc: { by: 'Healer', kind: 'mezz', until: Date.now() + 9000 } });
        const s = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [focusAt(12_500), mezzed], orders: { focus: 51 } });
        expect(await tank().run(s.ctx)).toBe(false);
        expect(s.skips).toEqual(['tank: focus beyond the chase leash, no enemy inside it']);
        expect(s.calls.killPlayer).toEqual([]);
    });

    test('a fight is let go once the foe runs beyond the leash', async () => {
        const kill = stoppable();
        const f = focusAt(10_800);
        const s = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [f], orders: { focus: 51 }, killPlayer: kill.run });
        setTimeout(() => { f.x = 12_200; }, 100);
        const t0 = Date.now();
        expect(await tank().run(s.ctx)).toBe(true);
        expect(kill.state.stopped).toBe(true);
        expect(Date.now() - t0).toBeLessThan(1500);
        expect(s.results).toEqual([]);
    });

    test('a stand-in fight ends once the focus is back inside the leash', async () => {
        const kill = stoppable();
        const f = focusAt(12_500);
        const s = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [f, foe(53, 10_300, 10_000, { target: 'Tank' })], orders: { focus: 51 }, killPlayer: kill.run });
        setTimeout(() => { f.x = 11_500; }, 100);
        expect(await tank().run(s.ctx)).toBe(true);
        expect(s.calls.killPlayer.map(k => k.id)).toEqual([53]);
        expect(kill.state.stopped).toBe(true);
    });

    test('refused because we are mezzed (reason crowd_controlled): waits its retryAfterMs once', async () => {
        const s = stub({
            name: 'Tank', role: 'tank', at: ANCHOR, contacts: [focusAt(10_300)], orders: { focus: 51 },
            killPlayer: async () => ({ success: false, killed: false, reason: 'crowd_controlled', retryAfterMs: 300, message: "You can't attack when you are mesmerized!" }),
        });
        const t0 = Date.now();
        expect(await tank().run(s.ctx)).toBe(true);
        const waited = Date.now() - t0;
        expect(waited).toBeGreaterThanOrEqual(290);
        expect(waited).toBeLessThan(1000);
    });
});

describe('assist (melee): the chase leash and dying players', () => {
    test('the focus beyond the leash: melee hits the nearest enemy inside it; with none it skips', async () => {
        const s = stub({ name: 'Blade', role: 'melee', at: { x: 10_100, y: 10_000 }, contacts: [foe(51, 12_500, 10_000), foe(53, 10_400, 10_000, { target: 'Blade' })], orders: { focus: 51 } });
        expect(await assist({ melee: true }).run(s.ctx)).toBe(true);
        expect(s.calls.attack).toEqual([53]);
        const none = stub({ name: 'Blade', role: 'melee', at: { x: 10_100, y: 10_000 }, contacts: [foe(51, 12_500, 10_000)], orders: { focus: 51 } });
        expect(await assist({ melee: true }).run(none.ctx)).toBe(false);
        expect(none.skips).toEqual(['assist: focus beyond the chase leash, no enemy inside it']);
    });

    test('a player at 0 % is alive until its dead flag says otherwise', async () => {
        const at0 = () => foe(51, 10_200, 10_000, { hp: 0 });
        const living = stub({ name: 'Blade', role: 'melee', at: { x: 10_100, y: 10_000 }, contacts: [at0()], orders: { focus: 51 }, seen: { 51: { healthPercent: 0, isDead: false } } });
        expect(await assist({ melee: true }).run(living.ctx)).toBe(true);
        expect(living.calls.attack).toEqual([51]);
        const dead = stub({ name: 'Blade', role: 'melee', at: { x: 10_100, y: 10_000 }, contacts: [at0()], orders: { focus: 51 }, seen: { 51: { healthPercent: 0, isDead: true } } });
        expect(await assist({ melee: true }).run(dead.ctx)).toBe(false);
        expect(dead.skips).toEqual(['assist: focus just died']);
    });
});

describe('crowdControl: immunity and refusals', () => {
    const cc = (castSpell: StubOptions['castSpell'], over: Partial<StubOptions> = {}) => stub({
        name: 'Healer', role: 'healer', at: { x: 10_000, y: 10_500 }, contacts: [foe(51, 10_300, 10_000), foe(52, 11_000, 10_500)],
        orders: { focus: 51, cc: [{ targetId: 52, by: 'Healer' }] }, castSpell, ...over,
    });

    test('"Your target is immune to this effect!" after the cast (effectImmune): no mezz on the board, and the target is left alone', async () => {
        const s = cc(async () => ({
            success: true, effectImmune: true, message: 'Cast Mesmerize on Norseman (target immune)',
            messages: [{ text: 'You cast a Mesmerize spell!' }, { text: 'Your target is immune to this effect!' }] as CastResult['messages'],
        }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks).toEqual([]);
        expect((s.ctx.memory.get('ccImmune') as Map<string, number>).has(ckey(s.pic.contacts[1]!))).toBe(true);
        // ... and the board knows, so the coordinator assigns it to nobody else.
        expect(s.pic.contacts[1]!.ccImmuneUntil).toBeGreaterThan(Date.now() + 50_000);
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([52]);
    });

    test('a target another member found immune (the board\'s mark) is left alone too', async () => {
        const s = cc(async () => ({ success: true, messages: [] as CastResult['messages'] }));
        s.pic.contacts[1]!.ccImmuneUntil = Date.now() + 30_000;
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
    });

    test('the target\'s PvP immunity (reason immune) only waits retryAfterMs: the next turn mezzes again', async () => {
        const text = 'Norseman is temporarily immune to PvP attacks!';
        const s = cc(async () => ({ success: false, reason: 'immune', retryAfterMs: 300, message: text, messages: [{ text }] as CastResult['messages'] }));
        const t0 = Date.now();
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
        expect([...(s.ctx.memory.get('ccImmune') as Map<string, number>).keys()]).toEqual([]);
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([52, 52]);
    });

    test('refused because we are mezzed (reason crowd_controlled): waits its retryAfterMs once, marks nothing', async () => {
        const s = cc(async () => ({ success: false, reason: 'crowd_controlled', retryAfterMs: 300, message: "You can't cast while mesmerized!" }));
        const t0 = Date.now();
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        const waited = Date.now() - t0;
        expect(waited).toBeGreaterThanOrEqual(290);
        expect(waited).toBeLessThan(1000);
        expect(s.marks).toEqual([]);
        expect([...(s.ctx.memory.get('ccImmune') as Map<string, number>).keys()]).toEqual([]);
    });

    test('an assignment our client can\'t see gives way to the next one it can', async () => {
        const s = cc(undefined, {
            contacts: [foe(51, 10_300, 10_000), foe(52, 11_000, 10_500), foe(54, 10_800, 10_800)],
            orders: { focus: 51, cc: [{ targetId: 52, by: 'Healer' }, { targetId: 54, by: 'Healer' }] }, inView: [51, 54],
        });
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([54]);
        expect(s.marks.map(m => m.targetId)).toEqual([54]);
        const blind = cc(undefined, { inView: [51] });
        expect(await crowdControl({ assignedOnly: true }).run(blind.ctx)).toBe(false);
        expect(blind.skips).toEqual(['cc: target not in view']);
    });
});

describe('flee: only from what can follow us to the tank', () => {
    const tankM = report('Tank', { role: 'tank', regionId: R, x: ANCHOR.x, y: ANCHOR.y, objectId: 3 });
    const run = async (c: Contact) => {
        const s = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 10_700 }, members: [tankM], contacts: [c], orders: { focus: 99 } });
        return { acted: await flee().run(s.ctx), walks: s.calls.walkTo };
    };
    test('an enemy caster nuking us from 1500 is no reason to run; one in melee reach is; a monster always (PvE as before)', async () => {
        expect(await run(foe(52, 10_000, 12_200, { target: 'Nuker' }))).toEqual({ acted: false, walks: [] });
        expect((await run(foe(52, 10_000, 10_900, { target: 'Nuker' }))).walks).toEqual([{ x: ANCHOR.x, y: ANCHOR.y }]);
        expect((await run(contact(60, { regionId: R, x: 10_000, y: 12_200, threat: true, target: 'Nuker' }))).walks).toEqual([{ x: ANCHOR.x, y: ANCHOR.y }]);
    });
});

describe('holdFormation in a fight', () => {
    test('fightRejoin: tank and melee come back from beyond the leash, everyone from 3000', () => {
        expect(fightRejoin('tank', 2000)).toBe(2000);
        expect(fightRejoin('melee', 2000)).toBe(2000);
        expect(fightRejoin('nuker', 2000)).toBe(3000);
        expect(fightRejoin('tank', undefined)).toBe(3000);
        expect(fightRejoin('tank', 5000)).toBe(3000);
    });

    const cases: [Role, TacticsSettings, number, boolean][] = [
        ['tank', LEASHED, 2500, true], ['tank', LEASHED, 3500, true], ['melee', LEASHED, 2500, true],
        ['nuker', LEASHED, 2500, false], ['tank', PVE_SETTINGS, 2500, false], ['tank', PVE_SETTINGS, 3500, true],
    ];
    for (const [role, settings, d, walks] of cases) {
        test(`${role} ${d} from the anchor, ${settings.chaseLeash ? 'leash 2000' : 'no leash'}: ${walks ? 'walks back' : 'stays'}`, async () => {
            const at = { x: ANCHOR.x + d, y: ANCHOR.y };
            const s = stub({ name: 'Member', role, at, settings, contacts: [foe(51, 13_000, 10_000)], orders: { focus: 51 } });
            expect(await holdFormation().run(s.ctx)).toBe(walks);
            expect(s.calls.walkTo.length).toBe(walks ? 1 : 0);
            // Toward the anchor, in short legs while inside 3000 (the fight behaviours get a turn between them).
            const to = s.calls.walkTo[0];
            if (to) {
                expect(dist(to, ANCHOR)).toBeLessThan(d);
                expect(dist(to, at)).toBeLessThanOrEqual(d < 3000 ? 1000 + 1 : 2500 + 1);
            }
        });
    }
});
