// The pet behaviours on a stub MemberContext, as in behaviors-rvr.test.ts: a fixed picture and orders, our
// client's view, a pet window, and actions that answer with canned results. Region 9999 has no keeps or spawns.
import { describe, expect, test } from 'bun:test';
import { getSpell, type SpellInfo } from '../../data/index';
import type { BotActions, CastResult, KillOptions } from '../actions';
import type { BotSDK } from '../index';
import type { CombatEvent, GameMessage, NearbyNpc, NearbyPlayer, PetCommand, PetState, Spell } from '../types';
import { makeMessage, makeState } from '../test/fixtures';
import { assist, buffRetryMs, crowdControl, defaultBehaviors, flee, holdFormation, holdState, position, release, rest, REST_MANA_UP_TO, retreat, SAVING_POWER, tank, type TacticsSettings } from './behaviors';
import { Blackboard } from './blackboard';
import { withCharacter } from './character';
import { contact, enemy, picture, report } from './fixtures';
import { MemberAgent, type Behavior, type MemberContext } from './member';
import { formatReport, GroupObserver } from './observer';
import { castRunning, fnfPet, leftPassive, memberPetKit, PET_SETTINGS, petAfterRun, petBuff, petBuffAtStart, petControl, petHeal, petKit, petMaxHp, petsAllowed, summonPet, waitsForPet, withPets, type PetKit } from './pets';
import { PACK_SETTINGS } from './pack';
import { theurgist } from '../classes/theurgist';
import { decidePve, PVE_SETTINGS } from './pve';
import { decideRvr, RVR_SETTINGS, rvrBehaviors } from './rvr';
import { Spellbook, type SpellPick } from './spells';
import type { Contact, MemberReport, Orders, Point, Role } from './types';

const R = 9999;
const ME = 1;
const PET = 900;
const ANCHOR = { x: 10_000, y: 10_000, z: 0 };
const OWNER_AT = { x: 10_000, y: 10_500 };

interface WorldOptions {
    at?: Point;
    role?: Role;
    contacts?: Contact[];
    members?: MemberReport[];
    orders?: Partial<Orders>;
    settings?: TacticsSettings;
    /** The window; null: no pet; absent: one at defaults. */
    pet?: Partial<PetState> | null;
    /** A client from before pets: state.pet undefined. */
    olderClient?: boolean;
    /** Its NPC entry; null: out of view. */
    petEntry?: { healthPercent?: number; distance?: number; x?: number; y?: number; name?: string; level?: number } | null;
    /** Contacts our own client sees (default: all). */
    inView?: number[];
    seen?: Record<number, { healthPercent: number }>;
    combatEvents?: CombatEvent[];
    player?: Partial<{ mana: number; maxMana: number; manaPercent: number; isShade: boolean; concentration: number; attacking: boolean; targetObjectId: number | null }>;
    /** What the turn beside the side tick has announced (ctx.turn). */
    turn?: { kind: string; targetId: number | null } | null;
    /** The server's lines, oldest first. */
    messages?: GameMessage[];
    /** Its region, for one with real zones (default 9999: none). */
    region?: number;
    dead?: boolean;
    turret?: boolean;
    summon?: SpellPick | null;
    fnf?: SpellPick | null;
    petHeal?: SpellPick | null;
    petBuffs?: (SpellPick & { slot: string })[];
    lastPetLoss?: { at: number } | null;
    summonPet?: () => Partial<CastResult>;
    castSpell?: () => Partial<CastResult>;
    rest?: () => Partial<{ success: boolean; reason: string; message: string }>;
}

function world(o: WorldOptions = {}) {
    const sent: { command: PetCommand; target?: number }[] = [];
    const results: { kind: string; success: boolean; reason?: string; targetId: number | null }[] = [];
    const skips: string[] = [];
    const doing: { kind: string; targetId: number | null; detail: string }[] = [];
    const calls = { summon: [] as { spell: unknown; opts: unknown }[], cast: [] as unknown[][], rest: [] as unknown[], walk: [] as unknown[][], petHealNeed: [] as (number | undefined)[] };
    const at = o.at ?? OWNER_AT;
    const tankM = report('Tank', { role: 'tank', regionId: R, x: ANCHOR.x, y: ANCHOR.y, objectId: 3 });
    const pic = picture([report('Owner', { role: o.role ?? 'nuker', regionId: R, x: at.x, y: at.y, level: 20, objectId: ME }), tankM, ...(o.members ?? [])], o.contacts ?? [], { phase: 'engage', anchor: ANCHOR, ...o.orders });
    const mana = { mana: 500, maxMana: 1000, manaPercent: 50, ...o.player };
    const me = () => ({ name: 'Owner', objectId: ME, regionId: o.region ?? R, x: at.x, y: at.y, z: 0, level: 20, realm: 'midgard', attacking: false, targetObjectId: null, concentration: 0, healthPercent: 100, ...mana });
    const pet: PetState | null | undefined = o.olderClient ? undefined : o.pet === null ? null : { objectId: PET, name: 'spirit soldier', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null, ...o.pet };
    const state = { pet, combatEvents: o.combatEvents ?? [], timestamp: Date.now(), effects: [], equipment: [], lastPetLoss: o.lastPetLoss ?? null, gameMessages: o.messages ?? [] };
    const visible = (id: number) => (o.inView ?? pic.contacts.map(c => c.objectId)).includes(id);
    const nearby = (c: Contact) => ({
        objectId: c.objectId, name: c.name, x: c.x, y: c.y, z: c.z, distance: Math.hypot(c.x - at.x, c.y - at.y), level: c.level, realm: c.realm, healthPercent: o.seen?.[c.objectId]?.healthPercent ?? c.hp,
    });
    const sdk = {
        getPetState: () => state.pet ?? null,
        getPet: () => (!state.pet || o.petEntry === null ? null : { kind: 'npc', objectId: PET, name: 'spirit soldier', distance: 100, x: at.x, y: at.y - 100, healthPercent: 100, ...o.petEntry }),
        getGameMessages: () => state.gameMessages,
        getState: () => state,
        getNearbyNpc: (id: number) => { const c = pic.contacts.find(x => x.objectId === id && x.kind === 'npc'); return c && visible(id) ? { ...nearby(c), kind: 'npc' } as unknown as NearbyNpc : null; },
        getNearbyPlayer: (id: number) => { const c = pic.contacts.find(x => x.objectId === id && x.kind === 'player'); return c && visible(id) ? { ...nearby(c), kind: 'player', isDead: false } as unknown as NearbyPlayer : null; },
        sendPetCommand: async (command: PetCommand, target?: number) => { sent.push(target === undefined ? { command } : { command, target }); return { success: true, message: '' }; },
        sendAttack: async () => ({ success: true, message: '' }),
        getSkills: () => ({ styles: [] }),
    };
    const bot = {
        isDead: () => o.dead ?? false,
        summonPet: async (spell: unknown, opts: unknown) => { calls.summon.push({ spell, opts }); return { success: true, message: 'Cast', ...o.summonPet?.() }; },
        castHeldLeftMs: () => 0,
        castSpell: async (...args: unknown[]) => { calls.cast.push(args); return { success: true, message: 'Cast', ...o.castSpell?.() }; },
        rest: async (opts: unknown) => { calls.rest.push(opts); return { success: true, message: 'Rested', ...o.rest?.() }; },
        walkToObject: async (...args: unknown[]) => { calls.walk.push(args); return { success: true, message: 'In range' }; },
        getAttackers: () => [],
        getPlayerAttackers: () => [],
    };
    const spells = {
        knowsTurret: () => o.turret ?? false,
        summon: () => o.summon ?? null, fnf: () => o.fnf ?? null, petHeal: (missing?: number) => { calls.petHealNeed.push(missing); return o.petHeal ?? null; }, petBuffs: () => o.petBuffs ?? [], root: () => null, cc: () => null,
        capabilities: () => ({ ccKinds: ['mezz', 'root'] }),
        powerOf: (s: { power: number }) => (s.power < 0 ? Math.floor(mana.maxMana * -s.power / 100) : s.power),
    };
    const ctx = {
        name: 'Owner', role: o.role ?? 'nuker', settings: o.settings ?? PVE_SETTINGS, memory: new Map<string, any>(), sdk, bot, spells, me,
        isTank: () => (o.role ?? 'nuker') === 'tank', turn: () => o.turn ?? null,
        picture: () => pic, orders: () => pic.orders, members: () => pic.members,
        tank: () => pic.members.find(m => m.role === 'tank' && !m.isDead),
        contact: (id: number | null | undefined) => pic.contacts.find(c => c.objectId === id),
        focus: () => pic.contacts.find(c => c.objectId === pic.orders.focus),
        threats: () => pic.contacts.filter(c => c.threat),
        doing: (kind: string, targetId: number | null = null, detail = '') => { doing.push({ kind, targetId, detail }); },
        skip: (reason: string) => { skips.push(reason); return false as const; },
        result: (kind: string, r: { success: boolean; reason?: string }, targetId: number | null = null) => { results.push({ kind, success: r.success, reason: r.reason, targetId }); },
    } as unknown as MemberContext<TacticsSettings>;
    return { ctx, sent, results, skips, doing, calls, pic, state };
}

/** A monster the tank has held since `heldFor` ms ago. */
const mob = (id: number, heldFor = 5000, over: Partial<Contact> = {}) => contact(id, {
    regionId: R, x: 10_300, y: 10_000, threat: true, target: 'Tank', targetSince: Date.now() - heldFor, hostileSince: Date.now() - heldFor, ...over,
});
const FOCUS = 51;
const held = (over: Partial<Contact> = {}) => mob(FOCUS, 5000, over);

