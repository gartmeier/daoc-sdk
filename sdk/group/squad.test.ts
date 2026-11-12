import { describe, expect, test } from 'bun:test';
import { enemy, picture, report } from './fixtures';
import { BATTLEGROUND_LAYOUTS, homeOf, THIDRANKI } from './keeps';
import { countFor } from './size';
import { callOdds, decideSquad, edgePatrol, sideStrength, sizeUp, SQUAD_SETTINGS, squadRoaming, type Friend, type SquadSettings } from './squad';
import type { AnswerState, RealmCall } from './director';
import { mergeSettings, type CoordinatorContext } from './strategy';
import type { Capabilities, Contact, GroupPicture, MemberReport, Orders, Point, Role } from './types';
import { isDry } from './water';
import { boards, rng, type RosterMember } from './tactics/compare';
import { friendsIn, squadVariant } from './squad-run';

// Region 9999 has no spawns and no battleground: no aggro zones, keeps or home get in the way.
const R = 9999;
const BASE = { x: 10_000, y: 10_000 };
const LOOP = [{ x: 10_000, y: 10_000, z: 0 }, { x: 13_000, y: 10_000, z: 0 }, { x: 13_000, y: 13_000, z: 0 }];
const caps = (over: Partial<Capabilities> = {}): Capabilities => ({ heal: false, cc: false, nuke: false, buffs: [], buffSpells: [], ...over });

const KINDS: Record<string, { role: Role; className: string; caps: Partial<Capabilities> }> = {
    Merc: { role: 'melee', className: 'Mercenary', caps: {} },
    Arms: { role: 'tank', className: 'Armsman', caps: {} },
    Cleric: { role: 'healer', className: 'Cleric', caps: { heal: true } },
    Wizard: { role: 'nuker', className: 'Wizard', caps: { nuke: true } },
};

/** A squad of the named kinds standing round `at` (100 apart), level 24, full health and power unless `over` says. */
function squad(kinds: string[], over: Partial<Record<string, Partial<MemberReport>>> = {}, at: Point = BASE, regionId = R): MemberReport[] {
    return kinds.map((k, i) => report(k, { role: KINDS[k]!.role, className: KINDS[k]!.className, capabilities: caps(KINDS[k]!.caps), objectId: i + 1, regionId, x: at.x - i * 100, y: at.y, z: 0, level: 24, ...over[k] }));
}

const guess = (role: string) => ({ classGuess: { classes: ['X'], p: [0.8], role: role as any, basis: [] } });
/** An enemy player `dx` east of BASE (level 24, full health unless `over` says). */
const foe = (id: number, dx: number, over: Partial<Contact> = {}, at: Point = BASE, regionId = R) => enemy(id, 'midgard', { regionId, x: at.x + dx, y: at.y, level: 24, hp: 100, ...over });

function ctx(p: GroupPicture, o: { orders?: Partial<Orders>; memory?: Record<string, any>; settings?: Record<string, unknown>; now?: number } = {}): CoordinatorContext<SquadSettings> {
    return {
        picture: p, orders: { ...p.orders, ...o.orders }, memory: o.memory ?? {}, now: o.now ?? p.at, windingDown: false,
        settings: mergeSettings(SQUAD_SETTINGS, { patrol: LOOP, ...o.settings } as any),
    };
}
const decide = (p: GroupPicture, o: Parameters<typeof ctx>[1] & { friends?: Friend[] } = {}) => decideSquad(ctx(p, o), undefined, { friends: () => o.friends ?? [] });

describe('sizeUp: strength by role, health and numbers (Lanchester), never by who', () => {
    test('one against one at full health is even; two against one is four to one; one against two a quarter', () => {
        const us = squad(['Merc']);
        expect(sizeUp(us, [foe(51, 1000)], BASE, SQUAD_SETTINGS).ratio).toBeCloseTo(1, 5);
        expect(sizeUp(squad(['Merc', 'Wizard']), [foe(51, 1000)], BASE, SQUAD_SETTINGS).ratio).toBeCloseTo(4, 5);
        expect(sizeUp(us, [foe(51, 1000), foe(52, 1100)], BASE, SQUAD_SETTINGS).ratio).toBeCloseTo(0.25, 5);
    });

    test('a read mezzer counts more than a fighter, a hurt one less, and one busy with a third realm less again', () => {
        const us = squad(['Merc']);
        const plain = sizeUp(us, [foe(51, 1000)], BASE, SQUAD_SETTINGS).theirs;
        expect(sizeUp(us, [foe(51, 1000, guess('cc'))], BASE, SQUAD_SETTINGS).theirs).toBeGreaterThan(plain);
        expect(sizeUp(us, [foe(51, 1000, { hp: 40 })], BASE, SQUAD_SETTINGS).theirs).toBeCloseTo(plain * 0.4, 5);
        const third = enemy(60, 'hibernia', { regionId: R, x: BASE.x + 1200, y: BASE.y, level: 24 });
        const busy = sizeUp(us, [foe(51, 1000, { targetId: 60 }), third], BASE, SQUAD_SETTINGS);
        expect(busy.foes.map(c => c.objectId)).toEqual([51]);   // one realm at a time: the hibernian is the other fight
    });

    test('a healer backs its side: two with a healer are stronger than two without', () => {
        expect(sideStrength([1, 1], 1)).toBeGreaterThan(sideStrength([1, 1], 0));
        expect(sideStrength([1], 1)).toBe(sideStrength([1], 0));   // alone it only heals itself
        expect(sideStrength([], 0)).toBe(0);
    });

    test('far enemies join the count only when they stand with the near ones', () => {
        const up = sizeUp(squad(['Merc']), [foe(51, 2000), foe(52, 3000), foe(53, 9000)], BASE, SQUAD_SETTINGS);
        expect(up.foes.map(c => c.objectId).sort()).toEqual([51, 52]);
    });
});

