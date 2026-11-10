import { describe, expect, test } from 'bun:test';
import { makePlayer, makePlayerObj, makeState } from '../test/fixtures';
import type { CombatEvent } from '../types';
import { Blackboard, observeState, type MemberSelf } from './blackboard';
import { addLook, classKit, CLASS_ROLES, newEvidence, readClass, roleOfClass, type FoeLook } from './class-read';
import { getClasses } from '../../data/index';

// The arena's GM gear (gear-template.ts MODELS): plate, chain and cloth sets, a Paladin's sword and large shield, a Healer's hammer and small shield, a caster's staff.
const PLATE: [number, number][] = [[21, 93], [22, 89], [23, 90], [25, 46], [27, 87], [28, 88]];
const MID_CHAIN: [number, number][] = [[21, 834], [22, 278], [23, 279], [25, 275], [27, 276], [28, 277]];
const ALB_CLOTH: [number, number][] = [[21, 822], [22, 142], [23, 143], [25, 378], [27, 379], [28, 380]];

const read = (race: string, realm: 'albion' | 'midgard' | 'hibernia', look: FoeLook, level = 24) => {
    const ev = newEvidence(race, realm, level);
    addLook(ev, look);
    return readClass(ev)!;
};
/** An effect `a` can cast at `level` and none of `others` can. */
const onlyOf = (a: string, others: string[], level = 24) => {
    const theirs = new Set(others.flatMap(o => classKit(o, 50)!.effects));
    return classKit(a, level)!.effects.find(e => !theirs.has(e))!;
};

describe('readClass', () => {
    test('every class the realms can meet has a role', () => {
        for (const c of getClasses()) expect(CLASS_ROLES[c.key]).toBeDefined();
        expect(roleOfClass('Healer')).toBe('healer');
        expect(roleOfClass('Sorcerer')).toBe('cc');
    });

    test('race alone: the realm\'s classes that race can be, evenly', () => {
        const g = read('Dwarf', 'midgard', {});
        expect(g.basis).toEqual(['race Dwarf']);
        expect(g.p.every(p => p === g.p[0])).toBe(true);
        expect(g.classes).not.toContain('Spiritmaster'); // no Dwarf Spiritmaster (classes.json eligibleRaceIds)
    });

    test('plate and a large shield: a tank, Armsman or Paladin', () => {
        const g = read('Briton', 'albion', { gear: [...PLATE, [10, 10], [11, 60]] });
        expect(g.classes.slice(0, 2).sort()).toEqual(['Armsman', 'Paladin']);
        expect(g.role).toBe('tank');
        expect(g.basis).toContain('armour plate');
    });

    test('cloth and a staff: a caster; one spell of its own says which', () => {
        const g = read('Briton', 'albion', { gear: [...ALB_CLOTH, [12, 19]] });
        expect(g.role).toBe('caster');
        expect(g.classes).toContain('Cabalist');
        const own = onlyOf('Cabalist', ['Sorcerer', 'Wizard', 'Theurgist', 'Necromancer']);
        expect(read('Briton', 'albion', { gear: [...ALB_CLOTH, [12, 19]], effects: [own] }).classes[0]).toBe('Cabalist');
    });

    test('a Healer in chain with a hammer and small shield: a spell of its own picks it from the Warriors and Thanes', () => {
        const look: FoeLook = { gear: [...MID_CHAIN, [10, 320], [11, 59]] };
        expect(read('Dwarf', 'midgard', look).classes).toEqual(expect.arrayContaining(['Healer', 'Warrior', 'Thane']));
        const heal = onlyOf('Healer', ['Warrior', 'Thane', 'Skald', 'Shaman']);
        const g = read('Dwarf', 'midgard', { ...look, effects: [heal] });
        expect(g.classes[0]).toBe('Healer');
        expect(g.role).toBe('healer');
    });

    test('a style shows the line: a Shield style, a class with Shields', () => {
        const shieldStyle = classKit('Warrior', 24)!.styles.find(s => !classKit('Healer', 50)!.styles.includes(s) && !classKit('Shaman', 50)!.styles.includes(s))!;
        const g = read('Dwarf', 'midgard', { styles: [shieldStyle] });
        expect(g.classes).not.toContain('Healer');
        expect(g.basis).toContain('styles 1');
    });

    test('a Warrior from a Thane: swinging 30 s in chain behind a big shield and never a cast', () => {
        const ev = newEvidence('Troll', 'midgard', 24);
        addLook(ev, { gear: [...MID_CHAIN, [10, 319], [11, 60]] }, 24, 0);
        const before = readClass(ev)!;
        for (let t = 0; t <= 30_000; t += 250) addLook(ev, { swung: true }, 24, t);
        const after = readClass(ev)!;
        expect(after.classes[0]).toBe('Warrior');
        expect(after.p[0]).toBeGreaterThan(before.p[before.classes.indexOf('Warrior')]!);
        expect(after.role).toBe('tank');
        expect(after.basis.at(-1)).toBe('no casts in 30 s of swinging');
        // One cast and it is a caster again: the quiet counts for nothing.
        addLook(ev, { cast: true }, 24, 31_000);
        expect(readClass(ev)!.p).toEqual(before.p);
        // Gaps don't count: a swing 5 s after the last adds 1 s.
        const gap = newEvidence('Troll', 'midgard', 24);
        addLook(gap, { swung: true }, 24, 1000);
        addLook(gap, { swung: true }, 24, 6000);
        expect(gap.swingMs).toBe(1000);
    });

    test('one odd effect weakens a class, it doesn\'t empty the list', () => {
        const odd = onlyOf('Runemaster', ['Healer']);
        const heal = onlyOf('Healer', ['Runemaster', 'Warrior', 'Thane', 'Skald', 'Shaman']);
        const g = read('Dwarf', 'midgard', { gear: [...MID_CHAIN, [10, 320], [11, 59]], effects: [odd, heal, onlyOf('Healer', ['Runemaster'], 24)] });
        expect(g.classes[0]).toBe('Healer');
    });

    test('a Hero from a Champion: the same scale, shield and blades, and no cast in 25 s leans tank', () => {
        const ev = newEvidence('Celt', 'hibernia', 24);
        addLook(ev, { gear: [[21, 840], [22, 431], [23, 432], [25, 428], [27, 429], [28, 430], [10, 473], [11, 60]] }, 24, 1000);
        const tied = readClass(ev)!;
        expect(tied.classes.slice(0, 2).sort()).toEqual(['Champion', 'Hero']);
        expect(tied.p[0]).toBe(tied.p[1]!);
        for (let t = 1000; t <= 31_000; t += 250) addLook(ev, { swung: true }, 24, t);
        const g = readClass(ev)!;
        expect(g.classes[0]).toBe('Hero');
        expect(g.role).toBe('tank');
    });

    test('effects no class of the realm has count for nothing', () => {
        const g = read('Dwarf', 'midgard', { effects: [65000] });
        expect(g.basis).toEqual(['race Dwarf']);
    });

    test('a spell above its level is no match: a level 5 can\'t show a level 40 spell', () => {
        const late = classKit('Healer', 50)!.effects.find(e => !classKit('Healer', 5)!.effects.includes(e) && !['Warrior', 'Thane', 'Skald', 'Shaman', 'Berserker', 'Savage', 'Hunter', 'Runemaster', 'Shadowblade', 'Bonedancer', 'Spiritmaster'].some(o => classKit(o, 50)!.effects.includes(e)));
        expect(late).toBeDefined();
        expect(read('Dwarf', 'midgard', { effects: [late!] }, 50).classes[0]).toBe('Healer');
        expect(read('Dwarf', 'midgard', { effects: [late!] }, 5).classes[0]).not.toBe('Healer');
    });
});

