import { describe, expect, test } from 'bun:test';
import { contact, picture, report } from '../fixtures';
import { decideRvr, realmCalls, RVR_SETTINGS, rvrRoaming, type RvrSettings } from '../rvr';
import { defencePlan } from '../siege';
import { mergeSettings, type CoordinatorContext } from '../strategy';
import type { GroupPicture, MemberReport, Orders } from '../types';
import { defendPatch, memberJobs, withDefenceStand } from './defend';
import { chooseCall, CALL_SETTINGS, type RealmCall } from './help';

const plan = defencePlan('albion')!;
const TH = plan.regionId;
const caps = (o: { heal?: boolean; nuke?: boolean } = {}) => ({ heal: !!o.heal, cc: false, nuke: !!o.nuke, buffs: [], buffSpells: [] });
/** Five Albions round (x, y) on the island's east bank. */
function five(x = 36000, y = 38300): MemberReport[] {
    const roles = [['Tank', 'tank', caps()], ['Cleric', 'healer', caps({ heal: true })], ['Wiz', 'nuker', caps({ nuke: true })], ['Merc', 'melee', caps()], ['Sorc', 'nuker', caps({ nuke: true })]] as const;
    return roles.map(([name, role, c], i) => report(name, { role, className: 'Armsman', realm: 'albion', objectId: 100 + i, regionId: TH, x: x + i * 40, y, z: 3300, level: 24, capabilities: c } as any));
}
const defend: RealmCall = { id: 'albion-9', kind: 'defend', from: 'director', why: 'keep', at: { x: 33089, y: 38271, z: 3700 }, target: { x: 33089, y: 38271, z: 3700 }, foes: 4, ours: 0, want: 0, asked: ['camelot'] };

describe('the defence call, the units\' side (S3, 2026-11-13)', () => {
    test('jobs from the report: its own when given, else heal for a healer, the wall for a caster, the yard for all', () => {
        expect(memberJobs({ role: 'healer', capabilities: caps({ heal: true }) as any })).toEqual(['heal', 'yard']);
        expect(memberJobs({ role: 'nuker', capabilities: caps({ nuke: true }) as any })).toEqual(['wall', 'yard']);
        expect(memberJobs({ role: 'melee', capabilities: caps({ nuke: true }) as any })).toEqual(['yard']);
        expect(memberJobs({ role: 'nuker', capabilities: { ...caps({ nuke: true }), defence: ['bomb', 'wall', 'yard'] } as any })).toEqual(['bomb', 'wall', 'yard']);
    });

    test('a defend call that asks us comes first; one that doesn\'t is no call of ours', () => {
        const help: RealmCall = { id: 'albion-3', kind: 'help', from: 'camelot-2', why: 'caught', at: { x: 36000, y: 38000, z: 0 }, foes: 3, ours: 1, want: 3, asked: ['camelot'] };
        expect(chooseCall([help, defend], 'camelot', { x: 36000, y: 38300 }, CALL_SETTINGS)?.id).toBe('albion-9');
        expect(chooseCall([{ ...defend, asked: ['camelot-2'] }], 'camelot', { x: 36000, y: 38300 }, CALL_SETTINGS)).toBeNull();
    });

    test('defendPatch seats every member by name; the same object tick to tick', () => {
        const mem: Record<string, any> = {};
        const a = defendPatch(mem, 'albion', five(), [])!;
        expect(Object.keys(a.seats).sort()).toEqual(['Cleric', 'Merc', 'Sorc', 'Tank', 'Wiz']);
        expect(a.seats.Cleric!.job).toBe('heal');
        expect(a.seats.Wiz!.job).toBe('wall');
        expect(a.seats.Tank!.job).toBe('yard');
        expect(defendPatch(mem, 'albion', five(), [])).toBe(a);
    });

    test('realmCalls: answering it, the orders carry the seats and no anchor; the group neither hunts nor falls back; the stand behaviour comes first', () => {
        const { strategy } = realmCalls(rvrRoaming as any, 'camelot', { calls: () => [defend], answer: () => {} });
        const ctx = (p: GroupPicture, memory: Record<string, any>, orders: Partial<Orders> = {}): CoordinatorContext<RvrSettings> =>
            ({ picture: p, orders: { ...p.orders, ...orders }, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, {} as any) });
        const memory: Record<string, any> = {};
        let o = strategy.decide(ctx(picture(five()), memory));
        expect((o.settings as any)?.defence?.seats?.Wiz?.job).toBe('wall');
        expect(o.anchor).toBeNull();
        expect(o.reason).toContain('the defence of our keep');
        // Seven Midgard 3000 out: no hunt and no fall back while defending.
        const seven = [1, 2, 3, 4, 5, 6, 7].map(i => contact(500 + i, { kind: 'player', realm: 'midgard', name: 'Norseman', level: 24, regionId: TH, x: 39500 + i * 30, y: 38300, z: 3300, hp: 100 }));
        o = strategy.decide(ctx(picture(five(), seven), memory));
        expect(o.reason).not.toMatch(/^(fall back|hunt)/);
        expect((o.settings as any)?.defence).toBeDefined();
        expect(strategy.behaviors.tank.map(b => b.name).slice(0, 2)).toEqual(['release', 'defence-stand']);
        // Without the call: decideRvr alone hunts or falls back as before.
        expect(decideRvr(ctx(picture(five(), seven), {})).reason).toMatch(/^(fall back|hunt|wait ashore)/);
        expect(withDefenceStand([]).map(b => b.name)).toEqual(['defence-stand']);
    });

    test('defending, the group fights only enemies within the keep reach: not two gate-breakers out at the stage (S2 rehearsal)', () => {
        const { strategy } = realmCalls(rvrRoaming as any, 'camelot', { calls: () => [defend], answer: () => {} });
        const ctx = (p: GroupPicture, memory: Record<string, any>): CoordinatorContext<RvrSettings> =>
            ({ picture: p, orders: p.orders, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, {} as any) });
        const inside = five(33600, 38300);
        const at = (id: number, x: number, y: number) => contact(id, { kind: 'player', realm: 'midgard', name: 'Norseman', level: 24, regionId: TH, x, y, z: 3300, hp: 100 });
        const memory: Record<string, any> = {};
        strategy.decide(ctx(picture(inside), memory));
        expect(strategy.decide(ctx(picture(inside, [at(601, 36300, 38300), at(602, 36350, 38300)]), memory)).phase).not.toBe('engage');
        const o = strategy.decide(ctx(picture(inside, [at(603, 34300, 38275)]), memory));
        expect(o).toMatchObject({ phase: 'engage', focus: 603 });
    });
});