describe('petControl: the pet goes for the focus', () => {
    test('held by the tank: the order goes with the focus selected, and the behaviour falls through', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS } });
        expect(await petControl().run(w.ctx)).toBe(false);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('not held yet: no order; holdMs, then pet.holdMs, then the fallback of assistAfterMs', async () => {
        const after = async (ms: number, settings?: TacticsSettings) => {
            const w = world({ contacts: [mob(FOCUS, ms)], orders: { focus: FOCUS }, settings });
            await petControl().run(w.ctx);
            return w.sent.length;
        };
        expect(await after(1000)).toBe(0);
        expect(await after(1600)).toBe(1);
        const longer = { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, holdMs: 3000 } };
        expect(await after(1600, longer)).toBe(0);
        expect(await after(3100, longer)).toBe(1);
        expect(await after(100, { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, holdMs: 0 } })).toBe(1);
        // On a member who isn't the tank: only assistAfterMs lets it go in.
        const onHealer = (ms: number) => world({ contacts: [mob(FOCUS, ms, { target: 'Healer' })], orders: { focus: FOCUS } });
        const soon = onHealer(2000);
        await petControl().run(soon.ctx);
        expect(soon.sent).toEqual([]);
        const late = onHealer(6100);
        await petControl().run(late.ctx);
        expect(late.sent.length).toBe(1);
    });

    test('a pet.holdMs above assistAfterMs does what it says: raised to 10 s, the pet waits 10 s, and the nukers\' fallback stays', async () => {
        const after = async (ms: number, holdMs?: number) => {
            const w = world({ contacts: [mob(FOCUS, ms)], orders: { focus: FOCUS }, settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, holdMs } } });
            await petControl().run(w.ctx);
            return w.sent.length;
        };
        expect(await after(6100, 10_000)).toBe(0);
        expect(await after(9900, 10_000)).toBe(0);
        expect(await after(10_100, 10_000)).toBe(1);
        // At or below it nothing moves.
        expect(await after(6100, 6000)).toBe(1);
        expect(await after(6100)).toBe(1);
        // A mob on no tank at all waits as long as the setting too.
        const onHealer = world({ contacts: [mob(FOCUS, 6100, { target: 'Healer' })], orders: { focus: FOCUS }, settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, holdMs: 10_000 } } });
        await petControl().run(onHealer.ctx);
        expect(onHealer.sent).toEqual([]);
    });

    test('an enemy player at once: no tank holds one', async () => {
        const w = world({ contacts: [enemy(FOCUS, 'albion', { regionId: R, x: 10_300, y: 10_000, threat: true })], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('already on it: nothing goes out (the entry\'s 0 and 65535 never come in here, PetState.targetObjectId holds)', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('another mob as focus now: over at once', async () => {
        const w = world({ contacts: [held(), mob(52)], orders: { focus: FOCUS }, pet: { targetObjectId: 52 } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('it takes the focus only: an add on us is no target, and a stale or dead focus none either', async () => {
        const add = world({ contacts: [mob(52, 5000, { target: 'Owner' })], orders: { focus: null } });
        await petControl().run(add.ctx);
        expect(add.sent).toEqual([]);
        const stale = world({ contacts: [held({ stale: true })], orders: { focus: FOCUS } });
        await petControl().run(stale.ctx);
        expect(stale.sent).toEqual([]);
        const dead = world({ contacts: [held({ hp: 0 })], orders: { focus: FOCUS } });
        await petControl().run(dead.ctx);
        expect(dead.sent).toEqual([]);
    });

    test('a focus reading 0 % fights on without a death event, and with one it is done (GameLiving.cs:2621)', async () => {
        const at0 = (combatEvents: CombatEvent[]) => world({ contacts: [held({ hp: 1 })], orders: { focus: FOCUS }, seen: { [FOCUS]: { healthPercent: 0 } }, combatEvents });
        const alive = at0([]);
        await petControl().run(alive.ctx);
        expect(alive.sent.length).toBe(1);
        const gone = at0([{ id: 1, kind: 'death', attackerObjectId: null, targetObjectId: FOCUS, receivedAt: Date.now() - 200 }]);
        await petControl().run(gone.ctx);
        expect(gone.sent).toEqual([]);
    });
});

describe('petControl: never a crowd-controlled target', () => {
    const mezz = { by: 'Bard', kind: 'mezz', until: Date.now() + 9000 };

    // Something else free in the fight: alone, a crowd-controlled focus is the one to break (ccHolds), the pet's too.
    test('a cc\'d focus: no order; on it already: it comes away', async () => {
        const none = world({ contacts: [held({ cc: mezz }), mob(52)], orders: { focus: FOCUS } });
        await petControl().run(none.ctx);
        expect(none.sent).toEqual([]);
        const on = world({ contacts: [held({ cc: mezz }), mob(52)], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(on.ctx);
        expect(on.sent).toEqual([{ command: 'follow' }]);
    });

    test('a mezz in flight, by the orders: the same', async () => {
        const inFlight = { focus: FOCUS, cc: [{ targetId: FOCUS, by: 'Bard' }] };
        const none = world({ contacts: [held()], orders: inFlight });
        await petControl().run(none.ctx);
        expect(none.sent).toEqual([]);
        const on = world({ contacts: [held()], orders: inFlight, pet: { targetObjectId: FOCUS } });
        await petControl().run(on.ctx);
        expect(on.sent).toEqual([{ command: 'follow' }]);
    });

    test('a mezz in flight, by another member\'s cast (no assignment): the same, and it\'s an add the pet comes off', async () => {
        const bard = report('Bard', { role: 'support', regionId: R, objectId: 4, activity: { kind: 'cc', targetId: 52, detail: 'Mesmerize', since: Date.now() - 1000 } });
        const w = world({ contacts: [held(), mob(52, 5000, { target: 'Owner' })], members: [bard], orders: { focus: null }, pet: { targetObjectId: 52 } });
        await petControl().run(w.ctx);
        // On its owner too: passive as well, or the next hit brings it back.
        expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
    });

    test('with a valid focus up, it goes there instead of just coming away', async () => {
        const w = world({ contacts: [held(), mob(52, 5000, { cc: mezz })], orders: { focus: FOCUS }, pet: { targetObjectId: 52 } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });
});

describe('petControl: retreat', () => {
    const orders = { phase: 'retreat' as const, focus: null, retreatTo: ANCHOR };

    test('in a fight: passive and follow, two packets (an aggression command returns at once, PetWindowHandler.cs:18-36)', async () => {
        const w = world({ orders, pet: { targetObjectId: FOCUS } });
        expect(await petControl().run(w.ctx)).toBe(false);
        expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
    });

    test('told to go somewhere: follow too; already passive and following: nothing', async () => {
        const elsewhere = world({ orders, pet: { aggression: 'passive', walk: 'goTarget' } });
        await petControl().run(elsewhere.ctx);
        expect(elsewhere.sent).toEqual([{ command: 'follow' }]);
        const done = world({ orders, pet: { aggression: 'passive', walk: 'follow' } });
        await petControl().run(done.ctx);
        expect(done.sent).toEqual([]);
        // Passive alone resumes its walk (ControlledMobBrain.cs:199-203): no fight, no follow.
        const idle = world({ orders });
        await petControl().run(idle.ctx);
        expect(idle.sent).toEqual([{ command: 'passive' }]);
    });

    test('once it is over: defensive again', async () => {
        const w = world({ orders: { phase: 'recover', focus: null }, pet: { aggression: 'passive' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }]);
        const never = world({ orders: { phase: 'recover', focus: null }, pet: { aggression: 'aggressive' } });
        await petControl().run(never.ctx);
        expect(never.sent).toEqual([{ command: 'defensive' }]);
    });
});

describe('petControl: the leash', () => {
    const LEASHED: TacticsSettings = { ...PVE_SETTINGS, chaseLeash: 2000 };
    const far = () => enemy(FOCUS, 'albion', { regionId: R, x: 12_500, y: 10_000, threat: true });

    test('a focus beyond it: no attack order, and it goes passive: a defensive pet runs at whoever hits its owner (ControlledMobBrain.cs:614-638). On it already: it comes away too. Inside it the order goes', async () => {
        const none = world({ contacts: [far()], orders: { focus: FOCUS }, settings: LEASHED, at: { x: 11_500, y: 10_000 } });
        await petControl().run(none.ctx);
        expect(none.sent).toEqual([{ command: 'passive' }]);
        const on = world({ contacts: [far()], orders: { focus: FOCUS }, settings: LEASHED, at: { x: 11_500, y: 10_000 }, pet: { targetObjectId: FOCUS } });
        await petControl().run(on.ctx);
        expect(on.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
        const inside = world({ contacts: [enemy(FOCUS, 'albion', { regionId: R, x: 11_500, y: 10_000, threat: true })], orders: { focus: FOCUS }, settings: LEASHED, at: { x: 11_000, y: 10_000 } });
        await petControl().run(inside.ctx);
        expect(inside.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('no stand-in for a focus beyond it: the pet takes the focus or nothing', async () => {
        const standIn = enemy(53, 'albion', { regionId: R, x: 10_300, y: 10_000, threat: true, target: 'Tank' });
        const w = world({ contacts: [far(), standIn], orders: { focus: FOCUS }, settings: LEASHED });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'passive' }]);
    });

    test('held off, the stance stays passive turn after turn: nothing flips it back and forth', async () => {
        const w = world({ contacts: [far()], orders: { focus: FOCUS }, settings: LEASHED, pet: { aggression: 'passive' } });
        await petControl().run(w.ctx);
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('the focus back inside it: the order goes, and the stance comes back with it', async () => {
        const w = world({ contacts: [enemy(FOCUS, 'albion', { regionId: R, x: 11_500, y: 10_000, threat: true })], orders: { focus: FOCUS }, settings: LEASHED, at: { x: 11_000, y: 10_000 }, pet: { aggression: 'passive' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }, { command: 'attack', target: FOCUS }]);
    });

    test('after the fight, or with no focus left beyond it: defensive again', async () => {
        const after = world({ orders: { phase: 'recover', focus: null }, settings: LEASHED, pet: { aggression: 'passive' } });
        await petControl().run(after.ctx);
        expect(after.sent).toEqual([{ command: 'defensive' }]);
        const noFocus = world({ orders: { phase: 'engage', focus: null }, settings: LEASHED, pet: { aggression: 'passive' } });
        await petControl().run(noFocus.ctx);
        expect(noFocus.sent).toEqual([{ command: 'defensive' }]);
    });

    test('a parked pet keeps its stance, as ever; called off, it stays parked', async () => {
        const w = world({ contacts: [far()], orders: { focus: FOCUS }, settings: LEASHED, at: { x: 11_500, y: 10_000 }, pet: { walk: 'stay', targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'stay' }]);
    });
});

describe('petControl: throttled', () => {
    test('the same attack order at most once in 3 s, whatever the pet\'s target reads meanwhile; a different one at once', async () => {
        const w = world({ contacts: [held(), mob(52)], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(1);
        (w.ctx.memory.get('petAttack') as { at: number }).at -= 2900;
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(1);
        (w.ctx.memory.get('petAttack') as { at: number }).at -= 200;
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(2);
        w.pic.orders.focus = 52;
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }, { command: 'attack', target: FOCUS }, { command: 'attack', target: 52 }]);
    });

    test('a stance and a walk order each at most once in 1.5 s', async () => {
        const w = world({ orders: { phase: 'retreat', focus: null }, pet: { targetObjectId: FOCUS } });
        // Far off, so its walk order goes again: beside us it wouldn't.
        const entry = w.ctx.sdk.getPet()!;
        Object.assign(w.ctx.sdk, { getPet: () => ({ ...entry, distance: 900 }) });
        await petControl().run(w.ctx);
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
        for (const k of ['petOrder:stance', 'petOrder:walk']) (w.ctx.memory.get(k) as { at: number }).at -= 1600;
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(4);
    });

    test('only a repeat is held back: a retreat that flaps still sends its passive right after a defensive, whichever way it goes', async () => {
        const w = world({ orders: { phase: 'recover', focus: null }, pet: { aggression: 'passive' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }]);
        // The retreat's walk takes the next turn away for up to 20 s: this passive is the only one it gets.
        w.state.pet!.aggression = 'defensive';
        w.pic.orders.phase = 'retreat';
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }, { command: 'passive' }]);
        // A tick of engage and back, all inside the 1.5 s.
        w.state.pet!.aggression = 'passive';
        w.pic.orders.phase = 'engage';
        await petControl().run(w.ctx);
        w.state.pet!.aggression = 'defensive';
        w.pic.orders.phase = 'retreat';
        await petControl().run(w.ctx);
        expect(w.sent.map(c => c.command)).toEqual(['defensive', 'passive', 'defensive', 'passive']);
        // The window trailing the order: the same order again waits.
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(4);
    });
});

describe('petControl: out of view and out of reach', () => {
    test('a focus our own client doesn\'t see: no order', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, inView: [] });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('over 2000 from us: no order, the server would only say it\'s too far (GamePlayer.cs:12183); at 2000 it goes', async () => {
        const at = async (x: number) => {
            const w = world({ at: { x, y: 10_000 }, contacts: [held({ x: 12_000, y: 10_000 })], orders: { focus: FOCUS } });
            await petControl().run(w.ctx);
            return w.sent.length;
        };
        expect(await at(9999)).toBe(0);
        expect(await at(10_000)).toBe(1);
    });

    test('the pet\'s own entry out of view: the window still takes orders', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, petEntry: null });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        const back = world({ orders: { phase: 'retreat', focus: null }, petEntry: null, pet: { walk: 'goTarget' } });
        await petControl().run(back.ctx);
        expect(back.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
    });
});

describe('petControl: pets it leaves alone', () => {
    const all = async (o: WorldOptions) => {
        for (const orders of [{ focus: FOCUS }, { phase: 'retreat' as const, focus: null }, { phase: 'recover' as const, focus: null }]) {
            const w = world({ contacts: [held()], orders, pet: { aggression: 'passive', targetObjectId: 77 }, ...o });
            expect(await petControl().run(w.ctx)).toBe(false);
            expect(w.sent).toEqual([]);
        }
    };
    test('a shade\'s: the Necromancer\'s tactics are its own', () => all({ player: { isShade: true } }));
    test('an immobile one: an order only stops what it does', () => all({ turret: true }));
    test('turned off', () => all({ settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, enabled: false } } }));
    test('turned off by a flag\'s text', () => all({ settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, enabled: 'false' as unknown as boolean } } }));
    test('we are dead', () => all({ dead: true }));
    test('no pet, or a client from before pets', async () => {
        await all({ pet: null });
        await all({ olderClient: true });
    });
});

describe('petControl: a pet on stay is the character\'s own', () => {
    test('with no focus it is left as it is, fight, stance and all', async () => {
        for (const orders of [{ phase: 'recover' as const, focus: null }, { phase: 'travel' as const, focus: null }, { phase: 'retreat' as const, focus: null }, { phase: 'engage' as const, focus: null }]) {
            const w = world({ orders, pet: { walk: 'stay', aggression: 'passive', targetObjectId: 77 } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
        }
    });

    test('a focus ordered: it goes, and the stance is the server\'s to lift (ControlledMobBrain.cs:213-214)', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, pet: { walk: 'stay', aggression: 'passive' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('called off, it stays parked', async () => {
        const w = world({ contacts: [held({ cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 9000 } }), mob(52)], orders: { focus: FOCUS }, pet: { walk: 'stay', targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'stay' }]);
    });

    describe('a fight petControl sent it into is petControl\'s to end', () => {
        /** Parked, sent at the focus, and the answer in: an ordered pet keeps walk stay (ControlledMobBrain.cs:211-226). */
        const sentIn = async () => {
            const w = world({ contacts: [held()], orders: { focus: FOCUS }, pet: { walk: 'stay' } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
            w.sent.length = 0;
            w.state.pet!.targetObjectId = FOCUS;
            w.pic.orders.focus = null;
            return w;
        };

        test('a retreat reaches it: passive and follow', async () => {
            const w = await sentIn();
            w.pic.orders.phase = 'retreat';
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
        });

        test('a retreat with the pet beside us and a target still in its entry: no more follows, and one far off gets them', async () => {
            // r20on Rbcab: 5 in 16 s, 3 of them with the pet at about 110.
            const w = await sentIn();
            w.pic.orders.phase = 'retreat';
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
            w.sent.length = 0;
            const stance = w.ctx.sdk.getPetState()!;
            Object.assign(w.ctx.sdk, { getPetState: () => ({ ...stance, aggression: 'passive', walk: 'follow' }) });
            const pet = w.ctx.sdk.getPet()!;
            Object.assign(w.ctx.sdk, { getPet: () => ({ ...pet, distance: 110 }) });
            w.ctx.memory.delete('petOrder:walk');
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
            Object.assign(w.ctx.sdk, { getPet: () => ({ ...pet, distance: 900 }) });
            w.ctx.memory.delete('petOrder:walk');
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'follow' }]);
        });

        test('between fights it comes off, and stays parked', async () => {
            const w = await sentIn();
            w.pic.orders.phase = 'recover';
            w.pic.contacts.length = 0;
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'stay' }]);
        });

        test('with the answer still on its way: the retreat reaches it just the same', async () => {
            const w = await sentIn();
            w.state.pet!.targetObjectId = null;
            w.pic.orders.phase = 'retreat';
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
            // Long after that order, no target is no fight of ours.
            const idle = await sentIn();
            idle.state.pet!.targetObjectId = null;
            idle.pic.orders.phase = 'retreat';
            (idle.ctx.memory.get('petAttack') as { at: number }).at -= 3100;
            await petControl().run(idle.ctx);
            expect(idle.sent).toEqual([]);
        });

        test('a fight of its own after that order is the routine\'s: another target stays left alone', async () => {
            const w = await sentIn();
            w.state.pet!.targetObjectId = 77;
            w.pic.orders.phase = 'retreat';
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
        });
    });
});

describe('petControl: while we cast', () => {
    const casting = (over: Partial<CombatEvent> = {}): CombatEvent => ({ id: 5, kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: 3000, receivedAt: Date.now() - 500, ...over });

    test('castRunning: the cast time from its 0x72; not after it, not after an interrupt, not someone else\'s', () => {
        const during = (combatEvents: CombatEvent[]) => castRunning(world({ combatEvents }).ctx);
        expect(during([])).toBe(false);
        expect(during([casting()])).toBe(true);
        expect(during([casting({ receivedAt: Date.now() - 3100 })])).toBe(false);
        expect(during([casting({ castTimeMs: undefined })])).toBe(false);
        expect(during([casting({ attackerObjectId: 7 })])).toBe(false);
        expect(during([casting(), { id: 6, kind: 'interrupt', attackerObjectId: ME, targetObjectId: null, receivedAt: Date.now() }])).toBe(false);
        expect(during([{ id: 4, kind: 'interrupt', attackerObjectId: ME, targetObjectId: null, receivedAt: Date.now() - 900 }, casting()])).toBe(true);
    });

    test('no attack order: its select moves the server\'s target. The next turn does it, unthrottled', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, combatEvents: [casting()] });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
        w.state.combatEvents = [];
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('what takes no select still goes: a 0x8A interrupts nothing', async () => {
        const off = world({ contacts: [held({ cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 9000 } }), mob(52)], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS }, combatEvents: [casting()] });
        await petControl().run(off.ctx);
        expect(off.sent).toEqual([{ command: 'follow' }]);
        const run = world({ orders: { phase: 'retreat', focus: null }, combatEvents: [casting()] });
        await petControl().run(run.ctx);
        expect(run.sent).toEqual([{ command: 'passive' }]);
    });
});

describe('petControl: a focus in another region', () => {
    // Object ids are per region (Region.cs:151, :779, :886), so an NPC by us can hold the focus's: "petAttack:not_attackable", or a monster attacked beside a member who has just respawned.
    test('takes no order, whoever holds its id here', async () => {
        const w = world({ contacts: [held({ regionId: 200 })], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('and assist neither nukes what holds its id nor walks to where it stands in the other region', async () => {
        const w = world({ contacts: [held({ regionId: 200 })], orders: { focus: FOCUS } });
        expect(await assist().run(w.ctx)).toBe(false);
        expect(w.calls.cast).toEqual([]);
        expect(w.calls.walk).toEqual([]);
        expect(w.skips).toEqual(['assist: focus in another region']);
    });
});

describe('petControl: a threat under an enemy keep\'s guards, outside the fight', () => {
    // r8: Celt under the keep at (35930,38271), 2841 from Thidranki Faste's centre, 5 s spell cooldown: "00:06 travel", "00:07 engage", "to defend you!" at +6.8, "disengage from combat!" at +7.3. A hit on the owner in that half second sends a defensive pet under the guards.
    const THIDRANKI_ID = 252;
    const celt = (threat: boolean) => enemy(FOCUS, 'hibernia', { regionId: THIDRANKI_ID, x: 35_930, y: 38_271, threat, target: null });
    const there = (threat: boolean, pet: Partial<PetState> = { aggression: 'passive' }) => world({ region: THIDRANKI_ID, at: { x: 37_500, y: 38_271 }, contacts: [celt(threat)], orders: { phase: 'travel', focus: null, anchor: { x: 37_500, y: 38_271, z: 0 } }, pet });

    test('passive stays while it is a threat, whatever the phase read in the gap', async () => {
        const w = there(true);
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('and goes when it isn\'t', async () => {
        const w = there(false);
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }]);
    });

    test('out in the open the same threat holds nothing back', async () => {
        const w = world({ region: THIDRANKI_ID, at: { x: 25_000, y: 25_000 }, contacts: [enemy(FOCUS, 'hibernia', { regionId: THIDRANKI_ID, x: 25_300, y: 25_000, threat: true })], orders: { phase: 'travel', focus: null, anchor: { x: 25_000, y: 25_000, z: 0 } }, pet: { aggression: 'passive' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }]);
    });
});

describe('the last stance sent goes with the pet it went to', () => {
    // A retreat's passive, the pet dead, a new one up defensive by the window (ControlledMobBrain.cs:56, CharacterClassBase.cs:317): petControl sees it agree and sends nothing.
    const afterRetreat = async () => {
        const w = world({ orders: { phase: 'retreat', focus: null } });
        await petControl().run(w.ctx);
        expect(w.sent[0]).toEqual({ command: 'passive' });
        w.state.pet = null;
        await petControl().run(w.ctx);
        w.state.pet = { objectId: 901, name: 'spirit soldier', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null };
        (w.pic.orders as Orders).phase = 'recover';
        w.sent.length = 0;
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
        return w;
    };

    test('a run cut off doesn\'t log a new pet as left passive', async () => {
        const w = await afterRetreat();
        expect(leftPassive(w.ctx.sdk, w.ctx.memory)).toBe(false);
    });

    test('a normal end sends it no needless defensive', async () => {
        const w = await afterRetreat();
        const sent: PetCommand[] = [];
        await petAfterRun({ getPetState: () => w.state.pet!, sendPetCommand: (async (c: PetCommand) => { sent.push(c); return { success: true, message: '' }; }) as never }, w.ctx.memory);
        expect(sent).toEqual(['follow']);
    });

    test('with the pet still the one told, it reads as ever', async () => {
        const w = world({ orders: { phase: 'retreat', focus: null } });
        await petControl().run(w.ctx);
        expect(leftPassive(w.ctx.sdk, w.ctx.memory)).toBe(true);
    });
});

describe('petControl: outside a fight', () => {
    test('a pull: off the focus (the tank\'s to bring); never on it unasked', async () => {
        const orders = { phase: 'pull' as const, focus: FOCUS, puller: 'Tank' };
        const on = world({ contacts: [held()], orders, pet: { targetObjectId: FOCUS } });
        await petControl().run(on.ctx);
        expect(on.sent).toEqual([{ command: 'follow' }]);
        const off = world({ contacts: [held()], orders });
        await petControl().run(off.ctx);
        expect(off.sent).toEqual([]);
        const other = world({ contacts: [held()], orders, pet: { targetObjectId: 77 } });
        await petControl().run(other.ctx);
        expect(other.sent).toEqual([]);
    });

    test('a stray fight with no threats: it comes back, or our regen slows; with threats the coordinator is on it', async () => {
        for (const phase of ['recover', 'gather', 'idle', 'travel'] as const) {
            const stray = world({ orders: { phase, focus: null }, pet: { targetObjectId: 77 } });
            await petControl().run(stray.ctx);
            expect(stray.sent).toEqual([{ command: 'follow' }]);
            const fought = world({ contacts: [mob(77)], orders: { phase, focus: null }, pet: { targetObjectId: 77 } });
            await petControl().run(fought.ctx);
            expect(fought.sent).toEqual([]);
        }
        const nothing = world({ orders: { phase: 'idle', focus: null } });
        await petControl().run(nothing.ctx);
        expect(nothing.sent).toEqual([]);
    });
});

const onTimer = (p: SpellPick): SpellPick => ({ ...p, spell: { ...p.spell, cooldownRemaining: 40 } });
const pick = (over: Partial<SpellPick> & { name?: string } = {}): SpellPick => {
    const { name = 'A Spell', ...rest } = over;
    return { spell: { name, cooldownRemaining: 0 } as Spell, type: 'X', target: 'Pet', range: 2000, radius: 0, power: 10, castTime: 3, duration: 0, recast: 0, concentration: 0, pulse: false, value: 0, damage: 0, spellGroup: 0, damageType: 0, effectGroup: 0, frequency: 0, icon: 0, ...rest };
};

describe('petControl: a strategy that doesn\'t turn a threat into a fight (pet.strayFightsOff: the wolf pack)', () => {
    const PACK = { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, strayFightsOff: true } };
    const QUIET = ['recover', 'gather', 'idle', 'travel'] as const;

    test('between fights a pet in a fight comes off, threat or no threat, passive so that the next hit on its owner doesn\'t send it back', async () => {
        for (const phase of QUIET) {
            const w = world({ contacts: [mob(77)], orders: { phase, focus: null }, pet: { targetObjectId: 77 }, settings: PACK });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
        }
    });

    test('with no fight it only stays out of one', async () => {
        const w = world({ contacts: [mob(77)], orders: { phase: 'travel', focus: null }, settings: PACK });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'passive' }]);
        const already = world({ contacts: [mob(77)], orders: { phase: 'travel', focus: null }, pet: { aggression: 'passive' }, settings: PACK });
        await petControl().run(already.ctx);
        expect(already.sent).toEqual([]);
    });

    test('the fight itself is as ever: the focus goes to the pet, and the next stance is defensive', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, pet: { aggression: 'passive' }, settings: PACK });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }, { command: 'attack', target: FOCUS }]);
    });

    test('a pet on stay is the character\'s, as ever', async () => {
        const w = world({ contacts: [mob(77)], orders: { phase: 'travel', focus: null }, pet: { walk: 'stay', targetObjectId: 77 }, settings: PACK });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('a flag\'s text counts (--pet.strayFightsOff=true)', async () => {
        const w = world({ contacts: [mob(77)], orders: { phase: 'recover', focus: null }, pet: { targetObjectId: 77 }, settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, strayFightsOff: 'true' as unknown as boolean } } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'passive' }, { command: 'follow' }]);
    });

    test('the pack has it on, what decides a threat into a fight has it off', () => {
        expect(PACK_SETTINGS.pet?.strayFightsOff).toBe(true);
        expect(PET_SETTINGS.strayFightsOff).toBeUndefined();
    });
});

