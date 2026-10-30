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

    test('isMaterialChange: phase, focus, puller, cc and big moves', () => {
        const a = emptyOrders(0);
        expect(isMaterialChange(a, { ...a, focus: 7 })).toBe(true);
        expect(isMaterialChange(a, { ...a, cc: [{ targetId: 8, by: 'Bard' }] })).toBe(true);
        expect(isMaterialChange(a, { ...a, reason: 'other words' })).toBe(false);
        expect(isMaterialChange({ ...a, retreatTo: { x: 0, y: 0, z: 0 } }, { ...a, retreatTo: { x: 500, y: 0, z: 0 } })).toBe(true);
    });
});
