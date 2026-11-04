import { describe, expect, spyOn, test } from 'bun:test';
import { areaMezzCatch, backupHealWanted, confuse, interrupt, rest, SAVING_POWER, standStepTo } from './behaviors';
import { petControl } from './pets';
import { Blackboard, SHADE_REFUSED, UNATTACKABLE_MS } from './blackboard';
import { enemy, obs, picture, report, sighting } from './fixtures';
import { decidePack, packBehaviors, packCc, PACK_SETTINGS, pickPackFocus, rvrPack, type PackSettings } from './pack';
import { RVR_SETTINGS, rvrBehaviors, rvrRoaming, defaultPatrol, spokedPatrol } from './rvr';
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

describe('decidePack: a Necromancer in shade (AbstractServerRules.cs:449-455)', () => {
    const shade = (over: Partial<Contact> = {}) => foe(51, 11_000, 10_000, { name: 'Briton', realm: 'albion', isShade: true, threat: false, ...over });

    test('it opens no raid and is no focus: every attack on it is refused', () => {
        const m: any = {};
        const u = decidePack(ctx(picture(team(), [shade()]), { memory: m }));
        expect(u.focus ?? null).toBeNull();
        expect(m.pack).not.toBe('raid');
    });

    test('in a raid the focus moves off it at once, to the enemy beside it, and no mezz goes on it', () => {
        const m: any = { pack: 'raid', raidAt: 1000, packAnchor: { x: 10_000, y: 10_000, z: 0 } };
        const u = decidePack(ctx(picture(team(), [shade(), foe(53, 11_100)], { phase: 'engage', focus: 51 }), { memory: m, now: 2000 }));
        expect(u).toMatchObject({ phase: 'engage', focus: 53 });
        expect((u.cc ?? []).map(a => a.targetId)).not.toContain(51);
    });

    test('its servant on us is fought like any enemy pet, as rvr-roam does', () => {
        const servant = enemy(52, 'albion', { kind: 'npc', name: 'necroservant', level: 17, isPet: true, regionId: R, x: 10_500, y: 10_000, threat: true, target: 'Tank' });
        expect(decidePack(ctx(picture(team(), [shade(), servant])))).toMatchObject({ phase: 'engage', focus: 52 });
    });
});

describe('a shade in the pickers that go straight to the contacts (AbstractServerRules.cs:449-455)', () => {
    const member = (at: number) => report('Bard', { objectId: 100, regionId: 1, at, x: 1000, y: 1000 });
    const shade = sighting(42, { kind: 'player', name: 'Briton', realm: 'albion', x: 1500, y: 1000, isShade: true, casting: true });
    const free = (id: number) => sighting(id, { kind: 'player', name: 'Saracen', realm: 'albion', x: 1600, y: 1000, casting: id === 8 });
    /** A real board, the server's answer to a cast at a shade, and what member.ts does with that line. */
    function bard(focus: number | null, sightings = [shade, free(7)]) {
        const b = new Blackboard();
        const t = Date.now();
        b.publish(obs(member(t), sightings), t);
        const casts: number[] = [];
        const ctx: any = {
            name: 'Bard',
            orders: () => ({ phase: 'engage', focus, cc: [] }),
            spells: { confuse: () => ({ spell: { name: 'Befuddling Cadence' }, range: 1350 }), interrupts: () => [{ spell: { name: 'Minor Lullaby' }, range: 2300 }] },
            picture: () => b.picture(),
            sdk: { getNearbyNpc: () => null, getNearbyPlayer: (id: number) => ({ objectId: id, distance: 500 }) },
            doing() {},
            result(_k: string, r: { message?: string }, id: number) { if (r.message?.includes(SHADE_REFUSED)) b.markUnattackable(id, 1, UNATTACKABLE_MS); },
            bot: { castSpell: async (_s: unknown, id: number) => { casts.push(id); return { success: id !== 42, reason: id === 42 ? 'refused' : undefined, message: id === 42 ? SHADE_REFUSED : 'Cast' }; } },
        };
        return { ctx, casts, b };
    }

    test('confuse leaves it, however long it has been known a caster, and the turn goes on to the song', async () => {
        const { ctx, casts } = bard(7);
        expect(await confuse().run(ctx)).toBe(false);
        expect(casts).toEqual([]);
    });

    test('interrupt leaves it, and takes the one it can stop: the mezz under it gets its turn', async () => {
        const alone = bard(7);
        expect(await interrupt().run(alone.ctx)).toBe(false);
        expect(alone.casts).toEqual([]);
        const both = bard(7, [shade, free(8)]);
        expect(await interrupt().run(both.ctx)).toBe(true);
        expect(both.casts).toEqual([8]);
    });

    test('an area mezz doesn\'t count it: the server\'s area selection never catches one (SpellHandler.cs:1477, :1599), and crowdControl would mark it mezzed', () => {
        const { b } = bard(null);
        const contacts = b.picture().contacts;
        expect(areaMezzCatch(contacts.find(c => c.objectId === 7)!, contacts, 350, null).map(c => c.objectId)).toEqual([7]);
    });

    test('a refusal\'s mark does the same for one never read as a shade', async () => {
        const { b, ctx, casts } = bard(7, [sighting(42, { kind: 'player', name: 'Briton', realm: 'albion', x: 1500, y: 1000, casting: true }), free(7)]);
        b.markUnattackable(42, 1, UNATTACKABLE_MS);
        expect(await confuse().run(ctx)).toBe(false);
        expect(casts).toEqual([]);
    });
});

