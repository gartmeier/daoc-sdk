// A whole member on a FakeWorld: the real BotSDK and BotActions, the real Blackboard and MemberAgent with petControl on its side tick, the real behaviours and spell rows.
// What these say goes across the turn, the side tick and the actions under them, so that a rule in one can't pass alone and be undone by another. Region 1 has no keeps.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { BotActions, getNavmeshStore, type NavmeshStore } from '../actions';
import { setDefaultPathProvider, StraightLinePathProvider } from '../pathfinding';
import { FakeWorld } from '../test/fake-world';
import { makeNpc, makePlayer, makePlayerObj } from '../test/fixtures';
import type { BotWorldState, NearbyNpc, NearbyPlayer, PetState } from '../types';
import { assist, buff, buffRetryMs, crowdControl, defaultBehaviors, flee, heal, meleeFight, song } from './behaviors';
import { Blackboard } from './blackboard';
import { MEZZED } from './cc';
import { obs, report } from './fixtures';
import { MemberAgent, type Behavior, type MemberAgentOptions } from './member';
import { GroupObserver } from './observer';
import { packBehaviors } from './pack';
import { PET_SETTINGS, petControl, petKit, summonPet, withPets } from './pets';
import { decidePve, PVE_SETTINGS } from './pve';
import { RVR_SETTINGS, rvrBehaviors } from './rvr';
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

