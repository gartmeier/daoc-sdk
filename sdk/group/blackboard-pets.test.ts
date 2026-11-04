// The board with pets on it, and its rule for a monster at 0 %: observeState on real-shaped
// snapshots, publish on reports. Lines and numbers come from the live pet runs.
import { describe, expect, test } from 'bun:test';
import { makeMessage, makeNpc, makePlayer, makePlayerObj, makeState } from '../test/fixtures';
import type { BotWorldState, CombatEvent, NearbyNpc, PetState } from '../types';
import { Blackboard, diedLately, isAlive, observeState, untouchable, type Killer, type MemberSelf } from './blackboard';
import { obs, report, sighting } from './fixtures';
import { GroupObserver } from './observer';
import type { GroupEvent, MemberReport, PetReport, Sighting } from './types';

const T = 1_800_000_000_000;
const self: MemberSelf = { bot: 'testbot', role: 'nuker', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [] } };

describe('a blow its pet took for its owner: the mob is on the owner', () => {
    // AttackComponent.cs:1492-1498 sets ad.Target to the pet, WeaponAction.cs:366-367 sends every non-attacker the 0xBC with that defender, and the mob's TargetObject stays the owner: PacketLib168.cs:820-828 names it on the next 0xA1.
    // Passive doesn't stop it (ControlledMobState.cs:148, AttackComponent.cs:1429-1436). Live: spiritmaster-melee 'a blow on us reads as on the pet (a7c 14.34)', group-midgard "on Petspi's pet 32%" from 'The spirit soldier steps in front of you and takes the blow!'.
    const LINE = 'The spirit soldier steps in front of you and takes the blow!';
    const OWNER = 100, OTHER = 101, PET_ID = 900, MOB = 7;
    const window: PetState = { objectId: PET_ID, name: 'spirit soldier', aggression: 'passive', walk: 'follow', icons: [], targetObjectId: null };
    const blow = (ago: number, now = T): CombatEvent => ({ id: 2, kind: 'melee', attackerObjectId: MOB, targetObjectId: PET_ID, result: 'hit', receivedAt: now - ago });
    const line = (ago: number, text = LINE, now = T) => makeMessage(50, text, { receivedAt: now - ago });
    const ownersLook = (o: { now?: number; events?: CombatEvent[]; messages?: ReturnType<typeof makeMessage>[]; target?: number | null } = {}) => observeState(makeState({
        timestamp: o.now ?? T, inGame: true, player: makePlayer({ objectId: OWNER, name: 'Owner', regionId: 1 }), pet: window, nearbyPlayers: [], combatEvents: o.events ?? [], gameMessages: o.messages ?? [],
        nearbyNpcs: [makeNpc({ objectId: PET_ID, name: 'spirit soldier', realm: 'midgard', isPet: true }), makeNpc({ objectId: MOB, name: 'wolf', level: 6, targetObjectId: o.target === undefined ? PET_ID : o.target, inCombat: true })],
    }), { ...self, role: 'tank' })!;
    const othersLook = (now: number, target: number | null = PET_ID) => observeState(makeState({
        timestamp: now, inGame: true, player: makePlayer({ objectId: OTHER, name: 'Other', regionId: 1 }), pet: null, nearbyPlayers: [], combatEvents: [], gameMessages: [],
        nearbyNpcs: [makeNpc({ objectId: MOB, name: 'wolf', level: 6, targetObjectId: target, inCombat: true })],
    }), self)!;
    const wolf = (b: Blackboard, now: number) => b.picture(now).contacts.find(c => c.objectId === MOB)!;

    test('the owner\'s client says which mob: the 0xBC on the pet beside the line', () => {
        expect(ownersLook({ events: [blow(10)], messages: [line(8)] }).intercepts).toEqual([{ mobId: MOB, at: T - 8 }]);
    });

    test('no line: a blow on the pet is a blow on the pet', () => {
        expect(ownersLook({ events: [blow(10)] }).intercepts ?? []).toEqual([]);
    });

    test('a groupmate who stepped in reads the same with its own name: no pet of ours', () => {
        expect(ownersLook({ events: [blow(10)], messages: [line(8, 'Gawain steps in front of you and takes the blow!')] }).intercepts ?? []).toEqual([]);
    });

    test('of two mobs on the pet, the one beside the line', () => {
        const other: CombatEvent = { id: 3, kind: 'melee', attackerObjectId: 8, targetObjectId: PET_ID, result: 'hit', receivedAt: T - 900 };
        expect(ownersLook({ events: [other, blow(10)], messages: [line(8)] }).intercepts).toEqual([{ mobId: MOB, at: T - 8 }]);
    });

    test('on the board it reads on the owner, from every client, with no flip of targetSince', () => {
        const b = new Blackboard();
        b.publish(ownersLook({ now: T - 2000, target: OWNER }), T - 2000);
        const since = wolf(b, T - 2000).targetSince;
        b.publish(ownersLook({ events: [blow(10)], messages: [line(8)] }), T);
        expect(wolf(b, T)).toMatchObject({ target: 'Owner', targetPet: null, targetId: OWNER, targetSince: since });
        // Another member's client has the 0xBC too, and no line.
        b.publish(othersLook(T + 100), T + 100);
        expect(wolf(b, T + 100)).toMatchObject({ target: 'Owner', targetPet: null, targetId: OWNER, targetSince: since });
    });

    test('until the mob could have swung again and nothing says so: then a reading on the pet is the mob on the pet', () => {
        const b = new Blackboard();
        b.publish(ownersLook({ events: [blow(10)], messages: [line(8)] }), T);
        b.publish(othersLook(T + 6000), T + 6000);
        expect(wolf(b, T + 6000)).toMatchObject({ target: null, targetPet: 'Owner', targetId: PET_ID });
    });

    test('a groupmate\'s pet stays that groupmate\'s, and another member\'s reading of the mob on itself stands', () => {
        const b = new Blackboard();
        b.publish(ownersLook({ events: [blow(10)], messages: [line(8)] }), T);
        b.publish(othersLook(T + 100, OTHER), T + 100);
        expect(wolf(b, T + 100)).toMatchObject({ target: 'Other', targetPet: null });
    });
});

describe('a shade\'s refusal mark goes with the shade', () => {
    // ClassDisciple.cs:60-83, ShadeECSEffect.cs:38: the servant gone, the old model comes back in the same step, in reach of attacks at once (AbstractServerRules.cs:449-455) with health at min(current, max(10, pet %)) (:149).
    const member = (at: number) => report('Owner', { objectId: 100, regionId: 1, at, x: 1000, y: 1000 });
    const necro = (over: Partial<Sighting> = {}) => sighting(42, { kind: 'player', name: 'Briton', realm: 'albion', x: 1500, y: 1000, ...over });

    test('a contact read as a shade, marked by a refusal, is free as soon as it reads otherwise', () => {
        const b = new Blackboard();
        b.publish(obs(member(T), [necro({ isShade: true })]), T);
        b.markUnattackable(42, 1, 30_000, T + 300);
        expect(untouchable(b.picture(T + 300).contacts[0]!, T + 300)).toBe(true);
        b.publish(obs(member(T + 20_000), [necro({ hp: 10, targetId: 100 })]), T + 20_000);
        const c = b.picture(T + 20_000).contacts[0]!;
        expect(c.unattackableUntil).toBeUndefined();
        expect(untouchable(c, T + 20_000)).toBe(false);
        expect(c).toMatchObject({ hp: 10, threat: true });
    });

    test('one no client read as a shade keeps its 30 s: that mark is all there is to go by', () => {
        const b = new Blackboard();
        b.publish(obs(member(T), [necro()]), T);
        b.markUnattackable(42, 1, 30_000, T + 300);
        b.publish(obs(member(T + 20_000), [necro()]), T + 20_000);
        expect(untouchable(b.picture(T + 20_000).contacts[0]!, T + 20_000)).toBe(true);
    });
});

describe('a monster at 0 %: under 1 % reads 0 alive (GameLiving.cs:2621)', () => {
    const death = (id: number, ago: number): CombatEvent => ({ id: 1, kind: 'death', attackerObjectId: null, targetObjectId: id, receivedAt: T - ago });
    const look = (healthPercent: number, combatEvents: CombatEvent[] = [], ms = 0) => observeState(makeState({
        timestamp: T + ms, player: makePlayer({ objectId: 100 }), nearbyPlayers: [], combatEvents,
        nearbyNpcs: [makeNpc({ objectId: 7, name: 'wolf', level: 6, healthPercent, targetObjectId: 100, inCombat: true })],
    }), self)!;

    test('with no death event it is a sighting, floored at 1 so every reader of hp > 0 reads it alive', () => {
        const o = look(0);
        expect(o.deaths).toEqual([]);
        expect(o.sightings).toMatchObject([{ objectId: 7, hp: 1, targetId: 100 }]);
        // Health above that is left alone.
        expect(look(1).sightings[0]!.hp).toBe(1);
        expect(look(37).sightings[0]!.hp).toBe(37);
    });

    test('with a fresh death event it is dead, as before', () => {
        const o = look(0, [death(7, 300)]);
        expect(o.deaths).toEqual([7]);
        expect(o.sightings).toEqual([]);
    });

    test('a death event older than that is an earlier holder of the id', () => {
        const o = look(0, [death(7, 5000)]);
        expect(o.deaths).toEqual([]);
        expect(o.sightings).toMatchObject([{ objectId: 7, hp: 1 }]);
    });

    test('a town NPC at 0 % reports no death either', () => {
        const o = observeState(makeState({ timestamp: T, player: makePlayer({ objectId: 100 }), nearbyPlayers: [], combatEvents: [], nearbyNpcs: [makeNpc({ objectId: 8, name: 'Guard Ulf', realm: 'albion', healthPercent: 0 })] }), self)!;
        expect(o.deaths).toEqual([]);
        expect(o.sightings).toEqual([]);
    });

    test('on the board it stays alive and a threat for those seconds, and may regenerate; its death event ends it, with a kill', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish(look(40), T);
        b.publish(look(0, [], 2000), T + 2000);
        expect(b.picture(T + 2000).contacts).toMatchObject([{ objectId: 7, hp: 1, threat: true }]);
        expect(isAlive(b.picture(T + 2000).contacts[0]!)).toBe(true);
        expect(events.filter(e => e.kind === 'kill')).toEqual([]);
        b.publish(look(2, [], 4000), T + 4000);
        expect(b.picture(T + 4000).contacts[0]!.hp).toBe(2);
        b.publish(look(0, [death(7, -5400)], 5500), T + 5500);
        expect(b.picture(T + 5500).contacts).toEqual([]);
        expect(events.filter(e => e.kind === 'kill').map(e => e.text)).toEqual(['wolf (L6) died']);
    });

    test('diedLately: the event, this id, this fresh', () => {
        const state = (combatEvents: CombatEvent[]) => ({ timestamp: T, combatEvents });
        expect(diedLately(state([death(7, 4999)]), 7)).toBe(true);
        expect(diedLately(state([death(7, 5000)]), 7)).toBe(false);
        expect(diedLately(state([death(8, 100)]), 7)).toBe(false);
        expect(diedLately(state([{ ...death(7, 100), kind: 'melee' }]), 7)).toBe(false);
    });
});

