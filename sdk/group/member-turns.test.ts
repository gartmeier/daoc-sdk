// A whole member on a FakeWorld: the real BotSDK and BotActions, the real Blackboard and MemberAgent with petControl on its side tick, the real behaviours and spell rows.
// What these say goes across the turn, the side tick and the actions under them, so that a rule in one can't pass alone and be undone by another. Region 1 has no keeps.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { BotActions, getNavmeshStore, type NavmeshStore } from '../actions';
import { setDefaultPathProvider, StraightLinePathProvider } from '../pathfinding';
import { FakeWorld } from '../test/fake-world';
import { makeNpc, makePlayer, makePlayerObj } from '../test/fixtures';
import type { BotWorldState, NearbyNpc, NearbyPlayer, PetState } from '../types';
import { assist, crowdControl, meleeFight } from './behaviors';
import { Blackboard } from './blackboard';
import { MemberAgent, type Behavior } from './member';
import { petControl, summonPet } from './pets';
import { RVR_SETTINGS } from './rvr';
import type { OrdersUpdate, Role } from './types';

let navmeshAt: Mock<NavmeshStore['at']>;
beforeAll(() => {
    setDefaultPathProvider(new StraightLinePathProvider());
    navmeshAt = spyOn(getNavmeshStore(), 'at').mockReturnValue(null);
});
afterAll(() => {
    setDefaultPathProvider(null);
    navmeshAt.mockRestore();
});

const ME = { x: 560_000, y: 511_000, z: 2500 };
const ANCHOR = { ...ME };
const PET = 600;
const petWindow = (o: Partial<PetState> = {}): PetState => ({ objectId: PET, name: 'spirit soldier', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null, ...o });
const petNpc = () => makeNpc({ objectId: PET, name: 'spirit soldier', level: 20, realm: 'albion', isPet: true, x: ME.x + 50, y: ME.y });
const foe = (objectId: number, dx: number, o: Partial<NearbyPlayer> = {}) => makePlayerObj({ objectId, name: 'Celt', level: 20, realm: 'hibernia', x: ME.x + dx, y: ME.y, z: ME.z, ...o });
const mob = (objectId: number, dx: number, o: Partial<NearbyNpc> = {}) => makeNpc({ objectId, name: 'young wolf', level: 20, x: ME.x + dx, y: ME.y, z: ME.z, ...o });
/** A spell by its real row. */
const spell = (name: string, internalId: number, spellIndex = 0) => ({ name, level: 20, internalId, lineName: 'Line', lineIndex: 0, spellIndex, cooldownRemaining: 0 });
const MEZZ = spell('Minor Mesmerization', 911);
const SUMMON = spell('Amber Simulacrum', 801);

type Orders = Omit<OrdersUpdate, 'reason'>;

let running: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const end of running) await end();
    running = [];
});

function member(o: { list: Behavior<any>[]; role?: Role; world?: Partial<BotWorldState>; player?: object; settings?: object; orders?: Orders; spells?: ReturnType<typeof spell>[] }) {
    const w = new FakeWorld({
        pet: petWindow(), nearbyObjects: [], nearbyPlayers: [], nearbyNpcs: [petNpc()], effects: [], combatEvents: [],
        player: makePlayer({ level: 20, mana: 500, maxMana: 500, manaPercent: 100, healthPercent: 100, health: 100, maxHealth: 100, ...o.player }),
        skills: { specializations: [], abilities: [], styles: [], spells: o.spells ?? [] },
        equipment: [{ slot: 10, name: 'sword', level: 1, count: 1, model: 3, objectType: 3, condition: 100, durability: 100, quality: 85, weight: 30, value1: 12, value2: 37, hand: 0 }],
        ...o.world,
    });
    w.stepSize = 5;
    const stamp = w.onTick;
    w.onTick = world => { world.state.timestamp = Date.now(); stamp?.(world); };
    const bot = new BotActions(w.sdk);
    const board = new Blackboard();
    const agent = new MemberAgent({ bot: 'testbot', role: o.role ?? 'nuker', sdk: w.sdk, actions: bot }, board, o.list, { ...RVR_SETTINGS, ...o.settings }, { minTurnMs: 10, idleMs: 10, failedTurnMs: 50, sideTickMs: 20, sightRadius: 40_000 });
    const order = (u: Orders) => { board.setOrders({ reason: 'test', ...u }); };
    if (o.orders) order(o.orders);
    const stop = new AbortController();
    const run = agent.run(stop.signal).catch(() => {});
    running.push(async () => { stop.abort(new Error('test over')); await run; agent.dispose(); w.dispose(); });
    return {
        w, bot, board, agent, order,
        attacks: () => w.sentOf('petCommand').filter(a => a.command === 'attack').map(a => a.targetObjectId),
        stances: () => w.sentOf('petCommand').map(a => a.command).filter(c => c === 'passive' || c === 'defensive'),
        activity: () => board.picture().members[0]?.activity.kind,
        results: () => board.events().filter(e => e.kind === 'result').map(e => e.text),
    };
}

