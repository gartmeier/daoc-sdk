// Observed members (observed.ts): a group member with no member agent, such as a human. What the board makes of the
// bots' clients' view of it, how the behaviours put it first, the group files that name it, and that nothing changes
// for a group without one (the equivalence block at the end).
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BotWorldState, CombatEvent, GroupMember, NearbyPlayer } from '../types';
import { assist, formationSlot, guard, heal, healOrder, leftTo, rez, rezOrder, tank, type TacticsSettings } from './behaviors';
import { Blackboard, observeState, type Observation } from './blackboard';
import { planBuffs } from './buffs';
import { contact, enemy, obs, picture, report, sighting } from './fixtures';
import type { MemberContext } from './member';
import { finishedBy, groupmatesOf, LEAVE_BELOW, ObservedMembers, observedRole, OUT_OF_SIGHT, type Groupmate } from './observed';
import { decidePve, PVE_SETTINGS, type PveSettings } from './pve';
import { loadGroup, observedEntriesProblem } from './roster';
import { columnOrder } from './pack';
import { mezzMelee } from './tactics/peel';
import { ctx as tacticsCtx, engage, foe as tacticsFoe, team } from './tactics/fixtures';
import type { BuffSpell, Contact, MemberReport, Orders, Point, Role } from './types';

const R = 9999;
const ANCHOR = { x: 10_000, y: 10_000, z: 0 };
const SETTINGS: TacticsSettings = { ...PVE_SETTINGS, chaseLeash: 2000 };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** A human in the group as the board reports it. */
const human = (over: Partial<MemberReport> = {}) => report('Vue', { bot: '', role: 'melee', className: 'Armsman', objectId: 77, regionId: R, x: 10_100, y: 10_000, activity: { kind: 'observed', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, rez: false, buffs: [], buffSpells: [], pet: null }, observed: true, ...over });

// ── a bot's client: the window, the entry in view, the combat it sees ──

function windowEntry(name: string, over: Partial<GroupMember> = {}): GroupMember {
    return { name, className: 'Armsman', level: 24, objectId: 77, healthPercent: 80, manaPercent: 0, endurancePercent: 90, isDead: false, inOtherRegion: false, ...over };
}

function inView(name: string, over: Partial<NearbyPlayer> = {}): NearbyPlayer {
    return { kind: 'player', objectId: 77, name, x: 10_100, y: 10_000, z: 0, heading: 0, distance: 100, distance2d: 100, lastSeenAgo: 2000, sessionId: 0, guildName: '', lastName: '', level: 24, realm: 'albion', healthPercent: 80, isDead: false, isSitting: false, inCombat: false, ...over } as NearbyPlayer;
}

function state(over: Partial<BotWorldState> = {}): BotWorldState {
    const now = Date.now();
    return {
        inGame: true, timestamp: now, player: { name: 'Tank', objectId: 1, regionId: R, x: 10_000, y: 10_000, z: 0, heading: 0, realm: 'albion', className: 'Armsman', level: 24, experience: 0, realmPoints: 0, healthPercent: 100, maxHealth: 500, manaPercent: 100, endurancePercent: 100, isDead: false, isSitting: false, inCombat: false, attacking: false, targetObjectId: null },
        nearbyNpcs: [], nearbyPlayers: [], combatEvents: [], gameMessages: [], effects: [], group: [], concentrationEffects: [], pet: null, summons: [],
        ...over,
    } as unknown as BotWorldState;
}

const SELF = { bot: 'tank', role: 'tank' as Role, activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } };

