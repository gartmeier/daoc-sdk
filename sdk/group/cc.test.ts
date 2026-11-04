import { describe, expect, test } from 'bun:test';
import { spellMessagePattern } from '../actions-helpers';
import type { GameMessage } from '../types';
import { Blackboard, observeState, type MemberSelf } from './blackboard';
import { CC_IMMUNE_MS, canControl, ccKindOfType, immuneKinds, npcCcLanded, readCcEnds, serverNameKey } from './cc';
import { contact, enemy, obs, report, sighting } from './fixtures';
import { MemberAgent } from './member';
import { assignCc, PVE_SETTINGS } from './pve';
import type { Capabilities } from './types';

const T = 1_000_000;
const R = 200;
const player = (over = {}) => sighting(7, { kind: 'player', name: 'Celt', realm: 'hibernia', ...over });
const line = (text: string, receivedAt = T, type: GameMessage['type'] = 'spellExpires'): GameMessage => ({ id: receivedAt, type, rawType: 25, text, sender: null, popup: false, receivedAt });

function board(s = player()) {
    const b = new Blackboard();
    b.publish(obs(report('Bard', { at: T }), [s]), T);
    return { b, c: (now = T) => b.picture(now).contacts[0]! };
}
/** A sighting at `at`, with what the server told this member. */
const look = (b: Blackboard, at: number, s = player(), ccEnds: { name: string; kind: 'mezz' | 'root' | 'stun'; at: number }[] = []) =>
    b.publish({ ...obs(report('Bard', { at }), [s]), ccEnds }, at);

describe('the server\'s rules', () => {
    test('a kind per spell type: roots and snares share one', () => {
        expect(['Mesmerize', 'Stun', 'SpeedDecrease', 'UnbreakableSpeedDecrease', 'DamageSpeedDecrease', 'Heal'].map(ccKindOfType)).toEqual(['mezz', 'stun', 'root', 'root', null, null]);
    });

    test('a monster\'s repeats: 7 s stun measured live at 7, 3.5, 1.75, 1.2, then immune until 60 s after the first', () => {
        let run: ReturnType<typeof npcCcLanded>['run'] | undefined;
        const out = [0, 10_000, 20_000, 30_000].map(at => {
            const r = npcCcLanded(run, 7000, T + at);
            run = r.run;
            return r;
        });
        expect(out.map(r => Math.round(r.durationMs))).toEqual([7000, 3500, 1750, 1167]);
        expect(out.map(r => r.immuneUntil)).toEqual([null, null, null, T + 60_000]);
        // The window runs from the first, however many came since.
        expect(npcCcLanded(run, 7000, T + 60_000).durationMs).toBe(7000);
    });

    test('a long mezz takes more repeats before it is too short', () => {
        expect(npcCcLanded({ count: 7, since: T }, 16_000, T + 1000)).toMatchObject({ durationMs: 16_000 / 14, immuneUntil: null });
        expect(npcCcLanded({ count: 8, since: T }, 16_000, T + 1000)).toMatchObject({ durationMs: 1000, immuneUntil: T + 60_000 });
    });

    test('the names in the server\'s messages', () => {
        expect(serverNameKey('The ccdummy')).toBe('ccdummy');
        expect(serverNameKey('A tomte mystic')).toBe('tomte mystic');
        expect(serverNameKey('Oisin')).toBe('oisin');
        expect(spellMessagePattern('{0} is entranced!').exec('Oisin is entranced!')![1]).toBe('Oisin');
        expect(spellMessagePattern("{0}'s feet are frozen to the ground!").exec("The ccdummy's feet are frozen to the ground!")![1]).toBe('The ccdummy');
        expect(spellMessagePattern('Rocks rise from the ground and trip {0}!').exec('Rocks rise from the ground and trip Oisin!')![1]).toBe('Oisin');
        expect(spellMessagePattern('{0} is entranced!').test('Oisin is no longer entranced.')).toBe(false);
    });

    test('ends are read from the spell data, only from new spell-expiry lines', () => {
        expect(readCcEnds([line('Oisin is no longer entranced.'), line('Oisin recovers from the mesmerize.'), line('Oisin recovers from the stun.')], T - 1).map(e => [e.name, e.kind])).toEqual([['Oisin', 'mezz'], ['Oisin', 'mezz'], ['Oisin', 'stun']]);
        expect(readCcEnds([line('Oisin is no longer entranced.', T)], T)).toEqual([]);
        expect(readCcEnds([line('Oisin is no longer entranced.', T, 'spell')], T - 1)).toEqual([]);
        expect(readCcEnds([line('Your coordination returns.')], T - 1)).toEqual([]);
    });

    test('observeState passes them on', () => {
        const self: MemberSelf = { bot: 'b', role: 'tank', activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] } };
        const state = { inGame: true, timestamp: T, player: { name: 'B', objectId: 1, regionId: R, x: 0, y: 0, z: 0, realm: 'midgard', encumbrance: null }, nearbyNpcs: [], nearbyPlayers: [], effects: [], combatEvents: [], gameMessages: [line('Oisin is no longer entranced.', T - 500), line('Oisin recovers from the stun.', T - 5000)] } as never;
        expect(observeState(state, self)!.ccEnds).toEqual([{ name: 'Oisin', kind: 'mezz', at: T - 500 }]);
    });
});

