// Region views (gateway/regions.ts): the region frame from fake session maps
// and runs, the per-username auth step, the regions list and the battleground
// layout. Pure functions; the routes are tested in viewer/viewer.test.ts and,
// with a real group store, in groups.test.ts.
import { describe, expect, test } from 'bun:test';
import { composeRegion, listRegions, regionFrame, regionLayout, type RegionRun, type RegionSources } from './regions';
import type { ActiveRun } from './groups';
import type { GroupBadge } from './group-types';
import type { ViewerBotSession } from './viewer/routes';
import { makeNpc, makePlayer, makePlayerObj, makeState } from '../sdk/test/fixtures';
import { enemy, picture, report } from '../sdk/group/fixtures';
import { BATTLEGROUND_LAYOUTS, THIDRANKI } from '../sdk/group/rvr';
import { KEEP_CLEARANCE } from '../sdk/group/keeps';
import type { BotWorldState, PetState, PlayerState } from './types';
import type { LiveReport } from '../sdk/group/wire';

const NOW = 1_800_000_000_000;
const BG = THIDRANKI;

function session(player: Partial<PlayerState> | null, extra: Partial<BotWorldState> = {}, at = NOW - 200, ws: object | null = {}): ViewerBotSession {
    const state = player ? makeState({ player: makePlayer({ regionId: BG, zoneId: BG, zoneName: 'Thidranki', ...player }), nearbyNpcs: [], nearbyPlayers: [], ...extra }) : null;
    return { ws, clientId: 'c', lastState: state, lastStateReceivedAt: state ? at : 0 };
}

const GROUPS: Record<string, GroupBadge> = {
    galahad: { id: 'camelot', name: 'camelot', run: null }, nimue: { id: 'camelot', name: 'camelot', run: null },
    thorgrim: { id: 'midgard', name: 'midgard', run: null }, sigrid: { id: 'midgard', name: 'midgard', run: null },
    brigid: { id: 'hibernia', name: 'hibernia', run: null },
};

/** Two Albion, two Midgard and one Hibernia bot in Thidranki, one Albion bot elsewhere, one not in game, one whose client left. */
function sessions(): Map<string, ViewerBotSession> {
    return new Map<string, ViewerBotSession>([
        ['galahad', session({ name: 'Galahad', objectId: 11, realm: 'albion', className: 'Paladin', level: 20, x: 30000, y: 40000, healthPercent: 90, manaPercent: 50, targetObjectId: 21, inCombat: true, realmPoints: 120 }, {
            // Thorgrim (ours) by its race name, a human Troll, a same-realm stranger and a broken entry.
            nearbyPlayers: [
                makePlayerObj({ objectId: 21, name: 'Norseman', realm: 'midgard', x: 30500, y: 40000 }),
                makePlayerObj({ objectId: 77, name: 'Troll', realm: 'midgard', level: 22, x: 31000, y: 40000, healthPercent: 60 }),
                makePlayerObj({ objectId: 78, name: 'Briton', realm: 'albion', x: 31000, y: 40100 }),
                { objectId: 'x' } as any,
            ],
        }, NOW - 100)],
        ['nimue', session({ name: 'Nimue', objectId: 12, realm: 'albion', className: 'Cleric', x: 30100, y: 40050, isDead: true, healthPercent: 0 }, {
            nearbyPlayers: [makePlayerObj({ objectId: 77, name: 'Troll', realm: 'midgard', x: 31010, y: 40000 }), makePlayerObj({ objectId: 99, name: 'Celt', realm: 'hibernia', x: 32000, y: 40000 })],
        }, NOW - 500)],
        ['thorgrim', session({ name: 'Thorgrim', objectId: 21, realm: 'midgard', className: 'Warrior', x: 30500, y: 40000 }, {
            // The Albion bots seen from Midgard: ours, so no markers.
            nearbyPlayers: [makePlayerObj({ objectId: 11, name: 'Briton', realm: 'albion' }), makePlayerObj({ objectId: 12, name: 'Briton', realm: 'albion' })],
        })],
        ['sigrid', session({ name: 'Sigrid', objectId: 22, realm: 'midgard', className: 'Healer', x: 30600, y: 40000 })],
        ['brigid', session({ name: 'Brigid', objectId: 31, realm: 'hibernia', className: 'Druid', x: 20000, y: 20000 }, {}, NOW - 9000)],
        ['lancelot', session({ name: 'Lancelot', objectId: 41, realm: 'albion', regionId: 1, zoneName: 'Camelot Hills' })],
        ['loading', session(null)],
        ['gone', session({ name: 'Gone', objectId: 51, realm: 'albion' }, {}, NOW - 100, null)],
    ]);
}

