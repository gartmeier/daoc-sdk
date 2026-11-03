#!/usr/bin/env bun
// Rewrites data/fixtures/trainer-windows.json: the real 0x7B trainer window of one level 50 character of
// every creatable class. data/skills.test.ts holds the static data against it, and the C# rules that
// data/skills.ts mirrors are only checked by a capture.
//
// When to run it: after server/core or server/db moves. Rebuild the image first if server/core did
// (docker compose -f server/docker/docker-compose.yml build gameserver), then run this and
// `bun test data/skills.test.ts`. A difference there means data/skills.ts has to follow the server.
//
//   bun scripts/capture-trainer-windows.ts [--name=<stack>] [--keep]
//
// It works on a throwaway stack of its own (scripts/throwaway-server.ts), `<checkout>-capture` by default:
// it brings it up unless it is up, and removes it at the end unless it was up before or --keep is given.
// A failed run leaves the stack for a look and writes nothing. On that stack it sets start_as_base_class=False,
// so that a character is the advanced class from the start, and disable_quit_timer=True, which saves 20 s a
// logout. Characters and accounts stay, so a second run on a kept stack only logs in.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DaocClient } from '../client/client';
import { ServerOp } from '../client/protocol/opcodes';
import { getPlayableRacesForClass, getStartingClasses } from '../data/index';
import type { Realm } from '../sdk/types';
import { pinnedCommit } from './check-submodules';
import { run, sql, sqlString } from './setup-server';
import { applyProperties, compose, composePorts, down, parseArgs as throwawayArgs, stackFor, up, waitUntilListening, type Stack } from './throwaway-server';
import { assembleWindow, compactWindow, decodeWindowPacket, formatFixture, type FixtureLine, type TrainerWindowFixture } from './trainer-window-decode';

const ROOT = join(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'data', 'fixtures', 'trainer-windows.json');
const REALMS: Realm[] = ['albion', 'midgard', 'hibernia'];
const LEVEL = 50;
const AT_ONCE = 6;
const WINDOW_TIMEOUT_MS = 30_000;
/** Throwaway accounts on a local stack: this is not a secret of anything. */
const PASSWORD = 'trainerwindow';
const PROPERTIES = [
    { key: 'start_as_base_class', value: 'False' },   // StartAsBaseClass.cs:36
    { key: 'disable_quit_timer', value: 'True' },   // ServerProperties.cs:359
];

export interface CaptureOptions {
    name: string;
    keep: boolean;
}

const USAGE = `usage: bun scripts/capture-trainer-windows.ts [options]
  --name=<name>   which throwaway stack (default: this checkout's folder name + -capture)
  --keep          leave the stack up afterwards`;

export function parseOptions(argv: string[], defaultName = `${basename(ROOT)}-capture`): CaptureOptions {
    const opts: CaptureOptions = { name: defaultName, keep: false };
    for (const arg of argv) {
        const [flag, value] = arg.split(/=(.*)/s);
        if (arg === '--keep') opts.keep = true;
        else if (flag === '--name' && value) opts.name = value;
        else throw new Error(`unknown option '${arg}'\n${USAGE}`);
    }
    return opts;
}

export interface ClassPlan {
    classKey: string;
    classId: number;
    /** Display name, what character creation takes. */
    className: string;
    realm: Realm;
    raceName: string;
    /** One account per character. */
    account: string;
    charName: string;
}

/** One character of every creatable class. Names must be letters only, and be clear of config/invalidnames.txt. */
export function classPlans(): ClassPlan[] {
    return REALMS.flatMap(realm => getStartingClasses(realm).map(c => {
        const race = getPlayableRacesForClass(c.id, c.realm, false)[0];
        if (!race) throw new Error(`no playable race for ${realm} ${c.key}`);
        const account = `wd${realm[0]}${c.key.toLowerCase().replace(/[^a-z]/g, '')}`.slice(0, 13);
        return {
            classKey: c.key, classId: c.id, className: c.name, realm, raceName: race.name,
            account, charName: account[0]!.toUpperCase() + account.slice(1),
        };
    }));
}