/** Run a line of a turn until `check` holds, or fail at `ms`. */
async function until(check: () => boolean, ms = 1500): Promise<void> {
    const t0 = Date.now();
    while (!check() && Date.now() - t0 < ms) await Bun.sleep(5);
}

describe('crowd control walks in steps, announced as a walk', () => {
    const FOCUS = 410, ADD = 412;
    // r8on, Rbspi: '+2 focus 416 dist 2170 turn cc 419 Hold Spirit pet->None', '+4 dist 1926', '+13 dist 831', '+17 dist 974 turn cc 419 Hold Spirit pet->416'.
    const engaged: Orders = { phase: 'engage', focus: FOCUS, cc: [{ targetId: ADD, by: 'Testbot' }], anchor: ANCHOR };
    const roam = (add = 1900, o: { pet?: Partial<PetState> } = {}) => member({
        list: [crowdControl({ assignedOnly: true }), petControl()], spells: [MEZZ], orders: engaged,
        world: { nearbyPlayers: [foe(FOCUS, 900), foe(ADD, add)], pet: petWindow(o.pet) },
    });

    test('the pet\'s order goes during the walk: first order +19 to +25 s in a roam, +0.3 s in the pack', async () => {
        const m = roam();
        await until(() => m.attacks().length > 0, 600);
        expect(m.attacks()).toEqual([FOCUS]);
        expect(m.w.state.movement.moving).toBe(true);
        expect(m.activity()).toBe('move');
        expect(m.w.sentOf('castSpell')).toEqual([]);
    });

    test('it casts where it got to, with no approach, and announces cc only then', async () => {
        const m = roam(1550);
        m.w.stepSize = 30;
        await until(() => m.w.sentOf('castSpell').length > 0);
        expect(m.w.sentOf('castSpell').length).toBe(1);
        expect(m.activity()).toBe('cc');
        expect(m.w.player.targetObjectId).toBe(ADD);
        expect(m.w.state.movement.moving).toBe(false);
    });

    test('a walk of more than 2.5 s goes in steps, with the list read in between: "a dropped assignment drops the cast"', async () => {
        let turns = 0;
        const m = member({
            list: [{ name: 'above', run() { turns++; return false; } }, crowdControl({ assignedOnly: true })], spells: [MEZZ], orders: engaged,
            world: { nearbyPlayers: [foe(FOCUS, 900), foe(ADD, 30_000)] },
        });
        m.w.stepSize = 2;
        await Bun.sleep(200);
        const inFirst = turns;
        expect(m.w.sentOf('moveTo').length).toBe(1);
        await until(() => m.w.sentOf('moveTo').length >= 2, 3500);
        expect(turns).toBeGreaterThan(inFirst);
        expect(m.w.sentOf('moveTo').length).toBeGreaterThanOrEqual(2);
        expect(m.results().filter(r => r.startsWith('walk'))).toEqual([]);
    }, 6000);

    test('an assignment dropped on the way drops the cast: "`00:14 Celt died`, `You begin casting a Sedate spell!` +21.1", onto the new focus', async () => {
        const m = roam(1700);
        m.w.stepSize = 10;
        await until(() => m.w.state.movement.moving);
        m.order({ cc: [] });
        await until(() => !m.w.state.movement.moving);
        await Bun.sleep(150);
        expect(m.w.sentOf('castSpell')).toEqual([]);
        // Nor onto the same target as the focus now.
        m.order({ focus: ADD });
        await Bun.sleep(100);
        expect(m.w.sentOf('castSpell')).toEqual([]);
    });

    describe('read again at the cast, as the sends before it take a moment', () => {
        const onAdd = { pet: { targetObjectId: ADD } };

        test('the orders: its assignment gone in the call-off of its own pet, no cast', async () => {
            const m = roam(1000, onAdd);
            const real = m.w.handlers.petCommand;
            m.w.handlers.petCommand = (a, world) => { if (a.type === 'petCommand' && a.command === 'follow') m.order({ cc: [] }); return real?.(a, world); };
            await until(() => m.w.sentOf('petCommand').some(a => a.command === 'follow'));
            await Bun.sleep(100);
            expect(m.w.sentOf('castSpell')).toEqual([]);
        });

        test('its reach: gone out of range in that moment, a step and not a cast at it', async () => {
            const m = roam(1000, onAdd);
            m.w.handlers.petCommand = (a, world) => {
                if (a.type === 'petCommand' && a.command === 'follow') { world.state.nearbyPlayers.find(p => p.objectId === ADD)!.x = ME.x + 4000; world.publish(); }
            };
            await until(() => m.w.sentOf('moveTo').length > 0);
            expect(m.w.sentOf('castSpell')).toEqual([]);
            expect(m.activity()).toBe('move');
        });
    });
});

