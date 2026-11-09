import { describe, expect, test } from 'bun:test';
import { assist, Blackboard, buff, countCombatMessage, defaultBehaviors, heal, MemberAgent, release, rest, shedLoad, tank, withCharacter, type Behavior, type MemberCombat, type StylePick } from './index';
import { pickStyleFromSeen } from './behaviors';
import { styleQueue, type BotActions } from '../actions';
import type { BotSDK } from '../index';
import { makeMessage, makeState } from '../test/fixtures';

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

    test('no fight and no position (the pack\'s support): urgent above its main action, react, fight and chores at shedLoad', () => {
        const support = [release(), own('flee'), own('interrupt'), own('crowdControl'), own('song'), shedLoad(), buff(), rest()];
        expect(names(withCharacter(support, { urgent: [own('cureMezz')], react: [own('myReact')], fight: [own('myFight')], chores: [own('myChore')] })))
            .toEqual(['release', 'flee', 'cureMezz', 'interrupt', 'crowdControl', 'song', 'myReact', 'myFight', 'myChore', 'shedLoad', 'buff', 'rest']);
        const healer = [release(), own('emergencyHeal'), own('flee'), heal(), own('crowdControl'), shedLoad(), rest()];
        expect(names(withCharacter(healer, { urgent: [own('cureMezz')] })))
            .toEqual(['release', 'emergencyHeal', 'flee', 'cureMezz', 'heal', 'crowdControl', 'shedLoad', 'rest']);
        // React stays where it was: below heal and crowd control.
        expect(names(withCharacter(healer, { react: [own('cureMezz')] })))
            .toEqual(['release', 'emergencyHeal', 'flee', 'heal', 'crowdControl', 'cureMezz', 'shedLoad', 'rest']);
    });

    test('with a fight, urgent goes where react does, ahead of it', () => {
        expect(names(withCharacter(role, { urgent: [own('cure')], react: [own('myHeal')] }))).toEqual(['release', 'cure', 'myHeal', 'tank', 'shedLoad', 'buff', 'rest']);
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
    test('a blow its own pet took for it, by name: "The spirit soldier steps in front of you and takes the blow!" (Ability.txt:117, AttackComponent.cs:1900)', () => {
        const LINE = 'The spirit soldier steps in front of you and takes the blow!';
        const own = { styles: new Set<string>(), spells: new Set<string>(), pet: 'spirit soldier' };
        const combat: MemberCombat = { dealt: 0, styles: {}, missedStyles: 0 };
        countCombatMessage(LINE, combat, own);
        countCombatMessage(LINE, combat, own);
        expect(combat).toEqual({ dealt: 0, styles: {}, missedStyles: 0, petIntercepts: 2 });
        // A groupmate's reads the same with its own name, and with no pet it can't be ours.
        const other: MemberCombat = { dealt: 0, styles: {}, missedStyles: 0 };
        countCombatMessage('Gawain steps in front of you and takes the blow!', other, own);
        countCombatMessage(LINE, other, { ...own, pet: undefined });
        countCombatMessage(LINE, other);
        expect(other).toEqual({ dealt: 0, styles: {}, missedStyles: 0 });
    });

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

    describe('a pet\'s lines (live pet runs)', () => {
        const known = (styles: string[] = [], spells: string[] = []) => ({ styles: new Set(styles), spells: new Set(spells) });
        const seen = (names: ReturnType<typeof known>, ...lines: string[]) => {
            const combat: MemberCombat = { dealt: 0, styles: {}, missedStyles: 0 };
            for (const l of lines) countCombatMessage(l, combat, names);
            return combat;
        };

        test('its blows, shots, crits, procs and shields go to petDealt, whatever `own` says', () => {
            for (const names of [undefined, known()]) {
                const pet = (line: string) => { const c: MemberCombat = { dealt: 0, styles: {}, missedStyles: 0 }; countCombatMessage(line, c, names); return c; };
                expect(pet('Your spirit soldier attacks the sveawolf cub and hits for 42 damage!')).toEqual({ dealt: 0, styles: {}, missedStyles: 0, petDealt: 42 });
                expect(pet('Your spirit soldier attacks the roaming thrall and hits for 22 (-2) damage!').petDealt).toBe(22);
                expect(pet('Your earth spirit attacks the spriggarn elder and hits for 37 (-7) damage!').petDealt).toBe(37);
                expect(pet('Your skeletal commander attacks the large sveawolf and hits for 57 (+26) damage!').petDealt).toBe(57);
                expect(pet('Your bone dart shoots the arachite priest and hits for 34 damage!').petDealt).toBe(34);
                expect(pet('Your necroservant critically hits the giant wolf for an additional 29 damage! (10%)').petDealt).toBe(29);
                expect(pet('Your skeletal commander hit the wolf for 12 damage!').petDealt).toBe(12);
                expect(pet('Your spirit soldier hit the rock crab for 5 damage!').petDealt).toBe(5);
            }
        });

        test('it adds up, and nothing else moves', () => {
            expect(seen(known(), 'Your hunter\'s pet attacks the black mauler and hits for 21 damage!', 'Your hunter\'s pet attacks the soft-shelled crab and hits for 68 damage!', 'You hit the crab for 3 damage!'))
                .toEqual({ dealt: 3, styles: {}, missedStyles: 0, petDealt: 89 });
        });

        test('"Your X hits": a spell of ours is ours, anything else the pet\'s; with no names, ours as before', () => {
            const mine = known([], ['Lesser Decrepify']);
            expect(seen(mine, 'Your Lesser Decrepify hits the wolf spiderling for 4 damage!')).toMatchObject({ dealt: 4 });
            expect(seen(mine, 'Your Lesser Decrepify hits the wolf spiderling for 4 damage!').petDealt).toBeUndefined();
            expect(seen(mine, 'Your underhill companion hits the hill toad for 39 damage!')).toMatchObject({ dealt: 0, petDealt: 39 });
            expect(seen(mine, 'Your ruby simulacrum hits the wolf for 33 (-2) damage!')).toMatchObject({ dealt: 0, petDealt: 33 });
            expect(count('Your underhill companion hits the hill toad for 39 damage!')).toEqual({ dealt: 39, styles: {}, missedStyles: 0 });
        });

        test('"You perform your X perfectly": ours only if X is a style of ours (AttackComponent.cs:1785-1789); with no names, ours as before', () => {
            const line = 'You perform your Havoc perfectly!  (+16, GR: 0.722)';
            expect(seen(known(), line).styles).toEqual({});
            expect(seen(known(['Misty Gloom']), line).styles).toEqual({});
            expect(seen(known(['Havoc']), line).styles).toEqual({ Havoc: 1 });
            expect(count(line).styles).toEqual({ Havoc: 1 });
        });

        test('a miss, a fumble or a hit on the pet counts for nobody', () => {
            expect(seen(known(), 'The spirit soldier attacks the rock crab and misses! (14%)', 'The spirit soldier fumbled!', 'The hill toad hits your underhill friend for 10 damage.', 'The hill toad attacks your underhill friend and misses!'))
                .toEqual({ dealt: 0, styles: {}, missedStyles: 0 });
        });
    });
});

