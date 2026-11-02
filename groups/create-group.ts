#!/usr/bin/env bun
// Create groups/<group>/ from groups/_template/: group.json (members and roles),
// strategy.ts, hunt.ts and lab_log.md.
//
//   bun groups/create-group.ts <group> <bot> <bot> ... [--leader=<bot>] [--role=<bot>:<role> ...]
//
// The first bot leads unless --leader says otherwise. Roles default to the class
// in each bot.env (Hero → tank, Druid → healer, Bard → support, Mentalist → nuker, ...).

import { cp, readFile, readdir, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findBotEnv, parseEnvFile } from '../sdk/index';
import { loadCharacter } from '../sdk/group/character';
import { roleForClass } from '../sdk/group/strategy';
import type { GroupDefinition, Role } from '../sdk/group/types';

const ROLES: Role[] = ['tank', 'healer', 'support', 'nuker', 'melee'];
const GROUPS_DIR = process.env.DAOC_GROUPS_DIR || import.meta.dir;
const TEMPLATE_DIR = join(import.meta.dir, '_template');

function die(message: string): never {
    console.error(`Error: ${message}`);
    process.exit(1);
}

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flag = (k: string) => process.argv.slice(2).filter(a => a.startsWith(`--${k}=`)).map(a => a.slice(k.length + 3));
const [group, ...bots] = positional;
if (!group || !bots.length) die('Usage: bun groups/create-group.ts <group> <bot> <bot> ... [--leader=<bot>] [--role=<bot>:<role>]');
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(group) || group === '_template') die(`invalid group name "${group}"`);
const dir = join(GROUPS_DIR, group);
if (existsSync(dir)) die(`${dir} already exists`);

const roles = new Map(flag('role').map(r => r.split(':') as [string, string]));
const members: GroupDefinition['members'] = [];
const roster: string[] = [];
const realms = new Set<string>();
for (const bot of bots) {
    const path = findBotEnv(bot);
    if (!path) die(`no bots/${bot}/bot.env (create it with bun bots/create-bot.ts ${bot} ...)`);
    const env = parseEnvFile(readFileSync(path, 'utf-8'));
    const role = (roles.get(bot) ?? (await loadCharacter(bot))?.role ?? roleForClass(env.CLASS ?? '')) as Role;
    if (!ROLES.includes(role)) die(`${bot}: unknown role "${role}" (use ${ROLES.join(', ')})`);
    realms.add(env.REALM ?? '?');
    members.push(roles.has(bot) ? { bot, role } : { bot });
    roster.push(`| ${bot} | ${env.CHAR_NAME ?? bot} | ${env.CLASS ?? '?'} | ${role} |`);
}
if (realms.size > 1) die(`members must share a realm, got ${[...realms].join(', ')}`);
const leader = flag('leader')[0] ?? bots[0]!;
if (!bots.includes(leader)) die(`leader ${leader} is not a member`);

await cp(TEMPLATE_DIR, dir, { recursive: true });
const table = ['| Bot | Character | Class | Role |', '|---|---|---|---|', ...roster].join('\n');
for (const file of await readdir(dir)) {
    const p = join(dir, file);
    const text = (await readFile(p, 'utf-8')).replaceAll('{{GROUP}}', group).replaceAll('{{ROSTER}}', table);
    await writeFile(p, text);
}
const def: GroupDefinition = { name: group, leader, members };
await writeFile(join(dir, 'group.json'), JSON.stringify(def, null, 2) + '\n');
console.log(`Created ${dir}`);
console.log(table);
console.log(`\nStart the clients:  bun client/swarm.ts ${bots.join(' ')}`);
console.log(`Look:               bun sdk/group/cli.ts ${group}`);
console.log(`Hunt for a minute:  bun groups/${group}/hunt.ts 60`);
