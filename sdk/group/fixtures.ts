// Test fixtures for group coordination: member reports, sightings, pictures.

import type { Observation } from './blackboard';
import { emptyOrders } from './blackboard';
import type { Contact, GroupPicture, MemberReport, Orders, Sighting } from './types';

export function report(name: string, over: Partial<MemberReport> = {}): MemberReport {
    return {
        name, bot: name.toLowerCase(), role: 'nuker', className: 'Mentalist', level: 6, experience: 1000,
        objectId: name.length * 100, regionId: 200, x: 1000, y: 1000, z: 0,
        hp: 100, mana: 100, endurance: 100, load: 10, isDead: false, isSitting: false, inCombat: false, attacking: false, targetId: null,
        effects: [], capabilities: { heal: false, cc: false, nuke: true, buffs: [] },
        activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, at: Date.now(),
        ...over,
    };
}

export function sighting(objectId: number, over: Partial<Sighting> = {}): Sighting {
    return { objectId, kind: 'npc', name: 'water beetle', level: 6, realm: 'none', x: 1500, y: 1000, z: 0, hp: 100, targetId: null, inCombat: false, swinging: false, ...over };
}

export function obs(r: MemberReport, sightings: Sighting[] = [], deaths: number[] = []): Observation {
    return { report: r, sightings, deaths };
}

export function contact(objectId: number, over: Partial<Contact> = {}): Contact {
    const now = Date.now();
    return {
        ...sighting(objectId), regionId: 200, target: null, targetSince: now, seenBy: ['Tank'], firstSeen: now, lastSeen: now,
        stale: false, threat: false, hostileSince: 0, cc: null, ...over,
    };
}

export function picture(members: MemberReport[], contacts: Contact[] = [], orders: Partial<Orders> = {}, at = Date.now()): GroupPicture {
    return { at, members, contacts, orders: { ...emptyOrders(at), ...orders } };
}