describe('crowd control behind a cast the server runs on', () => {
    // The hold (castHeld) was inside castSpell, after crowdControl's read: focus dead mid-nuke, the read true, 2 s of wait, the assignment gone in them, and the mezz at the new focus.
    const FOCUS = 410, ADD = 412;
    const NUKE = spell('Murk Blast', 2508, 0);
    const MEZZ2 = spell('Minor Mesmerization', 911, 1);
    const nuking = async () => {
        const m = member({
            list: [crowdControl({ assignedOnly: true }), assist()], spells: [NUKE, MEZZ2], orders: { phase: 'engage', focus: FOCUS, cc: [], anchor: ANCHOR },
            world: { pet: null, nearbyNpcs: [], nearbyPlayers: [foe(FOCUS, 900), foe(ADD, 900)] },
        });
        m.w.handlers.castSpell = (a, world) => {
            if (a.type !== 'castSpell') return;
            const ms = a.spellIndex === 0 ? 1500 : 100;
            const name = a.spellIndex === 0 ? NUKE.name : MEZZ2.name;
            setTimeout(() => {
                world.message(`You begin casting a ${name} spell!`, { type: 'spell' });
                world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: ms });
                if (a.spellIndex !== 0) setTimeout(() => world.message(`You cast a ${name} spell!`, { type: 'spell' }), ms + 10);
            }, 5);
        };
        await until(() => m.w.sentOf('castSpell').length > 0);
        await Bun.sleep(100);
        m.order({ cc: [{ targetId: ADD, by: 'Testbot' }] });
        await Bun.sleep(100);
        m.w.state.nearbyPlayers = m.w.state.nearbyPlayers.filter(p => p.objectId !== FOCUS);
        m.w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: FOCUS, targetHealthPercent: 0 });
        return m;
    };
    const mezzes = (m: ReturnType<typeof member>) => m.w.sentOf('castSpell').filter(a => a.spellIndex === 1);

    test('the assignment gone meanwhile: no cast at what is the focus now', async () => {
        const m = await nuking();
        await Bun.sleep(150);
        m.order({ focus: ADD, cc: [] });
        await Bun.sleep(1500);
        expect(mezzes(m)).toEqual([]);
    });

    test('and no \'cc\' until the cast goes: an order of our pet\'s isn\'t held by what may not be ours', async () => {
        const m = await nuking();
        await Bun.sleep(150);
        expect(m.activity()).not.toBe('cc');
        expect(mezzes(m)).toEqual([]);
    });

    test('still ours at its end: it goes then, and not before', async () => {
        const m = await nuking();
        await Bun.sleep(300);
        expect(mezzes(m)).toEqual([]);
        await until(() => mezzes(m).length > 0, 2000);
        expect(mezzes(m).length).toBe(1);
        expect(m.w.player.targetObjectId).toBe(ADD);
    });
});

