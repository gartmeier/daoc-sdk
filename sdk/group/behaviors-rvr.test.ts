// Behaviours against enemy players, run on a stub MemberContext: a fixed picture and orders,
// our own client's view (getNearbyPlayer / getNearbyNpc), and bot actions that answer with
// canned results. Region 9999 has no spawns, so safeSpot and safePath see no danger.
import type { CcKind } from './cc';
import { describe, expect, test } from 'bun:test';
import type { CastResult, KillPlayerOptions, KillPlayerResult } from '../actions';
import { executionContext } from '../execution-context';
import type { CombatEvent, NearbyNpc, NearbyPlayer } from '../types';
import { shaman } from '../classes/shaman';
import { assist, ckey, crowdControl, interrupt, fightRejoin, flee, guard, heal, holdFormation, isDown, leashFallback, onMember, peelTarget, pull, rejoinFight, rest, retreat, spareNuke, tank, type TacticsSettings } from './behaviors';
import { withCharacter } from './character';
import { rvrBehaviors } from './rvr';
import { contact, enemy, picture, report } from './fixtures';
import type { MemberContext } from './member';
import { assignCc, PVE_SETTINGS } from './pve';
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
    /** Our own client's combat events. */
    combatEvents?: CombatEvent[];
    walk?: { success: boolean; reason?: string; message?: string };
    attack?: { success: boolean; reason?: string; message?: string; retryAfterMs?: number };
    killNpc?: { success: boolean; killed?: boolean; reason?: string; message?: string };
    rest?: { success: boolean; reason?: string; message?: string };
    /** What the spellbook has for a heal. */
    healSpell?: unknown;
    /** Whether its spell list has a heal at all (default true). */
    canHeal?: boolean;
    manaPercent?: number;
}

