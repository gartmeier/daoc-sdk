// What a member's client makes of the packets, on through observeState to the board and what reads it: real WorldModels, each with the
// packets the server sends everyone in view, so that a rule in the model and one on the board can't each pass alone and undo each other.
import { describe, expect, test } from 'bun:test';
import { WorldModel } from '../../client/model/world-model';
import { PacketWriter } from '../../client/protocol/buffer';
import { ServerOp } from '../../client/protocol/opcodes';
import { makePlayer, makeState } from '../test/fixtures';
import { flee, onMember, peelTarget, pull } from './behaviors';
import { Blackboard, emptyOrders, observeState } from './blackboard';
import { decidePve, PVE_SETTINGS } from './pve';
import type { Contact } from './types';

const W = () => new PacketWriter();
const ME = { x: 574797, y: 530161, z: 2896 };
const FAR = 900;
const npcCreate = (oid: number, name: string, x: number, y: number, o: { level?: number; pet?: boolean; realm?: number } = {}) =>
    W().u16(oid).u16(0).u16(0).u16(ME.z).u32(x).u32(y).u16(0).u16(400).u8(50).u8(o.level ?? 5).u8((o.realm ?? 0) << 6).u8(0x20).u8(o.pet ? 0x80 : 0).u8(0).u16(0).pascal(name).pascal('').u8(0).toBytes();
const playerCreate = (oid: number, session: number, name: string, realm: number) =>
    W().f32le(ME.x + 50).f32le(ME.y).f32le(ME.z).u16(session).u16(oid).u16(0).u16(32).u8(5).u8(realm << 2).fill(0, 10).pascal(name).pascal('').pascal('').pascal('').pascal('').u8(0).toBytes();
const objectUpdate = (oid: number, targetId: number, hp = 100) =>
    W().u16(0).u16(0).u16(ME.x + FAR - 548864).u16(0).u16(ME.y - 483328).u16(0).u16(ME.z).u16(0).u16(oid).u16(targetId).u8(hp).u8(0).u8(0).u8(0).toBytes();
const blow = (attacker: number, defender: number, result: number, hp = 90) => W().u16(attacker).u16(defender).u16(3).u16(0).u16le(0).u8(0).u8(result).u8(hp).u8(0).toBytes();
const SWING = 10, SPELL_DAMAGE = 0x14;
const castAnimation = (caster: number) => W().u16(caster).u16(5208).u16(30).u16(0).toBytes();
const spellEffect = (caster: number, target: number) => W().u16(caster).u16(5208).u16(target).u16(0).u8(0).u8(1).toBytes();
const petWindow = (oid: number) => W().u16(oid).u8(0).u8(0).u8(2).u8(2).u8(1).u8(0).u8(0).toBytes();

const MOB = 500, X = 11, Y = 22, T = 33;
const NAMES: Record<number, string> = { [X]: 'Xenia', [Y]: 'Yorick', [T]: 'Tank' };
const START = 1_000_000;

/** A group on one spot, a mob 900 off. Its own clock, its own models. */
function group(ids: number[]) {
    let now = START;
    const team = ids.map(id => {
        const m = new WorldModel({ onSignificant: () => {} }, () => now);
        m.self.objectId = id;
        m.self.realm = 1;
        ids.forEach((o, j) => { if (o !== id) m.handle(ServerOp.PlayerCreate172, playerCreate(o, 50 + j, NAMES[o]!, 1)); });
        m.handle(ServerOp.NPCCreate, npcCreate(MOB, 'caster mob', ME.x + FAR, ME.y));
        return { id, name: NAMES[id]!, m };
    });
    type Who = (typeof team)[number];
    const board = new Blackboard();
    const stateOf = (x: Who) => makeState({
        timestamp: now, player: makePlayer({ objectId: x.id, name: x.name, realm: 'albion', x: ME.x, y: ME.y, z: ME.z, regionId: 1, level: 5, healthPercent: 80 }),
        nearbyNpcs: x.m.nearbyNpcs(ME), nearbyPlayers: x.m.nearbyPlayers(ME), nearbyObjects: [], combatEvents: x.m.combatEvents.slice(), pet: x.m.pet, summons: [...x.m.summons.keys()], gameMessages: [], effects: [],
    });
    const publish = (x: Who) => board.publish(observeState(stateOf(x), { bot: x.name.toLowerCase(), role: x.id === T ? 'tank' : 'nuker', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [] } })!, now);
    return {
        team, board, publish, stateOf,
        at: () => now,
        advance: (ms: number) => { now += ms; },
        /** What every client in view gets. */
        all: (op: number, bytes: Uint8Array) => { for (const x of team) x.m.handle(op, bytes); },
        mob: () => board.picture(now).contacts.find(c => c.objectId === MOB) as Contact,
    };
}