describe('crowd control with no pet to order: the walk and the cast one turn, as ever', () => {
    const FOCUS = 410, ADD = 412;
    const engaged: Orders = { phase: 'engage', focus: FOCUS, cc: [{ targetId: ADD, by: 'Testbot' }], anchor: ANCHOR };
    const walking = (o: { world?: Partial<BotWorldState>; settings?: object }) => {
        const m = member({ list: [crowdControl({ assignedOnly: true })], spells: [MEZZ], orders: engaged, settings: o.settings, world: { nearbyPlayers: [foe(FOCUS, 900), foe(ADD, 1700)], ...o.world } });
        m.w.stepSize = 10;
        return m;
    };

    const cases: [string, Parameters<typeof walking>[0]][] = [['none in the window', { world: { pet: null, nearbyNpcs: [] } }], ['pets off', { settings: { pet: { enabled: false } } }]];
    for (const [why, o] of cases) {
        test(`${why}: announced as cc, and it casts at the end of it, whatever the orders did meanwhile`, async () => {
            const m = walking(o);
            await until(() => m.w.state.movement.moving);
            expect(m.activity()).toBe('cc');
            m.order({ cc: [] });
            await until(() => m.w.sentOf('castSpell').length > 0);
            expect(m.w.sentOf('castSpell').length).toBe(1);
            expect(m.w.player.targetObjectId).toBe(ADD);
        });
    }
});

describe('a cc walk getting nowhere', () => {
    const FOCUS = 410, ADD = 412;
    // A step's own timeout is no failure (reportLeg), and it comes before route's 8 s: main logged 'cc: stuck' every 8 s of a root, this nothing.
    test('it says so, as one long walk did, and goes on trying', async () => {
        const m = member({
            list: [crowdControl({ assignedOnly: true })], spells: [MEZZ], orders: { phase: 'engage', focus: FOCUS, cc: [{ targetId: ADD, by: 'Testbot' }], anchor: ANCHOR },
            world: { nearbyPlayers: [foe(FOCUS, 900), foe(ADD, 3000)] },
        });
        m.w.stepSize = 0;
        await until(() => m.results().length > 0, 11_500);
        expect(m.results()[0]).toContain('cc: stuck');
        expect(m.results()[0]).toContain('Cannot reach');
        expect(m.w.sentOf('castSpell')).toEqual([]);
    }, 14_000);

    test('walking, however slowly, it doesn\'t', async () => {
        const m = member({
            list: [crowdControl({ assignedOnly: true })], spells: [MEZZ], orders: { phase: 'engage', focus: FOCUS, cc: [{ targetId: ADD, by: 'Testbot' }], anchor: ANCHOR },
            world: { nearbyPlayers: [foe(FOCUS, 900), foe(ADD, 30_000)] },
        });
        m.w.stepSize = 1;
        await Bun.sleep(5500);
        expect(m.results()).toEqual([]);
    }, 8000);
});

describe('out of the world in the middle of a melee turn', () => {
    const CELT = 415;
    // A stop reads `me` (beyondLeash, keepCircles) in a bare timer: "null is not an object (evaluating 'me.regionId')" four times a second, past every catch. Under MCP, with no top-level await pending, that ends the server.
    test('a relog during attack\'s wait: nothing thrown past the member', async () => {
        const thrown: unknown[] = [];
        const seen = (e: unknown) => { thrown.push(e); };
        process.on('uncaughtException', seen);
        try {
            const m = member({ role: 'melee', list: [meleeFight()], settings: { chaseLeash: 2000 }, orders: { phase: 'engage', focus: CELT, cc: [], anchor: ANCHOR }, world: { nearbyPlayers: [foe(CELT, 90)], nearbyNpcs: [petNpc()] } });
            m.w.handlers.attack = () => {};
            await until(() => m.w.sentOf('attack').some(a => a.on));
            m.w.state.player = null;
            m.w.state.inGame = false;
            await Bun.sleep(700);
            expect(thrown).toEqual([]);
            expect(m.board.events().filter(e => e.text?.includes('threw'))).toEqual([]);
        } finally {
            process.off('uncaughtException', seen);
        }
    });
});