function member(o: { list: Behavior<any>[]; role?: Role; world?: Partial<BotWorldState>; player?: object; settings?: object; orders?: Orders; spells?: ReturnType<typeof spell>[]; agent?: MemberAgentOptions }) {
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
    const agent = new MemberAgent({ bot: 'testbot', role: o.role ?? 'nuker', sdk: w.sdk, actions: bot }, board, o.list, { ...RVR_SETTINGS, ...o.settings }, { minTurnMs: 10, idleMs: 10, failedTurnMs: 50, sideTickMs: 20, sightRadius: 40_000, ...o.agent });
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

describe('a focus that dies during attack\'s walk', () => {
    const FOCUS = 501;
    // c4: 'Pethun: melee: not_found (sveawolf mother disappeared)' and 2 more, Failures melee:not_found (3) in 5 kills; c3 1 in 1. Also in live4 (4).
    const walking = () => member({ role: 'melee', list: [meleeFight()], settings: { chaseLeash: 5000 }, orders: { phase: 'engage', focus: FOCUS, cc: [], anchor: ANCHOR }, world: { nearbyNpcs: [petNpc(), mob(FOCUS, 1500)] } });
    const dies = (w: FakeWorld) => {
        w.removeNpc(FOCUS);
        w.combat({ kind: 'death', attackerObjectId: null, targetObjectId: FOCUS, targetHealthPercent: 0 });
    };

    test('it is no failure of the member\'s, and the walk ends with it', async () => {
        const m = walking();
        await until(() => m.w.state.movement.moving);
        expect(m.w.state.movement.moving).toBe(true);
        dies(m.w);
        await until(() => !m.w.state.movement.moving, 500);
        expect(m.w.state.movement.moving).toBe(false);
        await Bun.sleep(100);
        expect(m.results()).toEqual([]);
    });

    test('nor is one gone by the time attack is asked, with the board still naming it', async () => {
        const m = walking();
        await until(() => m.w.state.movement.moving);
        m.w.handlers.moveTo = () => ({ success: false, message: 'no way there', reason: 'no_path' });
        dies(m.w);
        m.order({ phase: 'engage', focus: FOCUS, cc: [], anchor: ANCHOR });
        await Bun.sleep(200);
        expect(m.results().filter(r => r.includes('not_found'))).toEqual([]);
    });
});

describe('a song with no instrument out', () => {
    // r1on Rbbar: 'You are not wielding the right type of instrument!' at 04:35:17, :35, :47, 04:36:01, :15, with `song: no_response` each time; 20261104-050645: song:no_response (13), a try every 3-11 s.
    const ROAD = spell('Clear Road', 5153);
    let clock: { mockRestore: () => void } | null = null;
    afterEach(() => { clock?.mockRestore(); clock = null; });

    test('it reads refused, and the next try waits what the refusal says, not the 10 s of a song just cast', async () => {
        const realNow = Date.now.bind(Date);
        let skew = 0;
        clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
        const m = member({ role: 'support', list: [song()], spells: [ROAD], orders: { phase: 'travel', focus: null, cc: [], anchor: ANCHOR } });
        m.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You are not wielding the right type of instrument!', { type: 'resisted' }), 5); };
        const casts = () => m.w.sentOf('castSpell').length;
        await Bun.sleep(40);
        skew += 20_000; // past the wait for a pulse overdue
        await until(() => casts() > 0, 1500);
        expect(casts()).toBe(1);
        await until(() => m.results().length > 0, 500);
        expect(m.results()[0]).toContain('song: refused');
        expect(m.results()[0]).toContain('Clear Road');
        skew += 11_000;
        await Bun.sleep(80);
        expect(casts()).toBe(1);
        skew += 60_000;
        await until(() => casts() > 1, 500);
        expect(casts()).toBe(2);
    });
});

describe('a long pull-back: the puller\'s pet goes in once the mob has reached him', () => {
    const FOCUS = 700;
    // a2: 'pull lake serpent L11 (con 1) 1354 away' at Pethun hp69. Hits 04:36:12.869 37, 15.885 40, 18.898 35, 21.913 40; 'Pethun: walk: died (Died en route to (718359, 778447))'. Pet 'passive/follow tgt=null' d110 all the way.
    const HOLD = 150;
    const home = { x: ME.x - 1300, y: ME.y, z: ME.z };
    const pulling = (list: Behavior<any>[], o: { dx?: number } = {}) => member({
        role: 'tank', list, settings: { holdMs: HOLD, pet: { ...PET_SETTINGS, holdMs: HOLD } }, orders: { phase: 'pull', focus: FOCUS, puller: 'Testbot', cc: [], anchor: home },
        world: { nearbyNpcs: [petNpc(), mob(FOCUS, o.dx ?? 120, { targetObjectId: 100, inCombat: true })] },
    });
    const swing = (m: ReturnType<typeof member>) => m.w.combat({ kind: 'melee', attackerObjectId: FOCUS, targetObjectId: 100, result: 'hit' });

    test('held back through the walk with nothing on him yet, as ever', async () => {
        const m = pulling([petControl()]);
        await Bun.sleep(HOLD + 150);
        expect(m.stances()).toEqual(['passive']);
        expect(m.attacks()).toEqual([]);
    });

    test('holdMs after its first swing at him the order goes, with the pull still standing', async () => {
        const m = pulling([petControl()]);
        await Bun.sleep(60);
        m.w.state.pet = petWindow({ aggression: 'passive' });
        swing(m);
        await Bun.sleep(HOLD - 90);
        expect(m.attacks()).toEqual([]);
        await until(() => m.attacks().length > 0, HOLD + 200);
        expect(m.attacks()).toEqual([FOCUS]);
    });

    test('on a tank\'s real list, in the middle of pull\'s walk home: the walk isn\'t disturbed', async () => {
        const m = pulling(withPets(defaultBehaviors().tank, { main: true }));
        await until(() => m.w.state.movement.moving);
        expect(m.w.state.movement.moving).toBe(true);
        swing(m);
        await until(() => m.attacks().length > 0, HOLD + 300);
        expect(m.attacks()).toEqual([FOCUS]);
        expect(m.w.state.movement.moving).toBe(true);
    });

    test('someone else\'s pull: its pet is no part of it', async () => {
        const m = member({ list: [petControl()], settings: { holdMs: 0, pet: { ...PET_SETTINGS, holdMs: 0 } }, orders: { phase: 'pull', focus: FOCUS, puller: 'Tank', cc: [], anchor: home }, world: { nearbyNpcs: [petNpc(), mob(FOCUS, 120, { targetObjectId: 100, inCombat: true })] } });
        swing(m);
        await Bun.sleep(150);
        expect(m.attacks()).toEqual([]);
    });

    describe('a pet parked on stay', () => {
        const parkedPull = () => member({
            role: 'tank', list: [petControl()], settings: { holdMs: HOLD, pet: { ...PET_SETTINGS, holdMs: HOLD } }, orders: { phase: 'pull', focus: FOCUS, puller: 'Testbot', cc: [], anchor: home },
            world: { pet: petWindow({ walk: 'stay' }), nearbyNpcs: [petNpc(), mob(FOCUS, 120, { targetObjectId: 100, inCombat: true })] },
        });
        const decide = (m: ReturnType<typeof member>) => {
            const p = m.board.picture();
            const now = Date.now();
            return decidePve({ picture: p, orders: p.orders, memory: { camp: { ...home, zone: '', count: 0, names: 'x' }, campLevel: 20, base: home, pullStart: now - 5000 }, settings: PVE_SETTINGS, now, windingDown: false });
        };

        test('its order, which leaves it on stay (ControlledMobBrain.cs:211-226), ends the pull like any: he walked on being hit with the nukers on the phase', async () => {
            const m = parkedPull();
            await Bun.sleep(40);
            swing(m);
            await until(() => m.attacks().length > 0, HOLD + 400);
            expect(m.attacks()).toEqual([FOCUS]);
            m.w.state.pet = petWindow({ walk: 'stay', targetObjectId: FOCUS });
            m.w.publish();
            await Bun.sleep(40);
            expect(m.board.picture().members[0]!.pet).toMatchObject({ walk: 'stay', targetId: FOCUS, orderedOn: FOCUS });
            expect(decide(m)).toMatchObject({ phase: 'engage', focus: FOCUS, puller: null });
        });

        test('one that answered a blow with no order of ours ends no pull: the walk home goes on', async () => {
            const m = parkedPull();
            await Bun.sleep(30);
            m.w.state.pet = petWindow({ walk: 'stay', targetObjectId: FOCUS });
            m.w.publish();
            await Bun.sleep(30);
            expect(m.attacks()).toEqual([]);
            expect(m.board.picture().members[0]!.pet?.orderedOn).toBeUndefined();
            expect(decide(m).phase).toBe('pull');
        });
    });

    test('a swing from an earlier fight with the mob isn\'t this pull\'s: its pet goes for a new one', async () => {
        const m = member({ role: 'tank', list: [petControl()], settings: { holdMs: HOLD, pet: { ...PET_SETTINGS, holdMs: HOLD } }, orders: { phase: 'recover', focus: null, cc: [], anchor: home }, world: { nearbyNpcs: [petNpc(), mob(FOCUS, 1500)] } });
        await Bun.sleep(40);
        swing(m);
        await Bun.sleep(HOLD + 60);
        m.w.state.pet = petWindow({ aggression: 'passive' });
        m.order({ phase: 'pull', focus: FOCUS, puller: 'Testbot', cc: [], anchor: home });
        await Bun.sleep(120);
        expect(m.attacks()).toEqual([]);
        swing(m);
        await Bun.sleep(HOLD - 90);
        expect(m.attacks()).toEqual([]);
        await until(() => m.attacks().length > 0, HOLD + 200);
        expect(m.attacks()).toEqual([FOCUS]);
    });

    test('the RvR lists have no pull, and decideRvr orders none: this changes nothing there', () => {
        for (const lists of [rvrBehaviors(), packBehaviors()]) for (const list of Object.values(lists)) expect(list.map(b => b.name)).not.toContain('pull');
    });
});

describe('our own root on a lone focus leaves our pet on it', () => {
    const FOCUS = 710, ADD = 711;
    // 20261104-054051: '05:41:08.291 You begin casting a Bonding Vines', '05:41:08.423 to follow you!', pet d=685 by 05:41:08.647; root 05:41:10.757; '05:41:11.257 to kill your target!', first hit 05:41:13.857, 3.1 s after the root. Three times of three, 5-6 s of hits lost each.
    const ROOT = spell('Bonding Vines', 5202);
    const casting = (spells: ReturnType<typeof spell>[], o: { add?: boolean } = {}) => member({
        list: [crowdControl({ assignedOnly: true }), petControl()], spells, orders: { phase: 'engage', focus: FOCUS, cc: [{ targetId: FOCUS, by: 'Testbot' }], anchor: ANCHOR },
        world: { pet: petWindow({ targetObjectId: FOCUS }), nearbyNpcs: [petNpc(), mob(FOCUS, 300, { targetObjectId: PET, inCombat: true }), ...(o.add ? [mob(ADD, 400, { targetObjectId: 100, inCombat: true })] : [])] },
    });
    const off = (m: ReturnType<typeof member>) => m.w.sentOf('petCommand').map(a => a.command).filter(c => c === 'follow' || c === 'passive');

    test('nothing else free: it isn\'t called off, by the cast or by the side tick', async () => {
        const m = casting([ROOT]);
        await until(() => m.w.sentOf('castSpell').length > 0);
        expect(m.w.sentOf('castSpell').length).toBe(1);
        await Bun.sleep(120);
        expect(off(m)).toEqual([]);
    });

    test('something else free: the root still has a job, and the pet comes off', async () => {
        const m = casting([ROOT], { add: true });
        await until(() => off(m).length > 0, 300);
        expect(off(m)).toContain('follow');
    });

    test('a mezz always takes it off: any swing breaks one', async () => {
        const m = casting([MEZZ]);
        await until(() => off(m).length > 0, 300);
        expect(off(m)).toContain('follow');
    });
});

describe('a member too far to buff', () => {
    // Run 20261104-050639: 'ACT petdru: buff Dexterity of the Ferret on Petenc' 05:06:43 and no other activity until the run's end 05:07:49, Petenc 4445 from base. She couldn't heal in that time: buff has interruptible false. Report: 0 kills in 70 s.
    const STR = spell('Blessed Strength', 1451);
    const RANGE = 1000, GATHER = 1200, TANK = 77;
    const buffer = (dx: number) => {
        const m = member({
            role: 'healer', list: [buff()], spells: [STR], settings: { gatherRadius: GATHER }, player: { concentration: 20, maxConcentration: 20 }, orders: { phase: 'idle', focus: null, cc: [], anchor: ME },
            world: { pet: null, nearbyNpcs: [], nearbyPlayers: [makePlayerObj({ objectId: TANK, name: 'Tank', realm: 'albion', x: ME.x + dx, y: ME.y, z: ME.z, distance: dx, distance2d: dx })] },
        });
        m.board.publish(obs(report('Tank', { role: 'tank', objectId: TANK, regionId: 1, x: ME.x + dx, y: ME.y, z: ME.z })));
        return m;
    };

    test('more than gatherRadius beyond the spell\'s range: no walk and no cast, and the turn goes on', async () => {
        const m = buffer(RANGE + GATHER + 50);
        await Bun.sleep(150);
        expect(m.w.sentOf('castSpell')).toEqual([]);
        expect(m.w.state.movement.moving).toBe(false);
        expect(m.activity()).toBe('idle');
    });

    test('within that it walks and casts as ever', async () => {
        const m = buffer(RANGE + 150);
        m.w.stepSize = 60;
        await until(() => m.w.sentOf('castSpell').length > 0, 800);
        expect(m.w.sentOf('castSpell').length).toBe(1);
    });

    test('a walk that gets nowhere has a time limit, and that is a failure of its own, not 66 s of no heals', async () => {
        const realNow = Date.now.bind(Date);
        let skew = 0;
        const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
        try {
            const m = buffer(RANGE + 150);
            m.w.stepSize = 0;
            await until(() => m.w.state.movement.moving);
            expect(m.w.state.movement.moving).toBe(true);
            skew = 16_000;
            await until(() => m.results().some(r => r.startsWith('buff: timeout')), 1500);
            expect(m.results().filter(r => r.startsWith('buff:'))).toMatchObject([expect.stringContaining('buff: timeout')]);
            expect(m.w.sentOf('castSpell')).toEqual([]);
            expect(m.w.state.movement.moving).toBe(false);
        } finally {
            clock.mockRestore();
        }
    });
});

describe('a nuker with no tank under melee', () => {
    // 20261104-044005 Rebon: 'nuke:interrupted (10)', 'nuke:must_wait (2)', 37 s, 'The necroservant attacks you and your spell is interrupted!', then dead. 20261104-045536: 11 interrupted, 00:13-00:53, by the turret.
    const FOCUS = 720;
    const LONG = spell('Ice Cloud (Minor)', 151, 0), INSTANT = spell('Tormenting Cackle', 6531, 1);
    const LINE = 'The necroservant attacks you and your spell is interrupted!';
    const under = (o: { spells?: ReturnType<typeof spell>[]; tank?: boolean | { x?: number; regionId?: number }; dx?: number } = {}) => {
        const m = member({ list: [assist()], spells: o.spells ?? [LONG, INSTANT], orders: { phase: 'engage', focus: FOCUS, cc: [], anchor: ANCHOR }, world: { pet: null, nearbyNpcs: [], nearbyPlayers: [foe(FOCUS, o.dx ?? 300)] } });
        if (o.tank) m.board.publish(obs(report('Tank', { role: 'tank', objectId: 77, regionId: 1, x: ME.x, y: ME.y, z: ME.z, ...(o.tank === true ? {} : o.tank) })));
        m.w.handlers.castSpell = (a, world) => {
            if (a.type !== 'castSpell') return;
            setTimeout(() => {
                if (a.spellIndex === 1) { world.message(`You cast a ${INSTANT.name} spell!`, { type: 'spell' }); return; }
                world.message(`You begin casting a ${LONG.name} spell!`, { type: 'spell' });
                world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 2600 });
                setTimeout(() => {
                    world.message(LINE, { type: 'spell' });
                    world.combat({ kind: 'interrupt', attackerObjectId: world.player.objectId, targetObjectId: null });
                }, 10);
            }, 5);
        };
        return { m, casts: () => m.w.sentOf('castSpell').map(a => a.spellIndex) };
    };

    test('after two in a row by one attacker it takes the instant', async () => {
        const { casts } = under();
        await until(() => casts().length >= 3, 6000);
        expect(casts().slice(0, 3)).toEqual([0, 0, 1]);
    }, 8000);

    test('with a tank to run to it goes on as it did', async () => {
        const { casts } = under({ tank: true });
        await until(() => casts().length >= 3, 6000);
        expect(casts().slice(0, 3)).toEqual([0, 0, 0]);
    }, 8000);

    test('inside the 5000 flee runs within, the tank still counts', async () => {
        const { casts } = under({ tank: { x: ME.x + 3000 } });
        await until(() => casts().length >= 3, 6000);
        expect(casts().slice(0, 3)).toEqual([0, 0, 0]);
    }, 8000);

    // 20261104-052629: 'flee to Petani' 2 s after his respawn, about 9000 off. flee stands aside for him (R9), so he is no tank to run to here either.
    test.each([['released to his bind, 9000 off', { x: ME.x + 9000 }], ['in another region', { regionId: 2 }]])('with the tank %s: what it does with none', async (_what, tank) => {
        const { casts, m } = under({ tank });
        await until(() => casts().length >= 3, 6000);
        expect(casts().slice(0, 3)).toEqual([0, 0, 1]);
        expect(m.w.sentOf('moveTo')).toEqual([]);
    }, 8000);

    test('with an instant out of reach of the focus it doesn\'t walk for it: the long one stands', async () => {
        const { casts, m } = under({ dx: 1200 });
        await until(() => casts().length >= 3, 6000);
        expect(casts().slice(0, 3)).toEqual([0, 0, 0]);
        expect(m.w.sentOf('moveTo')).toEqual([]);
    }, 8000);
});

