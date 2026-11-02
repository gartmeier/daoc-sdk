import { describe, expect, test } from 'bun:test';
import { assist, buff, countCombatMessage, defaultBehaviors, heal, release, rest, shedLoad, tank, withCharacter, type Behavior, type StylePick } from './index';
import { pickStyleFromSeen } from './behaviors';
import { styleQueue } from '../actions';

const names = (list: Behavior[]) => list.map(b => b.name);
const own = (name: string): Behavior => ({ name, run: () => false });

describe('withCharacter', () => {
    const role = [release(), tank(), shedLoad(), buff(), rest()];

    test('no character: the role list as it is', () => {
        expect(withCharacter(role, null)).toBe(role);
        expect(withCharacter(role, undefined)).toBe(role);
    });

    test('fight replaces the role fight, react goes above, chores below', () => {
        expect(names(withCharacter(role, { react: [own('myHeal')], fight: [own('myFight')], chores: [own('myChore')] })))
            .toEqual(['release', 'myHeal', 'myFight', 'myChore', 'shedLoad', 'buff', 'rest']);
    });

    test('without a fight of its own it keeps the role fight', () => {
        expect(names(withCharacter(role, { react: [own('myHeal')] }))).toEqual(['release', 'myHeal', 'tank', 'shedLoad', 'buff', 'rest']);
    });

    test('a role list with no fight takes it where position() would keep it at range', () => {
        const healer = defaultBehaviors().healer;
        const list = names(withCharacter(healer, { fight: [own('myFight')] }));
        expect(list.indexOf('myFight')).toBe(list.indexOf('position') - 1);
        expect(list).toContain('heal');
    });

    test('every fight of the role goes, wherever it stands', () => {
        const nuker = [release(), heal(), assist(), assist({ melee: true }), rest()];
        expect(names(withCharacter(nuker, { fight: [own('myFight')] }))).toEqual(['release', 'heal', 'myFight', 'rest']);
    });
});

describe('countCombatMessage', () => {
    // Lines as the server sends them (fights.jsonl of both bots, and the handlers named in the code).
    const count = (...lines: string[]) => {
        const combat = { dealt: 0, styles: {}, missedStyles: 0 };
        for (const l of lines) countCombatMessage(l, combat);
        return combat;
    };

    test('weapons, spells, bleeds, crits and DoT ticks all count as damage', () => {
        expect(count('You attack the spraggon with your club and hit for 5 (-1) damage!').dealt).toBe(5);
        expect(count('You hit the feckless lucragan for 3 damage!').dealt).toBe(3);
        expect(count('You critical hit the spraggon for an additional 12 damage! (10%)').dealt).toBe(12);
        expect(count('You critically hit for an additional 7 damage!').dealt).toBe(7);
        expect(count('Your Blinding Rain hits the water beetle for 4 damage!').dealt).toBe(4);
    });

    test('styles landed and missed, by name', () => {
        expect(count('You perform your Misty Gloom perfectly!  (+1, GR: 0.035)', 'You perform your Misty Gloom perfectly!  (+1, GR: 0.035)', 'You fail to execute your Blinding Rain perfectly!'))
            .toEqual({ dealt: 0, styles: { 'Misty Gloom': 2 }, missedStyles: 1 });
    });

    test('what is done to us does not count', () => {
        expect(count('The spraggon hits your torso for 9 (-2) damage!', 'The spraggon attacks you and you parry the blow! (5.9%)').dealt).toBe(0);
    });
});

describe('style queue', () => {
    const named = (name: string, skillIndex: number) => ({ name, internalId: 0, specLevel: 1, specName: 'Blades', skillIndex, prerequisite: 0x100 });
    const styles = [named('Return Blade', 1), named('Taunting Blade', 2), named('Shining Blade', 3)];

    test('one name, or a style and its backup', () => {
        expect(styleQueue('Taunting Blade', styles).map(s => s.skillIndex)).toEqual([2]);
        expect(styleQueue(['Return Blade', 'Taunting Blade'], styles).map(s => s.skillIndex)).toEqual([1, 2]);
    });

    test('the server keeps two: what is unknown, repeated or beyond that goes', () => {
        expect(styleQueue(['Nope', 'Return Blade', 'Return Blade', 'Taunting Blade', 'Shining Blade'], styles).map(s => s.skillIndex)).toEqual([1, 2]);
        expect(styleQueue(null, styles)).toEqual([]);
    });
});

describe('pickStyleFromSeen', () => {
    const pick: StylePick = ({ styles }) => styles[0]?.name ?? null;
    const style = { name: 'Misty Gloom', internalId: 1, specLevel: 2, specName: 'Celtic Dual', skillIndex: 7, prerequisite: 0x100 };

    test('a style that exists comes back with its index', () => {
        expect(pickStyleFromSeen(pick, { target: {} as never, player: { endurancePercent: 80 } as never, state: {} as never, styles: [style] })).toEqual([style]);
    });

    test('no pick, an unknown name, or too little endurance: a plain swing', () => {
        const args = { target: {} as never, player: { endurancePercent: 80 } as never, state: {} as never, styles: [style] };
        expect(pickStyleFromSeen(() => null, args)).toEqual([]);
        expect(pickStyleFromSeen(() => 'Nope', args)).toEqual([]);
        expect(pickStyleFromSeen(pick, { ...args, player: { endurancePercent: 10 } as never })).toEqual([]);
    });
});
