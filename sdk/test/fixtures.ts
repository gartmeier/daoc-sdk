// Fabricated BotWorldState for unit tests (no server needed).

import type { BotWorldState, GameMessage, NearbyNpc, NearbyObject, NearbyPlayer, PlayerState } from '../types';

export function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
    return {
        name: 'Testbot', lastName: '', guildName: '', accountName: 'testbot', objectId: 100, sessionId: 5,
        level: 5, realm: 'albion', className: 'Fighter', raceName: 'Briton',
        regionId: 1, zoneId: 0, zoneName: 'Camelot Hills', x: 560000, y: 511000, z: 2500, heading: 0,
        speed: 0, maxSpeed: 191, maxSwimSpeed: 85, maxSpeedPercent: 100,
        health: 80, maxHealth: 100, healthPercent: 80, mana: 0, maxMana: 0, manaPercent: 0,
        endurance: 100, maxEndurance: 100, endurancePercent: 100, concentration: 0, maxConcentration: 0,
        experience: 1500, experienceForNextLevel: 4000, levelPermill: 375, realmPoints: 0, bountyPoints: 0,
        specPoints: 3, realmSpecPoints: 0,
        money: { copper: 50, silver: 2, gold: 1, mithril: 0, platinum: 0, totalCopper: 10250 },
        stats: null, constitutionLost: 0, encumbrance: null,
        isDead: false, isSitting: false, attacking: false, inCombat: false, targetObjectId: null,
        deathCount: 0, lastDeathAt: null,
        ...overrides,
    };
}

export function makeNpc(overrides: Partial<NearbyNpc> = {}): NearbyNpc {
    return {
        kind: 'npc', objectId: 200, name: 'rat', guildName: '', level: 1, model: 1, realm: 'none',
        x: 560100, y: 511000, z: 2500, heading: 0, distance: 100, distance2d: 100, lastSeenAgo: 0,
        healthPercent: 100, speed: 0, targetObjectId: null, inCombat: false,
        isPeaceful: false, isTargetable: true, hasQuest: false, isPet: false, role: null,
        ...overrides,
    };
}

export function makePlayerObj(overrides: Partial<NearbyPlayer> = {}): NearbyPlayer {
    return {
        kind: 'player', objectId: 300, sessionId: 7, name: 'Otherguy', guildName: '', lastName: '', level: 10, realm: 'albion',
        x: 560500, y: 511000, z: 2500, heading: 0, distance: 500, distance2d: 500, lastSeenAgo: 0,
        healthPercent: 100, isDead: false, isSitting: false, inCombat: false,
        ...overrides,
    };
}

export function makeObject(overrides: Partial<NearbyObject> = {}): NearbyObject {
    return {
        kind: 'object', objectId: 400, name: 'bag of coins', model: 488, realm: 'none',
        x: 560050, y: 511000, z: 2500, heading: 0, distance: 50, distance2d: 50, lastSeenAgo: 0,
        doorId: null, isLoot: true, ownedByUs: true,
        ...overrides,
    };
}

export function makeMessage(id: number, text: string, overrides: Partial<GameMessage> = {}): GameMessage {
    return { id, type: 'system', rawType: 0, text, sender: null, popup: false, receivedAt: 1000 + id, ...overrides };
}

export function makeState(overrides: Partial<BotWorldState> = {}): BotWorldState {
    return {
        tick: 1,
        revision: 1,
        timestamp: Date.now(),
        inGame: true,
        connection: { phase: 'playing', serverName: 'OpenDAoC', clientVersion: '1.127', lastError: null },
        player: makePlayer(),
        movement: { moving: false, destination: null, waypoints: [], lastStopReason: null, correctionCount: 0, swimming: false },
        nearbyNpcs: [
            makeNpc(),
            makeNpc({ objectId: 201, name: 'sewer rat', level: 3, distance: 300, distance2d: 300 }),
            makeNpc({ objectId: 202, name: 'Guard Edric', level: 50, realm: 'albion', isPeaceful: false, role: 'guard', distance: 800, distance2d: 800 }),
            makeNpc({ objectId: 203, name: 'Lady Grynoch', level: 20, realm: 'albion', isPeaceful: true, role: 'merchant', guildName: 'Merchant', distance: 250, distance2d: 250 }),
        ],
        nearbyPlayers: [makePlayerObj()],
        nearbyObjects: [makeObject(), makeObject({ objectId: 401, name: 'well', isLoot: false, ownedByUs: false, distance: 900, distance2d: 900 })],
        inventory: [
            { slot: 40, name: 'minor healing potion', level: 1, count: 3, model: 99, objectType: 0, condition: 100, durability: 100, quality: 85, weight: 5, value1: 0, value2: 0, hand: 0 },
            { slot: 41, name: 'rat tail', level: 1, count: 2, model: 1, objectType: 0, condition: 100, durability: 100, quality: 85, weight: 1, value1: 0, value2: 0, hand: 0 },
            { slot: 42, name: 'rat tail', level: 1, count: 1, model: 1, objectType: 0, condition: 100, durability: 100, quality: 85, weight: 1, value1: 0, value2: 0, hand: 0 },
        ],
        equipment: [
            { slot: 10, name: 'training sword', level: 1, count: 1, model: 3, objectType: 3, condition: 100, durability: 100, quality: 85, weight: 30, value1: 12, value2: 37, hand: 0 },
        ],
        vault: [],
        skills: {
            specializations: [{ name: 'Slash', level: 2, internalId: 1, bonus: 0 }],
            abilities: [{ name: 'Sprint', level: 1, internalId: 2, skillIndex: 4 }],
            styles: [{ name: 'Backslash', internalId: 3, specLevel: 2, specName: 'Slash', skillIndex: 7, prerequisite: 0x100 }],
            spells: [],
        },
        effects: [{ index: 0, name: 'Strength buff', icon: 1, spellId: 9, remainingSeconds: 60, isNegative: false }],
        group: [],
        gameMessages: [
            makeMessage(1, 'Welcome to OpenDAoC'),
            makeMessage(2, 'Otherguy says, "hello there"', { type: 'say', rawType: 1, sender: 'Otherguy' }),
            makeMessage(3, 'You say, "hi"', { type: 'say', rawType: 1, sender: null }),
        ],
        npcDialog: null,
        dialog: null,
        textWindow: null,
        merchant: { isOpen: false, merchantObjectId: null, windowType: 0, items: [] },
        trade: null,
        trainer: { isOpen: false, specPoints: 0, specs: [] },
        combatEvents: [],
        ...overrides,
    };
}
