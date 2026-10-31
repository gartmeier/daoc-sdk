import { describe, expect, test } from 'bun:test';
import { Blackboard, isMaterialChange, emptyOrders } from './blackboard';
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
