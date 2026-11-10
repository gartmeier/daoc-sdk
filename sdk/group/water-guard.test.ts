import { describe, expect, test } from 'bun:test';
import type { BotActions } from '../actions';
import { BotSDK, MOVE_GUARD_HERE } from '../index';
import { getTerrainStore } from '../terrain';
import { makeState } from '../test/fixtures';
import { Blackboard } from './blackboard';
import { MemberAgent } from './member';
import type { BotAction, Vec3 } from '../types';
import { bankCut, dryMoveGuard, isWet, staysDry } from './water';

// Thidranki's rivers from the client's terrain (bun run terrain:build); skipped without it.
const T = 252;
const terrain = getTerrainStore().available();
// The east river's north bank, where Albion fought Midgard in round 67: water starts some 400 south.
const bank = { regionId: T, x: 47_866, y: 39_266, z: 2000 };
const inRiver = { x: 47_866, y: 40_766, z: 1800 };
const back = { regionId: T, x: 47_866, y: 38_666, z: 2000 }; // 600 further from the water

/** A BotSDK that sends nothing: the actions it would send, and where it stands. */
function sdkAt(at: { regionId: number; x: number; y: number; z: number }) {
    const sdk = new BotSDK({ botUsername: 'guardtest' });
    const sent: BotAction[] = [];
    (sdk as any).sendAction = async (a: BotAction) => { sent.push(a); return { success: true, message: 'ok' }; };
    (sdk as any).getPlayer = () => at;
    return { sdk, sent };
}

describe('staysDry', () => {
    test('on unless it says otherwise, a flag string included', () => {
        expect(staysDry({})).toBe(true);
        expect(staysDry({ stayDry: true })).toBe(true);
        for (const off of [false, 'false', 'off', '0', 'no']) expect(staysDry({ stayDry: off })).toBe(false);
    });
});

describe('BotSDK move guard', () => {
    test('without a guard a move goes as asked; a guard\'s cut replaces it; removing the guard ends it', async () => {
        const { sdk, sent } = sdkAt(back);
        await sdk.sendMoveTo(1, 2, 3);
        expect(sent.at(-1)).toMatchObject({ type: 'moveTo', x: 1, y: 2, z: 3 });
        const off = sdk.setMoveGuard(() => ({ to: { x: 10, y: 20, z: 30 }, waypoints: [] }));
        await sdk.sendMoveTo(1000, 2000, 3, { tolerance: 50 });
        expect(sent.at(-1)).toMatchObject({ type: 'moveTo', x: 10, y: 20, z: 30, tolerance: 50, waypoints: [] });
        off();
        await sdk.sendMoveTo(1000, 2000, 3);
        expect(sent.at(-1)).toMatchObject({ x: 1000, y: 2000 });
    });

    test('a cut to where we stand is refused with reason water, and nothing is sent', async () => {
        const { sdk, sent } = sdkAt(back);
        sdk.setMoveGuard(() => ({ to: { x: back.x, y: back.y + MOVE_GUARD_HERE - 1 }, waypoints: [] }));
        const r = await sdk.sendMoveTo(back.x, back.y + 2000);
        expect(r.success).toBe(false);
        expect(r.reason).toBe('water');
        expect(sent.length).toBe(0);
    });

    test('a remover only removes its own guard', () => {
        const { sdk } = sdkAt(back);
        const first = sdk.setMoveGuard(() => null);
        const second = () => null;
        sdk.setMoveGuard(second);
        first();
        expect((sdk as any).moveGuard).toBe(second);
    });
});