function stub(o: StubOptions) {
    const calls = { killPlayer: [] as { id: number; opts: KillPlayerOptions }[], castSpell: [] as number[], walkTo: [] as Point[], attack: [] as number[], killNpc: [] as { id: number; opts: unknown }[], rest: 0 };
    const results: { kind: string; success: boolean; reason?: string; targetId: number | null }[] = [];
    const marks: { targetId: number; kind: string; ms: number; serverName?: string }[] = [];
    const skips: string[] = [];
    const meReport = report(o.name, { role: o.role, regionId: R, x: o.at.x, y: o.at.y, level: 20, objectId: 1 });
    const pic = picture([meReport, ...(o.members ?? [])], o.contacts ?? [], { phase: 'engage', anchor: ANCHOR, facing: { x: ANCHOR.x + 1000, y: ANCHOR.y }, ...o.orders });
    const me = () => ({ name: o.name, objectId: 1, regionId: R, x: o.at.x, y: o.at.y, z: 0, level: 20, attacking: false, targetObjectId: null, maxMana: 100, mana: 100, manaPercent: o.manaPercent ?? 100, healthPercent: 100 });
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
        getState: () => ({ effects: [], timestamp: Date.now(), combatEvents: o.combatEvents ?? [] }),
    };
    const bot = {
        killPlayer: async (id: number, opts: KillPlayerOptions) => {
            calls.killPlayer.push({ id, opts });
            return { success: true, message: 'Killed', killed: true, ...(await (o.killPlayer?.(id, opts) ?? {})) };
        },
        castHeldLeftMs: () => 0,
        castSpell: async (_spell: unknown, targetId: number) => {
            calls.castSpell.push(targetId);
            return { success: true, message: 'Cast', resisted: false, completed: true, messages: [], ...(await (o.castSpell?.(targetId) ?? {})) };
        },
        walkTo: async (x: number, y: number) => { calls.walkTo.push({ x, y }); return { success: true, message: 'arrived', ...o.walk }; },
        followPath: async () => ({ success: true, message: 'arrived', ...o.walk }),
        attack: async (id: number) => { calls.attack.push(id); return { success: true, message: 'attacking', ...o.attack }; },
        killNpc: async (id: number, opts: unknown) => { calls.killNpc.push({ id, opts }); return { success: true, message: 'Killed', killed: true, ...o.killNpc }; },
        getAttackers: () => [],
        getPlayerAttackers: () => [],
        rest: async () => { calls.rest++; return { success: true, message: 'Rested', ...o.rest }; },
    };
    const ctx = {
        name: o.name, role: o.role, settings: o.settings ?? LEASHED, memory: new Map<string, any>(), sdk, bot,
        spells: { cc: (opts: { except?: string[] } = {}) => (opts.except?.includes('mezz') ? null : { spell: { name: 'Mesmerize' }, kind: 'mezz', duration: 30, range: 1500 }), heal: () => o.healSpell ?? null, nuke: () => ({ spell: { name: 'Moon Blast' }, type: 'DirectDamage' }), capabilities: () => ({ ccKinds: ['mezz'], heal: o.canHeal ?? true }) },
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
        markCc: (targetId: number, kind: string, ms: number, serverName?: string) => { marks.push({ targetId, kind, ms, ...(serverName ? { serverName } : {}) }); },
        markCcImmune: (targetId: number, kind: CcKind, ms: number) => { const c = pic.contacts.find(x => x.objectId === targetId); if (c) (c.ccImmune ??= {})[kind] = Date.now() + ms; },
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
    test('an enemy pet like a player: in melee reach only (a run to the tank or a taunt doesn\'t move an ordered pet)', () => {
        const pet = (x: number) => contact(70, { realm: 'midgard', isPet: true, x, y: 10_000, target: 'Nuker' });
        expect(onMember(pet(10_300), nuker)).toBe(true);
        expect(onMember(pet(11_500), nuker)).toBe(false);
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
        // The chase limit counts from where it stood: wide enough for a focus inside the leash of a moved anchor,
        // which can have moved twice the leash (the leash stop ends the chase, not this backstop).
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

    test('with a leash, such a caster is a peel only inside it, and never away from an enemy player', () => {
        const caster = (x: number) => contact(60, { regionId: R, x, y: 10_000, threat: true, target: 'Healer', targetBySpell: true, hostileSince: Date.now() - 1000 });
        const monster = contact(51, { regionId: R, x: 10_300, y: 10_000, threat: true });
        const leashed = (focus: Contact, add: Contact) => stub({ name: 'Tank', role: 'tank', at: ANCHOR, members: [healer(10_000, 11_500)], contacts: [focus, add], orders: { focus: 51 } });
        expect(peelTarget(leashed(monster, caster(11_500)).ctx)?.objectId).toBe(60);
        expect(peelTarget(leashed(monster, caster(12_500)).ctx)).toBeNull();
        expect(peelTarget(leashed(focusAt(10_300), caster(11_500)).ctx)).toBeNull();
    });

    test('an enemy pet casting at the healer from range is no such peel: a taunt doesn\'t move an ordered pet', () => {
        const pet = contact(60, { regionId: R, realm: 'midgard', isPet: true, x: 11_500, y: 11_500, threat: true, target: 'Healer', targetBySpell: true, hostileSince: Date.now() - 1000 });
        const s = stub({ name: 'Tank', role: 'tank', at: ANCHOR, members: [healer(10_000, 11_500)], contacts: [contact(51, { regionId: R, x: 10_300, y: 10_000, threat: true }), pet], orders: { focus: 51 }, settings: PVE_SETTINGS });
        expect(peelTarget(s.ctx)).toBeNull();
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

describe('assist: a crowd-controlled focus', () => {
    const root = () => ({ cc: { by: 'Druid', kind: 'root', until: Date.now() + 20_000 } });
    const mezz = () => ({ cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 20_000 } });
    const at = { x: 10_100, y: 10_000 };

    // Run 20261103-174453: "Members idle assist: focus is crowd-controlled", Petbon "idle 64%", Pethun "idle 58%", first order on Celt at +32.3.
    test('a root is hit when it is all that\'s left in the fight: it has done its job', async () => {
        const melee = stub({ name: 'Blade', role: 'melee', at, contacts: [foe(51, 10_200, 10_000, root())], orders: { focus: 51 } });
        expect(await assist({ melee: true }).run(melee.ctx)).toBe(true);
        expect(melee.calls.attack).toEqual([51]);
        const nuke = stub({ name: 'Menta', role: 'nuker', at, contacts: [foe(51, 10_200, 10_000, root())], orders: { focus: 51 } });
        expect(await assist().run(nuke.ctx)).toBe(true);
        expect(nuke.calls.castSpell).toEqual([51]);
    });

    // User, live in Thidranki: with every enemy mezzed the group stood by them and rebuffed. The coordinator picks one off (pack.ts, decideRvr).
    test('a mezz, the same: with every other enemy crowd-controlled the focus is the one to break', async () => {
        const melee = stub({ name: 'Blade', role: 'melee', at, contacts: [foe(51, 10_200, 10_000, mezz()), foe(53, 10_300, 10_000, mezz())], orders: { focus: 51 } });
        expect(await assist({ melee: true }).run(melee.ctx)).toBe(true);
        expect(melee.calls.attack).toEqual([51]);
        const nuke = stub({ name: 'Menta', role: 'nuker', at, contacts: [foe(51, 10_200, 10_000, mezz())], orders: { focus: 51 } });
        expect(await assist().run(nuke.ctx)).toBe(true);
        expect(nuke.calls.castSpell).toEqual([51]);
    });

    test('nor a mezz with something else free in the fight', async () => {
        const s = stub({ name: 'Blade', role: 'melee', at, contacts: [foe(51, 10_200, 10_000, mezz()), foe(53, 10_300, 10_000)], orders: { focus: 51 } });
        expect(await assist({ melee: true }).run(s.ctx)).toBe(false);
        expect(s.skips).toEqual(['assist: focus is crowd-controlled']);
    });

    test('nor a mezzed add that isn\'t the focus', async () => {
        const s = stub({ name: 'Blade', role: 'melee', at, contacts: [foe(51, 10_200, 10_000, mezz())], orders: { focus: 53 } });
        expect(await assist({ melee: true }).run(s.ctx)).toBe(false);
    });

    test('nor a root with something else free in the fight, while the coordinator moves the focus', async () => {
        const s = stub({ name: 'Blade', role: 'melee', at, contacts: [foe(51, 10_200, 10_000, root()), foe(53, 10_300, 10_000)], orders: { focus: 51 } });
        expect(await assist({ melee: true }).run(s.ctx)).toBe(false);
        expect(s.skips).toEqual(['assist: focus is crowd-controlled']);
    });

    test('something else under cc is nothing free: the root still gets hit', async () => {
        const s = stub({ name: 'Blade', role: 'melee', at, contacts: [foe(51, 10_200, 10_000, root()), foe(53, 10_300, 10_000, mezz())], orders: { focus: 51 } });
        expect(await assist({ melee: true }).run(s.ctx)).toBe(true);
        expect(s.calls.attack).toEqual([51]);
    });
});

describe('flee: a rooted mob with us in its reach', () => {
    const root = (x: number, target = 'Druid') => contact(60, { regionId: R, x, y: 10_000, threat: true, target, cc: { by: 'Bard', kind: 'root', until: Date.now() + 15_000 } });
    const run = async (mob: Contact) => {
        const s = stub({ name: 'Druid', role: 'healer', at: { x: 10_000, y: 10_000 }, members: [report('Tank', { role: 'tank', regionId: R, x: 11_000, y: 10_000, objectId: 3 })], contacts: [mob] });
        return { acted: await flee().run(s.ctx), walks: s.calls.walkTo.length };
    };

    // "The water beetle hits your hand for 25 damage!", feet frozen: now that a swing leaves the root on the board, nothing else moves us out of it.
    test('it swings on and can\'t follow: we go', async () => {
        expect(await run(root(10_100))).toEqual({ acted: true, walks: 1 });
    });

    test('not out of its reach, nor from one on somebody else, nor from a mezzed one', async () => {
        expect((await run(root(10_600))).acted).toBe(false);
        expect((await run(root(10_100, 'Tank'))).acted).toBe(false);
        expect((await run({ ...root(10_100), cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 15_000 } })).acted).toBe(false);
    });
});

describe('heal: a member with nothing to heal with', () => {
    const hurt = () => report('Blade', { role: 'melee', regionId: R, x: 10_000, y: 10_000, hp: 40, objectId: 9 });

    // r5 member activity ('petbon','idle','heal: not enough power') with mana 100 %, capabilities heal:false.
    test('says nothing about power', async () => {
        const s = stub({ name: 'Menta', role: 'nuker', at: { x: 10_000, y: 10_100 }, members: [hurt()], canHeal: false });
        expect(await heal().run(s.ctx)).toBe(false);
        expect(s.skips).toEqual([]);
    });

    test('one that has a heal and can\'t pay for it says so', async () => {
        const s = stub({ name: 'Druid', role: 'healer', at: { x: 10_000, y: 10_100 }, members: [hurt()], canHeal: true });
        expect(await heal().run(s.ctx)).toBe(false);
        expect(s.skips).toEqual(['heal: not enough power']);
    });
});

describe('isDown and assist: a monster at 0 %', () => {
    const at0 = () => contact(60, { regionId: R, x: 10_200, y: 10_000, hp: 1, threat: true, hostileSince: Date.now() - 10_000 });
    const opts = (events: CombatEvent[]) => ({ name: 'Blade', role: 'melee' as const, at: { x: 10_100, y: 10_000 }, contacts: [at0()], orders: { focus: 60 }, seen: { 60: { healthPercent: 0, isDead: false } }, combatEvents: events });
    const died = (ago: number): CombatEvent => ({ id: 1, kind: 'death', attackerObjectId: null, targetObjectId: 60, receivedAt: Date.now() - ago });

    test('with no death event it fights on (GameLiving.cs:2621 truncates under 1 %)', async () => {
        const s = stub(opts([]));
        expect(await assist({ melee: true, holdMs: 0 }).run(s.ctx)).toBe(true);
        expect(s.calls.attack).toEqual([60]);
    });

    test('with a fresh one it is dead', async () => {
        const s = stub(opts([died(200)]));
        expect(await assist({ melee: true, holdMs: 0 }).run(s.ctx)).toBe(false);
        expect(s.skips).toEqual(['assist: focus just died']);
    });

    test('isDown: above 0 % never, an old event is an earlier holder of the id, a player by its flag alone', () => {
        const fresh = stub(opts([died(200)]));
        const npc = (healthPercent: number) => ({ kind: 'npc', objectId: 60, healthPercent }) as NearbyNpc;
        expect(isDown(fresh.ctx, npc(0))).toBe(true);
        expect(isDown(fresh.ctx, npc(3))).toBe(false);
        expect(isDown(stub(opts([died(6000)])).ctx, npc(0))).toBe(false);
        const player = (isDead: boolean) => ({ kind: 'player', objectId: 60, healthPercent: 0, isDead }) as NearbyPlayer;
        expect(isDown(fresh.ctx, player(false))).toBe(false);
        expect(isDown(fresh.ctx, player(true))).toBe(true);
    });
});

describe('crowdControl: an enemy pet', () => {
    test('is nobody\'s add to mezz unasked; a real add next to it is', async () => {
        const pet = contact(70, { regionId: R, realm: 'midgard', isPet: true, x: 10_300, y: 10_000, target: 'Healer', threat: true, hostileSince: Date.now() - 1000 });
        const onlyPet = stub({ name: 'Bard', role: 'support', at: { x: 10_000, y: 10_500 }, contacts: [foe(51, 10_300, 10_000), pet], orders: { focus: 51 } });
        expect(await crowdControl().run(onlyPet.ctx)).toBe(false);
        expect(onlyPet.calls.castSpell).toEqual([]);
        const withAdd = stub({ name: 'Bard', role: 'support', at: { x: 10_000, y: 10_500 }, contacts: [foe(51, 10_300, 10_000), pet, foe(52, 10_400, 10_000)], orders: { focus: 51 } });
        expect(await crowdControl().run(withAdd.ctx)).toBe(true);
        expect(withAdd.calls.castSpell).toEqual([52]);
    });
});

describe('crowdControl: what an add can take, by immunity and by its health', () => {
    const MEZZ = { spell: { name: 'Mesmerize' }, kind: 'mezz', duration: 30 };
    const ROOT = { spell: { name: 'Webbing' }, kind: 'root', duration: 30 };
    const at = { x: 10_000, y: 10_500 };
    const npc = (over: Partial<Contact>) => contact(52, { regionId: R, x: 11_000, y: 10_500, threat: true, target: 'Healer', hostileSince: Date.now() - 1000, ...over });
    const world = (add: Contact) => {
        const s = stub({ name: 'Healer', role: 'healer', at, contacts: [foe(51, 10_300, 10_000), add], orders: { focus: 51, cc: [{ targetId: 52, by: 'Healer' }] } });
        Object.assign(s.ctx.spells, {
            cc: (opts: { except?: string[] } = {}) => (opts.except?.includes('mezz') ? (opts.except.includes('root') ? null : ROOT) : MEZZ),
            root: () => ROOT,
            capabilities: () => ({ ccKinds: ['mezz', 'root'] }),
        });
        return s;
    };
    const immune = (...kinds: string[]) => ({ ccImmune: Object.fromEntries(kinds.map(k => [k, Date.now() + 30_000])) });

    test('under 75 %: the root, since a mezz only costs the power', async () => {
        const s = world(npc({ hp: 70 }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks.map(m => m.kind)).toEqual(['root']);
    });

    test('under 75 % in our own client with the board still at 80: the root. m4: read 80 at 28.40, mezz begun 28.803, 67 at 29.008, "Your target is enraged"', async () => {
        const s = stub({ name: 'Healer', role: 'healer', at, contacts: [foe(51, 10_300, 10_000), npc({ hp: 80 })], orders: { focus: 51, cc: [{ targetId: 52, by: 'Healer' }] }, seen: { 52: { healthPercent: 67, isDead: false } } });
        Object.assign(s.ctx.spells, { cc: () => MEZZ, root: () => ROOT, capabilities: () => ({ ccKinds: ['mezz', 'root'] }) });
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks.map(m => m.kind)).toEqual(['root']);
    });

    test('immune to a mezz at full health: the root, as the board says', async () => {
        const s = world(npc(immune('mezz')));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks.map(m => m.kind)).toEqual(['root']);
    });

    test('under 75 % and immune to a root: nothing can land, so no cast and no failure, and the list goes on', async () => {
        const s = world(npc({ hp: 70, ...immune('root') }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
        expect(s.results).toEqual([]);
    });

    test('assignCc the same: under 75 % only to a member with a root, and not one it is immune to', () => {
        const rooter = report('Bone', { role: 'nuker', capabilities: { heal: false, cc: true, root: true, ccKinds: ['root'], nuke: true, buffs: [], buffSpells: [] } });
        const mezzer = report('Bard', { role: 'support', capabilities: { heal: false, cc: true, ccKinds: ['mezz'], nuke: false, buffs: [], buffSpells: [] } });
        expect(assignCc([npc({ hp: 70 })], [mezzer, rooter], [])).toEqual([{ targetId: 52, by: 'Bone' }]);
        expect(assignCc([npc({ hp: 70, ...immune('root') })], [mezzer, rooter], [])).toEqual([]);
        expect(assignCc([npc(immune('mezz'))], [mezzer, rooter], [])).toEqual([{ targetId: 52, by: 'Bone' }]);
    });

    test('an area mezz takes our pet off a neighbour it catches before the cast, and marks both', async () => {
        const sequence: string[] = [];
        const s = stub({
            name: 'Healer', role: 'healer', at, settings: { ...LEASHED, areaMezzMin: 2 },
            contacts: [foe(51, 12_000, 10_000), foe(52, 11_000, 10_500), foe(53, 11_100, 10_500)], orders: { focus: 51, cc: [{ targetId: 52, by: 'Healer' }] },
            castSpell: async () => { sequence.push('cast'); return {}; },
        });
        Object.assign(s.ctx.spells, { areaMezz: () => ({ spell: { name: 'Dark Wave' }, radius: 350, range: 1500, duration: 30 }), knowsTurret: () => false });
        Object.assign(s.ctx.sdk, {
            getState: () => ({ effects: [], pet: { targetObjectId: 53, walk: 'follow' } }),
            sendPetCommand: async (command: string) => { sequence.push(command); return { success: true, message: '' }; },
        });
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(sequence).toEqual(['follow', 'cast']);
        expect(s.marks.map(m => m.targetId)).toEqual([52, 53]);
    });
});

describe('crowdControl: holding ground', () => {
    const at = { x: 10_000, y: 10_000 };
    const run = async (role: Role, contacts: Contact[], assignedId: number) => {
        const s = stub({ name: 'Bard', role, at, contacts, orders: { focus: 51, cc: [{ targetId: assignedId, by: 'Bard' }] }, settings: { ...LEASHED, standGround: true, standStep: 500 }, castSpell: async () => ({ success: true, message: 'Cast' }) });
        const acted = await crowdControl().run(s.ctx);
        return { acted, cast: s.calls.castSpell, walks: s.calls.walkTo };
    };
    const focus = foe(51, 9000, 10_000);

    test('assigned the far one, it mezzes the one in reach instead of standing idle', async () => {
        const r = await run('support', [focus, foe(52, 11_800, 10_000), foe(53, 11_000, 10_000)], 52);
        expect(r).toMatchObject({ acted: true, cast: [53], walks: [] });
    });

    test('nothing in reach: the Bard steps just far enough', async () => {
        const r = await run('support', [focus, foe(52, 11_700, 10_000)], 52);
        expect(r.cast).toEqual([]);
        expect(r.walks.length).toBe(1);
        expect(r.walks[0]!.x).toBeCloseTo(10_300);
    });

    test('a target too far for a step, or another member: holds', async () => {
        expect((await run('support', [focus, foe(52, 12_400, 10_000)], 52)).walks).toEqual([]);
        expect((await run('healer', [focus, foe(52, 11_700, 10_000)], 52)).walks).toEqual([]);
    });
});

describe('crowdControl: immunity and refusals', () => {
    const cc = (castSpell: StubOptions['castSpell'], over: Partial<StubOptions> = {}) => stub({
        name: 'Healer', role: 'healer', at: { x: 10_000, y: 10_500 }, contacts: [foe(51, 10_300, 10_000), foe(52, 11_000, 10_500)],
        orders: { focus: 51, cc: [{ targetId: 52, by: 'Healer' }] }, castSpell, ...over,
    });

    test('the server says out of range twice on one target: it is left a while and the turn goes on (arena round 32: 9 in a row)', async () => {
        const far = async () => ({ success: false, reason: 'out_of_range', message: 'That target is too far away!' });
        const s = cc(far);
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([52, 52]);
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([52, 52]);
    });

    test('an enemy player swinging at us: no mezz with a cast time, it would be interrupted (hammeredBy)', async () => {
        const s = cc(async () => ({ success: true, message: 'Cast' }), { contacts: [foe(51, 10_300, 10_000), foe(52, 11_000, 10_500), foe(53, 10_000, 10_650, { target: 'Healer' })] });
        Object.assign(s.ctx.spells, { cc: () => ({ spell: { name: 'Mesmerize' }, kind: 'mezz', duration: 30, range: 1500, castTime: 2.5 }) });
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
        expect(s.skips.at(-1)).toMatch(/would be interrupted/);
    });

    test('"Your target is immune to this effect!" after the cast (effectImmune): no mezz on the board, and the target is left alone', async () => {
        const s = cc(async () => ({
            success: true, effectImmune: true, message: 'Cast Mesmerize on Norseman (target immune)',
            messages: [{ text: 'You cast a Mesmerize spell!' }, { text: 'Your target is immune to this effect!' }] as CastResult['messages'],
        }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks).toEqual([]);
        // The board knows, so the coordinator assigns it to nobody else, and the report calls it what it was.
        expect(s.pic.contacts[1]!.ccImmune!.mezz).toBeGreaterThan(Date.now() + 50_000);
        expect(s.results[0]).toMatchObject({ kind: 'cc', success: false, reason: 'immune' });
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([52]);
    });

    test('a target another member found immune (the board\'s mark) is left alone too', async () => {
        const s = cc(async () => ({ success: true, messages: [] as CastResult['messages'] }));
        s.pic.contacts[1]!.ccImmune = { mezz: Date.now() + 30_000 };
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
    });

    test('the target\'s PvP immunity (reason immune) only waits retryAfterMs: the next turn mezzes again', async () => {
        const text = 'Norseman is temporarily immune to PvP attacks!';
        const s = cc(async () => ({ success: false, reason: 'immune', retryAfterMs: 300, message: text, messages: [{ text }] as CastResult['messages'] }));
        const t0 = Date.now();
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
        expect(s.pic.contacts[1]!.ccImmune).toBeUndefined();
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
        expect(s.pic.contacts[1]!.ccImmune).toBeUndefined();
    });

    test('the server named what it landed on: on the board, for the whole spell', async () => {
        const s = cc(async () => ({ success: true, effectLanded: true, landedOn: 'Oisin' }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks).toEqual([{ targetId: 52, kind: 'mezz', ms: 30_000, serverName: 'Oisin' }]);
        expect(s.results[0]).toMatchObject({ success: true });
    });

    test('"already has that effect": held for up to the spell and the immunity after it, no mezz of ours on the board', async () => {
        const s = cc(async () => ({ success: true, alreadyOn: true, effectLanded: false }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks).toEqual([]);
        expect(s.pic.contacts[1]!.ccImmune!.mezz).toBeGreaterThan(Date.now() + 85_000);
        expect(s.results[0]).toMatchObject({ success: false, reason: 'already_on' });
    });

    test('resisted: nothing on the board, and it may be tried again at once', async () => {
        const s = cc(async () => ({ success: true, resisted: true, effectLanded: false }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks).toEqual([]);
        expect(s.pic.contacts[1]!.ccImmune).toBeUndefined();
        expect(s.results[0]).toMatchObject({ success: false, reason: 'resisted' });
    });

    test('a player with no line from the server: not marked as held', async () => {
        const s = cc(async () => ({ success: true, effectLanded: false }));
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks).toEqual([]);
        expect(s.results[0]).toMatchObject({ success: false, reason: 'no_effect' });
    });

    test('a monster with no line: the repeat replaced the old effect without a word, so it holds', async () => {
        const s = cc(async () => ({ success: true, effectLanded: false }));
        s.pic.contacts[1]!.kind = 'npc';
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        expect(s.marks.map(m => m.kind)).toEqual(['mezz']);
    });

    test('a target held or being cast at by another member is left alone, and an immune one is skipped for a free one', async () => {
        const claimed = cc(undefined);
        claimed.pic.members.push(report('Bard', { role: 'support', activity: { kind: 'cc', targetId: 52, detail: '', since: Date.now() } }));
        expect(await crowdControl({ assignedOnly: true }).run(claimed.ctx)).toBe(false);
        expect(claimed.calls.castSpell).toEqual([]);

        const held = cc(undefined);
        held.pic.contacts[1]!.cc = { by: 'Bard', kind: 'mezz', until: Date.now() + 10_000 };
        expect(await crowdControl({ assignedOnly: true }).run(held.ctx)).toBe(false);
        expect(held.calls.castSpell).toEqual([]);

        const next = cc(undefined, { contacts: [foe(51, 10_300, 10_000), foe(52, 11_000, 10_500), foe(54, 10_800, 10_800)], orders: { focus: 51, cc: [{ targetId: 52, by: 'Healer' }, { targetId: 54, by: 'Healer' }] } });
        next.pic.contacts[1]!.ccImmune = { mezz: Date.now() + 10_000 };
        expect(await crowdControl({ assignedOnly: true }).run(next.ctx)).toBe(true);
        expect(next.calls.castSpell).toEqual([54]);
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

    test('at the tank with an enemy player still swinging: round the tank to its far side from it, inside 150 (arena rounds 1-4: the Bard cast into the swings)', async () => {
        const s = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 10_050 }, members: [tankM], contacts: [foe(52, 10_000, 10_200, { target: 'Nuker' })], orders: { focus: 99 } });
        expect(await flee().run(s.ctx)).toBe(true);
        expect(s.calls.walkTo).toHaveLength(1);
        expect(s.calls.walkTo[0]!.y).toBeCloseTo(ANCHOR.y - 130, 0);
        // Standing there already: a quarter turn round the tank, still within 150 of it.
        const again = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 9_870 }, members: [tankM], contacts: [foe(52, 10_000, 10_050, { target: 'Nuker' })], orders: { focus: 99 } });
        expect(await flee().run(again.ctx)).toBe(true);
        const to = again.calls.walkTo[0]!;
        expect(Math.hypot(to.x - ANCHOR.x, to.y - ANCHOR.y)).toBeCloseTo(130, 0);
        expect(Math.abs(to.x - ANCHOR.x)).toBeCloseTo(130, 0);
        // A monster there is the tank's to take back, as before.
        const m = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 10_050 }, members: [tankM], contacts: [contact(60, { regionId: R, x: 10_000, y: 10_200, threat: true, target: 'Nuker' })], orders: { focus: 99 } });
        expect(await flee().run(m.ctx)).toBe(false);
        expect(m.calls.walkTo).toEqual([]);
    });
});

