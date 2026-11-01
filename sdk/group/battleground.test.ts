// The way into a battleground against fake members: a snapshot (player, backpack, equipment)
// and action stubs that change it the way the server would, recording every call. The static
// spawn data is real: the town teleporters, the portal keeps and Atlantis.
import { describe, expect, test } from 'bun:test';
import { getZonePoint, type ZonePoint } from '../../data/index';
import type { InventoryItem, PlayerState, Realm } from '../types';
import { BATTLEGROUNDS, battlegroundExit, CAPITALS, enterBattleground, leaveBattleground, PORTAL_KEEPS, toPortalKeep, townTeleporter, viaWalkers, waitForPort, walkTogether, wearMedallion } from './battleground';
import { BATTLEGROUND_LAYOUTS } from './keeps';
import type { Member } from './member';

const BG = BATTLEGROUNDS[252]!;
const ALB = PORTAL_KEEPS.albion;
const MEDALLION = 'Battlegrounds Medallion of Passage';
/** By the Castle Sauvage OFTeleporter, region 1. */
const KEEP = { regionId: 1, x: ALB.teleporter.x - 300, y: ALB.teleporter.y - 300 };
/** Master Rusiv, the Castle Sauvage emissary at Snowdonia Fortress (SimpleTeleporter), region 1. */
const RUSIV = { regionId: 1, x: 527188 + 100, y: 359272 };
/** Master Visur (LiveTeleporter) at (560297, 511737), region 1. */
const VISUR = { regionId: 1, x: 560297 + 100, y: 511737 };
/** Region 1 with no town teleporter within 4000. */
const FIELD = { regionId: 1, x: 560000, y: 520000 };

type State = { player: PlayerState; inventory: InventoryItem[]; equipment: InventoryItem[] };
type Stubs = Partial<Record<'buyItem' | 'equipItem' | 'unequipItem' | 'walkTo' | 'whisper' | 'useZonePoint' | 'releaseAndRespawn', (...a: any[]) => Promise<unknown>>>;
interface Fake {
    member: Member;
    state: State;
    calls: string[];
    /** A new player snapshot, as the client publishes one (callers keep the old one). */
    set(change: Partial<PlayerState>): void;
}

const ok = (message = 'ok') => ({ success: true, message });
const item = (slot: number, name = MEDALLION) => ({ slot, name, level: 0, count: 1 }) as InventoryItem;