describe('decideSquad: picking fights', () => {
    test('a solo takes a lone enemy at even odds, and a lone healer', () => {
        expect(decide(picture(squad(['Merc']), [foe(51, 1500)])).phase).toBe('engage');
        const d = decide(picture(squad(['Merc']), [foe(51, 1500, { ...guess('healer'), healer: true })]));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
    });

    test('a duo outnumbered by three it is not yet fighting keeps clear: steps away, no engage, no hunt', () => {
        const three = [foe(51, 2500), foe(52, 2600), foe(53, 2700, { ...guess('healer') })];
        const memory: Record<string, any> = {};
        const d = decide(picture(squad(['Merc', 'Cleric']), three), { memory });
        expect(d.phase).toBe('travel');
        expect(d.reason).toStartWith('avoid:');
        expect(d.anchor!.x).toBeLessThan(BASE.x);    // away from them (west)
        expect(memory.squad.avoided).toBe(1);
        // Beyond sizeUp they are left alone: the patrol goes on, no hunt.
        const far = [foe(51, 3800), foe(52, 3900), foe(53, 3950)];
        const e = decide(picture(squad(['Merc', 'Cleric']), far), { memory: {} });
        expect(e.phase).toBe('travel');
        expect(e.reason).toContain('patrol');
    });

    test('a trio takes a duo it meets, and a trio of its own size', () => {
        expect(decide(picture(squad(['Merc', 'Cleric', 'Wizard']), [foe(51, 1500), foe(52, 1600)])).phase).toBe('engage');
        expect(decide(picture(squad(['Merc', 'Cleric', 'Wizard']), [foe(51, 1500), foe(52, 1600), foe(53, 1700)])).phase).toBe('engage');
    });

    test('the patrol skips waypoints by a group it keeps clear of', () => {
        const t = 1_000_000;
        const memory: Record<string, any> = { wp: 1, squad: { avoid: { 51: t + 30_000, 52: t + 30_000, 53: t + 30_000 }, flee: null, stand: false, fled: 0, caught: 0, avoided: 1 } };
        const three = [foe(51, 4500, {}, { x: BASE.x, y: BASE.y - 1000 }), foe(52, 4600, {}, { x: BASE.x, y: BASE.y - 1000 }), foe(53, 4700, {}, { x: BASE.x, y: BASE.y - 1000 })];
        const d = decide(picture(squad(['Merc']), three, {}, t), { memory, now: t });
        expect(d.phase).toBe('travel');
        expect(d.reason).toContain('waypoint 1/3');   // (13000, 10000) and (13000, 13000) are within 4500 of them
    });

    test("a hidden stealther opens on what it would not take in the open: a lone mezzer, not two", () => {
        const assassin = () => [report('Mordred', { role: 'melee', className: 'Infiltrator', capabilities: caps(), objectId: 1, regionId: R, x: BASE.x, y: BASE.y, z: 0, level: 24 })];
        const mezzer = [foe(51, 1500, guess('cc'))];
        expect(decide(picture(squad(['Merc']), mezzer)).reason).toStartWith('avoid:');
        expect(decide(picture(assassin(), mezzer)).phase).toBe('engage');
        expect(decide(picture(assassin(), [foe(51, 1500), foe(52, 1600)])).reason).toStartWith('avoid:');
        // In combat it is seen: no opener.
        expect(sizeUp(assassin().map(m => ({ ...m, inCombat: true })), mezzer, BASE, SQUAD_SETTINGS).opening).toBeCloseTo(sizeUp(assassin(), mezzer, BASE, SQUAD_SETTINGS).ratio, 5);
    });

    test('a hidden stealther opens on one it can take before the rest come (OPEN_TAKE, LATE), and focuses it', () => {
        // The freeze on 11-12: the assassins kept clear of "1 vs 2, from stealth" 140 times and opened twice in 4 h.
        const assassin = () => [report('Scathach', { role: 'melee', className: 'Nightshade', capabilities: caps(), objectId: 1, regionId: R, x: BASE.x, y: BASE.y, z: 0, level: 24 })];
        // Two fighters 1500 apart: one is opened on alone, the other comes late.
        const apart = [foe(51, 1500), foe(52, 3000)];
        const d = decide(picture(assassin(), apart));
        expect(d.phase).toBe('engage');
        // A caster with a fighter 1500 off, nearer us: the caster is the one, and the focus goes to it.
        const casterApart = [foe(51, 1500), foe(52, 3000, guess('caster'))];
        const up = sizeUp(assassin(), casterApart, BASE, SQUAD_SETTINGS);
        expect(up.openOn).toBe(52);
        expect(up.opening).toBeGreaterThan(SQUAD_SETTINGS.squad.engageAt);
        const e = decide(picture(assassin(), casterApart));
        expect(e.phase).toBe('engage');
        expect(e.focus).toBe(52);
        // A player and its pet: the player opened on, the pet no match.
        expect(sizeUp(assassin(), [foe(51, 1500), foe(52, 1600, { isPet: true })], BASE, SQUAD_SETTINGS).opening).toBeGreaterThan(SQUAD_SETTINGS.squad.engageAt);
        // Two side by side, or three apart: still no.
        expect(decide(picture(assassin(), [foe(51, 1500), foe(52, 1600, guess('caster'))])).reason).toStartWith('avoid:');
        expect(decide(picture(assassin(), [foe(51, 1500), foe(52, 3000), foe(53, 3100)])).reason).toStartWith('avoid:');
        // Seen (in combat), none of it: the odds of a fighter in the open.
        const seen = sizeUp(assassin().map(m => ({ ...m, inCombat: true })), apart, BASE, SQUAD_SETTINGS);
        expect(seen.openOn).toBeNull();
        expect(seen.opening).toBeCloseTo(seen.ratio, 5);
        // Not on a target out of view.
        expect(sizeUp(assassin(), [foe(51, 1500, { stale: true, lastSeen: 0 })], BASE, SQUAD_SETTINGS).openOn).toBeNull();
    });

    test('a hidden squad that leaves a fight walks away hidden, never a retreat (which would show it)', () => {
        const t0 = 1_000_000;
        const assassin = () => [report('Hodur', { role: 'melee', className: 'Shadowblade', capabilities: caps(), objectId: 1, regionId: R, x: BASE.x, y: BASE.y, z: 0, level: 24 })];
        const memory: Record<string, any> = {};
        expect(decide(picture(assassin(), [foe(51, 1200, guess('caster'))], {}, t0), { memory, now: t0 }).phase).toBe('engage');
        // Engaged, still hidden, and a group of five closes in.
        const five = [51, 52, 53, 54, 55].map((id, i) => foe(id, 900 + 50 * i, i ? {} : guess('caster')));
        const d = decide(picture(assassin(), five, { phase: 'engage', focus: 51 }, t0 + 3000), { memory, now: t0 + 3000 });
        expect(d.phase).not.toBe('retreat');
    });

    test('after a jump (a release home) the old leg is dropped and the patrol starts at the nearest waypoint', () => {
        // 11-12: Diarmuid and Scathach walked ~30000 straight to their pre-death leg after each release, over the Faste's island.
        const at = { x: 13_000, y: 11_000 };
        const memory: Record<string, any> = { wp: 2, legKind: 'patrol', leg: { x: 33_000, y: 30_000, z: 0 }, legAt: 0, goal: LOOP[2], route: [{ x: 33_000, y: 30_000 }] };
        const d = decide(picture(squad(['Merc'], {}, at), []), { memory });
        expect(d.phase).toBe('travel');
        expect(d.reason).toContain('waypoint 2/3');
        expect(Math.hypot(memory.leg.x - at.x, memory.leg.y - at.y)).toBeLessThan(3000);
    });

    test('a hurt solo does not start a fight it would start at full health', () => {
        expect(decide(picture(squad(['Merc'], { Merc: { hp: 60 } }), [foe(51, 1500)])).reason).toStartWith('avoid:');
    });
});

