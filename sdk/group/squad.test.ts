import { describe, expect, test } from 'bun:test';
import { enemy, picture, report } from './fixtures';
import { BATTLEGROUND_LAYOUTS, homeOf, THIDRANKI } from './keeps';
import { countFor } from './size';
import { decideSquad, edgePatrol, sideStrength, sizeUp, SQUAD_SETTINGS, squadRoaming, type SquadSettings } from './squad';
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
const decide = (p: GroupPicture, o: Parameters<typeof ctx>[1] & { friends?: Point[] } = {}) => decideSquad(ctx(p, o), undefined, { friends: () => o.friends ?? [] });

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
        // Out of sight beyond engageRadius for shakenMs: done, and those two are not hunted.
        d = decide(picture(squad(['Merc']), chasers(3800), o, t0 + 8000), { memory, now: t0 + 8000 });
        expect(d.phase).toBe('retreat');
        d = decide(picture(squad(['Merc']), chasers(3800), o, t0 + 12_000), { memory, now: t0 + 12_000 });
        expect(d.phase).toBe('travel');
        expect(d.reason).toContain('patrol');
        expect(memory.squad.avoid[51]).toBeGreaterThan(t0 + 12_000);

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
        expect(friendsIn(bots, 'nobody')).toEqual([]);
    });
});
