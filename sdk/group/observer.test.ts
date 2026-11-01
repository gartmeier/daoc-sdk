import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatReport, GroupObserver, saveReport, stampOf } from './observer';
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

    // T9
    const act = (kind: string, since = 0) => ({ activity: { kind, targetId: kind === 'idle' ? null : 7, detail: '', since } });
    const wolf = contact(7, { target: 'Tank', threat: true, x: 0 });
    const calm = (o: GroupObserver, from: number) => { for (let i = 0; i < 3; i++) o.sample(picture(members(), [], { seq: 9, phase: 'recover' }, T0 + (from + i) * 1000)); };

    test('a nuker moving in 30% of engaged time gets a positioning finding; openerMs is its first nuke after the engage', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        // Engage from 1 s: Menta walks 3 of 10 samples and starts nuking at 3.7 s. The tank's walks don't count.
        for (let i = 1; i <= 10; i++) {
            const Menta = i <= 3 ? act('move', T0 + i * 1000) : act('nuke', T0 + 3700);
            o.sample(picture(members({ Menta, Tank: act(i <= 5 ? 'move' : 'melee') }), [wolf], { seq: 2, phase: 'engage', focus: 7 }, T0 + i * 1000));
        }
        calm(o, 11);
        const r = o.report();
        expect(r.members.Menta!.movingInFights).toBe(30);
        expect(r.members.Druid!.movingInFights).toBe(0);
        expect(r.members.Tank!.movingInFights).toBeNull();
        const pos = r.findings.filter(f => f.topic === 'positioning');
        expect(pos.map(f => f.member)).toEqual(['Menta']);
        expect(pos[0]!.issue).toContain('moving 30%');
        expect(pos[0]!.suggestion).toContain('slotSlack');
        // Healers that never nuke have no opener entry.
        expect(r.fights[0]!.openerMs).toEqual({ Menta: 2700 });
        expect(r.members.Menta!.openerMs).toBe(2700);
        expect(r.members.Menta!.fightsWithoutNuke).toBe(0);
        expect(r.members.Druid!.openerMs).toBeNull();
        const md = formatReport(r);
        expect(md).toContain('| 30% | 2.7 s |');
        expect(md).toContain('first nuke: Menta 2.7 s');
    });

    test('openerMs: median per member, exact from activity events, and fights without a nuke', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        const fight = (from: number, menta: (i: number) => ReturnType<typeof act>, events: [number, string][] = []) => {
            for (let i = from; i < from + 6; i++) {
                for (const [at, member] of events) if (at < T0 + i * 1000 && at >= T0 + (i - 1) * 1000) o.handle({ at, kind: 'activity', member, targetId: 7, text: 'nuke Moon Blast', data: { activity: 'nuke' } });
                o.sample(picture(members({ Menta: menta(i) }), [wolf], { seq: 2, phase: 'engage', focus: 7 }, T0 + i * 1000));
            }
            calm(o, from + 6);
        };
        // 1: seen in a sample, begun 2 s after the engage.
        fight(10, i => i >= 13 ? act('nuke', T0 + 12_000) : act('idle'));
        // 2: a short cast no sample shows (4.4 s); the later sampled nuke doesn't move it.
        fight(20, i => i >= 25 ? act('nuke', T0 + 24_900) : act('idle'), [[T0 + 24_400, 'Menta']]);
        // 3: no nuke at all.
        fight(30, () => act('idle'));
        const r = o.report();
        expect(r.fights.map(f => f.openerMs.Menta)).toEqual([2000, 4400, null]);
        expect(r.members.Menta!.openerMs).toBe(3200);
        expect(r.members.Menta!.fightsWithoutNuke).toBe(1);
        const md = formatReport(r);
        expect(md).toContain('3.2 s, 1 fights without');
        expect(md).toContain('first nuke: Menta none');
    });

    test('a nuke ahead of the first engage sample opens at 0; a passive watch records no openers', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        // The fight opens during the pull; the nuke event beats the sampler to the engage order.
        o.sample(picture(members(), [wolf], { seq: 1, phase: 'pull', focus: 7 }, T0 + 1000));
        o.handle({ at: T0 + 1500, kind: 'activity', member: 'Menta', targetId: 7, text: 'nuke', data: { activity: 'nuke' } });
        o.sample(picture(members({ Menta: act('nuke', T0 + 1500) }), [wolf], { seq: 2, phase: 'engage', focus: 7 }, T0 + 2000));
        calm(o, 3);
        // Observe mode: no orders, the phase is inferred, activities are unknown.
        for (let i = 10; i < 15; i++) o.sample(picture(members(), [wolf], {}, T0 + i * 1000));
        calm(o, 15);
        const r = o.report();
        expect(r.fights.length).toBe(2);
        expect(r.fights[0]!.openerMs).toEqual({ Menta: 0 });
        expect(r.fights[1]!.openerMs).toEqual({});
        expect(r.members.Menta!.fightsWithoutNuke).toBe(0);
    });

    test('snapshot() mid-fight shows the open fight and leaves the final report unchanged', () => {
        // The same samples and events into two observers; one is snapshotted mid-fight and after the kill.
        const feed = (o: GroupObserver, snap: boolean) => {
            const snaps: ReturnType<GroupObserver['snapshot']>[] = [];
            for (let i = 1; i <= 5; i++) o.sample(picture(members(), [], { seq: 1, phase: 'recover' }, T0 + i * 1000));
            for (let i = 6; i <= 15; i++) {
                const Menta = i >= 9 ? act('nuke', T0 + 8500) : act('idle');
                o.sample(picture(members({ Menta }), [wolf], { seq: 2, phase: 'engage', focus: 7 }, T0 + i * 1000));
                if (i === 7) o.handle({ at: T0 + 7200, kind: 'result', member: 'Menta', text: 'nuke: interrupted', data: { action: 'nuke', success: false, reason: 'interrupted' } });
                if (snap && i % 4 === 0) snaps.push(o.snapshot());
            }
            o.handle({ at: T0 + 15_500, kind: 'kill', member: 'Tank', targetId: 7, text: 'wolf died', data: { name: 'wolf' } });
            if (snap) snaps.push(o.snapshot());
            calm(o, 16);
            if (snap) snaps.push(o.snapshot());
            return snaps;
        };
        const a = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        const b = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        const snaps = feed(a, true);
        feed(b, false);
        const [early, , withKill, after] = snaps;
        expect(snaps.length).toBe(4);
        expect(early!.openFight).toBe(true);
        expect(early!.fights.length).toBe(1);
        expect(early!.fights[0]!.outcome).toBe('unfinished');
        expect(early!.totals.fights).toBe(1);
        expect(withKill!.fights[0]).toMatchObject({ kills: ['wolf'], outcome: 'won' });
        expect(after!.openFight).toBe(false);
        // Copies: changing one changes nothing inside the observer.
        early!.fights.length = 0;
        withKill!.members.Menta!.failures.x = 9;
        const final = a.report();
        expect(final).toEqual(b.report());
        expect(final.fights.length).toBe(1);
        expect(final.fights[0]).toMatchObject({ kills: ['wolf'], outcome: 'won', openerMs: { Menta: 2500 } });
        expect(final.members.Menta!.failures).toEqual({ 'nuke:interrupted': 1 });
        expect(after).toEqual({ ...final, openFight: false });
    });

    test('stampOf names a run by its start in UTC, the same from ms and from ISO text', () => {
        const at = Date.UTC(2026, 9, 31, 13, 37, 19, 450);
        expect(stampOf(at)).toBe('20261031-133719');
        expect(stampOf(new Date(at).toISOString())).toBe('20261031-133719');
        const dir = mkdtempSync(join(tmpdir(), 'group-'));
        try {
            const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: at });
            o.sample(picture(members(), [], { seq: 1, phase: 'recover' }, at + 1000));
            expect(saveReport(dir, o.report())).toBe(join(dir, 'runs', '20261031-133719.md'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('saveReport writes json/md/log and compares with the previous run', () => {
        const dir = mkdtempSync(join(tmpdir(), 'group-'));
        try {
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
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