/** Runs fn for each class, AT_ONCE at a time. A failure doesn't stop the others, so that they all quit cleanly; then it throws with all of them. */
async function forEachClass<R>(plans: ClassPlan[], fn: (plan: ClassPlan) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(plans.length);
    const failed: string[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: AT_ONCE }, async () => {
        while (next < plans.length) {
            const i = next++;
            try {
                out[i] = await fn(plans[i]!);
            } catch (e) {
                failed.push(`${plans[i]!.classKey}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }));
    if (failed.length) throw new Error(`${failed.length} of ${plans.length} classes failed:\n  ${failed.join('\n  ')}`);
    return out;
}

/** A logged-in client for the length of `fn`, which always ends in a clean quit: anything else link-deads the character. */
async function withCharacter<R>(plan: ClassPlan, game: number, create: boolean, fn: (client: DaocClient) => Promise<R>): Promise<R> {
    const client = new DaocClient({
        host: '127.0.0.1', port: game, username: plan.account, password: PASSWORD, charName: plan.charName,
        realm: plan.realm, className: plan.className, raceName: plan.raceName, createIfMissing: create, log: () => {},
    });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.quit();
    }
}

/** Asks for the window and returns its lines. Always 0, 1, 4 per line, 3, 5 (PacketLib1105.cs), so code 5 means the rest has arrived. */
async function captureWindow(client: DaocClient, plan: ClassPlan): Promise<FixtureLine[]> {
    const self = client.session!.character!;
    if (self.classId !== plan.classId) throw new Error(`the server has it as class ${self.classId}, not ${plan.classId}`);
    if (self.level !== LEVEL) throw new Error(`logged in at level ${self.level}, not ${LEVEL}`);

    const raw: Uint8Array[] = [];
    client.session!.onPacket(p => { if (p.code === ServerOp.TrainerWindow) raw.push(p.payload.slice()); });
    const asked = await client.execute({ type: 'openTrainer' });
    if (!asked.success) throw new Error(`openTrainer: ${asked.message}`);
    const deadline = Date.now() + WINDOW_TIMEOUT_MS;
    while (!raw.some(p => p[2] === 5)) {
        if (Date.now() > deadline) throw new Error(`no complete window after ${WINDOW_TIMEOUT_MS / 1000} s, got codes ${raw.map(p => p[2]).join(',') || 'none'}`);
        await Bun.sleep(50);
    }
    return compactWindow(assembleWindow(raw.map(decodeWindowPacket)));
}

const isUp = async (stack: Stack) => (await run(['docker', 'compose', '-p', stack.project, 'ps', '-q', 'gameserver'])).stdout.trim() !== '';

async function capture(stack: Stack): Promise<TrainerWindowFixture> {
    const game = composePorts(readFileSync(stack.file, 'utf8')).game;
    if (await applyProperties(stack.ctx, PROPERTIES)) {
        console.log(`setting ${PROPERTIES.map(p => `${p.key}=${p.value}`).join(', ')} and restarting the gameserver`);
        const restarted = await compose(stack, 'restart', 'gameserver');
        if (restarted.code !== 0) throw new Error(`docker compose restart failed: ${restarted.stderr.trim()}`);
        await waitUntilListening(stack, game, 600_000);
    }

    const plans = classPlans();
    const names = plans.map(p => sqlString(p.charName)).join(',');
    const existing = new Set((await sql(stack.ctx, `SELECT Name FROM dolcharacters WHERE Name IN (${names});`)).map(([name]) => name!.toLowerCase()));
    const missing = plans.filter(p => !existing.has(p.charName.toLowerCase()));
    console.log(`creating ${missing.length} of ${plans.length} characters`);
    await forEachClass(missing, plan => withCharacter(plan, game, true, async () => {}));

    // Only while they are logged out, or the server saves over it. Spec points follow from the level (GamePlayer.cs:9949).
    await sql(stack.ctx, `UPDATE dolcharacters SET Level=${LEVEL} WHERE Name IN (${names});`);
    console.log(`capturing ${plans.length} windows at level ${LEVEL}`);
    const windows = await forEachClass(plans, plan => withCharacter(plan, game, false, client => captureWindow(client, plan)));

    const pin = (path: string): string => {
        const commit = pinnedCommit(ROOT, path);
        if (!commit) throw new Error(`git can't say what ${path} is pinned to`);
        return commit;
    };
    return {
        level: LEVEL, serverCore: pin('server/core'), serverDb: pin('server/db'),
        classes: Object.fromEntries(plans.map((plan, i) => [plan.classKey, windows[i]!])),
    };
}

/** What changed against the fixture on disk, in words. */
export function changes(before: TrainerWindowFixture | null, after: TrainerWindowFixture): string[] {
    if (!before) return ['no fixture before this'];
    const out: string[] = [];
    if (before.serverCore !== after.serverCore) out.push(`server/core ${before.serverCore.slice(0, 7)} -> ${after.serverCore.slice(0, 7)}`);
    if (before.serverDb !== after.serverDb) out.push(`server/db ${before.serverDb.slice(0, 7)} -> ${after.serverDb.slice(0, 7)}`);
    const keys = [...new Set([...Object.keys(before.classes), ...Object.keys(after.classes)])].sort();
    const differ = keys.filter(k => JSON.stringify(before.classes[k]) !== JSON.stringify(after.classes[k]));
    if (differ.length) out.push(`windows differ for ${differ.join(', ')}`);
    return out;
}

async function main(): Promise<void> {
    const opts = parseOptions(process.argv.slice(2));
    const stack = stackFor(opts.name);
    const wasUp = await isUp(stack);
    const stackOptions = (command: 'up' | 'down') => throwawayArgs([command, `--name=${opts.name}`]);
    await up(stackOptions('up'));

    const t0 = Date.now();
    let fixture: TrainerWindowFixture;
    try {
        fixture = await capture(stack);
    } catch (e) {
        console.error(`nothing written. The stack is left for a look; remove it with: bun run server:throwaway down --name=${opts.name}`);
        throw e;
    }

    const text = formatFixture(fixture);
    const before = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8') : null;
    const lines = Object.values(fixture.classes).flat();
    console.log(`${Object.keys(fixture.classes).length} classes, ${lines.length} lines, ${lines.flatMap(l => l.skills).length} skills in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    if (text === before) {
        console.log(`${FIXTURE} is unchanged, byte for byte`);
    } else {
        mkdirSync(dirname(FIXTURE), { recursive: true });
        writeFileSync(FIXTURE, text);
        const changed = changes(before === null ? null : JSON.parse(before) as TrainerWindowFixture, fixture);
        console.log(`rewrote ${FIXTURE}: ${changed.join('; ')}\nnow run: bun test data/skills.test.ts`);
    }

    if (wasUp || opts.keep) console.log(`the stack stays up; remove it with: bun run server:throwaway down --name=${opts.name}`);
    else await down(stackOptions('down'));
}

if (import.meta.main) {
    main().then(() => process.exit(0), (e: unknown) => {
        console.error(`capture-trainer-windows: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
    });
}