describe('decideSquad: what run B showed (2026-11-11 23:10-23:27)', () => {
    test('a stray at the edge of a group strung out along a road is no lone enemy: no engage, no hunt', () => {
        // 23:11: Camelot's duo engaged a Kobold "1 vs 1" and fled 13 s later from six.
        const road = [foe(51, 1500), ...[2700, 3900, 5100, 5200, 5300].map((dx, i) => foe(52 + i, dx))];
        const d = decide(picture(squad(['Merc', 'Cleric']), road));
        expect(d.phase).toBe('retreat');   // 1500 off and far stronger: run (runAt)
        expect(d.reason).toContain('2 vs 6');
    });

    test('a lone caster of one realm is hunted while another realm\'s group is far off; once near, keep clear until well beyond', () => {
        const caster = enemy(70, 'hibernia', { regionId: R, x: BASE.x, y: BASE.y + 3000, level: 24, hp: 100, ...guess('caster') });
        const group = (dx: number) => [foe(51, dx), foe(52, dx + 100), foe(53, dx + 200), foe(54, dx + 300)];
        const memory: Record<string, any> = {};
        const t = 1_000_000;
        let d = decide(picture(squad(['Merc', 'Cleric']), [caster, ...group(-6000)], {}, t), { memory, now: t });
        expect(d.reason).toContain('hunt 1 enemy');
        d = decide(picture(squad(['Merc', 'Cleric']), [caster, ...group(-3300)], {}, t + 1000), { memory, now: t + 1000 });
        expect(d.reason).toStartWith('avoid:');
        // 3800 off: inside the slack, still stepping away (no flip back to the hunt) ...
        d = decide(picture(squad(['Merc', 'Cleric']), [caster, ...group(-3800)], {}, t + 2000), { memory, now: t + 2000 });
        expect(d.reason).toStartWith('avoid:');
        // ... and beyond it the hunt goes on.
        d = decide(picture(squad(['Merc', 'Cleric']), [caster, ...group(-4700)], {}, t + 3000), { memory, now: t + 3000 });
        expect(d.reason).toContain('hunt 1 enemy');
    });

    test('a group we would not take that closes within runAt runs us off at once (a retreat, which sprints)', () => {
        // 08:32: a group of five walked Camelot's duo down from 3300 to 900 while it stepped away at a walk.
        const five = (dx: number) => [0, 100, 200, 300, 400].map((d, i) => foe(51 + i, dx + d));
        const memory: Record<string, any> = {};
        expect(decide(picture(squad(['Merc', 'Cleric']), five(3000)), { memory }).reason).toStartWith('avoid:');
        const d = decide(picture(squad(['Merc', 'Cleric']), five(1900)), { memory });
        expect(d.phase).toBe('retreat');
        expect(d.reason).toStartWith('flee: 5 closing');
        expect(d.retreatTo!.x).toBeLessThan(BASE.x);
        expect(memory.squad.fled).toBe(1);
        // One enemy closing on a hurt solo is not run from: it steps away, and fights if attacked.
        const e = decide(picture(squad(['Merc'], { Merc: { hp: 50 } }), [foe(51, 1500)]), { memory: {} });
        expect(e.phase).toBe('travel');
        expect(e.reason).toStartWith('avoid:');
    });

    test('where it last saw a group it kept clear of, the patrol does not go back on the same line: it skips and goes round', () => {
        // The user, run B 08:40: Hibernia's duo stepped clear of Albion's group, then patrolled straight back into it, again and again.
        const memory: Record<string, any> = {};
        const t = 1_000_000;
        const LINE = [{ x: 10_000, y: 10_000, z: 0 }, { x: 22_000, y: 10_000, z: 0 }, { x: 22_000, y: 20_000, z: 0 }];
        const five = [0, 100, 200, 300, 400].map((d, i) => foe(51 + i, 3200 + d));
        // Seen at 3200 east: stepping away, and their spot is remembered.
        let d = decide(picture(squad(['Merc', 'Cleric']), five, {}, t), { memory, now: t, settings: { patrol: LINE } });
        expect(d.reason).toStartWith('avoid:');
        expect(memory.squad.zones).toHaveLength(1);
        // Out of sight a minute later, the patrol to (22000, 10000) would pass their spot: it goes round it.
        memory.wp = 1;
        d = decide(picture(squad(['Merc', 'Cleric']), [], {}, t + 60_000), { memory, now: t + 60_000, settings: { patrol: LINE } });
        expect(d.phase).toBe('travel');
        expect(d.reason).toContain('round a group last seen at');
        expect(Math.abs(d.anchor!.y - BASE.y)).toBeGreaterThan(300);
        // With another lane clear of their spot, that lane is taken instead of going round.
        const OTHER = [{ x: 10_000, y: 10_000, z: 0 }, { x: 22_000, y: 10_000, z: 0 }, { x: 5_000, y: 20_000, z: 0 }];
        memory.wp = 1;
        d = decide(picture(squad(['Merc', 'Cleric']), [], {}, t + 60_500), { memory, now: t + 60_500, settings: { patrol: OTHER } });
        expect(d.reason).toContain('waypoint 3/3');
        expect(d.reason).not.toContain('round a group');
        // A waypoint inside their spot is skipped.
        const NEAR = [{ x: 10_000, y: 10_000, z: 0 }, { x: 13_500, y: 10_000, z: 0 }, { x: 10_000, y: 16_000, z: 0 }];
        memory.wp = 1;
        d = decide(picture(squad(['Merc', 'Cleric']), [], {}, t + 61_000), { memory, now: t + 61_000, settings: { patrol: NEAR } });
        expect(d.reason).toContain('waypoint 3/3');
        // Four minutes on, forgotten.
        decide(picture(squad(['Merc', 'Cleric']), [], {}, t + 300_000), { memory, now: t + 300_000, settings: { patrol: LINE } });
        expect(memory.squad.zones).toHaveLength(0);
    });

    test('a tank chasing to its leash is still with its healer: an even duo fight goes on', () => {
        // Run B 09:17: both duos read "1 vs 2" with their tank 2500 out after its focus, and both fled an even fight.
        const us = squad(['Merc', 'Cleric'], { Merc: { x: BASE.x + 2500 }, Cleric: { x: BASE.x } });
        const two = [foe(51, 2700, { target: 'Merc', threat: true }), foe(52, 2900, { target: 'Merc', threat: true })];
        const d = decide(picture(us, two, { phase: 'engage', focus: 51 }));
        expect(d.phase).toBe('engage');
    });

    test('a member walking back from a release is not on our side: a lone healer does not take a fighter', () => {
        // 23:25: Tuck alone took a Celt at "2 vs 1" with Galahad 9000 off, and died.
        const us = squad(['Cleric', 'Merc'], { Merc: { x: BASE.x - 9000 } });
        const d = decide(picture(us, [foe(51, 1500)]));
        expect(d.phase).not.toBe('engage');
        expect(d.reason).not.toContain('hunt');
    });

    test('those that killed one of ours count more next time: the same even duo is not taken again', () => {
        const duo = (dx: number) => [foe(51, dx), foe(52, dx + 100)];
        const memory: Record<string, any> = {};
        const t = 1_000_000;
        expect(decide(picture(squad(['Merc', 'Wizard']), duo(1500), {}, t), { memory, now: t }).phase).toBe('engage');
        // Merc dies with them beside him; Wizard runs; later Merc is back and they meet the same two.
        decide(picture(squad(['Merc', 'Wizard'], { Merc: { isDead: true, hp: 0 } }), duo(300), { phase: 'engage', focus: 51 }, t + 20_000), { memory, now: t + 20_000 });
        decide(picture(squad(['Merc', 'Wizard'], { Merc: { isDead: true, hp: 0 } }), [], { phase: 'retreat' }, t + 30_000), { memory, now: t + 30_000 });
        const d = decide(picture(squad(['Merc', 'Wizard']), duo(1500), {}, t + 300_000), { memory, now: t + 300_000 });
        expect(d.reason).toStartWith('avoid:');
        // Ten minutes on, forgiven.
        expect(decide(picture(squad(['Merc', 'Wizard']), duo(1500), {}, t + 700_000), { memory, now: t + 700_000 }).phase).toBe('engage');
    });
});