/** A stand-in MemberContext over the real board, for what reads the contact. */
function memberOf(g: ReturnType<typeof group>, x: ReturnType<typeof group>['team'][number], orders: object, settings: object = {}) {
    const calls: string[] = [];
    const me = makePlayer({ objectId: x.id, name: x.name, realm: 'albion', x: ME.x, y: ME.y, z: ME.z, regionId: 1 });
    const pic = () => g.board.picture(g.at());
    const ctx = {
        name: x.name, role: x.id === T ? 'tank' : 'nuker', settings: { combatRange: {}, ...settings }, memory: new Map(), isTank: () => x.id === T,
        tank: () => { const r = pic().members.find(m => m.role === 'tank'); return r ? { ...r, x: ME.x - 1000 } : r; },
        me: () => me, picture: pic, members: () => pic().members, orders: () => orders,
        focus: () => pic().contacts.find(c => c.objectId === (orders as { focus?: number }).focus),
        threats: () => pic().contacts.filter(c => c.threat),
        contact: (id: number) => pic().contacts.find(c => c.objectId === id),
        skip: (why: string) => { calls.push(`skip ${why}`); return false; },
        doing: (k: string) => { calls.push(k); },
        result: () => {},
        sdk: { getNearbyNpc: (id: number) => x.m.nearbyNpcs(ME).find(n => n.objectId === id), sendAttack: async () => ({ success: true }), getState: () => g.stateOf(x), waitForCondition: async () => null },
        bot: {
            walkTo: async (px: number, py: number) => { calls.push(`walkTo ${Math.round(px - ME.x)},${Math.round(py - ME.y)}`); return { success: true }; },
            attack: async (id: number) => { calls.push(`attack ${id}`); return { success: true }; },
        },
    };
    return { ctx: ctx as any, calls };
}

/** Its 0x72, its cast later the spell's 0x1B on `victim`, and then 0xA1's 0 (PacketLib168.cs:820-828: a timed cast leaves attack state). */
function casts(g: ReturnType<typeof group>, victim: number) {
    g.all(ServerOp.SpellCastAnimation, castAnimation(MOB));
    g.advance(2500);
    g.all(ServerOp.SpellEffectAnimation, spellEffect(MOB, victim));
    g.advance(250);
    g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
}