describe.skipIf(!terrain)('dryMoveGuard in Thidranki', () => {
    const on = dryMoveGuard(() => ({ stayDry: true }));

    test('a cast approach from the bank to a swimmer ends on the bank, at our height', () => {
        expect(isWet(T, bank)).toBe(false);
        expect(isWet(T, inRiver)).toBe(true);
        const cut = on(bank, inRiver, [])!;
        expect(cut.waypoints).toEqual([]);
        expect(cut.to.x).toBe(bank.x);
        expect(cut.to.y).toBeGreaterThan(bank.y);
        expect(cut.to.y).toBeLessThan(inRiver.y);
        expect(cut.to.z).toBe(bank.z);
        expect(isWet(T, cut.to)).toBe(false);
        expect(isWet(T, { x: cut.to.x, y: cut.to.y + 150 })).toBe(true);
    });

    test('a flee step towards the water is cut to the last dry point, not refused', async () => {
        // 1500 south from 600 back from the bank: its end is in the river.
        const step = { x: back.x, y: back.y + 1500 };
        expect(isWet(T, step)).toBe(true);
        const { sdk, sent } = sdkAt(back);
        sdk.setMoveGuard(on);
        const r = await sdk.sendMoveTo(step.x, step.y, back.z, { tolerance: 30 });
        expect(r.success).toBe(true);
        const a = sent.at(-1) as Extract<BotAction, { type: 'moveTo' }>;
        expect(a.y).toBeGreaterThan(back.y + MOVE_GUARD_HERE);
        expect(a.y).toBeLessThan(step.y);
        expect(isWet(T, a)).toBe(false);
    });

    test('no cut for a dry end, for a swimmer, or with stayDry off', () => {
        expect(on(bank, { x: bank.x, y: 38_000 }, [])).toBeNull();
        expect(on({ regionId: T, ...inRiver }, bank, [])).toBeNull();
        expect(dryMoveGuard(() => ({ stayDry: 'false' }))(bank, inRiver, [])).toBeNull();
    });

    test('a crossing to the far bank is left alone, and one that ends in water keeps its waypoints up to the last bank', () => {
        // Straight south over the river: the samples along the line, wet in the middle and dry beyond.
        let far: Vec3 | null = null, wet = false;
        for (let y = bank.y; y < bank.y + 6000; y += 50) {
            const w = isWet(T, { x: bank.x, y });
            if (w) wet = true;
            else if (wet) { far = { x: bank.x, y: y + 400, z: 1900 }; break; }
        }
        expect(far).not.toBeNull();
        expect(isWet(T, far!)).toBe(false);
        expect(on(bank, far!, [])).toBeNull();
        expect(on(bank, far!, [{ x: inRiver.x, y: inRiver.y, z: 1800 }])).toBeNull();
        // On to a spot back in the same river from the far side: the waypoint on the far bank stays, the end is cut there.
        const cut = bankCut(T, bank, [far!, { x: far!.x, y: far!.y - 900, z: 1800 }]);
        if (isWet(T, { x: far!.x, y: far!.y - 900 })) {
            expect(cut!.kept).toEqual([far!]);
            expect(isWet(T, cut!.to)).toBe(false);
            expect(cut!.to.y).toBeLessThanOrEqual(far!.y);
        }
    });
});

describe('MemberAgent sets the dry guard', () => {
    const agentWith = (settings: Record<string, unknown>) => {
        const state = makeState({ gameMessages: [] });
        const guards: unknown[] = [];
        let removed = 0;
        const sdk = {
            getState: () => state, getPlayer: () => state.player, getSkills: () => ({}), getGameMessages: () => [], onStateUpdate: () => () => {}, isConnected: () => true,
            setMoveGuard: (g: unknown) => { guards.push(g); return () => { removed++; }; },
        } as unknown as BotSDK;
        const agent = new MemberAgent({ bot: 'testbot', role: 'healer', sdk, actions: { getSpellInfo: () => null } as unknown as BotActions }, new Blackboard(), [], settings as any);
        return { agent, guards, removed: () => removed };
    };

    test('with stayDry in the settings (RvR, the pack), and taken off on dispose', () => {
        const a = agentWith({ stayDry: true });
        expect(a.guards.length).toBe(1);
        a.agent.dispose();
        expect(a.removed()).toBe(1);
    });

    test('not for a strategy without stayDry (PvE: mobs in water are fair game)', () => {
        const a = agentWith({});
        expect(a.guards.length).toBe(0);
        a.agent.dispose();
    });
});