describe('groupmatesOf: what one client knows of an observed member', () => {
    test('the window gives health, power, dead; the entry in view where it stands; its swings what it fights', () => {
        const s = state({ group: [windowEntry('Tank', { objectId: 1 }), windowEntry('Vue')], nearbyPlayers: [inView('Vue')] });
        const [g, ...rest] = groupmatesOf(s, ['vue'], new Map([[77, { targetId: 500, at: s.timestamp - 1000 }]]));
        expect(rest).toEqual([]);
        expect(g).toMatchObject({ name: 'Vue', className: 'Armsman', objectId: 77, hp: 80, endurance: 90, isDead: false, aim: { targetId: 500 } });
        // The snapshot's time, not the entry's last move: a human standing still is still there.
        expect(g!.seen).toEqual({ regionId: R, x: 10_100, y: 10_000, z: 0, inCombat: false, isSitting: false, at: s.timestamp });
    });

    test('not in view: no position; an old aim: none; our own entry and names not asked for: left out', () => {
        const s = state({ group: [windowEntry('Tank', { objectId: 1 }), windowEntry('Vue'), windowEntry('Other', { objectId: 78 })] });
        const g = groupmatesOf(s, ['Vue', 'Tank'], new Map([[77, { targetId: 500, at: s.timestamp - 7000 }]]));
        expect(g.map(x => x.name)).toEqual(['Vue']);
        expect(g[0]!.seen).toBeUndefined();
        expect(g[0]!.aim).toBeUndefined();
    });

    test('our concentration buffs on it, by their full names (the list cuts them to 12 and ..)', () => {
        const s = state({ group: [windowEntry('Vue')], concentrationEffects: [{ index: 0, name: 'Strength of t..', ownerName: 'Vue', concentration: 5, icon: 1 }, { index: 1, name: 'Armor', ownerName: 'Cleric', concentration: 5, icon: 2 }] });
        expect(groupmatesOf(s, ['Vue'], new Map(), ['Strength of the Ox'])[0]!.buffs).toEqual(['Strength of the Ox']);
    });

    test('its own pet: the nearest pet of our realm near it, not ours, not a foe’s, and on the report while fresh', () => {
        const npc = (objectId: number, x: number, over: Record<string, unknown> = {}) => ({ kind: 'npc', objectId, name: 'bwca', x, y: 10_000, z: 0, realm: 'albion', isPet: true, healthPercent: 100, ...over });
        const s = state({
            group: [windowEntry('Tank', { objectId: 1 }), windowEntry('Vue')], nearbyPlayers: [inView('Vue')],
            pet: { objectId: 5 } as BotWorldState['pet'],
            nearbyNpcs: [npc(5, 10_120), npc(6, 10_300), npc(7, 10_150, { realm: 'midgard' }), npc(8, 10_140, { isPet: false }), npc(9, 11_000)] as unknown as BotWorldState['nearbyNpcs'],
        });
        const [g] = groupmatesOf(s, ['Vue'], new Map());
        expect(g!.pet).toMatchObject({ objectId: 6, name: 'bwca', x: 10_300 });
        expect(groupmatesOf(state({ group: [windowEntry('Vue')], nearbyNpcs: s.nearbyNpcs }), ['Vue'], new Map())[0]!.pet).toBeUndefined();
        const m = new ObservedMembers([{ name: 'Vue' }]);
        m.merge('Tank', [g!], s.timestamp);
        expect(m.reports(s.timestamp)[0]!.observedPet).toEqual({ objectId: 6, name: 'bwca', x: 10_300, y: 10_000, z: 0 });
        expect(m.reports(s.timestamp + 6000)[0]!.observedPet).toBeUndefined();
    });
});

describe('observeState: observed members only when asked', () => {
    test('a swing of the human at a mob is its aim; the observation carries groupmates', () => {
        const now = Date.now();
        const swing: CombatEvent = { id: 1, kind: 'melee', attackerObjectId: 77, targetObjectId: 500, result: 'hit', receivedAt: now - 500 };
        const s = state({ timestamp: now, group: [windowEntry('Vue')], nearbyPlayers: [inView('Vue')], combatEvents: [swing] });
        const o = observeState(s, { ...SELF, observed: ['Vue'] })!;
        expect(o.groupmates?.[0]?.aim).toEqual({ targetId: 500, at: now - 500 });
    });

    test('with none asked for the observation has no groupmates key at all', () => {
        const s = state({ group: [windowEntry('Vue')], nearbyPlayers: [inView('Vue')] });
        expect('groupmates' in observeState(s, SELF)!).toBe(false);
        expect('groupmates' in observeState(s, { ...SELF, observed: [] })!).toBe(false);
    });
});

/** A bot's observation with groupmates. */
function seenBy(name: string, mates: Groupmate[], over: Partial<MemberReport> = {}, sightings = [] as ReturnType<typeof sighting>[]): Observation {
    return { ...obs(report(name, { regionId: R, x: 10_000, y: 10_000, objectId: name.length, ...over }), sightings), groupmates: mates };
}
const mate = (over: Partial<Groupmate> = {}): Groupmate => ({ name: 'Vue', className: 'Armsman', level: 24, objectId: 77, hp: 70, mana: 0, endurance: 100, isDead: false, inOtherRegion: false, seen: { regionId: R, x: 10_100, y: 10_000, z: 0, inCombat: false, isSitting: false, at: Date.now() }, ...over });