function fake(name: string, where: Partial<PlayerState>, opts: { inventory?: InventoryItem[]; equipment?: InventoryItem[]; realm?: Realm; stubs?: (f: Fake) => Stubs } = {}): Fake {
    const player = { name, realm: opts.realm ?? 'albion', regionId: 1, x: 0, y: 0, z: 0, level: 20, realmPoints: 0, isDead: false, inCombat: false, healthPercent: 100, ...where } as PlayerState;
    const state: State = { player, inventory: opts.inventory ?? [], equipment: opts.equipment ?? [] };
    const calls: string[] = [];
    const move = (from: InventoryItem[], to: InventoryItem[], slot: number) => {
        const i = from.findIndex(x => x.name === MEDALLION);
        if (i >= 0) to.push({ ...from.splice(i, 1)[0]!, slot });
    };
    const f: Fake = { member: null!, state, calls, set: change => { state.player = { ...state.player, ...change }; } };
    const actions: Record<string, (...a: any[]) => Promise<unknown>> = {
        buyItem: async (merchant: string) => {
            calls.push(`buy ${merchant}`);
            state.inventory.push(item(40 + state.inventory.length));
            return ok();
        },
        closeMerchant: async () => ok(),
        equipItem: async () => { calls.push('equip'); move(state.inventory, state.equipment, 37); return ok(); },
        unequipItem: async () => { calls.push('unequip'); move(state.equipment, state.inventory, 40 + state.inventory.length); return ok(); },
        walkTo: async (x: number, y: number, o: { z?: number } = {}) => {
            calls.push(`walkTo ${x},${y}${o.z === undefined ? '' : ` z=${o.z}`}`);
            f.set({ x, y });
            return ok();
        },
        followPath: async () => { calls.push('followPath'); return ok(); },
        walkToObject: async (target: string) => { calls.push(`walkToObject ${target}`); return ok(); },
        talkTo: async (npc: string) => { calls.push(`talkTo ${npc}`); return ok(); },
        whisper: async (npc: string, keyword: string) => { calls.push(`whisper ${npc} ${keyword}`); return ok(); },
        useZonePoint: async (zp: ZonePoint) => { calls.push(`zone point ${zp.id}`); f.set({ regionId: zp.targetRegion, x: zp.targetX, y: zp.targetY }); return ok(); },
        // bg_release_to_portal_keep: the realm's portal keep inside the battleground.
        releaseAndRespawn: async () => { calls.push('release'); f.set({ isDead: false, x: 37301, y: 52362 }); return ok(); },
    };
    Object.assign(actions, opts.stubs?.(f));
    const sdk = {
        getPlayer: () => state.player,
        getInventory: () => state.inventory,
        getEquipment: () => state.equipment,
        getEquipmentItem: (slot: number) => state.equipment.find(i => i.slot === slot) ?? null,
        getGameMessages: () => [],
        sendCommand: async () => ok(),
        // The real one polls snapshots for up to `ms`; a fake's state changes inside the stubs.
        waitForCondition: async (pred: (s: State) => boolean, ms: number) => {
            const end = Date.now() + Math.min(ms, 100);
            for (;;) {
                if (pred(state)) return state;
                if (Date.now() >= end) throw new Error('waitForCondition timed out');
                await Bun.sleep(5);
            }
        },
    };
    f.member = { bot: name.toLowerCase(), role: 'nuker', sdk, actions } as unknown as Member;
    return f;
}

const walked = (f: Fake) => f.calls.filter(c => c.startsWith('walkTo '));

describe('wearMedallion', () => {
    test('a medallion in the Mythical slot is worn already: nothing bought or moved', async () => {
        const f = fake('Galahad', KEEP, { equipment: [item(37)] });
        expect(await wearMedallion(f.member, ALB, BG)).toEqual({ ok: true, note: 'medallion already worn' });
        expect(f.calls).toEqual([]);
    });

    test('one in the backpack is put on, seen in the equipment', async () => {
        const f = fake('Galahad', KEEP, { inventory: [item(52)] });
        expect(await wearMedallion(f.member, ALB, BG)).toEqual({ ok: true, note: 'medallion worn' });
        expect(f.calls).toEqual(['equip']);
        expect(f.state.equipment.map(i => i.slot)).toEqual([37]);
    });

    test('without one it is bought from the merchant, then put on', async () => {
        const f = fake('Galahad', KEEP);
        expect(await wearMedallion(f.member, ALB, BG)).toEqual({ ok: true, note: 'medallion worn' });
        expect(f.calls).toEqual([`buy ${ALB.merchant.name}`, 'equip']);
    });

    test('an equip that never reaches the Mythical slot is no medallion worn', async () => {
        const f = fake('Galahad', KEEP, { inventory: [item(40)], stubs: () => ({ equipItem: async () => ok() }) });
        expect(await wearMedallion(f.member, ALB, BG)).toEqual({ ok: false, note: 'medallion not in the Mythical slot' });
    });
});

describe('waitForPort', () => {
    test('outside the keep\'s region there is no walk: the teleporter\'s coordinates mean nothing there', async () => {
        const f = fake('Galahad', { regionId: 252, x: 38000, y: 53500 }, { equipment: [item(37, 'Medallion of City Passage')] });
        expect(await waitForPort(f.member, ALB, CAPITALS.albion)).toBe('not at Castle Sauvage: r252 (38000, 53500)');
        expect(f.calls).toEqual([]);
    });
});

