// Spending by one's build, and going to one's class trainer: the real spawns, and a fake member that says what it was asked to do.
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findNpcSpawns, getClasses } from '../../data/index';
import type { Build } from '../../data/builds';
import { nearestClassTrainer, trainAtClassTrainer, trainAtTrainer, TRAINER_RADIUS, trainFlags, trainingDue, type TrainMember } from './train';

const BUILD: Build = { className: 'Enchanter', name: 'Mana nuker', targets: [{ level: 24, specs: { Mana: 24 } }, { level: 50, specs: { Mana: 49, Light: 22 } }] };
/** A real Enchanter trainer, with a member standing some way from it. */
const SPAWN = findNpcSpawns({ regionId: 200, realm: 'hibernia', guild: 'Enchanter Trainer' })[0]!;

type Train = { success: boolean; message: string; reason?: string; over: { spec: string; level: number; target: number }[] };

interface FakeOptions {
    at?: { regionId?: number; x?: number; y?: number };
    level?: number;
    points?: number;
    specs?: { name: string; level: number }[];
    isDead?: boolean;
    trains?: Partial<Train>[];
    respec?: { success: boolean; message: string; reason?: string };
    walk?: { success: boolean; message: string; reason?: string };
    shape?: 'bot' | 'actions';
    user?: string;
    /** A group member's folder. */
    folder?: string;
    className?: string;
}

/** What training gets with no trainer on a server with allow_train_anywhere off (train.cs:150). */
const WANTS_TRAINER = { success: false, reason: 'needs_trainer', message: 'You must select a valid trainer for your class.' };

function fake(o: FakeOptions = {}): { m: TrainMember; log: string[] } {
    const log: string[] = [];
    const trains = [...o.trains ?? []];
    const actions = {
        walkTo: async (x: number, y: number) => { log.push(`walk ${x},${y}`); return o.walk ?? { success: true, message: 'there' }; },
        trainBuild: async (trainer: string | null, build?: Build) => {
            log.push(`${trainer === null ? 'train here' : `train at ${trainer}`} by ${build?.name ?? 'its own build'}`);
            return { success: true, message: 'trained', over: [], ...trains.shift() };
        },
        respec: async (trainer: string) => { log.push(`respec at ${trainer}`); return o.respec ?? { success: true, message: 'regained 10' }; },
    } as any;
    const sdk = {
        config: { botUsername: o.user ?? 'nosuchbot' },
        getPlayer: () => ({
            className: o.className ?? 'Enchanter', realm: 'hibernia', regionId: o.at?.regionId ?? SPAWN.regionId, x: o.at?.x ?? SPAWN.x + 3000, y: o.at?.y ?? SPAWN.y,
            level: o.level ?? 10, specPoints: o.points ?? 100, isDead: !!o.isDead,
        }),
        getSkills: () => ({ specializations: o.specs ?? [{ name: 'Mana Magic', level: 5 }, { name: 'Light Magic', level: 1 }] }),
    } as any;
    return { m: o.shape === 'actions' ? { sdk, actions, bot: o.folder } : { sdk, bot: actions }, log };
}

const here = (p: { x: number; y: number; regionId: number }, realm: 'albion' | 'midgard' | 'hibernia', className: string) => ({ ...p, realm, className });
const actionsOf = (m: TrainMember) => ('actions' in m ? m.actions : m.bot);