const status = (s: ViewerBotSession) => (!s.ws ? 'dead' : NOW - s.lastStateReceivedAt > 8000 ? 'stale' : 'active');

function run(id: string, usernames: string[], over: Partial<ActiveRun> = {}): ActiveRun {
    return {
        id, name: id, leaderUsername: usernames[0]!, usernames, runId: `run-${id}-0001`, state: 'live', strategy: `${id}-rvr`, lastAt: NOW - 700,
        picture: picture([], [], { phase: 'travel', reason: 'patrol to waypoint 2/6', objective: 'patrol 6 waypoints', anchor: { x: 30200, y: 40100, z: 3800 } }, NOW),
        timing: { windingDown: false, deadline: NOW + 60_000, hardStop: NOW + 120_000 }, coordinator: null, report: null, result: null,
        ...over,
    };
}

function sources(over: Partial<RegionSources> = {}): RegionSources {
    return { sessions: sessions(), sessionStatus: status, groupOf: u => GROUPS[u] ?? null, runs: [], ...over };
}

function deepFreeze<T>(x: T): T {
    if (x && typeof x === 'object' && !Object.isFrozen(x)) {
        Object.freeze(x);
        for (const v of Object.values(x)) deepFreeze(v);
    }
    return x;
}

describe('composeRegion', () => {
    test('every in-game bot of the region with its own state and group, by username; nothing from other regions or dead sessions', () => {
        const f = composeRegion(BG, sources(), NOW);
        expect(f).toMatchObject({ v: 1, regionId: BG, now: NOW, layout: null, keeps: [], runs: [], hidden: { bots: 0, runs: 0 } });
        expect(f.bots.map(b => b.username)).toEqual(['brigid', 'galahad', 'nimue', 'sigrid', 'thorgrim']);
        expect(f.bots.find(b => b.username === 'galahad')).toEqual({
            username: 'galahad', status: 'active', stateAge: 100, name: 'Galahad', objectId: 11, level: 20, className: 'Paladin', realm: 'albion',
            zoneId: BG, zoneName: 'Thidranki', x: 30000, y: 40000, z: 2500, heading: 0, hp: 90, mana: 50, endurance: 100,
            isDead: false, isSitting: false, inCombat: true, attacking: false, targetObjectId: 21, realmPoints: 120,
            group: { id: 'camelot', name: 'camelot' },
        });
        expect(f.bots.find(b => b.username === 'nimue')).toMatchObject({ isDead: true, hp: 0 });
        expect(f.bots.find(b => b.username === 'brigid')).toMatchObject({ status: 'stale', stateAge: 9000, group: { id: 'hibernia' } });
        expect(composeRegion(1, sources(), NOW).bots.map(b => b.username)).toEqual(['lancelot']);
        expect(composeRegion(999, sources(), NOW).bots).toEqual([]);
    });

    test('a bot\'s window pet: its entry\'s place and health, null out of view; null without one; absent from an older client', () => {
        const window: PetState = { objectId: 600, name: 'old name', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null };
        const entry = makeNpc({ objectId: 600, name: 'spirit warrior', x: 30010, y: 40010, healthPercent: 84, isPet: true });
        const sess = new Map<string, ViewerBotSession>([
            ['galahad', session({ name: 'Galahad', objectId: 11, realm: 'albion' }, { pet: window, nearbyNpcs: [entry] })],
            ['nimue', session({ name: 'Nimue', objectId: 12, realm: 'albion' }, { pet: window })],
            ['sigrid', session({ name: 'Sigrid', objectId: 22, realm: 'midgard' }, { pet: null })],
            ['thorgrim', session({ name: 'Thorgrim', objectId: 21, realm: 'midgard' }, { pet: { objectId: 'x' } as any })],
            ['brigid', session({ name: 'Brigid', objectId: 31, realm: 'hibernia' })],
        ]);
        const bots = new Map(composeRegion(BG, sources({ sessions: sess }), NOW).bots.map(b => [b.username, b]));
        expect(bots.get('galahad')!.pet).toEqual({ objectId: 600, name: 'spirit warrior', x: 30010, y: 40010, hp: 84 });
        expect(bots.get('nimue')!.pet).toEqual({ objectId: 600, name: 'old name', x: null, y: null, hp: null });
        expect(bots.get('sigrid')!.pet).toBeNull();
        expect(bots.get('thorgrim')!.pet).toBeNull();
        expect('pet' in bots.get('brigid')!).toBe(false);
    });

    test('enemy players: other realms only, none of our bots, one marker per object id seen by every bot that sees it', () => {
        const f = composeRegion(BG, sources(), NOW);
        expect(f.enemies.map(e => e.objectId).sort()).toEqual([77, 99]);
        // Galahad's state is the fresher one: its sighting wins, Nimue joins seenBy.
        expect(f.enemies.find(e => e.objectId === 77)).toEqual({
            objectId: 77, name: 'Troll', level: 22, realm: 'midgard', x: 31000, y: 40000, z: 2500, heading: 0, hp: 60,
            isDead: false, inCombat: false, seenBy: ['Galahad', 'Nimue'],
        });
        expect(f.enemies.find(e => e.objectId === 99)?.seenBy).toEqual(['Nimue']);
    });

    test('a hidden bot is still ours: never an enemy marker, and the bots shown see for the frame', () => {
        const f = composeRegion(BG, sources(), NOW, u => u !== 'thorgrim' && u !== 'nimue');
        expect(f.bots.map(b => b.username)).toEqual(['brigid', 'galahad', 'sigrid']);
        expect(f.hidden).toEqual({ bots: 2, runs: 0 });
        // Thorgrim (21) stays out although Galahad sees it; Nimue's sightings (the Celt) are not read.
        expect(f.enemies.map(e => e.objectId)).toEqual([77]);
        expect(f.enemies[0]!.seenBy).toEqual(['Galahad']);
    });

    test('runs: only those with a member here, coloured by their members\' realm; the focus by our bot, the run\'s contact or its id', () => {
        const report_ = { totals: { kills: 4, deaths: 1, playerKills: 3, deathsToPlayers: 1, enemiesSeen: 9, engagements: 2, realmPoints: 'lots' } } as unknown as LiveReport;
        const camelot = run('camelot', ['galahad', 'nimue', 'merlin'], {
            picture: picture(
                [report('Galahad', { regionId: BG }), report('Nimue', { regionId: BG, isDead: true }), report('Merlin', { regionId: 1 })],
                [], { phase: 'engage', focus: 21, reason: 'fight Norseman#21 (midgard L20, 80%): 2 enemies vs 2', anchor: { x: 30200, y: 40100, z: 3800 }, retreatTo: null }, NOW),
            coordinator: { camp: { x: 33000, y: 39000, z: 0, zone: '', count: 0, names: 'patrol waypoint 2/6' }, campLevel: null, base: null, facing: null, route: [{ x: 31000, y: 39500 }, { x: 33000, y: 39000 }], leg: { x: 30600, y: 39800, z: 3800 }, avoidCamps: [], excluded: [] },
            report: report_,
        });
        const midgard = run('midgard', ['thorgrim', 'sigrid'], {
            state: 'stale',
            picture: picture([], [enemy(77, 'midgard', { regionId: BG, name: 'Troll', hp: 55 })], { phase: 'engage', focus: 77, reason: 'fight Troll' }, NOW),
            result: { totals: { kills: 2, deaths: 0, wipes: 0, retreats: 0, fights: 1, killsPerHour: 0, xpPerHour: 0, avgFightMs: 0, downtime: 0, tankHold: null }, findings: [], stamp: null, stoppedBy: 'time' },
        });
        const hibernia = run('hibernia', ['brigid'], { picture: picture([], [], { phase: 'engage', focus: 4242 }, NOW) });
        const elsewhere = run('lancelots', ['lancelot']);
        const f = composeRegion(BG, sources({ runs: [midgard, hibernia, elsewhere, camelot] }), NOW);
        expect(f.runs.map(r => r.group)).toEqual(['camelot', 'hibernia', 'midgard']);
        const [c, h, m] = f.runs as [RegionRun, RegionRun, RegionRun];
        expect(c).toEqual({
            group: 'camelot', name: 'camelot', realm: 'albion', runId: 'run-camelot-0001', state: 'live', strategy: 'camelot-rvr', ageMs: 700, windingDown: false,
            phase: 'engage', reason: 'fight Norseman#21 (midgard L20, 80%): 2 enemies vs 2', objective: '',
            focus: { objectId: 21, name: 'Thorgrim', realm: 'midgard', hp: 80, ours: true },
            anchor: { x: 30200, y: 40100, z: 3800 }, facing: null, retreatTo: null,
            leg: { x: 30600, y: 39800, z: 3800 }, route: [{ x: 31000, y: 39500 }, { x: 33000, y: 39000 }],
            camp: { x: 33000, y: 39000, label: 'patrol waypoint 2/6' },
            // A number the runner sent as a string is left out.
            totals: { kills: 4, deaths: 1, playerKills: 3, deathsToPlayers: 1, enemiesSeen: 9, engagements: 2 },
            members: ['galahad', 'nimue'], alive: 1, size: 3,
        });
        expect(m).toMatchObject({ realm: 'midgard', state: 'stale', focus: { objectId: 77, name: 'Troll', realm: 'midgard', hp: 55, ours: false }, totals: { kills: 2, deaths: 0 } });
        expect('playerKills' in m.totals!).toBe(false);
        expect(h).toMatchObject({ realm: 'hibernia', focus: { objectId: 4242, name: '#4242', realm: 'none', hp: null, ours: false }, totals: null, leg: null, route: [], camp: null });
    });

    test('a run whose leader the request may not read is hidden and counted; a hidden bot never names a focus', () => {
        const camelot = run('camelot', ['galahad', 'nimue'], { picture: picture([], [enemy(21, 'midgard', { regionId: BG })], { focus: 21 }, NOW) });
        const midgard = run('midgard', ['thorgrim', 'sigrid']);
        const f = composeRegion(BG, sources({ runs: [camelot, midgard] }), NOW, u => u !== 'thorgrim');
        expect(f.runs.map(r => r.group)).toEqual(['camelot']);
        expect(f.hidden).toEqual({ bots: 1, runs: 1 });
        // Thorgrim is hidden: the focus is what the run's own board calls it.
        expect(f.runs[0]!.focus).toEqual({ objectId: 21, name: 'Norseman', realm: 'midgard', hp: 100, ours: false });
    });

    test('keeps from the battleground layout with the clearance for portal and other keeps', () => {
        const layout = BATTLEGROUND_LAYOUTS[BG]!;
        const f = composeRegion(BG, sources({ layout, keepClearance: { portal: 4500, keep: 3000 } }), NOW);
        expect(f.layout).toEqual({ name: 'Thidranki', levels: [20, 24] });
        expect(f.keeps).toHaveLength(4);
        expect(f.keeps.find(k => k.name === 'Thidranki Faste')).toEqual({ name: 'Thidranki Faste', x: 33089, y: 38271, z: 3720, owner: 'albion', portal: false, guardLevel: 28, clearance: 3000 });
        expect(f.keeps.find(k => k.name === 'Midgard Portal Keep')).toMatchObject({ owner: 'midgard', portal: true, guardLevel: 255, clearance: 4500 });
        expect(composeRegion(BG, sources({ layout }), NOW).keeps.every(k => k.clearance === 0)).toBe(true);
    });

    test('pure: frozen states, sessions and runs compose the same frame twice', () => {
        const src = sources({ runs: [run('camelot', ['galahad'])] });
        for (const s of src.sessions.values()) deepFreeze(s);
        deepFreeze(src.runs);
        const a = composeRegion(BG, src, NOW);
        expect(composeRegion(BG, src, NOW)).toEqual(a);
    });
});