describe('pets on the board', () => {
    const window = (over: Partial<PetState> = {}): PetState => ({ objectId: 500, name: 'spirit soldier', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null, ...over });
    const entry = (over: Partial<NearbyNpc> = {}) => makeNpc({ objectId: 500, name: 'spirit soldier', level: 17, realm: 'albion', isPet: true, x: 560100, y: 511000, z: 2500, healthPercent: 84, ...over });
    const look = (over: Partial<BotWorldState>) => observeState(makeState({ timestamp: T, player: makePlayer({ objectId: 100 }), nearbyNpcs: [], nearbyPlayers: [], combatEvents: [], ...over }), self)!;
    const petOf = (over: Partial<PetReport> = {}): PetReport => ({ objectId: 500, name: 'spirit soldier', level: 17, x: 1000, y: 1000, z: 0, hp: 84, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [], ...over });
    const contactOf = (b: Blackboard, at: number, id = 7) => b.picture(at).contacts.find(c => c.objectId === id);

    describe('MemberReport.pet', () => {
        test('the window with its entry in view', () => {
            const r = look({ pet: window({ icons: [811, 831], targetObjectId: 7, walk: 'comeHere', aggression: 'passive' }), nearbyNpcs: [entry({ inCombat: true })] }).report;
            expect(r.pet).toEqual({ objectId: 500, name: 'spirit soldier', level: 17, x: 560100, y: 511000, z: 2500, hp: 84, targetId: 7, inCombat: true, aggression: 'passive', walk: 'comeHere', icons: [811, 831] });
        });

        test('out of view: the window holds, what only its entry knows is null', () => {
            expect(look({ pet: window(), nearbyNpcs: [] }).report.pet).toEqual({ objectId: 500, name: 'spirit soldier', level: null, x: null, y: null, z: null, hp: null, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [] });
            expect(look({ pet: window({ name: undefined }), nearbyNpcs: [] }).report.pet!.name).toBe('');
        });

        test('the target is the window\'s, which holds while a caster pet reads 0 and a walking one 65535', () => {
            // The model turns both of the entry's into a null targetObjectId.
            const r = look({ pet: window({ targetObjectId: 7 }), nearbyNpcs: [entry({ targetObjectId: null, inCombat: false })] }).report;
            expect(r.pet!.targetId).toBe(7);
        });

        test('null without a pet, absent from an older client', () => {
            expect(look({ pet: null }).report.pet).toBeNull();
            expect(look({}).report.pet).toBeUndefined();
        });

        test('pets with no window go by id, and only when there are some', () => {
            expect(look({ pet: null, summons: [600, 601] }).report.summons).toEqual([600, 601]);
            expect(look({ pet: null, summons: [] }).report.summons).toBeUndefined();
            expect(look({ pet: null }).report.summons).toBeUndefined();
        });

        test('the last loss goes along for the note', () => {
            const loss = { objectId: 499, name: 'spirit soldier', cause: 'died' as const, at: T - 100 };
            expect(look({ pet: null, lastPetLoss: loss }).petLoss).toEqual(loss);
            expect(look({ pet: null }).petLoss).toBeUndefined();
        });
    });

    describe('sightings', () => {
        const sighted = (npc: NearbyNpc) => look({ nearbyNpcs: [npc] }).sightings;

        test('an enemy realm\'s pet is a contact, marked; it keeps its target', () => {
            expect(sighted(entry({ objectId: 700, realm: 'midgard', targetObjectId: 100 }))).toMatchObject([{ objectId: 700, kind: 'npc', realm: 'midgard', isPet: true, targetId: 100 }]);
        });

        test('ours and a realm-mate\'s are not, nor a monster\'s, a peaceful one or a keep guard', () => {
            expect(sighted(entry())).toEqual([]);
            expect(sighted(entry({ objectId: 700, realm: 'none' }))).toEqual([]);
            expect(sighted(entry({ objectId: 700, realm: 'midgard', isPeaceful: true }))).toEqual([]);
            expect(sighted(makeNpc({ objectId: 701, name: 'Guard Ulf', realm: 'midgard' }))).toEqual([]);
        });

        test('nor our own pet with no pet flag yet, by window or as a summon', () => {
            const unflagged = makeNpc({ objectId: 500, name: 'wolf', realm: 'none', isPet: false });
            expect(look({ pet: window(), nearbyNpcs: [unflagged] }).sightings).toEqual([]);
            expect(look({ pet: null, summons: [500], nearbyNpcs: [unflagged] }).sightings).toEqual([]);
        });

        test('a monster carries no isPet', () => {
            expect(sighted(makeNpc({ objectId: 701, name: 'wolf' }))[0]).not.toHaveProperty('isPet');
        });
    });

    test('a hit by our window pet or a summon on an enemy player counts as ours; a miss, or someone else\'s, does not', () => {
        const foe = makePlayerObj({ objectId: 300, name: 'Norseman', realm: 'midgard' });
        const swing = (by: number, result: CombatEvent['result']): CombatEvent => ({ id: 1, kind: 'melee', attackerObjectId: by, targetObjectId: 300, result, receivedAt: T - 500 });
        expect(look({ pet: window(), nearbyPlayers: [foe], combatEvents: [swing(500, 'hit')] }).hits).toEqual([300]);
        expect(look({ pet: null, summons: [600], nearbyPlayers: [foe], combatEvents: [swing(600, 'hit')] }).hits).toEqual([300]);
        expect(look({ pet: window(), nearbyPlayers: [foe], combatEvents: [swing(500, 'miss')] }).hits).toEqual([]);
        expect(look({ pet: null, nearbyPlayers: [foe], combatEvents: [swing(500, 'hit')] }).hits).toEqual([]);
    });

    test('a killer that is an enemy pet says so; a guard of that realm does not', () => {
        const dead = makePlayer({ objectId: 100, isDead: true });
        const killedBy = (id: number): CombatEvent => ({ id: 1, kind: 'death', attackerObjectId: id, targetObjectId: 100, receivedAt: T - 100 });
        expect(look({ player: dead, nearbyNpcs: [entry({ objectId: 700, realm: 'midgard' })], combatEvents: [killedBy(700)] }).killer).toEqual({ name: 'spirit soldier', kind: 'npc', realm: 'midgard', isPet: true });
        expect(look({ player: dead, nearbyNpcs: [makeNpc({ objectId: 701, name: 'Guard Ulf', realm: 'midgard' })], combatEvents: [killedBy(701)] }).killer).toEqual({ name: 'Guard Ulf', kind: 'npc', realm: 'midgard' });
    });

    describe('Observation.petSwings', () => {
        const swing = (by: number, result: CombatEvent['result'] = 'hit', ago = 500): CombatEvent => ({ id: 1, kind: 'melee', attackerObjectId: by, targetObjectId: 7, result, receivedAt: T - ago });
        const mob = makeNpc({ objectId: 7, name: 'rock crab', level: 6 });

        test('our window pet\'s and a summon\'s, whether they landed or not', () => {
            expect(look({ pet: window(), nearbyNpcs: [mob], combatEvents: [swing(500)] }).petSwings).toEqual([{ targetId: 7, at: T - 500, landed: true }]);
            expect(look({ pet: null, summons: [600], nearbyNpcs: [mob], combatEvents: [swing(600, 'styledHit')] }).petSwings).toEqual([{ targetId: 7, at: T - 500, landed: true }]);
            for (const result of ['miss', 'parry', 'block', 'evade', 'fumble'] as const) {
                expect(look({ pet: window(), nearbyNpcs: [mob], combatEvents: [swing(500, result)] }).petSwings).toEqual([{ targetId: 7, at: T - 500, landed: false }]);
            }
        });

        test('nobody else\'s, and none older than a swing', () => {
            expect(look({ pet: null, nearbyNpcs: [mob], combatEvents: [swing(500)] }).petSwings).toEqual([]);
            expect(look({ pet: window(), nearbyNpcs: [mob], combatEvents: [swing(100)] }).petSwings).toEqual([]);
            expect(look({ pet: window(), nearbyNpcs: [mob], combatEvents: [swing(500, 'hit', 2000)] }).petSwings).toEqual([]);
        });

        test('a caster pet\'s hostile spell counts (any but a mezz on an NPC breaks one, GameLiving.cs:1729-1730), its buff on us does not', () => {
            const effect = (on: number): CombatEvent => ({ id: 1, kind: 'spellEffect', attackerObjectId: 500, targetObjectId: on, effectId: 2165, receivedAt: T - 500 });
            const seen = { pet: window(), nearbyNpcs: [mob, entry()] };
            expect(look({ ...seen, combatEvents: [effect(7)] }).petSwings).toEqual([{ targetId: 7, at: T - 500, landed: true }]);
            expect(look({ ...seen, combatEvents: [effect(100)] }).petSwings).toEqual([]);
        });
    });

    describe('Blackboard.publish', () => {
        const owner = (at: number, pet: PetReport | null, over: Partial<MemberReport> = {}) => report('Hrafna', { at, objectId: 11, pet, ...over });
        const healer = (at: number) => report('Healer', { at, objectId: 22, x: 1200 });

        test('a mob on a member\'s pet names its owner in targetPet, not target', () => {
            const b = new Blackboard();
            b.publish(obs(owner(T, petOf()), [sighting(7, { targetId: 500, inCombat: true })]), T);
            expect(contactOf(b, T)).toMatchObject({ target: null, targetPet: 'Hrafna', targetId: 500 });
            // Any member's snapshot of it says the same.
            b.publish(obs(healer(T + 100), [sighting(7, { targetId: 500, inCombat: true })]), T + 100);
            expect(contactOf(b, T + 100)!.targetPet).toBe('Hrafna');
        });

        test('a mob on a pet is a threat even when it isn\'t swinging, and its death is a kill', () => {
            const b = new Blackboard({ hostileMs: 4000 });
            const events: GroupEvent[] = [];
            b.onEvent(e => events.push(e));
            for (const ms of [0, 1000, 2000, 3000, 4000, 5000]) b.publish(obs(owner(T + ms, petOf()), [sighting(7, { targetId: 500, inCombat: true })]), T + ms);
            expect(contactOf(b, T + 5000)).toMatchObject({ threat: true, hostileSince: T });
            b.publish(obs(owner(T + 5500, petOf()), [], [7]), T + 5500);
            expect(events.filter(e => e.kind === 'kill').map(e => e.text)).toEqual(['water beetle (L6) died']);
        });

        test('a mob the pet attacks is ours before it turns: threat, and its death a kill', () => {
            const b = new Blackboard();
            const events: GroupEvent[] = [];
            b.onEvent(e => events.push(e));
            b.publish(obs(owner(T, petOf({ targetId: 7 })), [sighting(7)]), T);
            expect(contactOf(b, T)).toMatchObject({ threat: true, target: null, targetPet: null });
            b.publish(obs(owner(T + 500, petOf({ targetId: 7 })), [], [7]), T + 500);
            expect(events.filter(e => e.kind === 'kill').map(e => e.targetId)).toEqual([7]);
        });

        test('a mob near a pet that nothing ties to it is no threat, and its death no kill', () => {
            const b = new Blackboard();
            const events: GroupEvent[] = [];
            b.onEvent(e => events.push(e));
            b.publish(obs(owner(T, petOf()), [sighting(7)]), T);
            expect(contactOf(b, T)).toMatchObject({ threat: false, targetPet: null });
            b.publish(obs(owner(T + 500, petOf()), [], [7]), T + 500);
            expect(events.filter(e => e.kind === 'kill')).toEqual([]);
        });

        test('a mob on a summon names its owner too; a window pet wins an id both claim', () => {
            const b = new Blackboard();
            b.publish(obs(report('Taliesin', { at: T, objectId: 11, pet: null, summons: [600] }), [sighting(7, { targetId: 600, inCombat: true })]), T);
            expect(contactOf(b, T)).toMatchObject({ target: null, targetPet: 'Taliesin', threat: true });
            // A buff of ours on a groupmate's fresh pet can land it in our summons (BotWorldState.summons).
            const c = new Blackboard();
            c.publish(obs(report('Healer', { at: T, objectId: 22, summons: [500] })), T);
            c.publish(obs(owner(T + 100, petOf()), [sighting(7, { targetId: 500, inCombat: true })]), T + 100);
            expect(contactOf(c, T + 100)!.targetPet).toBe('Hrafna');
        });

        test('while the mob runs (in combat, no target) targetPet is kept; a mob leaving combat clears it', () => {
            const b = new Blackboard();
            b.publish(obs(owner(T, petOf()), [sighting(7, { targetId: 500, inCombat: true })]), T);
            b.publish(obs(owner(T + 500, petOf()), [sighting(7, { targetId: null, inCombat: true })]), T + 500);
            expect(contactOf(b, T + 500)).toMatchObject({ targetId: 500, targetPet: 'Hrafna' });
            b.publish(obs(owner(T + 1000, petOf()), [sighting(7, { targetId: null, inCombat: false })]), T + 1000);
            expect(contactOf(b, T + 1000)).toMatchObject({ targetId: null, targetPet: null });
        });

        test('on a member, targetPet stays null', () => {
            const b = new Blackboard();
            b.publish(obs(owner(T, petOf()), [sighting(7, { targetId: 11, inCombat: true })]), T);
            expect(contactOf(b, T)).toMatchObject({ target: 'Hrafna', targetPet: null });
        });

        test('a groupmate\'s pet is never a contact, flag or no flag: a mob a charm just took stops being one', () => {
            const b = new Blackboard();
            b.publish(obs(healer(T), [sighting(500, { name: 'wolf' })]), T);
            expect(contactOf(b, T, 500)).toBeDefined();
            b.publish(obs(owner(T + 100, petOf())), T + 100);
            b.publish(obs(healer(T + 200), [sighting(500, { name: 'wolf' })]), T + 200);
            expect(contactOf(b, T + 200, 500)).toBeUndefined();
        });

        test('a summon\'s id is no such shield: one that ended out of view lingers in summons, and a mob can inherit its id', () => {
            const b = new Blackboard();
            b.publish(obs(report('Taliesin', { at: T, objectId: 11, pet: null, summons: [600] })), T);
            b.publish(obs(healer(T + 100), [sighting(600, { name: 'wolf', targetId: 22, inCombat: true })]), T + 100);
            expect(contactOf(b, T + 100, 600)).toMatchObject({ name: 'wolf', target: 'Healer', threat: true });
        });

        test('an enemy pet swinging far off is someone else\'s fight; near a member or on one it is hostile', () => {
            const pet = (over: Partial<Sighting> = {}) => sighting(700, { realm: 'midgard', isPet: true, x: 5000, swinging: true, ...over });
            const far = new Blackboard();
            far.publish(obs(report('Tank', { at: T, objectId: 11 }), [pet()]), T);
            expect(contactOf(far, T, 700)).toMatchObject({ isPet: true, threat: false });
            const near = new Blackboard();
            near.publish(obs(report('Tank', { at: T, objectId: 11 }), [pet({ x: 2000 })]), T);
            expect(contactOf(near, T, 700)!.threat).toBe(true);
            const onUs = new Blackboard();
            onUs.publish(obs(report('Tank', { at: T, objectId: 11 }), [pet({ swinging: false, targetId: 11 })]), T);
            expect(contactOf(onUs, T, 700)).toMatchObject({ target: 'Tank', threat: true });
        });

        test('an enemy pet\'s death says so in the kill data; a monster\'s carries no such key', () => {
            const b = new Blackboard();
            const events: GroupEvent[] = [];
            b.onEvent(e => events.push(e));
            b.publish(obs(report('Tank', { at: T, objectId: 11 }), [sighting(700, { realm: 'midgard', isPet: true, targetId: 11, hp: 5 }), sighting(7, { targetId: 11 })]), T);
            b.publish({ ...obs(report('Tank', { at: T + 100, objectId: 11 }), [], [700, 7]), petHits: [700] }, T + 100);
            const kills = events.filter(e => e.kind === 'kill');
            expect(kills.find(e => e.targetId === 700)!.data).toMatchObject({ pet: true, realm: 'midgard' });
            expect(kills.find(e => e.targetId === 7)!.data).not.toHaveProperty('pet');
        });

        test('a monster that inherits an enemy pet\'s id loses the mark', () => {
            const b = new Blackboard();
            b.publish(obs(report('Tank', { at: T, x: 0 }), [sighting(700, { realm: 'midgard', isPet: true, x: 9000 })]), T);
            expect(contactOf(b, T, 700)!.isPet).toBe(true);
            b.publish(obs(report('Tank', { at: T + 500, x: 0 }), [sighting(700, { x: 9000 })]), T + 500);
            expect(contactOf(b, T + 500, 700)!.isPet).toBeUndefined();
        });

        describe('a pet breaking crowd control', () => {
            const swing = (at: number, landed = true) => ({ targetId: 7, at, landed });
            const broke = (events: GroupEvent[]) => events.filter(e => e.kind === 'note' && e.data?.petBrokeCc);
            /** A mezz (or root) from the healer at T, and the mob sighted standing under it. */
            const under = (kind = 'mezz') => {
                const b = new Blackboard();
                const events: GroupEvent[] = [];
                b.onEvent(e => events.push(e));
                b.publish(obs(owner(T, petOf()), [sighting(7, { name: 'rock crab' })]), T);
                b.markCc(7, 200, 'Healer', kind, 60_000, T);
                return { b, events };
            };

            // Live: 'Your spirit soldier attacks the rock crab and hits for 21 damage!' and 'The rock crab hits your spirit soldier for 9 damage.' in the same tick: mez broken.
            test('the owner gets the note, the mob comes off cc, and the mob\'s answer in the same snapshot adds none', () => {
                const { b, events } = under();
                b.publish({ ...obs(owner(T + 3000, petOf({ targetId: 7 })), [sighting(7, { name: 'rock crab', targetId: 500, inCombat: true, swinging: true })]), petSwings: [swing(T + 2900)] }, T + 3000);
                expect(broke(events)).toMatchObject([{ member: 'Hrafna', targetId: 7, text: 'Hrafna\'s pet broke the mezz on rock crab', data: { petBrokeCc: true, kind: 'mezz', by: 'Healer' } }]);
                expect(events.filter(e => e.kind === 'note').length).toBe(1);
                expect(contactOf(b, T + 3000)!.cc).toBeNull();
                // The same swing in the next snapshot, under a new mezz: it came before that one.
                b.markCc(7, 200, 'Healer', 'mezz', 60_000, T + 3200);
                b.publish({ ...obs(owner(T + 3400, petOf({ targetId: 7 })), [sighting(7, { name: 'rock crab' })]), petSwings: [swing(T + 2900)] }, T + 3400);
                expect(broke(events).length).toBe(1);
                expect(contactOf(b, T + 3400)!.cc).not.toBeNull();
            });

            test('a swing within 500 ms of the mark can be one from before it landed', () => {
                const { b, events } = under();
                b.publish({ ...obs(owner(T + 600, petOf()), [sighting(7, { name: 'rock crab' })]), petSwings: [swing(T + 500)] }, T + 600);
                expect(broke(events)).toEqual([]);
                expect(contactOf(b, T + 600)!.cc).not.toBeNull();
                b.publish({ ...obs(owner(T + 700, petOf()), [sighting(7, { name: 'rock crab' })]), petSwings: [swing(T + 501)] }, T + 700);
                expect(broke(events).length).toBe(1);
            });

            test('a miss breaks a mezz (GameLiving.cs:1700-1704); a root only a hit (:1689-1694)', () => {
                const mezz = under();
                mezz.b.publish({ ...obs(owner(T + 2000, petOf()), [sighting(7, { name: 'rock crab' })]), petSwings: [swing(T + 1900, false)] }, T + 2000);
                expect(broke(mezz.events).length).toBe(1);
                const root = under('root');
                root.b.publish({ ...obs(owner(T + 2000, petOf()), [sighting(7, { name: 'rock crab' })]), petSwings: [swing(T + 1900, false)] }, T + 2000);
                expect(broke(root.events)).toEqual([]);
                expect(contactOf(root.b, T + 2000)!.cc).not.toBeNull();
                root.b.publish({ ...obs(owner(T + 3000, petOf()), [sighting(7, { name: 'rock crab' })]), petSwings: [swing(T + 2900)] }, T + 3000);
                expect(broke(root.events)).toMatchObject([{ text: 'Hrafna\'s pet broke the root on rock crab', data: { kind: 'root' } }]);
            });

            test('no cc on it, or no such contact: nothing', () => {
                const b = new Blackboard();
                const events: GroupEvent[] = [];
                b.onEvent(e => events.push(e));
                b.publish(obs(owner(T, petOf()), [sighting(7)]), T);
                b.publish({ ...obs(owner(T + 1000, petOf()), [sighting(7)]), petSwings: [swing(T + 900), { targetId: 8, at: T + 900, landed: true }] }, T + 1000);
                expect(broke(events)).toEqual([]);
            });

            test('a mob\'s own swing with no pet\'s before it stays the plain note', () => {
                const { b, events } = under();
                b.publish(obs(owner(T + 3000, petOf()), [sighting(7, { name: 'rock crab', swinging: true })]), T + 3000);
                expect(broke(events)).toEqual([]);
                expect(events.filter(e => e.kind === 'note').map(e => e.text)).toEqual(['mezz on rock crab broke']);
            });
        });

        describe('losing the pet', () => {
            const notes = (events: GroupEvent[]) => events.filter(e => e.kind === 'note' && e.data?.pet === 'lost');

            test('a note, once, with how it went; not when the owner died or never had one', () => {
                const b = new Blackboard();
                const events: GroupEvent[] = [];
                b.onEvent(e => events.push(e));
                b.publish(obs(owner(T, null)), T);
                b.publish(obs(owner(T + 100, petOf())), T + 100);
                expect(notes(events)).toEqual([]);
                b.publish({ ...obs(owner(T + 200, null)), petLoss: { objectId: 500, name: 'spirit soldier', cause: 'died', at: T + 190 } }, T + 200);
                b.publish(obs(owner(T + 300, null)), T + 300);
                expect(notes(events)).toMatchObject([{ member: 'Hrafna', text: 'Hrafna lost spirit soldier (died)', data: { pet: 'lost', name: 'spirit soldier', cause: 'died' } }]);
                b.publish(obs(owner(T + 400, petOf())), T + 400);
                b.publish(obs(owner(T + 500, null, { isDead: true, hp: 0 })), T + 500);
                expect(notes(events).length).toBe(1);
            });

            test('with no loss on record for this pet the cause is unknown', () => {
                const b = new Blackboard();
                const events: GroupEvent[] = [];
                b.onEvent(e => events.push(e));
                b.publish(obs(owner(T, petOf())), T);
                b.publish({ ...obs(owner(T + 100, null)), petLoss: { objectId: 499, name: 'an older one', cause: 'released', at: T - 100_000 } }, T + 100);
                expect(notes(events)).toMatchObject([{ text: 'Hrafna lost spirit soldier', data: { pet: 'lost', cause: null } }]);
            });

            /** The owner keeps seeing `ids`, on nobody, out of combat, until `to`. */
            const stillSees = (b: Blackboard, from: number, to: number, ...ids: number[]) => {
                for (let ms = from; ms <= to; ms += 500) b.publish(obs(owner(T + ms, null), ids.map(id => sighting(id, { targetId: null, inCombat: false }))), T + ms);
            };
            /** The same, running at it: in combat, no target (the server sends 65535 while a mob runs), at a speed. */
            const runsIn = (b: Blackboard, from: number, to: number, speed = 128, id = 7) => {
                for (let ms = from; ms <= to; ms += 500) b.publish(obs(owner(T + ms, null), [sighting(id, { targetId: null, inCombat: true, speed })]), T + ms);
            };

            test('the mob that killed it stays a threat for its whole run-in, though it reads as on nobody. 20261103-165547: pet dead 16:56:01.0, "frame 16:56:07 mob speed 128 inCombat true target null", first hit 16:56:09.98', () => {
                const b = new Blackboard({ hostileMs: 4000 });
                b.publish(obs(owner(T, petOf({ targetId: 7 })), [sighting(7, { targetId: 500, inCombat: true })]), T);
                // The pet dies at +500; the mob idles about 1 s, reading no target and no combat, and runs.
                stillSees(b, 500, 1500, 7);
                runsIn(b, 2000, 9500);
                expect(contactOf(b, T + 6600)!.threat).toBe(true);
                expect(contactOf(b, T + 9400)).toMatchObject({ threat: true, hostileSince: T });
                // Its first swing on the owner is an ordinary threat from there.
                b.publish(obs(owner(T + 10_000, null), [sighting(7, { targetId: 11, inCombat: true, swinging: true })]), T + 10_000);
                expect(contactOf(b, T + 13_000)!.target).toBe('Hrafna');
            });

            test('up to 30 s from the loss, the model\'s bound for a run-in: 20261103-163415 ran in for 9.6 s, 20261104-052514 for 19 s at 21 %', () => {
                const b = new Blackboard({ hostileMs: 4000 });
                b.publish(obs(owner(T, petOf({ targetId: 7 })), [sighting(7, { targetId: 500, inCombat: true })]), T);
                b.publish(obs(owner(T + 500, null), [sighting(7, { targetId: null, inCombat: false })]), T + 500);
                runsIn(b, 1000, 35_000);
                expect(contactOf(b, T + 30_400)!.threat).toBe(true);
                expect(contactOf(b, T + 30_600)!.threat).toBe(false);
            });

            test('a mob that doesn\'t come: only hostileMs. Standing, or going home (out of combat)', () => {
                const standing = new Blackboard({ hostileMs: 4000 });
                standing.publish(obs(owner(T, petOf({ targetId: 7 })), [sighting(7, { targetId: 500, inCombat: true })]), T);
                standing.publish(obs(owner(T + 500, null), [sighting(7, { targetId: null, inCombat: false })]), T + 500);
                runsIn(standing, 1000, 6000, 0);
                expect(contactOf(standing, T + 4400)!.threat).toBe(true);
                expect(contactOf(standing, T + 4600)!.threat).toBe(false);
                const home = new Blackboard({ hostileMs: 4000 });
                home.publish(obs(owner(T, petOf({ targetId: 7 })), [sighting(7, { targetId: 500, inCombat: true })]), T);
                home.publish(obs(owner(T + 500, null), [sighting(7, { targetId: null, inCombat: false })]), T + 500);
                for (let ms = 1000; ms <= 6000; ms += 500) home.publish(obs(owner(T + ms, null), [sighting(7, { targetId: null, inCombat: false, speed: 150 })]), T + ms);
                expect(contactOf(home, T + 4600)!.threat).toBe(false);
            });

            test('a mob running in combat with no pet lost before it gets none of that', () => {
                const b = new Blackboard({ hostileMs: 4000 });
                b.publish(obs(owner(T, null), [sighting(7, { targetId: null, inCombat: true, speed: 128 })]), T);
                expect(contactOf(b, T + 100)!.threat).toBe(false);
            });

            test('so does one another member\'s snapshot already cleared: the pet\'s own target says which', () => {
                const b = new Blackboard({ hostileMs: 4000 });
                b.publish(obs(owner(T, petOf({ targetId: 7 })), [sighting(7, { targetId: 500, inCombat: true })]), T);
                b.publish(obs(healer(T + 100), [sighting(7, { targetId: null, inCombat: false })]), T + 100);
                b.publish(obs(owner(T + 200, null), [sighting(7, { targetId: null, inCombat: false })]), T + 200);
                runsIn(b, 500, 6000);
                expect(contactOf(b, T + 6000)!.threat).toBe(true);
            });

            test('the first health loss of the fight: not from the sightings before the engage order, and with the health it began at', () => {
                const b = new Blackboard();
                const see = (ms: number, hp: number) => b.publish(obs(owner(T + ms, null), [sighting(7, { hp, targetId: 11, inCombat: true })]), T + ms);
                see(0, 100);
                see(1000, 93);
                expect(contactOf(b, T + 1000)!.lossSince).toBeUndefined();
                b.publish(obs(owner(T + 2000, null), [sighting(7, { hp: 93, targetId: 11, inCombat: true })]), T + 2000);
                b.setOrders({ phase: 'engage', focus: 7, reason: 'test' }, T + 2000);
                see(3000, 93);
                expect(contactOf(b, T + 3000)!.lossSince).toBeUndefined();
                see(4000, 84);
                expect(contactOf(b, T + 4000)).toMatchObject({ lossSince: T + 4000, lossFromHp: 93 });
                see(5000, 72);
                expect(contactOf(b, T + 5000)).toMatchObject({ lossSince: T + 4000, lossFromHp: 93, hp: 72 });
            });

            test('back at full health it starts over', () => {
                const b = new Blackboard();
                const see = (ms: number, hp: number) => b.publish(obs(owner(T + ms, null), [sighting(7, { hp, targetId: 11, inCombat: true })]), T + ms);
                see(0, 100);
                b.setOrders({ phase: 'engage', focus: 7, reason: 'test' }, T);
                see(1000, 90);
                see(2000, 100);
                expect(contactOf(b, T + 2000)!.lossSince).toBeUndefined();
                see(3000, 95);
                expect(contactOf(b, T + 3000)).toMatchObject({ lossSince: T + 3000, lossFromHp: 100 });
            });

            test('the sighting carries the NPC\'s speed', () => {
                const o = observeState(makeState({ timestamp: T, player: makePlayer({ objectId: 100 }), nearbyPlayers: [], combatEvents: [], nearbyNpcs: [makeNpc({ objectId: 7, name: 'wolf', level: 6, speed: 128, inCombat: true })] }), self)!;
                expect(o.sightings[0]!.speed).toBe(128);
            });

            test('a longer hostileMs is not cut short, and a mob on someone else gets no extra time', () => {
                const longer = new Blackboard({ hostileMs: 8000 });
                longer.publish(obs(owner(T, petOf()), [sighting(7, { targetId: 500, inCombat: true })]), T);
                stillSees(longer, 500, 7500, 7);
                expect(contactOf(longer, T + 7900)!.threat).toBe(true);
                const other = new Blackboard({ hostileMs: 4000 });
                other.publish(obs(owner(T, petOf()), [sighting(7, { targetId: 11, inCombat: true }), sighting(8, { targetId: 500, inCombat: true })]), T);
                stillSees(other, 500, 4500, 7, 8);
                expect(contactOf(other, T + 4400, 7)!.threat).toBe(false);
                expect(contactOf(other, T + 4400, 8)!.threat).toBe(true);
            });
        });
    });
});