describe('enterBattleground', () => {
    const FULL = { buyItem: async () => ({ success: false, reason: 'inventory_full', message: 'Backpack is full' }) };

    test('a medallion for elsewhere that won\'t come off stops the group before anyone buys', async () => {
        const stuck = { unequipItem: async () => ({ success: false, reason: 'inventory_full', message: 'Backpack is full' }) };
        const group = [fake('Galahad', KEEP, { equipment: [item(37, 'Medallion of City Passage')], stubs: () => stuck }), fake('Nimue', KEEP)];
        const r = await enterBattleground(group.map(f => f.member), { bind: false });
        expect(r.message).toStartWith('medallion for elsewhere still on: Galahad r1');
        expect(r.report.Galahad).toContain('unequip: inventory_full Backpack is full');
        expect(group.flatMap(f => f.calls)).toEqual([]);
    });

    test('a real Mythical item is no medallion: it stays on until the medallion swaps it out', async () => {
        const f = fake('Galahad', KEEP, { equipment: [item(37, 'Mythirian of Ektaton')], stubs: () => FULL });
        await enterBattleground([f.member], { bind: false });
        expect(f.calls).toEqual([]);
        expect(f.state.equipment).toHaveLength(1);
    });

    test('a member without a medallion stops the group before anyone puts one on or waits for the port', async () => {
        const full = { buyItem: async () => ({ success: false, reason: 'inventory_full', message: 'Backpack is full' }) };
        const group = [fake('Galahad', KEEP), fake('Nimue', KEEP, { stubs: () => full }), fake('Merlin', KEEP, { inventory: [item(41)] })];
        const r = await enterBattleground(group.map(f => f.member), { bind: false });
        expect(r.success).toBe(false);
        expect(r.message).toBe('no medallion: Nimue (buy from Sall Fadri: inventory_full Backpack is full)');
        expect(group.map(f => f.calls)).toEqual([['buy Sall Fadri'], [], []]);
        expect(group.every(f => f.state.equipment.length === 0)).toBe(true);
    });

    test('an equip that fails takes the others\' medallions off again and nobody waits for the port', async () => {
        const stuck = { equipItem: async () => ({ success: false, reason: 'timeout', message: 'No change observed' }) };
        const group = [fake('Galahad', KEEP, { inventory: [item(40)] }), fake('Nimue', KEEP, { inventory: [item(40)], stubs: () => stuck })];
        const r = await enterBattleground(group.map(f => f.member), { bind: false });
        expect(r.message).toBe('medallion not worn: Nimue (equip: timeout No change observed)');
        expect(group.map(f => f.calls)).toEqual([['equip', 'unequip'], []]);
        expect(group.every(f => f.state.equipment.length === 0 && walked(f).length === 0)).toBe(true);
    });

    test('everyone wearing one walks to the teleporter and waits for the port', async () => {
        const group = [fake('Galahad', KEEP), fake('Nimue', KEEP, { equipment: [item(37)] })];
        // The port: the OFTeleporter's cast lands everyone standing by it in Thidranki.
        const port = (f: Fake) => ({ walkTo: async (x: number, y: number) => { f.calls.push(`walkTo ${x},${y}`); f.set({ regionId: 252, x: 38113, y: 53507 }); return ok(); } });
        for (const f of group) Object.assign(f.member.actions, port(f));
        const r = await enterBattleground(group.map(f => f.member), { bind: false });
        expect(r.success).toBe(true);
        expect(group.map(f => f.calls)).toEqual([[`buy ${ALB.merchant.name}`, 'equip', `walkTo ${ALB.teleporter.x},${ALB.teleporter.y}`], [`walkTo ${ALB.teleporter.x},${ALB.teleporter.y}`]]);
    });

    test('a member with no town teleporter of its realm in reach stops the group before anyone whispers', async () => {
        const group = [fake('Galahad', RUSIV), fake('Nimue', FIELD)];
        const r = await enterBattleground(group.map(f => f.member), { bind: false });
        expect(r.message).toBe('no town teleporter of their realm within 4000: Nimue r1 (560000, 520000)');
        expect(group.flatMap(f => f.calls)).toEqual([]);
    });

    test('--via walks only the members neither at the portal keep nor by a town teleporter', async () => {
        const group = [fake('Galahad', FIELD), fake('Nimue', KEEP), fake('Merlin', RUSIV), fake('Morgana', { regionId: 252, x: 38113, y: 53507 })];
        expect(viaWalkers(group.map(f => f.member), BG).map(m => m.bot)).toEqual(['galahad']);
        // A via point with no teleporter near it: the walk happens, then the pre-check stops everyone.
        const r = await enterBattleground(group.map(f => f.member), { bind: false, via: { x: FIELD.x + 1000, y: FIELD.y } });
        expect(r.message).toBe(`no town teleporter of their realm within 4000: Galahad r1 (${FIELD.x + 1000}, ${FIELD.y})`);
        expect(walked(group[0]!).length).toBeGreaterThan(0);
        expect(walked(group[0]!).every(c => !c.includes('z='))).toBe(true);
        expect(group.slice(1).flatMap(f => f.calls)).toEqual([]);
    });
});