describe('regionFrame', () => {
    test('asks the auth hook once per bot and run leader with the request\'s password; a throwing hook refuses', async () => {
        const asked: string[] = [];
        const auth = ({ kind, username, password }: { kind: string; username: string; password: string }) => {
            asked.push(`${kind}:${username}:${password}`);
            if (username === 'brigid') throw new Error('broken hook');
            return { success: password === `${username}-pw` || (password === 'shared' && username !== 'sigrid') };
        };
        const src = sources({ runs: [run('midgard', ['thorgrim', 'sigrid']), run('lancelots', ['lancelot'])] });
        const none = await regionFrame(BG, src, auth, '', NOW);
        expect(none.bots).toEqual([]);
        expect(none.hidden).toEqual({ bots: 5, runs: 1 });
        // The region's five bots; the run elsewhere is not asked about. Thorgrim leads midgard: asked once.
        expect(asked.sort()).toEqual(['brigid', 'galahad', 'nimue', 'sigrid', 'thorgrim'].map(u => `http:${u}:`));
        const one = await regionFrame(BG, src, auth, 'galahad-pw', NOW);
        expect(one.bots.map(b => b.username)).toEqual(['galahad']);
        const shared = await regionFrame(BG, src, auth, 'shared', NOW);
        expect(shared.bots.map(b => b.username)).toEqual(['galahad', 'nimue', 'thorgrim']);
        expect(shared.runs.map(r => r.group)).toEqual(['midgard']);
        expect(shared.hidden).toEqual({ bots: 2, runs: 0 });
        expect((await regionFrame(BG, src, undefined, '', NOW)).bots).toHaveLength(5);
    });
});

