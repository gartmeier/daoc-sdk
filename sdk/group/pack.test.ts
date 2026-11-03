import { describe, expect, test } from 'bun:test';
import { areaMezzCatch, backupHealWanted } from './behaviors';
import { enemy, picture, report } from './fixtures';
import { decidePack, packBehaviors, packCc, PACK_SETTINGS, pickPackFocus, rvrPack, type PackSettings } from './pack';
import { RVR_SETTINGS, rvrBehaviors, rvrRoaming } from './rvr';
import { mergeSettings, type CoordinatorContext } from './strategy';
import { pickNuke, type SpellPick } from './spells';
import type { Contact, GroupPicture, MemberReport, Orders, Point } from './types';

// Region 9999 has no spawns and no battleground: no aggro zones, keeps or home get in the way.
const R = 9999;
const BASE = { x: 10_000, y: 10_000 };
const LOOP = [{ x: 10_000, y: 10_000, z: 0 }, { x: 13_000, y: 10_000, z: 0 }];
const caps = (heal: boolean, cc: boolean, nuke: boolean) => ({ heal, cc, nuke, buffs: [], buffSpells: [] });

function team(over: Partial<Record<string, Partial<MemberReport>>> = {}, base: Point = BASE, regionId = R): MemberReport[] {
    const at = (dx: number, dy: number) => ({ regionId, x: base.x + dx, y: base.y + dy, level: 24 });
    return [
        report('Tank', { role: 'tank', className: 'Hero', objectId: 1, mana: 0, capabilities: caps(false, false, false), ...at(0, 0), ...over.Tank }),
        report('Druid', { role: 'healer', className: 'Druid', objectId: 2, capabilities: caps(true, true, false), ...at(-100, 100), ...over.Druid }),
        report('Bard', { role: 'support', className: 'Bard', objectId: 3, capabilities: caps(true, true, false), ...at(-100, -100), ...over.Bard }),
        report('Menta', { role: 'nuker', className: 'Mentalist', objectId: 4, capabilities: caps(true, true, true), ...at(-200, 100), ...over.Menta }),
        report('Encha', { role: 'nuker', className: 'Enchanter', objectId: 5, capabilities: caps(false, false, true), ...at(-200, -100), ...over.Encha }),
    ];
}

function ctx(p: GroupPicture, opts: { memory?: Record<string, any>; orders?: Partial<Orders>; settings?: any; now?: number; windingDown?: boolean } = {}): CoordinatorContext<PackSettings> {
    return { picture: p, orders: { ...p.orders, ...opts.orders }, memory: opts.memory ?? {}, now: opts.now ?? p.at, windingDown: opts.windingDown ?? false, settings: mergeSettings(PACK_SETTINGS, { patrol: LOOP, ...opts.settings }) };
}

const foe = (id: number, x: number, y = 10_000, over: Partial<Contact> = {}) => enemy(id, 'midgard', { regionId: R, x, y, ...over });
const fiveAt = (x: number) => [foe(101, x), foe(102, x + 200), foe(103, x + 300, 10_200), foe(104, x + 400), foe(105, x + 500, 9_800)];
const distTo = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