describe('leaveBattleground', () => {
    const EXIT = getZonePoint(63)!;
    const MIDDLE = { regionId: 252, x: 31000, y: 33000 };
    const atExit = (f: Fake) => Math.hypot(f.state.player.x - EXIT.sourceX, f.state.player.y - EXIT.sourceY);
    const rest = (f: Fake) => f.calls.filter(c => !c.startsWith('walkTo '));

    test('each realm has an exit in its own portal keep, landing at the portal keep outside', () => {
        for (const [realm, id] of [['albion', 63], ['midgard', 64], ['hibernia', 65]] as const) {
            const f = fake('X', { regionId: 252 }, { realm });
            const exit = battlegroundExit(f.member, BG)!;
            const keep = PORTAL_KEEPS[realm], inside = BATTLEGROUND_LAYOUTS[252]!.keeps.find(k => k.portal && k.owner === realm)!;
            expect(exit.id).toBe(id);
            expect(Math.hypot(exit.sourceX - inside.x, exit.sourceY - inside.y)).toBeLessThan(2000);
            expect(exit.targetRegion).toBe(keep.regionId);
            expect(Math.hypot(exit.targetX - keep.teleporter.x, exit.targetY - keep.teleporter.y)).toBeLessThan(3000);
        }
    });

    test('walks the group to the exit, then everyone takes it', async () => {
        const group = [fake('Galahad', MIDDLE), fake('Nimue', { ...MIDDLE, x: MIDDLE.x + 300 })];
        const r = await leaveBattleground(group.map(f => f.member));
        expect(r.success).toBe(true);
        for (const f of group) {
            expect(walked(f).at(-1)).toBe(`walkTo ${EXIT.sourceX},${EXIT.sourceY} z=${EXIT.sourceZ}`);
            expect(rest(f)).toEqual(['zone point 63']);
            expect(f.state.player).toMatchObject({ regionId: 1, x: EXIT.targetX, y: EXIT.targetY });
        }
        expect(r.report.Galahad!.at(-1)).toBe(`out: r1 (${EXIT.targetX}, ${EXIT.targetY})`);
    });

    test('nobody takes the exit before all stand by it, even for walkers who started apart', async () => {
        const order: string[] = [];
        const group = [MIDDLE, { regionId: 252, x: 37301, y: 52362 }].map((where, i) => fake(i ? 'Merlin' : 'Galahad', where, {
            stubs: f => ({ useZonePoint: async (zp: ZonePoint) => { order.push(`${f.state.player.name} ${Math.round(atExit(f))} ${group.map(atExit).every(d => d <= 300)}`); f.set({ regionId: zp.targetRegion }); return ok(); } }),
        }));
        expect((await leaveBattleground(group.map(f => f.member))).success).toBe(true);
        expect(order).toEqual(['Galahad 0 true', 'Merlin 0 true']);
        // Two clusters, two routes: the far one has legs the near one doesn't.
        expect(walked(group[0]!).length).toBeGreaterThan(walked(group[1]!).length);
    });

    test('a member that can\'t reach the exit keeps everyone in the battleground', async () => {
        const stuck = { walkTo: async () => ({ success: false, reason: 'stuck', message: 'no progress' }) };
        const group = [fake('Galahad', { regionId: 252, x: EXIT.sourceX, y: EXIT.sourceY }), fake('Nimue', MIDDLE, { stubs: () => stuck })];
        const r = await leaveBattleground(group.map(f => f.member));
        expect(r.success).toBe(false);
        expect(r.message).toContain('Nimue: stuck no progress');
        expect(group.flatMap(rest)).toEqual([]);
    });

    test('the dead are released first, then walk from where that left them', async () => {
        const f = fake('Galahad', { ...MIDDLE, isDead: true });
        const r = await leaveBattleground([f.member]);
        expect(r.success).toBe(true);
        expect(rest(f)).toEqual(['release', 'zone point 63']);
        expect(walked(f).length).toBe(1);
    });

    test('a release that fails stops everyone', async () => {
        const group = [fake('Galahad', { ...MIDDLE, isDead: true }, { stubs: () => ({ releaseAndRespawn: async () => ({ success: false, reason: 'timeout', message: 'Still dead' }) }) }), fake('Nimue', MIDDLE)];
        const r = await leaveBattleground(group.map(f => f.member));
        expect(r.message).toBe('still dead: Galahad r252 (31000, 33000)');
        expect(walked(group[1]!)).toEqual([]);
    });

    test('an attack on the way does not stop the walk', async () => {
        const hit = (f: Fake) => ({ walkTo: async (x: number, y: number) => { f.calls.push(`walkTo ${x},${y}`); f.set({ x, y, inCombat: true, healthPercent: f.state.player.healthPercent - 1 }); return ok(); } });
        const lines: string[] = [];
        const f = fake('Galahad', MIDDLE, { stubs: hit });
        expect((await leaveBattleground([f.member], { log: l => lines.push(l) })).success).toBe(true);
        expect(lines.some(l => l.startsWith('attacked on leg 1/'))).toBe(true);
    });

    test('a refused exit is reported per member, and the run says it failed', async () => {
        const no = { useZonePoint: async () => ({ success: false, reason: 'timeout', message: 'No jump' }) };
        const f = fake('Galahad', { regionId: 252, x: EXIT.sourceX, y: EXIT.sourceY }, { stubs: () => no });
        const r = await leaveBattleground([f.member]);
        expect(r.success).toBe(false);
        expect(r.report.Galahad).toEqual(['zone point 63: timeout No jump']);
    });

    test('members already out are left alone, so it can simply run again', async () => {
        const group = [fake('Galahad', KEEP), fake('Nimue', { ...KEEP, isDead: true })];
        expect(await leaveBattleground(group.map(f => f.member))).toMatchObject({ success: true });
        expect(group.flatMap(f => f.calls)).toEqual([]);
    });

    test('routes stay out of enemy keeps: a Hibernian walking past the Faste goes round it', async () => {
        const faste = BATTLEGROUND_LAYOUTS[252]!.keeps.find(k => k.name === 'Thidranki Faste')!;
        const f = fake('Cuchulainn', { regionId: 252, x: 40_000, y: 45_000 }, { realm: 'hibernia' });
        expect((await leaveBattleground([f.member])).success).toBe(true);
        const legs = walked(f).map(c => c.slice('walkTo '.length).split(' ')[0]!.split(',').map(Number));
        expect(Math.min(...legs.map(([x, y]) => Math.hypot(x! - faste.x, y! - faste.y)))).toBeGreaterThan(2500);
        expect(f.calls.at(-1)).toBe('zone point 65');
    });
});