describe('decideSquad: leaving a fight that turned', () => {
    test('a solo attacked by two runs (retreat), straight away from them with no home here', () => {
        const two = [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 1200, { ...guess('caster'), caster: true })];
        const memory: Record<string, any> = {};
        const d = decide(picture(squad(['Merc']), two, { phase: 'engage', focus: 51 }), { memory });
        expect(d.phase).toBe('retreat');
        expect(d.reason).toStartWith('flee:');
        expect(d.retreatTo!.x).toBeLessThan(BASE.x - 1000);
        expect(memory.squad.fled).toBe(1);
    });

    test('runs toward friends when they are near and not behind the enemy', () => {
        const two = [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 800)];
        const friends = [{ x: BASE.x, y: BASE.y + 5000 }, { x: BASE.x + 200, y: BASE.y + 5100 }];
        const d = decide(picture(squad(['Merc']), two, { phase: 'engage', focus: 51 }), { friends });
        expect(d.phase).toBe('retreat');
        expect(d.objective).toContain('toward friends');
        expect(d.retreatTo!.y).toBeGreaterThan(BASE.y + 1000);
        // One friend alone is no group to run to.
        expect(decide(picture(squad(['Merc']), two, { phase: 'engage', focus: 51 }), { friends: [{ x: BASE.x, y: BASE.y + 5000 }] }).objective).not.toContain('toward friends');
        // Friends behind the enemy (east): not that way.
        const e = decide(picture(squad(['Merc']), two, { phase: 'engage', focus: 51 }), { friends: [{ x: BASE.x + 5000, y: BASE.y }, { x: BASE.x + 5100, y: BASE.y }] });
        expect(e.objective).not.toContain('toward friends');
        expect(e.retreatTo!.x).toBeLessThan(BASE.x);
    });

    test("a friendly group's fight is ours: a solo joins it rather than walking away, and stays in it", () => {
        // Run B 09:53 (N5): Diarmuid, solo, read "1 vs 3" to "1 vs 5" and patrolled away from Hibernia's group fighting those five.
        const five = [0, 150, 300, 450, 600].map((d, i) => foe(51 + i, 3400 + d));
        const ours = [3100, 3200, 3300, 3400, 3500].map((dx, i) => ({ x: BASE.x + dx, y: BASE.y + 600 + 50 * i, hp: 90, level: 24, className: i === 0 ? 'Druid' : 'Hero' }));
        const alone = decide(picture(squad(['Merc']), five), { friends: [] });
        expect(alone.reason).toStartWith('avoid:');
        const up = sizeUp(squad(['Merc']), five, BASE, SQUAD_SETTINGS, new Set(), ours);
        expect(up.allies).toBe(5);
        expect(up.ratio).toBeGreaterThan(SQUAD_SETTINGS.squad.engageAt);
        const join = decide(picture(squad(['Merc']), five), { friends: ours });
        expect(join.reason ?? '').not.toContain('avoid');
        expect(join.reason ?? '').not.toContain('clear of');
        expect(join.phase).not.toBe('retreat');
        // In it (walked up to 3000 east), it stays: no leaving a fight our side is winning.
        const there = { x: BASE.x + 3000, y: BASE.y };
        const fight = decide(picture(squad(['Merc'], { Merc: { inCombat: true } }, there), five.map((c, i) => (i ? c : { ...c, target: 'Merc', threat: true })), { phase: 'engage', focus: 51 }), { friends: ours });
        expect(fight.phase).toBe('engage');
        expect(fight.reason).toContain('beside 5 friends');
        // The first tick of it, nobody on us yet and no fight begun: engaged beside them (run A on 11-12, camelot-s3 17:58:
        // the coordinator threw on sq.fight.start 38 times).
        const first = decide(picture(squad(['Merc'], {}, there), five), { friends: ours });
        expect(first.phase).toBe('engage');
        expect(first.reason).toContain('beside 5 friends');
        // Friends far from those enemies are in no fight of theirs: still avoided.
        const far = ours.map(f => ({ ...f, y: f.y + 6000 }));
        expect(decide(picture(squad(['Merc']), five), { friends: far }).reason).toStartWith('avoid:');
        // Hurt friends count for less: five at 10 % don't turn it.
        const hurt = ours.map(f => ({ ...f, hp: 10 }));
        expect(sizeUp(squad(['Merc']), five, BASE, SQUAD_SETTINGS, new Set(), hurt).ratio).toBeLessThan(SQUAD_SETTINGS.squad.engageAt);
    });

    test('a fight we chose against players is fought out: adds seen later do not end it, our losses do', () => {
        // The user, 14:43 on 11-12: Aine and Fionn engaged two Albions, fled 13 s later at 0.50 when a third came near.
        // N1, the human-vision hour on 11-12: a trio took "3 vs 1", five more came into view, it fled at "0.26 (3 vs 6)".
        const t0 = 1_000_000;
        const us = (over: Parameters<typeof squad>[1] = {}) => squad(['Merc', 'Cleric'], { Merc: { inCombat: true }, ...over });
        const two = [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 500)];
        const three = [...two, foe(53, 700)];
        const four = [...three, foe(54, 800)];
        const five = [...four, foe(55, 900)];
        const run = (memory: Record<string, any>, steps: [number, Contact[], Parameters<typeof squad>[1]?][]) =>
            steps.map(([t, cs, over]) => decide(picture(us(over), cs, { phase: 'engage', focus: 51 }, t0 + t), { memory, now: t0 + t }));
        const memory: Record<string, any> = {};
        let [d] = run(memory, [[0, two]]);
        expect(d!.phase).toBe('engage');
        expect(memory.squad.fight.chosen).toBe(true);
        // A third at 13 s, a fourth at 21 s and 40 s: still in it.
        const ds = run(memory, [[5000, two], [10_000, two], [13_000, three], [21_000, four], [30_000, four], [40_000, four]]);
        for (const x of ds) expect(x.phase).toBe('engage');
        expect(ds.at(-1)!.reason).toContain('committed 40 s, no losses');
        // Our mean health 45 points down: lost, and by the odds gone.
        [d] = run(memory, [[42_000, four, { Merc: { inCombat: true, hp: 30 }, Cleric: { hp: 80 } }]]);
        expect(d!.phase).toBe('retreat');
        expect(d!.reason).toContain('health 100 to 55 %');
        // A member dead: lost too.
        const m2: Record<string, any> = {};
        run(m2, [[0, two]]);
        expect(run(m2, [[5000, four]])[0]!.phase).toBe('engage');
        [d] = run(m2, [[8000, four, { Cleric: { isDead: true, hp: 0 } }]]);
        expect(d!.phase).toBe('retreat');
        expect(d!.reason).toContain('Cleric died');
        // A fight we did not choose (caught at 0.50 from the start) is not held.
        const m3: Record<string, any> = {};
        expect(run(m3, [[0, three]])[0]!.phase).toBe('retreat');
    });

    test('a fight we chose is left at once, at full health, when a whole group comes into view (OVERRUN)', () => {
        // The commit hour on 11-12: Aine and Fionn took "2 vs 2", fled at "2 vs 7" with health 100 to 50 %, both dead in 13 s.
        const t0 = 1_000_000;
        const duo = () => squad(['Merc', 'Cleric'], { Merc: { inCombat: true } });
        const two = [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 500)];
        const five = [...two, foe(53, 700), foe(54, 800), foe(55, 900)];
        const memory: Record<string, any> = {};
        expect(decide(picture(duo(), two, { phase: 'engage', focus: 51 }, t0), { memory, now: t0 }).phase).toBe('engage');
        const d = decide(picture(duo(), five, { phase: 'engage', focus: 51 }, t0 + 8000), { memory, now: t0 + 8000 });
        expect(d.phase).toBe('retreat');
        expect(d.reason).toContain('5 in view');
        // Out of view they are no group we noticed: fought on.
        const m2: Record<string, any> = {};
        decide(picture(duo(), two, { phase: 'engage', focus: 51 }, t0), { memory: m2, now: t0 });
        const late = [...two, ...five.slice(2).map(c => ({ ...c, stale: true, lastSeen: t0 + 7000 }))];
        expect(decide(picture(duo(), late, { phase: 'engage', focus: 51 }, t0 + 8000), { memory: m2, now: t0 + 8000 }).phase).toBe('engage');
        // A trio that took one fights on against six (the user's case, N1 on 11-12): 6 is under 2 x 3 + 1.
        const trio = () => squad(['Merc', 'Cleric', 'Wizard'], { Merc: { inCombat: true } });
        const m3: Record<string, any> = {};
        const one = [foe(51, 300, { target: 'Merc', threat: true })];
        decide(picture(trio(), one, { phase: 'engage', focus: 51 }, t0), { memory: m3, now: t0 });
        const six = [...one, ...[52, 53, 54, 55, 56].map((id, i) => foe(id, 500 + 100 * i))];
        expect(decide(picture(trio(), six, { phase: 'engage', focus: 51 }, t0 + 8000), { memory: m3, now: t0 + 8000 }).phase).toBe('engage');
    });

    test('a fight we chose against a pet alone is held 20 s, and left at once far past the line', () => {
        const t0 = 1_000_000;
        const us = () => squad(['Merc'], { Merc: { inCombat: true } });
        const pet = (id: number, dx: number, over: Partial<Contact> = {}) => foe(id, dx, { isPet: true, threat: true, ...over });
        const memory: Record<string, any> = {};
        expect(decide(picture(us(), [pet(51, 300, { target: 'Merc' })], { phase: 'engage', focus: 51 }, t0), { memory, now: t0 }).phase).toBe('engage');
        expect(memory.squad.fight.players).toBe(false);
        // Many pets later: far past the line, gone.
        const pets = [51, 52, 53, 54, 55, 56, 57, 58].map((id, i) => pet(id, 300 + 50 * i, i ? {} : { target: 'Merc' }));
        expect(decide(picture(us(), pets, { phase: 'engage', focus: 51 }, t0 + 5000), { memory, now: t0 + 5000 }).phase).toBe('retreat');
    });

    test('human vision: pursuers out of view still count in a flee, until forgotten (REMEMBER_MS)', () => {
        // N1, hibernia-s1 15:55 on 11-12: fleeing, those behind left the cone, "4 following, odds 0.61", it turned back, saw them, fled.
        const t0 = 1_000_000;
        const us = () => squad(['Merc', 'Cleric']);
        const memory: Record<string, any> = {};
        const four = [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 400), foe(53, 500), foe(54, 600)];
        decide(picture(us(), four, { phase: 'engage', focus: 51 }, t0), { memory, now: t0 });
        expect(memory.squad.flee).toBeTruthy();
        const o = { phase: 'retreat' as const };
        // 12 s on: one in view at 600, three behind out of view since 8 s, last seen 3700-3900 back.
        const behind = (seen: number) => [52, 53, 54].map((id, i) => foe(id, 3700 + 100 * i, { stale: true, lastSeen: t0 + seen }));
        const one = foe(51, 600, { target: 'Merc', threat: true });
        let d = decide(picture(us(), [one, ...behind(8000)], o, t0 + 12_000), { memory, now: t0 + 12_000 });
        expect(d.phase).toBe('retreat');
        expect(d.reason).toContain('4 we ran from');
        // Without them on the board (as omniscient sight had it when they left range): it turns on the one.
        const m2: Record<string, any> = {};
        decide(picture(us(), four, { phase: 'engage', focus: 51 }, t0), { memory: m2, now: t0 });
        expect(decide(picture(us(), [one], o, t0 + 12_000), { memory: m2, now: t0 + 12_000 }).phase).toBe('engage');
        // Last seen 31 s ago: forgotten, and it turns on the one still following.
        d = decide(picture(us(), [one, ...behind(8000)], o, t0 + 39_500), { memory, now: t0 + 39_500 });
        expect(d.phase).toBe('engage');
    });

    test('human vision: a lone enemy in view with its group out of view is no lone enemy', () => {
        const t0 = 1_000_000;
        const trio = () => squad(['Merc', 'Cleric', 'Wizard']);
        const one = foe(51, 1500);
        // Five of its realm seen 10 s ago 1000 beyond it.
        const rest = [52, 53, 54, 55, 56].map((id, i) => foe(id, 2500 + 100 * i, { stale: true, lastSeen: t0 - 10_000 }));
        expect(decide(picture(trio(), [one], {}, t0), { now: t0 }).phase).toBe('engage');
        const d = decide(picture(trio(), [one, ...rest], {}, t0), { now: t0 });
        expect(d.phase).not.toBe('engage');
        expect(d.reason).toContain('5 out of view');
        // Seen 40 s ago: forgotten, the one is taken.
        const old = rest.map(c => ({ ...c, lastSeen: t0 - 40_000 }));
        expect(decide(picture(trio(), [one, ...old], {}, t0), { now: t0 }).phase).toBe('engage');
        // Out of view is no one closing: no run (sprint) from last known places within runAt.
        const close = [52, 53, 54, 55, 56].map((id, i) => foe(id, 1000 + 100 * i, { stale: true, lastSeen: t0 - 10_000 }));
        expect(decide(picture(trio(), close, {}, t0), { now: t0 }).phase).not.toBe('retreat');
    });

    test('after a flee, its group is not engaged again while remembered: one of them, or one of their realm where they were', () => {
        const t0 = 1_000_000;
        const us = () => squad(['Merc', 'Cleric']);
        const memory: Record<string, any> = {};
        decide(picture(us(), [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 400), foe(53, 500), foe(54, 600)], { phase: 'engage', focus: 51 }, t0), { memory, now: t0 });
        const o = { phase: 'retreat' as const };
        decide(picture(us(), [], o, t0 + 3000), { memory, now: t0 + 3000 });
        decide(picture(us(), [], o, t0 + 10_000), { memory, now: t0 + 10_000 });
        expect(memory.squad.flee).toBeNull();
        // One never seen, of their realm, where they were: left alone.
        let d = decide(picture(us(), [foe(61, 900)], {}, t0 + 15_000), { memory, now: t0 + 15_000 });
        expect(d.phase).not.toBe('engage');
        // One we ran from with a new one beside it: both left alone.
        d = decide(picture(us(), [foe(52, 900), foe(62, 1000)], {}, t0 + 16_000), { memory, now: t0 + 16_000 });
        expect(d.phase).not.toBe('engage');
        expect(memory.squad.avoid[62]).toBeGreaterThan(t0 + 16_000);
        // Another realm there is no part of it.
        d = decide(picture(us(), [enemy(70, 'hibernia', { regionId: R, x: BASE.x + 900, y: BASE.y, level: 24, hp: 100 })], {}, t0 + 17_000), { memory, now: t0 + 17_000 });
        expect(d.phase).toBe('engage');
        // Once the flee's avoidMs has passed: taken again.
        d = decide(picture(us(), [foe(63, 900)], {}, t0 + 75_000), { memory, now: t0 + 75_000 });
        expect(d.phase).toBe('engage');
    });

    test('after a flee, all it ran from are left alone: the two that come back into view are not hunted', () => {
        const memory: Record<string, any> = {};
        const t0 = 1_000_000;
        const us = () => squad(['Merc', 'Cleric']);
        const o = { phase: 'retreat' as const };
        decide(picture(us(), [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 400), foe(53, 500), foe(54, 600)], { phase: 'engage', focus: 51 }, t0), { memory, now: t0 });
        expect(memory.squad.flee).toBeTruthy();
        // Shaken off, then the two that were in front of it come back into view 3000 off, alone.
        decide(picture(us(), [], o, t0 + 3000), { memory, now: t0 + 3000 });
        let d = decide(picture(us(), [], o, t0 + 10_000), { memory, now: t0 + 10_000 });
        expect(memory.squad.flee).toBeNull();
        d = decide(picture(us(), [foe(51, 3000), foe(52, 3100)], d as any, t0 + 11_000), { memory, now: t0 + 11_000 });
        expect(d.reason ?? '').not.toContain('hunt');
        expect(d.phase).not.toBe('engage');
    });

    test('friends passing by out of combat are not counted; friends counted in our fight stay counted for a while', () => {
        const five = [0, 150, 300, 450, 600].map((d, i) => foe(51 + i, 3400 + d));
        const passing = [3100, 3200, 3300, 3400, 3500].map((dx, i) => ({ name: `F${i}`, x: BASE.x + dx, y: BASE.y + 600, inCombat: false }));
        expect(sizeUp(squad(['Merc']), five, BASE, SQUAD_SETTINGS, new Set(), passing).allies).toBe(0);
        const fighting = passing.map(f => ({ ...f, inCombat: true }));
        const up = sizeUp(squad(['Merc']), five, BASE, SQUAD_SETTINGS, new Set(), fighting);
        expect(up.allyNames).toEqual(['F0', 'F1', 'F2', 'F3', 'F4']);
        // Out of combat a moment and 1000 further off: still counted while kept.
        const after = fighting.map(f => ({ ...f, inCombat: false, y: f.y + 1000 }));
        expect(sizeUp(squad(['Merc']), five, BASE, SQUAD_SETTINGS, new Set(), after, new Set(up.allyNames)).allies).toBe(5);
        expect(sizeUp(squad(['Merc']), five, BASE, SQUAD_SETTINGS, new Set(), after).allies).toBe(0);
    });

    test('two solos in one fight: each counts the other, takes its target, and does not leave it at 2 vs 3', () => {
        // The user, 15:47 on 11-12: Scathach and Diarmuid fought the same three Albions 1000 apart, each "1 vs 3", and both died.
        const three = [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 500), foe(53, 600)];
        const other = { name: 'Scathach', x: BASE.x + 700, y: BASE.y + 300, hp: 90, level: 24, className: 'Nightshade', inCombat: true, targetId: 52 };
        const us = () => squad(['Merc'], { Merc: { inCombat: true } });
        // Alone: gone (1 vs 3).
        expect(decide(picture(us(), three, { phase: 'engage', focus: 51 }), { friends: [] }).phase).toBe('retreat');
        // With the other solo in it: 1+1 vs 3, stays, and on its target.
        const d = decide(picture(us(), three, { phase: 'engage', focus: 51 }), { friends: [other] });
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(52);
        expect(d.reason).toContain("on Scathach's target");
        expect(d.reason).toContain('1+1 vs 3');
        // Hopeless even with it (five): gone.
        const five = [...three, foe(54, 650), foe(55, 700)];
        expect(decide(picture(us(), five, { phase: 'engage', focus: 51 }), { friends: [other] }).phase).toBe('retreat');
        // One passing by out of combat is in no fight.
        expect(decide(picture(us(), three, { phase: 'engage', focus: 51 }), { friends: [{ ...other, inCombat: false }] }).phase).toBe('retreat');
    });

    test("a stealther's opener: a lone melee on a hurt solo is fought out, unless friends are near to run to", () => {
        const opener = [foe(51, 100, { ...guess('melee'), target: 'Wizard', threat: true })];
        const us = () => squad(['Wizard'], { Wizard: { hp: 45, inCombat: true } });
        const d = decide(picture(us(), opener, { phase: 'engage', focus: 51 }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        const e = decide(picture(us(), opener, { phase: 'engage', focus: 51 }), { friends: [{ x: BASE.x - 3000, y: BASE.y }, { x: BASE.x - 3100, y: BASE.y + 100 }] });
        expect(e.phase).toBe('retreat');
        // An archer or caster on us shoots at our back: fought out too (run B 08:49: Tristram ran from a Hunter and died), its pet with it.
        const f = decide(picture(us(), [foe(51, 1200, { ...guess('caster'), target: 'Wizard', threat: true }), foe(52, 300, { isPet: true, threat: true, target: 'Wizard' })], { phase: 'engage', focus: 51 }));
        expect(f.phase).toBe('engage');
        // ... also with no target read for it (an archer's arrows name none).
        const g = decide(picture(us(), [foe(51, 1200, { ...guess('caster'), threat: true })], { phase: 'engage', focus: 51 }));
        expect(g.phase).toBe('engage');
    });

    test('a focus nearly dead is finished first', () => {
        const two = [foe(51, 200, { target: 'Merc', threat: true, hp: 15 }), foe(52, 400, { target: 'Merc', threat: true })];
        const d = decide(picture(squad(['Merc'], { Merc: { hp: 70 } }), two, { phase: 'engage', focus: 51 }));
        expect(d.phase).toBe('engage');
    });

    test('the run goes on while they follow, ends once shaken off (they are left alone then), or turns into a fight when caught', () => {
        const memory: Record<string, any> = {};
        const t0 = 1_000_000;
        const chasers = (dx: number) => [foe(51, dx, { target: 'Merc', threat: true }), foe(52, dx + 100)];
        let d = decide(picture(squad(['Merc']), chasers(300), { phase: 'engage', focus: 51 }, t0), { memory, now: t0 });
        expect(d.phase).toBe('retreat');
        const o = { phase: 'retreat' as const, retreatTo: d.retreatTo, anchor: d.anchor };
        d = decide(picture(squad(['Merc']), chasers(300), o, t0 + 5000), { memory, now: t0 + 5000 });
        expect(d.phase).toBe('retreat');
        // Out of sight beyond engageRadius: on at a walk (no sprint); for shakenMs: done, and those two are not hunted.
        d = decide(picture(squad(['Merc']), chasers(3800), o, t0 + 8000), { memory, now: t0 + 8000 });
        expect(d.phase).toBe('travel');
        expect(d.reason).toStartWith('flee:');
        expect(d.reason).toContain('walking');
        d = decide(picture(squad(['Merc']), chasers(3800), o, t0 + 12_000), { memory, now: t0 + 12_000 });
        expect(d.phase).toBe('travel');
        expect(d.reason).toContain('patrol');
        expect(memory.squad.avoid[51]).toBeGreaterThan(t0 + 12_000);

        // Only one still following, and we can take it: turn on it.
        const m3: Record<string, any> = {};
        decide(picture(squad(['Merc', 'Cleric']), [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 400), foe(53, 500)], { phase: 'engage', focus: 51 }, t0), { memory: m3, now: t0 });
        expect(m3.squad.flee).toBeTruthy();
        d = decide(picture(squad(['Merc', 'Cleric']), [foe(51, 600, { target: 'Merc', threat: true })], o, t0 + 8000), { memory: m3, now: t0 + 8000 });
        expect(d.phase).toBe('engage');
        expect(m3.squad.flee).toBeNull();

        // Caught: still followed after fleeMaxMs, fight it out.
        const m2: Record<string, any> = {};
        decide(picture(squad(['Merc']), chasers(300), { phase: 'engage', focus: 51 }, t0), { memory: m2, now: t0 });
        d = decide(picture(squad(['Merc']), chasers(300), o, t0 + 46_000), { memory: m2, now: t0 + 46_000 });
        expect(d.phase).toBe('engage');
        expect(d.reason).toStartWith('caught:');
        expect(m2.squad.caught).toBe(1);
    });

    test('the inner decide never retreats by itself: a margin of 1 or 99 gives the same orders', () => {
        const boards = [[foe(51, 1500)], [foe(51, 300, { target: 'Merc', threat: true }), foe(52, 800)], [foe(51, 2500), foe(52, 2600), foe(53, 2700)]];
        for (const foes of boards) {
            const a = decide(picture(squad(['Merc', 'Cleric']), foes, {}, 5), { settings: { retreat: { margin: 1 } }, now: 5 });
            const b = decide(picture(squad(['Merc', 'Cleric']), foes, {}, 5), { settings: { retreat: { margin: 99 } }, now: 5 });
            expect(a).toEqual(b);
        }
        // What the shares give below five (size.ts): not used by a squad, whose retreat is its own.
        expect([1, 2, 3].map(n => countFor({ share: 0.6 }, n))).toEqual([1, 1, 2]);
    });
});