describe('the board reads enemy players', () => {
    const self: MemberSelf = { bot: 'tank', role: 'tank', capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] }, activity: { kind: 'idle', targetId: null, detail: '', since: 0 } };
    const T = 1_000_000;
    const ev = (kind: CombatEvent['kind'], by: number, on: number | null, over: Partial<CombatEvent> = {}): CombatEvent => ({ id: 1, kind, attackerObjectId: by, targetObjectId: on, receivedAt: T - 500, ...over });
    const heal = onlyOf('Healer', ['Warrior', 'Thane', 'Skald', 'Shaman']);

    test('gear and a cast reach the contact as a guess; it outlasts the contact and starts over under a new race', () => {
        const players = [makePlayerObj({ objectId: 300, name: 'Dwarf', realm: 'midgard', level: 24, gear: { activeWeapons: 0x10, items: MID_CHAIN.map(([slot, model]) => ({ slot, model })), at: T } })];
        const state = (combatEvents: CombatEvent[], at = T, nearby = players) => makeState({ timestamp: at, player: makePlayer({ objectId: 100 }), nearbyNpcs: [], nearbyPlayers: nearby, combatEvents });
        const o = observeState(state([ev('spellCast', 300, null, { effectId: heal, castTimeMs: 3000 }), ev('melee', 300, 100, { result: 'hit', weaponModel: 320 })]), self)!;
        expect(o.sightings[0]!.look).toEqual({ gear: MID_CHAIN, effects: [heal], weapons: [320], cast: true, swung: true });

        const board = new Blackboard({ forgetAfterMs: 30_000 });
        board.publish(o, T);
        const c = board.picture(T).contacts[0]!;
        expect(c.classGuess?.classes[0]).toBe('Healer');
        expect(c.classGuess?.role).toBe('healer');
        expect('look' in c).toBe(false);

        // Out of view and forgotten, then back with nothing new to show: the read stays.
        board.picture(T + 40_000);
        expect(board.picture(T + 40_000).contacts).toHaveLength(0);
        board.publish(observeState(state([], T + 41_000, [makePlayerObj({ objectId: 300, name: 'Dwarf', realm: 'midgard', level: 24 })]), self)!, T + 41_000);
        expect(board.picture(T + 41_000).contacts[0]!.classGuess?.classes[0]).toBe('Healer');

        // Another player under the id: its own read.
        board.publish(observeState(state([], T + 42_000, [makePlayerObj({ objectId: 300, name: 'Norseman', realm: 'midgard', level: 24 })]), self)!, T + 42_000);
        expect(board.picture(T + 42_000).contacts[0]!.classGuess?.basis).toEqual(['race Norseman']);
    });
});