describe('town teleporters', () => {
    test('only our realm\'s: a Midgarder by Master Visur in Atlantis asks Stor Gothi Annark', () => {
        const f = fake('Thorgrim', { regionId: 73, x: 330930, y: 451480 }, { realm: 'midgard' });
        expect(townTeleporter(f.member)?.name).toBe('Stor Gothi Annark');
    });

    test('an emissary is right-clicked before the whisper, which it ignores otherwise', async () => {
        const f = fake('Galahad', RUSIV, { stubs: f => ({ whisper: async (npc: string, kw: string) => { f.calls.push(`whisper ${npc} ${kw}`); f.set(ALB.landing); return ok(); } }) });
        expect(await toPortalKeep(f.member, ALB)).toBe('teleported to Castle Sauvage by Master Rusiv');
        expect(f.calls).toEqual(['walkToObject Master Rusiv', 'talkTo Master Rusiv', 'whisper Master Rusiv Castle Sauvage']);
    });

    test('a LiveTeleporter answers the whisper alone', async () => {
        const f = fake('Galahad', VISUR, { stubs: f => ({ whisper: async (npc: string, kw: string) => { f.calls.push(`whisper ${npc} ${kw}`); f.set(ALB.landing); return ok(); } }) });
        expect(await toPortalKeep(f.member, ALB)).toBe('teleported to Castle Sauvage by Master Visur');
        expect(f.calls).toEqual(['walkToObject Master Visur', 'whisper Master Visur Castle Sauvage']);
    });
});