describe('decideSquad: help calls (director.ts)', () => {
    const call = (over: Partial<RealmCall> = {}): RealmCall => ({
        id: 'albion-1', kind: 'help', from: 'camelot', why: 'outnumbered', at: { x: BASE.x + 4000, y: BASE.y, z: 0 },
        foes: 3, ours: 2, foeRoles: {}, want: 2, asked: ['me'], coming: [], since: 0, updatedAt: 0, ...over,
    });
    type Said = [string, AnswerState, string];
    const run = (p: GroupPicture, calls: RealmCall[], said: Said[], o: Parameters<typeof ctx>[1] = {}) =>
        decideSquad(ctx(p, o), undefined, { friends: () => [], unit: 'me', calls: () => calls, answer: (id, st, why) => said.push([id, st, why]) });

    test('callOdds: us and the realm\'s own there against the foes by role', () => {
        expect(callOdds(squad(['Merc']), { foes: 1, ours: 0, foeRoles: {} })).toBeCloseTo(1, 5);
        // A duo with a healer and two friends there against three: about 1.9.
        expect(callOdds(squad(['Merc', 'Cleric']), call())).toBeGreaterThan(1.5);
        // A solo and one friend against six: hopeless.
        expect(callOdds(squad(['Merc']), call({ foes: 6, ours: 1 }))).toBeLessThan(0.2);
    });

    test('asked, free and the odds there good: it goes, and says so', () => {
        const said: Said[] = [];
        const memory: Record<string, any> = {};
        const d = run(picture(squad(['Merc', 'Cleric']), []), [call()], said, { memory });
        expect(d.phase).toBe('travel');
        expect(d.reason).toStartWith("call: to camelot's fight (outnumbered, 2 vs 3), 4050 away");
        expect(said.map(x => x[1])).toEqual(['coming']);
        expect(memory.squad.answered).toBe(1);
        // The next tick: still on its way, no second answer.
        expect(run(picture(squad(['Merc', 'Cleric']), []), [call()], said, { memory }).reason).toStartWith('call:');
        expect(said.length).toBe(1);
    });

    test('asked, and the odds there stay bad even with us, or we are hurt, or it is far: declined, and it patrols on', () => {
        const said: Said[] = [];
        expect(run(picture(squad(['Merc']), []), [call({ foes: 6, ours: 1 })], said).reason).toContain('patrol');
        expect(said[0]![1]).toBe('declined');
        expect(said[0]![2]).toContain('odds there');
        const hurt: Said[] = [];
        expect(run(picture(squad(['Merc', 'Cleric'], { Merc: { hp: 30 } }), []), [call()], hurt).reason).not.toStartWith('call:');
        expect(hurt[0]![2]).toContain('not ready');
        const far: Said[] = [];
        run(picture(squad(['Merc', 'Cleric']), []), [call({ at: { x: BASE.x + 9000, y: BASE.y, z: 0 } })], far);
        expect(far[0]![1]).toBe('declined');
        // Declined once, not again every tick.
        const memory: Record<string, any> = {};
        const again: Said[] = [];
        for (let i = 0; i < 3; i++) run(picture(squad(['Merc']), []), [call({ foes: 6, ours: 1 })], again, { memory });
        expect(again.length).toBe(1);
    });

    test('unasked: it comes only from near, when the call still wants bodies and the odds there favour us', () => {
        const said: Said[] = [];
        expect(run(picture(squad(['Merc', 'Cleric']), []), [call({ asked: [] })], said).reason).toStartWith('call:');
        expect(said[0]![2]).toStartWith('unasked');
        const none: Said[] = [];
        expect(run(picture(squad(['Merc', 'Cleric']), []), [call({ asked: [], at: { x: BASE.x + 6000, y: BASE.y, z: 0 } })], none).reason).not.toStartWith('call:');
        expect(run(picture(squad(['Merc', 'Cleric']), []), [call({ asked: [], want: 0 })], none).reason).not.toStartWith('call:');
        expect(run(picture(squad(['Merc']), []), [call({ asked: [], foes: 3, ours: 1 })], none).reason).not.toStartWith('call:');
        expect(none).toEqual([]);
    });

    test('there: arrived, and the fight it would have kept clear of is fought as one it chose', () => {
        const t0 = 1_000_000;
        const at = { x: BASE.x + 1000, y: BASE.y, z: 0 };
        const three = [foe(51, 1200), foe(52, 1300), foe(53, 1400)];
        // Without the call a duo keeps clear of three.
        expect(decide(picture(squad(['Merc', 'Cleric']), three, {}, t0), { now: t0 }).reason).toMatch(/^(avoid|flee):/);
        const said: Said[] = [];
        const memory: Record<string, any> = {};
        const d = run(picture(squad(['Merc', 'Cleric']), three, {}, t0), [call({ at })], said, { memory, now: t0 });
        expect(said.map(x => x[1])).toEqual(['coming', 'arrived']);
        expect(d.phase).toBe('engage');
        expect(d.reason).toContain("at camelot's call");
        const e = run(picture(squad(['Merc', 'Cleric'], { Merc: { inCombat: true } }), three, { phase: 'engage', focus: d.focus }, t0 + 1000), [call({ at })], said, { memory, now: t0 + 1000 });
        expect(e.phase).toBe('engage');
        expect(memory.squad.fight.chosen).toBe(true);
    });

    test('a call that closes, or the director going off, ends it: back on patrol', () => {
        const said: Said[] = [];
        const memory: Record<string, any> = {};
        run(picture(squad(['Merc', 'Cleric']), []), [call()], said, { memory });
        expect(run(picture(squad(['Merc', 'Cleric']), []), [], said, { memory }).reason).toContain('patrol');
        expect(memory.squad.call).toBeUndefined();
    });

    test('given up when the odds there collapse on the way', () => {
        const said: Said[] = [];
        const memory: Record<string, any> = {};
        run(picture(squad(['Merc', 'Cleric']), []), [call()], said, { memory });
        expect(run(picture(squad(['Merc', 'Cleric']), []), [call({ foes: 9, ours: 0 })], said, { memory }).reason).not.toStartWith('call:');
        expect(said.at(-1)![1]).toBe('left');
    });

    test('a muster: to the rally however far, held there until go, then on to the target', () => {
        const said: Said[] = [];
        const memory: Record<string, any> = {};
        const rally = { x: BASE.x + 12_000, y: BASE.y, z: 0 }, target = { x: BASE.x + 16_000, y: BASE.y, z: 0 };
        const muster = (over: Partial<RealmCall> = {}) => call({ id: 'albion-2', kind: 'muster', from: 'director', why: 'raid', at: rally, stage: 'rally', target, foes: 0, ours: 0, ...over });
        expect(run(picture(squad(['Merc']), []), [muster()], said, { memory }).reason).toStartWith('call: to the rally, 12000 away');
        const there = squad(['Merc'], {}, { x: rally.x + 200, y: rally.y });
        expect(run(picture(there, []), [muster()], said, { memory }).reason).toStartWith('call: at the rally, waiting for go');
        expect(run(picture(there, []), [muster({ stage: 'go', at: target })], said, { memory }).reason).toStartWith('call: to the raid, 3800 away');
        expect(said.map(x => x[1])).toEqual(['coming', 'arrived']);
    });

    test('off (squad.calls false): no call is answered', () => {
        const said: Said[] = [];
        expect(run(picture(squad(['Merc', 'Cleric']), []), [call()], said, { settings: { squad: { ...SQUAD_SETTINGS.squad, calls: false } } }).reason).not.toStartWith('call:');
        expect(said).toEqual([]);
    });
});