describe('a melee member\'s stand-in under a keep\'s guards', () => {
    // Thidranki, the Hibernia portal keep: its circle at 4500 from (18362, 18257). The stand-in was picked by the leash alone and dropped by the walk's check every 250 ms: 'moveTo 25 stop 24', and into the circle (rvr.md: tank and melee never follow a player into one).
    const KEEP = { x: 18_362, y: 18_257 };
    const HERE = { x: KEEP.x + 4800, y: KEEP.y, z: 4320, regionId: 252, realm: 'albion' as const };
    const FOCUS = 415, UNDER = 416, CLEAR = 417;
    const at = (objectId: number, x: number) => makePlayerObj({ objectId, name: 'Celt', level: 20, realm: 'hibernia', x, y: HERE.y, z: HERE.z });
    const fight = (near: ReturnType<typeof at>[]) => {
        const m = member({
            role: 'melee', list: [meleeFight()], player: { ...HERE, objectId: 100 }, settings: { chaseLeash: 2000 },
            orders: { phase: 'engage', focus: FOCUS, cc: [], anchor: HERE },
            world: { pet: null, nearbyNpcs: [], nearbyPlayers: [at(FOCUS, HERE.x + 2600), ...near] },
        });
        const hits = setInterval(() => { for (const n of near) m.w.combat({ kind: 'melee', attackerObjectId: n.objectId, targetObjectId: 100, result: 'hit' }); }, 50);
        running.push(async () => clearInterval(hits));
        return m;
    };

    test('it isn\'t one: no walk, no swing', async () => {
        const m = fight([at(UNDER, KEEP.x + 4400)]);
        await until(() => !!m.board.picture().contacts.find(c => c.objectId === UNDER)?.threat);
        await Bun.sleep(400);
        expect(m.w.sentOf('moveTo')).toEqual([]);
        expect(m.w.sentOf('attack')).toEqual([]);
    });

    test('one clear of them, farther off, is', async () => {
        const m = fight([at(UNDER, KEEP.x + 4400), at(CLEAR, HERE.x + 1000)]);
        await until(() => m.w.sentOf('moveTo').length > 0, 800);
        expect(m.w.sentOf('moveTo')[0]!.x).toBeGreaterThan(HERE.x);
    });
});