describe('an instant summon in our own pull', () => {
    const FOCUS = 730;
    // a1: 'Hunter's Pet L7 ... cd 18s' at start, mana 100 %, pull took 18 s, pet first up at the release tick 04:31:05.97. '[pet-down] Pethun had no pet 37% of the run'. Tank died with no pet.
    const HUNTER = spell('Hunter\'s Pet', 3587);
    const home = { x: ME.x - 1300, y: ME.y, z: ME.z };
    const pulling = (spells: ReturnType<typeof spell>[], kit: Parameters<typeof withPets>[1]) => member({
        role: 'tank', list: withPets(defaultBehaviors().tank, kit), spells, orders: { phase: 'pull', focus: FOCUS, puller: 'Testbot', cc: [], anchor: home },
        world: { pet: null, nearbyNpcs: [mob(FOCUS, 120, { targetObjectId: 100, inCombat: true })] },
    });

    test('petKit says so from the spell\'s row', () => {
        const m = member({ list: [], spells: [HUNTER], world: { pet: null, nearbyNpcs: [] } });
        expect(petKit(m.w.sdk, m.bot)).toMatchObject({ main: true, instantSummon: true });
        const n = member({ list: [], spells: [SUMMON], world: { pet: null, nearbyNpcs: [] } });
        expect(petKit(n.w.sdk, n.bot)).not.toHaveProperty('instantSummon');
    });

    test('it goes, with the mob on him, on a tank\'s real list: above pull, which takes every turn', async () => {
        const m = pulling([HUNTER], { main: true, instantSummon: true });
        await until(() => m.w.sentOf('castSpell').length > 0, 1500);
        expect(m.w.sentOf('castSpell').length).toBe(1);
    });

    test('one with a cast time doesn\'t: it would stand him still, with the mob on him', async () => {
        const m = pulling([SUMMON], { main: true });
        await until(() => m.w.state.movement.moving);
        await Bun.sleep(100);
        expect(m.w.sentOf('castSpell')).toEqual([]);
    });

    test('on its recast the walk goes on, and it goes when that is over: the walk hands the turn back', async () => {
        const m = pulling([{ ...HUNTER, cooldownRemaining: 18 }], { main: true, instantSummon: true });
        await until(() => m.w.state.movement.moving);
        expect(m.w.sentOf('castSpell')).toEqual([]);
        await Bun.sleep(100);
        m.w.state.skills = { ...m.w.state.skills, spells: [{ ...HUNTER, cooldownRemaining: 0 }] };
        await until(() => m.w.sentOf('castSpell').length > 0, 1200);
        expect(m.w.sentOf('castSpell').length).toBe(1);
    });

    test('a list with none of this has none of it: a character\'s pet false', async () => {
        const m = pulling([HUNTER], null);
        await until(() => m.w.state.movement.moving);
        await Bun.sleep(700);
        expect(m.w.sentOf('castSpell')).toEqual([]);
        // The walk isn't cut up for a summon nobody will cast.
        expect(m.w.sentOf('moveTo').length).toBe(1);
    });
});

