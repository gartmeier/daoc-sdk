import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findingsFor, formatReport, GroupObserver, saveReport, stampOf, type RunReport } from './observer';
import { contact, enemy, picture, report } from './fixtures';
import type { Capabilities, GroupEvent, MemberReport, PetReport } from './types';
import { getTerrainStore } from '../terrain';
import { BATTLEGROUND_LAYOUTS } from './keeps';

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

    test('a walk to a crowd-control target is no positioning: combatRange has nothing to say about it', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        for (let i = 1; i <= 10; i++) {
            const Menta = i <= 3 ? { activity: { kind: 'move', targetId: 8, detail: 'cc: into range for Hold Spirit', since: T0 + i * 1000 } } : act('nuke', T0 + 3700);
            o.sample(picture(members({ Menta }), [wolf], { seq: 2, phase: 'engage', focus: 7 }, T0 + i * 1000));
        }
        calm(o, 11);
        const r = o.report();
        expect(r.members.Menta!.movingInFights).toBe(0);
        expect(r.findings.filter(f => f.topic === 'positioning' && f.member === 'Menta')).toEqual([]);
    });

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

    const rvrRun = (strategy = 'rvr', startedAt = T0, rpGain = 1) => {
        const o = new GroupObserver(null, { group: 'g', strategy, startedAt });
        const at = (i: number) => startedAt + i * 1000;
        const rp = (tank: number, druid: number) => members({ Tank: { realmPoints: tank }, Druid: { realmPoints: druid }, Menta: { realmPoints: 0 } });
        const enemy = (objectId: number, over: Parameters<typeof contact>[1] = {}) => contact(objectId, { kind: 'player', name: 'Norseman', realm: 'midgard', threat: true, ...over });
        // Roaming with an enemy far off, a 10 s skirmish with two Midgard players and a Hibernian, roaming again.
        for (let i = 1; i <= 10; i++) o.sample(picture(rp(100, 50), [enemy(300, { threat: false, x: 9000 })], { seq: 1, phase: 'travel' }, at(i)));
        for (let i = 11; i <= 20; i++) {
            const enemies = [enemy(300, { target: 'Druid' }), enemy(301, { target: 'Menta' }), enemy(310, { name: 'Celt', realm: 'hibernia' })];
            o.sample(picture(rp(100, 50), enemies, { seq: 2, phase: 'engage', focus: 300 }, at(i)));
        }
        o.handle({ at: at(15), kind: 'kill', member: 'Tank', targetId: 300, text: 'Norseman (L20) died', data: { name: 'Norseman', level: 20, kind: 'player', realm: 'midgard' } });
        o.handle({ at: at(18), kind: 'death', member: 'Druid', text: 'Druid died', data: { killer: { name: 'Celt', kind: 'player', realm: 'hibernia' } } });
        o.handle({ at: at(19), kind: 'death', member: 'Menta', text: 'Menta died', data: { killer: { name: 'mature boar', kind: 'npc', realm: 'none' } } });
        for (let i = 21; i <= 30; i++) o.sample(picture(rp(100 + 300 * rpGain, 150), [], { seq: 3, phase: 'travel' }, at(i)));
        return o.report();
    };

    // Thidranki's river between Hibernia and Midgard, from the client's terrain (bun run terrain:build); skipped without it.
    test.skipIf(!getTerrainStore().available())('RvR: time in water, ours and the enemies\', per fight and member, and fights with both other realms', () => {
        const river = BATTLEGROUND_LAYOUTS[252]!.pairs!['hibernia|midgard']!;
        const land = BATTLEGROUND_LAYOUTS[252]!.arrival.hibernia;
        const o = new GroupObserver(null, { group: 'g', strategy: 'rvr', startedAt: T0 });
        const at = (i: number) => T0 + i * 1000;
        // Tank and Druid in the river, Menta on land; a Midgard player in the river and a Hibernian on land; 10 s of it, then 10 s of travel on land.
        const ms = (wet: boolean) => members({
            Tank: { regionId: 252, ...(wet ? river : land) }, Druid: { regionId: 252, ...(wet ? river : land) }, Menta: { regionId: 252, ...land },
        });
        const foes = [
            contact(300, { kind: 'player', name: 'Norseman', realm: 'midgard', threat: true, target: 'Tank', regionId: 252, ...river }),
            contact(310, { kind: 'player', name: 'Celt', realm: 'hibernia', threat: true, target: 'Menta', regionId: 252, ...land }),
        ];
        for (let i = 1; i <= 10; i++) o.sample(picture(ms(true), foes, { seq: 2, phase: 'engage', focus: 300 }, at(i)));
        for (let i = 11; i <= 20; i++) o.sample(picture(ms(false), [], { seq: 3, phase: 'travel' }, at(i)));
        const r = o.report();
        expect(r.totals).toMatchObject({ wetInFights: 67, enemiesWetInFights: 50, threeWay: 1 });
        expect(r.totals.wetPct).toBe(Math.round(100 * 20 / 60));
        expect(r.fights[0]).toMatchObject({ wetPct: 67, enemyWetPct: 50 });
        expect(r.members.Tank).toMatchObject({ wetPct: 50, wetInFights: 100 });
        expect(r.members.Menta).toMatchObject({ wetPct: 0, wetInFights: 0 });
        const md = formatReport(r);
        expect(md).toContain('Water: we swam 33% of the time alive and 67% of fight time, the enemies in our fights 50%. Fights with both other realms: 1 of 1.');
        expect(md).toContain('in water: us 67%, them 50%');
    });

    test('RvR: player kills, deaths to players, realm points, enemies seen and engagements; killers per member', () => {
        const r = rvrRun();
        expect(r.totals).toMatchObject({ kills: 1, playerKills: 1, deathsToPlayers: 1, realmPoints: 400, rpPerHour: 48_000, enemiesSeen: 3, engagements: 1 });
        expect(r.fights.map(f => [f.enemyPlayers, f.enemyRealms])).toEqual([[3, ['hibernia', 'midgard']]]);
        expect(Object.fromEntries(Object.entries(r.members).map(([n, m]) => [n, [m.realmPoints, m.killedBy]]))).toEqual({
            Tank: [300, undefined], Druid: [100, { 'player:hibernia': 1 }], Menta: [0, { 'npc:mature boar': 1 }],
        });
        const md = formatReport(r);
        expect(md).toContain('RvR: 3 enemy players seen, 1 engagements, 1 player kills, 1 deaths to players, 400 realm points (48000/h).');
        expect(md).toContain('- Druid: 100 RP, killed by player:hibernia (1)');
        expect(md).toContain('- Tank: 300 RP\n');
        expect(md).toContain('3 enemy players (hibernia, midgard)');
    });

    test('RvR: the PvE-only findings stay out; deaths name the killers', () => {
        const r = rvrRun();
        const topics = r.findings.map(f => f.topic);
        // As PvE, this run would have aggro (the focus on the Druid), adds (two more attackers) and downtime (20 s of 30 roaming).
        expect(topics).not.toContain('aggro');
        expect(topics).not.toContain('adds');
        expect(topics).not.toContain('downtime');
        expect(topics.filter(t => t === 'deaths').length).toBe(2);
        expect(r.findings.find(f => f.member === 'Druid')!.evidence).toStartWith('killed by player:hibernia (1); ');
    });

    test('a PvE run gets no RvR fields, even with realm points in the reports; killedBy lists every death', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        for (let i = 1; i <= 5; i++) o.sample(picture(members({ Tank: { realmPoints: 70 } }), [contact(7, { target: 'Tank', threat: true })], { seq: 1, phase: 'engage', focus: 7 }, T0 + i * 1000));
        o.handle({ at: T0 + 3000, kind: 'death', member: 'Druid', text: 'Druid died', data: { killer: { name: 'wolf', kind: 'npc', realm: 'none' } } });
        o.handle({ at: T0 + 4000, kind: 'death', member: 'Menta', text: 'Menta died' });
        const r = o.report();
        for (const k of ['playerKills', 'deathsToPlayers', 'realmPoints', 'rpPerHour', 'enemiesSeen', 'engagements']) expect(k in r.totals).toBe(false);
        expect('enemyPlayers' in r.fights[0]!).toBe(false);
        expect('realmPoints' in r.members.Tank!).toBe(false);
        expect(r.members.Druid!.killedBy).toEqual({ 'npc:wolf': 1 });
        expect(r.members.Menta!.killedBy).toEqual({ unknown: 1 });
        expect(r.findings.find(f => f.member === 'Druid')!.evidence).not.toContain('killed by');
        const md = formatReport(r);
        expect(md).not.toContain('RvR');
        expect(md).not.toContain('RP');
    });

    test('a retreat counts once however many legs it runs, and once more only after it ended for a while', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 'rvr', startedAt: T0 });
        const orders = (s: number, phase: string) => o.handle({ at: T0 + s * 1000, kind: 'orders', text: `${phase}: r`, data: { phase } });
        o.sample(picture(members(), [], { seq: 1, phase: 'engage' }, T0 + 1000));
        // One retreat, four legs (decideRvr re-issues retreatTo 3000 further each time), a tick of engage, more legs.
        orders(1, 'engage');
        for (const s of [2, 4, 6, 8]) orders(s, 'retreat');
        orders(9, 'engage');
        orders(10, 'retreat');
        expect(o.report().totals.retreats).toBe(1);
        // Over: travel for a minute, then outnumbered again.
        orders(12, 'travel');
        orders(70, 'retreat');
        orders(72, 'retreat');
        expect(o.report().totals.retreats).toBe(2);
    });

    test('a death to an enemy realm\'s pet or keep guard is a death to players: pet:<realm> by the pet flag, else guard:<realm>', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 'rvr', startedAt: T0 });
        o.sample(picture(members(), [contact(300, { kind: 'player', name: 'Norseman', realm: 'midgard' })], { seq: 1, phase: 'engage' }, T0 + 1000));
        // A Spiritmaster's pet lands the blow: 0xAE names its owner (GameLiving.cs:1299-1300), and killerOf takes the pet back from the hits before it.
        o.handle({ at: T0 + 1500, kind: 'death', member: 'Druid', text: 'Druid died', data: { killer: { name: 'earthen spirit', kind: 'npc', realm: 'midgard', isPet: true } } });
        o.handle({ at: T0 + 1550, kind: 'death', member: 'Tank', text: 'Tank died', data: { killer: { name: 'Guard Ulf', kind: 'npc', realm: 'midgard' } } });
        o.handle({ at: T0 + 1600, kind: 'death', member: 'Menta', text: 'Menta died', data: { killer: { name: 'mature boar', kind: 'npc', realm: 'none' } } });
        const r = o.report();
        expect(r.totals.deathsToPlayers).toBe(2);
        expect(r.members.Druid!.killedBy).toEqual({ 'pet:midgard': 1 });
        expect(r.members.Tank!.killedBy).toEqual({ 'guard:midgard': 1 });
        expect(r.members.Menta!.killedBy).toEqual({ 'npc:mature boar': 1 });
    });

    // 20261103-181211: JSON killedBy guard:albion, deathsToPlayers 2; the .md had "Evidence: 00:24 Petbon: Petbon died", no killer and no RvR line.
    test('deaths to a keep\'s guards with no enemy player seen: the report has the RvR line and the killers', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        for (let i = 1; i <= 5; i++) o.sample(picture(members(), [], { seq: 1, phase: 'travel' }, T0 + i * 1000));
        for (const member of ['Tank', 'Druid']) o.handle({ at: T0 + 3000, kind: 'death', member, text: `${member} died`, data: { killer: { name: 'Guard Ulf', kind: 'npc', realm: 'albion' } } });
        const r = o.report();
        expect(r.totals.deathsToPlayers).toBe(2);
        const md = formatReport(r);
        expect(md).toContain('RvR: 0 enemy players seen, 0 engagements, 0 player kills, 2 deaths to players');
        expect(md).toContain('- Tank: 0 RP, killed by guard:albion (1)');
        expect(r.findings.find(f => f.member === 'Druid')!.evidence).toStartWith('killed by guard:albion (1)');
    });

    test('a stray death to a guard in a hunt says who, and leaves the hunt its PvE findings', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        for (let i = 1; i <= 70; i++) o.sample(picture(members(), [], { seq: 1, phase: 'travel' }, T0 + i * 1000));
        o.handle({ at: T0 + 3000, kind: 'death', member: 'Druid', text: 'Druid died', data: { killer: { name: 'Guard Ulf', kind: 'npc', realm: 'albion' } } });
        const r = o.report();
        expect(r.findings.map(f => f.topic)).toContain('no-kills');
        expect(formatReport(r)).toContain('killed by guard:albion (1)');
    });

    test('a PvE report lists its killers too, with nothing of RvR', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        for (let i = 1; i <= 5; i++) o.sample(picture(members(), [contact(7, { target: 'Tank', threat: true })], { seq: 1, phase: 'engage', focus: 7 }, T0 + i * 1000));
        o.handle({ at: T0 + 3000, kind: 'death', member: 'Druid', text: 'Druid died', data: { killer: { name: 'wolf', kind: 'npc', realm: 'none' } } });
        const md = formatReport(o.report());
        expect(md).toContain('Deaths by killer:');
        expect(md).toContain('- Druid: npc:wolf (1)');
        expect(md).not.toContain('RvR');
        expect(md).not.toContain('RP');
        // No deaths: no such list.
        const calm = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
        calm.sample(picture(members(), [], { seq: 1, phase: 'travel' }, T0 + 1000));
        expect(formatReport(calm.report())).not.toContain('Deaths by killer');
    });

    test('the strategy\'s findings join the report; one that throws becomes a finding itself', () => {
        const sample = (o: GroupObserver) => { o.sample(picture(members(), [], { seq: 1, phase: 'recover' }, T0 + 1000)); return o; };
        const own = { severity: 'low' as const, topic: 'roam', issue: 'Roamed 1 s', evidence: '1 sample', suggestion: 'Roam longer.' };
        const r = sample(new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0, findings: rep => [{ ...own, evidence: `${rep.durationMs} ms` }] })).report();
        expect(r.findings.at(-1)).toEqual({ ...own, evidence: '1000 ms' });
        expect(formatReport(r)).toContain('[roam] Roamed 1 s.');
        const broken = sample(new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0, findings: () => { throw new Error('no settings'); } })).report();
        expect(broken.findings.at(-1)).toMatchObject({ topic: 'strategy', issue: 'The strategy\'s findings() threw: no settings' });
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
            // PvE against PvE: no RvR keys.
            expect(Object.keys(second.previous!)).not.toContain('playerKills');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('an RvR run compares player kills, deaths to players and realm points per hour with the previous one', () => {
        const dir = mkdtempSync(join(tmpdir(), 'group-'));
        try {
            saveReport(dir, rvrRun('rvr', T0, 1));
            const second = rvrRun('rvr', T0 + 100_000, 2);
            const md = saveReport(dir, second);
            expect(second.previous).toMatchObject({ playerKills: '1→1', deathsToPlayers: '1→1', rpPerHour: '48000→84000' });
            expect(readFileSync(md, 'utf-8')).toContain('rpPerHour 48000→84000');
            expect(JSON.parse(readFileSync(join(dir, 'runs', 'history.jsonl'), 'utf-8').trim().split('\n')[1]!)).toMatchObject({ playerKills: 1, rpPerHour: 84_000, enemiesSeen: 3 });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('GroupObserver: pets', () => {
    const caps = (pet: Capabilities['pet']): Capabilities => ({ heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], pet });
    const petOf = (over: Partial<PetReport> = {}): PetReport => ({ objectId: 500, name: 'spirit soldier', level: 17, x: 1000, y: 1000, z: 0, hp: 84, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [], ...over });
    /** Menta with `pet` up (null: none), and a summon of its kind in her spell list. */
    const owner = (pet: PetReport | null, over: Partial<MemberReport> = {}) => members({ Menta: { pet, capabilities: caps('main'), ...over } });
    const observer = () => new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0 });
    const wolf = (over: Parameters<typeof contact>[1] = {}) => contact(7, { name: 'wolf', target: 'Tank', threat: true, x: 0, ...over });
    const engage = { seq: 2, phase: 'engage' as const, focus: 7 };
    const quiet = { seq: 1, phase: 'recover' as const };
    const died: GroupEvent = { at: T0, kind: 'note', member: 'Menta', text: 'Menta lost spirit soldier (died)', data: { pet: 'lost', name: 'spirit soldier', cause: 'died' } };
    const released: GroupEvent = { ...died, text: 'Menta lost spirit soldier (released)', data: { pet: 'lost', name: 'spirit soldier', cause: 'released' } };
    const summoned: GroupEvent = { at: T0, kind: 'result', member: 'Menta', text: 'summon: ok', data: { action: 'summon', success: true, reason: null } };
    const broke: GroupEvent = { at: T0, kind: 'note', member: 'Menta', targetId: 7, text: 'Menta\'s pet broke the mezz on wolf', data: { petBrokeCc: true, kind: 'mezz', by: 'Druid' } };

    test('up %, on focus % in engage, deaths, summons and broken cc, per member; a snapshot leaves them as they are', () => {
        const o = observer();
        // 4 s with no pet, 6 s up, then 10 s engaged with the pet on the focus for the last 8.
        for (let i = 1; i <= 4; i++) o.sample(picture(owner(null), [], quiet, T0 + i * 1000));
        for (let i = 5; i <= 10; i++) o.sample(picture(owner(petOf()), [], quiet, T0 + i * 1000));
        for (let i = 11; i <= 20; i++) o.sample(picture(owner(petOf({ targetId: i > 12 ? 7 : null })), [wolf()], engage, T0 + i * 1000));
        for (const e of [summoned, died, released, broke]) o.handle(e);
        const before = o.snapshot().members.Menta!.pet;
        const r = o.report();
        expect(r.members.Menta!.pet).toEqual({ kind: 'main', name: 'spirit soldier', up: 80, onFocus: 80, focusSamples: 10, drewFocus: 0, deaths: 1, summons: 1, brokeCc: 1 });
        expect(before).toEqual(r.members.Menta!.pet);
        expect(r.members.Druid!.pet).toBeUndefined();
    });

    test('a dead owner\'s samples don\'t count against pet up: its pet goes with it (GamePlayer.cs:5988-5989)', () => {
        const o = observer();
        for (let i = 1; i <= 5; i++) o.sample(picture(owner(petOf()), [], quiet, T0 + i * 1000));
        for (let i = 6; i <= 10; i++) o.sample(picture(owner(null, { isDead: true, hp: 0 }), [], quiet, T0 + i * 1000));
        expect(o.report().members.Menta!.pet!.up).toBe(100);
    });

    test('on focus counts what it may go for: not a crowd-controlled focus, none, or outside the engage', () => {
        const o = observer();
        const on = petOf({ targetId: 7 });
        for (let i = 1; i <= 4; i++) o.sample(picture(owner(petOf()), [wolf()], engage, T0 + i * 1000));
        for (let i = 5; i <= 6; i++) o.sample(picture(owner(on), [wolf()], engage, T0 + i * 1000));
        o.sample(picture(owner(petOf()), [wolf({ cc: { by: 'Druid', kind: 'mezz', until: T0 + 60_000 } })], engage, T0 + 7000));
        o.sample(picture(owner(petOf()), [], { seq: 2, phase: 'engage', focus: null }, T0 + 8000));
        o.sample(picture(owner(on), [wolf()], { seq: 3, phase: 'pull', focus: 7 }, T0 + 9000));
        expect(o.report().members.Menta!.pet).toMatchObject({ onFocus: 33, focusSamples: 6 });
    });

    test('with no such sample on focus is unknown, not 0', () => {
        const o = observer();
        o.sample(picture(owner(petOf()), [], quiet, T0 + 1000));
        expect(o.report().members.Menta!.pet).toMatchObject({ onFocus: null, focusSamples: 0, up: 100 });
    });

    test('a client from before pets reports none either way: up is unknown, and no pet-down', () => {
        const o = observer();
        o.sample(picture(members({ Menta: { capabilities: caps('main') } }), [], quiet, T0 + 120_000));
        const r = o.report();
        expect(r.members.Menta!.pet).toMatchObject({ kind: 'main', up: null });
        expect(r.findings.map(f => f.topic)).not.toContain('pet-down');
        expect(formatReport(r)).toContain('| Menta | main | - | - | - | 0 | 0 | 0 | 0 |');
    });

    test('hold metric: a focus on a pet counts as not held; a focus on nobody still isn\'t a sample', () => {
        const o = observer();
        for (let i = 1; i <= 6; i++) o.sample(picture(owner(petOf()), [wolf()], engage, T0 + i * 1000));
        for (let i = 7; i <= 10; i++) o.sample(picture(owner(petOf()), [wolf({ target: null, targetPet: 'Menta' })], engage, T0 + i * 1000));
        for (let i = 11; i <= 14; i++) o.sample(picture(owner(petOf()), [wolf({ target: null, targetPet: null })], engage, T0 + i * 1000));
        const r = o.report();
        expect(r.fights[0]!.tankHold).toBe(60);
        expect(r.totals.tankHold).toBe(60);
        expect(r.members.Menta!.pet!.drewFocus).toBe(40);
        const aggro = r.findings.find(f => f.topic === 'aggro')!;
        expect(aggro.evidence).toContain('on pets 40%');
    });

    test('pet damage goes in MemberStats and the Pets table; a window pet from an earlier script reports too, with no kind', () => {
        const o = observer();
        const combat = { dealt: 40, styles: {}, missedStyles: 0, petDealt: 123 };
        const ms = members({ Menta: { pet: petOf(), combat }, Druid: { pet: petOf({ objectId: 501, name: 'wolf sage' }), combat: { dealt: 7, styles: {}, missedStyles: 0 } } });
        o.sample(picture(ms, [], quiet, T0 + 1000));
        const r = o.report();
        expect(r.members.Menta).toMatchObject({ dealt: 40, petDealt: 123, pet: { kind: null, up: 100 } });
        expect(r.members.Druid!.pet!.kind).toBeNull();
        expect('petDealt' in r.members.Druid!).toBe(false);
        const md = formatReport(r);
        expect(md).toContain('## Pets');
        expect(md).toContain('| Member | Pet | Up | On focus | Drew the focus | Damage dealt | Died | Summons | Broke cc |');
        expect(md).toContain('| Menta | spirit soldier | 100% | - | - | 123 | 0 | 0 | 0 |');
        expect(md).toContain('| Druid | wolf sage | 100% | - | - | 0 | 0 | 0 | 0 |');
        // Only those with a pet get a row.
        expect(md.slice(md.indexOf('## Pets'))).not.toContain('| Tank | ');
    });

    test('a Theurgist: no window, so up and on focus are unknown; summons are new ids; no pet-down or pet-idle', () => {
        const o = observer();
        const theurgist = (summons: number[] | undefined) => members({ Menta: { pet: null, capabilities: caps('fnf'), summons, combat: { dealt: 5, styles: {}, missedStyles: 0, petDealt: 300 } } });
        // Three pets in all; one stays through two samples, and the last comes after a gap.
        for (const [i, ids] of ([[1, [600]], [2, [600, 601]], [3, [601]], [4, undefined], [5, [602]]] as [number, number[] | undefined][])) {
            o.sample(picture(theurgist(ids), [wolf()], engage, T0 + i * 1000));
        }
        o.sample(picture(theurgist(undefined), [wolf()], engage, T0 + 120_000));
        const r = o.report();
        expect(r.members.Menta!.pet).toEqual({ kind: 'fnf', name: '', up: null, onFocus: null, focusSamples: 0, drewFocus: 0, deaths: 0, summons: 3, brokeCc: 0 });
        expect(r.members.Menta!.petDealt).toBe(300);
        const topics = r.findings.map(f => f.topic);
        expect(topics).not.toContain('pet-down');
        expect(topics).not.toContain('pet-idle');
        expect(formatReport(r)).toContain('| Menta | fnf | - | - | 0% | 300 | 0 | 3 | 0 |');
    });

    test('an enemy pet\'s death ends a fight but is no kill: it is worth nothing (GameNPC.cs:2731-2732)', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 'rvr', startedAt: T0 });
        for (let i = 1; i <= 3; i++) o.sample(picture(members(), [contact(700, { name: 'earthen spirit', realm: 'midgard', isPet: true, target: 'Druid', threat: true })], { seq: 1, phase: 'engage', focus: 700 }, T0 + i * 1000));
        o.handle({ at: T0 + 3500, kind: 'kill', member: 'Tank', targetId: 700, text: 'earthen spirit (L20) died', data: { name: 'earthen spirit', level: 20, kind: 'npc', realm: 'midgard', pet: true } });
        for (let i = 4; i <= 6; i++) o.sample(picture(members(), [], { seq: 2, phase: 'recover' }, T0 + i * 1000));
        const r = o.report();
        expect(r.totals.kills).toBe(0);
        expect(r.fights[0]).toMatchObject({ kills: [], outcome: 'won' });
        expect(r.timeline.join('\n')).toContain('earthen spirit (L20) died');
    });

    test('a fight\'s kills are the real ones: "00:31 Briton: won in 74 s, kills 5" under a header of 4, with an emerald simulacrum in them', () => {
        const o = new GroupObserver(null, { group: 'g', strategy: 'rvr', startedAt: T0 });
        for (let i = 1; i <= 3; i++) o.sample(picture(members(), [contact(700, { name: 'emerald simulacrum', realm: 'midgard', isPet: true, target: 'Druid', threat: true }), enemy(701, 'midgard', { target: 'Tank', threat: true })], { seq: 1, phase: 'engage', focus: 701 }, T0 + i * 1000));
        o.handle({ at: T0 + 3400, kind: 'kill', member: 'Tank', targetId: 701, text: 'Briton (L20) died', data: { name: 'Briton', level: 20, kind: 'player', realm: 'midgard' } });
        o.handle({ at: T0 + 3500, kind: 'kill', member: 'Tank', targetId: 700, text: 'emerald simulacrum (L21) died', data: { name: 'emerald simulacrum', level: 21, kind: 'npc', realm: 'midgard', pet: true } });
        for (let i = 4; i <= 6; i++) o.sample(picture(members(), [], { seq: 2, phase: 'recover' }, T0 + i * 1000));
        const r = o.report();
        expect(r.totals.kills).toBe(1);
        expect(r.fights[0]).toMatchObject({ kills: ['Briton'], outcome: 'won' });
        expect(formatReport(r)).toContain('kills 1,');
    });

    test('Drew the focus reads - with no hold samples, as On focus does: "tank held \'-%\', table \'Drew the focus 0%\'" (20261103-154125)', () => {
        const o = observer();
        o.sample(picture(owner(petOf()), [], quiet, T0 + 1000));
        const r = o.report();
        expect(r.members.Menta!.pet!.drewFocus).toBeNull();
        expect(formatReport(r)).toContain('| Menta | spirit soldier | 100% | - | - | 0 | 0 | 0 | 0 |');
        // A sample with the tank holding it is one: 0 of it is 0.
        const held = observer();
        held.sample(picture(owner(petOf()), [wolf()], engage, T0 + 1000));
        expect(held.report().members.Menta!.pet!.drewFocus).toBe(0);
    });

    describe('what comes before a member\'s first sample', () => {
        // A track starts with its first sample, up to a second into the run.
        test('an instant summon: "You cast a Hunter\'s Pet spell!" 16:26:46.6, run start 16:26:46, "Pethun Up 100 %, Summons 0"', () => {
            const o = observer();
            o.handle(summoned);
            o.sample(picture(owner(petOf()), [], quiet, T0 + 1000));
            o.sample(picture(owner(petOf()), [], quiet, T0 + 2000));
            expect(o.report().members.Menta!.pet!.summons).toBe(1);
        });

        test('a failure too', () => {
            const o = observer();
            o.handle({ ...summoned, text: 'summon: no_power', data: { action: 'summon', success: false, reason: 'no_power' } });
            o.sample(picture(owner(null), [], quiet, T0 + 1000));
            expect(o.report().members.Menta!.failures).toEqual({ 'summon:no_power': 1 });
        });

        test('a death: "15:46:02 Pettan: Pettan died", and the report said deaths 0', () => {
            const o = observer();
            o.handle({ at: T0 + 200, kind: 'death', member: 'Tank', text: 'Tank died', data: { killer: { kind: 'npc', name: 'carrion drake', realm: 'none' } } });
            o.sample(picture(members({ Tank: { isDead: true, hp: 0 } }), [wolf({ target: 'Tank' })], engage, T0 + 1000));
            o.sample(picture(members({ Tank: { isDead: true, hp: 0 } }), [wolf({ target: 'Tank' })], engage, T0 + 2000));
            const r = o.report();
            expect(r.totals.deaths).toBe(1);
            expect(r.members.Tank).toMatchObject({ deaths: 1, killedBy: { 'npc:carrion drake': 1 } });
            expect(r.fights[0]!.deaths).toEqual(['Tank']);
            expect(r.findings.map(f => f.topic)).toContain('deaths');
        });

        test('one who has a track by then counts once, as ever', () => {
            const o = observer();
            o.sample(picture(members(), [wolf()], engage, T0 + 1000));
            o.handle({ at: T0 + 1200, kind: 'death', member: 'Tank', text: 'Tank died' });
            o.sample(picture(members({ Tank: { isDead: true, hp: 0 } }), [wolf()], engage, T0 + 2000));
            const r = o.report();
            expect(r.members.Tank!.deaths).toBe(1);
            expect(r.fights[0]!.deaths).toEqual(['Tank']);
        });
    });

    describe('an intercept isn\'t aggro', () => {
        // "'on Petspi's pet 32%' from 'The spirit soldier steps in front of you and takes the blow!' (r7)".
        const stepping = (n: number) => owner(petOf(), { combat: { dealt: 0, styles: {}, missedStyles: 0, ...(n ? { petIntercepts: n } : {}) } });
        const onPet = wolf({ target: null, targetPet: 'Menta' });

        test('the blow reads as the mob on the pet: that is no focus it drew, for as long as it reads so, with a blow at its owner behind it', () => {
            const o = observer();
            for (let i = 1; i <= 6; i++) o.sample(picture(stepping(0), [wolf()], engage, T0 + i * 1000));
            o.sample(picture(stepping(1), [onPet], engage, T0 + 7000));
            // The pet hits back, and the mob stays on it past the 4 s of the line.
            for (let i = 8; i <= 14; i++) o.sample(picture(stepping(1), [onPet], engage, T0 + i * 1000));
            const r = o.report();
            expect(r.members.Menta!.pet).toMatchObject({ drewFocus: 0, intercepted: 57 });
            expect(r.findings.map(f => f.topic)).not.toContain('pet-aggro');
            expect(formatReport(r)).toContain('| 0% (57% more by intercepting) |');
            // The tank's hold is as strict as ever, and what took it is said.
            expect(r.totals.tankHold).toBe(43);
            expect(r.findings.find(f => f.topic === 'aggro')!.evidence).toContain('pets stepping in for their owners 57%');
        });

        test('the same mob back on the tank and later on the pet with no such line is a focus it drew', () => {
            const o = observer();
            o.sample(picture(stepping(1), [onPet], engage, T0 + 1000));
            o.sample(picture(stepping(1), [wolf()], engage, T0 + 2000));
            for (let i = 8; i <= 10; i++) o.sample(picture(stepping(1), [onPet], engage, T0 + i * 1000));
            expect(o.report().members.Menta!.pet).toMatchObject({ drewFocus: 60, intercepted: 20 });
        });

        test('a pet that has stepped in for nobody has no such key', () => {
            const o = observer();
            o.sample(picture(stepping(0), [onPet], engage, T0 + 1000));
            expect('intercepted' in o.report().members.Menta!.pet!).toBe(false);
        });
    });

    describe('on focus counts from the pet\'s hold', () => {
        // Run 155042: "pet-idle Petdru's pet was on the focus only 46%", "engages of 5-6 s with orders at +2..+4 s and the mob dead by +5.4".
        const fight = (hold: number | undefined, focus = wolf({ engagedAt: T0 + 1000 })) => {
            const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0, petHoldMs: hold });
            for (let i = 1; i <= 10; i++) o.sample(picture(owner(petOf({ targetId: i >= 4 ? 7 : null })), [focus], engage, T0 + i * 1000));
            return o.report().members.Menta!.pet!;
        };

        test('with the hold known, the time it is meant to wait is no idleness', () => {
            expect(fight(3000)).toMatchObject({ onFocus: 100, focusSamples: 7 });
        });

        test('with none known, from the engage as ever', () => {
            expect(fight(undefined)).toMatchObject({ onFocus: 70, focusSamples: 10 });
            expect(fight(0)).toMatchObject({ onFocus: 70, focusSamples: 10 });
        });

        test('a fight shorter than the hold leaves no sample to judge by', () => {
            expect(fight(60_000)).toMatchObject({ onFocus: null, focusSamples: 0 });
        });

        test('each focus has its own hold', () => {
            const o = new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0, petHoldMs: 3000 });
            for (let i = 1; i <= 5; i++) o.sample(picture(owner(petOf({ targetId: 7 })), [wolf({ engagedAt: T0 + 1000 })], engage, T0 + i * 1000));
            const bear = contact(8, { name: 'bear', target: 'Tank', threat: true, x: 0, engagedAt: T0 + 6000 });
            for (let i = 6; i <= 8; i++) o.sample(picture(owner(petOf()), [bear], { seq: 3, phase: 'engage', focus: 8 }, T0 + i * 1000));
            // 4 and 5 on the first, none of 6 to 8 on the second.
            expect(o.report().members.Menta!.pet).toMatchObject({ focusSamples: 2, onFocus: 100 });
        });

        test('an enemy player has none: a pet goes at once', () => {
            expect(fight(3000, wolf({ kind: 'player', engagedAt: T0 + 1000 }))).toMatchObject({ onFocus: 70, focusSamples: 10 });
        });
    });

    test('the stats say when its owner\'s death is why it was down', () => {
        const o = observer();
        for (let i = 1; i <= 70; i++) o.sample(picture(owner(petOf()), [], quiet, T0 + i * 1000));
        for (let i = 71; i <= 72; i++) o.sample(picture(owner(null, { isDead: true, hp: 0 }), [], quiet, T0 + i * 1000));
        for (let i = 73; i <= 100; i++) o.sample(picture(owner(null), [], quiet, T0 + i * 1000));
        expect(o.report().members.Menta!.pet).toMatchObject({ up: 71, lostToOwner: 29 });
    });

    test('a pet back after its owner\'s death ends that: what follows is on its own account', () => {
        const o = observer();
        o.sample(picture(owner(null, { isDead: true, hp: 0 }), [], quiet, T0 + 1000));
        o.sample(picture(owner(null), [], quiet, T0 + 2000));
        o.sample(picture(owner(petOf()), [], quiet, T0 + 3000));
        for (let i = 4; i <= 6; i++) o.sample(picture(owner(null), [], quiet, T0 + i * 1000));
        expect(o.report().members.Menta!.pet).toMatchObject({ up: 20, lostToOwner: 20 });
    });

    test('a death event alone starts that: a release can come between two samples', () => {
        const o = observer();
        o.sample(picture(owner(petOf()), [], quiet, T0 + 1000));
        o.handle({ at: T0 + 1500, kind: 'death', member: 'Menta', text: 'Menta died' });
        o.sample(picture(owner(null), [], quiet, T0 + 2000));
        expect(o.report().members.Menta!.pet).toMatchObject({ lostToOwner: 50 });
    });

    describe('findings', () => {
        const FOUGHT = { start: 0, durationMs: 60_000, focus: ['wolf'], kills: [], adds: 0, maxAttackers: 1, tankHold: 50, openerMs: {}, deaths: [], retreated: false, outcome: 'won' as const };
        const ORDERED = { routine: ['release', 'petControl', 'assist'], actions: { petAttack: 3 } };
        /** A minute's report with Menta's pet as given, on a list that orders it; the rest of the group as it is. */
        const reportWith = (pet: NonNullable<RunReport['members'][string]['pet']>, over: Partial<RunReport> = {}): RunReport => {
            const o = observer();
            o.sample(picture(members(), [], quiet, T0 + 120_000));
            const r = { ...o.report(), fights: [FOUGHT], ...over };
            r.members.Menta!.pet = pet;
            Object.assign(r.members.Menta!, ORDERED);
            return r;
        };
        const fine = { kind: 'main' as const, name: 'spirit soldier', up: 100, onFocus: 100, focusSamples: 60, drewFocus: 0, deaths: 0, summons: 1, brokeCc: 0 };
        const topics = (r: RunReport) => findingsFor(r).map(f => f.topic);
        const of = (r: RunReport, topic: string) => findingsFor(r).find(f => f.topic === topic);

        test('a pet doing its job is none of them', () => {
            expect(topics(reportWith(fine)).filter(t => t.startsWith('pet-'))).toEqual([]);
        });

        test('pet-mezz: one broken cc is enough, with the lines from the timeline', () => {
            const r = reportWith({ ...fine, brokeCc: 2 }, { timeline: ['00:12 Menta: Menta\'s pet broke the mezz on wolf', '00:30 Druid: Druid\'s pet broke the mezz on bear'] });
            expect(of(r, 'pet-mezz')).toMatchObject({ severity: 'medium', member: 'Menta', issue: 'Menta\'s pet broke crowd control 2×', evidence: '00:12 Menta: Menta\'s pet broke the mezz on wolf' });
            expect(of(r, 'pet-mezz')!.suggestion).toContain('pet.holdMs');
        });

        test('pet-aggro: pets together drew the focus over 25 % of the hold samples; not against players', () => {
            expect(topics(reportWith({ ...fine, drewFocus: 25 }))).not.toContain('pet-aggro');
            const r = reportWith({ ...fine, drewFocus: 20 });
            r.members.Druid!.pet = { ...fine, drewFocus: 10 };
            Object.assign(r.members.Druid!, ORDERED);
            expect(of(r, 'pet-aggro')).toMatchObject({ severity: 'medium', issue: 'The focus was on a pet 30% of fight time', evidence: 'on Druid\'s pet 10%, on Menta\'s pet 20%' });
            expect(of(r, 'pet-aggro')!.suggestion).toContain('pet.holdMs');
            const rvr = reportWith({ ...fine, drewFocus: 60 });
            rvr.totals.enemiesSeen = 2;
            expect(topics(rvr)).not.toContain('pet-aggro');
        });

        describe('pet-aggro names its cause', () => {
            // Fired in 19 of 43 runs, with "Try: Raise pet.holdMs" "at --pet.holdMs=10000 (r4 50 %), with --pet.enabled=false (g7b 32 %), ... and 91 % for the tank's commander (r16)".
            const HOLD = 'Raise pet.holdMs';

            test('the tank\'s own pet gets the stance advice: "on Petbon\'s pet 91%", which no hold reaches', () => {
                const r = reportWith(fine);
                r.members.Tank!.pet = { ...fine, drewFocus: 91 };
                Object.assign(r.members.Tank!, { routine: ['release', 'petControl', 'tank'], actions: {} });
                const f = of(r, 'pet-aggro')!;
                expect(f.member).toBe('Tank');
                expect(f.evidence).toBe('on Tank\'s pet 91% (the tank\'s own)');
                expect(f.suggestion).toContain('passive');
                expect(f.suggestion).not.toContain(HOLD);
            });

            test('a list without petControl: no hold advice (--pet.enabled=false, g7b 32 %)', () => {
                const r = reportWith({ ...fine, drewFocus: 32 });
                r.members.Menta!.routine = ['release', 'assist'];
                r.members.Menta!.actions = {};
                const f = of(r, 'pet-aggro')!;
                expect(f.evidence).toBe('on Menta\'s pet 32% (no order)');
                expect(f.suggestion).toContain('ControlledMobBrain.cs:614-638');
                expect(f.suggestion).not.toContain(HOLD);
            });

            test('on the list and never ordered: no hold advice either', () => {
                const r = reportWith({ ...fine, drewFocus: 43 });
                r.members.Menta!.actions = {};
                expect(of(r, 'pet-aggro')!.evidence).toContain('(no order)');
                expect(of(r, 'pet-aggro')!.suggestion).not.toContain(HOLD);
            });

            test('a refused order is none: it took the mob by itself', () => {
                const r = reportWith({ ...fine, drewFocus: 43 });
                r.members.Menta!.actions = {};
                r.members.Menta!.failures = { 'petAttack:immune': 2 };
                expect(of(r, 'pet-aggro')!.suggestion).not.toContain(HOLD);
            });

            test('a passive watch knows no list and no order: no hold advice', () => {
                const r = reportWith({ ...fine, drewFocus: 43 });
                delete r.members.Menta!.routine;
                r.members.Menta!.actions = {};
                expect(of(r, 'pet-aggro')!.suggestion).not.toContain(HOLD);
            });

            test('ordered by petControl, the hold it is', () => {
                const f = of(reportWith({ ...fine, drewFocus: 53 }), 'pet-aggro')!;
                expect(f).toMatchObject({ member: 'Menta', evidence: 'on Menta\'s pet 53%' });
                expect(f.suggestion).toContain(HOLD);
            });

            test('a Theurgist\'s: fnfPet waits for the hold before each cast (20261103-162537: on Petthe\'s pet 50%)', () => {
                const r = reportWith({ ...fine, kind: 'fnf', name: '', up: null, onFocus: null, focusSamples: 0, summons: 4, drewFocus: 50 });
                r.members.Menta!.routine = ['release', 'fnfPet', 'assist'];
                r.members.Menta!.actions = {};
                expect(of(r, 'pet-aggro')!.suggestion).toContain(HOLD);
            });

            test('a broken mezz names the mezz: the line from the timeline, and pet-mezz for what to do', () => {
                const r = reportWith({ ...fine, drewFocus: 53, brokeCc: 1 }, { timeline: ['00:12 Menta: Menta\'s pet broke the mezz on wolf'] });
                const f = of(r, 'pet-aggro')!;
                expect(f.evidence).toBe('on Menta\'s pet 53% (00:12 Menta: Menta\'s pet broke the mezz on wolf)');
                expect(f.suggestion).toContain('pet-mezz');
                expect(f.suggestion).not.toContain(HOLD);
            });

            test('with the line gone from the timeline it still says so', () => {
                const f = of(reportWith({ ...fine, drewFocus: 53, brokeCc: 2 }), 'pet-aggro')!;
                expect(f.evidence).toBe('on Menta\'s pet 53% (it broke crowd control 2×)');
            });

            test('two pets, two causes: each advice once, and no one member', () => {
                const r = reportWith({ ...fine, drewFocus: 20 });
                r.members.Tank!.pet = { ...fine, drewFocus: 11 };
                r.members.Druid!.pet = { ...fine, drewFocus: 5 };
                Object.assign(r.members.Druid!, ORDERED);
                const f = of(r, 'pet-aggro')!;
                expect(f.member).toBeUndefined();
                expect(f.evidence).toBe('on Tank\'s pet 11% (the tank\'s own), on Druid\'s pet 5%, on Menta\'s pet 20%');
                expect(f.suggestion.split(HOLD).length).toBe(2);
                expect(f.suggestion).toContain('passive');
            });

            test('fewer: 100 % of a 2 s fight is nothing to go by (20261103-164244: on Pethun\'s pet 100%, 2 samples)', () => {
                const r = reportWith({ ...fine, drewFocus: 100 }, { fights: [{ ...FOUGHT, durationMs: 2000 }] });
                expect(topics(r)).not.toContain('pet-aggro');
                // A fight with no hold sample behind it adds nothing.
                const s = reportWith({ ...fine, drewFocus: 100 }, { fights: [{ ...FOUGHT, durationMs: 2000 }, { ...FOUGHT, tankHold: null }] });
                expect(topics(s)).not.toContain('pet-aggro');
                const t = reportWith({ ...fine, drewFocus: 100 }, { fights: [{ ...FOUGHT, durationMs: 6000 }, { ...FOUGHT, durationMs: 5000 }] });
                expect(topics(t)).toContain('pet-aggro');
            });
        });

        test('pet-idle: up, and on the focus under half of at least 10 samples', () => {
            expect(of(reportWith({ ...fine, onFocus: 40, focusSamples: 20 }), 'pet-idle')).toMatchObject({ member: 'Menta', issue: 'Menta\'s pet was on the focus only 40% of engaged time' });
            expect(of(reportWith({ ...fine, onFocus: 40, focusSamples: 20 }), 'pet-idle')!.suggestion).toContain('pet.holdMs');
            expect(topics(reportWith({ ...fine, onFocus: 50, focusSamples: 20 }))).not.toContain('pet-idle');
            expect(topics(reportWith({ ...fine, onFocus: 40, focusSamples: 9 }))).not.toContain('pet-idle');
            expect(topics(reportWith({ ...fine, onFocus: null, focusSamples: 0 }))).not.toContain('pet-idle');
        });

        test('pet-idle names what the server said to its orders: "petAttack (6)" answered "You can\'t attack a shadowed necromancer!" isn\'t range or hold', () => {
            const r = reportWith({ ...fine, onFocus: 7, focusSamples: 20 });
            r.members.Menta!.failures = { 'petAttack:immune': 4, 'petAttack:not_attackable': 2, 'nuke:immune': 3 };
            const f = of(r, 'pet-idle')!;
            expect(f.evidence).toContain('its orders refused: immune 4×, not_attackable 2×');
            expect(f.suggestion).not.toContain('pet.holdMs');
        });

        test('pet-idle: a list without petControl leaves its pet alone on purpose (a shade\'s, a turret)', () => {
            const idle = () => reportWith({ ...fine, kind: null, onFocus: 40, focusSamples: 20 });
            const shade = idle();
            shade.members.Menta!.routine = ['release', 'assist'];
            expect(topics(shade)).not.toContain('pet-idle');
            const ordered = idle();
            ordered.members.Menta!.routine = ['release', 'petControl', 'assist'];
            expect(topics(ordered)).toContain('pet-idle');
        });

        test('pet-idle: skipped where no routine is known: "cli.ts --watch=40 during a --pet.enabled=false run: \'pet-idle ... only 0%\' on both"', () => {
            const watch = reportWith({ ...fine, onFocus: 0, focusSamples: 20 });
            delete watch.members.Menta!.routine;
            expect(topics(watch)).not.toContain('pet-idle');
        });

        test('pet-down: can summon, and no pet over 25 % of a run over a minute', () => {
            const r = reportWith({ ...fine, up: 60, deaths: 3, summons: 4 });
            r.members.Menta!.failures = { 'summon:no_power': 2, 'nuke:interrupted': 1 };
            expect(of(r, 'pet-down')).toMatchObject({ severity: 'medium', member: 'Menta', issue: 'Menta had no pet 40% of the run', evidence: 'summoned 4×, it died 3×; summon:no_power (2)' });
            expect(of(r, 'pet-down')!.suggestion).toContain('pet.summonMana');
            expect(topics(reportWith({ ...fine, up: 75 }))).not.toContain('pet-down');
            // One it has from elsewhere: no summon to keep it up with.
            expect(topics(reportWith({ ...fine, up: 10, kind: null }))).not.toContain('pet-down');
            expect(topics(reportWith({ ...fine, up: 10 }, { durationMs: 60_000 }))).not.toContain('pet-down');
        });

        test('pet-down: says the owner\'s death when that\'s the cause (a6: "pet-down \'no pet 32% ... summoned 1x, it died 0x\'", Petcab dead and released)', () => {
            const r = reportWith({ ...fine, up: 68, lostToOwner: 32, summons: 1 });
            r.members.Menta!.deaths = 1;
            const f = of(r, 'pet-down')!;
            expect(f.issue).toBe('Menta had no pet 32% of the run');
            expect(f.evidence).toBe('summoned 1×, it died 0×, its owner died 1×');
            expect(f.suggestion).toContain('deaths finding');
            expect(f.suggestion).not.toContain('pet.summonMana');
        });

        test('pet-down: an owner\'s death behind less than half of it isn\'t the cause', () => {
            const r = reportWith({ ...fine, up: 60, lostToOwner: 10, summons: 1 });
            r.members.Menta!.deaths = 1;
            expect(of(r, 'pet-down')!.evidence).toBe('summoned 1×, it died 0×, its owner died 1×');
            expect(of(r, 'pet-down')!.suggestion).toContain('pet.summonMana');
        });
    });

    describe('a group with no pets reads as before', () => {
        const run = (pet?: null, petDealt?: number) => {
            const o = observer();
            const combat = { dealt: 40, styles: { Slam: 2 }, missedStyles: 0, ...(petDealt ? { petDealt } : {}) };
            const ms = members({ Tank: { pet, combat }, Druid: { pet, combat }, Menta: { pet, combat } });
            for (let i = 1; i <= 5; i++) o.sample(picture(ms, [wolf()], engage, T0 + i * 1000));
            o.handle({ at: T0 + 5500, kind: 'kill', member: 'Tank', targetId: 7, text: 'wolf died', data: { name: 'wolf' } });
            for (let i = 6; i <= 9; i++) o.sample(picture(ms, [], quiet, T0 + i * 1000));
            return o.report();
        };

        test('no pet in the reports: nothing in the report mentions one, no key, column or line', () => {
            const r = run(null);
            // The same as a run from before pets, with no such field at all.
            expect(r).toEqual(run());
            expect(JSON.stringify(r)).not.toMatch(/pet/i);
            const md = formatReport(r);
            expect(md).not.toMatch(/pet/i);
            expect(md).toContain('| Member | Damage dealt | Styles landed | Styles missed | Routine from | Routine |');
            expect(md).toContain('## What each member did\n\n| Member');
            expect(md).toContain('| Member | Role | Level | XP/h | Deaths | Actions | Failures | Idle in fights | Moving in fights | First nuke | Targeted | In melee | Min HP | Group waited for it |');
            expect(md.split('\n').filter(l => l.startsWith('## '))).toEqual(['## Findings', '## Members', '## What each member did', '## Fights', '## Timeline (last events)']);
        });

        test('a DoT tick from a proc outside its spell list reads like a pet\'s, and with no pet is the member\'s own damage', () => {
            const r = run(null, 15);
            expect(r.members.Menta!.dealt).toBe(55);
            expect('petDealt' in r.members.Menta!).toBe(false);
            expect(JSON.stringify(r)).not.toMatch(/pet/i);
            expect(formatReport(r)).toContain('| Menta | 55 |');
        });
    });

    describe('history', () => {
        /** In a folder of its own: findBotEnv looks in the working directory first. */
        const inTemp = (use: (dir: string) => void) => {
            const dir = mkdtempSync(join(tmpdir(), 'group-'));
            const back = process.cwd();
            for (const bot of ['tank', 'druid', 'menta']) {
                mkdirSync(join(dir, 'bots', bot), { recursive: true });
                writeFileSync(join(dir, 'bots', bot, 'bot.env'), '');
            }
            process.chdir(dir);
            try {
                use(dir);
            } finally {
                process.chdir(back);
                rmSync(dir, { recursive: true, force: true });
            }
        };
        const line = (dir: string, bot: string) => JSON.parse(readFileSync(join(dir, 'bots', bot, 'runs', 'history.jsonl'), 'utf-8').trim());

        test('a bot with a pet logs its damage and stats; one without logs the same keys as ever', () => {
            inTemp(dir => {
                const o = observer();
                const combat = { dealt: 40, styles: {}, missedStyles: 0 };
                o.sample(picture(members({ Tank: { combat }, Druid: { combat, pet: null }, Menta: { pet: petOf(), capabilities: caps('main'), combat: { ...combat, petDealt: 123 } } }), [], quiet, T0 + 1000));
                saveReport(join(dir, 'g'), o.report(), undefined, { botHistory: true });
                expect(line(dir, 'menta')).toMatchObject({ dealt: 40, petDealt: 123, pet: { kind: 'main', name: 'spirit soldier', up: 100, summons: 0 } });
                const keys = ['startedAt', 'stamp', 'group', 'strategy', 'seconds', 'name', 'role', 'level', 'xpPerHour', 'deaths', 'dealt', 'styles', 'missedStyles', 'actions', 'failures', 'idleInFights', 'targeted', 'minHp'];
                expect(Object.keys(line(dir, 'tank')).sort()).toEqual([...keys].sort());
                expect(Object.keys(line(dir, 'druid')).sort()).toEqual([...keys].sort());
            });
        });

        test('the group\'s history lists pet findings like any other, and adds nothing else', () => {
            inTemp(dir => {
                const o = observer();
                o.sample(picture(members({ Menta: { pet: petOf(), capabilities: caps('main') } }), [], quiet, T0 + 1000));
                o.handle(broke);
                saveReport(join(dir, 'g'), o.report());
                const summary = JSON.parse(readFileSync(join(dir, 'g', 'runs', 'history.jsonl'), 'utf-8').trim());
                expect(summary.findings).toContain('pet-mezz');
                expect(Object.keys(summary).filter(k => /pet/i.test(k))).toEqual([]);
                expect(existsSync(join(dir, 'bots', 'menta', 'runs'))).toBe(false);
            });
        });
    });
});