describe('a melee member\'s chase ends where the tank\'s does', () => {
    const CELT = 415, TURRET = 500;
    // Run 20261104-045536: focus on the turret at +15.7; Rehun on after Celt, 3800 from the anchor at +33.8; the pet's next order +41.1; first swing at the turret +52.2.
    const chase = (o: { world?: Partial<BotWorldState>; orders?: Orders; runner?: number; speed?: number } = {}) => {
        const m = member({
            role: 'melee', list: [meleeFight(), petControl()], settings: { chaseLeash: 2000 },
            orders: o.orders ?? { phase: 'engage', focus: CELT, cc: [], anchor: ANCHOR },
            world: { nearbyPlayers: [foe(CELT, 1000)], nearbyNpcs: [petNpc(), mob(TURRET, 400, { name: 'cloudsong', realm: 'hibernia', isPet: true })], ...o.world },
        });
        const stamp = m.w.onTick;
        // It outruns us.
        m.w.onTick = world => { stamp?.(world); const c = world.state.nearbyPlayers.find(p => p.objectId === (o.runner ?? CELT)); if (c) c.x += o.speed ?? 3; };
        return m;
    };

    test('the focus moves: the walk ends and the pet\'s order goes, within a turn of it', async () => {
        const m = chase();
        await until(() => m.w.state.movement.moving);
        expect(m.attacks().length).toBeGreaterThan(0);
        const before = m.attacks().length;
        const moved = Date.now();
        m.order({ focus: TURRET });
        await until(() => m.attacks().length > before);
        expect(m.attacks().at(-1)).toBe(TURRET);
        expect(Date.now() - moved).toBeLessThan(1000);
        expect(m.w.player.targetObjectId === CELT).toBe(false);
    });

    test('it runs beyond the leash: the walk ends, and nobody goes on after it', async () => {
        const m = chase({ speed: 12 });
        m.w.stepSize = 2;
        await until(() => m.w.state.nearbyPlayers[0]!.x - ANCHOR.x > 2000);
        await until(() => m.w.sentOf('stop').length > 0, 800);
        expect(m.w.sentOf('stop').length).toBeGreaterThan(0);
        expect(m.w.state.movement.moving).toBe(false);
        const moves = m.w.sentOf('moveTo').length;
        await Bun.sleep(150);
        expect(m.w.sentOf('moveTo').length).toBe(moves);
        expect(m.results().filter(r => r.startsWith('melee'))).toEqual([]);
    });

    test('a stand-in for a focus beyond the leash gives way as the focus comes back, as the tank\'s does', async () => {
        const STAND_IN = 416;
        const m = chase({
            runner: STAND_IN,
            world: { nearbyPlayers: [foe(CELT, 2600), foe(STAND_IN, 900)] },
        });
        // The stand-in has to be on us to be taken for one.
        const hits = setInterval(() => m.w.combat({ kind: 'melee', attackerObjectId: STAND_IN, targetObjectId: 100, result: 'hit' }), 100);
        await until(() => m.w.state.movement.moving);
        const toward = m.w.sentOf('moveTo').at(-1)!;
        expect(toward.x).toBeLessThan(ME.x + 2000);
        m.w.state.nearbyPlayers.find(p => p.objectId === CELT)!.x = ME.x + 500;
        await until(() => m.w.player.targetObjectId === CELT, 1000);
        clearInterval(hits);
        expect(m.w.player.targetObjectId).toBe(CELT);
    });

    test('a walk with a swing still on the last target: off first, as it hits nothing from here and holds the order', async () => {
        const m = member({
            role: 'melee', list: [meleeFight(), petControl()], settings: { chaseLeash: 2000 },
            player: { attacking: true, targetObjectId: CELT },
            orders: { phase: 'engage', focus: TURRET, cc: [], anchor: ANCHOR },
            world: { nearbyPlayers: [foe(CELT, 100)], nearbyNpcs: [petNpc(), mob(TURRET, 1500, { name: 'cloudsong', realm: 'hibernia', isPet: true })] },
        });
        await until(() => m.w.sentOf('attack').some(a => !a.on));
        await until(() => m.attacks().length > 0);
        expect(m.attacks()).toEqual([TURRET]);
    });
});