describe('nearestClassTrainer', () => {
    test('every class a character can be has trainers, of its realm', () => {
        for (const c of getClasses().filter(c => c.creatable)) {
            expect(findNpcSpawns({ realm: c.realm, guild: new RegExp(`^${c.name} Trainer$`) }).length).toBeGreaterThan(0);
        }
    });

    test('goes by the class, so a female name finds the same trainer', () => {
        const p = { regionId: SPAWN.regionId, x: SPAWN.x, y: SPAWN.y };
        expect(nearestClassTrainer(here(p, 'hibernia', 'Enchanter'))?.name).toBe(SPAWN.name);
        expect(nearestClassTrainer(here(p, 'hibernia', 'Enchantress'))?.name).toBe(SPAWN.name);
    });

    test('the guild says what a spawn trains: Hrut is a Rogue trainer whatever his class type says', () => {
        const hrut = findNpcSpawns({ regionId: 100, name: 'Hrut', guild: 'Rogue Trainer' })[0]!;
        expect(hrut.classType).toBe('Trainer.RogueTrainer');
        expect(nearestClassTrainer(here(hrut, 'midgard', 'Rogue'))?.name).toBe('Hrut');
        const jucla = findNpcSpawns({ regionId: 100, name: 'Jucla' })[0]!;
        expect(jucla.classType).toBe('Trainer.MidgardRogueTrainer');
        expect(nearestClassTrainer(here(jucla, 'midgard', 'Rogue'))?.name).toBe('Jucla');
    });

    test('a Rogue trainer is of one realm, and a Master Trainer is no class trainer', () => {
        const odon = findNpcSpawns({ regionId: 1, name: 'Master Odon' })[0]!;
        expect(nearestClassTrainer(here(odon, 'albion', 'Rogue'))?.guild).toBe('Rogue Trainer');
        expect(nearestClassTrainer(here(odon, 'midgard', 'Rogue'))).toBeNull();
        const atlas = findNpcSpawns({ regionId: 165, classType: 'AtlasTrainer', realm: 'hibernia' })[0]!;
        expect(nearestClassTrainer(here(atlas, 'hibernia', 'Enchanter'))?.classType ?? 'none').not.toContain('Atlas');
    });

    test('none in a region without one', () => {
        expect(nearestClassTrainer(here({ regionId: 1, x: 0, y: 0 }, 'hibernia', 'Enchanter'))).toBeNull();
    });
});

