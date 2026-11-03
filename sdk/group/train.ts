// Spending the points by one's own build, for a bot (bots/examples/train-build.ts) or a group's members
// (groups/_template/train.ts). The build is bots/<bot>/build.ts; what to raise next is the rule in data/builds/rule.ts,
// and bot.trainBuild plays it. See learnings/builds.md.
//
// Only a respec needs a trainer of the class (respec.cs:62-67). The server trains anywhere while allow_train_anywhere is
// on, as by default and here (train.cs:143), so training happens where the character stands, and the walk is for a
// respec or a server with that property off.
//
// Game failures come back as lines and a reason, as with gear-care.ts. A broken build.ts throws: loadBuild's error.

import { findNpcSpawns, getClass, type ClassInfo, type NpcSpawnMatch } from '../../data/index';
import { buildProblems, linesOverTarget, nextBuildStep, PROMOTION_LEVEL, type Build, type BuildState } from '../../data/builds';
import type { BotActions, NpcTarget, RespecResult, TrainBuildResult } from '../actions';
import { botFolder, loadBuild } from '../build';
import type { BotSDK } from '../index';
import type { PlayerState } from '../types';

/** How far this walks to a trainer, unless told otherwise (--radius). Farther takes a teleporter, or a hunt that ends nearer. */
export const TRAINER_RADIUS = 8000;
/** Standing this close, trainSpec and respec do the last steps themselves. */
const NEAR_ENOUGH = 300;

type TrainActions = Pick<BotActions, 'walkTo' | 'trainBuild' | 'respec'>;
/** A group member (`actions`, with `bot` its folder) or a bot on its own (`bot`), as CareMember. */
export type TrainMember = { sdk: Pick<BotSDK, 'getPlayer' | 'getSkills' | 'config'> } & ({ actions: TrainActions; bot?: string } | { bot: TrainActions });

export interface TrainOptions {
    /**
     * When lines are over the build's current target, walk to a trainer, respec and train again. A respec
     * ends the character's own buffs and kills its pet, so a caller asks for it.
     */
    respec?: boolean;
    /** Another build than the bot's own. */
    build?: Build;
    /** How far to walk to a trainer (default TRAINER_RADIUS). */
    radius?: number;
}

export interface TrainTrip {
    /** Trained as far as the points reach, or had nothing to raise. */
    success: boolean;
    /** not_in_game, dead, no_build, no_trainer, too_far, or the reason of the walk, trainBuild or respec. */
    reason?: string;
    /** What happened, in words. */
    lines: string[];
    /** The trainer walked to; null when it took none. */
    trainer: string | null;
    /** The last trainBuild: what it raised, what the points wait for, what is over target. */
    train: TrainBuildResult | null;
    respec: RespecResult | null;
}

/** What trainAtTrainer did. */
export type TrainRun = Omit<TrainTrip, 'trainer'>;

/**
 * The arguments of a train script: --respec and --radius=<units>. Null for anything else, which the script answers with
 * its usage: --respec=false must not pass for a yes, nor a typo for a plain run.
 */
export function trainFlags(args: readonly string[]): { respec: boolean; radius?: number } | null {
    const flags: { respec: boolean; radius?: number } = { respec: false };
    for (const arg of args) {
        const radius = /^--radius=(\d+)$/.exec(arg);
        if (arg === '--respec') flags.respec = true;
        else if (radius) flags.radius = Number(radius[1]);
        else return null;
    }
    return flags;
}

/**
 * What makes a spawn this class's trainer. The guild and realm decide ahead of the class type (Region.cs:591-599):
 * no C# class answers to the Trainer.RogueTrainer of Hrut's row, and he trains Midgard's Rogues as
 * "Rogue Trainer" (MidgardRogueTrainer.cs:29).
 */
const trainerQuery = (cls: ClassInfo) => ({ realm: cls.realm, guild: new RegExp(`^${cls.name} Trainer$`) });

/** The nearest trainer of the character's current class in its region, near or far. */
export function nearestClassTrainer(p: Pick<PlayerState, 'className' | 'regionId' | 'x' | 'y' | 'realm'>): NpcSpawnMatch | null {
    const cls = getClass(p.className, p.realm);
    return cls ? findNpcSpawns({ regionId: p.regionId, near: p, ...trainerQuery(cls) })[0] ?? null : null;
}

/** What the build rule reads. Autotrain is the current class's: a base class has none. */
const stateOf = (sdk: Pick<BotSDK, 'getSkills'>, p: PlayerState): BuildState => ({
    level: p.level, specs: sdk.getSkills().specializations, points: p.specPoints, autotrain: getClass(p.className, p.realm)?.autotrainSpecs,
});

/**
 * Whether a trip to the trainer pays: the points reach the character's level, as the town scripts ask, and the rule
 * has a line to raise. Without the rule, a finished build with banked points would go to town for ever. A base class
 * counts like any other: promotion is the caller's to decide. It reads player.specPoints, which lags behind a promotion.
 */
export function trainingDue(sdk: Pick<BotSDK, 'getPlayer' | 'getSkills'>, build: Build | null): boolean {
    const p = sdk.getPlayer();
    // One with no targets hasn't been through loadBuild, and the rule can't read it.
    if (!build?.targets.length || !p || p.specPoints < p.level) return false;
    return nextBuildStep(build, stateOf(sdk, p)).kind === 'train';
}