describe('Blackboard: the observed member on the picture', () => {
    test('after the bots, marked observed, a tank class read as melee, never given capabilities', () => {
        const board = new Blackboard({ observed: [{ name: 'Vue' }] });
        board.publish(seenBy('Tank', [mate()]));
        board.publish(seenBy('Cleric', [mate()], { role: 'healer' }));
        const p = board.picture();
        expect(p.members.map(m => m.name)).toEqual(['Tank', 'Cleric', 'Vue']);
        const vue = p.members[2]!;
        expect(vue).toMatchObject({ observed: true, bot: '', role: 'melee', className: 'Armsman', hp: 70, regionId: R, x: 10_100, objectId: 77, activity: { kind: 'observed' } });
        expect(vue.capabilities).toMatchObject({ heal: false, cc: false, nuke: false, rez: false, buffSpells: [] });
        expect(observedRole('Armsman')).toBe('melee');
        expect(observedRole('Cleric')).toBe('healer');
        expect(observedRole('Armsman', 'support')).toBe('support');
    });

    test('nothing until a window has shown it; out of everyone\'s view for 5 s it is in no region', () => {
        const board = new Blackboard({ observed: [{ name: 'Vue' }] });
        board.publish(seenBy('Tank', []));
        expect(board.picture().members.map(m => m.name)).toEqual(['Tank']);
        const t0 = Date.now();
        board.publish(seenBy('Tank', [mate({ seen: { regionId: R, x: 10_100, y: 10_000, z: 0, inCombat: false, isSitting: false, at: t0 - 6000 } })]));
        expect(board.picture(t0).members[1]!.regionId).toBe(OUT_OF_SIGHT);
    });

    test('a mob on the human is on the group: its target is the human\'s name, and it is a threat', () => {
        const board = new Blackboard({ observed: [{ name: 'Vue' }] });
        board.publish(seenBy('Tank', [mate()], {}, [sighting(500, { x: 10_150, y: 10_000, targetId: 77, inCombat: true })]));
        const c = board.picture().contacts.find(x => x.objectId === 500)!;
        expect(c.target).toBe('Vue');
        expect(c.threat).toBe(true);
    });

    test('a mob the human hits is the group\'s fight (attacking, targetId from its swings)', () => {
        const board = new Blackboard({ observed: [{ name: 'Vue' }] });
        board.publish(seenBy('Tank', [mate({ aim: { targetId: 500, at: Date.now() } })], {}, [sighting(500, { x: 10_150, y: 10_000 })]));
        const p = board.picture();
        expect(p.members[1]).toMatchObject({ attacking: true, targetId: 500, inCombat: true });
        expect(p.contacts[0]!.threat).toBe(true);
    });

    test('its death is a death event, like a bot\'s', () => {
        const board = new Blackboard({ observed: [{ name: 'Vue' }] });
        board.publish(seenBy('Tank', [mate()]));
        board.publish(seenBy('Tank', [mate({ isDead: true, hp: 0 })]));
        expect(board.events().filter(e => e.kind === 'death').map(e => e.member)).toEqual(['Vue']);
    });

    test('effects: the concentration buffs bots hold on it, until the holder lets go', () => {
        const m = new ObservedMembers([{ name: 'Vue' }]);
        const now = Date.now();
        m.merge('Cleric', [mate({ buffs: ['Blessing of Strength'] })], now);
        m.merge('Friar', [mate({ buffs: ['Holy Armor'] })], now);
        expect(m.reports(now)[0]!.effects.sort()).toEqual(['Blessing of Strength', 'Holy Armor']);
        m.merge('Cleric', [mate()], now);
        expect(m.reports(now)[0]!.effects).toEqual(['Holy Armor']);
    });

    test('a pickup: unseen, it reads at the place until seen after the ask or its time is up', () => {
        const m = new ObservedMembers([{ name: 'Vue' }]);
        const t0 = Date.now();
        const at = (x: number, t: number) => ({ regionId: R, x, y: 10_000, z: 0, inCombat: false, isSitting: false, at: t });
        m.merge('Tank', [mate({ seen: at(10_100, t0) })], t0);
        expect(m.reports(t0 + 10_000)[0]!.regionId).toBe(OUT_OF_SIGHT);
        const pk = { regionId: R, x: 50_000, y: 50_000, z: 300 };
        expect(m.pickup('vue', pk, t0 + 10_000, t0 + 190_000)).toBe(true);
        expect(m.pickup('Nobody', pk, t0 + 10_000, t0 + 190_000)).toBe(false);
        expect(m.reports(t0 + 11_000)[0]).toMatchObject({ regionId: R, x: 50_000, y: 50_000, z: 300 });
        expect(m.pickupsOpen(t0 + 11_000)).toEqual(['Vue']);
        // Seen after the ask: where seen, and the pickup is over (out of sight again reads as ever).
        m.merge('Tank', [mate({ seen: at(49_000, t0 + 20_000) })], t0 + 20_000);
        expect(m.reports(t0 + 20_000)[0]).toMatchObject({ regionId: R, x: 49_000 });
        expect(m.reports(t0 + 40_000)[0]!.regionId).toBe(OUT_OF_SIGHT);
        // Its time up, unseen: out of sight again.
        m.pickup('Vue', pk, t0 + 40_000, t0 + 50_000);
        expect(m.reports(t0 + 45_000)[0]!.x).toBe(50_000);
        expect(m.reports(t0 + 51_000)[0]!.regionId).toBe(OUT_OF_SIGHT);
        // Dead: no pickup.
        m.pickup('Vue', pk, t0 + 60_000, t0 + 200_000);
        m.merge('Tank', [mate({ isDead: true, seen: at(10_100, t0) })], t0 + 61_000);
        expect(m.reports(t0 + 62_000)[0]!.regionId).toBe(OUT_OF_SIGHT);
    });

    test('the bots\' observation asks for its name (observedNames), and none without observed members', () => {
        expect(new Blackboard({ observed: [{ name: 'Vue' }] }).observedNames()).toEqual(['Vue']);
        expect(new Blackboard().observedNames()).toEqual([]);
    });
});