describe('trainAtClassTrainer', () => {
    test('spends where it stands, with no walk: the server trains anywhere', async () => {
        const { m, log } = fake();
        const trip = await trainAtClassTrainer(m, { build: BUILD });
        expect(log).toEqual(['train here by Mana nuker']);
        expect(trip).toMatchObject({ success: true, trainer: null, respec: null, lines: ['trained'] });
    });

    test('a group member is the same, through its actions', async () => {
        const { m, log } = fake({ shape: 'actions' });
        expect((await trainAtClassTrainer(m, { build: BUILD })).success).toBeTrue();
        expect(log).toEqual(['train here by Mana nuker']);
    });

    test('in a region with no trainer of its class, and past any radius, the same', async () => {
        const inRegion = fake({ at: { regionId: 1 } });
        expect(await trainAtClassTrainer(inRegion.m, { build: BUILD })).toMatchObject({ success: true, trainer: null });
        expect(inRegion.log).toEqual(['train here by Mana nuker']);
        const far = fake({ at: { x: SPAWN.x + TRAINER_RADIUS + 500, y: SPAWN.y } });
        expect(await trainAtClassTrainer(far.m, { build: BUILD })).toMatchObject({ success: true, trainer: null });
        expect(far.log).toEqual(['train here by Mana nuker']);
    });

    test('already beside a trainer, it names it and no walk', async () => {
        const { m, log } = fake({ at: { x: SPAWN.x + 100, y: SPAWN.y } });
        await trainAtClassTrainer(m, { build: BUILD });
        expect(log).toEqual([`train at ${SPAWN.name} by Mana nuker`]);
    });

    describe('on a server that wants a trainer for training', () => {
        test('it walks to one and spends the points there', async () => {
            const { m, log } = fake({ trains: [WANTS_TRAINER] });
            const trip = await trainAtClassTrainer(m, { build: BUILD });
            expect(log).toEqual(['train here by Mana nuker', `walk ${SPAWN.x},${SPAWN.y}`, `train at ${SPAWN.name} by Mana nuker`]);
            expect(trip).toMatchObject({ success: true, trainer: SPAWN.name, respec: null });
            expect(trip.lines).toEqual([WANTS_TRAINER.message, `walked 3000 units to ${SPAWN.name}`, 'trained']);
        });

        test('a trainer too far stops with the distance, and nothing moves', async () => {
            const { m, log } = fake({ at: { x: SPAWN.x + TRAINER_RADIUS + 500, y: SPAWN.y }, trains: [WANTS_TRAINER] });
            const near = findNpcSpawns({ regionId: SPAWN.regionId, near: { x: SPAWN.x + TRAINER_RADIUS + 500, y: SPAWN.y }, guild: 'Enchanter Trainer' })[0]!;
            const trip = await trainAtClassTrainer(m, { build: BUILD });
            expect(near.distance!).toBeGreaterThan(TRAINER_RADIUS);
            expect(trip).toMatchObject({ success: false, reason: 'too_far', trainer: null });
            expect(trip.lines[1]).toContain(`${Math.round(near.distance!)} units away`);
            expect(trip.lines[1]).toContain(near.name);
            expect(log).toEqual(['train here by Mana nuker']);
        });

        test('no trainer in the region says which regions have one', async () => {
            const { m, log } = fake({ at: { regionId: 1 }, trains: [WANTS_TRAINER] });
            const trip = await trainAtClassTrainer(m, { build: BUILD });
            expect(trip).toMatchObject({ success: false, reason: 'no_trainer' });
            expect(trip.lines[1]).toContain('region 1');
            expect(trip.lines[1]).toContain('200');
            expect(log).toEqual(['train here by Mana nuker']);
        });

        test('a failed walk is its reason', async () => {
            const { m, log } = fake({ trains: [WANTS_TRAINER], walk: { success: false, reason: 'stuck', message: 'no progress' } });
            const trip = await trainAtClassTrainer(m, { build: BUILD });
            expect(trip).toMatchObject({ success: false, reason: 'stuck', trainer: null });
            expect(trip.lines[1]).toContain(SPAWN.name);
            expect(log).toHaveLength(2);
        });
    });

    test('another failure where it stands is the result, with no walk', async () => {
        const { m, log } = fake({ trains: [{ success: false, reason: 'refused', message: 'no' }] });
        expect(await trainAtClassTrainer(m, { build: BUILD })).toMatchObject({ success: false, reason: 'refused', lines: ['no'] });
        expect(log).toEqual(['train here by Mana nuker']);
    });

    describe('the bot\'s own build, by folder', () => {
        let root = '';
        let cwd: { mockRestore(): void } | null = null;
        afterEach(() => {
            cwd?.mockRestore();
            cwd = null;
            rmSync(root, { recursive: true, force: true });
        });

        test('a group member\'s folder, though another folder is named after its username', async () => {
            root = mkdtempSync(join(tmpdir(), 'daoc-trainfolder-'));
            for (const [folder, name] of [['tank1', 'In the folder'], ['tankuser', 'Named after the login']] as const) {
                mkdirSync(join(root, 'bots', folder), { recursive: true });
                writeFileSync(join(root, 'bots', folder, 'bot.env'), 'BOT_USERNAME=tankuser\n');
                writeFileSync(join(root, 'bots', folder, 'build.ts'), `export default { className: 'Enchanter', name: '${name}', targets: [{ level: 24, specs: { Mana: 16 } }] };`);
            }
            cwd = spyOn(process, 'cwd').mockReturnValue(root);
            const { m, log } = fake({ shape: 'actions', folder: 'tank1', user: 'tankuser' });
            expect(await trainAtClassTrainer(m)).toMatchObject({ success: true });
            expect(log).toEqual(['train here by In the folder']);
        });

        test('a bot on its own names its folder in the advice, by its username', async () => {
            root = mkdtempSync(join(tmpdir(), 'daoc-trainfolder-'));
            mkdirSync(join(root, 'bots', 'alias'), { recursive: true });
            writeFileSync(join(root, 'bots', 'alias', 'bot.env'), 'BOT_USERNAME=login\n');
            cwd = spyOn(process, 'cwd').mockReturnValue(root);
            const trip = await trainAtClassTrainer(fake({ user: 'login' }).m);
            expect(trip).toMatchObject({ success: false, reason: 'no_build' });
            expect(trip.lines[0]).toContain('bun bots/choose-build.ts alias');
        });
    });

    test('without a build it reports that and stays', async () => {
        const { m, log } = fake();
        const trip = await trainAtClassTrainer(m);
        expect(trip).toMatchObject({ success: false, reason: 'no_build' });
        expect(trip.lines[0]).toContain('bun bots/choose-build.ts nosuchbot');
        expect(log).toEqual([]);
    });

    test('a base class that could promote hears so first, and still trains', async () => {
        const promote = 'Magician at level 5 can promote to Enchanter: do that first';
        const at5 = fake({ className: 'Magician', level: 5, points: 14, specs: [{ name: 'Mana Magic', level: 1 }] });
        const trip = await trainAtClassTrainer(at5.m, { build: BUILD });
        expect(trip.lines[0]).toStartWith(promote);
        expect(trip.success).toBeTrue();
        expect(at5.log.some(l => l.startsWith('train here'))).toBeTrue();

        const at4 = fake({ className: 'Magician', level: 4, points: 9, specs: [{ name: 'Mana Magic', level: 1 }] });
        expect((await trainAtClassTrainer(at4.m, { build: BUILD })).lines.join()).not.toContain('promote');
        expect((await trainAtClassTrainer(fake({ level: 5 }).m, { build: BUILD })).lines.join()).not.toContain('promote');
    });

    test('a build passed in with problems goes to trainBuild to be named, with no walk and no crash on its empty targets', async () => {
        const { m, log } = fake({ trains: [{ success: false, message: 'The build has no targets.', reason: 'invalid_build' }] });
        const trip = await trainAtClassTrainer(m, { build: { className: 'Enchanter', name: 'Empty', targets: [] }, respec: true });
        expect(trip).toMatchObject({ success: false, reason: 'invalid_build' });
        expect(log).toEqual(['train here by Empty']);
    });

    test('dead stays where it lies', async () => {
        const { m, log } = fake({ isDead: true });
        expect(await trainAtClassTrainer(m, { build: BUILD })).toMatchObject({ success: false, reason: 'dead' });
        expect(log).toEqual([]);
    });

    test('with nothing to raise it does not walk: trainBuild says so without a trainer', async () => {
        const { m, log } = fake({ points: 2, trains: [{ message: 'saving for Mana 6: 2/6 points' }] });
        const trip = await trainAtClassTrainer(m, { build: BUILD });
        expect(log).toEqual(['train here by Mana nuker']);
        expect(trip).toMatchObject({ success: true, trainer: null, lines: ['saving for Mana 6: 2/6 points'] });
    });

    test('with nothing to raise and the trainer close by, it names the trainer: stale points get their refresh there', async () => {
        const { m, log } = fake({ at: { x: SPAWN.x + 250, y: SPAWN.y }, points: 2, trains: [{ message: 'saving for Mana 6: 2/6 points' }] });
        const trip = await trainAtClassTrainer(m, { build: BUILD });
        expect(log).toEqual([`train at ${SPAWN.name} by Mana nuker`]);
        expect(trip).toMatchObject({ success: true, trainer: SPAWN.name, lines: ['saving for Mana 6: 2/6 points'] });
    });

    test('just past close by, it does not name the trainer', async () => {
        const { m, log } = fake({ at: { x: SPAWN.x + 301, y: SPAWN.y }, points: 2 });
        await trainAtClassTrainer(m, { build: BUILD });
        expect(log).toEqual(['train here by Mana nuker']);
    });

    test('nothing to raise, and no trainer in reach, is no problem', async () => {
        const { m } = fake({ at: { regionId: 1 }, points: 0 });
        expect(await trainAtClassTrainer(m, { build: BUILD })).toMatchObject({ success: true });
    });

    describe('respec', () => {
        const OVER = [{ spec: 'Light', level: 8, target: 1 }];
        const overSpecs = [{ name: 'Mana Magic', level: 5 }, { name: 'Light Magic', level: 8 }];

        test('only when asked: otherwise it spends where it stands, and a line says what it would do', async () => {
            const { m, log } = fake({ specs: overSpecs, trains: [{ over: OVER, message: 'Mana 5 → 10. Over target: Light 8' }] });
            const trip = await trainAtClassTrainer(m, { build: BUILD });
            expect(log).toEqual(['train here by Mana nuker']);
            expect(trip.success).toBeTrue();
            expect(trip.lines.at(-1)).toContain('--respec');
        });

        test('asked, with lines over: train, respec, train again, and the last result counts', async () => {
            const { m, log } = fake({ specs: overSpecs, trains: [{ over: OVER, message: 'first' }, { message: 'second' }] });
            const trip = await trainAtClassTrainer(m, { build: BUILD, respec: true });
            expect(log).toEqual([`walk ${SPAWN.x},${SPAWN.y}`, `train at ${SPAWN.name} by Mana nuker`, `respec at ${SPAWN.name}`, `train at ${SPAWN.name} by Mana nuker`]);
            expect(trip.lines).toEqual([`walked 3000 units to ${SPAWN.name}`, 'first', 'regained 10', 'second']);
            expect(trip.train?.message).toBe('second');
            expect(trip.respec?.success).toBeTrue();
            expect(trip.success).toBeTrue();
        });

        test('asked, with nothing to raise but lines over, it still walks to the trainer', async () => {
            const { m, log } = fake({ points: 0, specs: overSpecs, trains: [{ over: OVER }, {}] });
            await trainAtClassTrainer(m, { build: BUILD, respec: true });
            expect(log[0]).toStartWith('walk');
            expect(log).toContain(`respec at ${SPAWN.name}`);
        });

        test('asked, with no line over, no respec and no walk', async () => {
            const { m, log } = fake();
            await trainAtClassTrainer(m, { build: BUILD, respec: true });
            expect(log).toEqual(['train here by Mana nuker']);
        });

        test('asked, with lines over and a trainer too far: stops with the distance, and spends nothing', async () => {
            const { m, log } = fake({ specs: overSpecs, at: { x: SPAWN.x + TRAINER_RADIUS + 500, y: SPAWN.y } });
            const near = findNpcSpawns({ regionId: SPAWN.regionId, near: { x: SPAWN.x + TRAINER_RADIUS + 500, y: SPAWN.y }, guild: 'Enchanter Trainer' })[0]!;
            const trip = await trainAtClassTrainer(m, { build: BUILD, respec: true });
            expect(trip).toMatchObject({ success: false, reason: 'too_far', trainer: null });
            expect(trip.lines[0]).toContain(`${Math.round(near.distance!)} units away`);
            expect(trip.lines[0]).toContain('for the respec');
            expect(trip.lines[0]).toContain('--radius');
            expect(log).toEqual([]);
        });

        test('asked, a radius reaches a trainer past the default', async () => {
            const at = { x: SPAWN.x + TRAINER_RADIUS + 500, y: SPAWN.y };
            const near = findNpcSpawns({ regionId: SPAWN.regionId, near: at, guild: 'Enchanter Trainer' })[0]!;
            const { m, log } = fake({ specs: overSpecs, at, trains: [{ over: OVER }, {}] });
            const trip = await trainAtClassTrainer(m, { build: BUILD, respec: true, radius: Math.ceil(near.distance!) });
            expect(trip).toMatchObject({ success: true, trainer: near.name });
            expect(log).toEqual([`walk ${near.x},${near.y}`, `train at ${near.name} by Mana nuker`, `respec at ${near.name}`, `train at ${near.name} by Mana nuker`]);
        });

        test('asked, with lines over and no trainer in the region: says which regions have one, and spends nothing', async () => {
            const { m, log } = fake({ specs: overSpecs, at: { regionId: 1 } });
            const trip = await trainAtClassTrainer(m, { build: BUILD, respec: true });
            expect(trip).toMatchObject({ success: false, reason: 'no_trainer' });
            expect(trip.lines[0]).toContain('region 1 for the respec');
            expect(trip.lines[0]).toContain('200');
            expect(log).toEqual([]);
        });

        test('a failed training does not respec: its cause is unknown', async () => {
            const { m, log } = fake({ specs: overSpecs, trains: [{ success: false, reason: 'refused', message: 'no', over: OVER }] });
            const trip = await trainAtClassTrainer(m, { build: BUILD, respec: true });
            expect(log.some(l => l.startsWith('respec'))).toBeFalse();
            expect(trip).toMatchObject({ success: false, reason: 'refused' });
        });

        test('a refused respec stops with its reason, and trains no more', async () => {
            const { m, log } = fake({ specs: overSpecs, trains: [{ over: OVER }], respec: { success: false, reason: 'refused', message: 'You must be speaking with your trainer to respec.' } });
            const trip = await trainAtClassTrainer(m, { build: BUILD, respec: true });
            expect(trip).toMatchObject({ success: false, reason: 'refused', train: { message: 'trained', over: OVER } });
            expect(trip.lines.at(-1)).toContain('speaking with your trainer');
            expect(log.filter(l => l.startsWith('train'))).toHaveLength(1);
        });
    });
});