describe('rejoinFight', () => {
    const cases: [string, Role, number, Partial<Orders>, boolean][] = [
        ['a nuker back from a release', 'nuker', 20_000, { focus: 51 }, true],
        ['a tank back from a release', 'tank', 6000, { focus: 51 }, true],
        ['a member at the fight', 'nuker', 2500, { focus: 51 }, false],
        ['a member 5000 off', 'tank', 5000, { focus: 51 }, false],
        ['a member far off outside a fight', 'nuker', 20_000, { phase: 'travel' }, false],
        ['with no anchor', 'nuker', 20_000, { focus: 51, anchor: null }, false],
    ];
    for (const [what, role, d, orders, walks] of cases) {
        test(`${what}: ${walks ? 'walks one leg back' : 'leaves it to the others'}`, async () => {
            const at = { x: ANCHOR.x + d, y: ANCHOR.y };
            const s = stub({ name: 'Member', role, at, contacts: [foe(51, ANCHOR.x, ANCHOR.y)], orders });
            expect(await rejoinFight().run(s.ctx)).toBe(walks);
            expect(s.calls.walkTo.length).toBe(walks ? 1 : 0);
            expect(s.calls.killPlayer).toEqual([]);
            const to = s.calls.walkTo[0];
            if (to) {
                expect(dist(to, ANCHOR)).toBeLessThan(d);
                expect(dist(to, at)).toBeLessThanOrEqual(2501);
            }
        });
    }
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

describe('refusals that come back at once: reported, so the agent paces them (member.ts failedTurnMs)', () => {
    // castSpell's before any walk or send; each was a turn's try and a logged line, four times a second, with no result to pace it for some.
    const refusals = ['invalid_target', 'not_attackable', 'no_target', 'already_dead', 'not_found', 'cooldown', 'spell_not_found'];
    const hurt = () => report('Healer', { role: 'healer', regionId: R, x: 10_000, y: 10_400, objectId: 2, hp: 20, maxHp: 400 });

    for (const reason of refusals) {
        test(`assist's nuke, heal: ${reason}`, async () => {
            const castSpell = async () => ({ success: false, reason, message: 'no' });
            const nuke = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 10_500 }, contacts: [foe(51, 10_300, 10_000)], orders: { focus: 51 }, castSpell });
            expect(await assist().run(nuke.ctx)).toBe(true);
            expect(nuke.results).toEqual([{ kind: 'nuke', success: false, reason, targetId: 51 }]);
            const healing = stub({ name: 'Druid', role: 'healer', at: { x: 10_000, y: 10_500 }, members: [hurt()], castSpell, healSpell: { spell: { name: 'Minor Recovery' } } });
            expect(await heal().run(healing.ctx)).toBe(true);
            expect(healing.results).toEqual([{ kind: 'heal', success: false, reason, targetId: 2 }]);
        });
    }

    for (const reason of ['invalid_target', 'not_attackable', 'no_target']) {
        test(`crowdControl: ${reason} can never land, so the next add gets the turn`, async () => {
            const orders = { focus: 51, cc: [{ targetId: 52, by: 'Bard' }, { targetId: 54, by: 'Bard' }] };
            const s = stub({ name: 'Bard', role: 'support', at: { x: 10_000, y: 10_500 }, contacts: [foe(51, 10_300, 10_000), foe(52, 10_400, 10_000), foe(54, 10_500, 10_000)], orders, castSpell: async id => (id === 52 ? { success: false, reason, message: 'no' } : {}) });
            expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
            expect(s.results).toEqual([{ kind: 'cc', success: false, reason, targetId: 52 }]);
            expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
            expect(s.calls.castSpell).toEqual([52, 54]);
            expect(s.marks.map(m => m.targetId)).toEqual([54]);
            // In our own memory only: another mezzer may yet be told otherwise by the server, and the board's mark is for a real immunity.
            expect(s.pic.contacts[1]!.ccImmune).toBeUndefined();
        });
    }

    test('melee: an attack refused at once is reported and waits its turn', async () => {
        const s = stub({ name: 'Blade', role: 'melee', at: { x: 10_100, y: 10_000 }, contacts: [foe(51, 10_300, 10_000)], orders: { focus: 51 }, attack: { success: false, reason: 'refused', message: 'no' } });
        expect(await assist({ melee: true }).run(s.ctx)).toBe(true);
        expect(s.results).toEqual([{ kind: 'melee', success: false, reason: 'refused', targetId: 51 }]);
    });

    test('tank: killNpc with nothing to swing (refused, at once) and killPlayer\'s at-once reasons are reported', async () => {
        const npc = contact(60, { regionId: R, x: 10_100, y: 10_000, threat: true, target: 'Tank' });
        const s = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [npc], orders: { focus: 60 }, killNpc: { success: false, killed: false, reason: 'refused', message: 'We have no weapon' } });
        expect(await tank().run(s.ctx)).toBe(true);
        expect(s.results).toEqual([{ kind: 'kill', success: false, reason: 'refused', targetId: 60 }]);
        for (const reason of ['not_attackable', 'not_found', 'refused']) {
            const p = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [foe(51, 10_300, 10_000, { target: 'Tank' })], orders: { focus: 51 }, killPlayer: async () => ({ success: false, killed: false, reason, message: 'no' }) });
            expect(await tank().run(p.ctx)).toBe(true);
            expect(p.results).toEqual([{ kind: 'kill', success: false, reason, targetId: 51 }]);
        }
    });

    test('tank: a target that died as it came is no failure, as for melee', async () => {
        // r17on, r19on: 'kill: already_dead' twice, 1 s apart, on a kill the group had just made.
        const player = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [foe(51, 10_300, 10_000, { target: 'Tank' })], orders: { focus: 51 }, killPlayer: async () => ({ success: false, killed: false, reason: 'already_dead', message: 'died as we came' }) });
        expect(await tank().run(player.ctx)).toBe(true);
        expect(player.results).toEqual([]);
        const npc = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [contact(60, { regionId: R, x: 10_100, y: 10_000, threat: true, target: 'Tank' })], orders: { focus: 60 }, killNpc: { success: false, killed: false, reason: 'already_dead', message: 'died as we came' } });
        expect(await tank().run(npc.ctx)).toBe(true);
        expect(npc.results).toEqual([]);
    });

    test('guard: a member out of view gets no Guard: the select does not take, and the ability lands on what we hold', async () => {
        // r17on Rbpal: "You can't guard yourself!", 6 lines, with no member near.
        const cleric = report('Cleric', { role: 'healer', regionId: R, x: 10_000, y: 10_000, objectId: 7 });
        const scene = (inView: boolean) => {
            const s = stub({ name: 'Tank', role: 'tank', at: ANCHOR, members: [cleric], orders: { phase: 'travel', focus: null }, settings: { ...LEASHED, guard: { guard: 'healer' } } as TacticsSettings });
            const selected: number[] = [];
            let used = 0;
            Object.assign(s.ctx.sdk, {
                findAbility: () => ({ name: 'Guard' }),
                getNearbyPlayers: () => (inView ? [{ objectId: 7 }] : []),
                sendSetTarget: async (id: number) => { selected.push(id); return { success: true, message: '' }; },
            });
            (s.ctx.bot as unknown as { useAbility: unknown; isDead: unknown }).useAbility = async () => { used++; return { success: true, message: '', messages: [{ text: 'You are now guarding Cleric.' }] }; };
            (s.ctx.bot as unknown as { isDead: unknown }).isDead = () => false;
            return { s, selected, used: () => used };
        };
        const far = scene(false);
        expect(await guard().run(far.s.ctx)).toBe(false);
        expect(far.selected).toEqual([]);
        expect(far.used()).toBe(0);
        const near = scene(true);
        expect(await guard().run(near.s.ctx)).toBe(true);
        expect(near.selected).toEqual([7]);
        expect(near.used()).toBe(1);
    });

    test('a leg cut by its own timeout is no failure: flee, tank and assist hand the next turn the decision that way, so a report gets no walk:timeout from them', async () => {
        const walk = { success: false, reason: 'timeout', message: 'Walk timed out after 6000ms' };
        const tankM = report('Tank', { role: 'tank', regionId: R, x: ANCHOR.x, y: ANCHOR.y, objectId: 3 });
        const fleeing = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 12_500 }, members: [tankM], contacts: [contact(60, { regionId: R, x: 10_000, y: 12_600, threat: true, target: 'Nuker' })], orders: { focus: 99 }, walk });
        expect(await flee().run(fleeing.ctx)).toBe(true);
        expect(fleeing.calls.walkTo.length).toBe(1);
        expect(fleeing.results).toEqual([]);

        const tanking = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [foe(51, 11_000, 10_000)], orders: { focus: 51 }, inView: [], walk });
        expect(await tank().run(tanking.ctx)).toBe(true);
        expect(tanking.calls.walkTo.length).toBe(1);
        expect(tanking.results).toEqual([]);

        const closing = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 12_500 }, contacts: [foe(51, 10_000, 10_000)], orders: { focus: 51 }, inView: [], walk });
        expect(await assist().run(closing.ctx)).toBe(true);
        expect(closing.calls.walkTo.length).toBe(1);
        expect(closing.results).toEqual([]);
    });

    test('a walk that fails at once is reported by what had nothing to say before: flee, tank, assist, pull, retreat', async () => {
        const walk = { success: false, reason: 'stuck', message: 'no way' };
        const tankM = report('Tank', { role: 'tank', regionId: R, x: ANCHOR.x, y: ANCHOR.y, objectId: 3 });
        const fleeing = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 10_700 }, members: [tankM], contacts: [contact(60, { regionId: R, x: 10_000, y: 11_000, threat: true, target: 'Nuker' })], orders: { focus: 99 }, walk });
        expect(await flee().run(fleeing.ctx)).toBe(true);
        expect(fleeing.results).toEqual([{ kind: 'walk', success: false, reason: 'stuck', targetId: null }]);

        const tanking = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [foe(51, 11_000, 10_000)], orders: { focus: 51 }, inView: [], walk });
        expect(await tank().run(tanking.ctx)).toBe(true);
        expect(tanking.results.map(r => r.kind)).toEqual(['walk']);

        const closing = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 12_500 }, contacts: [foe(51, 10_000, 10_000)], orders: { focus: 51 }, inView: [], walk });
        expect(await assist().run(closing.ctx)).toBe(true);
        expect(closing.results.map(r => r.kind)).toEqual(['walk']);

        const orders = { phase: 'pull' as const, focus: 60, puller: 'Tank' };
        const far = () => contact(60, { regionId: R, x: 11_000, y: 10_000 });
        const pulling = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [far()], orders, inView: [], walk });
        expect(await pull().run(pulling.ctx)).toBe(true);
        expect(pulling.results.map(r => r.kind)).toEqual(['walk']);
        const home = stub({ name: 'Tank', role: 'tank', at: { x: 10_800, y: 10_000 }, contacts: [far()], orders: { ...orders, facing: null }, walk });
        home.pic.contacts[0]!.target = 'Tank';
        expect(await pull().run(home.ctx)).toBe(true);
        expect(home.results.map(r => r.kind)).toEqual(['walk']);

        const running = stub({ name: 'Nuker', role: 'nuker', at: { x: 10_000, y: 12_500 }, orders: { phase: 'retreat', focus: null, retreatTo: ANCHOR }, walk });
        expect(await retreat().run(running.ctx)).toBe(true);
        expect(running.results.map(r => r.kind)).toEqual(['retreat']);
    });

    test('an attack refused because we are mezzed on a pull waits it out', async () => {
        const mobAt = contact(60, { regionId: R, x: 10_100, y: 10_000 });
        const s = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [mobAt], orders: { phase: 'pull', focus: 60, puller: 'Tank' }, attack: { success: false, reason: 'crowd_controlled', retryAfterMs: 300, message: "You can't attack when you are mesmerized!" } });
        const t0 = Date.now();
        expect(await pull().run(s.ctx)).toBe(true);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
        expect(s.results).toEqual([{ kind: 'pull', success: false, reason: 'crowd_controlled', targetId: 60 }]);
    });
});