// The live RvR pass: a Midgard group (Petbon#431, Pethun#429) against Briton#427 (albion) with its necroservant#432, and Celt#428 (hibernia) with grove's hunter.
describe('RvR on the board', () => {
    const lookAs = (over: Partial<BotWorldState>) => observeState(makeState({ timestamp: T, player: makePlayer({ objectId: 431, realm: 'midgard' }), nearbyNpcs: [], nearbyPlayers: [], combatEvents: [], ...over }), self)!;
    const pethunNear = makePlayerObj({ objectId: 429, name: 'Pethun', realm: 'midgard' });
    const contactOf = (b: Blackboard, at: number, id: number) => b.picture(at).contacts.find(c => c.objectId === id);
    const petbon = (at: number) => report('Petbon', { at, objectId: 431, x: 1000 });
    const pethun = (at: number) => report('Pethun', { at, objectId: 429, x: 1100 });

    describe('a Necromancer in shade: "You can\'t attack a shadowed necromancer!" (AbstractServerRules.cs:449-455)', () => {
        const shade = (over: Partial<Sighting> = {}) => sighting(427, { kind: 'player', name: 'Briton', realm: 'albion', level: 20, isShade: true, ...over });

        test('the sighting carries what the client read; a plain player\'s has no such key', () => {
            const briton = (isShade?: boolean) => makePlayerObj({ objectId: 427, name: 'Briton', realm: 'albion', ...(isShade === undefined ? {} : { isShade }) });
            expect(lookAs({ nearbyPlayers: [briton(true)] }).sightings[0]).toMatchObject({ objectId: 427, isShade: true });
            expect(lookAs({ nearbyPlayers: [briton(false)] }).sightings[0]).not.toHaveProperty('isShade');
            expect(lookAs({ nearbyPlayers: [briton()] }).sightings[0]).not.toHaveProperty('isShade');
        });

        test('the contact carries it, and it is no threat even with a member on it: nothing can be done to it', () => {
            const b = new Blackboard();
            b.publish(obs(petbon(T), [shade({ targetId: 431, inCombat: true })]), T);
            expect(contactOf(b, T, 427)).toMatchObject({ isShade: true, threat: false, hostileSince: 0 });
            expect(untouchable(contactOf(b, T, 427)!, T)).toBe(true);
        });

        test('out of shade again it is a player like any other', () => {
            const b = new Blackboard();
            b.publish(obs(petbon(T), [shade()]), T);
            b.publish(obs(petbon(T + 1000), [sighting(427, { kind: 'player', name: 'Briton', realm: 'albion', level: 20, targetId: 431, inCombat: true })]), T + 1000);
            expect(contactOf(b, T + 1000, 427)).not.toHaveProperty('isShade');
            expect(contactOf(b, T + 1000, 427)!.threat).toBe(true);
            expect(untouchable(contactOf(b, T + 1000, 427)!, T + 1000)).toBe(false);
        });

        test('with no model to go by (an older client) the refusal marks it for 30 s, whatever the sightings say', () => {
            const b = new Blackboard();
            const seen = (ms: number) => b.publish(obs(petbon(T + ms), [sighting(427, { kind: 'player', name: 'Briton', realm: 'albion', level: 20, targetId: 431, inCombat: true })]), T + ms);
            seen(0);
            b.markUnattackable(427, 200, 30_000, T);
            seen(1000);
            expect(contactOf(b, T + 1000, 427)).toMatchObject({ unattackableUntil: T + 30_000, threat: false });
            expect(untouchable(contactOf(b, T + 1000, 427)!, T + 1000)).toBe(true);
            seen(30_000);
            const after = contactOf(b, T + 30_000, 427)!;
            expect(after).not.toHaveProperty('unattackableUntil');
            expect(after.threat).toBe(true);
            expect(untouchable(after, T + 30_000)).toBe(false);
        });
    });

    describe('an enemy caster pet\'s fire: "grove\'s hunter" shooting Pethun', () => {
        // Raw per client, run 20261103-175746: pethun [452,"grove's hunter",429,true,100], Petbon's stays [452,"grove's hunter",null,false,100].
        const entry = (over: Partial<NearbyNpc> = {}) => makeNpc({ objectId: 452, name: "grove's hunter", level: 17, realm: 'hibernia', isPet: true, ...over });
        const shot = (ago = 1500): CombatEvent => ({ id: 1, kind: 'spellEffect', attackerObjectId: 452, targetObjectId: 429, receivedAt: T - ago });
        const says = (targetId: number | null) => sighting(452, { name: "grove's hunter", level: 17, realm: 'hibernia', isPet: true, targetId, inCombat: targetId !== null });

        test('a client whose entry can\'t say reads the target from the combat events, as for a player', () => {
            expect(lookAs({ nearbyNpcs: [entry()], nearbyPlayers: [pethunNear], combatEvents: [shot()] }).sightings[0]!.targetId).toBe(429);
            // Its entry first: it is the newer word when it names one.
            expect(lookAs({ nearbyNpcs: [entry({ targetObjectId: 431, inCombat: true })], nearbyPlayers: [pethunNear], combatEvents: [shot()] }).sightings[0]!.targetId).toBe(431);
            // The aim lapses as a player's does.
            expect(lookAs({ nearbyNpcs: [entry()], nearbyPlayers: [pethunNear], combatEvents: [shot(6500)] }).sightings[0]!.targetId).toBeNull();
        });

        test('a monster\'s entry stays the word: a 0 there says it let go, and the run-in after a pet\'s death reads that (blackboard.ts PET_KILLER_RUN_IN_MS)', () => {
            const mob = makeNpc({ objectId: 7, name: 'wolf', level: 6 });
            const swing: CombatEvent = { id: 1, kind: 'melee', attackerObjectId: 7, targetObjectId: 429, result: 'hit', receivedAt: T - 1500 };
            expect(lookAs({ nearbyNpcs: [mob], nearbyPlayers: [pethunNear], combatEvents: [swing] }).sightings[0]!.targetId).toBeNull();
        });

        test.each([['Pethun last', [[429, 0], [null, 100]]], ['Petbon last', [[null, 0], [429, 100]]]] as const)('both publish orders read the same: %s', (_name, order) => {
            const b = new Blackboard({ hostileMs: 6000 });
            b.publish(obs(pethun(T - 1000)), T - 1000);
            b.publish(obs(petbon(T - 1000)), T - 1000);
            // Hit once from the client that can say, then whichever order, as the board's 500 ms tick would read it.
            b.publish(obs(pethun(T), [says(429)]), T);
            for (const [id, ms] of order) b.publish(obs(id === 429 ? pethun(T + 1 + ms) : petbon(T + 1 + ms), [says(id)]), T + 1 + ms);
            expect(contactOf(b, T + 200, 452)).toMatchObject({ targetId: 429, target: 'Pethun', threat: true });
        });

        test('the known target is kept while it is fresh and no longer: a sighting that can\'t say doesn\'t feed itself', () => {
            const b = new Blackboard({ hostileMs: 6000 });
            b.publish(obs(pethun(T - 1000)), T - 1000);
            b.publish(obs(pethun(T), [says(429)]), T);
            for (const ms of [1000, 2000, 3000, 4000, 5000]) b.publish(obs(petbon(T + ms), [says(null)]), T + ms);
            expect(contactOf(b, T + 5000, 452)).toMatchObject({ target: 'Pethun', threat: true });
            b.publish(obs(petbon(T + 6500), [says(null)]), T + 6500);
            expect(contactOf(b, T + 6500, 452)).toMatchObject({ targetId: null, target: null, threat: false });
        });

        test('on a member\'s pet too: targetPet holds through the same gap ("hits your hunter\'s pet", board tp null from +6.6 to +8.1 in r3)', () => {
            const b = new Blackboard({ hostileMs: 6000 });
            const withPet = (at: number) => report('Pethun', { at, objectId: 429, x: 1100, pet: { objectId: 431, name: "hunter's pet", level: 17, x: 1100, y: 1000, z: 0, hp: 90, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [] } });
            b.publish(obs(withPet(T - 1000)), T - 1000);
            b.publish(obs(withPet(T), [says(431)]), T);
            b.publish(obs(report('Petbon', { at: T + 2000, objectId: 777, x: 1000 }), [says(null)]), T + 2000);
            expect(contactOf(b, T + 2000, 452)).toMatchObject({ targetPet: 'Pethun', threat: true });
        });

        test('a monster on nobody after a reset still loses its target at once', () => {
            const b = new Blackboard({ hostileMs: 6000 });
            b.publish(obs(pethun(T - 1000)), T - 1000);
            b.publish(obs(pethun(T), [sighting(7, { targetId: 429, inCombat: true })]), T);
            b.publish(obs(petbon(T + 100), [sighting(7, { targetId: null, inCombat: false })]), T + 100);
            expect(contactOf(b, T + 100, 7)).toMatchObject({ targetId: null, target: null });
        });
    });

    describe('a rooted mob: a root leaves melee on anyone in reach', () => {
        const member = (at: number) => report('Petani', { at, objectId: 11, x: 1100 });
        const crab = (over: Partial<Sighting> = {}) => sighting(7, { name: 'water beetle', targetId: 11, inCombat: true, ...over });
        /** Rooted by the Druid at T ("The water beetle's feet are frozen to the ground!"), and sighted standing under it. */
        const under = (kind = 'root') => {
            const b = new Blackboard();
            const events: GroupEvent[] = [];
            b.onEvent(e => events.push(e));
            b.publish(obs(member(T), [crab()]), T);
            b.markCc(7, 200, 'Petdru', kind, 18_000, T);
            b.publish(obs(member(T + 300), [crab()]), T + 300);
            return { b, events };
        };
        const notes = (events: GroupEvent[]) => events.filter(e => e.kind === 'note').map(e => e.text);

        test('"The water beetle hits your hand for 25 damage!" is no broken root ("Petdru: root on water beetle broke", three times on a rock crab, 9 power each)', () => {
            const { b, events } = under();
            b.publish(obs(member(T + 4400), [crab({ swinging: true })]), T + 4400);
            b.publish(obs(member(T + 6000), [crab({ swinging: true })]), T + 6000);
            expect(notes(events)).toEqual([]);
            expect(contactOf(b, T + 6000, 7)!.cc).toMatchObject({ kind: 'root', by: 'Petdru' });
        });

        test('a mezzed one that swings has still broken', () => {
            const { b, events } = under('mezz');
            b.publish(obs(member(T + 4400), [crab({ swinging: true })]), T + 4400);
            expect(notes(events)).toEqual(['mezz on water beetle broke']);
            expect(contactOf(b, T + 4400, 7)!.cc).toBeNull();
        });

        test('a landed swing of a member\'s own breaks it (GameLiving.cs:1689-1694): "You hit the water beetle for 5 damage!"', () => {
            const { b, events } = under();
            b.publish({ ...obs(member(T + 4400), [crab({ swinging: true })]), ownSwings: [{ targetId: 7, at: T + 4400 }] }, T + 4400);
            expect(notes(events)).toEqual(['root on water beetle broke']);
            expect(contactOf(b, T + 4400, 7)!.cc).toBeNull();
        });

        test('one from before the mark, or on a mezz, does not: a mezz goes by the mob\'s own swing as ever', () => {
            const root = under();
            root.b.publish({ ...obs(member(T + 400), [crab()]), ownSwings: [{ targetId: 7, at: T + 400 }] }, T + 400);
            expect(contactOf(root.b, T + 400, 7)!.cc).not.toBeNull();
            const mezz = under('mezz');
            mezz.b.publish({ ...obs(member(T + 4400), [crab()]), ownSwings: [{ targetId: 7, at: T + 4400 }] }, T + 4400);
            expect(contactOf(mezz.b, T + 4400, 7)!.cc).not.toBeNull();
        });

        test('it moving ends it, measured from where it stood once the mark settled', () => {
            const { b, events } = under();
            b.publish(obs(member(T + 600), [crab({ x: 1550 })]), T + 600);
            expect(contactOf(b, T + 600, 7)!.cc).not.toBeNull();
            b.publish(obs(member(T + 1000), [crab({ x: 1660 })]), T + 1000);
            expect(notes(events)).toEqual(['root on water beetle broke']);
            expect(contactOf(b, T + 1000, 7)!.cc).toBeNull();
        });

        test('a mob still running when the root was marked settles first: its next stop is where it was rooted', () => {
            const b = new Blackboard();
            b.publish(obs(member(T), [crab()]), T);
            b.markCc(7, 200, 'Petdru', 'root', 18_000, T);
            b.publish(obs(member(T + 200), [crab({ x: 1600 })]), T + 200);
            b.publish(obs(member(T + 400), [crab({ x: 1700 })]), T + 400);
            b.publish(obs(member(T + 900), [crab({ x: 1700 })]), T + 900);
            expect(contactOf(b, T + 900, 7)!.cc).not.toBeNull();
        });

        test('it ends on its expiry, with no note', () => {
            const { b, events } = under();
            b.publish(obs(member(T + 18_000), [crab()]), T + 18_000);
            expect(contactOf(b, T + 18_000, 7)!.cc).toBeNull();
            expect(notes(events)).toEqual([]);
        });

        test('Observation.ownSwings: our own swing that landed, in the swing window; a miss, somebody else\'s or an older one is none', () => {
            const at = (by: number, result: CombatEvent['result'], ago = 500): CombatEvent => ({ id: 1, kind: 'melee', attackerObjectId: by, targetObjectId: 7, result, receivedAt: T - ago });
            const mob = makeNpc({ objectId: 7, name: 'water beetle', level: 6 });
            const swings = (e: CombatEvent) => lookAs({ nearbyNpcs: [mob], combatEvents: [e] }).ownSwings;
            expect(swings(at(431, 'hit'))).toEqual([{ targetId: 7, at: T - 500 }]);
            expect(swings(at(431, 'miss'))).toEqual([]);
            expect(swings(at(99, 'hit'))).toEqual([]);
            expect(swings(at(431, 'hit', 2500))).toEqual([]);
        });
    });

    describe('killerOf: the server names a pet\'s owner in the death (GameLiving.cs:1299-1300, :1370)', () => {
        const dead = makePlayer({ objectId: 429, realm: 'midgard', isDead: true });
        const servant = makeNpc({ objectId: 432, name: 'necroservant', level: 17, realm: 'albion', isPet: true });
        const briton = makePlayerObj({ objectId: 427, name: 'Briton', realm: 'albion' });
        const event = (kind: CombatEvent['kind'], by: number, ago: number): CombatEvent => ({ id: T - ago, kind, attackerObjectId: by, targetObjectId: 429, receivedAt: T - ago });
        const killer = (combatEvents: CombatEvent[], over: Partial<BotWorldState> = {}) => lookAs({ player: dead, nearbyNpcs: [servant], nearbyPlayers: [briton], combatEvents, ...over }).killer;
        const THE_PET: Killer = { name: 'necroservant', kind: 'npc', realm: 'albion', isPet: true };
        const THE_OWNER: Killer = { name: 'Briton', kind: 'player', realm: 'albion' };

        // "necroservant#432 -> Pethun#429 hit", "death Briton#427 -> Pethun#429", "Pethun was just killed by Petnec in Thidranki."
        test('every blow the pet\'s: the pet', () => {
            expect(killer([event('melee', 432, 3000), event('melee', 432, 300), event('death', 427, 100)])).toEqual(THE_PET);
        });

        test('a turret\'s spell too, its owner about 5900 away and out of view', () => {
            const turret = makeNpc({ objectId: 433, name: "grove's hunter", level: 17, realm: 'hibernia', isPet: true });
            expect(killer([event('spellEffect', 433, 300), event('death', 428, 100)], { nearbyNpcs: [turret], nearbyPlayers: [] })).toEqual({ name: "grove's hunter", kind: 'npc', realm: 'hibernia', isPet: true });
        });

        test('with the owner\'s own hit in the window: the owner, whichever came last', () => {
            expect(killer([event('spellEffect', 427, 8000), event('melee', 432, 300), event('death', 427, 100)])).toEqual(THE_OWNER);
            expect(killer([event('melee', 432, 3000), event('melee', 427, 300), event('death', 427, 100)])).toEqual(THE_OWNER);
        });

        test('a pet of another realm is not the one named: the named player', () => {
            const other = makeNpc({ objectId: 433, name: "grove's hunter", level: 17, realm: 'hibernia', isPet: true });
            expect(killer([event('melee', 433, 300), event('death', 427, 100)], { nearbyNpcs: [other] })).toEqual(THE_OWNER);
        });

        test('nor a keep guard or a monster, which have no owner', () => {
            const guard = makeNpc({ objectId: 434, name: 'Guard Ulf', level: 50, realm: 'albion' });
            expect(killer([event('melee', 434, 300), event('death', 427, 100)], { nearbyNpcs: [guard] })).toEqual(THE_OWNER);
        });

        test('a friend\'s heal after the blow changes nothing, and a blow after the death isn\'t what killed us', () => {
            const friend = makePlayerObj({ objectId: 431, name: 'Petbon', realm: 'midgard' });
            expect(killer([event('melee', 432, 800), event('spellEffect', 431, 300), event('death', 427, 100)], { nearbyPlayers: [briton, friend] })).toEqual(THE_PET);
            expect(killer([event('melee', 427, 800), event('death', 427, 300), event('melee', 432, 100)])).toEqual(THE_OWNER);
        });

        test('no hit seen at all: the name the server gave', () => {
            expect(killer([event('death', 427, 100)])).toEqual(THE_OWNER);
        });
    });

    describe('an enemy pet removed because its owner died (GamePlayer.cs:5988-5989): "death Pethun#429 -> Celt#428" then "death null -> #433"', () => {
        const celt = (over: Partial<Sighting> = {}) => sighting(428, { kind: 'player', name: 'Celt', realm: 'hibernia', level: 20, targetId: 429, inCombat: true, ...over });
        const turret = (hp: number) => sighting(433, { name: "grove's hunter", level: 17, realm: 'hibernia', isPet: true, hp, targetId: 429, inCombat: true });
        const fought = (...sightings: Sighting[]) => {
            const b = new Blackboard();
            const events: GroupEvent[] = [];
            b.onEvent(e => events.push(e));
            b.publish(obs(pethun(T), sightings), T);
            return { b, events };
        };
        const say = (events: GroupEvent[]) => events.filter(e => e.kind === 'kill' || e.kind === 'note').map(e => `${e.kind}: ${e.text}`);

        test('no kill in the fight ("kills 3" for 2 players, the turret at 74 %), with the owner\'s death in the same tick or the tick before', () => {
            const one = fought(celt(), turret(74));
            one.b.publish(obs(pethun(T + 250), [], [428, 433]), T + 250);
            expect(say(one.events)).toEqual(['kill: Celt (L20) died', "note: grove's hunter (L17) went with its owner"]);
            const two = fought(celt(), turret(74));
            two.b.publish(obs(pethun(T + 250), [turret(74)], [428]), T + 250);
            two.b.publish(obs(pethun(T + 500), [], [433]), T + 500);
            expect(say(two.events)).toEqual(['kill: Celt (L20) died', "note: grove's hunter (L17) went with its owner"]);
        });

        test('whatever order the snapshot lists them in', () => {
            const { b, events } = fought(celt(), turret(74));
            b.publish(obs(pethun(T + 250), [], [433, 428]), T + 250);
            expect(say(events)).toEqual(['kill: Celt (L20) died', "note: grove's hunter (L17) went with its owner"]);
        });

        test('one the group killed itself is a kill: near 0 with a hit of ours on it, or with no such death beside it', () => {
            const low = fought(celt(), turret(3));
            low.b.publish({ ...obs(pethun(T + 250), [], [428, 433]), petHits: [433] }, T + 250);
            expect(say(low.events)).toEqual(['kill: Celt (L20) died', "kill: grove's hunter (L17) died"]);
            const alone = fought(turret(30));
            alone.b.publish({ ...obs(pethun(T + 250), [], [433]), petHits: [433] }, T + 250);
            expect(say(alone.events)).toEqual(["kill: grove's hunter (L17) died"]);
        });

        test('nor does a player of another realm dying beside it, or an owner who died a while ago', () => {
            const other = fought(sighting(427, { kind: 'player', name: 'Briton', realm: 'albion', level: 20, targetId: 429, inCombat: true }), turret(30));
            other.b.publish({ ...obs(pethun(T + 250), [], [427, 433]), petHits: [433] }, T + 250);
            expect(say(other.events)).toEqual(['kill: Briton (L20) died', "kill: grove's hunter (L17) died"]);
            const before = fought(celt(), turret(30));
            before.b.publish(obs(pethun(T + 250), [turret(30)], [428]), T + 250);
            before.b.publish({ ...obs(pethun(T + 5000), [], [433]), petHits: [433] }, T + 5000);
            expect(say(before.events)).toEqual(['kill: Celt (L20) died', "kill: grove's hunter (L17) died"]);
        });
    });
});