describe('an order on a focus just gone', () => {
    const FOCUS = 740;
    // 20261104-051811: '05:19:13 Petcab: petAttack: unknown_object (unknown objectId 23124)', Failures 'petAttack:unknown_object (1)', with focus 23124 at 1 % at 05:19:13.648.
    const ordering = (answer: { success: false; message: string; reason: string }) => {
        const m = member({ list: [petControl()], orders: { phase: 'engage', focus: FOCUS, cc: [], anchor: ANCHOR }, world: { nearbyPlayers: [foe(FOCUS, 300)] } });
        m.w.handlers.petCommand = () => answer;
        return m;
    };

    test('is no failed petAttack', async () => {
        const m = ordering({ success: false, message: 'unknown objectId 23124', reason: 'unknown_object' });
        await until(() => m.w.sentOf('petCommand').length > 0, 300);
        await Bun.sleep(60);
        expect(m.results()).toEqual([]);
    });

    test('any other refused send still is', async () => {
        const m = ordering({ success: false, message: 'no pet', reason: 'no_pet' });
        await until(() => m.results().length > 0, 300);
        expect(m.results()).toEqual(['petAttack: no_pet (no pet)']);
    });
});

describe('flee with the tank out of the fight\'s reach', () => {
    const ON_ME = 750, TANK = 77;
    // Run 20261104-052629: Petani died 05:28:01.965, respawned 05:28:13 at the bind (about 295553,642168). '05:28:15.285 ACT petenc: flee to Petani', Petenc about (294754,651198), so about 9000 away, for up to the 6 s walk.
    const chased = (dx: number, regionId = 1) => {
        const m = member({ list: [flee()], orders: { phase: 'engage', focus: ON_ME, cc: [], anchor: ANCHOR }, world: { pet: null, nearbyNpcs: [mob(ON_ME, 100, { targetObjectId: 100, inCombat: true })] } });
        m.board.publish(obs(report('Petani', { role: 'tank', objectId: TANK, regionId, x: ME.x + dx, y: ME.y, z: ME.z })));
        return m;
    };

    test('a released one at his bind, 9000 off: no run', async () => {
        const m = chased(9000);
        await Bun.sleep(100);
        expect(m.w.sentOf('moveTo')).toEqual([]);
        expect(m.activity()).not.toBe('flee');
    });

    test('nor to one in another region, whatever his numbers read', async () => {
        const m = chased(1000, 2);
        await Bun.sleep(100);
        expect(m.w.sentOf('moveTo')).toEqual([]);
    });

    test('in reach of the fight it runs as ever', async () => {
        const m = chased(3000);
        await until(() => m.w.sentOf('moveTo').length > 0, 300);
        expect(m.activity()).toBe('flee');
    });
});