describe('decidePack: a pet in it', () => {
    const PET_CAPS = (nuke = false) => ({ ...caps(false, false, nuke), pet: 'main' as const });
    const resting = { kind: 'rest', targetId: null, detail: SAVING_POWER, since: 0 };

    test('what it waits on is the summon\'s power, as rvr-roam and pve say, so the report\'s advice is the right one', () => {
        const low = { Encha: { mana: 28, activity: resting } };
        const rest = decidePack(ctx(picture(team(low), [foe(101, 14_120)]), { memory: { pack: 'stalk', resting: true } }));
        expect(rest).toMatchObject({ phase: 'recover' });
        expect(rest.waiting).toEqual([{ name: 'Encha', why: 'pet power' }]);
        const rebuff = decidePack(ctx(picture(team(low), [foe(101, 18_000)]), { memory: { pack: 'rebuff', rebuffAt: 0 }, now: Date.now() }));
        expect(rebuff.waiting).toEqual([{ name: 'Encha', why: 'pet power' }]);
    });

    test('plain low power stays power', () => {
        const rest = decidePack(ctx(picture(team({ Encha: { mana: 28 } }), [foe(101, 14_120)]), { memory: { pack: 'stalk', resting: true } }));
        expect(rest.waiting).toEqual([{ name: 'Encha', why: 'power' }]);
    });

    test('a member whose only use for power is its pet counts: a Hunter', () => {
        const hunter = { Tank: { className: 'Hunter', capabilities: PET_CAPS(), mana: 60 } };
        const held = decidePack(ctx(picture(team(hunter), [foe(101, 18_000)]), { memory: { pack: 'rebuff', rebuffAt: 0 }, now: Date.now() }));
        expect(held.waiting).toEqual([{ name: 'Tank', why: 'power' }]);
    });

    describe('an enemy on a member\'s pet is on us, as in decideRvr', () => {
        const onPet = (over: Partial<Contact>, x = 11_000) => foe(51, x, 10_000, { target: null, targetPet: 'Encha', threat: true, ...over });

        test('it counts for who is attacked: a main body beside the one whose pet it is, not a gathering from afar', () => {
            const far = { Menta: { x: 26_000, y: 26_000 }, Encha: { x: 26_100, y: 26_000 } };
            const on = (over: Partial<Contact>) => foe(51, 26_400, 26_000, { threat: true, ...over });
            const u = decidePack(ctx(picture(team(far), [on({ target: null, targetPet: 'Encha' })]), { memory: { pack: 'stalk' } }));
            const direct = decidePack(ctx(picture(team(far), [on({ target: 'Encha', targetPet: null })]), { memory: { pack: 'stalk' } }));
            expect(direct.reason).toContain('only 2 together');
            expect(u.phase).toBe(direct.phase);
            expect(u.reason).toBe(direct.reason);
        });

        test('a leave breaks off for it, as for one on the member', () => {
            const memory = { pack: 'leave', leaveTo: { x: 16_000, y: 10_000 }, raidEnd: 1000 };
            const u = decidePack(ctx(picture(team(), [onPet({}, 12_000)]), { memory: { ...memory }, now: 2000 }));
            const direct = decidePack(ctx(picture(team(), [onPet({ target: 'Encha', targetPet: null }, 12_000)]), { memory: { ...memory }, now: 2000 }));
            expect(u.reason).toBe(direct.reason);
        });

        test('inside a keep\'s circle: it is a foe when it hits the pet too', () => {
            // Thidranki, Midgard's portal keep (54053, 24680): a Norseman 4000 from it, inside its 4500.
            const THID = 252, NEAR_KEEP = { x: 48_633, y: 24_680 };
            const inCircle = (over: Partial<Contact>) => [enemy(51, 'midgard', { regionId: THID, x: NEAR_KEEP.x + 1300, y: NEAR_KEEP.y, threat: true, ...over })];
            const members = team({}, NEAR_KEEP, THID);
            const pet = decidePack(ctx(picture(members, inCircle({ target: null, targetPet: 'Encha' })), { memory: { pack: 'stalk' } }));
            const member = decidePack(ctx(picture(members, inCircle({ target: 'Encha', targetPet: null })), { memory: { pack: 'stalk' } }));
            expect(member).toMatchObject({ phase: 'engage', focus: 51 });
            expect(pet).toMatchObject({ phase: 'engage', focus: 51 });
        });
    });
});