describe('a pet on a rooted lone focus: the rule let it go in, so nothing was broken', () => {
    // 20261104-054051: '05:41:10.757 feet are frozen', '05:41:11.257 You command the minor nature spirit to kill your target!', '05:41:13.857 ... hits for 10', timeline 'Petdru's pet broke the root on water beetle', Broke cc 2, and pet-mezz said to look for what got round petControl.
    // 20261104-050645: '00:53 engage on Celt: ... 0 of 1 enemy vs 2', '00:56 Rebon: Rebon's pet broke the root on Celt', Pets table 'Broke cc 1'.
    const ME = 11;
    const petOf = (targetId: number | null): PetReport => ({ objectId: 500, name: 'minor nature spirit', level: 7, x: 1000, y: 1000, z: 0, hp: 90, targetId, inCombat: true, aggression: 'defensive', walk: 'follow', icons: [] });
    const druid = (at: number) => report('Petdru', { at, objectId: ME, pet: petOf(7) });
    const beetle = (over: Partial<Sighting> = {}) => sighting(7, { name: 'water beetle', targetId: ME, inCombat: true, ...over });
    const add = () => sighting(8, { name: 'moss sheerie', targetId: ME, inCombat: true, x: 1600 });
    const swung = (kind: string, o: { focus?: number; others?: Sighting[]; addCc?: boolean } = {}) => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.setOrders({ phase: 'engage', focus: o.focus ?? 7, cc: [], reason: 'test' }, T);
        b.publish(obs(druid(T), [beetle(), ...(o.others ?? [])]), T);
        b.markCc(7, 200, 'Petdru', kind, 60_000, T);
        if (o.addCc) b.markCc(8, 200, 'Oisin', 'mezz', 60_000, T);
        b.publish({ ...obs(druid(T + 3000), [beetle(), ...(o.others ?? [])]), petSwings: [{ targetId: 7, at: T + 2900, landed: true }] }, T + 3000);
        return { b, events, counted: events.filter(e => e.data?.petBrokeCc) };
    };
    const onBeetle = (b: Blackboard) => b.picture(T + 3000).contacts.find(c => c.objectId === 7)!;

    test('a root on the focus with nothing else free is no broken crowd control, and the timeline doesn\'t call it one', () => {
        const { b, events, counted } = swung('root');
        expect(counted).toEqual([]);
        expect(events.filter(e => e.kind === 'note' && e.text.includes('\'s pet broke'))).toEqual([]);
        // It is off all the same: the hit ended it (GameLiving.cs:1689-1694).
        expect(onBeetle(b).cc).toBeNull();
    });

    test('so the report has no Broke cc and no pet-mezz', () => {
        const { b, events } = swung('root');
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T - 1000 });
        o.sample(b.picture(T + 3000));
        for (const e of events) o.handle(e);
        const r = o.report();
        expect(r.members.Petdru!.pet!.brokeCc).toBe(0);
        expect(r.findings.map(f => f.topic)).not.toContain('pet-mezz');
    });

    test('with something else free the root still held at the swing: that counts', () => {
        expect(swung('root', { others: [add()] }).counted).toMatchObject([{ text: 'Petdru\'s pet broke the root on water beetle', data: { petBrokeCc: true, kind: 'root' } }]);
    });

    test('an add under crowd control of its own is nothing free', () => {
        expect(swung('root', { others: [add()], addCc: true }).counted).toEqual([]);
    });

    test('a root on an add counts: it isn\'t the focus', () => {
        expect(swung('root', { focus: 8, others: [add()] }).counted.length).toBe(1);
    });

    test('a mezz always counts, lone focus or not', () => {
        expect(swung('mezz').counted).toMatchObject([{ text: 'Petdru\'s pet broke the mezz on water beetle' }]);
    });
});