describe('a pet\'s health and buffs get their turn on the real lists', () => {
    // Across r1on, r2on, r4on, r6on, r8on: 0 Replenish Spirit, Restore Simulacrum, Reinforce Ally; 0 Valkyrie's Agility, Craftiness; 1 Intensify Spirit. --live: 'Rbcab nuker mana 100% cc Major Crippling Pet: emerald simulacrum L21 9%'.
    const FOCUS = 760, ADD = 761;
    const HEAL = spell('Mend Simulacrum', 821, 1), PET_BUFF = spell('Strengthen Spirit', 811, 1);
    const LISTS: [string, () => Behavior<any>[]][] = [
        ['rvrBehaviors', () => rvrBehaviors().nuker], ['packBehaviors', () => packBehaviors().nuker], ['pveLeveling', () => defaultBehaviors().nuker],
    ];
    const hurt = (list: Behavior<any>[], o: { hp?: number; mana?: number } = {}) => member({
        list: withPets(list, { main: true }), spells: [MEZZ, HEAL], player: { mana: o.mana ?? 500, manaPercent: Math.round((o.mana ?? 500) / 5) },
        orders: { phase: 'engage', focus: FOCUS, cc: [{ targetId: ADD, by: 'Testbot' }], anchor: ANCHOR },
        world: { nearbyPlayers: [foe(FOCUS, 900), foe(ADD, 900)], nearbyNpcs: [{ ...petNpc(), healthPercent: o.hp ?? 9 }] },
    });
    const firstCast = async (m: ReturnType<typeof member>) => {
        await until(() => m.w.sentOf('castSpell').length > 0, 500);
        return m.w.sentOf('castSpell')[0]?.spellIndex;
    };

    for (const [name, list] of LISTS) {
        describe(name, () => {
            test('under 25 % with power to spare: above crowd control', async () => {
                expect(await firstCast(hurt(list()))).toBe(1);
            });

            test('with no power to spare the assignment comes first', async () => {
                expect(await firstCast(hurt(list(), { mana: 120 }))).toBe(0);
            });

            test('over 25 % the assignment comes first, as ever', async () => {
                expect(await firstCast(hurt(list(), { hp: 40 }))).toBe(0);
            });

            test('its buffs at the run\'s start, before the walk: phase travel', async () => {
                const far = { x: ME.x + 9000, y: ME.y, z: ME.z };
                const m = member({ list: withPets(list(), { main: true }), spells: [PET_BUFF], orders: { phase: 'travel', focus: null, cc: [], anchor: far } });
                await until(() => m.w.sentOf('castSpell').length > 0, 500);
                expect(m.w.sentOf('castSpell').length).toBe(1);
                expect(m.w.sentOf('moveTo')).toEqual([]);
            });

            test('not with an enemy near: the walk goes on', async () => {
                const far = { x: ME.x + 9000, y: ME.y, z: ME.z };
                const m = member({ list: withPets(list(), { main: true }), spells: [PET_BUFF], orders: { phase: 'travel', focus: null, cc: [], anchor: far }, world: { nearbyPlayers: [foe(FOCUS, 1500, { inCombat: true })] } });
                await until(() => m.w.sentOf('moveTo').length > 0, 500);
                expect(m.w.sentOf('castSpell')).toEqual([]);
            });

            test('and not past the run\'s start', async () => {
                const realNow = Date.now.bind(Date);
                let skew = 0;
                const clock = spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
                try {
                    const far = { x: ME.x + 9000, y: ME.y, z: ME.z };
                    // Its first turn starts the clock, in whatever phase the run has it.
                    const held = member({ list: withPets(list(), { main: true }), spells: [PET_BUFF], orders: { phase: 'engage', focus: null, cc: [], anchor: ME } });
                    await Bun.sleep(60);
                    expect(held.w.sentOf('castSpell')).toEqual([]);
                    skew = 61_000;
                    held.order({ phase: 'travel', focus: null, cc: [], anchor: far });
                    await until(() => held.w.sentOf('moveTo').length > 0, 500);
                    expect(held.w.sentOf('moveTo').length).toBeGreaterThan(0);
                    expect(held.w.sentOf('castSpell')).toEqual([]);
                } finally {
                    clock.mockRestore();
                }
            });
        });
    }
});