describe('decidePack: stalking', () => {
    test('with nobody in sight it patrols like rvr-roam', () => {
        expect(decidePack(ctx(picture(team()))).phase).toBe('travel');
    });

    test('a group far off is stalked, never engaged, and the leg stops short of it', () => {
        const u = decidePack(ctx(picture(team(), fiveAt(13_500))));
        expect(u.phase).toBe('travel');
        expect(u.focus ?? null).toBeNull();
        expect(u.reason).toContain('stalk');
        expect(distTo(u.anchor!, { x: 13_500, y: 10_000 })).toBeGreaterThanOrEqual(1500);
    });

    test('no waiting at range: it walks on until the nearest is in reach of the raid', () => {
        const u = decidePack(ctx(picture(team(), fiveAt(11_750))));
        expect(u.phase).toBe('travel');
        expect(distTo(u.anchor!, { x: 11_750, y: 10_000 })).toBeLessThanOrEqual(1500);
    });

    test('an enemy within reach opens the raid: anchor on the focus, the nearest, Bard mezzes', () => {
        const m: any = {};
        const u = decidePack(ctx(picture(team(), fiveAt(11_000)), { memory: m }));
        expect(u.phase).toBe('engage');
        expect(u.focus).toBe(101);
        expect(m.pack).toBe('raid');
        expect(u.cc!.some(a => a.by === 'Bard')).toBe(true);
        expect(distTo(u.anchor!, { x: 11_000, y: 10_000 })).toBeLessThan(200);
    });

    test('refuses only a real crowd or a pack that is hurt or out of power; cooling down does not count', () => {
        const crowd = [...fiveAt(13_000), foe(201, 13_000, 10_300), foe(202, 13_100, 10_300), foe(203, 13_200, 10_300), foe(204, 13_300, 10_300)];
        expect(decidePack(ctx(picture(team(), crowd))).reason).toContain('enemies together');
        expect(decidePack(ctx(picture(team({ Menta: { mana: 10 } }), fiveAt(13_000)))).reason).toContain('not ready');
        expect(decidePack(ctx(picture(team(), fiveAt(13_000)), { memory: { raidEnd: 5000 }, now: 6000 })).reason).toContain('stalk');
    });

    test('hurt and attacked: walks off to rest', () => {
        const m: any = {};
        const u = decidePack(ctx(picture(team({ Menta: { mana: 10 } }), [foe(101, 11_000, 10_000, { target: 'Tank' }), foe(102, 11_100), foe(103, 11_200)]), { memory: m }));
        expect(u.phase).toBe('travel');
        expect(m.pack).toBe('leave');
    });
});

describe('decidePack: prey', () => {
    test('five against two is hunted even while cooling down, and killed with the Hero, not stood off from', () => {
        const m: any = { raidEnd: 5000 };
        const far = decidePack(ctx(picture(team(), [foe(101, 13_000), foe(102, 13_200)]), { memory: m, now: 6000 }));
        expect(far.reason).toContain('hunt');
        expect(far.anchor!.x).toBeGreaterThan(10_000);
        const m2: any = { raidEnd: 5000 };
        const near = decidePack(ctx(picture(team(), [foe(101, 11_200), foe(102, 11_400)]), { memory: m2, now: 6000 }));
        expect(near.phase).toBe('engage');
        expect(m2.pack).toBe('kill');
        expect(distTo(near.anchor!, { x: 11_200, y: 10_000 })).toBeLessThan(200);
    });

    test('not with a member badly hurt, and not three: that stays a raid or a refusal', () => {
        const hurt = decidePack(ctx(picture(team({ Menta: { hp: 30 } }), [foe(101, 13_000)])));
        expect(hurt.reason).toContain('not ready');
        const three = decidePack(ctx(picture(team(), [foe(101, 13_000), foe(102, 13_200), foe(103, 13_400)])));
        expect(three.reason).toContain('stalk');
    });
});