describe('a slow pet killer\'s run-in goes by its distance and its hurt speed', () => {
    // 20261104-052514: pet lost 05:26:10.407, threat gone 05:26:25.751, '05:26:25.952 You begin casting a Ruby Simulacrum spell!', '05:26:29.381 Growler hits your torso for 37 (-2) damage!'. Growler at 19-23 %: 150 x (0.2 + 0.21 x 2.42) = 106 units/s.
    const PET: PetReport = { objectId: 500, name: 'ruby simulacrum', level: 7, x: 1000, y: 1000, z: 0, hp: 40, targetId: 7, inCombat: true, aggression: 'defensive', walk: 'follow', icons: [] };
    const owner = (at: number, pet: PetReport | null, x = 1000) => report('Petcab', { at, objectId: 11, x, y: 1000, pet });
    const growler = (x: number, over: Partial<Sighting> = {}) => sighting(7, { name: 'Growler', hp: 21, x, y: 1000, targetId: null, inCombat: true, speed: 106, ...over });
    const lost = (from: number) => {
        const b = new Blackboard({ hostileMs: 4000 });
        b.publish(obs(owner(T, PET), [growler(from, { targetId: 500 })]), T);
        // It idles about 1 s reading no combat, and runs.
        b.publish(obs(owner(T + 400, null), [growler(from, { inCombat: false })]), T + 400);
        b.publish(obs(owner(T + 900, null), [growler(from, { inCombat: false })]), T + 900);
        return b;
    };
    const threat = (b: Blackboard, at: number) => b.picture(at).contacts.find(c => c.objectId === 7)!.threat;

    test('still a threat 18 s on, where the flat 15 s let a summon start four seconds before it arrived', () => {
        const b = lost(3000);
        for (let ms = 1000; ms <= 18_500; ms += 500) b.publish(obs(owner(T + ms, null), [growler(3000 - 0.106 * ms)]), T + ms);
        expect(threat(b, T + 15_600)).toBe(true);
        expect(threat(b, T + 18_600)).toBe(true);
        b.publish(obs(owner(T + 19_000, null), [growler(1050, { targetId: 11, swinging: true })]), T + 19_000);
        expect(b.picture(T + 19_000).contacts[0]).toMatchObject({ threat: true, target: 'Petcab' });
    });

    test('a hurt one\'s first estimate alone covers what a full-health one\'s doesn\'t', () => {
        // No sighting for a while after the loss: 2000 at 21 % is 21 s, against 15 s.
        const b = lost(3000);
        for (let ms = 1000; ms <= 15_000; ms += 500) b.publish(obs(owner(T + ms, null), [growler(3000 - 0.106 * ms)]), T + ms);
        b.publish(obs(owner(T + 15_800, null), [growler(1400)]), T + 15_800);
        expect(threat(b, T + 15_900)).toBe(true);
    });

    test('a reading that says it let go ends it, however far it had to come', () => {
        const b = lost(3000);
        b.publish(obs(owner(T + 1000, null), [growler(2900)]), T + 1000);
        for (let ms = 1500; ms <= 8000; ms += 500) b.publish(obs(owner(T + ms, null), [growler(3000, { inCombat: false })]), T + ms);
        expect(threat(b, T + 8000)).toBe(false);
    });
});