describe('a monster casting from range, as its victim\'s own client reads it', () => {
    test('the victim\'s report reads by spell, as the others\' do, and the flag doesn\'t flip with who reported last', () => {
        const g = group([X, Y, T]);
        for (const x of g.team) g.publish(x);
        for (let cast = 0; cast < 3; cast++) {
            casts(g, X);
            for (const x of g.team) {
                g.publish(x);
                expect(g.mob()).toMatchObject({ target: 'Xenia', targetBySpell: true, threat: true });
                g.advance(60);
            }
        }
    });

    test('so the healer doesn\'t walk to the tank, and the tank\'s peel keeps its limits: "flee() and position() don\'t react to a target by spell beyond melee reach"', async () => {
        const g = group([X, T]);
        for (const x of g.team) g.publish(x);
        casts(g, X);
        g.publish(g.team[0]!);
        expect(onMember(g.mob(), { name: 'Xenia', x: ME.x, y: ME.y })).toBe(false);
        const healer = memberOf(g, g.team[0]!, { phase: 'engage', focus: 999, cc: [], anchor: null });
        expect(await flee().run(healer.ctx)).toBe(false);
        expect(healer.calls).toEqual([]);
        // Beyond the leash: casterToPeel says no to one by spell, and only that.
        const tank = memberOf(g, g.team[1]!, { phase: 'engage', focus: 999, cc: [], anchor: { x: ME.x + FAR + 5000, y: ME.y } }, { chaseLeash: 2000, peelAfterMs: 4000 });
        expect(peelTarget(tank.ctx)).toBeNull();
    });

    test('the puller alone in view hits it rather than walking back without it', async () => {
        const g = group([X]);
        g.publish(g.team[0]!);
        casts(g, X);
        g.publish(g.team[0]!);
        expect(g.mob()).toMatchObject({ target: 'Xenia', targetBySpell: true });
        const puller = memberOf(g, g.team[0]!, { phase: 'pull', focus: MOB, puller: 'Xenia', cc: [], anchor: { x: ME.x - 3000, y: ME.y } }, { pullDistance: 700 });
        await pull().run(puller.ctx);
        expect(puller.calls).toContain(`attack ${MOB}`);
        expect(puller.calls.some(c => c.startsWith('walkTo'))).toBe(false);
    });

    test('a damage spell\'s 0xBC before the 0xA1 reads the same: no moment of a server\'s target', async () => {
        const g = group([X, T]);
        for (const x of g.team) g.publish(x);
        g.all(ServerOp.SpellCastAnimation, castAnimation(MOB));
        g.advance(2500);
        g.all(ServerOp.CombatAnimation, blow(MOB, X, SPELL_DAMAGE));
        g.all(ServerOp.SpellEffectAnimation, spellEffect(MOB, X));
        g.publish(g.team[0]!);
        expect(g.mob()).toMatchObject({ target: 'Xenia', targetBySpell: true });
    });

    test('on a member\'s pet the same: on it by spell, a threat, for the owner\'s report too', () => {
        const PET = 600;
        const g = group([X, Y]);
        g.all(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 50, ME.y, { pet: true, realm: 1 }));
        g.team[0]!.m.handle(ServerOp.PetWindow, petWindow(PET));
        for (const x of g.team) g.publish(x);
        casts(g, PET);
        for (const x of g.team) {
            g.publish(x);
            expect(g.mob()).toMatchObject({ targetPet: 'Xenia', targetBySpell: true, threat: true });
        }
    });

    test('its own client still names it, for what isn\'t the board: the pet work\'s hold through a 0, for 6 s', () => {
        const g = group([X]);
        casts(g, X);
        const entry = () => g.team[0]!.m.nearbyNpcs(ME).find(n => n.objectId === MOB)!;
        expect(entry()).toMatchObject({ targetObjectId: X, targetBySpell: true });
        g.advance(5751);
        g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
        expect(entry().targetObjectId).toBeNull();
        expect(entry().targetBySpell).toBeUndefined();
    });

    describe('what does read as the server\'s, on that client too', () => {
        test('it runs: 65535 after its spell (a tomte mystic lands its DoT, then comes), so walking off still means something', () => {
            const g = group([X, T]);
            for (const x of g.team) g.publish(x);
            g.all(ServerOp.SpellEffectAnimation, spellEffect(MOB, X));
            g.advance(250);
            g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, 0xFFFF));
            g.publish(g.team[0]!);
            expect(g.team[0]!.m.nearbyNpcs(ME).find(n => n.objectId === MOB)).toMatchObject({ targetObjectId: X, inCombat: true });
            expect(g.mob().target).toBe('Xenia');
            expect(g.mob().targetBySpell).toBe(false);
            expect(onMember(g.mob(), { name: 'Xenia', x: ME.x, y: ME.y })).toBe(true);
        });

        test('the server names it after the spell: its word goes', () => {
            const g = group([X]);
            casts(g, X);
            g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, X));
            g.publish(g.team[0]!);
            expect(g.mob()).toMatchObject({ target: 'Xenia', targetBySpell: false });
        });

        test('it swings', () => {
            const g = group([X]);
            casts(g, X);
            g.all(ServerOp.CombatAnimation, blow(MOB, X, SWING));
            g.publish(g.team[0]!);
            expect(g.mob()).toMatchObject({ target: 'Xenia', targetBySpell: false });
        });

        test('a DoT\'s tick from one named already changes nothing', () => {
            const g = group([X]);
            g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, X));
            g.all(ServerOp.CombatAnimation, blow(MOB, X, SPELL_DAMAGE));
            g.publish(g.team[0]!);
            expect(g.mob()).toMatchObject({ target: 'Xenia', targetBySpell: false });
        });
    });

    describe('a mezz on it: "at most 6 s after the mezz", on the victim\'s client too', () => {
        for (const before of [250, 1000, 3000]) {
            test(`its spell ${before} ms before the mezz`, () => {
                const g = group([X, Y]);
                for (const x of g.team) g.publish(x);
                g.all(ServerOp.SpellEffectAnimation, spellEffect(MOB, X));
                g.advance(before);
                g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                for (const x of g.team) g.publish(x);
                g.board.markCc(MOB, 1, 'Yorick', 'mezz', 30_000, g.at());
                const mezzed = g.at();
                let lastThreat = 0;
                for (let d = 250; d <= 12_000; d += 250) {
                    g.advance(250);
                    g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                    for (const x of g.team) g.publish(x);
                    if (g.mob().threat) lastThreat = d;
                    expect(g.mob().cc?.kind).toBe('mezz');
                }
                expect(lastThreat).toBeLessThanOrEqual(6000);
                expect(g.at() - mezzed).toBe(12_000);
            });
        }

        test('so the group kills what is free, and doesn\'t wake it for want of anything else while it thinks it a threat', () => {
            const g = group([X, Y]);
            for (const x of g.team) g.publish(x);
            g.all(ServerOp.SpellEffectAnimation, spellEffect(MOB, X));
            g.advance(250);
            g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
            for (const x of g.team) g.publish(x);
            g.board.markCc(MOB, 1, 'Yorick', 'mezz', 30_000, g.at());
            for (let d = 0; d < 7000; d += 250) {
                g.advance(250);
                g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, 0));
                for (const x of g.team) g.publish(x);
            }
            expect(g.mob().target).toBeNull();
            expect(g.mob().threat).toBe(false);
        });
    });
});

