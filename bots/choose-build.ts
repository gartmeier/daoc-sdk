#!/usr/bin/env bun
// Choose a bot's build: copy one from the catalogue (data/builds/) to bots/<bot>/build.ts, where it's the
// character's own to change. bot.trainBuild(trainer) spends the points by that file (learnings/builds.md).
//
//   bun bots/choose-build.ts <bot>                                   # the builds of its class
//   bun bots/choose-build.ts <bot> "Mana nuker" [--force]            # writes bots/<bot>/build.ts
//   bun bots/choose-build.ts <bot> "Polearm hybrid" --class=Armsman  # a bot made as a base class, before or after it promotes
//
// bun bots/create-bot.ts <name> --class=.. --build=.. does the same when the bot is created, and this file is
// where it gets the listing and the writer from.

import { existsSync, readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { defaultCharName } from '../client/client';
import { getClass, getRace, getStartingClasses, realmId, realmName, type ClassInfo, type RaceInfo } from '../data/index';
import { getBuild, getClassBuilds, type Build, type BuildTarget } from '../data/builds';
import { parseEnvFile } from '../sdk/index';

const REALMS = ['albion', 'midgard', 'hibernia'] as const;
/** Where bot folders go (overridable for tests), as in create-bot.ts. */
const BOTS_DIR = process.env.DAOC_BOTS_DIR || import.meta.dir;

function die(message: string): never {
    console.error(`Error: ${message}`);
    process.exit(1);
}

/** The catalogue file of a class. */
export const buildSourceFile = (className: string): string => `data/builds/${className.toLowerCase()}.ts`;

/** "Mana 49, Light 22". An empty target is a real step: the points stay banked up to its level. */
export function specsText(specs: BuildTarget['specs']): string {
    const lines = Object.entries(specs).map(([spec, level]) => `${spec} ${level}`);
    return lines.length ? lines.join(', ') : 'nothing: the points stay banked';
}

/**
 * The advanced classes of a base class that have builds. Mauler, Heretic and the like have none, because they can't
 * be created. With a race, only those it can promote to: a base class takes races its advanced classes refuse
 * (CanPromotePlayer, GameTrainer.cs:300-318).
 */
export function promotionsWithBuilds(base: ClassInfo, raceId?: number): string[] {
    return base.advancedClassIds.map(id => getClass(id)!)
        .filter(c => getClassBuilds(c.key) && (raceId === undefined || c.eligibleRaceIds.includes(raceId)))
        .map(c => c.name);
}

/** One class in full, as --builds=<class> and choose-build print it. */
function classLines(cls: ClassInfo): string[] {
    const realm = realmName(cls.realm);
    const catalogue = getClassBuilds(cls.key);
    if (!catalogue) {
        if (!cls.isBaseClass) return [`${cls.name} (${realm}) has no builds: it can't be created on this server.`];
        const promotions = promotionsWithBuilds(cls);
        return [
            `${cls.name} (${realm}) is a base class and has no builds of its own. It promotes to ${promotions.join(', ')}.`,
            `See one with bun bots/create-bot.ts --builds=${promotions[0]}`,
        ];
    }
    const file = buildSourceFile(cls.name);
    const lines = [`${cls.name} (${realm}${cls.isBaseClass ? '' : `, starts as ${cls.baseClassName}`}), builds in ${file}:`];
    for (const build of catalogue.builds) {
        lines.push('', `  ${build.name} [${build.basis}]`, `    ${build.role}`);
        const width = Math.max(...build.targets.map(t => String(t.level).length));
        for (const t of build.targets) lines.push(`    level ${String(t.level).padStart(width)}: ${specsText(t.specs)}`);
    }
    lines.push(
        '',
        'adapted: a guide gives the numbers or the shape, fitted to this server. derived: the numbers are ours.',
        `Why each build, its buying order and its sources are in ${file}.`,
    );
    return lines;
}

/**
 * A class's builds in words, or null for a name no class answers to. "Rogue" means one class per realm
 * unless `realm` says which.
 */
export function classBuildsLines(name: string, realm?: string): string[] | null {
    const found = (realm ? [realm] : REALMS).map(r => getClass(name, realmId(r))).filter(c => !!c);
    const classes = [...new Map(found.map(c => [c.id, c])).values()];
    if (!classes.length) return null;
    return classes.flatMap((c, i) => [...(i ? [''] : []), ...classLines(c)]);
}

/** Every class's builds by realm and base class, one line per class. */
export function buildsOverviewLines(): string[] {
    const lines: string[] = [];
    for (const realm of REALMS) {
        lines.push(`${realm}:`);
        for (const base of getStartingClasses(realm).filter(c => c.isBaseClass && c.creatable)) {
            lines.push(`  from ${base.name}:`);
            // Not commas: a build's name can have them.
            for (const name of promotionsWithBuilds(base)) lines.push(`    ${name.padEnd(13)}${getClassBuilds(name)!.builds.map(b => b.name).join(' | ')}`);
        }
        lines.push('');
    }
    lines.push('A base class has no builds of its own: a character chooses when it promotes, or starts as the advanced class.');
    lines.push('A class in full: bun bots/create-bot.ts --builds=<class>');
    return lines;
}

const quote = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** Most lines are one word; Two Handed and Matter Magic need quotes. */
const objectKey = (k: string): string => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k));