describe('summonPet: the gates', () => {
    const SUMMON = pick({ name: 'Summon Spirit Fighter', power: -25, target: 'Self', range: 0, castTime: 6 });
    const noPet = (o: WorldOptions = {}) => world({ pet: null, summon: SUMMON, orders: { phase: 'recover', focus: null }, ...o });
    const acts = async (o: WorldOptions) => {
        const w = noPet(o);
        const acted = await summonPet().run(w.ctx);
        return { acted, cast: w.calls.summon.length, skips: w.skips };
    };
    const silent = { acted: false, cast: 0, skips: [] };

    test('with no pet, between fights, in every phase it may: the spell goes through bot.summonPet', async () => {
        for (const phase of ['recover', 'gather', 'idle', 'travel'] as const) {
            const w = noPet({ orders: { phase, focus: null } });
            expect(await summonPet().run(w.ctx)).toBe(true);
            expect(w.calls.summon).toEqual([{ spell: SUMMON.spell, opts: undefined }]);
            expect(w.doing).toEqual([{ kind: 'summon', targetId: null, detail: 'Summon Spirit Fighter' }]);
            expect(w.results).toEqual([{ kind: 'summon', success: true, reason: undefined, targetId: null }]);
        }
    });

    test('a window pet left behind (past 3500 or out of view) in a quiet phase: summoned anew with replace, once a minute (arena round 24)', async () => {
        const far = noPet({ pet: {}, petEntry: { distance: 5000 } });
        expect(await summonPet().run(far.ctx)).toBe(true);
        expect(far.calls.summon).toEqual([{ spell: SUMMON.spell, opts: { replace: true } }]);
        expect(await summonPet().run(far.ctx)).toBe(false);
        const gone = noPet({ pet: {}, petEntry: null });
        expect(await summonPet().run(gone.ctx)).toBe(true);
        // Near, travelling, or with a foe near: left as it is.
        expect(await acts({ pet: {}, petEntry: { distance: 3000 } })).toEqual(silent);
        expect(await acts({ pet: {}, petEntry: { distance: 5000 }, orders: { phase: 'travel', focus: null } })).toEqual(silent);
        expect(await acts({ pet: {}, petEntry: { distance: 5000 }, contacts: [mob(77)] })).toEqual(silent);
    });

    test('in a pull, if we aren\'t the one pulling', async () => {
        expect((await acts({ orders: { phase: 'pull', focus: FOCUS, puller: 'Tank' } })).cast).toBe(1);
        expect(await acts({ orders: { phase: 'pull', focus: FOCUS, puller: 'Owner' } })).toEqual(silent);
    });

    test('silent with: no spell, a pet up, a client from before pets, death, the spell on its timer, a hostile focus, a retreat, threats', async () => {
        expect(await acts({ summon: null })).toEqual(silent);
        expect(await acts({ pet: {} })).toEqual(silent);
        expect(await acts({ olderClient: true })).toEqual(silent);
        expect(await acts({ dead: true })).toEqual(silent);
        expect(await acts({ summon: onTimer(SUMMON) })).toEqual(silent);
        expect(await acts({ orders: { phase: 'engage', focus: FOCUS }, contacts: [held()] })).toEqual(silent);
        expect(await acts({ orders: { phase: 'retreat', focus: null } })).toEqual(silent);
        expect(await acts({ contacts: [mob(77)] })).toEqual(silent);
        expect(await acts({ settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, enabled: false } } })).toEqual(silent);
    });

    test('an enemy player within 2500: no 6 s of standing still; past that, or stale, or in another region: it goes', async () => {
        const foe = (y: number, over: Partial<Contact> = {}) => enemy(60, 'albion', { regionId: R, x: OWNER_AT.x, y: OWNER_AT.y + y, ...over });
        expect(await acts({ contacts: [foe(2400)] })).toEqual(silent);
        expect((await acts({ contacts: [foe(2600)] })).cast).toBe(1);
        expect((await acts({ contacts: [foe(1000, { stale: true })] })).cast).toBe(1);
        expect((await acts({ contacts: [foe(1000, { regionId: 1 })] })).cast).toBe(1);
        // A monster that isn't fighting us doesn't count.
        expect((await acts({ contacts: [contact(61, { regionId: R, x: OWNER_AT.x, y: OWNER_AT.y + 1000 })] })).cast).toBe(1);
    });

    test('below the power for it: the turn goes on with a reason, as nothing above is fighting', async () => {
        const saving = { acted: false, cast: 0, skips: ['pet: saving power'] };
        // 25 % of 1000 is 250 by powerOf; summonMana is 30.
        expect(await acts({ player: { mana: 249, manaPercent: 30 } })).toEqual(saving);
        expect(await acts({ player: { mana: 290, manaPercent: 29 } })).toEqual(saving);
        expect((await acts({ player: { mana: 300, manaPercent: 30 } })).cast).toBe(1);
        expect((await acts({ settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, summonMana: 60 } } })).skips).toEqual(['pet: saving power']);
    });

    describe('the rest below stops at the power for it', () => {
        const SETTLED = { orders: { phase: 'recover' as const, focus: null } };
        const turn = async (o: WorldOptions) => {
            const w = noPet({ ...SETTLED, ...o });
            await summonPet().run(w.ctx);
            const rested = await rest().run(w.ctx);
            return { rested, rest: w.calls.rest, cast: w.calls.summon.length, w };
        };

        test('at 22 %: to summonMana, not to rest.mana, and health doesn\'t hold it', async () => {
            const t = await turn({ player: { mana: 220, manaPercent: 22 } });
            expect(t.rested).toBe(true);
            expect(t.cast).toBe(0);
            expect(t.rest).toEqual([{ healthPercent: 0, manaPercent: 30, timeout: 120_000 }]);
        });

        test('what the spell costs, where that is more: 45 % of 1000 needs 45', async () => {
            const dear = pick({ name: 'Summon Spirit Fighter', power: -45, target: 'Self', range: 0, castTime: 6 });
            const t = await turn({ summon: dear, player: { mana: 300, manaPercent: 30 } });
            expect(t.rest).toEqual([{ healthPercent: 0, manaPercent: 45, timeout: 120_000 }]);
        });

        test('the next turn at 30 % the summon goes, and the rest after it runs to rest.mana: the ready gate counts what it cost', async () => {
            const t = await turn({ player: { mana: 300, manaPercent: 30 } });
            expect(t.cast).toBe(1);
            expect(t.rest).toEqual([{ healthPercent: PVE_SETTINGS.rest.hp, manaPercent: PVE_SETTINGS.rest.mana, timeout: 120_000 }]);
        });

        test('nothing to wait for, a full rest: a pet up, the spell on its timer, a retry pending, pets off, no summon', async () => {
            const full = { healthPercent: PVE_SETTINGS.rest.hp, manaPercent: PVE_SETTINGS.rest.mana, timeout: 120_000 };
            const low = { player: { mana: 220, manaPercent: 22 } };
            for (const o of [{ pet: {} }, { summon: onTimer(SUMMON) }, { summon: null }, { settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, enabled: false } } }] as WorldOptions[]) {
                expect((await turn({ ...low, ...o })).rest).toEqual([full]);
            }
            const w = noPet({ ...SETTLED, ...low });
            w.ctx.memory.set('summonRetry', Date.now() + 5000);
            await summonPet().run(w.ctx);
            await rest().run(w.ctx);
            expect(w.calls.rest).toEqual([full]);
        });

        test('what it asked for goes with the turn: a pet back up by the next one means a full rest', async () => {
            const w = noPet({ ...SETTLED, player: { mana: 220, manaPercent: 22 } });
            await summonPet().run(w.ctx);
            w.state.pet = { objectId: PET, name: 'spirit soldier', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null };
            await summonPet().run(w.ctx);
            await rest().run(w.ctx);
            expect(w.calls.rest).toEqual([{ healthPercent: PVE_SETTINGS.rest.hp, manaPercent: PVE_SETTINGS.rest.mana, timeout: 120_000 }]);
        });

        test('a rest.mana below it stays the limit', async () => {
            const t = await turn({ settings: { ...PVE_SETTINGS, rest: { hp: 95, mana: 25 } }, player: { mana: 220, manaPercent: 22 } });
            expect(t.rest).toEqual([{ healthPercent: 95, manaPercent: 25, timeout: 120_000 }]);
        });
    });

    test('a retry timer by the outcome (buffRetryMs): after one that worked, and longer after one that was refused', async () => {
        const failed = noPet({ summonPet: () => ({ success: false, reason: 'refused', message: 'You already have a charmed creature, release it first!' }) });
        const t0 = Date.now();
        expect(await summonPet().run(failed.ctx)).toBe(true);
        expect(failed.results).toEqual([{ kind: 'summon', success: false, reason: 'refused', targetId: null }]);
        expect(failed.ctx.memory.get('summonRetry')).toBeGreaterThanOrEqual(t0 + 59_000);
        expect(await summonPet().run(failed.ctx)).toBe(false);
        expect(failed.calls.summon.length).toBe(1);
        expect(failed.skips).toEqual([]);

        const interrupted = noPet({ summonPet: () => ({ success: false, reason: 'interrupted', message: 'Your spell is interrupted.' }) });
        await summonPet().run(interrupted.ctx);
        expect(interrupted.ctx.memory.get('summonRetry')).toBeLessThan(Date.now() + 9000);
        expect(buffRetryMs({ success: true })).toBe(20_000);
    });
});

describe('fnfPet: the gates', () => {
    const AIR = pick({ name: 'Call Lesser Air Sprite', type: 'SummonTheurgistPet', target: 'Enemy', power: -12, range: 2000 });
    const lasting = () => held({ hp: 90, lossSince: Date.now() - 3000, lossFromHp: 100 });
    const fnf = (o: WorldOptions = {}) => world({ pet: null, fnf: AIR, contacts: [lasting()], orders: { focus: FOCUS }, ...o });
    const casts = async (o: WorldOptions) => { const w = fnf(o); const acted = await fnfPet().run(w.ctx); expect(acted).toBe(w.calls.summon.length > 0); return w.calls.summon.length; };

    test('a held focus: cast on it, as a nuke (the opener counts it)', async () => {
        const w = fnf();
        expect(await fnfPet().run(w.ctx)).toBe(true);
        expect(w.calls.summon).toEqual([{ spell: AIR.spell, opts: { target: FOCUS } }]);
        expect(w.doing).toEqual([{ kind: 'nuke', targetId: FOCUS, detail: 'Call Lesser Air Sprite' }]);
        expect(w.results).toEqual([{ kind: 'nuke', success: true, reason: undefined, targetId: FOCUS }]);
        // Another one on the next turn: a pet fights until it ends, and it takes the floor to stop them.
        expect(await fnfPet().run(w.ctx)).toBe(true);
    });

    test('the rules of a window pet\'s order: not held, cc\'d, a mezz in flight, out of view, no focus, another phase', async () => {
        expect(await casts({ contacts: [mob(FOCUS, 500)] })).toBe(0);
        expect(await casts({ contacts: [{ ...lasting(), cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 9000 } }, mob(52)] })).toBe(0);
        expect(await casts({ orders: { focus: FOCUS, cc: [{ targetId: FOCUS, by: 'Bard' }] } })).toBe(0);
        expect(await casts({ inView: [] })).toBe(0);
        expect(await casts({ orders: { focus: null } })).toBe(0);
        expect(await casts({ orders: { phase: 'recover', focus: FOCUS } })).toBe(0);
        expect(await casts({ settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, enabled: false } } })).toBe(0);
    });

    test('the floor: nothing below pet.fnfFloor, nor below what it costs, and it never says so (assist below has the turn)', async () => {
        expect(await casts({ player: { mana: 200, manaPercent: 20 } })).toBe(1);
        expect(await casts({ player: { mana: 190, manaPercent: 19 } })).toBe(0);
        expect(await casts({ player: { mana: 119, manaPercent: 20 } })).toBe(0);
        expect(await casts({ player: { manaPercent: 39 }, settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, fnfFloor: 40 } } })).toBe(0);
        const w = fnf({ player: { mana: 100, manaPercent: 10 } });
        await fnfPet().run(w.ctx);
        expect(w.skips).toEqual([]);
    });

    describe('a fight that will last: it pays at the end of its cast and goes with its target', () => {
        /** The focus at `hp` %, `ms` after its first health loss of the fight, down from `from` %. */
        const going = (hp: number, ms: number, from = 100) => ({ contacts: [held({ hp, lossSince: Date.now() - ms, lossFromHp: from })] });

        test('no clock before its first loss of the fight, whatever hostileSince says', async () => {
            expect(await casts({ contacts: [held({ hp: 90 })] })).toBe(0);
            expect(await casts({ contacts: [held({ hp: 100, hostileSince: Date.now() - 30_000 })] })).toBe(0);
        });

        test('judged only after 2 s of damage', async () => {
            expect(await casts(going(99, 1900))).toBe(0);
            expect(await casts(going(99, 2100))).toBe(1);
        });

        test('cast + pet.fnfLifeMs: with a 3 s cast and the default 10 s, 13 s left', async () => {
            expect(await casts(going(50, 14_000))).toBe(1);
            expect(await casts(going(50, 12_000))).toBe(0);
            expect(await casts({ ...going(50, 14_000), fnf: { ...AIR, castTime: 5 } })).toBe(0);
            expect(await casts({ ...going(50, 7000), settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, fnfLifeMs: 3000 } } })).toBe(1);
        });

        test('the rate from where the loss began: what a carried pull lost before the engage is not in it', async () => {
            // 93 % as the fight starts, 84 % 2.5 s later: 23 s left; counted from 100 % that would be 13 s.
            expect(await casts(going(84, 2500, 93))).toBe(1);
            expect(await casts(going(84, 2000, 100))).toBe(0);
        });

        /** Real fights, [ms after the first loss, hp]: nothing above `from`. Watcher logs c1on and b2. */
        const replay = async (from: number, samples: [number, number][]) => {
            let passed = 0;
            for (const [ms, hp] of samples) passed += await casts(going(hp, ms, from));
            return passed;
        };

        test('fights of 11 s stay on nukes: 2 of 13 samples at most, with fights over before a cast at those would pay', async () => {
            // c1on: focus 23130, 94 -> 59 at +4.0 s after the engage; 23129, 95 -> 88 at +1.2 s; 23164, 95 -> 86 at +1.6 s.
            expect(await replay(94, [[800, 51], [1200, 51], [1700, 51], [2500, 46], [2900, 25], [3300, 7], [4900, 3]])).toBe(0);
            expect(await replay(95, [[2400, 74], [2800, 62], [4000, 57], [4500, 52], [5700, 30], [6100, 15], [6900, 7]])).toBe(0);
            expect(await replay(95, [[3200, 79], [4100, 67], [4500, 57], [6900, 32], [8500, 10]])).toBe(1);
        });

        test('a long fight gets pets: Growler, 64 s by a pet alone', async () => {
            // b2: 96 -> 86 at +8.5 s after the engage, and then a hit every 2.8 s or so.
            expect(await replay(96, [[2400, 86], [6800, 64], [7700, 57], [10_500, 50], [32_600, 31], [35_500, 24], [38_300, 18], [41_100, 11], [43_900, 4]])).toBeGreaterThanOrEqual(3);
        });

        test('no skip: assist below has the turn, and its nuke lands at the end of the same cast', async () => {
            const w = fnf(going(10, 15_000));
            expect(await fnfPet().run(w.ctx)).toBe(false);
            expect(w.skips).toEqual([]);
            expect(w.doing).toEqual([]);
        });
    });

    test('off the map: skipped with a reason, as a summon there kicks the player', async () => {
        const w = fnf({ region: 200, at: { x: 286_364, y: 648_697 } });
        expect(await fnfPet().run(w.ctx)).toBe(false);
        expect(w.calls.summon).toEqual([]);
        expect(w.skips).toEqual(['pet: off the map, no summon']);
    });

    test('out of its range: no walk here, position and assist place us', async () => {
        expect(await casts({ at: { x: 12_400, y: 10_000 } })).toBe(0);
        expect(await casts({ at: { x: 12_200, y: 10_000 } })).toBe(1);
    });

    test('no spell, or on a timer', async () => {
        expect(await casts({ fnf: null })).toBe(0);
        expect(await casts({ fnf: onTimer(AIR) })).toBe(0);
    });

    test('a refusal that comes back at once (invalid_target, not_attackable, too many pets) is no hot loop: the list goes on for a while', async () => {
        for (const reason of ['invalid_target', 'not_attackable', 'no_target', 'refused']) {
            const w = fnf({ summonPet: () => ({ success: false, reason, message: 'no' }) });
            expect(await fnfPet().run(w.ctx)).toBe(true);
            expect(w.results).toEqual([{ kind: 'nuke', success: false, reason, targetId: FOCUS }]);
            expect(await fnfPet().run(w.ctx)).toBe(false);
            expect(w.calls.summon.length).toBe(1);
            w.ctx.memory.set('fnfRetry', Date.now() - 1);
            expect(await fnfPet().run(w.ctx)).toBe(true);
        }
    });
});