describe('a swing left on a corpse', () => {
    const RETHE = 415, SERVANT = 500;
    // 20261104-044005: Rethe dead +10.6, focus on the servant +10.7. `Rethe is already dead!` +11.6, +13.4 and on, atk:true, tgt:Briton#415. Rebon's order +11.6, Rehun's +19.7, at his first hit on the servant.
    const servant = () => mob(SERVANT, 1500, { name: 'bone servant', realm: 'hibernia', isPet: true });
    const onServant: Orders = { phase: 'engage', focus: SERVANT, cc: [], anchor: ANCHOR };

    test('it holds no order: attacking a dead target is free', async () => {
        const m = member({
            list: [petControl()], player: { attacking: true, targetObjectId: RETHE }, orders: onServant,
            world: { nearbyPlayers: [foe(RETHE, 100, { isDead: true, healthPercent: 0 })], nearbyNpcs: [petNpc(), servant()] },
        });
        await until(() => m.attacks().length > 0, 400);
        expect(m.attacks()).toEqual([SERVANT]);
    });

    test('nor one that is gone from the world', async () => {
        const m = member({ list: [petControl()], player: { attacking: true, targetObjectId: RETHE }, orders: onServant, world: { nearbyNpcs: [petNpc(), servant()] } });
        await until(() => m.attacks().length > 0, 400);
        expect(m.attacks()).toEqual([SERVANT]);
    });

    test('a swing at the living still holds it', async () => {
        const m = member({
            list: [petControl()], player: { attacking: true, targetObjectId: RETHE }, orders: onServant,
            world: { nearbyPlayers: [foe(RETHE, 100)], nearbyNpcs: [petNpc(), servant()] },
        });
        await Bun.sleep(150);
        expect(m.attacks()).toEqual([]);
    });

    test('attack reads the line, the swing goes off, and it is no failure of the member\'s: the fight went well', async () => {
        const m = member({ role: 'melee', list: [meleeFight()], settings: { chaseLeash: 2000 }, orders: { phase: 'engage', focus: RETHE, cc: [], anchor: ANCHOR }, world: { nearbyPlayers: [foe(RETHE, 60)], nearbyNpcs: [petNpc()] } });
        m.w.handlers.attack = (a, world) => {
            if (a.type !== 'attack') return;
            world.player.attacking = a.on;
            if (a.on) { world.message('You enter combat mode and target [Rethe]'); setTimeout(() => world.message('Rethe is already dead!'), 15); }
        };
        await until(() => m.w.sentOf('attack').some(a => !a.on));
        expect(m.w.player.attacking).toBe(false);
        expect(m.results()).toEqual([]);
    });

    describe('assist\'s skips leave no swing on', () => {
        const swinging = { attacking: true, targetObjectId: RETHE };
        const left = async (m: ReturnType<typeof member>) => { await until(() => m.w.sentOf('attack').some(a => !a.on), 300); return m.w.player.attacking; };

        test('the focus just died', async () => {
            const m = member({ role: 'melee', list: [meleeFight()], player: swinging, orders: { phase: 'engage', focus: RETHE, cc: [], anchor: ANCHOR }, world: { nearbyPlayers: [foe(RETHE, 100, { isDead: true, healthPercent: 0 })], nearbyNpcs: [petNpc()] } });
            expect(await left(m)).toBe(false);
        });

        test('the focus is gone from the board', async () => {
            const m = member({ role: 'melee', list: [meleeFight()], player: swinging, orders: { phase: 'engage', focus: 999, cc: [], anchor: ANCHOR }, world: { nearbyPlayers: [foe(RETHE, 100)], nearbyNpcs: [petNpc()] } });
            expect(await left(m)).toBe(false);
        });

        test('a mezz on the focus: any swing breaks one, a miss too', async () => {
            const m = member({ role: 'melee', list: [meleeFight()], player: swinging, orders: { phase: 'engage', focus: RETHE, cc: [], anchor: ANCHOR }, world: { nearbyPlayers: [foe(RETHE, 100)], nearbyNpcs: [petNpc()] } });
            m.board.markCc(RETHE, 1, 'Bard', 'mezz', 30_000);
            expect(await left(m)).toBe(false);
        });

        test('waiting for the tank to hold it: a swing on that mob stays, one on anything else goes', async () => {
            const list = [assist({ melee: true, holdMs: 60_000 })];
            const tank = (board: Blackboard) => board.publish({ report: { name: 'Tank', bot: 'tank', role: 'tank', className: 'Armsman', level: 20, experience: 0, objectId: 7, regionId: 1, x: ME.x, y: ME.y, z: ME.z, hp: 100, mana: 0, endurance: 100, load: 0, isDead: false, isSitting: false, inCombat: false, attacking: false, targetId: null, effects: [], capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] }, activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, at: Date.now() }, sightings: [], deaths: [] });
            const orders: Orders = { phase: 'engage', focus: 501, cc: [], anchor: ANCHOR };
            const on = member({ role: 'melee', list, settings: { assistAfterMs: 60_000 }, player: { attacking: true, targetObjectId: 501 }, orders, world: { nearbyNpcs: [petNpc(), mob(501, 100)] } });
            tank(on.board);
            await Bun.sleep(120);
            expect(on.w.sentOf('attack').filter(a => !a.on)).toEqual([]);
            const off = member({ role: 'melee', list, settings: { assistAfterMs: 60_000 }, player: { attacking: true, targetObjectId: 502 }, orders, world: { nearbyNpcs: [petNpc(), mob(501, 100), mob(502, 100, { name: 'dead wolf', healthPercent: 0 })] } });
            tank(off.board);
            expect(await left(off)).toBe(false);
        });
    });
});

