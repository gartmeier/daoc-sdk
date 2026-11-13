import { describe, expect, test } from 'bun:test';
import { makeNpc, makePlayer, makePlayerObj, makeState } from '../test/fixtures';
import type { CombatEvent, NearbyPlayer } from '../types';
import { Blackboard, isMaterialChange, emptyOrders, observeState, type MemberSelf } from './blackboard';
import { obs, report, sighting } from './fixtures';
import type { GroupEvent } from './types';

describe('Blackboard: shared awareness', () => {
    test('merges what each member sees: seenBy, freshest position wins, target resolved to a member', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        const tank = report('Tank', { objectId: 11, at: t0 });
        const healer = report('Healer', { objectId: 22, x: 1200, at: t0 + 100 });
        b.publish(obs(tank, [sighting(7, { x: 1500 })]), t0);
        b.publish(obs(healer, [sighting(7, { x: 1600, targetId: 22 })]), t0 + 100);
        const c = b.picture(t0 + 200).contacts[0]!;
        expect(c.seenBy).toEqual(['Tank', 'Healer']);
        expect(c.x).toBe(1600);
        expect(c.target).toBe('Healer');
        // An older snapshot does not overwrite fresher knowledge.
        b.publish(obs({ ...tank, at: t0 + 50 }, [sighting(7, { x: 1400 })]), t0 + 300);
        expect(b.picture(t0 + 300).contacts[0]!.x).toBe(1600);
    });

    test('a contact nobody sees turns stale, then is forgotten', () => {
        const b = new Blackboard({ staleAfterMs: 5000, forgetAfterMs: 20_000 });
        const t0 = Date.now();
        // The member stands far away, so not seeing it later proves nothing.
        b.publish(obs(report('Tank', { at: t0, x: 0 }), [sighting(7, { x: 9000 })]), t0);
        b.publish(obs(report('Tank', { at: t0 + 6000, x: 0 }), []), t0 + 6000);
        const c = b.picture(t0 + 6000).contacts[0]!;
        expect(c.stale).toBe(true);
        expect(c.seenBy).toEqual([]);
        expect(b.picture(t0 + 21_000).contacts).toEqual([]);
    });

    test('a member standing near the last position that no longer sees it drops the contact', () => {
        const b = new Blackboard({ viewRadius: 2500 });
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0 }), [sighting(7)]), t0);
        b.publish(obs(report('Tank', { at: t0 + 2000 }), []), t0 + 2000);
        expect(b.picture(t0 + 2000).contacts).toEqual([]);
    });

    test('a death emits a kill only for a mob the group fought, and the id is ignored for a while', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0, objectId: 11, targetId: 7 }), [sighting(7), sighting(8, { x: 1700 })]), t0);
        b.publish(obs(report('Tank', { at: t0 + 100, objectId: 11 }), [], [7, 8]), t0 + 100);
        expect(events.filter(e => e.kind === 'kill').map(e => e.targetId)).toEqual([7]);
        b.publish(obs(report('Tank', { at: t0 + 200 }), [sighting(7)]), t0 + 200);
        expect(b.picture(t0 + 200).contacts).toEqual([]);
    });

    test('a mob a member pulls to charm is no threat while her charm claim on it lasts (Contact.charming)', () => {
        const b = new Blackboard({ hostileMs: 4000 });
        const t0 = Date.now();
        const charming = { kind: 'charm', targetId: 7, detail: 'pulling', since: t0 };
        b.publish(obs(report('Deirdre', { at: t0, objectId: 11, activity: charming }), [sighting(7, { targetId: 11 }), sighting(8, { targetId: 11 })]), t0);
        const at = (t: number, id: number) => b.picture(t).contacts.find(c => c.objectId === id)!;
        expect(at(t0 + 100, 7).threat).toBe(false);
        expect(at(t0 + 100, 7).charming).toBe('Deirdre');
        expect(at(t0 + 100, 8).threat).toBe(true);
        expect(at(t0 + 100, 8).charming).toBeUndefined();
        // The claim lapses after CHARM_CLAIM_MS, or when her activity moves on: a threat like any other.
        b.publish(obs(report('Deirdre', { at: t0 + 200, objectId: 11, activity: { kind: 'idle', targetId: null, detail: '', since: t0 + 200 } }), [sighting(7, { targetId: 11 })]), t0 + 200);
        expect(at(t0 + 300, 7).threat).toBe(true);
        expect(at(t0 + 300, 7).charming).toBeUndefined();
    });

    test('hostility is sticky: a flickering target field keeps the mob a threat for hostileMs', () => {
        const b = new Blackboard({ hostileMs: 4000 });
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [sighting(7, { targetId: 11 })]), t0);
        b.publish(obs(report('Tank', { at: t0 + 500, objectId: 11 }), [sighting(7, { targetId: null })]), t0 + 500);
        let c = b.picture(t0 + 600).contacts[0]!;
        expect(c.target).toBeNull();
        expect(c.threat).toBe(true);
        expect(c.hostileSince).toBe(t0);
        c = b.picture(t0 + 4500).contacts[0]!;
        expect(c.threat).toBe(false);
        expect(c.hostileSince).toBe(0);
    });

    test('a mob in combat with no target keeps its last one while it runs; out of combat it clears', () => {
        const b = new Blackboard({ hostileMs: 4000 });
        const t0 = Date.now();
        const tank = (at: number) => obs(report('Tank', { at, objectId: 11 }), []);
        const see = (at: number, over: Parameters<typeof sighting>[1]) => {
            const o = tank(at);
            o.sightings.push(sighting(7, over));
            b.publish(o, at);
            return b.picture(at).contacts[0]!;
        };
        expect(see(t0, { targetId: 11, inCombat: true })).toMatchObject({ target: 'Tank', targetId: 11, targetSince: t0 });
        // The server sends no target while it chases: position updates, target and targetSince don't.
        expect(see(t0 + 500, { targetId: null, inCombat: true, x: 1300 })).toMatchObject({ target: 'Tank', targetId: 11, targetSince: t0, x: 1300 });
        see(t0 + 3000, { targetId: null, inCombat: true, x: 1200 });
        // Still a threat past hostileMs, on the same hostile streak.
        expect(see(t0 + 5000, { targetId: null, inCombat: true, x: 1100 })).toMatchObject({ target: 'Tank', threat: true, hostileSince: t0 });
        // Out of combat (a reset or leash): the target clears.
        expect(see(t0 + 5500, { targetId: null, inCombat: false })).toMatchObject({ target: null, targetId: null, targetSince: t0 + 5500 });
    });

    test('a different target resets targetSince', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        b.publish(obs(report('Healer', { at: t0, objectId: 22, x: 1200 })), t0);
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [sighting(7, { targetId: 11, inCombat: true })]), t0);
        b.publish(obs(report('Tank', { at: t0 + 300, objectId: 11 }), [sighting(7, { targetId: 22, inCombat: true })]), t0 + 300);
        expect(b.picture(t0 + 300).contacts[0]).toMatchObject({ target: 'Healer', targetId: 22, targetSince: t0 + 300 });
    });

    test('movedAt marks a carried pull: sightings that kept the target before the engage order', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        const see = (at: number, ...sightings: ReturnType<typeof sighting>[]) => b.publish(obs(report('Tank', { at, objectId: 11 }), sightings), at);
        const get = (id: number, at: number) => b.picture(at).contacts.find(c => c.objectId === id)!;
        // 7 is pulled and carried to the group; 9 is fought where it stands.
        see(t0, sighting(7, { targetId: 11, inCombat: true }), sighting(9, { x: 1100 }));
        expect(get(7, t0).movedAt).toBe(0);
        see(t0 + 500, sighting(7, { inCombat: true }), sighting(9, { x: 1100 }));
        see(t0 + 1000, sighting(7, { inCombat: true }), sighting(9, { x: 1100 }));
        expect(get(7, t0 + 1000)).toMatchObject({ movedAt: t0 + 1000, engagedAt: 0 });
        b.setOrders({ phase: 'engage', focus: 7, reason: 'fight' }, t0 + 1200);
        see(t0 + 1500, sighting(7, { inCombat: true }), sighting(9, { x: 1100 }));
        expect(get(7, t0 + 1500)).toMatchObject({ movedAt: t0 + 1000, engagedAt: t0 + 1200 });
        // 9: engaged, then the tank's hit, then a flicker: never carried.
        b.setOrders({ phase: 'engage', focus: 9, reason: 'next' }, t0 + 2000);
        see(t0 + 2500, sighting(9, { x: 1100, targetId: 11, inCombat: true }));
        see(t0 + 3000, sighting(9, { x: 1100, inCombat: true }));
        expect(get(9, t0 + 3000)).toMatchObject({ target: 'Tank', movedAt: 0, engagedAt: t0 + 2000 });
    });

    test('after a kill only the dead mob\'s own late sightings are ignored; a mob that inherited its id is new at once', () => {
        const t0 = Date.now();
        const killed = () => {
            const b = new Blackboard();
            b.publish(obs(report('Tank', { at: t0, objectId: 11, targetId: 7 }), [sighting(7, { name: 'wolf', targetId: 11, inCombat: true })]), t0);
            b.publish(obs(report('Tank', { at: t0 + 100, objectId: 11 }), [], [7]), t0 + 100);
            return b;
        };
        const seeAt = (b: Blackboard, at: number, over: Parameters<typeof sighting>[1]) => {
            b.publish(obs(report('Tank', { at, objectId: 11 }), [sighting(7, over)]), at);
            return b.picture(at).contacts;
        };
        // At the corpse, under its name: the dead wolf, ignored for 20 s.
        let b = killed();
        expect(seeAt(b, t0 + 200, { name: 'wolf', x: 1550 })).toEqual([]);
        expect(seeAt(b, t0 + 19_000, { name: 'wolf' })).toEqual([]);
        expect(seeAt(b, t0 + 20_200, { name: 'wolf' }).length).toBe(1);
        // 600 away: another wolf with the id. It stays (later sightings at its own spot too).
        b = killed();
        expect(seeAt(b, t0 + 300, { name: 'wolf', x: 2100 })).toMatchObject([{ name: 'wolf', x: 2100, target: null, targetId: null, engagedAt: 0, firstSeen: t0 + 300 }]);
        expect(seeAt(b, t0 + 600, { name: 'wolf', x: 1500 }).length).toBe(1);
        // At the corpse under another name: a new mob too.
        b = killed();
        expect(seeAt(b, t0 + 300, { name: 'forest wolf' })).toMatchObject([{ name: 'forest wolf' }]);
        // A camp respawn that inherits the id at the same spot shows full health; the corpse never more than it died with.
        b = new Blackboard();
        b.publish(obs(report('Tank', { at: t0, objectId: 11, targetId: 7 }), [sighting(7, { name: 'wolf', hp: 3, targetId: 11, inCombat: true })]), t0);
        b.publish(obs(report('Tank', { at: t0 + 100, objectId: 11 }), [], [7]), t0 + 100);
        expect(seeAt(b, t0 + 300, { name: 'wolf', hp: 0 })).toEqual([]);
        expect(seeAt(b, t0 + 3000, { name: 'wolf', hp: 100, x: 1600 })).toMatchObject([{ name: 'wolf', hp: 100, firstSeen: t0 + 3000 }]);
    });

    test('a mob that inherited a dead mob\'s id survives the death members still report for that id', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0, objectId: 11, targetId: 7 }), [sighting(7, { name: 'wolf', targetId: 11, inCombat: true })]), t0);
        b.publish(obs(report('Tank', { at: t0 + 100, objectId: 11 }), [], [7]), t0 + 100);
        // observeState keeps the death event for 5 s: it comes with the new mob's sightings.
        b.publish(obs(report('Tank', { at: t0 + 1000, objectId: 11 }), [sighting(7, { name: 'forest wolf', x: 2100 })], [7]), t0 + 1000);
        b.publish(obs(report('Tank', { at: t0 + 5000, objectId: 11 }), [sighting(7, { name: 'forest wolf', x: 2100 })], [7]), t0 + 5000);
        expect(b.picture(t0 + 5000).contacts.map(c => c.name)).toEqual(['forest wolf']);
        // Its own death, later, counts.
        b.publish(obs(report('Tank', { at: t0 + 8000, objectId: 11 }), [], [7]), t0 + 8000);
        expect(b.picture(t0 + 8000).contacts).toEqual([]);
        expect(events.filter(e => e.kind === 'kill').map(e => e.text)).toEqual(['wolf (L6) died']);
    });

    test('a mob under the id of something that was no contact, a pet say, stays on the board', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        const t0 = Date.now();
        const contacts = (at: number) => b.picture(at).contacts.map(c => c.name);
        // The Tank's pet goes (0xA2 type 0); every member in view reports its death for 5 s.
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [], [700]), t0);
        b.publish(obs(report('Healer', { at: t0 + 100, objectId: 22 }), [], [700]), t0 + 100);
        // A respawn takes the freed id (Region.cs:955, :779), and the death still comes with its sightings ...
        b.publish(obs(report('Tank', { at: t0 + 2000, objectId: 11 }), [sighting(700, { name: 'wolf' })], [700]), t0 + 2000);
        expect(contacts(t0 + 2000)).toEqual(['wolf']);
        // ... and from a member that hasn't seen it yet.
        b.publish(obs(report('Healer', { at: t0 + 2100, objectId: 22 }), [], [700]), t0 + 2100);
        expect(contacts(t0 + 2100)).toEqual(['wolf']);
        // Its own death, later, counts.
        b.publish(obs(report('Tank', { at: t0 + 8000, objectId: 11 }), [], [700]), t0 + 8000);
        expect(contacts(t0 + 8000)).toEqual([]);
    });

    test('so does one that came in the very snapshot that first reports the death', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [sighting(700, { name: 'wolf' })], [700]), t0);
        expect(b.picture(t0).contacts.map(c => c.name)).toEqual(['wolf']);
    });

    test('an old death under an id arms nothing: a mob there dies like any', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [], [700]), t0);
        b.publish(obs(report('Tank', { at: t0 + 7000, objectId: 11 }), [sighting(700, { name: 'wolf' })]), t0 + 7000);
        b.publish(obs(report('Tank', { at: t0 + 7100, objectId: 11 }), [], [700]), t0 + 7100);
        expect(b.picture(t0 + 7100).contacts).toEqual([]);
    });

    test('a member attacking a mob makes it a threat even before it turns', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0, objectId: 11, targetId: 7, attacking: true }), [sighting(7)]), t0);
        expect(b.picture(t0).contacts[0]!.threat).toBe(true);
    });

    test('crowd control lasts until it expires or the mob swings again', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        b.publish(obs(report('Bard', { at: t0 }), [sighting(7, { targetId: 200 })]), t0);
        b.markCc(7, 200, 'Bard', 'mezz', 10_000, t0);
        expect(b.picture(t0 + 1000).contacts[0]!.cc?.by).toBe('Bard');
        expect(b.picture(t0 + 11_000).contacts[0]!.cc).toBeNull();
        b.markCc(7, 200, 'Bard', 'mezz', 10_000, t0 + 11_000);
        // A swing right after the mezz landed is from before it; later ones break it.
        b.publish(obs(report('Bard', { at: t0 + 12_000 }), [sighting(7, { swinging: true })]), t0 + 12_000);
        expect(b.picture(t0 + 12_000).contacts[0]!.cc).not.toBeNull();
        b.publish(obs(report('Bard', { at: t0 + 14_000 }), [sighting(7, { swinging: true })]), t0 + 14_000);
        expect(b.picture(t0 + 14_000).contacts[0]!.cc).toBeNull();
    });

    test('member deaths and level-ups become events', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish(obs(report('Healer')));
        b.publish(obs(report('Healer', { isDead: true, level: 7 })));
        expect(events.map(e => e.kind).sort()).toEqual(['death', 'level']);
    });
});