describe('petHeal: the thresholds', () => {
    const MEND = pick({ name: 'Mend Simulacrum', type: 'Heal', power: 4, range: 2000 });
    const heals = async (o: WorldOptions) => {
        const w = world({ petHeal: MEND, orders: { focus: FOCUS }, contacts: [held()], ...o });
        const acted = await petHeal().run(w.ctx);
        expect(acted).toBe(w.calls.cast.length > 0);
        return w.calls.cast.length;
    };

    test('in a fight: below pet.healBelow', async () => {
        expect(await heals({ petEntry: { healthPercent: 49 } })).toBe(1);
        expect(await heals({ petEntry: { healthPercent: 50 } })).toBe(0);
        expect(await heals({ petEntry: { healthPercent: 69 }, settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, healBelow: 70 } } })).toBe(1);
    });

    test('between fights: below 80, with power to spare', async () => {
        const quiet = { orders: { phase: 'recover' as const, focus: null }, contacts: [] };
        expect(await heals({ ...quiet, petEntry: { healthPercent: 79 } })).toBe(1);
        expect(await heals({ ...quiet, petEntry: { healthPercent: 80 } })).toBe(0);
        expect(await heals({ ...quiet, petEntry: { healthPercent: 79 }, player: { manaPercent: 49 } })).toBe(0);
        // A threat makes it a fight whatever the orders say yet.
        expect(await heals({ orders: { phase: 'recover', focus: null }, contacts: [mob(77)], petEntry: { healthPercent: 79 } })).toBe(0);
        expect(await heals({ orders: { phase: 'recover', focus: null }, contacts: [mob(77)], petEntry: { healthPercent: 40 }, player: { manaPercent: 10 } })).toBe(1);
    });

    test('no target given: the spell lands on the pet with no walk or select (castSpell)', async () => {
        const w = world({ petHeal: MEND, petEntry: { healthPercent: 10 }, orders: { focus: FOCUS }, contacts: [held()] });
        await petHeal().run(w.ctx);
        expect(w.calls.cast).toEqual([[MEND.spell]]);
        expect(w.doing).toEqual([{ kind: 'heal', targetId: PET, detail: 'Mend Simulacrum' }]);
        expect(w.results).toEqual([{ kind: 'petHeal', success: true, reason: undefined, targetId: PET }]);
    });

    test('nothing to do with: no heal known or paid for, a pet out of view or out of range, death', async () => {
        expect(await heals({ petHeal: null, petEntry: { healthPercent: 10 } })).toBe(0);
        expect(await heals({ petEntry: null })).toBe(0);
        expect(await heals({ pet: null })).toBe(0);
        expect(await heals({ petEntry: { healthPercent: 10, distance: 2001 } })).toBe(0);
        expect(await heals({ petEntry: { healthPercent: 10 }, dead: true })).toBe(0);
        expect(await heals({ petHeal: onTimer(MEND), petEntry: { healthPercent: 10 } })).toBe(0);
    });

    describe('what it asks for: what this pet misses, not the biggest heal in the book', () => {
        test('its full health by its level, as the server sets a summoned pet\'s (MaxHealthCalculator.cs:102, GameSummonedPet.cs SetStats)', () => {
            expect(petMaxHp(7)).toBe(195);
            expect(petMaxHp(18)).toBe(562);
        });

        test('a level-7 pet at 79 %: 41 missing, for a Druid\'s Greater Regrowth of 263 to be left in the book', async () => {
            const w = world({ petHeal: MEND, petEntry: { healthPercent: 79, level: 7 }, orders: { phase: 'recover', focus: null }, contacts: [] });
            await petHeal().run(w.ctx);
            expect(w.calls.petHealNeed).toEqual([41]);
        });

        test('an entry with no level to go by asks for none: the one restoring most', async () => {
            const w = world({ petHeal: MEND, petEntry: { healthPercent: 10 }, orders: { focus: FOCUS }, contacts: [held()] });
            await petHeal().run(w.ctx);
            expect(w.calls.petHealNeed).toEqual([undefined]);
        });
    });

    describe('a heal on friends in a fight is the group\'s power: this much stays', () => {
        const REALM = pick({ name: 'Greater Regeneration', type: 'Heal', target: 'Realm', power: 39, range: 2000 });
        const inAFight = (mana: number, spell = REALM) => world({ petHeal: spell, petEntry: { healthPercent: 40 }, orders: { focus: FOCUS }, contacts: [held()], player: { mana, maxMana: 163, manaPercent: Math.round(100 * mana / 163) } });

        test('32 % of her pool, 39 of it for the pet: no', async () => {
            const w = inAFight(52);
            expect(await petHeal().run(w.ctx)).toBe(false);
            expect(w.calls.cast).toEqual([]);
        });

        test('with a quarter left after it: yes', async () => {
            const w = inAFight(80);
            expect(await petHeal().run(w.ctx)).toBe(true);
            expect(w.calls.cast).toEqual([[REALM.spell, PET]]);
        });

        test('a Pet-target heal is no heal on a member: "in a fight: below pet.healBelow", at any power', async () => {
            const w = inAFight(20, MEND);
            expect(await petHeal().run(w.ctx)).toBe(true);
        });
    });

    test('a refusal: not again for a while', async () => {
        const w = world({ petHeal: MEND, petEntry: { healthPercent: 10 }, orders: { focus: FOCUS }, contacts: [held()], castSpell: () => ({ success: false, reason: 'no_pet', message: 'No pet to cast this on' }) });
        expect(await petHeal().run(w.ctx)).toBe(true);
        expect(await petHeal().run(w.ctx)).toBe(false);
        expect(w.calls.cast.length).toBe(1);
    });
});

describe('petBuff: coverage by icon and the retry timer', () => {
    const buffs = [
        { ...pick({ name: 'Strengthen Spirit', type: 'StrengthBuff', power: 2, range: 1000, duration: 1200, icon: 811 }), slot: 'str' },
        { ...pick({ name: 'Quicken Spirit', type: 'CombatSpeedBuff', power: 3, range: 1000, duration: 600, icon: 830 }), slot: 'haste' },
    ];
    const quiet = { orders: { phase: 'recover' as const, focus: null } };
    const cast = (w: ReturnType<typeof world>) => w.calls.cast.map(c => (c[0] as Spell).name);

    test('the first whose icon the window doesn\'t show, with no target given; none when all show', async () => {
        const w = world({ ...quiet, petBuffs: buffs });
        expect(await petBuff().run(w.ctx)).toBe(true);
        expect(cast(w)).toEqual(['Strengthen Spirit']);
        expect(w.calls.cast[0]!.length).toBe(1);
        expect(w.doing).toEqual([{ kind: 'buff', targetId: PET, detail: 'Strengthen Spirit on spirit soldier' }]);
        expect(w.results).toEqual([{ kind: 'petBuff', success: true, reason: undefined, targetId: PET }]);
        const second = world({ ...quiet, petBuffs: buffs, pet: { icons: [811] } });
        await petBuff().run(second.ctx);
        expect(cast(second)).toEqual(['Quicken Spirit']);
        const covered = world({ ...quiet, petBuffs: buffs, pet: { icons: [811, 830] } });
        expect(await petBuff().run(covered.ctx)).toBe(false);
        expect(cast(covered)).toEqual([]);
    });

    test('one that landed but shows no icon (the window lists 8 at most): not again until most of its time is up', async () => {
        const w = world({ ...quiet, petBuffs: [buffs[0]!] });
        const t0 = Date.now();
        await petBuff().run(w.ctx);
        const retry = w.ctx.memory.get('petBuffRetry') as Map<string, number>;
        expect(retry.get('Strengthen Spirit')).toBeGreaterThanOrEqual(t0 + 1080_000 - 5);
        expect(retry.get('Strengthen Spirit')).toBeLessThanOrEqual(Date.now() + 1080_000);
        expect(await petBuff().run(w.ctx)).toBe(false);
        retry.set('Strengthen Spirit', Date.now() - 1);
        expect(await petBuff().run(w.ctx)).toBe(true);
        expect(w.calls.cast.length).toBe(2);
    });

    test('a failed one: by buffRetryMs', async () => {
        const w = world({ ...quiet, petBuffs: [buffs[0]!], castSpell: () => ({ success: false, reason: 'out_of_range', message: 'too far' }) });
        await petBuff().run(w.ctx);
        const retry = (w.ctx.memory.get('petBuffRetry') as Map<string, number>).get('Strengthen Spirit')!;
        expect(retry).toBeLessThanOrEqual(Date.now() + 8000);
        expect(retry).toBeGreaterThan(Date.now() + 7000);
        expect(await petBuff().run(w.ctx)).toBe(false);
    });

    test('a new pet starts over, under a reused id too: it is told by the last loss', async () => {
        const w = world({ ...quiet, petBuffs: [buffs[0]!] });
        await petBuff().run(w.ctx);
        expect(await petBuff().run(w.ctx)).toBe(false);
        w.state.lastPetLoss = { at: Date.now(), objectId: PET, name: 'spirit soldier', cause: 'died' } as never;
        expect(await petBuff().run(w.ctx)).toBe(true);
    });

    test('quiet phases and no threats only (and another member\'s pull: below)', async () => {
        for (const phase of ['engage', 'travel', 'retreat'] as const) {
            const w = world({ orders: { phase, focus: null }, petBuffs: buffs });
            expect(await petBuff().run(w.ctx)).toBe(false);
        }
        expect(await petBuff().run(world({ ...quiet, contacts: [mob(77)], petBuffs: buffs }).ctx)).toBe(false);
        for (const phase of ['recover', 'gather', 'idle'] as const) expect(await petBuff().run(world({ orders: { phase, focus: null }, petBuffs: buffs }).ctx)).toBe(true);
    });

    test('the buffMana gate for what costs power, and what it can pay; a concentration buff by its pool', async () => {
        const low = world({ ...quiet, petBuffs: buffs, player: { manaPercent: 39 } });
        expect(await petBuff().run(low.ctx)).toBe(false);
        expect(await petBuff().run(world({ ...quiet, petBuffs: buffs, player: { manaPercent: 40 } }).ctx)).toBe(true);
        expect(await petBuff().run(world({ ...quiet, petBuffs: buffs, player: { mana: 1 } }).ctx)).toBe(false);
        const conc = [{ ...pick({ name: 'Spirit Bond', power: 0, duration: 65535, concentration: 10, range: 1000, icon: 900 }), slot: 'str' }];
        expect(await petBuff().run(world({ ...quiet, petBuffs: conc, player: { manaPercent: 5, concentration: 9 } }).ctx)).toBe(false);
        expect(await petBuff().run(world({ ...quiet, petBuffs: conc, player: { manaPercent: 5, concentration: 10 } }).ctx)).toBe(true);
    });

    test('in reach only, and in view; a spell on its timer waits, the next one goes', async () => {
        expect(await petBuff().run(world({ ...quiet, petBuffs: buffs, petEntry: { distance: 1001 } }).ctx)).toBe(false);
        expect(await petBuff().run(world({ ...quiet, petBuffs: buffs, petEntry: null }).ctx)).toBe(false);
        const w = world({ ...quiet, petBuffs: [{ ...buffs[0]!, spell: { ...buffs[0]!.spell, cooldownRemaining: 4 } }, buffs[1]!] });
        await petBuff().run(w.ctx);
        expect(cast(w)).toEqual(['Quicken Spirit']);
    });
});

