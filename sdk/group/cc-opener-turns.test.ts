// The opener on a mezzed focus, across a whole member's turns on a FakeWorld (the harness of member-turns.test.ts): the
// real BotSDK and BotActions, the real Blackboard, MemberAgent and assist. Live, 2026-11-14 10:04 UTC, hibernia: the
// melee broke Fiacra's mezz on a Briton with plain swings.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { BotActions, getNavmeshStore, type NavmeshStore } from '../actions';
import { setDefaultPathProvider, StraightLinePathProvider } from '../pathfinding';
import { FakeWorld } from '../test/fake-world';
import { makePlayer, makePlayerObj } from '../test/fixtures';
import { EquipmentSlot, ObjectType, type BotWorldState, type NearbyPlayer, type Style } from '../types';
import { assist, ccHolds, tank } from './behaviors';
import { Blackboard } from './blackboard';
import { angleOff, standsAt } from './cc-opener';
import { MemberAgent, type Behavior } from './member';
import { RVR_SETTINGS } from './rvr';
import { ANYTIME_STYLE } from './styles';
import type { MemberReport, Role } from './types';

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
const BRITON = 437;
const foe = (dx: number, o: Partial<NearbyPlayer> = {}) => makePlayerObj({ objectId: BRITON, name: 'Briton', level: 24, realm: 'albion', x: ME.x + dx, y: ME.y, z: ME.z, heading: 1024, ...o });

const style = (name: string, skillIndex: number, o: { position?: 'side'; proc?: string; dmg?: number; fatigue?: number }): Style => ({
    name, internalId: skillIndex, specLevel: 1, specName: 'Celtic Dual', skillIndex, prerequisite: o.position ? 0 : ANYTIME_STYLE,
    details: {
        fatigue: o.fatigue ?? 10, attackMod: 0, defensiveMod: 0, openingDamage: o.dmg ?? 100, opening: o.position ? 'positional' : 'offensive', result: null, position: o.position ?? null,
        openingStyle: null, followUps: [], weapon: 'Celtic Dual', stealth: false, procSpellId: o.proc ? 9000 + skillIndex : null, ...(o.proc ? { procSpell: { description: o.proc } as never } : {}),
    },
});
const ICE_STORM = style('Ice Storm', 21, { position: 'side', proc: 'The target is stunned and cannot take any actions for 4 seconds.', dmg: 154 });
const HURRICANE = style('Hurricane', 22, { dmg: 96.6, fatigue: 15 });
const HANDS = [
    { slot: EquipmentSlot.RightHand, name: 'blade', level: 24, count: 1, model: 3, objectType: ObjectType.Blades, condition: 100, durability: 100, quality: 95, weight: 30, value1: 12, value2: 37, hand: 0 },
    { slot: EquipmentSlot.LeftHand, name: 'blade', level: 24, count: 1, model: 3, objectType: ObjectType.Blades, condition: 100, durability: 100, quality: 95, weight: 30, value1: 12, value2: 37, hand: 1 },
];

let running: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const end of running) await end();
    running = [];
});

function member(o: { list: Behavior<any>[]; role?: Role; world?: Partial<BotWorldState>; player?: object }) {
    const w = new FakeWorld({
        nearbyObjects: [], nearbyPlayers: [], nearbyNpcs: [], effects: [], combatEvents: [], pet: null,
        player: makePlayer({ level: 24, realm: 'hibernia', healthPercent: 100, health: 100, maxHealth: 100, endurancePercent: 100, ...o.player }),
        skills: { specializations: [], abilities: [], styles: [ICE_STORM, HURRICANE], spells: [] },
        equipment: HANDS,
        ...o.world,
    } as Partial<BotWorldState>);
    w.stepSize = 20;
    const stamp = w.onTick;
    w.onTick = world => { world.state.timestamp = Date.now(); stamp?.(world); };
    const bot = new BotActions(w.sdk);
    const board = new Blackboard();
    const agent = new MemberAgent({ bot: 'testbot', role: o.role ?? 'melee', sdk: w.sdk, actions: bot }, board, o.list, { ...RVR_SETTINGS }, { minTurnMs: 10, idleMs: 10, failedTurnMs: 50, sideTickMs: 20, sightRadius: 40_000 });
    // The engage comes once the mezz is on, as live: the pick-off after "mezz on the Briton, leave it".
    const engage = () => board.setOrders({ reason: 'test', phase: 'engage', focus: BRITON, cc: [], anchor: ANCHOR });
    board.setOrders({ reason: 'test', phase: 'idle', focus: null, cc: [], anchor: ANCHOR });
    const stop = new AbortController();
    const run = agent.run(stop.signal).catch(() => {});
    running.push(async () => { stop.abort(new Error('test over')); await run; agent.dispose(); w.dispose(); });
    return { w, board, agent, engage };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!check() && Date.now() - t0 < ms) await Bun.sleep(5);
}

const mezz = (m: ReturnType<typeof member>) => { m.board.markCc(BRITON, 1, 'Fiacra', 'mezz', 30_000); m.engage(); };
const seen = (m: ReturnType<typeof member>) => until(() => m.board.picture().contacts.some(c => c.objectId === BRITON));

