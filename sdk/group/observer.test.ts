import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatReport, GroupObserver, saveReport } from './observer';
import { contact, picture, report } from './fixtures';
import type { MemberReport } from './types';

const T0 = 1_800_000_000_000;

function members(over: Partial<Record<string, Partial<MemberReport>>> = {}): MemberReport[] {
    return [
        report('Tank', { role: 'tank', objectId: 1, x: 0, ...over.Tank }),
        report('Druid', { role: 'healer', objectId: 2, x: 600, ...over.Druid }),
        report('Menta', { role: 'nuker', objectId: 4, x: 1000, ...over.Menta }),
    ];
}

describe('GroupObserver', () => {
    test('segments fights, scores tank hold, counts kills, xp and idle reasons', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        // 10 s of resting, then a 10 s fight (the tank holds it 8 of 10 samples, Menta idles 5), then calm.
        for (let i = 1; i <= 10; i++) o.sample(picture(members(), [], { seq: 1, phase: 'recover' }, T0 + i * 1000));
        for (let i = 11; i <= 20; i++) {
            const held = i <= 18;
            const mob = contact(7, { target: held ? 'Tank' : 'Menta', threat: true, x: held ? 0 : 1000 });
            const menta = { activity: { kind: i <= 15 ? 'idle' : 'nuke', targetId: null, detail: i <= 15 ? 'assist: waiting for the tank to hold it' : '', since: 0 } };
            o.sample(picture(members({ Menta: menta }), [mob], { seq: 2, phase: 'engage', focus: 7 }, T0 + i * 1000));
        }
        o.handle({ at: T0 + 20_500, kind: 'kill', member: 'Tank', targetId: 7, text: 'water beetle died', data: { name: 'water beetle' } });
        for (let i = 21; i <= 30; i++) o.sample(picture(members({ Tank: { experience: 1500 }, Druid: { experience: 1500 }, Menta: { experience: 1500 } }), [], { seq: 3, phase: 'recover' }, T0 + i * 1000));
        const r = o.report();
        expect(r.fights.length).toBe(1);
        expect(r.fights[0]!.kills).toEqual(['water beetle']);
        expect(r.fights[0]!.tankHold).toBe(80);
        expect(r.fights[0]!.outcome).toBe('won');
        expect(r.totals.kills).toBe(1);
        expect(r.members.Menta!.xp).toBe(500);
        expect(r.members.Menta!.idleInFights).toBe(50);
        expect(r.members.Menta!.targeted).toBe(20);
        expect(r.phases.engage).toBeGreaterThan(30);
        expect(r.findings.map(f => f.topic)).toContain('idle');
        expect(formatReport(r)).toContain('assist: waiting for the tank to hold it');
    });

    test('deaths, interrupts and retreats become findings with evidence', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        o.sample(picture(members(), [contact(7, { target: 'Druid', threat: true, x: 600 })], { seq: 1, phase: 'engage', focus: 7 }, T0 + 1000));
        for (let i = 0; i < 2; i++) o.handle({ at: T0 + 1200 + i, kind: 'result', member: 'Druid', text: 'heal: interrupted', data: { action: 'heal', success: false, reason: 'interrupted' } });
        o.handle({ at: T0 + 1500, kind: 'orders', text: 'retreat: the tank is dead', data: { phase: 'retreat' } });
        o.handle({ at: T0 + 1600, kind: 'death', member: 'Druid', text: 'Druid died' });
        o.sample(picture(members({ Druid: { isDead: true, hp: 0 } }), [], { seq: 2, phase: 'recover' }, T0 + 2000));
        const r = o.report();
        const topics = r.findings.map(f => f.topic);
        expect(topics).toEqual(expect.arrayContaining(['deaths', 'interrupts', 'retreats']));
        expect(r.findings.find(f => f.topic === 'deaths')!.evidence).toContain('Druid died');
        expect(r.fights[0]!.outcome).toBe('retreated');
        expect(r.fights[0]!.deaths).toEqual(['Druid']);
    });

    test('long waits for one member become a finding', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        for (let i = 1; i <= 10; i++) {
            const waiting = i <= 6 ? [{ name: 'Tank', why: 'health' }] : [];
            o.sample(picture(members(), [], { seq: 1, phase: i <= 6 ? 'recover' : 'pull', waiting }, T0 + i * 1000));
        }
        const r = o.report();
        expect(r.members.Tank!.waitedFor.health).toBe(60);
        const f = r.findings.find(x => x.topic === 'waiting')!;
        expect(f.member).toBe('Tank');
        expect(f.suggestion).toContain('heal.outOfCombat');
    });

    test('duplicate mezzes on one target are counted', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        o.sample(picture(members(), [], {}, T0 + 100));
        o.handle({ at: T0 + 1000, kind: 'activity', member: 'Tank', targetId: 9, text: 'cc', data: { activity: 'cc' } });
        o.handle({ at: T0 + 2000, kind: 'activity', member: 'Menta', targetId: 9, text: 'cc', data: { activity: 'cc' } });
        expect(o.report().members.Menta!.failures['cc:duplicate']).toBe(1);
    });

    test('saveReport writes json/md/log and compares with the previous run', () => {
        const dir = mkdtempSync(join(tmpdir(), 'group-'));
        const run = (kills: number) => {
            const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 + kills * 100_000 });
            o.sample(picture(members(), [], { seq: 1, phase: 'recover' }, T0 + kills * 100_000 + 60_000));
            for (let i = 0; i < kills; i++) o.handle({ at: T0, kind: 'kill', text: 'x died', data: { name: 'x' } });
            return o.report();
        };
        saveReport(dir, run(1), ['line one']);
        const second = run(2);
        const md = saveReport(dir, second);
        expect(second.previous?.killsPerHour).toBe('60→120');
        expect(readFileSync(md, 'utf-8')).toContain('Against the previous run');
        const files = readdirSync(join(dir, 'runs'));
        expect(files.filter(f => f.endsWith('.json')).length).toBe(2);
        expect(files.filter(f => f.endsWith('.log')).length).toBe(1);
        expect(readFileSync(join(dir, 'runs', 'history.jsonl'), 'utf-8').trim().split('\n').length).toBe(2);
    });
});