describe('listRegions', () => {
    test('regions with an in-game bot, the busiest first: bots per realm, zones, groups', () => {
        expect(listRegions(sources())).toEqual([
            {
                regionId: BG, zones: ['Thidranki'], bots: 5, realms: { albion: 2, midgard: 2, hibernia: 1 },
                groups: [{ id: 'camelot', name: 'camelot' }, { id: 'midgard', name: 'midgard' }, { id: 'hibernia', name: 'hibernia' }],
            },
            { regionId: 1, zones: ['Camelot Hills'], bots: 1, realms: { albion: 1 }, groups: [] },
        ]);
        expect(listRegions({ sessions: new Map() })).toEqual([]);
    });
});

describe('regionLayout', () => {
    test('Thidranki from sdk/group/rvr.ts with the default keep clearance; nothing elsewhere', async () => {
        const bg = await regionLayout(BG);
        expect(bg?.layout.name).toBe('Thidranki');
        expect(bg?.layout.keeps).toHaveLength(4);
        // The Faste's circle went 3000 -> 4500 in 228c5de (keeps.ts KEEP_CLEARANCE).
        expect(bg?.keepClearance).toEqual(KEEP_CLEARANCE);
        expect(await regionLayout(1)).toBeNull();
    });
});

describe('enemy pets in the region frame', () => {
    // R9-region: GET /regions/252/live during a fight: enemies [] and 'spirit warrior' once, as a Midgard bot's pet. A non-bot enemy's pet would not show.
    const PET_OF_THORGRIM = 600, STRANGERS = 601, CASTER = 602, SAME_REALM = 603;
    const window = (objectId: number): PetState => ({ objectId, name: 'spirit warrior', aggression: 'defensive', walk: 'follow', icons: [], targetObjectId: null });
    const frame = () => {
        const s = new Map<string, ViewerBotSession>([
            ['galahad', session({ name: 'Galahad', objectId: 11, realm: 'albion', x: 30000, y: 40000 }, {
                nearbyNpcs: [
                    makeNpc({ objectId: PET_OF_THORGRIM, name: 'spirit warrior', realm: 'midgard', isPet: true, x: 30500, y: 40000 }),
                    makeNpc({ objectId: STRANGERS, name: 'emerald simulacrum', level: 21, realm: 'midgard', isPet: true, x: 31000, y: 40000, healthPercent: 60, targetObjectId: 11 }),
                    makeNpc({ objectId: CASTER, name: 'ice spirit', realm: 'hibernia', isPet: true, x: 32000, y: 40000 }),
                    makeNpc({ objectId: SAME_REALM, name: 'ruby simulacrum', realm: 'albion', isPet: true, x: 30100, y: 40000 }),
                    makeNpc({ objectId: 604, name: 'wolf', realm: 'none', x: 30100, y: 40100 }),
                    makeNpc({ objectId: 605, name: 'keep guard', realm: 'midgard', x: 30100, y: 40200 }),
                ],
                // A caster pet's entry names its target only on its victim's client, for moments (live): the fight says it, and that reaches every client.
                combatEvents: [{ id: 1, kind: 'spellEffect', attackerObjectId: CASTER, targetObjectId: 21, receivedAt: NOW - 500 }], timestamp: NOW,
            }, NOW - 100)],
            ['thorgrim', session({ name: 'Thorgrim', objectId: 21, realm: 'midgard', x: 30500, y: 40000 }, { pet: window(PET_OF_THORGRIM) })],
        ]);
        return composeRegion(BG, sources({ sessions: s }), NOW);
    };
    const pets = () => frame().enemies.filter(e => e.isPet);

    test('from nearbyNpcs with isPet, of another realm than the one who sees it, and none of our bots\'', () => {
        expect(pets().map(e => e.objectId).sort()).toEqual([STRANGERS, CASTER].sort());
    });

    test('as a marker, with its aim: its entry\'s target, else its last blow', () => {
        expect(frame().enemies.find(e => e.objectId === STRANGERS)).toMatchObject({ name: 'emerald simulacrum', level: 21, realm: 'midgard', x: 31000, y: 40000, hp: 60, isPet: true, targetId: 11, seenBy: ['Galahad'] });
        expect(frame().enemies.find(e => e.objectId === CASTER)).toMatchObject({ isPet: true, targetId: 21 });
    });

    test('a player has neither key: the frame reads as it did', () => {
        const players = composeRegion(BG, sources(), NOW).enemies;
        expect(players.length).toBeGreaterThan(0);
        for (const p of players) {
            expect(p).not.toHaveProperty('isPet');
            expect(p).not.toHaveProperty('targetId');
        }
    });

    test('players come first when the list is full: a pet never takes a player\'s place', () => {
        // MAX_ENEMIES is 300, and a bot's list runs to 500.
        const many = Array.from({ length: 300 }, (_, i) => makePlayerObj({ objectId: 1000 + i, name: 'Troll', realm: 'midgard', x: 30000 + i, y: 40000 }));
        const s = new Map<string, ViewerBotSession>([['galahad', session({ name: 'Galahad', objectId: 11, realm: 'albion', x: 30000, y: 40000 }, { nearbyPlayers: many, nearbyNpcs: [makeNpc({ objectId: 700, realm: 'midgard', isPet: true })] }, NOW - 100)]]);
        const list = composeRegion(BG, sources({ sessions: s }), NOW).enemies;
        expect(list.length).toBe(300);
        expect(list.filter(e => e.isPet)).toEqual([]);
    });
});