describe('edgePatrol: the roads and banks, away from the meeting point', () => {
    const bg = BATTLEGROUND_LAYOUTS[THIDRANKI]!;
    for (const realm of ['albion', 'midgard', 'hibernia'] as const) {
        test(`${realm}: at least five dry waypoints, all clear of the meeting point; the variants start on different lanes`, () => {
            const a = edgePatrol(THIDRANKI, realm, 24, { stayDry: true }, 0);
            const b = edgePatrol(THIDRANKI, realm, 24, { stayDry: true }, 1);
            expect(a.length).toBeGreaterThanOrEqual(5);
            for (const p of a) {
                expect(Math.hypot(p.x - bg.meet.x, p.y - bg.meet.y)).toBeGreaterThanOrEqual(6500);
                expect(isDry(THIDRANKI, p)).toBe(true);
            }
            expect(a[1]).not.toEqual(b[1]);
            // Starts on our own road, nearer home than the meeting point is.
            const home = homeOf(THIDRANKI, realm)!.arrival;
            expect(Math.hypot(a[0]!.x - home.x, a[0]!.y - home.y)).toBeLessThan(Math.hypot(bg.meet.x - home.x, bg.meet.y - home.y));
        });
    }

    test("a squad's loop keeps 7000 from a keep that isn't ours, where the Faste's bridges don't draw a walk onto the island", () => {
        const faste = BATTLEGROUND_LAYOUTS[THIDRANKI]!.keeps.find(k => k.name === 'Thidranki Faste')!;
        for (const realm of ['midgard', 'hibernia'] as const) {
            const loop = edgePatrol(THIDRANKI, realm, 24, SQUAD_SETTINGS, 0);
            expect(loop.length).toBeGreaterThanOrEqual(5);
            for (const p of loop) expect(Math.hypot(p.x - faste.x, p.y - faste.y)).toBeGreaterThanOrEqual(7000);
        }
    });

    test('the strategy patrols that loop in Thidranki', () => {
        const at = homeOf(THIDRANKI, 'albion')!.arrival;
        const memory: Record<string, any> = {};
        const us = squad(['Merc'], {}, { x: at.x, y: at.y - 6000 }, THIDRANKI);
        const p = picture(us, []);
        const d = decideSquad({ picture: p, orders: p.orders, memory, now: p.at, windingDown: false, settings: SQUAD_SETTINGS });
        expect(d.phase).toBe('travel');
        expect(memory.squadPatrol.length).toBeGreaterThanOrEqual(5);
        expect(squadRoaming.name).toBe('squad-roam');
    });
});