describe('walkTogether', () => {
    // Region 9999 has no spawns: the route is the straight line, in legs of 3000.
    const at = (x: number, y = 10_000) => ({ regionId: 9999, x, y });

    test('a member who set out hurt is no attack, and without z the height is left to walkTo', async () => {
        const group = [fake('Galahad', { ...at(10_000), healthPercent: 70 }), fake('Nimue', at(10_200))];
        expect(await walkTogether(group.map(f => f.member), { x: 16_000, y: 10_000 })).toBeNull();
        expect(group.map(walked)).toEqual([['walkTo 13000,10000', 'walkTo 16000,10000'], ['walkTo 13000,10000', 'walkTo 16000,10000']]);
    });

    test('a given z goes to the last leg only', async () => {
        const f = fake('Galahad', at(10_000));
        expect(await walkTogether([f.member], { x: 16_000, y: 10_000, z: 4680 })).toBeNull();
        expect(walked(f)).toEqual(['walkTo 13000,10000', 'walkTo 16000,10000 z=4680']);
    });

    test('health lost during a leg stops the walk there', async () => {
        const hit = (f: Fake) => ({ walkTo: async (x: number, y: number) => { f.calls.push(`walkTo ${x},${y}`); f.set({ x, y, healthPercent: 60 }); return ok(); } });
        const group = [fake('Galahad', { ...at(10_000), healthPercent: 70 }, { stubs: hit }), fake('Nimue', at(10_200))];
        expect(await walkTogether(group.map(f => f.member), { x: 16_000, y: 10_000 })).toBe('attacked on leg 1/2 at (13000, 10000): Galahad 60%');
    });

    test('members apart or in another region do not set out', async () => {
        const group = [fake('Galahad', at(10_000)), fake('Nimue', at(12_000)), fake('Merlin', { ...at(10_100), regionId: 1 })];
        expect(await walkTogether(group.map(f => f.member), { x: 16_000, y: 10_000 })).toBe('not together: Nimue r9999 (12000, 10000), Merlin r1 (10100, 10000), more than 1500 from Galahad r9999 (10000, 10000)');
        expect(group.flatMap(f => f.calls)).toEqual([]);
    });
});