/**
 * Spend the points by a build at this trainer, for a script that got there its own way, or with `null` where the
 * character stands. Without `build` it is the bot's own. With `respec` and a trainer, lines over the target go back and
 * the points are spent again. It walks to nothing itself: trainSpec and respec do the last steps.
 */
export async function trainAtTrainer(actions: Pick<BotActions, 'trainBuild' | 'respec'>, trainer: NpcTarget | null, opts: Pick<TrainOptions, 'respec' | 'build'> = {}): Promise<TrainRun> {
    const run: TrainRun = { success: false, lines: [], train: null, respec: null };
    const finish = (r: TrainBuildResult): TrainRun => {
        run.train = r;
        run.lines.push(r.message);
        if (r.over.length && !opts.respec) run.lines.push('--respec gives those points back');
        return { ...run, success: r.success, ...(r.success ? {} : { reason: r.reason }) };
    };

    const first = await actions.trainBuild(trainer, opts.build);
    // Not after a failure: its cause is unknown, and a respec can't be taken back. Not with no trainer: the server would refuse.
    if (!opts.respec || trainer === null || !first.success || !first.over.length) return finish(first);
    run.train = first;
    run.lines.push(first.message);

    run.respec = await actions.respec(trainer);
    if (!run.respec.success) return { ...run, reason: run.respec.reason ?? 'refused', lines: [...run.lines, run.respec.message] };
    run.lines.push(run.respec.message);
    return finish(await actions.trainBuild(trainer, opts.build));
}

/**
 * Spend the character's points by its build. It trains where it stands, naming a trainer only when one is close by,
 * which gets to correct the points (trainBuild). It walks to the nearest trainer of its class when `respec` has lines
 * over the target to give back, and when the server wants a trainer for training (allow_train_anywhere off).
 */
export async function trainAtClassTrainer(m: TrainMember, opts: TrainOptions = {}): Promise<TrainTrip> {
    const actions = 'actions' in m ? m.actions : m.bot;
    const trip: TrainTrip = { success: false, lines: [], trainer: null, train: null, respec: null };
    const stop = (reason: string, line: string): TrainTrip => ({ ...trip, reason, lines: [...trip.lines, line] });

    const p = m.sdk.getPlayer();
    if (!p) return stop('not_in_game', 'not in game');
    if (p.isDead) return stop('dead', 'dead: release first');
    const bot = 'actions' in m && m.bot ? m.bot : m.sdk.config.botUsername;
    const build = opts.build ?? await loadBuild(bot);
    if (!build) return stop('no_build', `no build: bun bots/choose-build.ts ${botFolder(bot)} lists what to choose from`);
    const trainAt = async (trainer: string | null): Promise<TrainTrip> => {
        const run = await trainAtTrainer(actions, trainer, { respec: opts.respec, build });
        return { ...trip, ...run, lines: [...trip.lines, ...run.lines] };
    };

    // One passed in hasn't been through loadBuild, and the rule can't read one with no targets: trainBuild says what is wrong.
    if (opts.build && buildProblems(build, p.realm).length) return trainAt(null);

    const cls = getClass(p.className, p.realm);
    const state = stateOf(m.sdk, p);
    // The base trainer goes on training it, but a build's banking and its order count on promotion at 5.
    const promotesTo = getClass(build.className, p.realm);
    if (promotesTo && cls?.advancedClassIds.includes(promotesTo.id) && p.level >= PROMOTION_LEVEL) {
        trip.lines.push(`${p.className} at level ${p.level} can promote to ${promotesTo.name}: do that first, or the points go to the lines it has now (bot.respec takes them back)`);
    }
    const wantsRespec = !!opts.respec && linesOverTarget(build, state).length > 0;
    const spawn = nearestClassTrainer(p);
    if (!wantsRespec) {
        // One close by gets to correct the points (trainBuild).
        if (spawn && spawn.distance! <= NEAR_ENOUGH) {
            trip.trainer = spawn.name;
            return trainAt(spawn.name);
        }
        const here = await trainAt(null);
        // A server with allow_train_anywhere off says so, and then it walks.
        if (here.reason !== 'needs_trainer') return here;
        trip.lines.push(here.lines.at(-1)!);
    }

    const forRespec = wantsRespec ? ' for the respec' : '';
    if (!spawn) {
        const regions = cls ? [...new Set(findNpcSpawns(trainerQuery(cls)).map(s => s.regionId))] : [];
        return stop('no_trainer', `no ${p.className} trainer in region ${p.regionId}${forRespec}${regions.length ? `: there are some in ${regions.join(', ')}` : ''}`);
    }
    const radius = opts.radius ?? TRAINER_RADIUS;
    const distance = Math.round(spawn.distance!);
    if (distance > radius) return stop('too_far', `${spawn.name}, the nearest ${p.className} trainer, is ${distance} units away: too far to walk${forRespec} (limit ${radius}, --radius=<units> raises it)`);
    if (distance > NEAR_ENOUGH) {
        const walk = await actions.walkTo(spawn.x, spawn.y, { z: spawn.z, tolerance: 120 });
        if (!walk.success) return stop(walk.reason ?? 'stuck', `walk to ${spawn.name}: ${walk.reason} ${walk.message}`);
        trip.lines.push(`walked ${distance} units to ${spawn.name}`);
    }
    trip.trainer = spawn.name;
    return trainAt(spawn.name);
}