describe('a root read broken by position: only from a sighting newer than the root', () => {
    // 20261104-052629: '05:28:05.098 The moss sheerie's feet are frozen to the ground!', log '05:28:08 Petdru: root on moss sheerie broke', and the server's own line only at '05:28:13.264 ... The moss sheerie can move normally again.'
    // A moving NPC is reckoned on toward its last 0xA1's destination at its last speed (WorldModel.npcPosition) until the next 0xA1.
    const member = (at: number) => report('Petdru', { at, objectId: 11, x: 1100 });
    const sheerie = (over: Partial<Sighting> = {}) => sighting(7, { name: 'moss sheerie', targetId: 11, inCombat: true, ...over });
    const rooted = () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish(obs(member(T), [sheerie({ x: 1500, speed: 150, fixedAt: T - 100 })]), T);
        b.markCc(7, 200, 'Petdru', 'root', 40_000, T);
        return { b, notes: () => events.filter(e => e.kind === 'note').map(e => e.text), cc: (at: number) => b.picture(at).contacts[0]!.cc };
    };

    test('reckoned on from before the root, it still stands rooted however far that reads', () => {
        const { b, notes, cc } = rooted();
        for (let ms = 250; ms <= 3000; ms += 250) b.publish(obs(member(T + ms), [sheerie({ x: 1500 + 0.15 * ms, speed: 150, fixedAt: T - 100 })]), T + ms);
        expect(notes()).toEqual([]);
        expect(cc(T + 3000)).toMatchObject({ kind: 'root' });
    });

    test('the update that says it stopped is where it was rooted, however far from the reckoning', () => {
        const { b, notes, cc } = rooted();
        b.publish(obs(member(T + 800), [sheerie({ x: 1620, speed: 150, fixedAt: T - 100 })]), T + 800);
        b.publish(obs(member(T + 1000), [sheerie({ x: 1520, speed: 0 })]), T + 1000);
        b.publish(obs(member(T + 2000), [sheerie({ x: 1525, speed: 0 })]), T + 2000);
        expect(notes()).toEqual([]);
        expect(cc(T + 2000)).toMatchObject({ kind: 'root' });
    });

    test('an update newer than the root that has it running is a broken root', () => {
        const { b, notes, cc } = rooted();
        b.publish(obs(member(T + 1000), [sheerie({ x: 1520, speed: 0 })]), T + 1000);
        b.publish(obs(member(T + 4000), [sheerie({ x: 1700, speed: 150, fixedAt: T + 3900 })]), T + 4000);
        expect(notes()).toEqual(['root on moss sheerie broke']);
        expect(cc(T + 4000)).toBeNull();
    });

    test('an update within a snapshot of the root can still be the run: not one to measure by', () => {
        const { b, notes } = rooted();
        b.publish(obs(member(T + 200), [sheerie({ x: 1800, speed: 150, fixedAt: T + 100 })]), T + 200);
        expect(notes()).toEqual([]);
    });

    test('observeState says when the position of a moving one was sent; one standing reads as it is', () => {
        const state = makeState({
            timestamp: T, inGame: true, player: makePlayer({ objectId: 11, name: 'Petdru', regionId: 1 }), pet: null, nearbyPlayers: [], combatEvents: [], gameMessages: [],
            nearbyNpcs: [makeNpc({ objectId: 7, name: 'moss sheerie', level: 10, speed: 150, lastSeenAgo: 900 }), makeNpc({ objectId: 8, name: 'rock crab', level: 10, speed: 0, lastSeenAgo: 900 })],
        });
        const seen = observeState(state, self)!.sightings;
        expect(seen.find(s => s.objectId === 7)!.fixedAt).toBe(T - 900);
        expect(seen.find(s => s.objectId === 8)!.fixedAt).toBeUndefined();
    });
});