describe('a mezzed member', () => {
    // 20261104-050645 Rehea: 'heal:crowd_controlled (15)', 'You can't cast while mesmerized!' at 00:36, 00:38, 00:40 ... for one 42 s mezz. The report's timeline is mostly this.
    const CURE = spell('Minor Rejuvenation', 1301);
    const effect = (name: string, remainingSeconds = 42) => ({ index: 0, name, icon: 1, spellId: 911, remainingSeconds, isNegative: true });
    const held = (effects: ReturnType<typeof effect>[]) => {
        const m = member({ role: 'healer', list: [heal()], spells: [CURE], player: { healthPercent: 30, health: 30 }, orders: { phase: 'engage', focus: null, cc: [], anchor: ANCHOR }, world: { pet: null, nearbyNpcs: [], effects } });
        let answer = 'You can\'t cast while mesmerized!';
        m.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(answer, { type: 'system' }), 5); };
        return { m, free: (line: string) => { answer = 'You begin casting a Minor Rejuvenation spell!'; m.w.state.effects = []; if (line) m.w.message(line, { type: 'spellExpires' }); }, fails: () => m.results().filter(r => r.includes('crowd_controlled')) };
    };

    test('one failure for one mezz, however long it lasts', async () => {
        const { m, fails } = held([effect('Minor Mesmerization')]);
        await until(() => fails().length > 0, 800);
        await Bun.sleep(2600);
        expect(fails().length).toBe(1);
        expect(m.w.sentOf('castSpell').length).toBe(1);
    }, 6000);

    for (const line of ['You are no longer entranced.', 'You recover from the mesmerize.']) {
        test(`"${line}": it goes on at once`, async () => {
            const { m, free, fails } = held([effect('Minor Mesmerization')]);
            await until(() => fails().length > 0, 800);
            await Bun.sleep(2300);
            free(line);
            await until(() => m.w.sentOf('castSpell').length > 1, 500);
            expect(m.w.sentOf('castSpell').length).toBe(2);
        }, 6000);
    }

    test('the effect gone says the same, with the line missed', async () => {
        const { m, free, fails } = held([effect('Minor Mesmerization')]);
        await until(() => fails().length > 0, 800);
        await Bun.sleep(2300);
        free('');
        await until(() => m.w.sentOf('castSpell').length > 1, 500);
        expect(m.w.sentOf('castSpell').length).toBe(2);
    }, 6000);

    test('its time up says the same, with neither', async () => {
        const { m, fails } = held([effect('Minor Mesmerization', 1)]);
        await until(() => fails().length > 0, 800);
        await until(() => m.w.sentOf('castSpell').length > 1, 3500);
        expect(m.w.sentOf('castSpell').length).toBe(2);
    }, 6000);

    test('a turn with no sleep of its own, as petHeal, buff or song: the failed-turn pause doesn\'t come after the wait. "next cast 1045 ms after the mezz ended", the owner free and the pet hurt', async () => {
        const mend = spell('Mend Simulacrum', 821);
        const refused: Behavior<any> = { name: 'mend', async run(ctx) { ctx.result('mend', await ctx.bot.castSpell(mend)); return true; } };
        const m = member({ list: [refused], spells: [mend], agent: { minTurnMs: 250, failedTurnMs: 1000 }, orders: { phase: 'engage', focus: null, cc: [], anchor: ANCHOR }, world: { effects: [effect('Minor Mesmerization')] } });
        let answer = 'You can\'t cast while mesmerized!';
        m.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message(answer, { type: 'system' }), 5); };
        await until(() => m.results().some(r => r.includes('crowd_controlled')), 800);
        await Bun.sleep(100);
        expect(m.w.sentOf('castSpell').length).toBe(1);
        answer = 'You begin casting a Mend Simulacrum spell!';
        m.w.state.effects = [];
        m.w.message('You are no longer entranced.', { type: 'spellExpires' });
        const freed = Date.now();
        await until(() => m.w.sentOf('castSpell').length > 1, 1500);
        expect(m.w.sentOf('castSpell').length).toBe(2);
        expect(Date.now() - freed).toBeLessThan(500);
    }, 6000);

    test('the report\'s idle leaves that out: before the wait it read its last turn, and a 42 s mezz in 100 s of fight now said "idle 42 %, check its behaviour list"', async () => {
        const NUKE = spell('Murk Blast', 2508);
        const m = member({ list: [assist()], spells: [NUKE], orders: { phase: 'engage', focus: 760, cc: [], anchor: ANCHOR }, world: { pet: null, nearbyNpcs: [], nearbyPlayers: [foe(760, 300)], effects: [effect('Minor Mesmerization')] } });
        m.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You can\'t cast while mesmerized!', { type: 'system' }), 5); };
        const observer = new GroupObserver(m.board, { group: 'g', strategy: 's', sampleMs: 50 }).start();
        await until(() => m.board.picture().members[0]?.activity.detail === MEZZED, 3500);
        expect(m.board.picture().members[0]?.activity).toMatchObject({ kind: 'idle', detail: MEZZED });
        await Bun.sleep(1200);
        const r = observer.stop();
        const { idleInFights, idleReasons } = Object.values(r.members)[0]!;
        expect(idleInFights).toBe(0);
        expect(idleReasons).toEqual({});
        expect(r.findings.filter(f => f.topic === 'idle')).toEqual([]);
    }, 8000);

    test('a stun isn\'t waited for like this: its 2 s stands', async () => {
        const { m, fails } = held([]);
        m.w.handlers.castSpell = (_a, world) => { setTimeout(() => world.message('You can\'t cast while stunned!', { type: 'system' }), 5); };
        await until(() => fails().length > 1, 3000);
        expect(fails().length).toBe(2);
    }, 6000);
});