describe('the board: a player', () => {
    test('a landed mezz: held, and no more mezzes until 60 s after its whole length; other kinds stay open', () => {
        const { b, c } = board();
        b.markCc(7, R, 'Bard', 'mezz', 30_000, T);
        expect(c()).toMatchObject({ cc: { by: 'Bard', kind: 'mezz', until: T + 30_000 }, ccImmune: { mezz: T + 30_000 + CC_IMMUNE_MS } });
        expect(immuneKinds(c())).toEqual([]); // By the clock of the test's own T, long past: the next line reads at T.
        expect(immuneKinds(c(), T)).toEqual(['mezz']);
        expect(canControl(c(), ['mezz'], T)).toBe(false);
        expect(canControl(c(), ['mezz', 'root'], T)).toBe(true);
    });

    test('the server says it ended: the immunity runs from then, once, whoever heard it', () => {
        const { b, c } = board();
        b.markCc(7, R, 'Bard', 'mezz', 30_000, T, 'Oisin');
        const end = T + 12_000;
        look(b, end, player(), [{ name: 'Oisin', kind: 'mezz', at: end }]);
        expect(c(end)).toMatchObject({ cc: null, ccImmune: { mezz: end + CC_IMMUNE_MS }, serverName: 'Oisin' });
        // Reported for a few seconds more: it changes nothing.
        look(b, end + 1000, player(), [{ name: 'Oisin', kind: 'mezz', at: end }]);
        expect(c(end + 1000).ccImmune!.mezz).toBe(end + CC_IMMUNE_MS);
    });

    test('an old end does not end a later mezz, and another player\'s end is another player\'s', () => {
        const { b, c } = board();
        b.markCc(7, R, 'Bard', 'mezz', 30_000, T + 5000, 'Oisin');
        look(b, T + 6000, player(), [{ name: 'Oisin', kind: 'mezz', at: T + 1000 }, { name: 'Brigid', kind: 'mezz', at: T + 6000 }]);
        expect(c(T + 6000).cc).not.toBeNull();
    });

    test('a swing breaks a mezz (immunity from then), a stun too', () => {
        for (const kind of ['mezz', 'stun'] as const) {
            const { b, c } = board();
            const notes: string[] = [];
            b.onEvent(e => { if (e.kind === 'note') notes.push(e.text); });
            b.markCc(7, R, 'Bard', kind, 30_000, T);
            look(b, T + 5000, player({ swinging: true }));
            expect(c(T + 5000)).toMatchObject({ cc: null, ccImmune: { [kind]: T + 5000 + CC_IMMUNE_MS } });
            expect(notes).toEqual([`${kind} on Celt broke`]);
        }
    });

    test('a root holds half its length, and swinging only frees the group to kill it: the root stays on, so nobody roots it again', () => {
        const { b, c } = board();
        const notes: string[] = [];
        b.onEvent(e => { if (e.kind === 'note') notes.push(e.text); });
        b.markCc(7, R, 'Druid', 'root', 30_000, T);
        expect(c(T)).toMatchObject({ cc: { kind: 'root', until: T + 15_000 }, ccImmune: { root: T + 30_000 + CC_IMMUNE_MS } });
        look(b, T + 5000, player({ swinging: true }));
        expect(c(T + 5000)).toMatchObject({ cc: null, ccImmune: { root: T + 30_000 + CC_IMMUNE_MS } });
        expect(notes).toEqual([]);
    });

    test('walking off says a root broke: the immunity runs from then', () => {
        const { b, c } = board();
        const notes: string[] = [];
        b.onEvent(e => { if (e.kind === 'note') notes.push(e.text); });
        b.markCc(7, R, 'Druid', 'root', 30_000, T);
        look(b, T + 3000, player({ x: 1500 + 40 })); // Creeping, or a stale position.
        expect(c(T + 3000).cc).not.toBeNull();
        look(b, T + 5000, player({ x: 1500 + 400 }));
        expect(c(T + 5000)).toMatchObject({ cc: null, ccImmune: { root: T + 5000 + CC_IMMUNE_MS } });
        expect(notes).toEqual(['root on Celt broke']);
    });

    test('an answer from the server marks that kind, up to the length given, unless we know better', () => {
        const { b, c } = board();
        b.markCcImmune(7, R, 'root', 60_000, T);
        expect(c(T).ccImmune).toEqual({ root: T + 60_000 });
        b.markCcImmune(7, R, 'root', 90_000, T + 1000);
        expect(c(T + 1000).ccImmune).toEqual({ root: T + 60_000 });
        expect(c(T + 60_000).ccImmune).toEqual({});
    });

    test('what we know outlasts its leaving view, but not its death', () => {
        const b = new Blackboard({ forgetAfterMs: 30_000 });
        b.publish(obs(report('Bard', { at: T }), [player()]), T);
        b.markCc(7, R, 'Bard', 'mezz', 30_000, T, 'Oisin');
        expect(b.picture(T + 31_000).contacts).toEqual([]);
        b.publish(obs(report('Bard', { at: T + 40_000 }), [player()]), T + 40_000);
        expect(b.picture(T + 40_000).contacts[0]).toMatchObject({ ccImmune: { mezz: T + 90_000 }, serverName: 'Oisin', cc: null });
        b.publish({ ...obs(report('Bard', { at: T + 41_000 }), []), deaths: [7] }, T + 41_000);
        b.publish(obs(report('Bard', { at: T + 100_000 }), [player()]), T + 100_000);
        expect(b.picture(T + 100_000).contacts[0]!.ccImmune).toBeUndefined();
    });
});