describe('a pet in a fight as the pack walks off: real board, real decidePack, real petControl and rest', () => {
    const ENEMY = 51, PET = 900;
    const LOW: Record<string, number> = { Tank: 0, Druid: 15, Bard: 80, Menta: 15, Encha: 15 };
    const OFFS: Record<string, [number, number]> = { Tank: [0, 0], Druid: [-100, 100], Bard: [-100, -100], Menta: [-200, 100], Encha: [-200, -100] };

    async function walkOff(settingsOver: object = {}) {
        let clock = 1_000_000;
        const dateNow = spyOn(Date, 'now').mockImplementation(() => clock);
        try {
            const settings = mergeSettings(PACK_SETTINGS, { patrol: LOOP, ...settingsOver });
            const board = new Blackboard(rvrPack.board);
            const memory: Record<string, any> = {};
            const pet = { objectId: PET, name: 'underhill companion', aggression: 'defensive' as string, walk: 'follow' as string, icons: [] as number[], targetObjectId: ENEMY as number | null };
            let base = { x: 10_000, y: 10_000 };
            const sent: string[] = [];
            const me = () => ({ name: 'Encha', objectId: 5, regionId: R, x: base.x - 200, y: base.y - 100, z: 0, level: 24, realm: 'hibernia', attacking: false, targetObjectId: null, concentration: 0, healthPercent: 100, mana: 150, maxMana: 1000, manaPercent: 15, isShade: false });
            const rests: unknown[] = [];
            const member: any = {
                name: 'Encha', role: 'nuker', settings, memory: new Map<string, any>(),
                sdk: {
                    getPetState: () => pet, getPet: () => null, getGameMessages: () => [], getNearbyNpc: () => null, getNearbyPlayer: () => null,
                    getState: () => ({ pet, combatEvents: [], timestamp: clock, effects: [], equipment: [], gameMessages: [] }),
                    sendPetCommand: async (c: string) => { sent.push(c); if (c === 'follow' || c === 'passive') pet.targetObjectId = null; if (c === 'passive' || c === 'defensive') pet.aggression = c; return { success: true, message: '' }; },
                },
                bot: { isDead: () => false, rest: async (o: unknown) => { rests.push(o); return { success: true, message: 'Rested' }; }, getAttackers: () => [], getPlayerAttackers: () => [] },
                spells: { knowsTurret: () => false, buffs: () => [], capabilities: () => ({ ccKinds: [] }) },
                me, isTank: () => false, turn: () => null,
                picture: () => board.picture(clock), orders: () => board.getOrders(), members: () => board.picture(clock).members,
                tank: () => board.picture(clock).members.find(m => m.role === 'tank' && !m.isDead),
                contact: (id: number | null | undefined) => board.picture(clock).contacts.find(c => c.objectId === id),
                focus: () => board.picture(clock).contacts.find(c => c.objectId === board.getOrders().focus),
                threats: () => board.picture(clock).contacts.filter(c => c.threat),
                doing: () => {}, skip: () => false, result: () => {},
            };
            const log: { phase: string; reason: string; threats: number; rested: boolean | null; petOn: number | null }[] = [];
            for (let t = 0; t < 40; t++) {
                clock += 1000;
                for (const m of team()) {
                    const [dx, dy] = OFFS[m.name]!;
                    const r = { ...m, regionId: R, x: base.x + dx, y: base.y + dy, level: 24, mana: LOW[m.name]!, at: clock, ...(m.name === 'Encha' ? { pet: { objectId: PET, name: pet.name, level: 20, x: null, y: null, z: null, hp: 80, targetId: pet.targetObjectId, inCombat: pet.targetObjectId !== null, aggression: pet.aggression, walk: pet.walk, icons: [] } } : {}) } as MemberReport;
                    // It aims at nobody: a defensive pet answered a hit on its owner, and now it is the pet's fight alone.
                    board.publish(obs(r, [sighting(ENEMY, { kind: 'player', name: 'Norseman', level: 24, realm: 'midgard', x: 11_280, y: 10_000, inCombat: true })]), clock);
                }
                const update = decidePack({ picture: board.picture(clock), orders: board.getOrders(), memory, now: clock, windingDown: false, settings });
                board.setOrders(update, clock);
                const orders = board.getOrders();
                await petControl().run(member);
                const rested = orders.phase === 'recover' ? !!(await rest().run(member)) : null;
                log.push({ phase: orders.phase, reason: orders.reason, threats: member.threats().length, rested, petOn: pet.targetObjectId });
                const a = orders.anchor;
                if (a && orders.phase === 'travel') {
                    const dx = a.x - base.x, dy = a.y - base.y, len = Math.hypot(dx, dy);
                    if (len > 0) { const step = Math.min(len, 191); base = { x: base.x + dx / len * step, y: base.y + dy / len * step }; }
                }
            }
            return { log, sent, rests };
        } finally {
            dateNow.mockRestore();
        }
    }

    test('it comes along at the first order to go, and once the threat has lapsed the pack sits', async () => {
        const { log, sent, rests } = await walkOff();
        expect(log[0]!.reason).toContain('leave');
        expect(sent.slice(0, 2)).toEqual(['passive', 'follow']);
        expect(log[0]!.petOn).toBeNull();
        expect(log.filter(l => l.phase === 'recover').length).toBeGreaterThan(0);
        expect(log.at(-1)).toMatchObject({ phase: 'recover', threats: 0, rested: true });
        expect(rests.length).toBeGreaterThan(0);
    });

    test('so with the setting off it never would: its target stays a threat, and the fight stays the pet\'s alone', async () => {
        const { log, sent, rests } = await walkOff({ pet: { strayFightsOff: false } });
        expect(sent).toEqual([]);
        expect(log.at(-1)).toMatchObject({ phase: 'recover', threats: 1, rested: false, petOn: ENEMY });
        expect(rests).toEqual([]);
    });
});

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
                expect(decidePack(ctx(picture(team(), fiveAt(13_000)), { memory: { raidEnd: 5000 }, now: 6000 })).reason).toContain('stalk');
    });

    test('hurt and attacked: walks off to rest', () => {
        const m: any = {};
        const u = decidePack(ctx(picture(team({ Menta: { mana: 10 }, Encha: { mana: 10 } }), [foe(101, 11_000, 10_000, { target: 'Tank' }), foe(102, 11_100), foe(103, 11_200)]), { memory: m }));
        expect(u.phase).toBe('travel');
        expect(m.pack).toBe('leave');
    });
});