describe('decidePack: raid, pull back, kill, leave', () => {
    const raid = (over: object = {}) => ({ pack: 'raid', raidAt: 1000, packAnchor: { x: 10_000, y: 10_000, z: 0 }, ...over });

    test('the burst ends by the clock and pulls back away from them', () => {
        const m: any = raid();
        const u = decidePack(ctx(picture(team(), fiveAt(11_300)), { memory: m, now: 1000 + PACK_SETTINGS.pack.raidMs }));
        expect(u.phase).toBe('retreat');
        expect(u.retreatTo!.x).toBeLessThan(10_000);
        expect(m.pack).toBe('pull');
    });

    test('a focus almost dead gets its extra seconds', () => {
        const foes = [foe(101, 11_300, 10_000, { hp: 10 }), foe(102, 11_500)];
        const u = decidePack(ctx(picture(team(), foes), { memory: raid(), orders: { focus: 101 }, now: 1000 + PACK_SETTINGS.pack.raidMs + 1000 }));
        expect(u.phase).toBe('engage');
    });

    test('three enemies on our casters end the raid at once', () => {
        const foes = [foe(101, 9_900, 10_100), foe(102, 9_900, 9_900), foe(103, 9_800, 10_100), foe(104, 11_000)];
        expect(decidePack(ctx(picture(team(), foes), { memory: raid(), now: 2000 })).phase).toBe('retreat');
    });

    test('after the run it always turns: whoever is nearest gets killed, and the rest mezzed', () => {
        const crowd = [foe(101, 11_000), foe(102, 11_100), foe(103, 11_200)];
        const m: any = { pack: 'pull', pullAt: 0, pullLegs: 0 };
        const u = decidePack(ctx(picture(team(), crowd), { memory: m, orders: { retreatTo: { x: 10_000, y: 10_000, z: 0 } }, now: 500 }));
        expect(u.phase).toBe('engage');
        expect(u.focus).toBe(101);
        expect(m.pack).toBe('kill');
    });

    test('a kill goes on 12 s, then runs a bit again', () => {
        const m: any = { pack: 'kill', killAt: 0 };
        const u = decidePack(ctx(picture(team(), [foe(101, 11_000), foe(102, 11_100), foe(103, 11_200)]), { memory: m, now: PACK_SETTINGS.pack.killMs }));
        expect(u.phase).toBe('retreat');
        expect(u.reason).toContain('run a bit');
    });

    test('nobody near after a run or a kill: back to the stalk', () => {
        const a: any = { pack: 'pull', pullAt: 0, pullLegs: 0 };
        decidePack(ctx(picture(team(), [foe(101, 14_000)]), { memory: a, orders: { retreatTo: { x: 10_000, y: 10_000, z: 0 } }, now: 500 }));
        expect(a.pack).toBe('stalk');
        const b: any = { pack: 'kill', killAt: 0 };
        expect(decidePack(ctx(picture(team()), { memory: b, now: 500 })).phase).toBe('travel');
        expect(b.pack).toBe('stalk');
    });

    test('the druid roots only chasers, not raid targets', () => {
        const m: any = {};
        const u = decidePack(ctx(picture(team(), fiveAt(11_000)), { memory: m }));
        expect(u.cc!.some(a => a.by === 'Druid')).toBe(false);
    });
});

describe('decidePack: nobody walks alone', () => {
    // Region 252: the keep and its arrival are real, a released member stands at (17367, 18248).
    const THID = 252;
    const keep = { x: 17_367, y: 18_248 };
    const middle = { x: 34_000, y: 32_000 };
    const thid = (o: Partial<Record<string, Partial<MemberReport>>> = {}, base = middle) => team(o, base, THID);

    test('a released member at the keep is told to wait, and the pack goes to get it', () => {
        const m: any = { realm: 'hibernia' };
        const members = thid({ Menta: { x: keep.x, y: keep.y } });
        const u = decidePack(ctx(picture(members), { memory: m, settings: { patrol: null } }));
        expect(u.waiting).toContainEqual({ name: 'Menta', why: 'pickup' });
        expect(u.phase).toBe('travel');
        expect(distTo(u.anchor!, keep)).toBeLessThan(distTo(middle, keep));
    });

    test('once the pack is near, nobody is waiting and it rebuffs together', () => {
        const m: any = { realm: 'hibernia', pack: 'home', hadDead: true };
        const near = { x: keep.x + 300, y: keep.y };
        const u = decidePack(ctx(picture(thid({ Menta: { x: keep.x, y: keep.y } }, near)), { memory: m, settings: { patrol: null } }));
        expect(u.waiting!.some(w => w.why === 'pickup')).toBe(false);
        expect(u.phase).toBe('recover');
        expect(m.pack).toBe('rebuff');
    });

    test('fewer than three together: home, whatever the phase was', () => {
        const m: any = { realm: 'hibernia', pack: 'raid', raidAt: 0, packAnchor: { ...middle, z: 0 } };
        const members = thid({ Tank: { isDead: true }, Druid: { isDead: true }, Encha: { isDead: true } });
        const u = decidePack(ctx(picture(members), { memory: m, settings: { patrol: null } }));
        expect(m.pack).toBe('home');
        expect(u.phase).not.toBe('engage');
    });

    test('rebuff waits out its time and everyone\'s health and power, then stalks', () => {
        const near = { x: keep.x, y: keep.y };
        const m: any = { realm: 'hibernia', pack: 'rebuff', rebuffAt: 0 };
        expect(decidePack(ctx(picture(thid({}, near)), { memory: m, now: 1000, settings: { patrol: null } })).phase).toBe('recover');
        const low: any = { realm: 'hibernia', pack: 'rebuff', rebuffAt: 0 };
        expect(decidePack(ctx(picture(thid({ Bard: { mana: 50 } }, near)), { memory: low, now: 60_000, settings: { patrol: null } })).reason).toContain("Bard's power");
        const ok: any = { realm: 'hibernia', pack: 'rebuff', rebuffAt: 0 };
        decidePack(ctx(picture(thid({}, near)), { memory: ok, now: 60_000, settings: { patrol: null } }));
        expect(ok.pack).toBe('stalk');
    });
});