describe('standing where the target was: no walk that "arrives" every turn', () => {
    test('tank: a focus not in view at its last position falls through; farther off it walks', async () => {
        const near = stub({ name: 'Tank', role: 'tank', at: { x: 10_900, y: 10_000 }, contacts: [foe(51, 11_000, 10_000)], orders: { focus: 51 }, inView: [] });
        expect(await tank().run(near.ctx)).toBe(false);
        expect(near.calls.walkTo).toEqual([]);
        expect(near.skips).toEqual(['tank: target not at its last position']);
        const far = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [foe(51, 11_000, 10_000)], orders: { focus: 51 }, inView: [] });
        expect(await tank().run(far.ctx)).toBe(true);
        expect(far.calls.walkTo.length).toBe(1);
    });

    test('pull: the same', async () => {
        const orders = { phase: 'pull' as const, focus: 60, puller: 'Tank' };
        const mobAt = () => contact(60, { regionId: R, x: 11_000, y: 10_000 });
        const near = stub({ name: 'Tank', role: 'tank', at: { x: 10_800, y: 10_000 }, contacts: [mobAt()], orders, inView: [] });
        expect(await pull().run(near.ctx)).toBe(false);
        expect(near.skips).toEqual(['pull: focus not at its last position']);
        const far = stub({ name: 'Tank', role: 'tank', at: ANCHOR, contacts: [mobAt()], orders, inView: [] });
        expect(await pull().run(far.ctx)).toBe(true);
    });
});