describe('Blackboard: orders', () => {
    test('only material changes bump seq, emit an event and notify listeners', () => {
        const b = new Blackboard();
        const seen: number[] = [];
        b.onOrders(o => seen.push(o.seq));
        expect(b.setOrders({ phase: 'recover', reason: 'low' })).toBe(true);
        expect(b.setOrders({ phase: 'recover', reason: 'still low' })).toBe(false);
        expect(b.getOrders().reason).toBe('still low');
        expect(b.setOrders({ phase: 'recover', anchor: { x: 0, y: 0, z: 0 }, reason: 'base' })).toBe(true);
        expect(b.setOrders({ phase: 'recover', anchor: { x: 100, y: 0, z: 0 }, reason: 'nudge' })).toBe(false);
        expect(seen).toEqual([1, 2]);
        expect(b.events().filter(e => e.kind === 'orders').length).toBe(2);
    });

    test('the engage order stamps engagedAt on the focus once; cc changes don\'t move it', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [sighting(7), sighting(8, { x: 1700 })]), t0);
        const engagedAt = (id: number) => b.picture(t0).contacts.find(c => c.objectId === id)!.engagedAt;
        b.setOrders({ phase: 'pull', focus: 7, puller: 'Tank', reason: 'pull' }, t0 + 100);
        expect(engagedAt(7)).toBe(0);
        b.setOrders({ phase: 'engage', focus: 7, puller: null, reason: 'fight' }, t0 + 1000);
        expect(engagedAt(7)).toBe(t0 + 1000);
        expect(b.setOrders({ phase: 'engage', focus: 7, cc: [{ targetId: 8, by: 'Bard' }], reason: 'mezz the add' }, t0 + 2000)).toBe(true);
        b.setOrders({ phase: 'engage', reason: 'still fighting' }, t0 + 3000);
        expect(engagedAt(7)).toBe(t0 + 1000);
        expect(engagedAt(8)).toBe(0);
    });

    test('isMaterialChange: phase, focus, puller, cc and big moves', () => {
        const a = emptyOrders(0);
        expect(isMaterialChange(a, { ...a, focus: 7 })).toBe(true);
        expect(isMaterialChange(a, { ...a, cc: [{ targetId: 8, by: 'Bard' }] })).toBe(true);
        expect(isMaterialChange(a, { ...a, reason: 'other words' })).toBe(false);
        expect(isMaterialChange({ ...a, retreatTo: { x: 0, y: 0, z: 0 } }, { ...a, retreatTo: { x: 500, y: 0, z: 0 } })).toBe(true);
    });
});