describe('what a report says of a run a round would read wrong', () => {
    const caps = (pet: Capabilities['pet']): Capabilities => ({ heal: false, cc: false, nuke: true, buffs: [], buffSpells: [], pet });
    const petOf = (over: Partial<PetReport> = {}): PetReport => ({ objectId: 500, name: 'spirit soldier', level: 17, x: 1000, y: 1000, z: 0, hp: 84, targetId: null, inCombat: false, aggression: 'defensive', walk: 'follow', icons: [], ...over });
    const observer = (routines?: Record<string, { from: 'role'; behaviors: string[] }>) => new GroupObserver(null, { group: 'g', strategy: 's', startedAt: T0, routines });
    const quiet = { seq: 1, phase: 'recover' as const };
    const engage = { seq: 2, phase: 'engage' as const, focus: 7 };
    const wolf = (over: Parameters<typeof contact>[1] = {}) => contact(7, { name: 'wolf', target: 'Tank', threat: true, x: 0, ...over });
    const of = (r: RunReport, topic: string) => r.findings.find(f => f.topic === topic);

    describe('pet-down says why', () => {
        const run = (seconds: number, m: (i: number) => { over: Partial<MemberReport>; orders?: object }) => {
            const o = observer();
            for (let i = 1; i <= seconds; i++) {
                const s = m(i);
                o.sample(picture(members({ Menta: { capabilities: caps('main'), ...s.over } }), [], s.orders ?? quiet, T0 + i * 1000));
            }
            return o.report();
        };

        test('on recast: "Pethun had no pet 37% of the run ... Try: Lower pet.summonMana", with mana at 100 % and a summon with 18 s on its clock', () => {
            const r = run(100, i => ({ over: i <= 40 ? { pet: null, petRecast: true } : { pet: petOf() } }));
            expect(r.members.Menta!.pet).toMatchObject({ up: 60, onRecast: 40 });
            const f = of(r, 'pet-down')!;
            expect(f.evidence).toContain('on recast 40% of the run');
            expect(f.suggestion).toContain('recast');
            expect(f.suggestion).not.toContain('pet.summonMana');
        });

        test('its owner pulling: a summon stands him still, so his own pull waits for none', () => {
            const r = run(100, i => ({ over: { pet: i <= 40 ? null : petOf() }, orders: i <= 40 ? { seq: 1, phase: 'pull' as const, focus: 7, puller: 'Menta' } : quiet }));
            expect(r.members.Menta!.pet).toMatchObject({ up: 60, ownerPulling: 40 });
            const f = of(r, 'pet-down')!;
            expect(f.evidence).toContain('its owner pulling 40% of the run');
            expect(f.suggestion).toContain('pet.waitForSummon');
            expect(f.suggestion).not.toContain('pet.summonMana');
        });

        test('someone else\'s pull is no reason', () => {
            const r = run(100, i => ({ over: { pet: i <= 40 ? null : petOf() }, orders: i <= 40 ? { seq: 1, phase: 'pull' as const, focus: 7, puller: 'Tank' } : quiet }));
            expect(r.members.Menta!.pet).not.toHaveProperty('ownerPulling');
            expect(of(r, 'pet-down')!.suggestion).toContain('pet.summonMana');
        });

        test('owner dead most of the run: "Petcab had no pet 28% of the run" of 30 s alive in 133 s, the first summon\'s 12 s, with mana at 100 %', () => {
            const r = run(133, i => ({ over: i <= 30 ? { pet: i <= 8 ? null : petOf() } : { pet: null, isDead: true, hp: 0 } }));
            expect(r.members.Menta!.pet).toMatchObject({ ownerDead: 77 });
            const f = of(r, 'pet-down')!;
            expect(f.suggestion).toContain('dead 77% of the run');
            expect(f.suggestion).toContain('deaths finding');
            expect(f.suggestion).not.toContain('pet.summonMana');
        });

        test('none of these: as it read, and no key in the stats', () => {
            const r = run(100, i => ({ over: { pet: i <= 40 ? null : petOf() } }));
            for (const k of ['onRecast', 'ownerPulling', 'ownerDead']) expect(r.members.Menta!.pet).not.toHaveProperty(k);
            expect(of(r, 'pet-down')!.evidence).toBe('summoned 0×, it died 0×');
            expect(of(r, 'pet-down')!.suggestion).toContain('pet.summonMana');
        });
    });

    describe('a fight\'s outcome and name', () => {
        const fight = (o: { kill?: GroupEvent; death?: boolean; contacts?: boolean } = {}) => {
            const g = observer();
            for (let i = 1; i <= 5; i++) g.sample(picture(members(), o.contacts === false ? [] : [wolf()], o.contacts === false ? { seq: 2, phase: 'engage' as const } : engage, T0 + i * 1000));
            if (o.kill) g.handle(o.kill);
            if (o.death) g.handle({ at: T0 + 5500, kind: 'death', member: 'Menta', text: 'Menta died' });
            for (let i = 6; i <= 9; i++) g.sample(picture(members(), [], quiet, T0 + i * 1000));
            return g.report();
        };

        test('"grove\'s agent: lost in 34 s, kills 0" with Rehea alive and the turret called off: it stopped', () => {
            expect(fight().fights[0]!.outcome).toBe('stopped');
            expect(formatReport(fight())).toContain('wolf: stopped in');
        });

        test('with a member dead and nothing to show for it: lost', () => {
            expect(fight({ death: true }).fights[0]!.outcome).toBe('lost');
        });

        test('"00:01 ?: won in 18 s, kills 1": a run that left the engage within a tick has its kill to go by', () => {
            const r = fight({ contacts: false, kill: { at: T0 + 5500, kind: 'kill', member: 'Tank', targetId: 7, text: 'water beetle died', data: { name: 'water beetle' } } });
            expect(r.fights[0]).toMatchObject({ focus: ['water beetle'], outcome: 'won' });
            expect(formatReport(r)).toContain('water beetle: won in');
        });

        test('or an enemy pet\'s, which is no kill in its line', () => {
            const r = fight({ contacts: false, kill: { at: T0 + 5500, kind: 'kill', member: 'Tank', targetId: 7, text: 'necroservant died', data: { name: 'necroservant', pet: true } } });
            expect(r.fights[0]).toMatchObject({ focus: ['necroservant'], kills: [], outcome: 'won' });
        });

        test('a focus seen stays the name', () => {
            const r = fight({ kill: { at: T0 + 5500, kind: 'kill', member: 'Tank', targetId: 8, text: 'add died', data: { name: 'add' } } });
            expect(r.fights[0]!.focus).toEqual(['wolf']);
        });
    });

    describe('pet-aggro: ordered, per fight and per target', () => {
        const ROUTINE = { menta: { from: 'role' as const, behaviors: ['release', 'petControl', 'assist'] }, tank: { from: 'role' as const, behaviors: ['release', 'petControl', 'tank'] } };
        const accepted = (member: string, targetId: number, at: number): GroupEvent => ({ at, kind: 'result', member, targetId, text: 'petAttack: ok', data: { action: 'petAttack', success: true, reason: null } });
        const onPet = (id: number, owner: string, over: Parameters<typeof contact>[1] = {}) => contact(id, { name: 'lake serpent', target: null, targetPet: owner, targetId: 500, threat: true, x: 0, ...over });
        const withPet = { Menta: { pet: petOf() } };
        /** A fight on `id`, 12 s, with the focus on `owner`'s pet for all of it. */
        const fight = (o: GroupObserver, id: number, owner: string, from: number, ordered: boolean) => {
            const ms = owner === 'Tank' ? { Tank: { pet: petOf() } } : withPet;
            if (ordered) o.sample(picture(members(ms), [onPet(id, owner, { target: 'Tank', targetPet: null })], { seq: 2, phase: 'engage', focus: id }, T0 + from * 1000));
            if (ordered) o.handle(accepted(owner, id, T0 + from * 1000 + 100));
            for (let i = 1; i <= 12; i++) o.sample(picture(members(ms), [onPet(id, owner)], { seq: 2, phase: 'engage', focus: id }, T0 + (from + i) * 1000));
            for (let i = 13; i <= 16; i++) o.sample(picture(members(ms), [], quiet, T0 + (from + i) * 1000));
        };

        test('c1: "on Petspi\'s pet 23%, on Petbon\'s pet 46%. Try: Raise pet.holdMs", the 46 % a mezz-woken mob that went for Commander with no order in that fight', () => {
            const o = observer(ROUTINE);
            // An order that went, in an earlier fight on another mob: run-wide that read as ordered.
            fight(o, 7, 'Tank', 0, true);
            o.handle(accepted('Menta', 7, T0 + 100));
            fight(o, 8, 'Menta', 20, false);
            const r = o.report();
            expect(r.members.Menta!.actions.petAttack).toBe(1);
            const f = of(r, 'pet-aggro')!;
            expect(f.evidence).toContain('on Menta\'s pet');
            expect(f.evidence).toContain('(no order)');
        });

        test('after its order, on that target, in that fight: the hold it is', () => {
            const o = observer(ROUTINE);
            fight(o, 8, 'Menta', 0, true);
            const f = of(o.report(), 'pet-aggro')!;
            expect(f.evidence).not.toContain('no order');
            expect(f.suggestion).toContain('Raise pet.holdMs');
        });

        test('20261104-043654: a tank\'s own pet, ordered at the first swing, turned the mob by damage: the hold, not the stance petControl just kept', () => {
            const o = observer(ROUTINE);
            fight(o, 8, 'Tank', 0, true);
            const f = of(o.report(), 'pet-aggro')!;
            expect(f.evidence).toContain('(the tank\'s own)');
            expect(f.suggestion).toContain('Raise pet.holdMs');
            expect(f.suggestion).not.toContain('passive');
        });

        test('a tank\'s own with no order that went: the stance', () => {
            const o = observer(ROUTINE);
            fight(o, 8, 'Tank', 0, false);
            const f = of(o.report(), 'pet-aggro')!;
            expect(f.suggestion).toContain('passive');
            expect(f.suggestion).not.toContain('Raise pet.holdMs');
        });

        test('the same id in the next fight is another mob: an order in the last one is none here', () => {
            const o = observer(ROUTINE);
            o.sample(picture(members(withPet), [wolf({ objectId: 8 })], { seq: 2, phase: 'engage', focus: 8 }, T0 + 1000));
            o.handle(accepted('Menta', 8, T0 + 1100));
            for (let i = 2; i <= 6; i++) o.sample(picture(members(withPet), [], quiet, T0 + i * 1000));
            fight(o, 8, 'Menta', 10, false);
            expect(of(o.report(), 'pet-aggro')!.evidence).toContain('(no order)');
        });
    });

    describe('interrupts: the advice with no tank', () => {
        const interrupted = (ms: MemberReport[]) => {
            const o = observer();
            o.sample(picture(ms, [wolf({ target: 'Menta', x: 1000 })], engage, T0 + 1000));
            for (let i = 0; i < 2; i++) o.handle({ at: T0 + 1200 + i, kind: 'result', member: 'Menta', text: 'nuke: interrupted', data: { action: 'nuke', success: false, reason: 'interrupted' } });
            return of(o.report(), 'interrupts')!;
        };

        test('"Finding says let flee() run before casting, and flee is on its list": with none in the group it has nowhere to run, and holdMs nothing to wait for', () => {
            const f = interrupted([report('Druid', { role: 'healer', objectId: 2 }), report('Menta', { role: 'nuker', objectId: 4, x: 1000 })]);
            expect(f.suggestion).not.toContain('flee()');
            expect(f.suggestion).not.toContain('holdMs');
            expect(f.suggestion).toContain('no tank');
        });

        test('with one, as it was', () => {
            expect(interrupted(members()).suggestion).toContain('let flee() run before casting');
        });

        test('and for the stretch its tank is out of flee\'s reach, released or over 5000 off, what it does then', () => {
            expect(interrupted(members()).suggestion).toMatch(/flee stands aside.*instant spell/);
        });
    });
});