describe('pickPackFocus and packCc', () => {
    const c = { x: 0, y: 0 };
    const near = enemy(1, 'midgard', { x: 500, y: 0 });
    const far = enemy(2, 'midgard', { x: 1400, y: 0 });

    test('the nearest, a known caster ahead of a fighter, never a healer while anything else is in reach', () => {
        expect(pickPackFocus([near, far], c, 1500)!.objectId).toBe(1);
        expect(pickPackFocus([near, { ...far, caster: true }], c, 1500)!.objectId).toBe(2);
        expect(pickPackFocus([{ ...near, healer: true }, far], c, 1500)!.objectId).toBe(2);
        expect(pickPackFocus([{ ...near, healer: true }], c, 1500)!.objectId).toBe(1);
    });

    const m = (name: string, role: any, cc = true) => report(name, { role, capabilities: caps(false, cc, false) });
    const opts = { centre: c, focus: near, areaRadius: 350, now: 0 };

    test('the Bard takes the far one; a nuker only a healer; the focus is left alone', () => {
        const a = packCc([near, far], [m('Bard', 'support'), m('Menta', 'nuker')], [], opts);
        expect(a).toEqual([{ targetId: 2, by: 'Bard' }]);
        const healer = enemy(3, 'midgard', { x: 1000, y: 800, healer: true });
        const b = packCc([near, far, healer], [m('Bard', 'support'), m('Menta', 'nuker')], [], opts);
        expect(b.some(x => x.by === 'Menta' && x.targetId === 3) || b.some(x => x.by === 'Bard' && x.targetId === 3)).toBe(true);
        expect(b.every(x => x.targetId !== 1)).toBe(true);
    });

    test('the Bard goes for a cluster away from the focus, and an immune one is skipped', () => {
        const a2 = enemy(4, 'midgard', { x: 1300, y: 100 }), a3 = enemy(5, 'midgard', { x: 1200, y: 0 });
        const a = packCc([near, far, a2, a3], [m('Bard', 'support')], [], opts);
        expect([2, 4, 5]).toContain(a[0]!.targetId);
        const b = packCc([near, { ...far, ccImmuneUntil: 100 }], [m('Bard', 'support')], [], opts);
        expect(b).toEqual([]);
    });

    test('a root keeps clear of what the mezz can catch, so it never wakes a mezzed enemy', () => {
        const bard = m('Bard', 'support'), druid = m('Druid', 'healer');
        const nextTo = enemy(6, 'midgard', { x: 1400, y: 200 }), away = enemy(7, 'midgard', { x: 700, y: 900 });
        const a = packCc([near, far, nextTo, away], [bard, druid], [], { ...opts, roots: true });
        const bardOn = a.find(x => x.by === 'Bard')!.targetId, druidOn = a.find(x => x.by === 'Druid')?.targetId;
        expect([2, 6]).toContain(bardOn);
        expect(druidOn === undefined || druidOn === 7).toBe(true);
        expect(packCc([near, far, nextTo], [bard, druid], [], { ...opts, roots: true }).some(x => x.by === 'Druid')).toBe(false);
    });

    test('roots only with roots: true', () => {
        const druid = m('Druid', 'healer');
        expect(packCc([near, far], [druid], [], opts)).toEqual([]);
        expect(packCc([near, far], [druid], [], { ...opts, roots: true })).toEqual([{ targetId: 2, by: 'Druid' }]);
    });
});

