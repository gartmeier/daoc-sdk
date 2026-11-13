import { describe, expect, test } from 'bun:test';
import { picture, report } from './fixtures';
import { decideRvr, homeOf, realmCalls, RVR_SETTINGS, type RvrSettings } from './rvr';
import { mergeSettings, type CoordinatorContext, type GroupStrategy } from './strategy';
import { CALL_SETTINGS, helpStep, WIPED_LEAVE_MS, type CallSource, type RealmCall } from './tactics/help';
import type { GroupPicture, MemberReport, Point } from './types';

// The user, playing Niamh at 20:12 and 20:15: after the wipe at the Faste, hibernia went straight back out on the same muster
// from our portal keep, twice, without the user: "they just left without me".
const T = 252;
const home = homeOf(T, 'hibernia')!.arrival;
const caps = { heal: false, cc: false, nuke: true, buffs: [], buffSpells: [] };
const team = (at: Point, dead: number, over: Partial<Record<string, Partial<MemberReport>>> = {}): MemberReport[] => ['Tank', 'Druid', 'Bard', 'Menta', 'Encha'].map((n, i) =>
    report(n, { role: i ? 'nuker' : 'tank', className: i ? 'Eldritch' : 'Hero', objectId: i + 1, regionId: T, x: at.x + i * 40, y: at.y, z: home.z, level: 24, capabilities: caps, ...(i >= 5 - dead ? { isDead: true, hp: 0 } : {}), ...over[n] }));
const muster: RealmCall = { id: 'hibernia-72', kind: 'muster', from: 'director', why: 'raid', at: { x: 28_454, y: 32_768, z: 3208 }, stage: 'go', target: { x: 33_089, y: 38_271, z: 3720 }, foes: 0, ours: 0, want: 0, asked: ['hibernia'], since: 1000 };
const ctx = (p: GroupPicture, memory: Record<string, any>): CoordinatorContext<RvrSettings> =>
    ({ picture: p, orders: p.orders, memory, now: p.at, windingDown: false, settings: mergeSettings(RVR_SETTINGS, { patrol: null } as any) });

describe('a wiped unit leaves its raid, this sortie and the next (S3, the user at 20:12)', () => {
    test('half of us dead on the muster at go: left "wiped", and not answered again', () => {
        const answers: { id: string; state: string; why?: string }[] = [];
        const src: CallSource = { calls: () => [muster], answer: (id, state, why) => { answers.push({ id, state, why }); } };
        const idle: GroupStrategy<RvrSettings> = { name: 'idle', description: '', settings: RVR_SETTINGS, behaviors: { tank: [], healer: [], support: [], nuker: [], melee: [] }, decide: () => ({ phase: 'idle', reason: 'idle' }) } as any;
        const { strategy } = realmCalls(idle, 'hibernia', src);
        const mem: Record<string, any> = { help: { id: muster.id, kind: 'muster', state: 'arrived', since: 2000 } };
        strategy.decide(ctx(picture(team({ x: 31_000, y: 36_000 }, 3)), mem));
        expect(answers).toEqual([{ id: 'hibernia-72', state: 'left', why: 'wiped: 3 of 5 dead' }]);
        expect(mem.help).toBeUndefined();
        expect(mem.helpLeft['hibernia-72']).toBeGreaterThan(Date.now() + WIPED_LEAVE_MS - 60_000);
    });

    test('a new sortie (fresh memory) reads the leave from the answers (CallSource.wiped): no answer to that muster', () => {
        const now = 100_000;
        const mem: Record<string, any> = { realmCalls: [muster], helpWiped: { 'hibernia-72': now - 60_000 } };
        expect(helpStep(mem, { unit: 'hibernia', centre: home, now, settings: CALL_SETTINGS, free: true })).toBeNull();
        // A call opened after the leave (a new director reusing the id) is answered.
        const later = { ...muster, since: now - 1000 };
        expect(helpStep({ realmCalls: [later], helpWiped: { 'hibernia-72': now - 60_000 } }, { unit: 'hibernia', centre: home, now, settings: CALL_SETTINGS, free: true })).not.toBeNull();
    });
});

describe('full force first: at our portal keep the group waits for the dead and the released (S3, the user at 20:12)', () => {
    test('one released out of view (another region): wait, up to 2 min from arriving; then on', () => {
        const members = team(home, 0, { Encha: { regionId: -1 } });
        const mem: Record<string, any> = { realm: 'hibernia', realmCalls: [muster], help: { id: muster.id, kind: 'muster', state: 'arrived', since: 2000 } };
        const p = picture(members);
        const u = decideRvr(ctx(p, mem));
        expect(u.reason).toMatch(/^full force first: waiting at our portal keep for Encha, 120 s at most/);
        const later = decideRvr({ ...ctx(picture(members, [], {}, p.at + 121_000), mem) });
        expect(later.reason).not.toMatch(/^full force first/);
    });
});

describe('never a raid without our human (S1, 20:3x)', () => {
    test('the muster at go with the observed member out of the region: the raid holds; with her: on', () => {
        const rally = { x: 28_454, y: 32_768 };
        const mem = () => ({ realm: 'hibernia', realmCalls: [muster], help: { id: muster.id, kind: 'muster', state: 'arrived', since: 2000 } } as Record<string, any>);
        const away = decideRvr(ctx(picture(team(rally, 0, { Encha: { observed: true, regionId: -1 } })), mem()));
        expect(away.reason).toMatch(/^raid held: waiting for Encha/);
        const there = decideRvr(ctx(picture(team(rally, 0, { Encha: { observed: true } })), mem()));
        expect(there.reason).toMatch(/^raid /);
    });
});
