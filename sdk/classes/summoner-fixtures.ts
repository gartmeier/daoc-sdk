// Test fixtures for the pet kits (bonedancer.ts, animist.ts, necromancer.ts): a build's spells as a kit reads them, from the static data.

import { buildPath, getBuild } from '../../data/builds';
import { getSpell } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import { Spellbook, type SpellPick } from '../group/spells';
import { reach } from './reach';
import { subOf, type Through } from './summoner';

/** Every spell a build reaches at `level`, as the Spellbook a member fights with lists them. */
export function knownPicks(className: string, buildName: string, level: number): SpellPick[] {
    const build = getBuild(className, buildName)!;
    const known = reach(className, level, buildPath(build)[level - 1]!.specs).known;
    const spells = known.map(k => ({ name: k.name, level: k.level, internalId: k.info.id, lineName: k.line, lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 }));
    const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana: Infinity, maxHealth: 600, level }) } as unknown as BotSDK;
    const bot = { getSpellInfo: (s: { internalId: number }) => getSpell(s.internalId) ?? null } as unknown as BotActions;
    return new Spellbook(sdk, bot).all();
}

/** The same, those of `type`, with their sub-spells (summoner.ts through). */
export function knownThrough(className: string, buildName: string, level: number, type: string): Through[] {
    return knownPicks(className, buildName, level).filter(p => p.type === type).map(pick => ({ pick, sub: subOf(getSpell(pick.spell.internalId)) }));
}