describe('backupHealWanted: the Bard heals only as a backup', () => {
    const hurtOne = team({ Menta: { hp: 40 } });
    const bard = hurtOne.find(x => x.name === 'Bard')!;

    test('not while the Druid is free and one member is hurt in her reach', () => {
        expect(backupHealWanted(bard, hurtOne, [], 40)).toBe(false);
        expect(backupHealWanted(bard, team(), [], 40)).toBe(false);
    });

    test('when the Druid is attacked or dead, two are low, or the hurt one is out of her reach', () => {
        expect(backupHealWanted(bard, hurtOne, [foe(1, 10_000, 10_000, { target: 'Druid' })], 40)).toBe(true);
        expect(backupHealWanted(bard, team({ Menta: { hp: 40 }, Druid: { isDead: true } }), [], 40)).toBe(true);
        expect(backupHealWanted(bard, team({ Menta: { hp: 40 }, Encha: { hp: 50 } }), [], 40)).toBe(true);
        const stretched = team({ Menta: { hp: 40, x: 10_500, y: 10_000 }, Druid: { x: 8_000, y: 10_000 } });
        expect(backupHealWanted(stretched.find(x => x.name === 'Bard')!, stretched, [], 40)).toBe(true);
    });
});

describe('areaMezzCatch', () => {
    const t = enemy(1, 'midgard', { x: 0, y: 0 }), n = enemy(2, 'midgard', { x: 300, y: 0 }), far = enemy(3, 'midgard', { x: 600, y: 0 });

    test('counts free players in the radius, target included', () => {
        expect(areaMezzCatch(t, [t, n, far], 350, null).map(c => c.objectId)).toEqual([1, 2]);
        expect(areaMezzCatch(t, [t, { ...n, cc: { kind: 'mezz', by: 'x', until: 0 } as any }], 350, null).map(c => c.objectId)).toEqual([1]);
    });

    test('nothing when the focus would be caught', () => {
        expect(areaMezzCatch(t, [t, n, far], 350, 2)).toEqual([]);
        expect(areaMezzCatch(t, [t, n, far], 350, 3).length).toBe(2);
    });
});

describe('options leave rvr-roam as it was', () => {
    const nuke = (name: string, level: number, damage: number) => ({ spell: { name, level }, type: 'DirectDamage', target: 'Enemy', range: 1500, radius: 0, damage }) as unknown as SpellPick;

    test('pickNuke takes the highest level unless asked for the hardest hit', () => {
        const list = [nuke('Sun Streak', 24, 88), nuke('Glittering Visions', 22, 102)];
        expect(pickNuke(list)!.spell.name).toBe('Sun Streak');
        expect(pickNuke(list, { byDamage: true })!.spell.name).toBe('Glittering Visions');
    });

    test('rvr-roam settings carry none of the pack options, and only the pack drops position', () => {
        expect(RVR_SETTINGS.standGround).toBeUndefined();
        expect(RVR_SETTINGS.areaMezzMin).toBeUndefined();
        expect(RVR_SETTINGS.strongestNuke).toBeUndefined();
        expect(rvrRoaming.settings).toBe(RVR_SETTINGS);
        expect(rvrBehaviors().nuker.map(b => b.name)).toContain('position');
        expect(packBehaviors().nuker.map(b => b.name)).not.toContain('position');
        expect(packBehaviors().nuker.map(b => b.name)).toContain('assist');
        expect(rvrPack.name).toBe('rvr-pack');
    });
});