describe('withPets: where they go', () => {
    const names = (list: Behavior[]) => list.map(b => b.name);
    const MAIN: PetKit = { main: true, window: false, fnf: false };
    const FNF: PetKit = { main: false, fnf: true, window: false };
    const WINDOW: PetKit = { main: false, fnf: false, window: true };

    const pve = defaultBehaviors();
    const rvr = rvrBehaviors();

    test('no use for them: the list as it is, the same array', () => {
        for (const lists of [pve, rvr]) {
            for (const list of Object.values(lists)) {
                expect(withPets(list, {})).toBe(list);
                expect(withPets(list, { main: false, fnf: false, window: false })).toBe(list);
                expect(withPets(list, null)).toBe(list);
                expect(withPets(list, undefined)).toBe(list);
            }
        }
    });

    test('a main pet on each role\'s list', () => {
        expect(names(withPets(pve.tank, MAIN))).toEqual(['release', 'hand', 'healer', 'sprint', 'petControl', 'retreat', 'rez', 'pull', 'petHeal', 'summonPet', 'tank', 'guard', 'shedLoad', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'rest']);
        expect(names(withPets(pve.healer, MAIN))).toEqual(['release', 'healer', 'sprint', 'petControl', 'retreat', 'emergencyHeal', 'flee', 'rez', 'heal', 'petHealUrgent', 'crowdControl', 'summonPet', 'position', 'petHeal', 'shedLoad', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'rest']);
        expect(names(withPets(pve.support, MAIN))).toEqual(['release', 'healer', 'sprint', 'petControl', 'retreat', 'emergencyHeal', 'flee', 'rez', 'petHealUrgent', 'crowdControl', 'heal', 'song', 'summonPet', 'position', 'petHeal', 'shedLoad', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'rest']);
        expect(names(withPets(pve.nuker, MAIN))).toEqual(['release', 'healer', 'sprint', 'petControl', 'retreat', 'flee', 'rez', 'petHealUrgent', 'crowdControl', 'emergencyHeal', 'summonPet', 'position', 'petHeal', 'assist', 'shedLoad', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'rest']);
        expect(names(withPets(pve.melee, MAIN))).toEqual(['release', 'hand', 'healer', 'sprint', 'petControl', 'retreat', 'rez', 'song', 'petHeal', 'summonPet', 'assistMelee', 'shedLoad', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'rest']);
    });

    test('the RvR lists the same way', () => {
        expect(names(withPets(rvr.nuker, MAIN))).toEqual(['release', 'sprint', 'petControl', 'retreat', 'summonOnTheWayBack', 'rejoinFight', 'flee', 'rez', 'petHealUrgent', 'crowdControl', 'emergencyHeal', 'summonPet', 'position', 'petHeal', 'assist', 'shedLoad', 'hasten', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'fightSit', 'rest', 'loiter']);
        expect(names(withPets(rvr.tank, MAIN))).toEqual(['release', 'hand', 'sprint', 'petControl', 'retreat', 'summonOnTheWayBack', 'rejoinFight', 'rez', 'song', 'petHeal', 'summonPet', 'tank', 'guard', 'shedLoad', 'hasten', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'rest', 'loiter']);
    });

    test('a Theurgist: fnfPet before the fight and nothing else, as there is no window pet to look after', () => {
        expect(names(withPets(pve.nuker, FNF))).toEqual(['release', 'healer', 'sprint', 'retreat', 'flee', 'rez', 'crowdControl', 'emergencyHeal', 'position', 'fnfPet', 'assist', 'shedLoad', 'holdFormation', 'buff', 'rest']);
    });

    test('a window pet from an earlier script, with no summon of its own: petControl alone', () => {
        expect(names(withPets(pve.nuker, WINDOW))).toEqual(['release', 'healer', 'sprint', 'petControl', 'retreat', 'flee', 'rez', 'crowdControl', 'emergencyHeal', 'position', 'assist', 'shedLoad', 'holdFormation', 'buff', 'rest']);
    });

    test('a strategy\'s memberBehaviors, literal lists without some of the names', () => {
        const ciaran = [release(), retreat(), flee(), position(), assist({ holdMs: 4000 }), holdFormation(), rest()];
        expect(names(withPets(ciaran, MAIN))).toEqual(['release', 'petControl', 'retreat', 'flee', 'summonPet', 'position', 'petHeal', 'assist', 'petBuffAtStart', 'holdFormation', 'petBuff', 'rest']);
        const bare = [assist()];
        expect(names(withPets(bare, MAIN))).toEqual(['petControl', 'petHeal', 'summonPet', 'assist', 'petBuff']);
        const noFight = [release(), rest()];
        expect(names(withPets(noFight, MAIN))).toEqual(['release', 'petControl', 'petHeal', 'summonPet', 'petBuff', 'rest']);
    });

    test('idempotent, and a place the strategy chose stays', () => {
        for (const kit of [MAIN, FNF, WINDOW, { main: true, fnf: true, window: true }]) {
            const once = withPets(pve.nuker, kit);
            expect(names(withPets(once, kit))).toEqual(names(once));
            expect(withPets(once, kit)).toBe(once);
        }
        const own = [petControl(), release(), assist(), rest()] as Behavior[];
        const placed = names(withPets(own, MAIN));
        expect(placed.indexOf('petControl')).toBe(0);
        expect(placed.filter(n => n === 'petControl').length).toBe(1);
    });

    test('with a character in the list before it: its routine stays, and a fight with a name of its own counts as none', () => {
        const own = (name: string): Behavior => ({ name, run: () => false });
        const list = withCharacter(pve.nuker as Behavior[], { react: [own('myHeal')], fight: [own('myFight')], chores: [own('myChore')] });
        expect(names(withPets(list, MAIN))).toEqual(['release', 'healer', 'sprint', 'petControl', 'retreat', 'flee', 'rez', 'petHealUrgent', 'crowdControl', 'emergencyHeal', 'summonPet', 'position', 'myHeal', 'myFight', 'myChore', 'petHeal', 'shedLoad', 'petBuffAtStart', 'holdFormation', 'petBuff', 'buff', 'rest']);
    });

    describe('petKit: from the spell list and the window', () => {
        const kit = (ids: number[], over: { pet?: Partial<PetState> | null; isShade?: boolean } = {}) => {
            const spells = ids.map(id => { const s = getSpell(id)!; return { name: s.name, internalId: id, level: 20, lineName: '', lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 } as Spell; });
            const sdk = {
                getSkills: () => ({ spells }), getPlayer: () => ({ mana: 500, isShade: over.isShade }),
                getPetState: () => over.pet ?? null,
            } as unknown as BotSDK;
            return petKit(sdk, { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions);
        };
        const ofType = (type: string) => {
            // The lowest id of a type in the real table.
            for (let id = 1; id < 60_000; id++) if (getSpell(id)?.type === type) return id;
            throw new Error(`no spell of type ${type}`);
        };

        test('a window pet the group summons by itself, each type', () => {
            for (const type of ['SummonSimulacrum', 'SummonSpiritFighter', 'SummonUnderhill', 'SummonDruidPet', 'SummonCommander']) {
                expect(kit([ofType(type)])).toEqual({ main: true, fnf: false, window: false });
            }
            expect(kit([ofType('SummonHunterPet')])).toEqual({ main: true, instantSummon: true, fnf: false, window: false });
        });

        test('a Theurgist\'s', () => {
            expect(kit([ofType('SummonTheurgistPet')])).toEqual({ main: false, fnf: true, window: false });
        });

        test('nothing for what the group doesn\'t summon by itself: a Necromancer\'s, an Animist\'s, a charm, a minion, a bomber', () => {
            for (const type of ['SummonNecroPet', 'SummonAnimistPet', 'SummonAnimistFnF', 'Charm', 'SummonMinion', 'Bomber']) {
                expect(kit([ofType(type)])).toEqual({ main: false, fnf: false, window: false });
            }
            expect(kit([])).toEqual({ main: false, fnf: false, window: false });
        });

        test('a window pet up: petControl orders it, except a shade\'s or a turret', () => {
            expect(kit([ofType('Charm')], { pet: {} }).window).toBe(true);
            expect(kit([], { pet: {} }).window).toBe(true);
            expect(kit([ofType('SummonNecroPet')], { pet: {}, isShade: true }).window).toBe(false);
            expect(kit([ofType('SummonAnimistPet')], { pet: {} }).window).toBe(false);
            expect(withPets(pve.nuker, kit([ofType('SummonAnimistPet')], { pet: {} }))).toBe(pve.nuker);
        });
    });
});

describe('a character\'s say in its pet (Character.pet)', () => {
    const ofType = (type: string) => { for (let id = 1; id < 60_000; id++) if (getSpell(id)?.type === type) return id; throw new Error(`no spell of type ${type}`); };
    const sdkKnowing = (type: string, pet: Partial<PetState> | null = null) => {
        const id = ofType(type);
        const spell = { name: getSpell(id)!.name, internalId: id, level: 20, lineName: '', lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 } as Spell;
        return { getSkills: () => ({ spells: [spell] }), getPlayer: () => ({ mana: 500 }), getPetState: () => pet } as unknown as BotSDK;
    };
    const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
    const nuker = () => defaultBehaviors().nuker;

    test('pet: false, no kit: its list is the role\'s, whatever it knows, and an Enchanter beside it keeps hers', () => {
        expect(memberPetKit(sdkKnowing('SummonDruidPet'), bot, { pet: false })).toBeNull();
        const list = nuker();
        expect(withPets(list, memberPetKit(sdkKnowing('SummonDruidPet'), bot, { pet: false }))).toBe(list);
        expect(withPets(list, memberPetKit(sdkKnowing('SummonUnderhill'), bot, null)).map(b => b.name)).toContain('summonPet');
        expect(withPets(list, memberPetKit(sdkKnowing('SummonUnderhill'), bot, {})).map(b => b.name)).toContain('summonPet');
    });

    test('nor a pet up from an earlier script: petControl leaves it, as with pet.enabled false', () => {
        expect(memberPetKit(sdkKnowing('Charm', {}), bot, { pet: false })).toBeNull();
    });

    test('a kit with no floor is petKit\'s', () => {
        expect(memberPetKit(sdkKnowing('SummonTheurgistPet'), bot, null)).toEqual({ main: false, fnf: true, window: false });
    });

    describe('fnfFloor: a Theurgist\'s kit binds his pets too (thrifty wraps only assist)', () => {
        const AIR = pick({ name: 'Summon Aged Ice Spirit', type: 'SummonTheurgistPet', target: 'Enemy', power: -12, range: 2000 });
        const casts = async (kit: PetKit | null, manaPercent: number, settings = PVE_SETTINGS) => {
            const fnf = withPets(nuker(), kit).find(b => b.name === 'fnfPet')!;
            const w = world({ pet: null, fnf: AIR, contacts: [held({ hp: 90, lossSince: Date.now() - 3000, lossFromHp: 100 })], orders: { focus: FOCUS }, player: { mana: manaPercent * 10, manaPercent }, settings });
            await fnf.run(w.ctx);
            return w.calls.summon.length;
        };
        const kit = (saveBelow?: number) => memberPetKit(sdkKnowing('SummonTheurgistPet'), bot, theurgist(saveBelow === undefined ? {} : { saveBelow }));

        test('at 39 % with the kit on: no pet, as no nuke', async () => {
            expect(await casts(kit(), 39)).toBe(0);
            expect(await casts(kit(), 40)).toBe(1);
        });

        test('saveBelow moves it', async () => {
            expect(await casts(kit(30), 29)).toBe(0);
            expect(await casts(kit(30), 30)).toBe(1);
        });

        test('no kit: pet.fnfFloor alone, as ever', async () => {
            expect(await casts(memberPetKit(sdkKnowing('SummonTheurgistPet'), bot, null), 20)).toBe(1);
            expect(await casts(memberPetKit(sdkKnowing('SummonTheurgistPet'), bot, null), 19)).toBe(0);
        });

        test('the higher of the two: a run can still take pets off (--pet.fnfFloor=101), and the kit can\'t lower the run\'s', async () => {
            const high = { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, fnfFloor: 50 } };
            expect(await casts(kit(), 45, high)).toBe(0);
            expect(await casts(kit(), 50, high)).toBe(1);
        });

        test('the role and the fight of the kit are as they were', () => {
            expect(theurgist().role).toBe('nuker');
            // The kit's own additions after it (offFocus, Albion class session) are the kit's business; assist stays its fight.
            expect(theurgist().fight!.map(b => b.name)[0]).toBe('assist');
            expect(theurgist().pet).toEqual({ fnfFloor: 40 });
        });
    });
});

describe('every killNpc in the group leaves the pet to petControl', () => {
    function tankWorld(contacts: Contact[], focus: number, members: MemberReport[] = []) {
        const w = world({ role: 'tank', at: { x: ANCHOR.x, y: ANCHOR.y }, contacts, members, orders: { focus } });
        const kills: { id: number; opts: KillOptions }[] = [];
        (w.ctx.bot as unknown as { killNpc: unknown }).killNpc = async (id: number, opts: KillOptions) => { kills.push({ id, opts }); return { success: true, message: 'Killed' }; };
        (w.ctx as unknown as { note: unknown }).note = () => {};
        return { ...w, kills };
    }

    test('the tank on the focus', async () => {
        const w = tankWorld([held()], FOCUS);
        expect(await tank().run(w.ctx)).toBe(true);
        expect(w.kills.map(k => [k.id, k.opts.usePet])).toEqual([[FOCUS, false]]);
        // How far it may run from where it stood; the next turn takes up the chase from there.
        expect(w.kills[0]!.opts.maxChaseDistance).toBe(3000);
    });

    test('the tank on an add it peels', async () => {
        const healerM = report('Healer', { role: 'healer', regionId: R, x: 10_000, y: 11_500, objectId: 2 });
        const add = mob(60, 5000, { x: 10_000, y: 11_400, target: 'Healer' });
        const w = tankWorld([held(), add], FOCUS, [healerM]);
        expect(await tank().run(w.ctx)).toBe(true);
        expect(w.kills.map(k => [k.id, k.opts.usePet])).toEqual([[60, false]]);
        expect(w.kills[0]!.opts.maxChaseDistance).toBe(3000);
    });
});

describe('waitForSummon: pulls wait for a pet only when asked', () => {
    const member = (over: Partial<MemberReport>) => ({ capabilities: { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], pet: 'main' as const }, pet: null, ...over });

    test('waitsForPet: on, a main pet, none up. Not a Theurgist, not an older runner', () => {
        const on = { ...PET_SETTINGS, waitForSummon: true };
        expect(waitsForPet(member({}), on)).toBe(true);
        expect(waitsForPet(member({}), { waitForSummon: 'true' as unknown as boolean })).toBe(true);
        expect(waitsForPet(member({}), PET_SETTINGS)).toBe(false);
        expect(waitsForPet(member({}), { waitForSummon: 'false' as unknown as boolean })).toBe(false);
        expect(waitsForPet(member({}), undefined)).toBe(false);
        expect(waitsForPet(member({ pet: undefined }), on)).toBe(false);
        expect(waitsForPet(member({ capabilities: { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], pet: 'fnf' } }), on)).toBe(false);
    });

    test('decidePve: recover with why "pet" while it is on, and pulling goes on otherwise', () => {
        const base = { x: 5000, y: 5000, z: 0 };
        const members = [report('Tank', { role: 'tank', regionId: 1, x: base.x, y: base.y }), report('Hrafna', { role: 'nuker', regionId: 1, x: base.x, y: base.y, capabilities: { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], pet: 'main' }, pet: null })];
        const decide = (settings: typeof PVE_SETTINGS) => decidePve({ picture: picture(members), orders: picture(members).orders, memory: { camp: { ...base, zone: '', count: 0, names: 'x' }, campLevel: 6, base }, settings, now: Date.now(), windingDown: false });
        const on = decide({ ...PVE_SETTINGS, pet: { ...PET_SETTINGS, waitForSummon: true } });
        expect(on).toMatchObject({ phase: 'recover', waiting: [{ name: 'Hrafna', why: 'pet' }] });
        expect(on.reason).toContain('Hrafna\'s pet');
        expect(decide(PVE_SETTINGS).waiting ?? []).toEqual([]);
    });
});

describe('pet.enabled false: the group has no pets', () => {
    const SUMMON_ID = (() => { for (let id = 1; id < 60_000; id++) if (getSpell(id)?.type === 'SummonHunterPet') return id; throw new Error('no such spell'); })();
    const OFF = { ...PET_SETTINGS, enabled: false };
    const OFF_TEXT = { ...PET_SETTINGS, enabled: 'false' as unknown as boolean };
    const HOLD = { waitForSummon: true };

    /** What a member's agent reports with these settings: a Hunter's spell list, a summon and no nuke, heal or cc. */
    const agentReport = (settings: unknown) => {
        const state = makeState({ gameMessages: [], pet: null });
        const spell = { name: getSpell(SUMMON_ID)!.name, internalId: SUMMON_ID, level: 20, lineName: '', lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 } as Spell;
        const sdk = { getState: () => state, getPlayer: () => state.player, getSkills: () => ({ spells: [spell] }), getGameMessages: () => state.gameMessages, onStateUpdate: () => () => {} } as unknown as BotSDK;
        const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
        const board = new Blackboard();
        const agent = new MemberAgent({ bot: 'hunter', role: 'melee', sdk, actions: bot }, board, [], settings);
        const r = board.picture().members[0]!;
        agent.dispose();
        return r;
    };

    test('petsAllowed: from the settings, a flag\'s text too; no settings, and on by default', () => {
        expect(petsAllowed({ pet: OFF })).toBe(false);
        expect(petsAllowed({ pet: OFF_TEXT })).toBe(false);
        expect(petsAllowed({ pet: PET_SETTINGS })).toBe(true);
        expect(petsAllowed({ pet: { enabled: 'true' } })).toBe(true);
        expect(petsAllowed({ pet: {} })).toBe(true);
        expect(petsAllowed({})).toBe(true);
        expect(petsAllowed(undefined)).toBe(true);
    });

    test('a character with pet: false reports none either, with the others of the group going on with theirs', () => {
        const state = makeState({ gameMessages: [], pet: null });
        const spell = { name: getSpell(SUMMON_ID)!.name, internalId: SUMMON_ID, level: 20, lineName: '', lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 } as Spell;
        const sdk = { getState: () => state, getPlayer: () => state.player, getSkills: () => ({ spells: [spell] }), getGameMessages: () => state.gameMessages, onStateUpdate: () => () => {} } as unknown as BotSDK;
        const bot = { getSpellInfo: (s: Spell) => getSpell(s.internalId) ?? null } as unknown as BotActions;
        const board = new Blackboard();
        const agent = new MemberAgent({ bot: 'hunter', role: 'melee', sdk, actions: bot, character: { pet: false } }, board, [], { pet: PET_SETTINGS });
        expect(board.picture().members[0]!.capabilities.pet).toBeNull();
        agent.dispose();
        expect(agentReport({ pet: PET_SETTINGS }).capabilities.pet).toBe('main');
    });

    test('a member reports no pet to keep up, whatever its spell list: the agent says so, with the rest of what it can do as it was', () => {
        expect(agentReport({ pet: PET_SETTINGS }).capabilities.pet).toBe('main');
        expect(agentReport({}).capabilities.pet).toBe('main');
        for (const pet of [OFF, OFF_TEXT]) {
            const can = agentReport({ pet }).capabilities;
            expect(can.pet).toBeNull();
            expect(can).toEqual({ ...agentReport({}).capabilities, pet: null });
        }
    });

    test('waitsForPet: never with it off, whatever waitForSummon says', () => {
        const m = { capabilities: { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], pet: 'main' as const }, pet: null };
        expect(waitsForPet(m, { ...OFF, ...HOLD })).toBe(false);
        expect(waitsForPet(m, { ...OFF_TEXT, waitForSummon: 'true' as unknown as boolean })).toBe(false);
        expect(waitsForPet(m, HOLD)).toBe(true);
    });

    const base = { x: 5000, y: 5000, z: 0 };
    const hunterGroup = (settings: unknown, over: Partial<MemberReport> = {}) => {
        const { capabilities, pet } = agentReport(settings);
        return [report('Tank', { role: 'tank', regionId: 1, x: base.x, y: base.y }), report('Hunter', { role: 'melee', regionId: 1, x: base.x, y: base.y, capabilities, pet, ...over })];
    };
    const pve = (settings: typeof PVE_SETTINGS, members: MemberReport[]) => decidePve({ picture: picture(members), orders: picture(members).orders, memory: { camp: { ...base, zone: '', count: 0, names: 'x' }, campLevel: 6, base }, settings, now: Date.now(), windingDown: false });

    test('decidePve holds no pull for its pet, with waitForSummon on', () => {
        const s = { ...PVE_SETTINGS, pet: { ...OFF, ...HOLD } };
        expect(pve(s, hunterGroup(s)).waiting ?? []).toEqual([]);
        // The same member with pets on: held.
        const on = { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, ...HOLD } };
        expect(pve(on, hunterGroup(on)).waiting).toEqual([{ name: 'Hunter', why: 'pet' }]);
        // Its report as of before the switch, from the same picture.
        expect(pve(s, hunterGroup(on)).waiting ?? []).toEqual([]);
    });

    test('nor for the power of a member whose only spell is the summon it won\'t cast', () => {
        const off = { ...PVE_SETTINGS, pet: OFF };
        expect(pve(off, hunterGroup(off, { mana: 10 })).waiting ?? []).toEqual([]);
        expect(pve(PVE_SETTINGS, hunterGroup(PVE_SETTINGS, { mana: 10 })).waiting).toEqual([{ name: 'Hunter', why: 'power' }]);
    });

    test('decideRvr the same', () => {
        const rvr = (settings: typeof RVR_SETTINGS, members: MemberReport[]) => decideRvr({ picture: picture(members), orders: picture(members).orders, memory: {}, settings: { ...settings, patrol: [{ x: 9000, y: 9000, z: 0 }] }, now: Date.now(), windingDown: false }).waiting ?? [];
        const off = { ...RVR_SETTINGS, pet: { ...OFF, ...HOLD } };
        expect(rvr(off, hunterGroup(off, { mana: 10 }))).toEqual([]);
        const on = { ...RVR_SETTINGS, pet: { ...PET_SETTINGS, ...HOLD } };
        expect(rvr(on, hunterGroup(on, { mana: 10 }))).toEqual([{ name: 'Hunter', why: 'power' }, { name: 'Hunter', why: 'pet' }]);
    });

    test('decideRvr names the summon\'s gate as decidePve does: rest\'s detail "pet: saving power" is what holds the group', () => {
        const settings = { ...RVR_SETTINGS, pet: PET_SETTINGS, patrol: [{ x: 9000, y: 9000, z: 0 }] };
        const members = hunterGroup(settings, { activity: { kind: 'rest', targetId: null, detail: SAVING_POWER, since: 0 }, mana: 20 });
        const d = decideRvr({ picture: picture(members), orders: picture(members).orders, memory: {}, settings, now: Date.now(), windingDown: false });
        expect(d.waiting).toEqual([{ name: 'Hunter', why: 'pet power' }]);
        expect(d.reason).toContain("Hunter's pet power");
    });

    test('the observer has no pet to report, over two minutes of none up: no table, no row, no pet-down', () => {
        const run = (settings: unknown) => {
            const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: 1_000_000 });
            const r = agentReport(settings);
            for (let i = 1; i <= 120; i++) o.sample(picture([r], [], { seq: 1, phase: 'recover' }, 1_000_000 + i * 1000));
            return o.report();
        };
        const off = run({ pet: OFF_TEXT });
        expect(Object.values(off.members)[0]!.pet).toBeUndefined();
        expect(off.findings.map(f => f.topic)).not.toContain('pet-down');
        expect(formatReport(off)).not.toContain('## Pets');
        // With it on the same member is a pet-down: what the switch turns off.
        const on = run({ pet: PET_SETTINGS });
        expect(on.findings.map(f => f.topic)).toContain('pet-down');
        expect(formatReport(on)).toContain('## Pets');
    });
});