describe('the board: a monster', () => {
    const mob = (over = {}) => sighting(7, { name: 'ccdummy', ...over });

    test('no immunity after a mezz, but each repeat within the window is shorter, and past a point it takes none', () => {
        const { b, c } = board(mob());
        b.markCc(7, R, 'Bard', 'stun', 7000, T);
        expect(c(T)).toMatchObject({ cc: { until: T + 7000 } });
        expect(c(T).ccImmune).toBeUndefined();
        b.markCc(7, R, 'Bard', 'stun', 7000, T + 8000);
        expect(c(T + 8000)).toMatchObject({ cc: { until: T + 8000 + 3500 } });
        b.markCc(7, R, 'Bard', 'stun', 7000, T + 12_000);
        b.markCc(7, R, 'Bard', 'stun', 7000, T + 14_000);
        expect(c(T + 14_000).ccImmune).toEqual({ stun: T + 60_000 });
        expect(canControl(c(T + 14_000), ['stun'], T + 14_000)).toBe(false);
    });

    test('a root has no limit', () => {
        const { b, c } = board(mob());
        for (const at of [0, 20_000, 40_000]) b.markCc(7, R, 'Druid', 'root', 30_000, T + at);
        expect(c(T + 40_000).cc!.until).toBe(T + 40_000 + 15_000);
        expect(c(T + 40_000).ccImmune).toBeUndefined();
    });

    test('its end goes by name with its article off, when only one of that name is under that kind', () => {
        const { b, c } = board(mob());
        b.markCc(7, R, 'Bard', 'mezz', 28_000, T);
        look(b, T + 3000, mob(), [{ name: 'The ccdummy', kind: 'mezz', at: T + 3000 }]);
        expect(c(T + 3000).cc).toBeNull();

        const two = new Blackboard();
        two.publish(obs(report('Bard', { at: T }), [mob(), sighting(8, { name: 'ccdummy', x: 1700 })]), T);
        two.markCc(7, R, 'Bard', 'mezz', 28_000, T);
        two.markCc(8, R, 'Ann', 'mezz', 28_000, T);
        two.publish({ ...obs(report('Bard', { at: T + 3000 }), [mob(), sighting(8, { name: 'ccdummy', x: 1700 })]), ccEnds: [{ name: 'The ccdummy', kind: 'mezz', at: T + 3000 }] }, T + 3000);
        expect(two.picture(T + 3000).contacts.map(x => !!x.cc)).toEqual([true, true]);
    });
});

