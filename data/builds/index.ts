// The build catalogue and the rule that plays a build. Private files write:
//
//   import type { Build } from '../../data/builds';

import { getClass } from '../index';
import type { Build, CatalogBuild, ClassBuilds } from './types';

import armsman from './armsman';
import cabalist from './cabalist';
import cleric from './cleric';
import friar from './friar';
import infiltrator from './infiltrator';
import mercenary from './mercenary';
import minstrel from './minstrel';
import necromancer from './necromancer';
import paladin from './paladin';
import reaver from './reaver';
import scout from './scout';
import sorcerer from './sorcerer';
import theurgist from './theurgist';
import wizard from './wizard';

import berserker from './berserker';
import bonedancer from './bonedancer';
import healer from './healer';
import hunter from './hunter';
import runemaster from './runemaster';
import savage from './savage';
import shadowblade from './shadowblade';
import shaman from './shaman';
import skald from './skald';
import spiritmaster from './spiritmaster';
import thane from './thane';
import warrior from './warrior';

import animist from './animist';
import bard from './bard';
import blademaster from './blademaster';
import champion from './champion';
import druid from './druid';
import eldritch from './eldritch';
import enchanter from './enchanter';
import hero from './hero';
import mentalist from './mentalist';
import nightshade from './nightshade';
import ranger from './ranger';
import valewalker from './valewalker';
import warden from './warden';

export type * from './types';
export * from './rule';

// Each file passed `satisfies ClassBuilds`, but a default export widens its array literals: two targets with
// different lines come out as `Parry?: undefined`, which no longer fits Record<string, number>.
const CATALOGUE = [
    armsman, cabalist, cleric, friar, infiltrator, mercenary, minstrel, necromancer, paladin, reaver, scout, sorcerer, theurgist, wizard,
    berserker, bonedancer, healer, hunter, runemaster, savage, shadowblade, shaman, skald, spiritmaster, thane, warrior,
    animist, bard, blademaster, champion, druid, eldritch, enchanter, hero, mentalist, nightshade, ranger, valewalker, warden,
] as readonly ClassBuilds[];

export function allClassBuilds(): readonly ClassBuilds[] {
    return CATALOGUE;
}

/** The builds of a class under any name getClass takes: enum key or display name, female names too. None for a base class. */
export function getClassBuilds(className: string): ClassBuilds | undefined {
    const cls = getClass(className);
    return cls && CATALOGUE.find(c => c.className === cls.name);
}

/** One catalogue build by name in any case, carrying its className so that it is a Build too. */
export function getBuild(className: string, name: string): (CatalogBuild & Build) | undefined {
    const builds = getClassBuilds(className);
    const build = builds?.builds.find(b => b.name.toLowerCase() === name.toLowerCase());
    return build && { ...build, className: builds!.className };
}