describe('rest with a pet in a fight (rest answers in_combat, at once, with no send)', () => {
    const orders = { phase: 'recover' as const, focus: null };
    test('no failure on the log, and the reason says who', async () => {
        const s = stub({ name: 'Nuker', role: 'nuker', at: ANCHOR, orders, manaPercent: 40, rest: { success: false, reason: 'in_combat', message: 'Cannot rest: our pet is fighting wolf' } });
        expect(await rest().run(s.ctx)).toBe(false);
        expect(s.results).toEqual([]);
        expect(s.skips).toEqual(['rest: Cannot rest: our pet is fighting wolf']);
    });
    test('and it isn\'t asked again every turn: the same reason, no activity flipping to rest and back', async () => {
        const s = stub({ name: 'Nuker', role: 'nuker', at: ANCHOR, orders, manaPercent: 40, rest: { success: false, reason: 'in_combat', message: 'Cannot rest: our pet is fighting wolf' } });
        await rest().run(s.ctx);
        expect(await rest().run(s.ctx)).toBe(false);
        expect(s.calls.rest).toBe(1);
        expect(s.skips).toEqual(['rest: Cannot rest: our pet is fighting wolf', 'rest: Cannot rest: our pet is fighting wolf']);
        s.ctx.memory.set('restBusy', { until: Date.now() - 1, why: '' });
        await rest().run(s.ctx);
        expect(s.calls.rest).toBe(2);
    });
    test('another failure still is one', async () => {
        const s = stub({ name: 'Nuker', role: 'nuker', at: ANCHOR, orders, manaPercent: 40, rest: { success: false, reason: 'refused', message: 'You can\'t sit now' } });
        expect(await rest().run(s.ctx)).toBe(false);
        expect(s.results).toEqual([{ kind: 'rest', success: false, reason: 'refused', targetId: null }]);
    });
});