describe('a monster on someone else\'s pet is someone else\'s fight', () => {
    const PET = 600, STRANGER_PET = 601, ENEMY_PET = 602, STRANGER = 77;
    /** A monster's swing, the 0xBC and the 0xA1, seen by all of us. */
    function swingsAt(victim: number, setup: (g: ReturnType<typeof group>) => void = () => {}) {
        const g = group([X, Y]);
        setup(g);
        for (const x of g.team) g.publish(x);
        g.advance(100);
        g.all(ServerOp.CombatAnimation, blow(MOB, victim, SWING));
        g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, victim));
        for (const x of g.team) g.publish(x);
        return { g, u: () => decidePve({ picture: g.board.picture(g.at()), orders: emptyOrders(g.at()), memory: {}, settings: PVE_SETTINGS, now: g.at(), windingDown: false } as any) };
    }
    const strangerPet = (g: ReturnType<typeof group>) => g.all(ServerOp.NPCCreate, npcCreate(STRANGER_PET, 'spirit', ME.x + 880, ME.y, { pet: true, realm: 1 }));
    const enemyPet = (g: ReturnType<typeof group>) => g.all(ServerOp.NPCCreate, npcCreate(ENEMY_PET, 'necroservant', ME.x + 880, ME.y, { pet: true, realm: 3 }));

    test('a same-realm stranger\'s pet, as for the stranger himself', () => {
        const pet = swingsAt(STRANGER_PET, strangerPet);
        expect(pet.g.mob().threat).toBe(false);
        expect(pet.u().focus ?? null).toBeNull();
        const himself = swingsAt(STRANGER, g => g.all(ServerOp.PlayerCreate172, playerCreate(STRANGER, 77, 'Stranger', 1)));
        expect(himself.g.mob().threat).toBe(false);
    });

    test('an enemy player\'s pet', () => {
        expect(swingsAt(ENEMY_PET, enemyPet).g.mob().threat).toBe(false);
    });

    test('a pet that stepped in front of its owner: the 0xBC names it (AttackComponent.cs:1492-1498), and the mob was on a stranger all along', () => {
        const { g } = swingsAt(STRANGER, g => { g.all(ServerOp.PlayerCreate172, playerCreate(STRANGER, 77, 'Stranger', 1)); strangerPet(g); });
        g.all(ServerOp.CombatAnimation, blow(MOB, STRANGER_PET, SWING));
        for (const x of g.team) g.publish(x);
        g.advance(4001);
        g.all(ServerOp.CombatAnimation, blow(MOB, STRANGER_PET, SWING));
        for (const x of g.team) g.publish(x);
        expect(g.mob().threat).toBe(false);
    });

    test('a member\'s pet is ours: on its owner\'s client and on a groupmate\'s, who has it as any other pet', () => {
        const { g, u } = swingsAt(PET, g => {
            g.all(ServerOp.NPCCreate, npcCreate(PET, 'wolf', ME.x + 880, ME.y, { pet: true, realm: 1 }));
            g.team[0]!.m.handle(ServerOp.PetWindow, petWindow(PET));
        });
        expect(g.mob()).toMatchObject({ targetPet: 'Xenia', threat: true });
        expect(u().phase).toBe('engage');
    });

    test('a swing on something we have no entry for still counts, as main\'s board has it', () => {
        expect(swingsAt(900).g.mob().threat).toBe(true);
    });

    test('the group fighting it, or it hitting a member, still makes it a threat', () => {
        const { g } = swingsAt(STRANGER_PET, strangerPet);
        g.all(ServerOp.CombatAnimation, blow(MOB, X, SWING));
        g.all(ServerOp.ObjectUpdate, objectUpdate(MOB, X));
        for (const x of g.team) g.publish(x);
        expect(g.mob()).toMatchObject({ target: 'Xenia', threat: true });
    });
});