describe('decidePack: resting', () => {
    test('low on power it rests where it stands, and stays resting until ready, whatever comes into sight', () => {
        const m: any = {};
        expect(decidePack(ctx(picture(team({ Menta: { mana: 10 }, Encha: { mana: 10 } }), [foe(101, 14_000)]), { memory: m })).phase).toBe('recover');
        expect(m.resting).toBe(true);
        // Above the low mark but not ready: still resting, with two stragglers in sight that would otherwise be prey.
        expect(decidePack(ctx(picture(team({ Menta: { mana: 40 } }), [foe(101, 14_000), foe(102, 14_200)]), { memory: m })).phase).toBe('recover');
        // Ready again: back to the hunt.
        expect(decidePack(ctx(picture(team({ Menta: { mana: 90 } }), [foe(101, 14_000)]), { memory: m })).reason).toContain('hunt');
        expect(m.resting).toBe(false);
    });

    test('enemies near: it moves off first; on us: it leaves', () => {
        expect(decidePack(ctx(picture(team({ Menta: { mana: 10 }, Encha: { mana: 10 } }), [foe(101, 12_000)]))).reason).toContain('moving off');
        const m: any = {};
        decidePack(ctx(picture(team({ Menta: { mana: 10 }, Encha: { mana: 10 } }), [foe(101, 11_000)]), { memory: m }));
        expect(m.pack).toBe('leave');
    });
});

describe('decidePack: who makes it rest', () => {
    const hunting = (over: Partial<Record<string, Partial<MemberReport>>>) => { const m: any = {}; decidePack(ctx(picture(team(over), [foe(101, 14_000)]), { memory: m })); return !!m.resting; };

    test('not one nuker low; the Druid, the Bard, two nukers or anyone badly hurt', () => {
        expect(hunting({ Menta: { mana: 10 } })).toBe(false);
        expect(hunting({ Druid: { mana: 10 } })).toBe(true);
        expect(hunting({ Bard: { mana: 10 } })).toBe(true);
        expect(hunting({ Menta: { mana: 10 }, Encha: { mana: 10 } })).toBe(true);
        expect(hunting({ Tank: { hp: 30 } })).toBe(true);
    });
});