describe('spareNuke: a healer with nothing to heal', () => {
    const nuke = { spell: { name: 'Minor Judgement' }, type: 'DirectDamage', range: 1500 };
    const scene = (o: { mana?: number; canNuke?: boolean; at?: Point; contacts?: Contact[] } = {}) => {
        const s = stub({ name: 'Cleric', role: 'healer', at: o.at ?? { x: 10_000, y: 10_000 }, contacts: o.contacts ?? [foe(51, 11_000, 10_000)], orders: { focus: 51 }, settings: { ...LEASHED, standStep: 500 } as TacticsSettings });
        const spells = s.ctx.spells as unknown as Record<string, unknown>;
        spells.nuke = () => (o.canNuke === false ? null : nuke);
        spells.capabilities = () => ({ nuke: o.canNuke !== false });
        const me = s.ctx.me();
        (s.ctx as unknown as { me: () => unknown }).me = () => ({ ...me, manaPercent: o.mana ?? 100 });
        const opts: unknown[] = [];
        (s.ctx.bot as unknown as { castSpell: unknown }).castSpell = async (_: unknown, id: number, castOpts: unknown) => { s.calls.castSpell.push(id); opts.push(castOpts); return { success: true, message: 'Cast' }; };
        return { ...s, opts };
    };

    test('hits the focus on spare power, from where it stands', async () => {
        const s = scene();
        expect(await spareNuke().run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([51]);
        expect(s.opts).toEqual([{ approach: false }]);
    });

    test('a burst on one of ours (2+ enemy players on it): it holds the nuke for heals (arena round 19)', async () => {
        const s = scene({ contacts: [foe(51, 11_000, 10_000), foe(52, 10_100, 10_000, { target: 'Cleric' }), foe(53, 10_000, 10_100, { target: 'Cleric' })] });
        expect(await spareNuke().run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
        expect(s.skips.at(-1)).toMatch(/2 enemy players on one of ours/);
        expect(await spareNuke().run(scene({ contacts: [foe(51, 11_000, 10_000), foe(52, 10_100, 10_000, { target: 'Cleric' })] }).ctx)).toBe(true);
    });

    test('below the floor it saves its power for heals, and the rez that needs 75 %', async () => {
        const s = scene({ mana: 74 });
        expect(await spareNuke().run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
        expect(s.skips).toEqual(['spareNuke: saving power (< 75 %)']);
        expect(await spareNuke().run(scene({ mana: 75 }).ctx)).toBe(true);
    });

    test('a short step for a focus just out of range, and no walk out of healing reach for one further off, whatever standStep says', async () => {
        const near = scene({ at: { x: 9300, y: 10_000 } });
        expect(await spareNuke().run(near.ctx)).toBe(true);
        expect(near.calls.walkTo).toEqual([{ x: 9600, y: 10_000 }]);
        expect(near.calls.castSpell).toEqual([]);
        const far = scene({ at: { x: 8000, y: 10_000 } });
        expect(await spareNuke().run(far.ctx)).toBe(false);
        expect(far.calls.walkTo).toEqual([]);
        expect(far.calls.castSpell).toEqual([]);
    });

    test('a member with no nuke: nothing, and no idle reason that says it is short of power', async () => {
        const s = scene({ canNuke: false });
        expect(await spareNuke().run(s.ctx)).toBe(false);
        expect(s.skips).toEqual([]);
    });

    test('in the RvR healer list it comes after every heal, and a character\'s fight still goes where it did', () => {
        const list = rvrBehaviors().healer.map(b => b.name);
        for (const before of ['emergencyHeal', 'rez', 'heal', 'crowdControl', 'position']) expect(list.indexOf(before)).toBeLessThan(list.indexOf('spareNuke'));
        const kit = withCharacter(rvrBehaviors().healer, shaman()).map(b => b.name);
        expect(kit.indexOf('assist')).toBe(kit.indexOf('position') - 1);
        expect(kit.indexOf('spareNuke')).toBe(kit.indexOf('position') + 1);
    });
});

describe('interrupt outside an engage', () => {
    const scene = (phase: Orders['phase'], foeOver: Partial<Contact>) => {
        const s = stub({ name: 'Bard', role: 'support', at: { x: 10_000, y: 10_000 }, contacts: [foe(51, 11_000, 10_000, { castingAt: Date.now(), ...foeOver })], orders: { phase, focus: null } });
        Object.assign(s.ctx.spells, { interrupts: () => [{ spell: { name: 'Minor Lullaby' }, range: 2300 }] });
        return s;
    };

    test('a cast at one of ours while we close in is cut (arena round 21: the opening area mezz came before the engage order)', async () => {
        const s = scene('travel', { target: 'Bard', targetBySpell: true });
        expect(await interrupt().run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([51]);
    });

    test('a cast at nobody of ours is left alone until the engage', async () => {
        const s = scene('travel', {});
        expect(await interrupt().run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
        const e = scene('engage', {});
        expect(await interrupt().run(e.ctx)).toBe(true);
    });
});

describe('interrupt after the server\'s "too far"', () => {
    test('that target waits 10 s unless it comes 200 nearer (arena round 35: 15 at once)', async () => {
        const s = stub({ name: 'Bard', role: 'support', at: { x: 10_000, y: 10_000 }, contacts: [foe(51, 11_000, 10_000, { castingAt: Date.now() })], orders: { phase: 'engage', focus: null },
            castSpell: async () => ({ success: false, reason: 'out_of_range', message: 'That target is too far away!' }) });
        Object.assign(s.ctx.spells, { interrupts: () => [{ spell: { name: 'Minor Lullaby' }, range: 2300 }] });
        expect(await interrupt().run(s.ctx)).toBe(true);
        expect(await interrupt().run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([51]);
    });
});

describe('assist after the server\'s "too far" twice', () => {
    test('the focus waits 8 s and the turn goes on (arena rounds 32 and 37: 15 in 17 s)', async () => {
        const s = stub({ name: 'Hrafna', role: 'nuker', at: { x: 10_000, y: 10_000 }, contacts: [foe(51, 11_000, 10_000)], orders: { focus: 51 }, settings: { ...LEASHED, standGround: true, standStep: 0 } as TacticsSettings,
            castSpell: async () => ({ success: false, reason: 'out_of_range', message: 'That target is too far away!' }) });
        Object.assign(s.ctx.spells, { nuke: () => ({ spell: { name: 'Minor Spirit Blast' }, type: 'DirectDamage', range: 1500, castTime: 2.5 }), capabilities: () => ({ nuke: true }) });
        expect(await assist().run(s.ctx)).toBe(true);
        expect(await assist().run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([51, 51]);
        await assist().run(s.ctx);
        expect(s.calls.castSpell).toEqual([51, 51]);
        expect(s.skips.at(-1)).toMatch(/server says out of reach/);
    });
});

describe('a target beyond the bank (dry move guard, reason \'water\'): left 8 s, not retried every turn', () => {
    const water = async () => ({ success: false, reason: 'water', message: '(11000, 10000) is in deep water: holding at the bank' });
    test('assist leaves the swimming focus', async () => {
        const s = stub({ name: 'Nimue', role: 'nuker', at: { x: 10_000, y: 10_000 }, contacts: [foe(51, 11_000, 10_000)], orders: { focus: 51 }, castSpell: water });
        Object.assign(s.ctx.spells, { nuke: () => ({ spell: { name: 'Minor Spirit Blast' }, type: 'DirectDamage', range: 1500, castTime: 2.5 }), capabilities: () => ({ nuke: true }) });
        expect(await assist().run(s.ctx)).toBe(true);
        await assist().run(s.ctx);
        expect(s.calls.castSpell).toEqual([51]);
        expect(s.skips.at(-1)).toMatch(/river/);
    });
    test('heal leaves the swimming friend', async () => {
        const hurt = report('Galahad', { role: 'tank', regionId: R, x: 11_000, y: 10_000, objectId: 2, hp: 20, maxHp: 400 });
        const s = stub({ name: 'Morgana', role: 'healer', at: { x: 10_000, y: 10_000 }, members: [hurt], castSpell: water, healSpell: { spell: { name: 'Minor Heal' } } });
        expect(await heal().run(s.ctx)).toBe(true);
        expect(await heal().run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([2]);
    });
    test('crowd control goes on to the next add', async () => {
        const orders = { focus: 51, cc: [{ targetId: 52, by: 'Bard' }, { targetId: 54, by: 'Bard' }] };
        const s = stub({ name: 'Bard', role: 'support', at: { x: 10_000, y: 10_500 }, contacts: [foe(51, 10_300, 10_000), foe(52, 10_400, 10_000), foe(54, 10_500, 10_000)], orders, castSpell: async id => (id === 52 ? { success: false, reason: 'water', message: 'bank' } : {}) });
        expect(await crowdControl({ assignedOnly: true }).run(s.ctx)).toBe(true);
        await crowdControl({ assignedOnly: true }).run(s.ctx);
        expect(s.calls.castSpell[0]).toBe(52);
        expect(s.calls.castSpell.slice(1)).not.toContain(52);
    });
});