describe('petAfterRun: what the end of a run owes a pet', () => {
    const sdkWith = (pet: Partial<PetState> | null) => {
        const sent: PetCommand[] = [];
        return { sent, sdk: { getPetState: () => (pet ? { objectId: PET, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null, ...pet } as PetState : null), sendPetCommand: async (c: PetCommand) => { sent.push(c); return { success: true, message: '' }; } } };
    };

    test('it follows, and a passive petControl ordered is lifted first: nothing else lifts it, and a solo killNpc orders no passive pet', async () => {
        const w = sdkWith({ aggression: 'passive' });
        await petAfterRun(w.sdk, new Map([['petOrder:stance', { command: 'passive', at: Date.now() }]]));
        expect(w.sent).toEqual(['defensive', 'follow']);
    });

    test('also with the window not showing that passive yet', async () => {
        const w = sdkWith({ aggression: 'defensive' });
        await petAfterRun(w.sdk, new Map([['petOrder:stance', { command: 'passive', at: Date.now() }]]));
        expect(w.sent).toEqual(['defensive', 'follow']);
    });

    test('a stance that came back already, or that it never touched (a shade\'s, one from an earlier script): follow alone', async () => {
        const back = sdkWith({});
        await petAfterRun(back.sdk, new Map([['petOrder:stance', { command: 'defensive', at: Date.now() }]]));
        expect(back.sent).toEqual(['follow']);
        const never = sdkWith({ aggression: 'passive' });
        await petAfterRun(never.sdk, new Map());
        expect(never.sent).toEqual(['follow']);
        const noAgent = sdkWith({ aggression: 'passive' });
        await petAfterRun(noAgent.sdk, undefined);
        expect(noAgent.sent).toEqual(['follow']);
    });

    test('no pet: nothing', async () => {
        const w = sdkWith(null);
        await petAfterRun(w.sdk, new Map([['petOrder:stance', { command: 'passive', at: Date.now() }]]));
        expect(w.sent).toEqual([]);
    });
});