// ── behaviours, on a small stub MemberContext ──

interface Stub { name: string; role: Role; members: MemberReport[]; contacts?: Contact[]; orders?: Partial<Orders>; settings?: TacticsSettings; mana?: number }
function stub(o: Stub) {
    const calls = { castSpell: [] as number[], resurrect: [] as { id: number; opts: any }[], killNpc: [] as number[], killPlayer: [] as number[], attack: [] as number[], target: [] as number[] };
    const skips: string[] = [];
    const me = o.members.find(m => m.name === o.name)!;
    const pic = picture(o.members, o.contacts ?? [], { phase: 'engage', anchor: ANCHOR, facing: { x: ANCHOR.x + 1000, y: ANCHOR.y }, ...o.orders });
    const nearby = (c: Contact) => ({ objectId: c.objectId, name: c.name, x: c.x, y: c.y, z: c.z, heading: 0, distance: dist(c, me), distance2d: dist(c, me), lastSeenAgo: 0, level: c.level, realm: c.realm, healthPercent: c.hp });
    const sdk = {
        getNearbyPlayer: (id: number) => { const c = pic.contacts.find(x => x.objectId === id && x.kind === 'player'); return c ? { ...nearby(c), kind: 'player', isDead: false } : null; },
        getNearbyNpc: (id: number) => { const c = pic.contacts.find(x => x.objectId === id && x.kind === 'npc'); return c ? { ...nearby(c), kind: 'npc', speed: 0, targetObjectId: null } : null; },
        getNearbyPlayers: () => pic.members.map(m => ({ objectId: m.objectId })),
        getObject: (id: number) => { const m = pic.members.find(x => x.objectId === id); return m ? { kind: 'player', isDead: m.isDead } : null; },
        findAbility: (re: RegExp) => (re.test('Guard') ? { name: 'Guard' } : null),
        sendSetTarget: async (id: number) => { calls.target.push(id); return { success: true, message: '' }; },
        sendAttack: async () => ({ success: true, message: '' }),
        getSkills: () => ({ styles: [] }),
        getState: () => ({ effects: [], timestamp: Date.now(), combatEvents: [], equipment: [] }),
    };
    const bot = {
        isDead: () => false,
        castHeldLeftMs: () => 0,
        castSpell: async (_s: unknown, id: number) => { calls.castSpell.push(id); return { success: true, message: 'Cast', completed: true, messages: [] }; },
        resurrect: async (id: number, opts: unknown) => { calls.resurrect.push({ id, opts }); return { success: true, message: 'back' }; },
        killNpc: async (id: number) => { calls.killNpc.push(id); return { success: true, message: 'Killed', killed: true }; },
        killPlayer: async (id: number) => { calls.killPlayer.push(id); return { success: true, message: 'Killed', killed: true }; },
        attack: async (id: number) => { calls.attack.push(id); return { success: true, message: 'attacking' }; },
        useAbility: async () => ({ success: true, message: '', messages: [{ text: 'You are now guarding Vue.' }] }),
        getAttackers: () => [],
        getPlayerAttackers: () => [],
        walkTo: async () => ({ success: true, message: 'arrived' }),
    };
    const ctx = {
        name: o.name, role: o.role, settings: o.settings ?? SETTINGS, memory: new Map<string, any>(), sdk, bot,
        spells: {
            heal: () => ({ spell: { name: 'Minor Healing' }, castTime: 2500 }),
            rez: () => ({ spell: { name: 'Revive' }, range: 1500 }),
            nuke: () => ({ spell: { name: 'Bolt' }, type: 'DirectDamage', range: 1500, castTime: 2500 }),
            capabilities: () => ({ heal: true, nuke: true }),
        },
        me: () => ({ name: o.name, objectId: me.objectId, regionId: me.regionId, x: me.x, y: me.y, z: 0, level: me.level, attacking: false, targetObjectId: null, maxMana: 100, mana: o.mana ?? 100, manaPercent: o.mana ?? 100, healthPercent: 100 }),
        picture: () => pic, orders: () => pic.orders, members: () => pic.members,
        member: (n: string) => pic.members.find(m => m.name === n),
        tank: () => pic.members.find(m => m.role === 'tank' && !m.isDead),
        isTank: () => o.role === 'tank',
        contact: (id: number | null | undefined) => pic.contacts.find(c => c.objectId === id),
        focus: () => pic.contacts.find(c => c.objectId === pic.orders.focus),
        threats: () => pic.contacts.filter(c => c.threat),
        doing: () => {}, finishTurn: () => {}, note: () => {},
        skip: (reason: string) => { skips.push(reason); return false as const; },
        result: () => {},
    } as unknown as MemberContext<TacticsSettings>;
    return { ctx, calls, skips };
}