describe('enemy players', () => {
    const T = 1_800_000_000_000;
    const self: MemberSelf = { bot: 'testbot', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } };
    let id = 0;
    /** A combat event `ago` ms before the snapshot. */
    const ev = (kind: CombatEvent['kind'], attacker: number, target: number | null, ago: number, extra: Partial<CombatEvent> = {}): CombatEvent =>
        ({ id: ++id, kind, attackerObjectId: attacker, targetObjectId: target, receivedAt: T - ago, ...extra });
    // We are Testbot (100, albion), 302 is a friend; 300 and 301 are Midgard, 303 and 304 Hibernia.
    const players = [
        makePlayerObj({ objectId: 300, name: 'Norseman', realm: 'midgard', inCombat: true }),
        makePlayerObj({ objectId: 301, name: 'Troll', realm: 'midgard' }),
        makePlayerObj({ objectId: 302, name: 'Friend', realm: 'albion' }),
        makePlayerObj({ objectId: 303, name: 'Celt', realm: 'hibernia' }),
        makePlayerObj({ objectId: 304, name: 'Elf', realm: 'hibernia' }),
    ];
    const state = (combatEvents: CombatEvent[], player = {}) =>
        makeState({ timestamp: T, player: makePlayer({ objectId: 100, realmPoints: 1234, ...player }), nearbyNpcs: [], nearbyPlayers: players, combatEvents });
    const seen = (o: ReturnType<typeof observeState>, objectId: number) => o!.sightings.find(s => s.objectId === objectId)!;
    /** Our observation `ms` after T, for stepping the board through time. */
    const later = (ms: number, combatEvents: CombatEvent[], nearbyPlayers = players) =>
        observeState(makeState({ timestamp: T + ms, player: makePlayer({ objectId: 100 }), nearbyNpcs: [], nearbyPlayers, combatEvents }), self)!;

    test('observeState infers a player\'s target from its latest swing or hostile spell, and reads its casts and heals', () => {
        const o = observeState(state([
            ev('melee', 300, 302, 3500),
            ev('melee', 300, 100, 500),
            // 301 heals 300 and is casting again: a heal is no target and no swing.
            ev('spellEffect', 301, 300, 2600),
            ev('spellCast', 301, null, 2500, { castTimeMs: 2500 }),
            // 303 nukes us from range: its target, though the effect is older than the swing window.
            ev('spellCast', 303, null, 5500, { castTimeMs: 2500 }),
            ev('spellEffect', 303, 100, 3000),
            // 304 buffed itself and swung 6.5 s ago, longer than a slow weapon's round: nothing it did is recent.
            ev('spellEffect', 304, 304, 1000),
            ev('melee', 304, 100, 6500),
        ]), self)!;
        expect(o.sightings.map(s => s.objectId)).toEqual([300, 301, 303, 304]);
        expect(seen(o, 300)).toMatchObject({ kind: 'player', realm: 'midgard', targetId: 100, swinging: true, casting: false, helped: false, inCombat: true });
        expect(seen(o, 301)).toMatchObject({ targetId: null, swinging: false, casting: true, helped: true });
        expect(seen(o, 303)).toMatchObject({ targetId: 100, swinging: false, casting: false, helped: false });
        expect(seen(o, 304)).toMatchObject({ targetId: null, swinging: false, casting: false, helped: false });
        expect(o.report.realmPoints).toBe(1234);
        expect(o.killer).toBeNull();
    });

    test('a player\'s cast start or hostile spell in the swing window counts as a swing (a mezzed player does neither)', () => {
        const o = observeState(state([ev('spellCast', 301, null, 500, { castTimeMs: 0 }), ev('spellEffect', 303, 100, 1500)]), self)!;
        expect(seen(o, 301)).toMatchObject({ swinging: true, casting: true });
        expect(seen(o, 303)).toMatchObject({ swinging: true, targetId: 100 });
        // A cast lasts its cast time, at least 3 s.
        expect(seen(observeState(state([ev('spellCast', 301, null, 4000, { castTimeMs: 4500 })]), self)!, 301).casting).toBe(true);
        expect(seen(observeState(state([ev('spellCast', 301, null, 3200, { castTimeMs: 1000 })]), self)!, 301).casting).toBe(false);
    });

    test('a dead member\'s killer: the death event\'s, else the newest foe that hit it, never a friend\'s heal', () => {
        const dead = { isDead: true, healthPercent: 0 };
        expect(observeState(state([ev('melee', 303, 100, 4000), ev('death', 300, 100, 100)], dead), self)!.killer).toEqual({ name: 'Norseman', kind: 'player', realm: 'midgard' });
        expect(observeState(state([ev('melee', 303, 100, 4000), ev('spellEffect', 302, 100, 1000)], dead), self)!.killer).toEqual({ name: 'Celt', kind: 'player', realm: 'hibernia' });
        // The killer left view and nobody else hit it, or the hit is too old.
        expect(observeState(state([ev('death', 999, 100, 100)], dead), self)!.killer).toBeNull();
        expect(observeState(state([ev('melee', 303, 100, 20_000)], dead), self)!.killer).toBeNull();
    });

    test('a player meleeing a member is a threat on that member; so is a caster nuking one', () => {
        const b = new Blackboard();
        const now = Date.now();
        const fresh = (o: ReturnType<typeof observeState>) => ({ ...o!, report: { ...o!.report, at: now, regionId: 200 } });
        b.publish(obs(report('Friend', { objectId: 302, at: now })), now);
        b.publish(fresh(observeState(state([ev('melee', 300, 100, 500), ev('spellEffect', 303, 302, 800)]), self)), now);
        const c = (objectId: number) => b.picture(now).contacts.find(x => x.objectId === objectId)!;
        expect(c(300)).toMatchObject({ kind: 'player', target: 'Testbot', targetId: 100, threat: true, hostileSince: now });
        expect(c(303)).toMatchObject({ target: 'Friend', targetId: 302, threat: true });
        expect(c(301)).toMatchObject({ target: null, threat: false, healer: false, caster: false });
    });

    test('a player in attack mode that stops hitting loses its target, then its threat: no hold as for a running mob', () => {
        const b = new Blackboard({ hostileMs: 4000 });
        // The Norseman (inCombat: attack mode on) swings at us once, then hits nobody we see.
        const swing = [ev('melee', 300, 100, 0)];
        const norseman = (ms: number) => {
            b.publish(later(ms, swing), T + ms);
            return b.picture(T + ms).contacts.find(c => c.objectId === 300)!;
        };
        expect(norseman(500)).toMatchObject({ inCombat: true, target: 'Testbot', targetId: 100, threat: true });
        expect(norseman(3000)).toMatchObject({ target: 'Testbot', threat: true });
        // A two-handed weapon swings every 4.4-5.5 s: the target holds between two swings (PLAYER_AIM_MS).
        expect(norseman(5500)).toMatchObject({ target: 'Testbot', targetId: 100, targetSince: T + 500, threat: true });
        expect(norseman(6500)).toMatchObject({ inCombat: true, target: null, targetId: null, targetSince: T + 6500, threat: true });
        for (let ms = 7500; ms < 40_000; ms += 1000) norseman(ms);
        expect(norseman(40_000)).toMatchObject({ inCombat: true, target: null, threat: false, hostileSince: 0, movedAt: 0 });
    });

    test('healer and caster stick to the contact once any member saw it heal or cast', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        const troll = (over: Parameters<typeof sighting>[1]) => sighting(301, { kind: 'player', name: 'Troll', realm: 'midgard', ...over });
        b.publish(obs(report('Tank', { at: t0 }), [troll({})]), t0);
        expect(b.picture(t0).contacts[0]).toMatchObject({ healer: false, caster: false });
        b.publish(obs(report('Healer', { at: t0 + 100, x: 1200 }), [troll({ helped: true, casting: true })]), t0 + 100);
        b.publish(obs(report('Tank', { at: t0 + 2000 }), [troll({ helped: false, casting: false })]), t0 + 2000);
        expect(b.picture(t0 + 2000).contacts[0]).toMatchObject({ helped: false, casting: false, healer: true, caster: true });
        // Monsters carry no such flags.
        b.publish(obs(report('Tank', { at: t0 + 2100 }), [troll({}), sighting(7)]), t0 + 2100);
        expect('healer' in b.picture(t0 + 2100).contacts.find(c => c.objectId === 7)!).toBe(false);
    });

    test('a kill names the enemy\'s kind and realm; a member\'s death names its killer', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        const t0 = Date.now();
        const norseman = sighting(300, { kind: 'player', name: 'Norseman', realm: 'midgard', level: 20, targetId: 11 });
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [norseman, sighting(7, { targetId: 11 })]), t0);
        b.publish(obs(report('Tank', { at: t0 + 100, objectId: 11 }), [], [300, 7]), t0 + 100);
        expect(events.filter(e => e.kind === 'kill').map(e => e.data)).toEqual([
            { name: 'Norseman', level: 20, kind: 'player', realm: 'midgard' },
            { name: 'water beetle', level: 6, kind: 'npc', realm: 'none' },
        ]);
        const killer = { name: 'Celt', kind: 'player', realm: 'hibernia' } as const;
        b.publish({ ...obs(report('Tank', { at: t0 + 200, objectId: 11, isDead: true })), killer }, t0 + 200);
        b.publish(obs(report('Healer', { at: t0 + 200 })), t0 + 200);
        b.publish(obs(report('Healer', { at: t0 + 300, isDead: true })), t0 + 300);
        expect(events.filter(e => e.kind === 'death').map(e => [e.member, e.data])).toEqual([['Tank', { killer }], ['Healer', { killer: null }]]);
    });

    test('an enemy another realm killed is our kill only if we hit it; by our realm or a killer out of view, it is', () => {
        const outcome = (killer: number, weHit: boolean) => {
            const b = new Blackboard();
            const events: GroupEvent[] = [];
            b.onEvent(e => events.push(e));
            // The Norseman swings at us (engaged), maybe we hit back; a second later the death event names `killer`.
            const fight = [ev('melee', 300, 100, 1000), ...(weHit ? [ev('melee', 100, 300, 500)] : [])];
            b.publish(later(0, fight), T);
            const corpse = players.map(o => (o.objectId === 300 ? { ...o, isDead: true, healthPercent: 0 } : o));
            b.publish(later(1000, [...fight, ev('death', killer, 300, -1000)], corpse), T + 1000);
            expect(b.picture(T + 1000).contacts.some(c => c.objectId === 300)).toBe(false);
            return events.filter(e => e.kind === 'kill' || e.kind === 'note').map(e => `${e.kind}: ${e.text}`);
        };
        // The Celt (Hibernia) finished a Norseman we never hit: Hibernia's kill, not ours.
        expect(outcome(303, false)).toEqual(['note: Norseman (L10) died to someone else']);
        // We hit it: the server shares the kill among all who damaged it.
        expect(outcome(303, true)).toEqual(['kill: Norseman (L10) died']);
        expect(outcome(302, false)).toEqual(['kill: Norseman (L10) died']);
        expect(outcome(999, false)).toEqual(['kill: Norseman (L10) died']);
        expect(later(1000, [ev('melee', 100, 300, 500), ev('death', 303, 300, -1000), ev('death', 302, 301, -1000)])).toMatchObject({ foeKills: [300], hits: [300] });
    });

    test('a killed player seen alive again after a few seconds was rezzed: a contact at once', () => {
        const b = new Blackboard();
        const t0 = Date.now();
        const norseman = (hp: number) => sighting(300, { kind: 'player', name: 'Norseman', realm: 'midgard', hp, targetId: 11 });
        b.publish(obs(report('Tank', { at: t0, objectId: 11 }), [norseman(5)]), t0);
        b.publish(obs(report('Tank', { at: t0 + 100, objectId: 11 }), [], [300]), t0 + 100);
        // A member's late snapshot of it alive: ignored.
        b.publish(obs(report('Healer', { at: t0 + 500, x: 1200 }), [norseman(5)]), t0 + 500);
        expect(b.picture(t0 + 500).contacts).toEqual([]);
        // Rezzed at its corpse with a little health; the death members still report is the old one.
        b.publish(obs(report('Tank', { at: t0 + 4000, objectId: 11 }), [norseman(10)], [300]), t0 + 4000);
        expect(b.picture(t0 + 4000).contacts).toMatchObject([{ objectId: 300, hp: 10 }]);
    });
});