describe('decidePack: a focus being healed', () => {
    test('is given up for the next, and comes back after a while', () => {
        const m: any = { pack: 'kill', killAt: 0 };
        const two = (hp: number) => [foe(101, 11_000, 10_000, { hp }), foe(102, 11_100), foe(103, 13_900)];
        expect(decidePack(ctx(picture(team(), two(20)), { memory: m, orders: { focus: 101 }, now: 500 })).focus).toBe(101);
        expect(decidePack(ctx(picture(team(), two(45)), { memory: m, orders: { focus: 101 }, now: 1000 })).focus).toBe(101);
        expect(decidePack(ctx(picture(team(), two(60)), { memory: m, orders: { focus: 101 }, now: 1500 })).focus).toBe(102);
        expect(decidePack(ctx(picture(team(), two(60)), { memory: m, orders: { focus: 102 }, now: 2000 })).focus).toBe(102);
        m.killAt = 16_000;
        expect(decidePack(ctx(picture(team(), [foe(101, 11_000, 10_000, { hp: 60 })]), { memory: m, orders: { focus: 102 }, now: 17_000 })).focus).toBe(101);
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
        expect(hurt.reason).toContain('resting');
        expect(hurt.phase).toBe('recover');
        const three = decidePack(ctx(picture(team(), [foe(101, 13_000), foe(102, 13_200), foe(103, 13_400)])));
        expect(three.reason).toContain('stalk');
    });
});

describe('decidePack: raid, pull back, kill, leave', () => {
    const raid = (over: object = {}) => ({ pack: 'raid', raidAt: 1000, packAnchor: { x: 10_000, y: 10_000, z: 0 }, ...over });

    test('parked just outside the opening distance from enemies that stand still: opens after idleMs', () => {
        const m: any = { pack: 'stalk' };
        const pic = picture(team(), fiveAt(BASE.x + 1360));
        expect(decidePack(ctx(pic, { memory: m, now: 1000 })).phase).toBe('travel');
        expect(decidePack(ctx(pic, { memory: m, now: 1000 + PACK_SETTINGS.pack.idleMs })).phase).toBe('engage');
    });

    test('a stalk aims inside the opening distance', () => {
        const u = decidePack(ctx(picture(team(), fiveAt(BASE.x + 2500)), { memory: { pack: 'stalk' } }));
        expect(distTo(u.anchor!, { x: BASE.x + 2500, y: BASE.y })).toBeLessThanOrEqual(PACK_SETTINGS.pack.openAt);
    });

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
        const b = packCc([near, { ...far, ccImmune: { mezz: Date.now() + 60_000 } }], [m('Bard', 'support')], [], opts);
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

describe('standStepTo', () => {
    const me = { x: 0, y: 0 };
    test('steps just far enough, not when too far or onto an enemy', () => {
        const f = { x: 1700, y: 0, distance: 1700 };
        expect(standStepTo(me, f, 1500, 500, [])!.x).toBeCloseTo(300);
        expect(standStepTo(me, { x: 2500, y: 0, distance: 2500 }, 1500, 500, [])).toBeNull();
        expect(standStepTo(me, f, 1500, 0, [])).toBeNull();
        expect(standStepTo(me, f, 1500, 500, [enemy(1, 'midgard', { x: 500, y: 100 })])).toBeNull();
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

describe('spokedPatrol', () => {
    const T = 252, meet = { x: 34_000, y: 32_000 };
    const ring = defaultPatrol(T, 'hibernia', 24);
    const loop = spokedPatrol(T, 'hibernia', 24, 11_000);

    test('adds one detour per enemy realm and comes back to the waypoint it left', () => {
        expect(loop.length).toBe(ring.length + 4);
        const far = loop.map((w, i) => ({ w, i })).filter(({ w }) => distTo(w, meet) > 7000);
        expect(far.length).toBe(2);
        for (const { i } of far) expect(loop[i - 1]).toEqual(loop[i + 1]!);
    });

    test('heads for the enemy homes, not its own', () => {
        const far = loop.filter(w => distTo(w, meet) > 7000);
        expect(far.some(w => w.y > 40_000)).toBe(true);
        expect(far.some(w => w.x > 42_000)).toBe(true);
        expect(far.some(w => w.x < 28_000 && w.y < 26_000)).toBe(false);
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