function specsLiteral(specs: BuildTarget['specs']): string {
    const entries = Object.entries(specs);
    return entries.length ? `{ ${entries.map(([k, v]) => `${objectKey(k)}: ${v}`).join(', ')} }` : '{}';
}

/** What bots/<bot>/build.ts holds: the targets as they are, because the order of a target's lines is the buying order. */
export function buildFileText(character: string, build: Build): string {
    const targets = build.targets.map(t => `        { level: ${t.level}, specs: ${specsLiteral(t.specs)} },`);
    return [
        `// ${character}'s spec points: ${build.name}, copied from ${buildSourceFile(build.className)}. This copy is the character's own: change it`,
        '// freely. bot.trainBuild(trainer) reads it and buys the lines in the order listed (learnings/builds.md).',
        "import type { Build } from '../../data/builds';",
        '',
        'export default {',
        `    className: ${quote(build.className)},`,
        `    name: ${quote(build.name)},`,
        '    targets: [',
        ...targets,
        '    ],',
        '} satisfies Build;',
        '',
    ].join('\n');
}

/**
 * Write <botDir>/build.ts and return its path. An existing file stays, with the write failing as EEXIST,
 * unless `force`: it may hold the character's own changes.
 */
export async function writeBuildFile(botDir: string, character: string, build: Build, opts: { force?: boolean } = {}): Promise<string> {
    const path = join(botDir, 'build.ts');
    await writeFile(path, buildFileText(character, build), { flag: opts.force ? 'w' : 'wx' });
    return path;
}

interface Args {
    bot?: string;
    buildName?: string;
    className?: string;
    force: boolean;
}

function parseArgs(argv: string[]): Args {
    const args: Args = { force: false };
    const words: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        const [flag, inline] = arg.split(/=(.*)/s, 2) as [string, string?];
        switch (flag) {
            case '--help': case '-h':
                console.log('Usage: bun bots/choose-build.ts <bot> [<build name>] [--class=<advanced class>] [--force]');
                process.exit(0);
            case '--force': args.force = true; break;
            case '--class': {
                const value = inline ?? (argv[i + 1]?.startsWith('-') ? undefined : argv[++i]);
                if (!value) die('--class needs a value (--class=...)');
                args.className = value;
                break;
            }
            default:
                if (arg.startsWith('-')) die(`unknown option ${arg} (see --help)`);
                if (args.bot === undefined) args.bot = arg;
                else words.push(arg);
        }
    }
    // Quoted or not: bun bots/choose-build.ts mybot Mana nuker.
    if (words.length) args.buildName = words.join(' ');
    return args;
}

/**
 * What a bot made as a base class does about a build. Its bot.env keeps that class after a promotion, so --class names
 * the class in both cases.
 */