describe('a summon after a target\'s death', () => {
    // 20261104-045941: `You begin casting a Murk Blast spell!` +19.7, `Rethe was just killed by Rehun` +21.5, `You are already casting a spell! You prepare this spell as a follow up!` +21.7, `00:24 Rebon: summon: no_response`. No pet to the end at +50.
    test('a follow-up reads must_wait and starts no 60 s of summonRetry', async () => {
        const m = member({
            list: [summonPet()], spells: [SUMMON], player: { level: 5 }, orders: { phase: 'recover', focus: null, cc: [], anchor: ANCHOR },
            world: { pet: null, nearbyNpcs: [], combatEvents: [] },
        });
        m.w.combat({ kind: 'spellCast', attackerObjectId: 100, targetObjectId: null, castTimeMs: 1500 });
        m.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You are already casting a spell! You prepare this spell as a follow up!', { type: 'spell' }), 5); };
        await until(() => m.results().length > 0, 3500);
        expect(m.results()[0]).toContain('summon: must_wait');
        const retry = m.agent.ctx.memory.get('summonRetry') - Date.now();
        // The running cast's rest and the summon's own 6 s, and not the 60 s of a failure.
        expect(retry).toBeGreaterThan(5000);
        expect(retry).toBeLessThan(10_000);
    });
});

describe('a defensive pet and a crowd-controlled mob on its owner', () => {
    const ADD = 501, FOCUS = 502;
    const root = (m: ReturnType<typeof member>) => m.board.markCc(ADD, 1, 'Bard', 'root', 30_000);
    // m4: 'to follow you!' 05:01:29.006; owner hit 30.414, same tick pet tgt=24396; 'to follow you!' 31.017. Fight 1: 'Pethun's pet broke the root on lake serpent'.
    test('a rooted add swinging at the owner: passive, or it answers the next hit in ~33 ms and breaks the root', async () => {
        const m = member({ list: [petControl()], orders: { phase: 'engage', focus: null, cc: [], anchor: ANCHOR }, world: { nearbyNpcs: [petNpc(), mob(ADD, 100, { targetObjectId: 100, inCombat: true })] } });
        await until(() => !!m.board.picture().contacts.find(c => c.objectId === ADD));
        root(m);
        await until(() => m.stances().length > 0, 300);
        expect(m.stances()).toEqual(['passive']);
    });

    test('with an order going for the pet: no passive, the order lifts it anyway', async () => {
        const m = member({
            list: [petControl()], orders: { phase: 'engage', focus: FOCUS, cc: [], anchor: ANCHOR },
            world: { nearbyPlayers: [foe(FOCUS, 300)], nearbyNpcs: [petNpc(), mob(ADD, 100, { targetObjectId: 100, inCombat: true })] },
        });
        await until(() => !!m.board.picture().contacts.find(c => c.objectId === ADD));
        root(m);
        await until(() => m.attacks().length > 0, 300);
        expect(m.attacks()).toEqual([FOCUS]);
        expect(m.stances()).toEqual([]);
    });

    test('free, it stays defensive as ever: it should answer that one', async () => {
        const m = member({ list: [petControl()], orders: { phase: 'engage', focus: null, cc: [], anchor: ANCHOR }, world: { nearbyNpcs: [petNpc(), mob(ADD, 100, { targetObjectId: 100, inCombat: true })] } });
        await Bun.sleep(120);
        expect(m.stances()).toEqual([]);
    });
});
