#!/usr/bin/env bun
// Create bots/<name>/ from bots/_template/ with a validated character.
//
//   bun bots/create-bot.ts [name] [--realm=albion|midgard|hibernia] [--class=Fighter] [--race=Briton]
//                          [--build="Mana nuker" | --no-build]
//                          [--gender=male|female] [--char=Name] [--server=host:port] [--gateway=ws://..] [--no-chat]
//   bun bots/create-bot.ts --builds[=<class>]      # the builds to choose from, and exit
//
// The account is created on the server at the first login; the character is
// created by the headless client (bun client/runner.ts <name>) if missing.
//
// Builds are chosen before a bot starts: a class with builds of its own needs --build, which writes
// bots/<name>/build.ts (bots/choose-build.ts), or --no-build for a test character. A base class has none
// and chooses when it promotes.

import { cp, readFile, readdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { randomInt } from 'crypto';
import { join } from 'path';
import { classAfterCreation, getClass, getPlayableRacesForClass, getRace, getStarterArmour, getStartingClasses, realmName, validateCharacter, type ClassInfo, type RaceInfo } from '../data/index';
import { getBuild, getClassBuilds, type Build, type CatalogBuild } from '../data/builds';
import { defaultCharName } from '../client/client';
import { parseEnvFile } from '../sdk/index';
import { buildsOverviewLines, buildSourceFile, classBuildsLines, promotionsWithBuilds, specsText, writeBuildFile } from './choose-build';

type RealmName = 'albion' | 'midgard' | 'hibernia';

const REALMS: RealmName[] = ['albion', 'midgard', 'hibernia'];
// Melee base classes that start with weapon, shield and a full armour set.
// Not Guardian: on a DB seeded before our fork's starterequipment fix (docs/SERVER.md)
// it starts with sword and shield only (learnings/classes-and-races.md).
export const DEFAULTS: Record<RealmName, { class: string; race: string }> = {
    albion: { class: 'Fighter', race: 'Briton' },
    midgard: { class: 'Viking', race: 'Norseman' },
    hibernia: { class: 'Naturalist', race: 'Celt' },
};
const RESERVED = new Set(['_template', 'examples']);
const TEMPLATE_DIR = join(import.meta.dir, '_template');
/** Where bot folders go (overridable for tests). */
const BOTS_DIR = process.env.DAOC_BOTS_DIR || import.meta.dir;

function die(message: string): never {
    console.error(`Error: ${message}`);
    process.exit(1);
}

function randomString(length: number, chars: string): string {
    let out = '';
    for (let i = 0; i < length; i++) out += chars.charAt(randomInt(chars.length));
    return out;
}

function usage(): never {
    console.log(`Usage: bun bots/create-bot.ts [name] [options]

  name                account name, letters and digits, at most 12 (default: random)
  --realm=<realm>     albion (default), midgard or hibernia
  --class=<class>     starting class (default Fighter / Viking / Naturalist)
  --build=<name>      the character's build, written to bots/<name>/build.ts: required for a class with
                      builds of its own (see --builds); a base class chooses when it promotes
  --no-build          no build, for a test character
  --race=<race>       race (default: the realm's default if eligible, else the first eligible race)
  --gender=<g>        male or female (default: whatever the class/race allows, else male)
  --char=<Name>       character name (default: derived from the account, digits mapped to letters)
  --server=host:port  DAoC server (default 127.0.0.1:10300)
  --gateway=ws://..   SDK gateway (default ws://localhost:7780)
  --no-chat           hide other players' chat (SHOW_CHAT=false)
  --list              list the starting classes and races per realm
  --builds[=<class>]  list the builds: an overview per realm and class, or one class in full`);
    process.exit(0);
}

function listClasses(): never {
    for (const realm of REALMS) {
        console.log(`\n${realm}:`);
        for (const c of getStartingClasses(realm)) {
            // Only races that also have a start location: createBot refuses the others.
            const races = getPlayableRacesForClass(c.id, realm).map(r => r.name);
            if (!races.length) continue;
            const unarmoured = starterArmourWarning(c.id) ? '  [no starter armour]' : '';
            console.log(`  ${c.name.padEnd(14)} ${races.join(', ')}${c.gender ? ` (${c.gender} only)` : ''}${unarmoured}`);
        }
    }
    console.log('\nWith start_as_base_class on (the default), advanced classes start as their base class.');
    console.log('[no starter armour]: the server skips that class\'s armour rows (their item templates are missing).');
    console.log('An advanced class needs a build as well: see --builds=<class>.');
    process.exit(0);
}

/**
 * Why a class starts unarmoured, or null. With start_as_base_class on, the class
 * is already reverted when the server hands out the starter gear
 * (StartupEquipment.cs:125), so an advanced class gets its base class's gear.
 */
export function starterArmourWarning(classId: number): string | null {
    const startAs = getClass(classAfterCreation(classId));
    if (!startAs) return null;
    const { armour, missing } = getStarterArmour(startAs.id);
    if (armour.length) return null;
    const skipped = missing.filter(t => !/bead|stone/i.test(t));
    if (!skipped.length) return null;
    return `${startAs.name} gets no starter armour: the server skips ${skipped.join(', ')} (missing item templates)`;
}

function listBuilds(className: string | undefined, realm: string | undefined): never {
    if (realm && !REALMS.includes(realm as RealmName)) die(`unknown realm '${realm}' (albion, midgard, hibernia)`);
    const lines = className ? classBuildsLines(className, realm) : buildsOverviewLines();
    if (!lines) die(`unknown class '${className}'${realm ? ` in ${realm}` : ''} (see --list)`);
    for (const line of lines) console.log(line);
    process.exit(0);
}

/** Realm whose starting classes include `cls`, when exactly one does. */
function realmOfClass(cls: string): RealmName | null {
    const realms = REALMS.filter(r => getStartingClasses(r).some(c => c.name.toLowerCase() === cls.toLowerCase() || c.key.toLowerCase() === cls.toLowerCase()));
    return realms.length === 1 ? realms[0]! : null;
}

interface Args {
    name?: string;
    realm?: string;
    className?: string;
    race?: string;
    gender?: string;
    charName?: string;
    build?: string;
    noBuild: boolean;
    /** --builds: '' for the overview, unless --class names one. */
    builds?: string;
    server: string;
    gateway: string;
    showChat: boolean;
}

const VALUE_FLAGS = new Set(['--realm', '--class', '--race', '--gender', '--char', '--build', '--server', '--gateway']);

export function parseArgs(argv: string[]): Args {
    const args: Args = { noBuild: false, server: '127.0.0.1:10300', gateway: 'ws://localhost:7780', showChat: true };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        let [flag, value] = arg.split(/=(.*)/s, 2) as [string, string?];
        if (VALUE_FLAGS.has(flag)) {
            // Accept both --realm=midgard and --realm midgard.
            if (value === undefined && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('-')) value = argv[++i]!;
            if (!value) die(`${flag} needs a value (${flag}=...)`);
        }
        value ??= '';
        switch (flag) {
            case '--help': case '-h': usage();
            case '--list': listClasses();
            case '--realm': args.realm = value.toLowerCase(); break;
            case '--class': args.className = value; break;
            case '--race': args.race = value; break;
            case '--gender': args.gender = value.toLowerCase(); break;
            case '--char': args.charName = value; break;
            case '--build': args.build = value; break;
            case '--no-build': args.noBuild = true; break;
            // Its value is optional, so a next word only counts when it's no flag: --builds, --builds=Bard, --builds Bard.
            case '--builds': args.builds = value || (argv[i + 1]?.startsWith('-') ? '' : argv[++i] ?? ''); break;
            case '--server': args.server = value; break;
            case '--gateway': args.gateway = value; break;
            case '--local': break;
            case '--no-chat': case '--hide-chat': args.showChat = false; break;
            case '--show-chat': args.showChat = true; break;
            default:
                if (arg.startsWith('-')) die(`unknown option ${arg} (see --help)`);
                if (args.name) die(`unexpected argument ${arg}`);
                args.name = arg;
        }
    }
    if (args.builds !== undefined) listBuilds(args.builds || args.className, args.realm);
    return args;
}