describe('MemberAgent counts a pet\'s lines by the member\'s own names', () => {
    const agentWith = (lines: string[], skills: { styles?: { name: string }[]; spells?: { name: string }[] } = {}) => {
        const state = makeState({ gameMessages: [] });
        const sdk = {
            getState: () => state, getPlayer: () => state.player, getSkills: () => skills,
            getGameMessages: () => state.gameMessages, onStateUpdate: () => () => {},
        } as unknown as BotSDK;
        const bot = { getSpellInfo: () => null } as unknown as BotActions;
        const board = new Blackboard();
        const agent = new MemberAgent({ bot: 'testbot', role: 'nuker', sdk, actions: bot }, board, [], {});
        state.gameMessages = lines.map((text, i) => makeMessage(i + 1, text));
        agent.publish();
        const report = board.picture().members[0]!;
        agent.dispose();
        return report.combat!;
    };

    test('a pet\'s style and its spell stay out of the member\'s record; its own stay in', () => {
        const lines = ['You perform your Havoc perfectly!  (+16, GR: 0.722)', 'You perform your Misty Gloom perfectly!  (+1, GR: 0.035)', 'Your skeletal commander attacks the large sveawolf and hits for 57 damage!', 'Your Lesser Decrepify hits the wolf spiderling for 4 damage!'];
        expect(agentWith(lines, { styles: [{ name: 'Misty Gloom' }], spells: [{ name: 'Lesser Decrepify' }] }))
            .toEqual({ dealt: 4, styles: { 'Misty Gloom': 1 }, missedStyles: 0, petDealt: 57 });
    });

    test('before the skill list is in, nothing tells them apart: as without names', () => {
        expect(agentWith(['You perform your Misty Gloom perfectly!  (+1, GR: 0.035)', 'Your Lesser Decrepify hits the wolf spiderling for 4 damage!']))
            .toEqual({ dealt: 4, styles: { 'Misty Gloom': 1 }, missedStyles: 0 });
    });

    test('a group with no pets shows no petDealt at all', () => {
        expect(agentWith(['You hit the feckless lucragan for 3 damage!'], { spells: [{ name: 'Moon Blast' }] })).not.toHaveProperty('petDealt');
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

describe('MemberAgent: a failed action paces the turn (failedTurnMs)', () => {
    const sdk = (state = makeState({ gameMessages: [] })) => ({
        getState: () => state, getPlayer: () => state.player, getSkills: () => ({}), getGameMessages: () => state.gameMessages, onStateUpdate: () => () => {},
    }) as unknown as BotSDK;
    const bot = { getSpellInfo: () => null } as unknown as BotActions;
    const turns = async (behaviors: Behavior[], ms: number) => {
        const agent = new MemberAgent({ bot: 'testbot', role: 'nuker', sdk: sdk(), actions: bot }, new Blackboard(), behaviors, {}, { minTurnMs: 10, idleMs: 10, failedTurnMs: 150 });
        const stop = new AbortController();
        const running = agent.run(stop.signal);
        await Bun.sleep(ms);
        stop.abort(new Error('test over'));
        await running.catch(() => {});
        agent.dispose();
    };

    test('a refusal that comes back at once: one try per failedTurnMs, not one per minTurnMs', async () => {
        let tries = 0;
        await turns([{ name: 'nuke', run(ctx) { tries++; ctx.result('nuke', { success: false, reason: 'invalid_target', message: 'no' }); return true; } }], 400);
        expect(tries).toBeGreaterThanOrEqual(2);
        expect(tries).toBeLessThanOrEqual(4);
    });

    test('in a behaviour that falls through at the bottom of the list too', async () => {
        let tries = 0;
        await turns([{ name: 'rest', run(ctx) { tries++; ctx.result('rest', { success: false, reason: 'refused', message: 'no' }); return false; } }], 400);
        expect(tries).toBeLessThanOrEqual(4);
    });

    test('an action that worked is paced by minTurnMs alone', async () => {
        let tries = 0;
        await turns([{ name: 'nuke', run(ctx) { tries++; ctx.result('nuke', { success: true, message: 'ok' }); return true; } }], 300);
        expect(tries).toBeGreaterThan(8);
    });

    test('a failure that took its time costs no more; one above what acted costs nothing', async () => {
        let slow = 0;
        await turns([{ name: 'nuke', async run(ctx) { slow++; await Bun.sleep(160); ctx.result('nuke', { success: false, reason: 'interrupted', message: 'no' }); return true; } }], 500);
        expect(slow).toBeGreaterThanOrEqual(2);
        let acted = 0;
        await turns([
            { name: 'sprint', run(ctx) { ctx.result('sprint', { success: false, reason: 'not_found', message: 'no' }); return false; } },
            { name: 'nuke', run() { acted++; return true; } },
        ], 300);
        expect(acted).toBeGreaterThan(8);
    });
});