describe('a cast that crowd control broke', () => {
    // 'You are entranced!' or 'You are stunned!' beside the 0x0B reads crowd_controlled (A10, R14), where it read interrupted, and the 60 s was every other reason's: a 5 s stun at a summon, no second cast until +60 s.
    test('as the interrupt it was: tried again after 8 s, not 60', () => {
        expect(buffRetryMs({ success: false, reason: 'crowd_controlled', message: 'You are stunned!' })).toBe(8000);
        expect(buffRetryMs({ success: false, reason: 'interrupted', message: 'Your spell is interrupted.' })).toBe(8000);
    });

    test.each([['You are stunned!', 'Stunning Flash'], ['You are entranced!', 'Minor Mesmerization']])('a summon broken by "%s" tries again in 8 s: no pet for 60 s of a 180 s round', async (line, effect) => {
        const m = member({ list: [summonPet()], spells: [SUMMON], orders: { phase: 'recover', focus: null, cc: [], anchor: ANCHOR }, world: { pet: null, nearbyNpcs: [] } });
        m.w.handlers.castSpell = (_a, world) => {
            world.message(`You begin casting a ${SUMMON.name} spell!`, { type: 'spell' });
            world.combat({ kind: 'spellCast', attackerObjectId: world.player.objectId, targetObjectId: null, castTimeMs: 5670 });
            setTimeout(() => {
                world.state.effects = [{ index: 0, name: effect, icon: 1, spellId: 911, remainingSeconds: 0.1, isNegative: true }];
                world.combat({ kind: 'interrupt', attackerObjectId: world.player.objectId, targetObjectId: null });
                world.message(line, { type: 'spell' });
            }, 10);
        };
        const t0 = Date.now();
        await until(() => m.results().some(r => r.startsWith('summon')), 1500);
        expect(m.results().find(r => r.startsWith('summon'))).toContain('crowd_controlled');
        expect(m.agent.ctx.memory.get('summonRetry') - t0).toBeLessThan(10_000);
    }, 6000);
});