/** The catalogue build this bot starts with; null for a base class or --no-build. Without a choice it stops here, before anything is written. */
function chosenBuild(cls: ClassInfo, args: Args): (CatalogBuild & Build) | null {
    if (args.build && args.noBuild) die('--build and --no-build contradict each other');
    const catalogue = getClassBuilds(cls.key);
    if (!catalogue) {
        if (args.build) {
            // With no --race, one the advanced class takes gets picked.
            const race = args.race ? getRace(args.race) : undefined;
            const first = cls.isBaseClass ? promotionsWithBuilds(cls, race?.id)[0] : null;
            die([
                ...classBuildsLines(cls.key)!,
                ...(first ? [`For a build from the start, name the advanced class: --class=${first} --build=.. starts as a ${cls.name}.`] : []),
                ...(cls.isBaseClass && !first ? [`A ${race?.name} ${cls.name} can promote to no class with builds.`] : []),
            ].join('\n'));
        }
        return null;
    }
    if (args.noBuild) return null;
    if (!args.build) {
        die([
            `${cls.name} needs a build, chosen before the bot starts:`,
            '',
            ...classBuildsLines(cls.key)!,
            '',
            `Choose one with --build="${catalogue.builds[0]!.name}", or pass --no-build for a test character.`,
        ].join('\n'));
    }
    const build = getBuild(cls.key, args.build);
    if (!build) die(`${cls.name} has no build "${args.build}". Its builds: ${catalogue.builds.map(b => b.name).join(', ')}`);
    return build;
}