describe('an enemy pet lost for other reasons is no kill', () => {
    // 20261104-043622: servant at 100 % 1950 from its owner, 'You have lost your bond to your servant.', 'death null -> #422', timeline '00:23 Rehea: necroservant (L21) died', fight 'Celt / necroservant: won in 16 s, kills 2' for 1 player. The tether is NecromancerPetBrain.cs:301 (2000).
    // An NPC's death event names no attacker (world-model.ts, 0xA2): only a player's does.
    const rehea = (at: number) => report('Rehea', { at, objectId: 11, x: 1100 });
    const servant = (hp: number) => sighting(422, { name: 'necroservant', level: 21, realm: 'midgard', isPet: true, hp, targetId: 11, inCombat: true });
    const said = (e: GroupEvent[]) => e.filter(x => x.kind === 'kill' || x.kind === 'note').map(x => `${x.kind}: ${x.text}`);
    const gone = (hp: number, o: { hitAt?: number; diesAt?: number } = {}) => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish(obs(rehea(T), [servant(hp)]), T);
        if (o.hitAt !== undefined) b.publish({ ...obs(rehea(o.hitAt), [servant(hp)]), petHits: [422] }, o.hitAt);
        const at = o.diesAt ?? T + 500;
        b.publish(obs(rehea(at), [], [422]), at);
        return said(events);
    };

    test('at 100 %, or at half, with an empty death: a note', () => {
        expect(gone(100)).toEqual(['note: necroservant (L21) was lost, no kill of ours']);
        expect(gone(50, { hitAt: T + 400 })).toEqual(['note: necroservant (L21) was lost, no kill of ours']);
    });

    test('hurt, and nobody of ours hit it lately: a note', () => {
        expect(gone(30)).toEqual(['note: necroservant (L21) was lost, no kill of ours']);
        expect(gone(30, { hitAt: T + 100, diesAt: T + 5000 })).toEqual(['note: necroservant (L21) was lost, no kill of ours']);
    });

    test('hurt, with a hit of ours just now: a kill, still marked as a pet', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish({ ...obs(rehea(T), [servant(30)]), petHits: [422] }, T);
        b.publish(obs(rehea(T + 500), [], [422]), T + 500);
        expect(said(events)).toEqual(['kill: necroservant (L21) died']);
        expect(events.find(e => e.kind === 'kill')!.data).toMatchObject({ pet: true });
    });

    test('a monster is none of this: its death with nobody\'s hit reported is a kill as ever', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish(obs(rehea(T), [sighting(7, { name: 'wolf', targetId: 11, inCombat: true })]), T);
        b.publish(obs(rehea(T + 500), [], [7]), T + 500);
        expect(said(events)).toEqual(['kill: wolf (L6) died']);
    });

    test('observeState: what we and our pets landed on an enemy pet lately; a miss did nothing, and a monster isn\'t one', () => {
        const blow = (attackerObjectId: number, targetObjectId: number, over: Partial<CombatEvent> = {}): CombatEvent => ({ id: 1, kind: 'melee', attackerObjectId, targetObjectId, result: 'hit', receivedAt: T - 100, ...over });
        const look = (events: CombatEvent[]) => observeState(makeState({
            timestamp: T, inGame: true, player: makePlayer({ objectId: 11, name: 'Rehea', regionId: 1, realm: 'albion' }), pet: { objectId: 500, name: 'pet', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null }, nearbyPlayers: [], combatEvents: events, gameMessages: [],
            nearbyNpcs: [makeNpc({ objectId: 500, name: 'pet', realm: 'albion', isPet: true }), makeNpc({ objectId: 422, name: 'necroservant', realm: 'midgard', isPet: true, level: 21 }), makeNpc({ objectId: 7, name: 'wolf', level: 6 })],
        }), self)!.petHits;
        expect(look([blow(11, 422)])).toEqual([422]);
        expect(look([blow(500, 422)])).toEqual([422]);
        expect(look([blow(11, 422, { kind: 'spellEffect', result: undefined })])).toEqual([422]);
        expect(look([blow(11, 422, { result: 'miss' })])).toBeUndefined();
        expect(look([blow(11, 7)])).toBeUndefined();
        expect(look([blow(11, 422, { receivedAt: T - 60_000 })])).toBeUndefined();
    });
});