describe('enemy players: who is hostile to us, and who died', () => {
    const T = 1_800_000_000_000;
    const self: MemberSelf = { bot: 'testbot', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } };
    let id = 0;
    const ev = (kind: CombatEvent['kind'], attacker: number, target: number | null, ago: number, extra: Partial<CombatEvent> = {}): CombatEvent =>
        ({ id: ++id, kind, attackerObjectId: attacker, targetObjectId: target, receivedAt: T - ago, ...extra });
    // We are Testbot (100, albion) at x 560000; 300 is Midgard, 303 Hibernia, both `dx` east of us.
    const enemies = (dx: number, over: Partial<NearbyPlayer> = {}) => [
        makePlayerObj({ objectId: 300, name: 'Norseman', realm: 'midgard', x: 560000 + dx, distance: dx, distance2d: dx, ...over }),
        makePlayerObj({ objectId: 303, name: 'Celt', realm: 'hibernia', x: 560000 + dx + 50, distance: dx + 50, distance2d: dx + 50 }),
    ];
    const look = (ms: number, combatEvents: CombatEvent[], nearbyPlayers: NearbyPlayer[]) =>
        observeState(makeState({ timestamp: T + ms, player: makePlayer({ objectId: 100 }), nearbyNpcs: [], nearbyPlayers, combatEvents }), self, 5000)!;

    test('two other realms fighting each other far off are no threat to us; within hostileRadius of a member they are', () => {
        const b = new Blackboard();
        // The Norseman melees the Celt, who starts a cast: the rvr strategy's members report enemies to 5000.
        const fight = [ev('melee', 300, 303, 500), ev('spellCast', 303, null, 800, { castTimeMs: 2500 })];
        const c = (ms: number, objectId: number) => b.picture(T + ms).contacts.find(x => x.objectId === objectId)!;
        b.publish(look(0, fight, enemies(4500)), T);
        expect(c(0, 300)).toMatchObject({ targetId: 303, target: null, swinging: true, threat: false, hostileSince: 0 });
        expect(c(0, 303)).toMatchObject({ swinging: true, casting: true, threat: false });
        // The same fight 2000 from us: it may turn on us any moment (a cast's target is unknown until it lands).
        b.publish(look(1000, fight, enemies(2000)), T + 1000);
        expect(c(1000, 300)).toMatchObject({ threat: true, hostileSince: T + 1000 });
        expect(c(1000, 303).threat).toBe(true);
    });

    test('a far enemy is hostile when it is on a member or we hit it', () => {
        const b = new Blackboard();
        // A Celt's bolt lands on us from 4500; our arrow lands on the Norseman.
        b.publish(look(0, [ev('spellEffect', 303, 100, 500), ev('melee', 100, 300, 300, { result: 'hit' })], enemies(4500)), T);
        const threat = (objectId: number) => b.picture(T).contacts.find(x => x.objectId === objectId)!.threat;
        expect(threat(303)).toBe(true);
        expect(threat(300)).toBe(true);
    });

    test('the broad swing flag still breaks a mezz, though a far swing is no threat', () => {
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish(look(0, [], enemies(4500)), T);
        b.markCc(300, 1, 'Bard', 'mezz', 30_000, T);
        b.publish(look(3000, [ev('melee', 300, 303, -2500)], enemies(4500)), T + 3000);
        expect(b.picture(T + 3000).contacts.find(x => x.objectId === 300)).toMatchObject({ cc: null, threat: false });
        expect(events.map(e => e.text)).toContain('mezz on Norseman broke');
    });

    test('our landed swing is a hit (a share of the kill); a miss, parry, block or evade is not', () => {
        const hits = (result: CombatEvent['result']) => look(0, [ev('melee', 100, 300, 500, { result })], enemies(100)).hits;
        for (const r of ['miss', 'parry', 'block', 'evade', 'fumble'] as const) expect(hits(r)).toEqual([]);
        expect(hits('hit')).toEqual([300]);
        expect(hits('styledHit')).toEqual([300]);
        // A missed swing still shows whom it was aimed at.
        expect(look(0, [ev('melee', 300, 100, 500, { result: 'miss' })], enemies(100)).sightings.find(s => s.objectId === 300)!.targetId).toBe(100);
    });

    test('a living player at 0 % (health is rounded down) is a sighting and a threat, not a death', () => {
        const o = look(0, [ev('melee', 300, 100, 500)], enemies(100, { healthPercent: 0 }));
        expect(o.deaths).toEqual([]);
        expect(o.sightings.find(s => s.objectId === 300)).toMatchObject({ hp: 0, targetId: 100 });
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        b.publish(o, T);
        expect(b.picture(T).contacts.find(c => c.objectId === 300)).toMatchObject({ hp: 0, target: 'Testbot', threat: true });
        expect(events.filter(e => e.kind === 'kill')).toEqual([]);
    });

    test('a dead entry is a death only while fresh: a corpse left in one member\'s model kills no live contact', () => {
        const corpse = (lastSeenAgo: number) => enemies(500, { isDead: true, healthPercent: 0, lastSeenAgo });
        expect(look(0, [], corpse(500)).deaths).toEqual([300]);
        expect(look(0, [], corpse(60_000)).deaths).toEqual([]);
        expect(look(0, [], corpse(60_000)).sightings.map(s => s.objectId)).toEqual([303]);
        // The death event itself still counts for 5 s, however old the entry.
        expect(look(0, [ev('death', 303, 300, 1000)], corpse(60_000)).deaths).toEqual([300]);

        // The Norseman released, walked back and hits the Healer 8000 east; Testbot still holds its corpse.
        const b = new Blackboard();
        const events: GroupEvent[] = [];
        b.onEvent(e => events.push(e));
        const back = sighting(300, { kind: 'player', name: 'Norseman', realm: 'midgard', x: 568100, y: 511000, targetId: 11 });
        b.publish(obs(report('Healer', { at: T, objectId: 11, regionId: 1, x: 568000, y: 511000 }), [back]), T);
        b.publish(look(100, [], corpse(60_000)), T + 100);
        expect(b.picture(T + 100).contacts.find(c => c.objectId === 300)).toMatchObject({ hp: 100, target: 'Healer' });
        expect(events.filter(e => e.kind === 'kill')).toEqual([]);
    });
});

