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
        const friends = [{ x: BASE.x, y: BASE.y + 5000 }];
        const d = decide(picture(squad(['Merc']), two, { phase: 'engage', focus: 51 }), { friends });
        expect(d.phase).toBe('retreat');
        expect(d.objective).toContain('toward friends');
        expect(d.retreatTo!.y).toBeGreaterThan(BASE.y + 1000);
        // Friends behind the enemy (east): not that way.
        const e = decide(picture(squad(['Merc']), two, { phase: 'engage', focus: 51 }), { friends: [{ x: BASE.x + 5000, y: BASE.y }] });
        expect(e.objective).not.toContain('toward friends');
        expect(e.retreatTo!.x).toBeLessThan(BASE.x);
    });

    test("a stealther's opener: a lone melee on a hurt solo is fought out, unless friends are near to run to", () => {
        const opener = [foe(51, 100, { ...guess('melee'), target: 'Wizard', threat: true })];
        const us = () => squad(['Wizard'], { Wizard: { hp: 45, inCombat: true } });
        const d = decide(picture(us(), opener, { phase: 'engage', focus: 51 }));
        expect(d.phase).toBe('engage');
        expect(d.focus).toBe(51);
        const e = decide(picture(us(), opener, { phase: 'engage', focus: 51 }), { friends: [{ x: BASE.x - 3000, y: BASE.y }] });
        expect(e.phase).toBe('retreat');
        // A caster on us is no runner: from it we run whatever.
        const f = decide(picture(us(), [foe(51, 100, { ...guess('caster'), target: 'Wizard', threat: true })], { phase: 'engage', focus: 51 }));
        expect(f.phase).toBe('retreat');
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