describe('assignCc', () => {
    const member = (name: string, role: 'support' | 'nuker' | 'healer', ccKinds: ('mezz' | 'root')[]) => report(name, { role, capabilities: { heal: false, cc: true, ccKinds, nuke: false, buffs: [], buffSpells: [] } });
    const bard = member('Bard', 'support', ['mezz']);
    const druid = member('Druid', 'healer', ['root']);
    const now = T;

    test('nobody is sent at a target immune to everything it casts', () => {
        const t = enemy(1, 'midgard', { ccImmune: { mezz: T + 1000 } });
        expect(assignCc([t], [bard], [], now)).toEqual([]);
    });

    test('the root goes where the mezz can\'t, and the mezz where the root can\'t', () => {
        expect(assignCc([enemy(1, 'midgard', { ccImmune: { mezz: T + 1000 } })], [bard, druid], [], now)).toEqual([{ targetId: 1, by: 'Druid' }]);
        expect(assignCc([enemy(1, 'midgard', { ccImmune: { root: T + 1000 } }), enemy(2)], [druid, bard], [], now)).toEqual([{ targetId: 1, by: 'Bard' }, { targetId: 2, by: 'Druid' }]);
    });

    test('an assignment is taken back once its target can\'t take what that member casts', () => {
        expect(assignCc([enemy(1, 'midgard', { ccImmune: { mezz: T + 1000 } })], [bard], [{ targetId: 1, by: 'Bard' }], now)).toEqual([]);
        expect(assignCc([enemy(1)], [bard], [{ targetId: 1, by: 'Bard' }], now)).toEqual([{ targetId: 1, by: 'Bard' }]);
    });

    test('immunity that has run out is none, and a report without ccKinds counts as both', () => {
        expect(assignCc([enemy(1, 'midgard', { ccImmune: { mezz: T - 1 } })], [bard], [], now)).toEqual([{ targetId: 1, by: 'Bard' }]);
        const old = report('Old', { role: 'nuker', capabilities: { heal: false, cc: true, nuke: false, buffs: [], buffSpells: [] } });
        expect(assignCc([contact(1, { ccImmune: { mezz: T + 1000 } })], [old], [], now)).toEqual([{ targetId: 1, by: 'Old' }]);
    });
});

describe('crowd control goes to whoever casts it', () => {
    const shout = { type: 'Mesmerize', target: 'Enemy', range: 700, radius: 0, power: 0, castTime: 0, recastDelay: 30, duration: 18, concentration: 0, pulse: 0, value: 0, damage: 0, spellGroup: 0, effectGroup: 0, frequency: 0 };
    const caps = (names: string[]) => (new MemberAgent({
        bot: 'x', role: 'melee',
        sdk: { getGameMessages: () => [], onStateUpdate: () => () => {}, getState: () => null, getSkills: () => ({ spells: [{ name: 'Crippling Shout', level: 10 }] }), getPlayer: () => null },
        actions: { getSpellInfo: () => shout },
    } as never, new Blackboard(), names.map(name => ({ name, run: () => false })), PVE_SETTINGS) as unknown as { capabilities: Capabilities }).capabilities;
    const member = (name: string, role: 'nuker' | 'melee', ccOn: boolean) => report(name, { role, capabilities: { heal: false, cc: ccOn, ccKinds: ccOn ? ['mezz'] : [], nuke: false, buffs: [], buffSpells: [] } });

    test('a list with no crowdControl says it has none, whatever its spells: a Skald\'s shout', () => {
        expect(caps(['song', 'assistMelee'])).toMatchObject({ cc: false, ccKinds: [] });
        expect(caps(['crowdControl', 'assistMelee'])).toMatchObject({ cc: true, ccKinds: ['mezz'] });
    });

    test('why it matters: an assignment is kept, and keeps a real mezzer who comes free off its target', () => {
        const foes = [enemy(52, 'albion')];
        const held = [{ targetId: 52, by: 'Skald' }];
        expect(assignCc(foes, [member('Skald', 'melee', true), member('Mage', 'nuker', true)], held)).toEqual(held);
        expect(assignCc(foes, [member('Skald', 'melee', false), member('Mage', 'nuker', true)], held)).toEqual([{ targetId: 52, by: 'Mage' }]);
        expect(assignCc(foes, [member('Skald', 'melee', false)], [])).toEqual([]);
    });
});