describe('a monster casting at a member from range', () => {
    const T = 1_800_000_000_000;
    const self: MemberSelf = { bot: 'testbot', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } };
    const MOB = 500, ME = 100, HEALER = 302;
    let id = 0;
    /** A combat event received at T + `at`. */
    const ev = (kind: CombatEvent['kind'], attacker: number, target: number | null, at: number, extra: Partial<CombatEvent> = {}): CombatEvent =>
        ({ id: ++id, kind, attackerObjectId: attacker, targetObjectId: target, receivedAt: T + at, ...extra });
    // As live: a dergan enchanter 446 away, and the server reports it neither targeting nor in combat.
    const mob = (over: Parameters<typeof makeNpc>[0] = {}) => makeNpc({ objectId: MOB, name: 'dergan enchanter', level: 6, distance: 446, distance2d: 446, ...over });
    const look = (ms: number, combatEvents: CombatEvent[], npc = mob()) => {
        const player = makePlayer({ objectId: ME });
        return observeState(makeState({ timestamp: T + ms, player, nearbyNpcs: [npc], nearbyPlayers: [makePlayerObj({ objectId: HEALER, name: 'Friend', realm: player.realm })], combatEvents }), self)!;
    };
    /** A board with both members on it, the healer too far off to see the mob; `step` publishes our observation and reads the contact. */
    const board = (options = {}) => {
        const b = new Blackboard(options);
        const regionId = look(0, []).report.regionId;
        const step = (ms: number, combatEvents: CombatEvent[], npc = mob()) => {
            const o = look(ms, combatEvents, npc);
            b.publish(obs(report('Friend', { objectId: HEALER, regionId, x: o.report.x + 9000, y: o.report.y, at: T + ms }), []), T + ms);
            b.publish(o, T + ms);
            return b.picture(T + ms).contacts.find(c => c.objectId === MOB)!;
        };
        return { b, step, regionId };
    };

    test('its spell landing on a member puts it on that member and makes it a threat, for the aim window', () => {
        const { step } = board();
        const hit = [ev('spellEffect', MOB, HEALER, 0)];
        expect(step(0, [])).toMatchObject({ target: null, threat: false });
        expect(step(100, hit)).toMatchObject({ target: 'Friend', targetId: HEALER, targetBySpell: true, threat: true, targetSince: T + 100, inCombat: false });
        // Between two spells: same target, same streak.
        step(3000, hit);
        expect(step(5000, hit)).toMatchObject({ target: 'Friend', targetSince: T + 100, hostileSince: T + 100, threat: true });
        // The aim window ends; the threat lasts hostileMs more, as for any hostile sign.
        expect(step(6100, hit)).toMatchObject({ target: null, targetId: null, targetBySpell: false, threat: true });
        expect(step(10_000, hit)).toMatchObject({ threat: false });
    });

    test('the newest spell names the target, and one the server reports goes first', () => {
        const { step } = board();
        const hits = [ev('spellEffect', MOB, HEALER, 0), ev('spellEffect', MOB, ME, 1000)];
        expect(step(1100, hits).targetId).toBe(ME);
        expect(step(1200, hits, mob({ targetObjectId: HEALER, inCombat: true }))).toMatchObject({ target: 'Friend', targetBySpell: false });
    });

    test('melee shows no aim: a swing keeps no target after a reset', () => {
        const { step } = board();
        expect(step(100, [ev('melee', MOB, HEALER, 0)])).toMatchObject({ target: null, targetId: null, targetBySpell: false, swinging: true });
    });

    test('a self-buff, a buff on its friend or a cast start is no threat', () => {
        const friend = makeNpc({ objectId: 501, name: 'dergan fury', level: 6 });
        for (const e of [ev('spellEffect', MOB, MOB, 0), ev('spellEffect', MOB, friend.objectId, 0), ev('spellCast', MOB, null, 0, { castTimeMs: 3000 })]) {
            const o = observeState(makeState({ timestamp: T + 100, player: makePlayer({ objectId: ME }), nearbyNpcs: [mob(), friend], nearbyPlayers: [], combatEvents: [e] }), self)!;
            expect(o.sightings.find(s => s.objectId === MOB)).toMatchObject({ spellTargetId: null, swinging: false, targetId: null });
            const b = new Blackboard();
            b.publish(o, T + 100);
            expect(b.picture(T + 100).contacts.find(c => c.objectId === MOB)).toMatchObject({ target: null, threat: false, hostileSince: 0 });
        }
    });

    test('a member\'s spell on it does not read as its aim', () => {
        const { step } = board();
        expect(step(100, [ev('spellEffect', HEALER, MOB, 0)])).toMatchObject({ target: null, targetId: null, swinging: false });
    });

    test('a mezzed caster drops out of the threats as a melee add does, not after the whole aim window', () => {
        const { b, step, regionId } = board({ hostileMs: 4000 });
        // It nuked the healer 1 s before the mezz, so the swing flag holds to T + 1000 and the threat to T + 5000.
        const hit = [ev('spellEffect', MOB, HEALER, -1000)];
        expect(step(-500, hit)).toMatchObject({ target: 'Friend', threat: true });
        b.markCc(MOB, regionId, 'Friend', 'mezz', 30_000, T);
        expect(step(100, hit)).toMatchObject({ target: null, targetId: null, targetBySpell: false, threat: true });
        // The spell from before the mezz neither ends the mezz nor counts as a target.
        expect(step(900, hit).cc?.by).toBe('Friend');
        expect(step(1900, hit).cc?.by).toBe('Friend');
        const c = step(5100, hit);
        expect(c).toMatchObject({ target: null, threat: false });
        expect(c.cc?.by).toBe('Friend');
    });

    test('a spell landing after the mezz ends the board\'s cc entry, with a note, and puts it back on the member', () => {
        const { b, step, regionId } = board();
        const notes: string[] = [];
        b.onEvent(e => { if (e.kind === 'note') notes.push(e.text); });
        step(0, []);
        b.markCc(MOB, regionId, 'Friend', 'mezz', 30_000, T);
        const hit = [ev('spellEffect', MOB, HEALER, 3000)];
        expect(step(3000, hit).cc).toBeNull();
        expect(notes).toEqual(['mezz on dergan enchanter broke']);
        expect(step(3250, hit)).toMatchObject({ target: 'Friend', targetBySpell: true, threat: true });
    });

    test('a cast start after the mezz ends nothing: only a landed spell does', () => {
        const { b, step, regionId } = board();
        step(0, []);
        b.markCc(MOB, regionId, 'Friend', 'mezz', 30_000, T);
        expect(step(3000, [ev('spellCast', MOB, null, 3000, { castTimeMs: 3000 })]).cc?.by).toBe('Friend');
    });

    test('a rooted caster that keeps casting is no longer controlled', () => {
        const { b, step, regionId } = board();
        step(0, []);
        b.markCc(MOB, regionId, 'Friend', 'root', 30_000, T);
        expect(step(3000, [ev('spellEffect', MOB, ME, 3000)]).cc).toBeNull();
    });

    test('its spell on a member who died is no target: nothing else would end it', () => {
        const { b, regionId } = board();
        b.publish(obs(report('Friend', { objectId: HEALER, regionId, isDead: true, at: T + 100 }), []), T + 100);
        b.publish(look(100, [ev('spellEffect', MOB, HEALER, 0)]), T + 100);
        expect(b.picture(T + 100).contacts.find(c => c.objectId === MOB)).toMatchObject({ target: null, targetId: null });
    });

    test('its spell on someone outside the group: targeting, but on no member', () => {
        const stranger = 700;
        const o = observeState(makeState({ timestamp: T + 100, player: makePlayer({ objectId: ME }), nearbyNpcs: [mob()], nearbyPlayers: [makePlayerObj({ objectId: stranger, name: 'Stranger', realm: 'albion' })], combatEvents: [ev('spellEffect', MOB, stranger, 0)] }), self)!;
        expect(o.sightings[0]).toMatchObject({ spellTargetId: stranger });
        const b = new Blackboard();
        b.publish(o, T + 100);
        expect(b.picture(T + 100).contacts[0]).toMatchObject({ target: null, targetId: stranger });
    });

    describe('fighting someone outside the group is not our fight', () => {
        const STRANGER = 700;
        const see = (ms: number, combatEvents: CombatEvent[], extra: { attacking?: boolean } = {}) => observeState(makeState({
            timestamp: T + ms, player: makePlayer({ objectId: ME, ...extra, ...(extra.attacking ? { targetObjectId: MOB } : {}) }), nearbyNpcs: [mob()],
            nearbyPlayers: [makePlayerObj({ objectId: STRANGER, name: 'Stranger', realm: 'albion' })], combatEvents,
        }), self)!;
        const threat = (b: Blackboard, ms: number) => b.picture(T + ms).contacts[0]!.threat;

        test('its spell or its swing on a stranger makes no threat, wherever it stands: a damage spell also arrives as a swing', () => {
            for (const kind of ['spellEffect', 'melee'] as const) {
                const b = new Blackboard();
                b.publish(see(100, [ev(kind, MOB, STRANGER, 0)]), T + 100);
                expect(threat(b, 100)).toBe(false);
            }
        });

        test('its next hit on us does', () => {
            const b = new Blackboard();
            b.publish(see(100, [ev('melee', MOB, STRANGER, 0)]), T + 100);
            b.publish(see(200, [ev('melee', MOB, STRANGER, 0), ev('melee', MOB, ME, 150)]), T + 200);
            expect(threat(b, 200)).toBe(true);
        });

        test('so does the group hitting it', () => {
            const b = new Blackboard();
            b.publish(see(100, [ev('melee', MOB, STRANGER, 0)], { attacking: true }), T + 100);
            b.publish(see(200, [ev('melee', MOB, STRANGER, 0)], { attacking: true }), T + 200);
            expect(threat(b, 200)).toBe(true);
        });

        test('its swing on something that is no player, a pet of ours for one, still counts', () => {
            const b = new Blackboard();
            b.publish(see(100, [ev('melee', MOB, 900, 0)]), T + 100);
            expect(threat(b, 100)).toBe(true);
        });
    });

    describe('only a mob standing to cast is on a member by its spell', () => {
        test('a target the server names that differs from the spell is the server\'s', () => {
            const { step } = board();
            const c = step(100, [ev('spellEffect', MOB, HEALER, 0)], mob({ targetObjectId: ME, inCombat: true }));
            expect(c.targetId).toBe(ME);
            expect(c.targetBySpell).toBe(false);
        });

        test('in combat with no target it is running: not by spell, and the target it had is kept', () => {
            const { step } = board();
            step(100, [], mob({ targetObjectId: HEALER, inCombat: true }));
            const c = step(200, [ev('spellEffect', MOB, HEALER, 150)], mob({ inCombat: true }));
            expect(c.targetBySpell).toBe(false);
            expect(c.target).toBe('Friend');
            expect(c.movedAt).toBeGreaterThan(0);
        });
    });
});