/** The bots/<dir>/ whose bot.env already uses this character name (case-insensitive), if any. */
async function localCharNameOwner(charName: string): Promise<string | null> {
    if (!existsSync(BOTS_DIR)) return null;
    for (const entry of await readdir(BOTS_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory() || RESERVED.has(entry.name)) continue;
        const envPath = join(BOTS_DIR, entry.name, 'bot.env');
        if (!existsSync(envPath)) continue;
        const env = parseEnvFile(await readFile(envPath, 'utf-8'));
        const used = env.CHAR_NAME || defaultCharName(env.BOT_USERNAME || entry.name);
        if (used.toLowerCase() === charName.toLowerCase()) return entry.name;
    }
    return null;
}

/** The build line of the printed summary. */
function buildSummary(cls: ClassInfo, race: RaceInfo, build: Build | null, username: string): string {
    if (build) return `${build.name}, from ${buildSourceFile(build.className)}: ${build.targets.map(t => `level ${t.level}: ${specsText(t.specs)}`).join('; ')}`;
    if (cls.isBaseClass) return `none: ${cls.name} has no builds of its own. Choose one when promoting to ${promotionsWithBuilds(cls, race.id).join(', ')}`;
    return `none (--no-build): bun bots/choose-build.ts ${username} lists its builds`;
}

/** The steps a build adds. A level 1 character has no spec points to spend yet. */
function buildSteps(cls: ClassInfo, race: RaceInfo, build: Build | null, username: string): [string, string][] {
    if (build) return [[`bun bots/examples/train-build.ts ${username}`, 'once it has levelled: spend the points by build.ts']];
    if (cls.isBaseClass) return [[`bun bots/choose-build.ts ${username} --class=${promotionsWithBuilds(cls, race.id)[0]}`, "before promoting at level 5: that class's builds, and with a build's name it writes build.ts"]];
    return [];
}