describe('decideSquad on generated boards (tactics/compare.ts)', () => {
    const SQUADS: RosterMember[][] = [
        [{ name: 'Merc', role: 'melee', className: 'Mercenary' }],
        [{ name: 'Merc', role: 'melee', className: 'Mercenary' }, { name: 'Cleric', role: 'healer', className: 'Cleric', capabilities: { heal: true } }],
        [{ name: 'Arms', role: 'tank', className: 'Armsman' }, { name: 'Cleric', role: 'healer', className: 'Cleric', capabilities: { heal: true } }, { name: 'Wizard', role: 'nuker', className: 'Wizard', capabilities: { nuke: true } }],
    ];
    test('never throws; a retreat always has a spot, an engage a focus; solo, duo and trio each fight and each leave', () => {
        const phases: Record<string, Record<string, number>> = {};
        for (let seed = 1; seed <= 90; seed++) {
            const roster = SQUADS[seed % 3]!;
            const key = String(roster.length);
            phases[key] ??= {};
            const pics = boards(rng(seed), { roster, regionId: R, origin: BASE, ticks: 60, foes: [1, 4] }, 1_000_000);
            const memory: Record<string, any> = {};
            let orders = pics[0]!.orders;
            for (const pic of pics) {
                const u = decideSquad({ picture: { ...pic, orders }, orders, memory, now: pic.at, windingDown: false, settings: mergeSettings(SQUAD_SETTINGS, { patrol: LOOP } as any) });
                if (u.phase === 'retreat') expect(u.retreatTo).toBeTruthy();
                if (u.phase === 'engage') expect(u.focus).not.toBeNull();
                const tag = u.phase === 'travel' && u.reason?.startsWith('avoid:') ? 'avoid' : u.phase!;
                phases[key]![tag] = (phases[key]![tag] ?? 0) + 1;
                orders = { ...orders, ...u } as Orders;
            }
        }
        for (const k of ['1', '2', '3']) {
            expect(phases[k]!.engage ?? 0).toBeGreaterThan(0);
            expect((phases[k]!.retreat ?? 0) + (phases[k]!.avoid ?? 0)).toBeGreaterThan(0);
        }
    });
});

describe('squad-run: lanes and friends', () => {
    test('the folder number picks the lane; friends are the other living bots of our realm, never an enemy', () => {
        expect([squadVariant('camelot-s1'), squadVariant('midgard-s2'), squadVariant('solo')]).toEqual([1, 2, 0]);
        const bot = (name: string, realm: any, group: string | null, over: object = {}) => ({ name, realm, x: 1, y: 2, isDead: false, group: group ? { id: group } : null, ...over });
        const bots = [bot('Mordred', 'albion', 'camelot-s1'), bot('Gawain', 'albion', 'camelot'), bot('Tuck', 'albion', 'camelot', { isDead: true }), bot('Sigrid', 'midgard', 'midgard'), bot('Lone', 'albion', null)];
        expect(friendsIn(bots, 'camelot-s1')).toHaveLength(2);
        expect(friendsIn([...bots, bot('Lancelot', 'albion', 'camelot', { hp: 60, level: 23, className: 'Paladin', inCombat: true, targetObjectId: 77 })], 'camelot-s1')[2]).toMatchObject({ name: 'Lancelot', hp: 60, level: 23, className: 'Paladin', inCombat: true, targetId: 77 });
        expect(friendsIn(bots, 'nobody')).toEqual([]);
    });
});