function baseClassAdvice(bot: string, base: ClassInfo, race: RaceInfo | undefined, buildName?: string): string {
    const open = promotionsWithBuilds(base, race?.id);
    if (!open.length) return `Its race, ${race?.name}, can promote to no class with builds.`;
    const command = `bun bots/choose-build.ts ${bot}${buildName ? ` "${buildName}"` : ''} --class=${open[0]}`;
    return `${race ? `Its race, ${race.name}, can promote to ${open.join(', ')}. ` : ''}Before or after promoting, name the class, because bot.env keeps ${base.name}: ${command}`;
}

/** The class to choose for: what bot.env says, or with --class, an advanced class it can promote to. */
function classToChoose(bot: string, env: Record<string, string>, requested: string | undefined, race: RaceInfo | undefined): ClassInfo {
    const realm = env.REALM ? realmId(env.REALM) : undefined;
    const own = env.CLASS ? getClass(env.CLASS, realm) : undefined;
    if (env.CLASS && !own) die(`bots/${bot}/bot.env has an unknown CLASS "${env.CLASS}"`);
    if (!requested) return own ?? die(`bots/${bot}/bot.env has no CLASS; pass --class=<class>`);
    const wanted = getClass(requested, realm);
    if (!wanted) die(`unknown class '${requested}'${env.REALM ? ` in ${env.REALM}` : ''} (see bun bots/create-bot.ts --list)`);
    if (own && wanted.id !== own.id && !own.advancedClassIds.includes(wanted.id)) {
        die(own.isBaseClass
            ? `${own.name} promotes to ${promotionsWithBuilds(own).join(', ')}, not ${wanted.name}`
            : `${bot}'s class is ${own.name}, not ${wanted.name}`);
    }
    if (race && !wanted.eligibleRaceIds.includes(race.id)) {
        const open = own ? promotionsWithBuilds(own, race.id) : [];
        die(`${bot}'s race, ${race.name}, can't become ${wanted.name}: the trainer would refuse the promotion. ${open.length ? `It can promote to ${open.join(', ')}` : 'It can promote to no class with builds'}`);
    }
    return wanted;
}

async function main(argv: string[]): Promise<void> {
    const args = parseArgs(argv);
    if (!args.bot) die('Usage: bun bots/choose-build.ts <bot> [<build name>] [--class=<advanced class>] [--force]');
    const { bot } = args;
    const botDir = join(BOTS_DIR, bot);
    const envPath = join(botDir, 'bot.env');
    if (!existsSync(envPath)) die(`no bots/${bot}/bot.env (create it with bun bots/create-bot.ts ${bot} ...)`);
    const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
    const race = env.RACE ? getRace(env.RACE) : undefined;
    const cls = classToChoose(bot, env, args.className, race);
    const catalogue = getClassBuilds(cls.key);
    const listing = classBuildsLines(cls.key)!;

    if (!args.buildName) {
        for (const line of listing) console.log(line);
        if (catalogue) console.log(`\nChoose one: bun bots/choose-build.ts ${bot} "${catalogue.builds[0]!.name}"${args.className ? ` --class=${cls.name}` : ''}`);
        else if (cls.isBaseClass) console.log(`\n${baseClassAdvice(bot, cls, race)}`);
        return;
    }

    if (!catalogue) die([...listing, ...(cls.isBaseClass ? ['', baseClassAdvice(bot, cls, race, args.buildName)] : [])].join('\n'));
    const build = getBuild(cls.key, args.buildName);
    if (!build) die(`${cls.name} has no build "${args.buildName}". Its builds: ${catalogue.builds.map(b => b.name).join(', ')}`);

    const character = env.CHAR_NAME || defaultCharName(env.BOT_USERNAME || bot);
    try {
        await writeBuildFile(botDir, character, build, { force: args.force });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        die(`bots/${bot}/build.ts exists and may hold the character's own changes; --force replaces it`);
    }
    console.log(`Wrote bots/${bot}/build.ts: ${build.name}, ${cls.name}`);
    for (const t of build.targets) console.log(`  level ${t.level}: ${specsText(t.specs)}`);
    console.log(`\nWhy and in which order: ${buildSourceFile(cls.name)}. Spend the points with: bun bots/examples/train-build.ts ${bot}`);
}

if (import.meta.main) await main(process.argv.slice(2));