describe('trainAtTrainer', () => {
    const OVER = [{ spec: 'Light', level: 8, target: 1 }];

    test('trains at the trainer it is given, with no walk', async () => {
        const { m, log } = fake();
        const run = await trainAtTrainer(actionsOf(m), 'Lirazel', { build: BUILD });
        expect(log).toEqual(['train at Lirazel by Mana nuker']);
        expect(run).toEqual({ success: true, lines: ['trained'], train: expect.objectContaining({ message: 'trained' }), respec: null });
    });

    test('without a build it leaves the choice to trainBuild: the bot\'s own', async () => {
        const { m, log } = fake();
        await trainAtTrainer(actionsOf(m), 'Lirazel');
        expect(log).toEqual(['train at Lirazel by its own build']);
    });

    test('a failed training is the result, with its reason', async () => {
        const { m } = fake({ trains: [{ success: false, reason: 'refused', message: 'no' }] });
        expect(await trainAtTrainer(actionsOf(m), 'Lirazel', { build: BUILD })).toMatchObject({ success: false, reason: 'refused', lines: ['no'] });
    });

    test('lines over, not asked to respec: a line says what would give them back', async () => {
        const { m, log } = fake({ trains: [{ over: OVER, message: 'over' }] });
        const run = await trainAtTrainer(actionsOf(m), 'Lirazel', { build: BUILD });
        expect(log).toHaveLength(1);
        expect(run).toMatchObject({ success: true, respec: null, lines: ['over', '--respec gives those points back'] });
    });

    test('asked to respec, with lines over: train, respec, train again, and the last result counts', async () => {
        const { m, log } = fake({ trains: [{ over: OVER, message: 'first' }, { message: 'second' }] });
        const run = await trainAtTrainer(actionsOf(m), 'Lirazel', { build: BUILD, respec: true });
        expect(log).toEqual(['train at Lirazel by Mana nuker', 'respec at Lirazel', 'train at Lirazel by Mana nuker']);
        expect(run).toMatchObject({ success: true, lines: ['first', 'regained 10', 'second'], train: { message: 'second' }, respec: { success: true } });
    });

    test('asked to respec, with no line over: none', async () => {
        const { m, log } = fake();
        await trainAtTrainer(actionsOf(m), 'Lirazel', { build: BUILD, respec: true });
        expect(log).toEqual(['train at Lirazel by Mana nuker']);
    });

    test('a failed first run does not respec: its cause is unknown', async () => {
        const { m, log } = fake({ trains: [{ success: false, reason: 'refused', message: 'no', over: OVER }] });
        expect(await trainAtTrainer(actionsOf(m), 'Lirazel', { build: BUILD, respec: true })).toMatchObject({ success: false, reason: 'refused', respec: null });
        expect(log).toHaveLength(1);
    });

    test('a refused respec stops with its reason, and trains no more', async () => {
        const { m, log } = fake({ trains: [{ over: OVER, message: 'first' }], respec: { success: false, reason: 'refused', message: 'You must be speaking with your trainer to respec.' } });
        const run = await trainAtTrainer(actionsOf(m), 'Lirazel', { build: BUILD, respec: true });
        expect(run).toMatchObject({ success: false, reason: 'refused', lines: ['first', 'You must be speaking with your trainer to respec.'], train: { message: 'first', over: OVER } });
        expect(log.filter(l => l.startsWith('train'))).toHaveLength(1);
    });

    test('with no trainer it trains where it stands, and a respec waits for one', async () => {
        const { m, log } = fake({ trains: [{ over: OVER, message: 'over' }] });
        const run = await trainAtTrainer(actionsOf(m), null, { build: BUILD, respec: true });
        expect(log).toEqual(['train here by Mana nuker']);
        expect(run).toMatchObject({ success: true, respec: null, lines: ['over'] });
    });
});