async function createBot(args: Args): Promise<void> {
    const username = args.name ?? randomString(1, 'abcdefghijklmnopqrstuvwxyz') + randomString(8, 'abcdefghijklmnopqrstuvwxyz0123456789');
    if (username.length > 12) die('name must be 12 characters or less');
    if (!/^[a-zA-Z0-9]+$/.test(username)) die('name must be letters and digits only');
    if (RESERVED.has(username)) die(`'${username}' is reserved`);

    const charName = args.charName ?? defaultCharName(username);
    if (!/^[A-Z][a-zA-Z]{2,}$/.test(charName)) die(`character name '${charName}' must be letters only, at least 3, starting with a capital`);

    let realm: RealmName;
    if (args.realm) {
        if (!REALMS.includes(args.realm as RealmName)) die(`unknown realm '${args.realm}' (albion, midgard, hibernia)`);
        realm = args.realm as RealmName;
    } else {
        realm = (args.className && realmOfClass(args.className)) || 'albion';
    }
    const className = args.className ?? DEFAULTS[realm].class;
    const cls = getClass(className, realm);
    if (!cls) {
        const elsewhere = REALMS.filter(r => r !== realm && getClass(className, r));
        die(elsewhere.length
            ? `${className} is not an ${realm} class; try --realm=${elsewhere[0]} (see --list)`
            : `unknown class '${className}' (see --list)`);
    }
    let race = args.race;
    if (!race) {
        const eligible = getPlayableRacesForClass(cls.id, realm).map(r => r.name);
        race = eligible.includes(DEFAULTS[realm].race) ? DEFAULTS[realm].race : eligible[0];
        if (!race) die(`${cls.name} has no creatable race on this server (see --list)`);
    }
    if (args.gender && !['male', 'female', 'm', 'f'].includes(args.gender)) die(`gender must be male or female`);
    const gender = args.gender ? (args.gender.startsWith('f') ? 'female' : 'male') : undefined;

    const v = validateCharacter({ realm, class: cls.name, race, gender });
    if (!v.valid) die(`invalid character: ${v.errors.join('; ')} (see --list)`);
    if (v.warnings.length) die(`unusable character: ${v.warnings.join('; ')}`);
    if (!/^[^:\s]+(:\d+)?$/.test(args.server)) die(`bad --server '${args.server}' (expected host:port)`);
    if (!/^wss?:\/\//.test(args.gateway)) die(`bad --gateway '${args.gateway}' (expected ws://host:port)`);
    const build = chosenBuild(v.classInfo!, args);

    const templateDir = TEMPLATE_DIR;
    const botDir = join(BOTS_DIR, username);
    if (!existsSync(templateDir)) die(`template directory not found at ${templateDir}`);
    if (existsSync(botDir)) die(`bot directory already exists at ${botDir}`);
    const clash = await localCharNameOwner(charName);
    if (clash) die(`character name ${charName} is already used by bots/${clash}/ (names are unique server-wide); pass --char=OtherName`);

    const replacements: Record<string, string> = {
        '{{USERNAME}}': username,
        '{{PASSWORD}}': randomString(12, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'),
        '{{CHAR_NAME}}': charName,
        '{{REALM}}': realmName(v.realmId),
        '{{CLASS}}': v.classInfo!.name,
        '{{RACE}}': v.raceInfo!.name,
        '{{GENDER}}': v.gender,
        '{{SERVER}}': args.server,
        '{{GATEWAY_URL}}': args.gateway,
        '{{SHOW_CHAT}}': String(args.showChat),
    };
    await cp(templateDir, botDir, { recursive: true });
    for (const file of await readdir(botDir)) {
        const path = join(botDir, file);
        let content = await readFile(path, 'utf-8');
        for (const [key, value] of Object.entries(replacements)) content = content.replaceAll(key, value);
        await writeFile(path, content);
    }
    if (build) await writeBuildFile(botDir, charName, build);

    const base = cls.isBaseClass ? '' : ` (starts as ${cls.baseClassName} while start_as_base_class is on)`;
    const armourWarning = starterArmourWarning(cls.id);
    console.log(`Created bots/${username}/ (bot.env, script.ts, lab_log.md${build ? ', build.ts' : ''})`);
    console.log(`  account   ${username}`);
    console.log(`  character ${charName}: ${v.gender} ${v.raceInfo!.name} ${v.classInfo!.name}, ${realm}${base}`);
    console.log(`  build     ${buildSummary(v.classInfo!, v.raceInfo!, build, username)}`);
    console.log(`  server    ${args.server}, gateway ${args.gateway}, chat ${args.showChat ? 'shown' : 'hidden'}`);
    if (armourWarning) console.log(`  warning   ${armourWarning}; it fights level-1 mobs badly (see learnings/classes-and-races.md)`);
    const steps: [string, string][] = [
        ['bun gateway/gateway.ts', 'once, if nothing listens on 7780'],
        [`bun client/runner.ts ${username}`, 'headless client; leave it running (creates the account + character)'],
        [`bun sdk/cli.ts ${username}`, 'check state'],
        [`bun bots/${username}/script.ts`, 'run the starter script'],
        ...buildSteps(v.classInfo!, v.raceInfo!, build, username),
    ];
    const width = Math.max(...steps.map(([cmd]) => cmd.length)) + 2;
    console.log('\nNext:');
    for (const [cmd, why] of steps) console.log(`  ${cmd.padEnd(width)}# ${why}`);
    console.log(`Or use MCP execute_code with bot_name "${username}": it starts the gateway and client itself.`);
}

if (import.meta.main) await createBot(parseArgs(process.argv.slice(2)));