describe('a mezzed focus to break', () => {
    test('the opener walks to its side and its first swing is the style: Ice Storm, Hurricane behind it, before any attack', async () => {
        const m = member({ list: [assist({ melee: true, holdMs: 0 })], world: { nearbyPlayers: [foe(400)] } });
        await seen(m);
        mezz(m);
        await until(() => m.w.sentOf('useSkill').length >= 2);
        const first = m.w.sent.findIndex(a => (a.type === 'attack' && a.on) || a.type === 'useSkill');
        expect(m.w.sent[first]).toMatchObject({ type: 'useSkill', skillIndex: ICE_STORM.skillIndex });
        expect(m.w.sentOf('useSkill').map(a => a.skillIndex)).toEqual([ICE_STORM.skillIndex, HURRICANE.skillIndex]);
        const p = m.w.player, f = m.w.state.nearbyPlayers[0]!;
        expect(standsAt(angleOff(f, p))).toBe('side');
        expect(Math.hypot(p.x - f.x, p.y - f.y)).toBeLessThan(110);
        expect(m.board.picture().members[0]?.activity.kind).toBe('open');
    });

    // Live 11:15:41: Cathbad's Stunning Blade on Enid, "Your strike was absorbed by a magical barrier! You miss!", the mezz gone.
    test('a bladeturn takes the opener: the same queue again at once, for the next swing', async () => {
        const m = member({ list: [assist({ melee: true, holdMs: 0 })], world: { nearbyPlayers: [foe(400)] } });
        let sends = 0;
        m.w.handlers.useSkill = (_a, world) => {
            sends++;
            const me = world.player.objectId;
            world.player.attacking = true;
            if (sends === 2) setTimeout(() => { world.message('Your strike was absorbed by a magical barrier!'); world.combat({ kind: 'melee', attackerObjectId: me, targetObjectId: BRITON, result: 'miss' }); }, 30);
            if (sends === 4) setTimeout(() => { world.message('You perform your Ice Storm perfectly!'); world.combat({ kind: 'melee', attackerObjectId: me, targetObjectId: BRITON, result: 'styledHit' }); }, 30);
        };
        await seen(m);
        mezz(m);
        await until(() => m.board.events().some(e => e.kind === 'note' && e.text.startsWith('opener on Briton')), 4000);
        expect(m.w.sentOf('useSkill').map(a => a.skillIndex)).toEqual([ICE_STORM.skillIndex, HURRICANE.skillIndex, ICE_STORM.skillIndex, HURRICANE.skillIndex]);
        expect(m.board.events().find(e => e.kind === 'note')?.text).toBe('opener on Briton: absorbed by a bladeturn, then Ice Storm landed (Ice Storm / Hurricane)');
    });

    test('the tank (Cuchulainn, a Hero) opens the same way', async () => {
        const m = member({ role: 'tank', list: [tank()], world: { nearbyPlayers: [foe(400)] } });
        await seen(m);
        mezz(m);
        await until(() => m.w.sentOf('useSkill').length >= 2);
        const first = m.w.sent.findIndex(a => (a.type === 'attack' && a.on) || a.type === 'useSkill');
        expect(m.w.sent[first]).toMatchObject({ type: 'useSkill', skillIndex: ICE_STORM.skillIndex });
    });

    test('a stunned focus opens the same way', async () => {
        const m = member({ list: [assist({ melee: true, holdMs: 0 })], world: { nearbyPlayers: [foe(400)] } });
        await seen(m);
        m.board.markCc(BRITON, 1, 'Cuchulainn', 'stun', 4000);
        m.engage();
        await until(() => m.w.sentOf('useSkill').length >= 1);
        expect(m.w.sentOf('useSkill')[0]?.skillIndex).toBe(ICE_STORM.skillIndex);
    });

    test('another melee bot nearer opens: we come up to 300 and swing nothing', async () => {
        const m = member({ list: [assist({ melee: true, holdMs: 0 })], world: { nearbyPlayers: [foe(900)] } });
        await seen(m);
        publishMate(m.board, 'Laoghaire', 'melee', ME.x + 800);
        await until(() => m.board.picture().members.length === 2);
        mezz(m);
        await until(() => Math.hypot(m.w.player.x - m.w.state.nearbyPlayers[0]!.x, m.w.player.y - m.w.state.nearbyPlayers[0]!.y) < 360, 4000);
        await Bun.sleep(150);
        expect(m.w.sent.filter(a => (a.type === 'attack' && a.on) || a.type === 'useSkill')).toEqual([]);
        expect(m.agent.lastSkip).toContain('Laoghaire opens on the mezzed Briton');
    });

    test('a caster holds its nuke while a melee bot is there to open; with none, the lone mezzed focus is everyone\'s', async () => {
        const m = member({ role: 'nuker', list: [], world: { nearbyPlayers: [foe(900)] } });
        await seen(m);
        mezz(m);
        const briton = () => m.board.picture().contacts.find(c => c.objectId === BRITON)!;
        expect(ccHolds(m.agent.ctx, briton())).toBe(false);
        publishMate(m.board, 'Laoghaire', 'melee', ME.x + 800);
        await until(() => m.board.picture().members.length === 2);
        expect(ccHolds(m.agent.ctx, briton())).toBe(true);
    });
});

function publishMate(board: Blackboard, name: string, role: Role, x: number): void {
    const report: MemberReport = {
        name, bot: name.toLowerCase(), role, className: 'Blademaster', level: 24, experience: 0, objectId: 7, regionId: 1, x, y: ME.y, z: ME.z, hp: 100, mana: 0, endurance: 100, load: 0,
        isDead: false, isSitting: false, inCombat: false, attacking: false, targetId: null, effects: [], capabilities: { heal: false, cc: false, nuke: false, buffs: [], buffSpells: [] },
        activity: { kind: 'idle', targetId: null, detail: '', since: 0 }, at: Date.now(),
    };
    board.publish({ report, sightings: [], deaths: [] });
}