describe('healers heal the observed member before the bots', () => {
    const cleric = () => report('Cleric', { role: 'healer', regionId: R, x: 10_000, y: 10_000, objectId: 2, level: 24 });
    test('a more hurt bot waits behind it, in a fight and out of one', async () => {
        const nuker = report('Wizard', { role: 'nuker', regionId: R, x: 10_050, y: 10_000, objectId: 3, hp: 45 });
        const s = stub({ name: 'Cleric', role: 'healer', members: [cleric(), nuker, human({ hp: 55 })], contacts: [contact(500, { regionId: R, threat: true })] });
        expect(await heal().run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([77]);
    });
    test('but a bot below the emergency line comes first', async () => {
        const nuker = report('Wizard', { role: 'nuker', regionId: R, x: 10_050, y: 10_000, objectId: 3, hp: 30 });
        const s = stub({ name: 'Cleric', role: 'healer', members: [cleric(), nuker, human({ hp: 55 })], contacts: [contact(500, { regionId: R, threat: true })] });
        expect(await heal().run(s.ctx)).toBe(true);
        expect(s.calls.castSpell).toEqual([3]);
    });
    test('out of sight (no region) it is not healed', async () => {
        const s = stub({ name: 'Cleric', role: 'healer', members: [cleric(), human({ hp: 40, regionId: OUT_OF_SIGHT })], contacts: [contact(500, { regionId: R, threat: true })] });
        expect(await heal().run(s.ctx)).toBe(false);
        expect(s.calls.castSpell).toEqual([]);
    });
});

describe('buffers buff it first', () => {
    const spell = (name: string, slot: BuffSpell['slot']): BuffSpell => ({ name, slot, target: 'Realm', concentration: 5 });
    test('every round of buffs starts with the observed member, before the tank', () => {
        const druid = report('Druid', { role: 'healer', capabilities: { heal: true, cc: false, nuke: false, buffs: [], buffSpells: [spell('Strength', 'str'), spell('Constitution', 'con')] } });
        const tankM = report('Hero', { role: 'tank' });
        const tasks = planBuffs('Druid', [tankM, druid, human({ role: 'melee' })], { needs: { tank: ['str', 'con'], melee: ['str', 'con'], healer: [] } });
        expect(tasks.map(t => `${t.rank}:${t.target}`)).toEqual(['0:Vue', '0:Hero', '1:Vue', '1:Hero']);
    });
    test('a concentration buff a caster holds on it counts as up', () => {
        const druid = report('Druid', { role: 'healer', capabilities: { heal: true, cc: false, nuke: false, buffs: [], buffSpells: [spell('Strength', 'str')] } });
        const [t] = planBuffs('Druid', [druid, human({ effects: ['Strength'] })], { needs: { melee: ['str'], healer: [] } });
        expect(t).toMatchObject({ target: 'Vue', covered: true, ours: true });
    });
    test('its own pet (a charmed bwca) gets the leftover concentration, last, as a member’s window pet does', () => {
        const druid = report('Druid', { role: 'healer', capabilities: { heal: true, cc: false, nuke: false, buffs: [], buffSpells: [spell('Strength', 'str')] } });
        const tasks = planBuffs('Druid', [druid, human({ observedPet: { objectId: 600, name: 'bwca', x: 0, y: 0, z: 0 } })], { needs: { melee: ['str'], healer: [] }, petNeeds: ['str'] });
        expect(tasks.map(t => `${t.target}${t.pet ? `@${t.pet.owner}:${t.pet.objectId}` : ''}`)).toEqual(['Vue', 'bwca@Vue:600']);
        // Some member's window pet after all (the board's view was wrong): not taken twice.
        const owner = report('Ench', { role: 'nuker', pet: { objectId: 600, name: 'bwca' } as MemberReport['pet'] });
        expect(planBuffs('Druid', [druid, owner, human({ observedPet: { objectId: 600, name: 'bwca', x: 0, y: 0, z: 0 } })], { needs: { melee: ['str'], healer: [], nuker: [] }, petNeeds: ['str'] }).filter(t => t.pet).map(t => t.pet!.owner)).toEqual(['Ench']);
    });
});

describe('rezzers rez it first', () => {
    test('rezOrder: the observed corpse before a rezzer\'s and the tank\'s', () => {
        const me = { x: 0, y: 0 };
        const corpses = [report('Tank', { role: 'tank', isDead: true }), report('Druid', { role: 'healer', isDead: true, capabilities: { heal: true, cc: false, nuke: false, rez: true, buffs: [], buffSpells: [] } }), human({ isDead: true })];
        expect(corpses.sort(rezOrder(me)).map(m => m.name)).toEqual(['Vue', 'Druid', 'Tank']);
    });
    test('the rez goes to it, and waits longer for its answer (a human reads the box)', async () => {
        const cleric = report('Cleric', { role: 'healer', regionId: R, x: 10_000, y: 10_000, objectId: 2, level: 24 });
        const deadTank = report('Hero', { role: 'tank', regionId: R, x: 10_050, y: 10_000, objectId: 3, isDead: true, level: 24 });
        const s = stub({ name: 'Cleric', role: 'healer', members: [cleric, deadTank, human({ isDead: true, hp: 0, level: 24 })], orders: { phase: 'recover' } });
        expect(await rez().run(s.ctx)).toBe(true);
        expect(s.calls.resurrect.map(r => r.id)).toEqual([77]);
        expect(s.calls.resurrect[0]!.opts.answerMs).toBeGreaterThan(4000);
    });
});

describe('guards guard it', () => {
    test('Guard goes on the observed member before the healer the settings name', async () => {
        const hero = report('Hero', { role: 'tank', regionId: R, x: 10_000, y: 10_000, objectId: 1 });
        const druid = report('Druid', { role: 'healer', regionId: R, x: 10_050, y: 10_000, objectId: 2 });
        const s = stub({ name: 'Hero', role: 'tank', members: [hero, druid, human()], orders: { phase: 'idle' }, settings: { ...SETTINGS, guard: { guard: 'healer', protect: '' } } });
        expect(await guard().run(s.ctx)).toBe(true);
        expect(s.calls.target).toEqual([77]);
    });
});

describe('formation: it holds a slot and nobody moves it', () => {
    test('the bots of its role keep their slots, and its slot is its own', () => {
        const blade = report('Blade', { role: 'melee', regionId: R });
        const pic = picture([report('Hero', { role: 'tank', regionId: R }), blade, human()]);
        const slotOf = (name: string) => formationSlot({ members: () => pic.members, role: 'melee', name, orders: () => pic.orders, settings: SETTINGS, me: () => ({ regionId: R }) } as unknown as MemberContext<TacticsSettings>, ANCHOR, { x: ANCHOR.x + 1000, y: ANCHOR.y });
        const bladeAlone = formationSlot({ members: () => [pic.members[0]!, blade], role: 'melee', name: 'Blade', orders: () => pic.orders, settings: SETTINGS, me: () => ({ regionId: R }) } as unknown as MemberContext<TacticsSettings>, ANCHOR, { x: ANCHOR.x + 1000, y: ANCHOR.y });
        expect(slotOf('Blade')).toEqual(bladeAlone);
        expect(slotOf('Vue')).not.toEqual(slotOf('Blade'));
    });
});

describe('bots leave it the kills', () => {
    const mob = (hp: number) => contact(500, { regionId: R, x: 10_200, y: 10_000, hp, threat: true, hostileSince: Date.now() - 10_000, target: 'Hero', targetSince: Date.now() - 10_000 });
    const hitting = () => human({ attacking: true, targetId: 500 });

    test('finishedBy: only at or below leaveBelow, only an observed member hitting it', () => {
        expect(finishedBy([hitting()], { objectId: 500, hp: LEAVE_BELOW })?.name).toBe('Vue');
        expect(finishedBy([hitting()], { objectId: 500, hp: LEAVE_BELOW + 1 })).toBeUndefined();
        expect(finishedBy([human({ attacking: false, targetId: 500 })], { objectId: 500, hp: 5 })).toBeUndefined();
        expect(finishedBy([report('Blade', { attacking: true, targetId: 500 })], { objectId: 500, hp: 5 })).toBeUndefined();
        expect(finishedBy([hitting()], { objectId: 500, hp: 30 }, 40)?.name).toBe('Vue');
    });

    test('assist holds its nuke and its swing; at 60 % it nukes as ever', async () => {
        const wiz = report('Wizard', { role: 'nuker', regionId: R, x: 10_000, y: 10_000, objectId: 3 });
        const low = stub({ name: 'Wizard', role: 'nuker', members: [wiz, hitting()], contacts: [mob(20)], orders: { focus: 500 } });
        expect(await assist({ holdMs: 0 }).run(low.ctx)).toBe(false);
        expect(low.skips).toEqual(['assist: water beetle left to Vue']);
        expect(low.calls.castSpell).toEqual([]);
        const melee = stub({ name: 'Wizard', role: 'melee', members: [wiz, hitting()], contacts: [mob(20)], orders: { focus: 500 } });
        expect(await assist({ melee: true, holdMs: 0 }).run(melee.ctx)).toBe(false);
        expect(melee.calls.attack).toEqual([]);
        const high = stub({ name: 'Wizard', role: 'nuker', members: [wiz, hitting()], contacts: [mob(60)], orders: { focus: 500 } });
        expect(await assist({ holdMs: 0 }).run(high.ctx)).toBe(true);
        expect(high.calls.castSpell).toEqual([500]);
    });

    test('the tank stops on it too', async () => {
        const hero = report('Hero', { role: 'tank', regionId: R, x: 10_100, y: 10_000, objectId: 1 });
        const s = stub({ name: 'Hero', role: 'tank', members: [hero, hitting()], contacts: [mob(20)], orders: { focus: 500 } });
        expect(await tank().run(s.ctx)).toBe(false);
        expect(s.skips).toEqual(['tank: water beetle left to Vue']);
        expect(s.calls.killNpc).toEqual([]);
        expect(leftTo(s.ctx, mob(20))?.name).toBe('Vue');
    });
});

describe('the coordinator counts it and never picks it to act', () => {
    const pveCtx = (members: MemberReport[], contacts: Contact[], settings: Partial<PveSettings> = {}) => ({
        picture: picture(members, contacts, { phase: 'engage', focus: 500 }), orders: { ...picture([]).orders, phase: 'engage' as const, focus: 500 },
        memory: {} as Record<string, any>, settings: { ...PVE_SETTINGS, ...settings, camp: { x: 10_000, y: 10_000, z: 0 } } as PveSettings, now: Date.now(), windingDown: false,
    });

    test('a tank class human is never the tank: with the bot tank dead the group has none', () => {
        const members = [report('Hero', { role: 'tank', regionId: R, isDead: true }), report('Druid', { role: 'healer', regionId: R }), human()];
        const u = decidePve({ ...pveCtx(members, [contact(500, { regionId: R, threat: true, hp: 80 })], { retreat: { ...PVE_SETTINGS.retreat, enabled: true } }) });
        expect(u).toMatchObject({ phase: 'retreat', reason: 'retreat: the tank is dead' });
    });

    test('its death counts in the retreat\'s deaths', () => {
        const members = [report('Hero', { role: 'tank', regionId: R }), report('Druid', { role: 'healer', regionId: R, isDead: true }), human({ isDead: true })];
        const u = decidePve(pveCtx(members, [contact(500, { regionId: R, threat: true, hp: 80 })], { retreat: { ...PVE_SETTINGS.retreat, enabled: true, deaths: 2 } }));
        expect(u).toMatchObject({ phase: 'retreat', reason: 'retreat: 2 members dead' });
    });

    test('the column: it never drives, also in a group with no crowd controller and no tank', () => {
        const blades = [report('Zed', { role: 'melee', regionId: R }), report('Yan', { role: 'melee', regionId: R })];
        expect(columnOrder([...blades, human({ name: 'Abe' })])).toEqual({ driver: 'Yan', order: ['Abe', 'Zed'] });
    });

    test('mezzMelee never hands the human a mezz, even in the mezzer\'s role', () => {
        const members = [human({ role: 'support', x: 10_000, y: 10_000, regionId: 200 }), ...team()];
        const c = tacticsCtx([tacticsFoe(600, 300, { classGuess: { classes: ['Armsman'], p: [0.9], role: 'tank', basis: [] } } as any)], { members });
        const u = mezzMelee(c, engage(null));
        expect((u.cc ?? []).some(a => a.by === 'Vue')).toBe(false);
    });
});

describe('group files name it', () => {
    test('observedEntriesProblem: names, never the tank, once each', () => {
        expect(observedEntriesProblem(undefined)).toBeNull();
        expect(observedEntriesProblem([{ name: 'Vue' }, { name: 'Ana', role: 'healer' }])).toBeNull();
        expect(observedEntriesProblem({ name: 'Vue' })).toMatch(/must be a list/);
        expect(observedEntriesProblem([{ name: 'V1' }])).toMatch(/letters only/);
        expect(observedEntriesProblem([{ name: 'Vue', role: 'tank' }])).toMatch(/the tank is a bot/);
        expect(observedEntriesProblem([{ name: 'Vue' }, { name: 'vue' }])).toMatch(/twice/);
    });

    test('loadGroup reads it and refuses a bad one', () => {
        // loadGroup finds bots/<bot>/bot.env from the working directory first.
        const root = mkdtempSync(join(tmpdir(), 'observed-'));
        const cwd = process.cwd();
        try {
            mkdirSync(join(root, 'bots', 'tank1'), { recursive: true });
            writeFileSync(join(root, 'bots', 'tank1', 'bot.env'), 'CHAR_NAME=Tanky\n');
            const dir = join(root, 'groups', 'g');
            mkdirSync(dir, { recursive: true });
            const write = (o: unknown) => writeFileSync(join(dir, 'group.json'), JSON.stringify({ members: [{ bot: 'tank1' }], observed: o }));
            process.chdir(root);
            write([{ name: 'Vue', role: 'support' }]);
            expect(loadGroup(dir, { lineup: undefined }).observed).toEqual([{ name: 'Vue', role: 'support' }]);
            write([{ name: 'Vue', role: 'tank' }]);
            expect(() => loadGroup(dir, { lineup: undefined })).toThrow(/the tank is a bot/);
        } finally {
            process.chdir(cwd);
            rmSync(root, { recursive: true, force: true });
        }
    });
});

// ── no observed member: everything as before ──

describe('equivalence: with no observed member nothing changes', () => {
    /** A seeded stream of member observations: three bots, mobs coming and going, targets, swings, deaths. */
    function stream(seed: number, n = 120): Observation[] {
        let a = seed >>> 0;
        const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
        const names = ['Tank', 'Druid', 'Wizard'];
        const out: Observation[] = [];
        const t0 = 1_000_000;
        for (let i = 0; i < n; i++) {
            const name = names[i % 3]!;
            const at = t0 + i * 250;
            const ids = [500, 501, 502, 503].filter(() => rnd() < 0.7);
            const sightings = ids.map(id => sighting(id, { x: 10_000 + int(-800, 800), y: 10_000 + int(-800, 800), hp: int(1, 100), targetId: rnd() < 0.5 ? [1, 2, 3, null][int(0, 3)]! : null, inCombat: rnd() < 0.5, swinging: rnd() < 0.3 }));
            const r = report(name, { regionId: R, objectId: names.indexOf(name) + 1, x: 10_000 + int(-300, 300), y: 10_000 + int(-300, 300), hp: int(20, 100), isDead: rnd() < 0.05, attacking: rnd() < 0.4, targetId: rnd() < 0.4 ? ids[0] ?? null : null, at });
            out.push({ ...obs(r, sightings, rnd() < 0.05 && ids.length ? [ids[0]!] : []), hits: [] });
        }
        return out;
    }
    const strip = (p: ReturnType<Blackboard['picture']>) => JSON.parse(JSON.stringify(p));

    for (const seed of [1, 2, 3, 42, 1234]) {
        test(`seed ${seed}: a board told of an observed member who never shows reads the same pictures and events, and the same decides`, () => {
            const plain = new Blackboard();
            const told = new Blackboard({ observed: [{ name: 'Nobody' }] });
            const empty = new Blackboard({ observed: [] });
            const s = stream(seed);
            for (const [i, o] of s.entries()) {
                const now = o.report.at;
                // The bots' clients have a window, with no Nobody in it: what an observed-aware member would publish.
                plain.publish(o, now);
                empty.publish(o, now);
                told.publish({ ...o, groupmates: [] }, now);
                if (i % 6 !== 5) continue;
                const [a, b, c] = [plain, told, empty].map(x => strip(x.picture(now)));
                expect(b).toEqual(a);
                expect(c).toEqual(a);
                const decide = (p: ReturnType<Blackboard['picture']>) => decidePve({ picture: p, orders: p.orders, memory: {}, settings: { ...PVE_SETTINGS, retreat: { ...PVE_SETTINGS.retreat, enabled: true }, camp: { x: 10_000, y: 10_000, z: 0 } } as PveSettings, now, windingDown: false });
                expect(decide(b)).toEqual(decide(a));
            }
            expect(told.events()).toEqual(plain.events());
        });
    }

    test('the orderings with no observed member are the old ones: heal by health, rez by rezzer/role/distance, buffs by role', () => {
        let a = 7;
        const rnd = () => (a = (a * 1103515245 + 12345) % 2147483648) / 2147483648;
        const roles: Role[] = ['tank', 'healer', 'support', 'nuker', 'melee'];
        for (let i = 0; i < 200; i++) {
            const ms = Array.from({ length: 6 }, (_, k) => report(`M${k}`, { role: roles[Math.floor(rnd() * 5)]!, hp: Math.floor(rnd() * 100), x: Math.floor(rnd() * 2000), y: 0, capabilities: { heal: false, cc: false, nuke: false, rez: rnd() < 0.3, buffs: [], buffSpells: [] } }));
            const oldHeal = [...ms].sort((x, y) => x.hp - y.hp)[0];
            expect([...ms].sort(healOrder(35))[0]!.hp).toBe(oldHeal!.hp);
            const REZ: Role[] = ['healer', 'tank', 'support', 'nuker', 'melee'];
            const me = { x: 0, y: 0 };
            const oldRez = [...ms].sort((x, y) => Number(!!y.capabilities.rez) - Number(!!x.capabilities.rez) || REZ.indexOf(x.role) - REZ.indexOf(y.role) || dist(me, x) - dist(me, y));
            expect([...ms].sort(rezOrder(me)).map(m => m.name)).toEqual(oldRez.map(m => m.name));
        }
    });

    test('finishedBy and leftTo never fire without an observed member, at any health', () => {
        const ms = team();
        for (const m of ms) { m.attacking = true; m.targetId = 500; }
        for (let hp = 0; hp <= 100; hp += 5) expect(finishedBy(ms, { objectId: 500, hp })).toBeUndefined();
    });

    test('mezzMelee: the same update with or without the filter when nobody is observed', () => {
        const c = tacticsCtx([tacticsFoe(600, 300, { classGuess: { classes: ['Armsman'], p: [0.9], role: 'tank', basis: [] } } as any)]);
        const u = mezzMelee(c, engage(null));
        expect((u.cc ?? []).length).toBeGreaterThan(0);
    });
});