describe('petControl on the side tick: what its select may disturb', () => {
    const casting = (over: Partial<CombatEvent> = {}): CombatEvent => ({ id: 5, kind: 'spellCast', attackerObjectId: ME, targetObjectId: null, castTimeMs: 3000, receivedAt: Date.now() - 500, ...over });

    test('it is marked side, on the list by name as before', () => {
        expect(petControl().side).toBe(true);
        expect(withPets(defaultBehaviors().tank, { main: true }).find(b => b.name === 'petControl')?.side).toBe(true);
    });

    test('in our own cast the order goes when its target is selected already: a tank\'s killNpc has the focus', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, combatEvents: [casting()], player: { targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('a turn on the focus, or a walk: it goes. "its turn nuke Lesser Bones to Dust from +2.5 to +14.3 (walk in from 2400, then a 3 s cast)"', async () => {
        for (const turn of [{ kind: 'nuke', targetId: FOCUS }, { kind: 'melee', targetId: FOCUS }, { kind: 'move', targetId: FOCUS }, { kind: 'move', targetId: null }, { kind: 'flee', targetId: null }]) {
            const w = world({ contacts: [held()], orders: { focus: FOCUS }, turn });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        }
    });

    test('a turn on another target: its cast would land on the focus, its swing move there. The order waits; stance and walk orders go', async () => {
        for (const turn of [{ kind: 'heal', targetId: 3 }, { kind: 'cc', targetId: 52 }, { kind: 'melee', targetId: 52 }, { kind: 'buff', targetId: null }, { kind: 'guard', targetId: null }]) {
            const w = world({ contacts: [held(), mob(52)], orders: { focus: FOCUS }, turn });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
            const lifted = world({ contacts: [held(), mob(52)], orders: { focus: FOCUS }, turn, pet: { aggression: 'passive' } });
            await petControl().run(lifted.ctx);
            expect(lifted.sent).toEqual([{ command: 'defensive' }]);
            const off = world({ contacts: [held({ cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 9000 } }), mob(52)], orders: { focus: FOCUS }, turn, pet: { targetObjectId: FOCUS } });
            await petControl().run(off.ctx);
            expect(off.sent).toEqual([{ command: 'follow' }]);
        }
    });

    test('swinging at something else between two turns: it waits too; at the focus it goes', async () => {
        const away = world({ contacts: [held(), mob(52)], orders: { focus: FOCUS }, player: { attacking: true, targetObjectId: 52 } });
        await petControl().run(away.ctx);
        expect(away.sent).toEqual([]);
        const on = world({ contacts: [held()], orders: { focus: FOCUS }, player: { attacking: true, targetObjectId: FOCUS } });
        await petControl().run(on.ctx);
        expect(on.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('our own cc on the way to the pet\'s target counts as cc on it: called off, no order onto it', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, turn: { kind: 'cc', targetId: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'follow' }]);
    });
});

describe('petControl: a tank\'s or puller\'s own pet', () => {
    // Run 165641: '16:57:23.473 The water beetle hits your head for 27 damage!', '16:57:23.506 Your wolf cub attacks the water beetle and hits for 9 damage!', no 'You command' line.
    const TANK = { role: 'tank' as const };
    const ahead = contact(FOCUS, { regionId: R, x: 10_300, y: 10_000 });
    const onOwner = (ms: number, over: Partial<Contact> = {}) => mob(FOCUS, ms, { target: 'Owner', ...over });

    test('passive through its own pull: unasked it would answer the first hit on its owner', async () => {
        const w = world({ ...TANK, contacts: [ahead], orders: { phase: 'pull', focus: FOCUS, puller: 'Owner' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'passive' }]);
        // And it stays so.
        w.state.pet!.aggression = 'passive';
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(1);
    });

    test('another member\'s pull leaves its stance alone', async () => {
        const w = world({ contacts: [ahead], orders: { phase: 'pull', focus: FOCUS, puller: 'Tank' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('in the fight: passive until pet.holdMs after the mob named the tank; then the attack order lifts it', async () => {
        const early = world({ ...TANK, contacts: [onOwner(500)], orders: { focus: FOCUS } });
        await petControl().run(early.ctx);
        expect(early.sent).toEqual([{ command: 'passive' }]);
        const late = world({ ...TANK, contacts: [onOwner(1600)], orders: { focus: FOCUS }, pet: { aggression: 'passive' } });
        await petControl().run(late.ctx);
        expect(late.sent).toEqual([{ command: 'defensive' }, { command: 'attack', target: FOCUS }]);
    });

    test('or after our first swing on the focus, with the mob on someone else; a swing from before the engage order is a carried pull\'s and doesn\'t count', async () => {
        const now = Date.now();
        const swing = (ago: number): CombatEvent => ({ id: 3, kind: 'melee', attackerObjectId: ME, targetObjectId: FOCUS, receivedAt: now - ago, result: 'hit' });
        const onHealer = mob(FOCUS, 3000, { target: 'Healer', engagedAt: now - 3000 });
        const none = world({ ...TANK, contacts: [onHealer], orders: { focus: FOCUS } });
        await petControl().run(none.ctx);
        expect(none.sent).toEqual([{ command: 'passive' }]);
        const soon = world({ ...TANK, contacts: [onHealer], orders: { focus: FOCUS }, combatEvents: [swing(500)] });
        await petControl().run(soon.ctx);
        expect(soon.sent).toEqual([{ command: 'passive' }]);
        const held2 = world({ ...TANK, contacts: [onHealer], orders: { focus: FOCUS }, combatEvents: [swing(1600)] });
        await petControl().run(held2.ctx);
        expect(held2.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        const carried = world({ ...TANK, contacts: [mob(FOCUS, 3000, { target: 'Healer', engagedAt: now - 1000 })], orders: { focus: FOCUS }, combatEvents: [swing(5000)] });
        await petControl().run(carried.ctx);
        expect(carried.sent).toEqual([{ command: 'passive' }]);
    });

    test('the mob already on this pet: passive wouldn\'t shed it (live), so no passive, and the order at once', async () => {
        const onPet = () => mob(FOCUS, 1000, { target: null, targetPet: 'Owner' });
        const w = world({ ...TANK, contacts: [onPet()], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        // In the pull it took: the coordinator makes that an engage on its next tick. Nothing meanwhile, a follow included.
        const pull = world({ ...TANK, contacts: [onPet()], orders: { phase: 'pull', focus: FOCUS, puller: 'Owner' }, pet: { targetObjectId: FOCUS } });
        await petControl().run(pull.ctx);
        expect(pull.sent).toEqual([]);
    });

    test('a reading on this pet not yet a snapshot old is a groupmate\'s client naming the pet for a blow it took: no lift, no order. The board corrects it when the owner\'s line is in', async () => {
        // A blow at the owner, intercepted: every client's 0xBC names the pet (WeaponAction.cs:366-367), and only the owner gets the line (AttackComponent.cs:1900). spiritmaster-melee: 'a blow on us reads as on the pet (a7c 14.34)'.
        const w = world({ ...TANK, contacts: [mob(FOCUS, 100, { target: null, targetPet: 'Owner' })], orders: { focus: FOCUS }, pet: { aggression: 'passive' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('nor is a defensive pet turned passive on one: if it is a mob that took it, that would only break its fight off for the order half a second later', async () => {
        const w = world({ ...TANK, contacts: [mob(FOCUS, 100, { target: null, targetPet: 'Owner' })], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('a pet with its order in force stays on it when the mob moves on to the tank inside the hold: no attack, passive, defensive, attack', async () => {
        const w = world({ ...TANK, contacts: [mob(FOCUS, 1000, { target: null, targetPet: 'Owner' })], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        // The tank's first swing turned it: the new target restarts targetSince, so the hold reads as not done (blackboard.ts, holdState).
        w.sent.length = 0;
        w.pic.contacts[0] = mob(FOCUS, 100, { target: 'Owner' });
        w.state.pet!.targetObjectId = FOCUS;
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
        // And the same with the pet on its way, reading no target just after the order.
        w.state.pet!.targetObjectId = null;
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('that goes for this order only: one on another mob, or a pet answering by itself, is still held back', async () => {
        const other = world({ ...TANK, contacts: [mob(FOCUS, 100, { target: 'Owner' })], orders: { focus: FOCUS }, pet: { targetObjectId: 77 } });
        other.ctx.memory.set('petAttack', { id: 77, at: Date.now(), seen: -1, answered: true });
        await petControl().run(other.ctx);
        expect(other.sent).toContainEqual({ command: 'passive' });
        const unasked = world({ ...TANK, contacts: [mob(FOCUS, 100, { target: 'Owner' })], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(unasked.ctx);
        expect(unasked.sent).toContainEqual({ command: 'passive' });
    });

    test('a puller who isn\'t the tank: the same through its pull and the fight that pull became', async () => {
        const w = world({ contacts: [ahead], orders: { phase: 'pull', focus: FOCUS, puller: 'Owner' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'passive' }]);
        w.state.pet!.aggression = 'passive';
        w.pic.orders.phase = 'engage';
        w.pic.orders.puller = null;
        w.pic.contacts[0] = mob(FOCUS, 100, { target: 'Owner' });
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(1);
    });

    test('nobody else\'s pet is held so: another member\'s stays defensive and waits for its order', async () => {
        const w = world({ contacts: [mob(FOCUS, 500)], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    test('no hold to wait for: pet.holdMs 0, an enemy player, an enemy pet', async () => {
        const zero = world({ ...TANK, contacts: [onOwner(100)], orders: { focus: FOCUS }, settings: { ...PVE_SETTINGS, pet: { ...PET_SETTINGS, holdMs: 0 } } });
        await petControl().run(zero.ctx);
        expect(zero.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        const player = world({ ...TANK, contacts: [enemy(FOCUS, 'albion', { regionId: R, x: 10_300, y: 10_000, threat: true })], orders: { focus: FOCUS } });
        await petControl().run(player.ctx);
        expect(player.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        const pet = world({ ...TANK, contacts: [mob(FOCUS, 100, { isPet: true, target: null })], orders: { focus: FOCUS } });
        await petControl().run(pet.ctx);
        expect(pet.sent).toEqual([]);
    });

    test('after the fight: defensive again', async () => {
        const w = world({ ...TANK, orders: { phase: 'recover', focus: null }, pet: { aggression: 'passive' } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'defensive' }]);
    });
});

describe('holdState: a mob on a pet', () => {
    const NOW = 1_000_000;
    const at = (over: Partial<Contact>) => ({ target: null, targetPet: null, targetSince: NOW - 2000, movedAt: 0, engagedAt: 0, hostileSince: NOW - 2000, ...over });

    test('on the tank\'s own pet: as if on the tank, from when it read so', () => {
        expect(holdState(at({ targetPet: 'Tank' }), 'Tank', 1500, 6000, NOW).held).toBe(true);
        expect(holdState(at({ targetPet: 'Tank', targetSince: NOW - 1000 }), 'Tank', 1500, 6000, NOW).held).toBe(false);
    });

    test('on another member\'s: held once it has read on that pet for holdMs. "first nuke: Petenc 6.1 s", with the mob on the pet from the start', () => {
        expect(holdState(at({ targetPet: 'Petenc' }), 'Tank', 1500, 6000, NOW)).toEqual({ held: true, dueAt: NOW - 500 });
        expect(holdState(at({ targetPet: 'Petenc', targetSince: NOW - 1000 }), 'Tank', 1500, 6000, NOW).held).toBe(false);
    });

    test('on nobody or on another member: as before, assistAfterMs', () => {
        expect(holdState(at({}), 'Tank', 1500, 6000, NOW).held).toBe(false);
        expect(holdState(at({ target: 'Healer', hostileSince: NOW - 6100 }), 'Tank', 1500, 6000, NOW).held).toBe(true);
        expect(holdState(at({ target: 'Healer' }), 'Tank', 1500, 6000, NOW).held).toBe(false);
    });

    test('a carried pull still counts from the engage order', () => {
        expect(holdState(at({ targetPet: 'Tank', movedAt: NOW - 3000, engagedAt: NOW - 500 }), 'Tank', 1500, 6000, NOW).held).toBe(false);
    });
});

describe('summonPet: threats, not the phase', () => {
    const SUMMON = pick({ name: 'Summon Spirit Fighter', power: -25, target: 'Self', range: 0, castTime: 6 });
    const casts = async (o: WorldOptions) => { const w = world({ pet: null, summon: SUMMON, ...o }); await summonPet().run(w.ctx); return w.calls.summon.length; };

    test('a roam\'s walk to a passive mob is an engage with no threat: it summons. "Petdru lost bear cub (died)", no summon for 51 s', async () => {
        expect(await casts({ orders: { phase: 'engage', focus: FOCUS }, contacts: [contact(FOCUS, { regionId: R, x: 10_300, y: 10_000 })] })).toBe(1);
    });

    test('a hostile focus or a threat near us: no', async () => {
        expect(await casts({ orders: { phase: 'engage', focus: FOCUS }, contacts: [held()] })).toBe(0);
        expect(await casts({ orders: { phase: 'recover', focus: null }, contacts: [mob(77)] })).toBe(0);
    });

    test('nothing hostile within 2500 of us: the group\'s fight doesn\'t count. "Petcab died 16:13:19.9, released; no summon up to the run\'s end"', async () => {
        const fight = { orders: { phase: 'engage' as const, focus: FOCUS }, contacts: [held()] };
        expect(await casts({ ...fight, at: { x: 10_000 + 25_000, y: 10_000 } })).toBe(1);
        expect(await casts({ ...fight, at: { x: 12_900, y: 10_000 } })).toBe(1);
        expect(await casts({ ...fight, at: { x: 12_900, y: 10_000 }, player: { mana: 100, manaPercent: 10 } })).toBe(0);
        expect(await casts({ ...fight, at: { x: 12_900, y: 10_000 }, contacts: [held(), mob(77, 5000, { x: 12_800 })] })).toBe(0);
    });

    test('still not: running away, and our own pull', async () => {
        expect(await casts({ orders: { phase: 'retreat', focus: null } })).toBe(0);
        expect(await casts({ orders: { phase: 'pull', focus: FOCUS, puller: 'Owner' } })).toBe(0);
    });

    test('off the map, or within a pet\'s step of its edge: skipped with a reason. A summon there kicks the player (SummonSpellHandler.cs:77)', async () => {
        // 'Calling KickPlayerToCharScreen with (... name=Petenc ... loc=286364,648697,4854 ...)': Shannon Estuary starts at x 286720.
        const off = world({ pet: null, summon: SUMMON, orders: { phase: 'recover', focus: null }, region: 200, at: { x: 286_364, y: 648_697 } });
        expect(await summonPet().run(off.ctx)).toBe(false);
        expect(off.calls.summon).toEqual([]);
        expect(off.skips).toEqual(['pet: off the map, no summon']);
        const edge = world({ pet: null, summon: SUMMON, orders: { phase: 'recover', focus: null }, region: 200, at: { x: 286_740, y: 648_697 } });
        await summonPet().run(edge.ctx);
        expect(edge.calls.summon).toEqual([]);
        const inside = world({ pet: null, summon: SUMMON, orders: { phase: 'recover', focus: null }, region: 200, at: { x: 287_881, y: 650_172 } });
        await summonPet().run(inside.ctx);
        expect(inside.calls.summon.length).toBe(1);
    });

    test('it stands above position and the fight: those take every turn of a walk back', () => {
        const names = (list: Behavior[]) => list.map(b => b.name);
        const nuker = names(withPets(defaultBehaviors().nuker, { main: true }));
        expect(nuker.indexOf('summonPet')).toBeLessThan(nuker.indexOf('position'));
        const melee = names(withPets(defaultBehaviors().melee, { main: true }));
        expect(melee.indexOf('summonPet')).toBeLessThan(melee.indexOf('assistMelee'));
        const tankList = names(withPets(defaultBehaviors().tank, { main: true }));
        expect(tankList.indexOf('summonPet')).toBeLessThan(tankList.indexOf('tank'));
    });

    describe('with rejoinFight on the list: it takes every turn of the walk back, and at the end of it the fight is too near for a summon', () => {
        const inRvr = (o: WorldOptions) => {
            const w = world({ pet: null, summon: SUMMON, orders: { phase: 'engage', anchor: ANCHOR, focus: FOCUS }, ...o });
            const list = withPets(rvrBehaviors().nuker as Behavior[], { main: true }) as Behavior<TacticsSettings>[];
            return { w, onTheWay: list.find(b => b.name === 'summonOnTheWayBack')!, list: list.map(b => b.name) };
        };

        test('a release far off: the summon goes before the walk', async () => {
            const { w, onTheWay, list } = inRvr({ at: { x: ANCHOR.x + 25_000, y: ANCHOR.y } });
            expect(list.indexOf('summonOnTheWayBack')).toBeLessThan(list.indexOf('rejoinFight'));
            expect(await onTheWay.run(w.ctx)).toBe(true);
            expect(w.calls.summon.length).toBe(1);
        });

        test('near the fight it has no say: a rez and the heals stay above summonPet', async () => {
            const { w, onTheWay, list } = inRvr({ at: { x: ANCHOR.x + 3000, y: ANCHOR.y } });
            expect(await onTheWay.run(w.ctx)).toBe(false);
            expect(w.calls.summon).toEqual([]);
            expect(list.indexOf('rez')).toBeLessThan(list.indexOf('summonPet'));
            expect(list.indexOf('emergencyHeal')).toBeLessThan(list.indexOf('summonPet'));
        });

        test('its gate still holds on the way: an enemy near us, or short of power', async () => {
            const hostile = inRvr({ at: { x: ANCHOR.x + 25_000, y: ANCHOR.y }, contacts: [mob(77, 200, { x: ANCHOR.x + 25_100, y: ANCHOR.y, threat: true })] });
            expect(await hostile.onTheWay.run(hostile.w.ctx)).toBe(false);
            expect(hostile.w.calls.summon).toEqual([]);
            const poor = inRvr({ at: { x: ANCHOR.x + 25_000, y: ANCHOR.y }, player: { mana: 100, manaPercent: 10 } });
            expect(await poor.onTheWay.run(poor.w.ctx)).toBe(false);
            expect(poor.w.skips).toEqual(['pet: saving power']);
        });

        test('a list with no rejoinFight has no such entry', () => {
            expect(withPets(defaultBehaviors().nuker, { main: true }).some(b => b.name === 'summonOnTheWayBack')).toBe(false);
        });
    });
});

describe('"pet: saving power" is seen', () => {
    test('in rest\'s activity detail while the summon is what it waits for; a plain rest says nothing', async () => {
        const saving = world({ orders: { phase: 'recover', focus: null }, player: { mana: 100, manaPercent: 10 } });
        saving.ctx.memory.set(REST_MANA_UP_TO, 30);
        await rest().run(saving.ctx);
        expect(saving.doing).toEqual([{ kind: 'rest', targetId: null, detail: 'pet: saving power' }]);
        const plain = world({ orders: { phase: 'recover', focus: null }, player: { mana: 100, manaPercent: 10 } });
        await rest().run(plain.ctx);
        expect(plain.doing).toEqual([{ kind: 'rest', targetId: null, detail: '' }]);
    });
});

describe('petHeal: a Realm heal, and the reading after a heal', () => {
    const MEND = pick({ name: 'Mend Simulacrum', type: 'Heal', power: 4, range: 2000 });
    const REALM = pick({ name: 'Major Resurgance', type: 'Heal', target: 'Realm', power: 8, range: 2000 });

    test('a heal with no Pet target goes at the pet\'s id: "petHeal null", with \'Major Resurgance type=Heal tgt=Realm\'', async () => {
        const w = world({ petHeal: REALM, petEntry: { healthPercent: 24 }, orders: { focus: FOCUS }, contacts: [held()] });
        expect(await petHeal().run(w.ctx)).toBe(true);
        expect(w.calls.cast).toEqual([[REALM.spell, PET]]);
    });

    test('Spellbook.petHeal: Pet-target first, else a single-target Realm or Group heal; capabilities().heal doesn\'t count on it', () => {
        const info: Record<string, Partial<SpellInfo>> = {
            'Patch Simulacrum': { type: 'Heal', target: 'Pet', power: 4, value: 40 },
            'Major Resurgance': { type: 'Heal', target: 'Realm', power: 8, value: 80 },
            'Group Mend': { type: 'Heal', target: 'Group', power: 8, value: 30, radius: 350 },
            'Song of Mending': { type: 'Heal', target: 'Realm', power: 0, value: 30, pulse: 1, frequency: 50 },
        };
        const book = (names: string[]) => new Spellbook(
            { getSkills: () => ({ spells: names.map((name, i) => ({ name, level: 10, lineIndex: 0, spellIndex: i, cooldownRemaining: 0 })) }), getPlayer: () => ({ mana: 500, maxHealth: 100 }) } as unknown as BotSDK,
            { getSpellInfo: (s: Spell) => ({ range: 2000, radius: 0, castTime: 3, duration: 0, concentration: 0, ...info[s.name] }) } as unknown as BotActions,
        );
        expect(book(['Major Resurgance', 'Patch Simulacrum']).petHeal()?.spell.name).toBe('Patch Simulacrum');
        expect(book(['Major Resurgance']).petHeal()?.spell.name).toBe('Major Resurgance');
        expect(book(['Group Mend', 'Song of Mending']).petHeal()).toBeNull();
        expect(book(['Patch Simulacrum']).capabilities().heal).toBe(false);
    });

    test('after a landed heal it waits for the reading to change, or 1 s. "16:35:15.132 You cast a Patch Simulacrum spell!", "16:35:15.333 You begin casting", "16:35:15.736 PETHP 67" (was 41)', async () => {
        const w = world({ petHeal: MEND, petEntry: { healthPercent: 41 }, orders: { focus: FOCUS }, contacts: [held()] });
        expect(await petHeal().run(w.ctx)).toBe(true);
        expect(await petHeal().run(w.ctx)).toBe(false);
        expect(w.calls.cast.length).toBe(1);
        w.ctx.memory.get('petHealLanded').at -= 1100;
        expect(await petHeal().run(w.ctx)).toBe(true);
        expect(w.calls.cast.length).toBe(2);
    });

    test('a new reading ends the wait at once: still below the line, the next one goes', async () => {
        let hp = 20;
        const w = world({ petHeal: MEND, petEntry: { get healthPercent() { return hp; } }, orders: { focus: FOCUS }, contacts: [held()] });
        await petHeal().run(w.ctx);
        hp = 40;
        expect(await petHeal().run(w.ctx)).toBe(true);
    });

    test('"The ruby simulacrum is fully healed.": no more on the old reading, for longer than the 1 s', async () => {
        const w = world({ petHeal: MEND, petEntry: { healthPercent: 41, name: 'ruby simulacrum' }, orders: { focus: FOCUS }, contacts: [held()], castSpell: () => ({ messages: [makeMessage(9, 'The ruby simulacrum is fully healed.')] }) });
        await petHeal().run(w.ctx);
        w.ctx.memory.get('petHealLanded').at -= 1100;
        expect(await petHeal().run(w.ctx)).toBe(false);
        w.ctx.memory.get('petHealLanded').at -= 2000;
        expect(await petHeal().run(w.ctx)).toBe(true);
    });

    test('the same line after the cast came back, with the wait on: it counts', async () => {
        const w = world({ petHeal: MEND, petEntry: { healthPercent: 41, name: 'ruby simulacrum' }, orders: { focus: FOCUS }, contacts: [held()] });
        await petHeal().run(w.ctx);
        w.state.gameMessages.push(makeMessage(9, 'The ruby simulacrum is fully healed.', { receivedAt: Date.now() }));
        w.ctx.memory.get('petHealLanded').at -= 1100;
        expect(await petHeal().run(w.ctx)).toBe(false);
    });
});

describe('assist: a nuke out of range walks a step and comes back to the list', () => {
    const NUKE = pick({ name: 'Lesser Bones to Dust', type: 'DirectDamage', target: 'Enemy', power: 5, range: 1500, castTime: 3 });
    // 20261103-163415: pet 49 % at 16:35:35, activity 'nuke Lesser Bones to Dust' for 15 s; 'You begin casting' 16:35:49.7 (pet 9 %).
    const far = { x: 13_000, y: 10_000 };
    const nukeWorld = (o: WorldOptions = {}) => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, at: far, ...o });
        (w.ctx as unknown as { spells: { nuke: () => SpellPick } }).spells.nuke = () => NUKE;
        (w.ctx.settings as TacticsSettings).combatRange ??= {};
        return w;
    };

    test('beyond its range: a walk, no cast; the walk is bounded, so what is above it on the list gets its turn', async () => {
        const w = nukeWorld();
        expect(await assist().run(w.ctx)).toBe(true);
        expect(w.calls.cast).toEqual([]);
        expect(w.calls.walk.length).toBe(1);
        expect((w.calls.walk[0]![1] as { timeout: number }).timeout).toBeLessThanOrEqual(3000);
        expect(w.doing).toEqual([{ kind: 'move', targetId: FOCUS, detail: 'into range for Lesser Bones to Dust' }]);
    });

    test('in range: the cast at once, no walk', async () => {
        const w = nukeWorld({ at: { x: 11_000, y: 10_000 } });
        expect(await assist().run(w.ctx)).toBe(true);
        expect(w.calls.walk).toEqual([]);
        expect(w.calls.cast.length).toBe(1);
    });
});

describe('petBuff: during another member\'s pull', () => {
    const buffs = [{ ...pick({ name: 'Strengthen Spirit', type: 'StrengthBuff', power: 2, range: 1000, duration: 1200, icon: 811 }), slot: 'str' }];

    test('with no threat it goes: "icons=[4702]" through three runs at full power, in gather -> pull -> engage', async () => {
        expect(await petBuff().run(world({ orders: { phase: 'pull', focus: FOCUS, puller: 'Tank' }, petBuffs: buffs }).ctx)).toBe(true);
    });

    test('not in our own pull, and not with a threat', async () => {
        expect(await petBuff().run(world({ orders: { phase: 'pull', focus: FOCUS, puller: 'Owner' }, petBuffs: buffs }).ctx)).toBe(false);
        expect(await petBuff().run(world({ orders: { phase: 'pull', focus: FOCUS, puller: 'Tank' }, contacts: [held()], petBuffs: buffs }).ctx)).toBe(false);
    });
});

describe('petBuffAtStart: one while the group walks', () => {
    const buffs = ['Strengthen Spirit', 'Quicken Spirit', 'Toughen Spirit'].map((name, i) => ({ ...pick({ name, type: 'StrengthBuff', power: 2, range: 1000, duration: 1200, icon: 811 + i }), slot: name }));

    // r19on-r21on Rbcab: four at +13, +16, +19, +22 s, 900 behind the group at the first engage, its first order 4.5 s later, no gain seen.
    test('in travel the first goes and the next waits; in a quiet phase the rest go', async () => {
        const w = world({ orders: { phase: 'travel', focus: null }, petBuffs: buffs });
        const b = petBuffAtStart();
        expect(await b.run(w.ctx)).toBe(true);
        expect(await b.run(w.ctx)).toBe(false);
        w.pic.orders.phase = 'gather';
        expect(await b.run(w.ctx)).toBe(true);
    });
});

describe('petAfterRun: a turret and a shade\'s pet are left alone', () => {
    test('"You command the forest\'s servant to follow you!" at the run\'s end: not any more', async () => {
        const sent: PetCommand[] = [];
        const sdk = { getPetState: () => ({ objectId: PET, aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null }) as PetState, sendPetCommand: async (c: PetCommand) => { sent.push(c); return { success: true, message: '' }; } };
        await petAfterRun(sdk, new Map(), true);
        expect(sent).toEqual([]);
        await petAfterRun(sdk, new Map(), false);
        expect(sent).toEqual(['follow']);
    });
});

describe('crowdControl: an NPC under 75 %', () => {
    // CCSpellHandler.cs:174-178. a6: "'Your target is enraged and resists the spell!', and again at :25.575, :28.808, :32.036, :35.472, :38.716 with the add at 68-63 %. Six casts at 5 power each of 57."
    const MEZZ = { ...pick({ name: 'Mesmerization', type: 'Mesmerize', target: 'Enemy', power: 5, range: 1500, castTime: 3, duration: 30, value: 0 }), kind: 'mezz' as const };
    const ROOT = { ...pick({ name: 'Webbing Vines', type: 'SpeedDecrease', target: 'Enemy', power: 5, range: 1500, castTime: 2, duration: 30, value: 99 }), kind: 'root' as const };
    const ADD = 52;
    const ccWorld = (add: Contact, spell: unknown, o: WorldOptions = {}) => {
        const w = world({ contacts: [held(), add], orders: { focus: FOCUS, cc: [] }, ...o });
        (w.ctx as unknown as { spells: { cc: (opts?: { except?: string[] }) => unknown } }).spells.cc = opts => (opts?.except?.includes((spell as { kind: string }).kind) ? null : spell);
        return w;
    };
    const add = (hp: number) => mob(ADD, 5000, { target: 'Owner', hp, threat: true });

    test('a free add under it isn\'t taken by a mezz: the power goes, and nothing can land', async () => {
        const w = ccWorld(add(74), MEZZ);
        expect(await crowdControl().run(w.ctx)).toBe(false);
        expect(w.calls.cast).toEqual([]);
    });

    test('at 75 it is', async () => {
        const w = ccWorld(add(75), MEZZ);
        (w.ctx as unknown as { markCc: () => void }).markCc = () => {};
        await crowdControl().run(w.ctx);
        expect(w.calls.cast.length).toBe(1);
    });

    test('an assignment that came before the health fell goes the same way', async () => {
        const w = ccWorld(add(68), MEZZ, { orders: { focus: FOCUS, cc: [{ targetId: ADD, by: 'Owner' }] } });
        expect(await crowdControl({ assignedOnly: true }).run(w.ctx)).toBe(false);
        expect(w.calls.cast).toEqual([]);
    });

    test('a member with both takes the root to it: the mezz would only cost the power', async () => {
        const w = ccWorld(add(70), MEZZ);
        (w.ctx as unknown as { spells: { root: () => unknown } }).spells.root = () => ROOT;
        const marks: unknown[][] = [];
        (w.ctx as unknown as { markCc: (...a: unknown[]) => void }).markCc = (...a) => { marks.push(a); };
        expect(await crowdControl().run(w.ctx)).toBe(true);
        expect(w.calls.cast[0]).toEqual([ROOT.spell, ADD, { approach: false }]);
        expect(marks[0]![1]).toBe('root');
    });

    test('with its assignment on such an add too, and at 75 or more the mezz all the same', async () => {
        const w = ccWorld(add(70), MEZZ, { orders: { focus: FOCUS, cc: [{ targetId: ADD, by: 'Owner' }] } });
        (w.ctx as unknown as { spells: { root: () => unknown } }).spells.root = () => ROOT;
        (w.ctx as unknown as { markCc: () => void }).markCc = () => {};
        await crowdControl({ assignedOnly: true }).run(w.ctx);
        expect(w.calls.cast[0]).toEqual([ROOT.spell, ADD, { approach: false }]);
        const whole = ccWorld(add(80), MEZZ);
        (whole.ctx as unknown as { spells: { root: () => unknown } }).spells.root = () => ROOT;
        (whole.ctx as unknown as { markCc: () => void }).markCc = () => {};
        await crowdControl().run(whole.ctx);
        expect(whole.calls.cast[0]).toEqual([MEZZ.spell, ADD, { approach: false }]);
    });

    test('a root has no such floor, and a player none', async () => {
        const root = ccWorld(add(40), ROOT);
        (root.ctx as unknown as { markCc: () => void }).markCc = () => {};
        await crowdControl().run(root.ctx);
        expect(root.calls.cast.length).toBe(1);
        const player = ccWorld(mob(ADD, 5000, { kind: 'player', target: 'Owner', hp: 40, threat: true }), MEZZ);
        (player.ctx as unknown as { markCc: () => void }).markCc = () => {};
        await crowdControl().run(player.ctx);
        expect(player.calls.cast.length).toBe(1);
    });

    test('the line itself, for one that fell during the cast: as effectImmune, left alone by us and marked for the other mezzers', async () => {
        const w = ccWorld(add(76), MEZZ, { castSpell: () => ({ effectImmune: true, resisted: false }) as never });
        const marked: unknown[] = [];
        (w.ctx as unknown as { markCcImmune: (id: number, kind: string, ms: number) => void }).markCcImmune = (id, kind, ms) => {
            marked.push([id, kind, ms]);
            w.ctx.contact(id)!.ccImmune = { [kind]: Date.now() + ms };
        };
        await crowdControl().run(w.ctx);
        expect(marked).toEqual([[ADD, 'mezz', 60_000]]);
        await crowdControl().run(w.ctx);
        expect(w.calls.cast.length).toBe(1);
    });
});

describe('buffRetryMs: a follow-up', () => {
    test('it isn\'t a failed cast: what the server holds, not the 60 s of a failure or the 8 s of a "You must wait"', () => {
        const waited = buffRetryMs({ success: false, reason: 'must_wait', message: 'You are already casting a spell! You prepare this spell as a follow up!', retryAfterMs: 1200, followUpMs: 3000 });
        expect(waited).toBeGreaterThanOrEqual(4200);
        expect(waited).toBeLessThan(8000);
        expect(buffRetryMs({ success: false, reason: 'must_wait', message: 'You must wait 2 seconds to cast a spell!', retryAfterMs: 2000 })).toBe(8000);
        expect(buffRetryMs({ success: false, reason: 'no_response' })).toBe(60_000);
    });
});

describe('crowdControl: our own pet comes off first', () => {
    const ROOT = { ...pick({ name: 'Webbing Vines', type: 'SpeedDecrease', target: 'Enemy', power: 5, range: 1500, castTime: 2, duration: 30, value: 99 }), kind: 'root' as const };
    const ccWorld = (add: Contact, o: WorldOptions = {}) => {
        const w = world({ contacts: [held(), add], orders: { focus: FOCUS, cc: [{ targetId: add.objectId, by: 'Owner' }] }, ...o });
        (w.ctx as unknown as { spells: { cc: () => unknown } }).spells.cc = () => ROOT;
        (w.ctx as unknown as { markCc: () => void }).markCc = () => {};
        return w;
    };
    const ADD = 52;

    test('on that target: a follow before the cast. "root lands 16:36:00.307, Your wolf cub attacks the water beetle and hits for 11 damage! 16:36:00.505, You command the wolf cub to follow you! 16:36:00.738"', async () => {
        const w = ccWorld(mob(ADD, 5000, { target: 'Owner' }), { pet: { targetObjectId: ADD } });
        let atCast: unknown[] = [];
        (w.ctx.bot as unknown as { castSpell: () => Promise<unknown> }).castSpell = async () => { atCast = [...w.sent]; return { success: true, message: 'Cast', resisted: false }; };
        await crowdControl({ assignedOnly: true }).run(w.ctx);
        expect(atCast).toEqual([{ command: 'follow' }]);
    });

    test('with the mob on the pet: passive too, or it hits back. "The water beetle hits your wolf cub" 16:36:21.271, "Your wolf cub attacks" 16:36:21.304', async () => {
        const w = ccWorld(mob(ADD, 5000, { target: null, targetPet: 'Owner' }), { pet: { targetObjectId: ADD } });
        let atCast: unknown[] = [];
        (w.ctx.bot as unknown as { castSpell: () => Promise<unknown> }).castSpell = async () => { atCast = [...w.sent]; return { success: true, message: 'Cast', resisted: false }; };
        await crowdControl({ assignedOnly: true }).run(w.ctx);
        expect(atCast).toEqual([{ command: 'passive' }, { command: 'follow' }]);
    });

    test('on something else, or no pet: nothing', async () => {
        const other = ccWorld(mob(ADD, 5000, { target: 'Owner' }), { pet: { targetObjectId: FOCUS } });
        await crowdControl({ assignedOnly: true }).run(other.ctx);
        expect(other.sent).toEqual([]);
        const none = ccWorld(mob(ADD, 5000, { target: 'Owner' }), { pet: null });
        await crowdControl({ assignedOnly: true }).run(none.ctx);
        expect(none.sent).toEqual([]);
    });

    test('a parked pet stays parked; a turret is left alone', async () => {
        const parked = ccWorld(mob(ADD, 5000, { target: 'Owner' }), { pet: { targetObjectId: ADD, walk: 'stay' } });
        await crowdControl({ assignedOnly: true }).run(parked.ctx);
        expect(parked.sent).toEqual([{ command: 'stay' }]);
        const turret = ccWorld(mob(ADD, 5000, { target: 'Owner' }), { pet: { targetObjectId: ADD }, turret: true });
        await crowdControl({ assignedOnly: true }).run(turret.ctx);
        expect(turret.sent).toEqual([]);
    });

    test('petControl keeps a pet passive while a cc\'d mob is on it, until there is an order for it', async () => {
        const w = world({ contacts: [mob(ADD, 5000, { target: null, targetPet: 'Owner', cc: { by: 'Owner', kind: 'root', until: Date.now() + 9000 } })], orders: { focus: null } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'passive' }]);
        const go = world({ contacts: [held(), mob(ADD, 5000, { target: null, targetPet: 'Owner', cc: { by: 'Owner', kind: 'root', until: Date.now() + 9000 } })], orders: { focus: FOCUS }, pet: { aggression: 'passive' } });
        await petControl().run(go.ctx);
        expect(go.sent).toEqual([{ command: 'defensive' }, { command: 'attack', target: FOCUS }]);
    });

    describe('a focus to go for, and its order held back: passive stays, or the mob on it is hit back in ~33 ms and the root breaks', () => {
        // Run 163503: root 16:36:00.307, the pet's swing .505, its follow .738. 'The water beetle hits your wolf cub' 16:36:21.271, 'Your wolf cub attacks' 16:36:21.304.
        const onPet = (cc?: Contact['cc']) => mob(ADD, 5000, { target: null, targetPet: 'Owner', ...(cc ? { cc } : {}) });
        const rooted = { by: 'Druid', kind: 'root', until: Date.now() + 9000 };

        test('through our own cc cast: selectFree keeps the order back while the turn is on the add', async () => {
            const w = world({ contacts: [held(), onPet()], orders: { focus: FOCUS }, turn: { kind: 'cc', targetId: ADD }, pet: { aggression: 'passive', targetObjectId: null } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
        });

        test('through a heal turn, with another member\'s root on the add', async () => {
            const w = world({ contacts: [held(), onPet(rooted)], orders: { focus: FOCUS }, turn: { kind: 'heal', targetId: 3 }, pet: { aggression: 'passive' } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
        });

        test('with the focus out of the order\'s 2000', async () => {
            const far = held({ x: OWNER_AT.x + 2500, y: OWNER_AT.y });
            const w = world({ contacts: [far, onPet(rooted)], orders: { focus: FOCUS }, pet: { aggression: 'passive' } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
        });

        test('from defensive it turns passive for it, as it would with no focus at all', async () => {
            const w = world({ contacts: [held(), onPet()], orders: { focus: FOCUS }, turn: { kind: 'cc', targetId: ADD } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'passive' }]);
        });

        test('a pet already on the focus stays there: passive would break that fight off at every heal turn (ControlledMobBrain.cs:199-203)', async () => {
            const w = world({ contacts: [held(), onPet(rooted)], orders: { focus: FOCUS }, turn: { kind: 'heal', targetId: 3 }, pet: { targetObjectId: FOCUS } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
        });

        test('and so does one on its way there, reading no target just after the order', async () => {
            const w = world({ contacts: [held(), onPet(rooted)], orders: { focus: FOCUS }, turn: { kind: 'heal', targetId: 3 } });
            w.ctx.memory.set('petAttack', { id: FOCUS, at: Date.now(), seen: -1, answered: false });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([]);
        });

        test('the turn over, the order goes and lifts it', async () => {
            const w = world({ contacts: [held(), onPet(rooted)], orders: { focus: FOCUS }, pet: { aggression: 'passive' } });
            await petControl().run(w.ctx);
            expect(w.sent).toEqual([{ command: 'defensive' }, { command: 'attack', target: FOCUS }]);
        });
    });
});

describe('petControl: a rooted focus', () => {
    const ADD = 52;
    const root = () => ({ cc: { by: 'Druid', kind: 'root', until: Date.now() + 20_000 } });
    const mezz = () => ({ cc: { by: 'Bard', kind: 'mezz', until: Date.now() + 20_000 } });
    const celt = (over: Partial<Contact> = {}) => enemy(FOCUS, 'hibernia', { regionId: R, x: 10_300, y: 10_000, threat: true, ...over });

    // Run 20261103-174453: root at +4.2, "first order on Celt at +32.3".
    test('all that\'s left in the fight: the order goes', async () => {
        const w = world({ contacts: [celt(root())], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });

    test('a pet already on it stays on it', async () => {
        const w = world({ contacts: [celt(root())], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
    });

    // User, live in Thidranki: with every enemy mezzed the group stood by them. The coordinator picks one off (pack.ts, decideRvr), the pet with the others.
    // A melee bot opens on a mezz with a style first (cc-opener.ts, user 2026-11-14): with the Tank there, the pet waits for
    // its swing, which breaks the mezz, and the order goes then. A pet already on it comes back: its next swing would break it first.
    test('a mezz: the pet waits for the Tank\'s opener; on it already, it is called back', async () => {
        const w = world({ contacts: [celt(mezz())], orders: { focus: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([]);
        const on = world({ contacts: [celt(mezz())], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(on.ctx);
        expect(on.sent).toEqual([{ command: 'follow' }]);
    });

    test('a mezz with something else free in the fight, no: called off', async () => {
        const w = world({ contacts: [celt(mezz()), mob(ADD, 5000)], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'follow' }]);
    });

    test('a root with something else free in the fight, no', async () => {
        const w = world({ contacts: [celt(root()), mob(ADD, 5000)], orders: { focus: FOCUS }, pet: { targetObjectId: FOCUS } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'follow' }]);
    });

    test('a rooted add beside the focus stays off limits', async () => {
        const w = world({ contacts: [held(), mob(ADD, 5000, root())], orders: { focus: FOCUS }, pet: { targetObjectId: ADD } });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
    });
});

describe('petControl: the answer to an attack order', () => {
    const ordered = async (o: WorldOptions = {}) => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS }, ...o });
        await petControl().run(w.ctx);
        expect(w.sent).toEqual([{ command: 'attack', target: FOCUS }]);
        return w;
    };
    const says = (w: ReturnType<typeof world>, text: string) => { w.state.gameMessages.push(makeMessage(w.state.gameMessages.length + 1, text, { receivedAt: Date.now() })); };

    test('nothing is recorded at the send: that says only that it went out. "petAttack (6)", each answered "You can\'t attack a shadowed necromancer!", Failures none', async () => {
        const w = await ordered();
        expect(w.results).toEqual([]);
    });

    test('"You command" is the success', async () => {
        const w = await ordered();
        says(w, 'You command the skeletal commander to kill your target!');
        await petControl().run(w.ctx);
        expect(w.results).toEqual([{ kind: 'petAttack', success: true, reason: undefined, targetId: FOCUS }]);
        // Once.
        await petControl().run(w.ctx);
        expect(w.results.length).toBe(1);
    });

    test('a refusal goes through ctx.result with its reason, and backs off for its time: 2 s for "immune", else the flat 3 s', async () => {
        const w = await ordered();
        says(w, 'Petani is temporarily immune to PvP attacks!');
        (w.ctx.memory.get('petAttack') as { at: number }).at -= 2500;
        await petControl().run(w.ctx);
        expect(w.results).toEqual([{ kind: 'petAttack', success: false, reason: 'immune', targetId: FOCUS }]);
        expect(w.sent.length).toBe(1);
        (w.ctx.memory.get('petAttack') as { until: number }).until -= 2100;
        await petControl().run(w.ctx);
        expect(w.sent.length).toBe(2);
        const shade = await ordered();
        says(shade, "You can't attack a shadowed necromancer!");
        await petControl().run(shade.ctx);
        expect(shade.results).toEqual([{ kind: 'petAttack', success: false, reason: 'not_attackable', targetId: FOCUS }]);
        (shade.ctx.memory.get('petAttack') as { until: number }).until -= 2900;
        await petControl().run(shade.ctx);
        expect(shade.sent.length).toBe(1);
        (shade.ctx.memory.get('petAttack') as { until: number }).until -= 200;
        await petControl().run(shade.ctx);
        expect(shade.sent.length).toBe(2);
    });

    test('a line from before the order is no answer', async () => {
        const w = await ordered({ messages: [makeMessage(1, "You can't attack a shadowed necromancer!")] });
        await petControl().run(w.ctx);
        expect(w.results).toEqual([]);
    });

    test('no answer at all (a dead target and a peace flag get none): no_response, unless the target went', async () => {
        const w = await ordered();
        (w.ctx.memory.get('petAttack') as { at: number }).at -= 2100;
        await petControl().run(w.ctx);
        expect(w.results).toEqual([{ kind: 'petAttack', success: false, reason: 'no_response', targetId: FOCUS }]);
        const gone = await ordered();
        gone.pic.contacts.length = 0;
        (gone.ctx.memory.get('petAttack') as { at: number }).at -= 2100;
        await petControl().run(gone.ctx);
        expect(gone.results).toEqual([]);
    });

    test('a send that failed reports at once', async () => {
        const w = world({ contacts: [held()], orders: { focus: FOCUS } });
        (w.ctx.sdk as unknown as { sendPetCommand: () => Promise<unknown> }).sendPetCommand = async () => ({ success: false, reason: 'not_connected', message: 'no' });
        await petControl().run(w.ctx);
        expect(w.results).toEqual([{ kind: 'petAttack', success: false, reason: 'not_connected', targetId: FOCUS }]);
    });

    describe('an accepted order to a pet that stands', () => {
        // imm1 +11.3: 'You command the skeletal commander to kill your target!', window t 427, pet distance 75-100, not moving; the server has dropped the order as the immunity began (ControlledMobBrain.cs:528-542).
        const accepted = async (o: WorldOptions = {}) => {
            const w = await ordered(o);
            says(w, 'You command the skeletal commander to kill your target!');
            w.state.pet!.targetObjectId = FOCUS;
            await petControl().run(w.ctx);
            return w;
        };
        const later = (w: ReturnType<typeof world>, ms: number) => { const a = w.ctx.memory.get('petAttack') as { at: number; acceptedAt: number; gapAt: number }; a.at -= ms; a.acceptedAt -= ms; a.gapAt -= ms; };

        test('5 s not closing with no hit landed: sent once more, once', async () => {
            const w = await accepted();
            await petControl().run(w.ctx);
            expect(w.sent.length).toBe(1);
            later(w, 4900);
            await petControl().run(w.ctx);
            expect(w.sent.length).toBe(1);
            later(w, 200);
            await petControl().run(w.ctx);
            expect(w.sent.length).toBe(2);
            says(w, 'You command the skeletal commander to kill your target!');
            await petControl().run(w.ctx);
            later(w, 5100);
            await petControl().run(w.ctx);
            expect(w.sent.length).toBe(2);
        });

        test('a pet still closing resets the clock', async () => {
            let y = 9000;
            const w = await accepted({ petEntry: { get y() { return y; }, x: 10_300 } });
            later(w, 5100);
            y = 9500;
            await petControl().run(w.ctx);
            expect(w.sent.length).toBe(1);
        });

        test('a hit in the last 5 s: it is fighting', async () => {
            const now = Date.now();
            const w = await accepted({ combatEvents: [{ id: 8, kind: 'melee', attackerObjectId: PET, targetObjectId: FOCUS, receivedAt: now, result: 'hit' }] });
            later(w, 5100);
            await petControl().run(w.ctx);
            expect(w.sent.length).toBe(1);
        });
    });
});

describe('settings', () => {
    test('both default strategies carry the defaults, and they leave waiting for a summon off', () => {
        expect(PVE_SETTINGS.pet).toEqual(PET_SETTINGS);
        expect(RVR_SETTINGS.pet).toEqual(PET_SETTINGS);
        expect(PET_SETTINGS).toEqual({ enabled: true, summonMana: 30, healBelow: 50, fnfFloor: 20, fnfLifeMs: 10_000, waitForSummon: false });
    });
});

describe('a long pull-back ends where it stands once the puller\'s pet has gone in', () => {
    // a2: 'pull lake serpent L11 (con 1) 1354 away' at Pethun hp69, hits 04:36:12.869 37, 15.885 40, 18.898 35, 21.913 40, 'Pethun: walk: died (Died en route to (718359, 778447))'. The nukers waited on phase pull.
    const base = { x: 10_000, y: 10_000, z: 0 };
    const pulling = { seq: 1, phase: 'pull' as const, focus: 7, puller: 'Tank', anchor: base, facing: null, reason: 'pull' };
    const decide = (pet: Partial<NonNullable<MemberReport['pet']>> | null, now = Date.now()) => {
        const tank = report('Tank', { role: 'tank', regionId: R, objectId: 3, x: 11_300, y: 10_000, pet: pet && { objectId: PET, name: 'hunter\'s pet', level: 7, x: 11_300, y: 10_000, z: 0, hp: 90, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [], ...pet } });
        const p = picture([tank, report('Nuke', { regionId: R, objectId: 4, x: base.x, y: base.y })], [contact(7, { regionId: R, x: 11_350, y: 10_000, threat: true, target: 'Tank', targetSince: now - 3000, hostileSince: now - 3000 })], pulling, now);
        return decidePve({ picture: p, orders: p.orders, memory: { camp: { ...base, zone: '', count: 0, names: 'x' }, campLevel: 6, base, pullStart: now - 3000 }, settings: PVE_SETTINGS, now, windingDown: false });
    };

    test('no pet, or one that hasn\'t gone: he brings it home', () => {
        expect(decide(null).phase).toBe('pull');
        expect(decide({ targetId: null, aggression: 'passive' }).phase).toBe('pull');
    });

    test('his pet on it: the fight starts here, for the nukers too', () => {
        expect(decide({ targetId: 7 })).toMatchObject({ phase: 'engage', focus: 7, puller: null });
    });

    test('a pet parked on stay that answered a blow is left to petControl\'s call-off: that\'s no going in', () => {
        expect(decide({ targetId: 7, walk: 'stay' }).phase).toBe('pull');
    });
});
