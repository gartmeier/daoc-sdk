// A character's own way of playing, brought along to any group. It lives in the bot's folder,
// bots/<bot>/character.ts, as a default export, so it isn't tied to one group or strategy.
//
// The role is the character's job in a group: where it stands, what it may be ordered to do. The
// character says how it does that job. Its behaviours go into the role's list at the fight:
//
//   urgent  above the role's main action (a mezz cure that must not wait for heals and songs)
//   react   above the fight (a heal)
//   fight   replaces the role's fight (tank, assist)
//   chores  right below the fight
//
// Lookup per member: the strategy's memberBehaviors, which a group may use to override a character
// outright, then the role's list with the character's behaviours in it.

import { existsSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { findBotEnv } from '../index';
import type { Behavior } from './member';
import type { Role } from './types';

const ROLES: readonly Role[] = ['tank', 'healer', 'support', 'nuker', 'melee'];

export interface Character<S = any> {
    /** Its job when group.json doesn't pin one, ahead of the role its class would get. */
    role?: Role;
    /**
     * Above the role's main action. In a list with a fight or position() that is react's place, ahead of it; in one with
     * neither (the pack's healer and support), above its first heal, interrupt, crowd control or song, where react would go
     * at shedLoad and get only the turns those leave.
     */
    urgent?: Behavior<S>[];
    react?: Behavior<S>[];
    fight?: Behavior<S>[];
    chores?: Behavior<S>[];
    /**
     * Its pet. `false`: it plays without one in any run, as pet.enabled false does for a whole group (no pet behaviours on its list, none in its capabilities, and the run's end leaves one that is up alone).
     * `fnfFloor`: a floor of power for fnfPet of its own, which binds with the run's pet.fnfFloor, the higher going (a kit that saves its power saves it from its pets too).
     */
    pet?: false | { fnfFloor?: number };
}

/** The behaviours a role's list fights with. */
export const ROLE_FIGHT: ReadonlySet<string> = new Set(['tank', 'assist', 'assistMelee']);
/** A healer's or support's main work, in a list without a fight: a character's urgent behaviours go above the first of them. */
const MAIN_ACTIONS: ReadonlySet<string> = new Set(['heal', 'interrupt', 'crowdControl', 'backupHeal', 'confuse', 'song']);

/**
 * A role's list with a character's behaviours in it. A list without a fight (a healer's) takes them
 * where position() would keep it at range, or else above its idle chores. A group pinning a role in
 * group.json changes the job (where it stands, what it's ordered to do), not this.
 */
export function withCharacter<S>(list: Behavior<S>[], character: Character<S> | null | undefined): Behavior<S>[] {
    if (!character) return list;
    const isFight = (b: Behavior<S>) => ROLE_FIGHT.has(b.name);
    const first = list.findIndex(isFight);
    const stands = list.findIndex(b => b.name === 'position');
    const chores = list.findIndex(b => b.name === 'shedLoad');
    const at = first >= 0 ? first : stands >= 0 ? stands : chores >= 0 ? chores : list.length;
    // No fight and no position (the pack's healer and support lists): urgent goes above the role's main action.
    const main = first < 0 && stands < 0 ? list.findIndex(b => MAIN_ACTIONS.has(b.name)) : -1;
    if (main >= 0 && main < at) return [
        ...list.slice(0, main),
        ...character.urgent ?? [],
        ...list.slice(main, at),
        ...character.react ?? [],
        ...character.fight ?? [],
        ...character.chores ?? [],
        ...list.slice(at),
    ];
    return [
        ...list.slice(0, at),
        ...character.urgent ?? [],
        ...character.react ?? [],
        ...character.fight ?? list.filter(isFight),
        ...character.chores ?? [],
        ...list.slice(at).filter(b => !isFight(b)),
    ];
}

/** bots/<bot>/character.ts, or null when the bot has none. A file that fails to load or has the wrong shape is an error, not a silent role list. */
export async function loadCharacter(bot: string): Promise<Character | null> {
    const env = findBotEnv(bot);
    if (!env) return null;
    const path = join(dirname(env), 'character.ts');
    if (!existsSync(path)) return null;
    // By modification time, like MCP's scripts: its process outlives an edit. Files this one imports stay cached there.
    const mod = await import(`${path}?v=${statSync(path).mtimeMs}`);
    const c = mod.default as Character | undefined;
    if (!c) throw new Error(`${path}: needs a default export`);
    if (c.role !== undefined && !ROLES.includes(c.role)) throw new Error(`${path}: role "${c.role}"; use one of ${ROLES.join(', ')}`);
    for (const k of ['urgent', 'react', 'fight', 'chores'] as const) {
        if (c[k] !== undefined && !Array.isArray(c[k])) throw new Error(`${path}: ${k} must be a list of behaviours`);
    }
    if (c.pet !== undefined && c.pet !== false && (typeof c.pet !== 'object' || c.pet === null)) throw new Error(`${path}: pet must be false or { fnfFloor }`);
    return c;
}