describe('trainFlags', () => {
    test('--respec and --radius=<units>, in any order', () => {
        expect(trainFlags([])).toEqual({ respec: false });
        expect(trainFlags(['--respec'])).toEqual({ respec: true });
        expect(trainFlags(['--radius=12000'])).toEqual({ respec: false, radius: 12000 });
        expect(trainFlags(['--radius=12000', '--respec'])).toEqual({ respec: true, radius: 12000 });
    });

    test.each([['--respec=false'], ['--respec=true'], ['--respek'], ['respec'], ['--radius'], ['--radius=far'], ['--radius=-1']])('%s is refused, not read as a yes or a no', arg => {
        expect(trainFlags([arg])).toBeNull();
        expect(trainFlags(['--respec', arg])).toBeNull();
    });

    test.each([['--respec=false'], ['--respek'], ['respec'], ['--radius=far']])('the group script answers %s with its usage, before it connects', async arg => {
        const script = join(import.meta.dir, '..', '..', 'groups', '_template', 'train.ts');
        const p = Bun.spawn(['bun', script, arg], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GATEWAY_URL: 'ws://localhost:59999' } });
        const said = await new Response(p.stderr).text();
        expect(await p.exited).toBe(2);
        expect(said).toContain('Usage:');
    });
});

describe('trainingDue', () => {
    /** Level 20: BUILD's current target is Mana 24, capped at 20. */
    const due = (points: number, mana: number, o: { build?: Build | null; className?: string; level?: number } = {}) => {
        const level = o.level ?? 20;
        const { m } = fake({ level, points, className: o.className, specs: [{ name: 'Mana Magic', level: mana }] });
        return trainingDue(m.sdk, o.build === undefined ? BUILD : o.build);
    };

    test('points at the character\'s level and a line to raise: yes', () => {
        expect(due(20, 5)).toBeTrue();
        expect(due(300, 5)).toBeTrue();
    });

    test('points below the level: no, though they would buy something', () => {
        expect(due(19, 5)).toBeFalse();
    });

    test('a finished build with many banked points: no', () => {
        expect(due(500, 20)).toBeFalse();
    });

    test('a build waiting on an expensive line: no', () => {
        expect(due(19, 19)).toBeFalse();
    });

    test('no build: no', () => {
        expect(due(500, 5, { build: null })).toBeFalse();
    });

    test('a build with no targets, which the rule can\'t read: no', () => {
        expect(due(500, 5, { build: { className: 'Enchanter', name: 'Empty', targets: [] } })).toBeFalse();
    });

    test('not in game: no', () => {
        const { m } = fake();
        expect(trainingDue({ getPlayer: () => null, getSkills: m.sdk.getSkills }, BUILD)).toBeFalse();
    });

    test('a base class counts like any other', () => {
        expect(due(14, 1, { className: 'Magician', level: 5 })).toBeTrue();
    });
});
