// What a build reaches at a level and what the role lists do with it, from the static data and the same
// Spellbook a member fights with: no server, no character. A class guide (learnings/classes/) points here
// instead of copying the lists, and its tests hold its claims to them.
//
//   bun sdk/classes/reach.ts Druid "Heal druid"
//   bun sdk/classes/reach.ts Bard "Nurture support" 24

import { buildPath, getBuild, type Build } from '../../data/builds';
import { getBaselineSkills, getClass, getClassSkills, getSpell, getStylesFor, type SpellInfo, type StyleInfo } from '../../data/index';
import type { BotActions } from '../actions';
import { dotFamily, pickHeal, Spellbook, type SpellPick } from '../group/spells';
import type { BotSDK } from '../index';

export interface Known {
    name: string;
    /** The spec level it comes at, or for a baseline spell the character level. */
    level: number;
    /** The line's display name. */
    line: string;
    baseline: boolean;
    info: SpellInfo;
}

export interface Reach {
    className: string;
    level: number;
    specs: Record<string, number>;
    known: Known[];
    /** What `heal` picks from, by what it restores. */
    heals: SpellPick[];
    /** What `crowdControl` casts at an add. */
    cc: (SpellPick & { kind: 'mezz' | 'root' }) | null;
    /** An area mezz, which it casts only with `aoe`. */
    areaMezz: SpellPick | null;
    /** What `assist` casts at a healthy target, in order: its DoTs, then the top direct damage. */
    nukes: SpellPick[];
    rez: SpellPick | null;
    /** What `buff` keeps up. */
    buffs: (SpellPick & { slot: string })[];
    /** What `song` plays. */
    songs: (SpellPick & { kind: string })[];
    /** The best rank of each kind of spell no behaviour casts. */
    unused: Known[];
    /** The styles its lines reach. */
    styles: StyleInfo[];
    /** The abilities its lines reach. */
    abilities: string[];
}

/** A Spellbook on a character knowing `known`, with all the power in the world and nothing on a timer. */
function bookOf(known: Known[], maxHealth: number): Spellbook {
    const spells = known.map(k => ({ name: k.name, level: k.level, internalId: k.info.id, lineName: k.line, lineIndex: 0, spellIndex: 0, cooldownRemaining: 0 }));
    const sdk = { getSkills: () => ({ spells }), getPlayer: () => ({ mana: Infinity, maxHealth }) } as unknown as BotSDK;
    const bot = { getSpellInfo: (s: { internalId: number }) => getSpell(s.internalId) ?? null } as unknown as BotActions;
    return new Spellbook(sdk, bot);
}

const kindOf = (s: Pick<SpellInfo, 'type' | 'target' | 'radius' | 'damageType'>) => `${s.type}:${s.target}:${s.radius ? 'area' : 'one'}:${s.damageType}`;

/** What `specs` reach at character `level`. `maxHealth` sizes the percent heals: about a level-24 template's by default. */
export function reach(className: string, level: number, specs: Record<string, number>, { maxHealth = 600 }: { maxHealth?: number } = {}): Reach {
    const specOf = (key: string) => specs[key] ?? 1;
    const known: Known[] = [];
    for (const line of getBaselineSkills(className)) for (const s of line.skills) {
        const info = s.dataId !== undefined ? getSpell(s.dataId) : undefined;
        if (info && s.specLevel <= level && line.levelAcquired <= level) known.push({ name: s.name, level: s.specLevel, line: line.displayName, baseline: true, info });
    }
    const windows = getClassSkills(className, { characterLevel: level });
    for (const line of windows) for (const s of line.skills) {
        const info = s.dataId !== undefined && s.kind !== 'style' ? getSpell(s.dataId) : undefined;
        if (info && s.specLevel <= specOf(line.specKey)) known.push({ name: s.name, level: s.specLevel, line: line.displayName, baseline: false, info });
    }
    const book = bookOf(known, maxHealth);
    const heals: SpellPick[] = [];
    for (let missing = 0; missing <= 2000; missing += 5) {
        const h = book.heal(missing);
        if (h && !heals.some(x => x.spell.name === h.spell.name)) heals.push(h);
    }
    const top = pickHeal(book.all().filter(s => heals.some(h => h.spell.name === s.spell.name)), { casterMaxHp: maxHealth });
    if (top && !heals.some(h => h.spell.name === top.spell.name)) heals.push(top);
    const nukes: SpellPick[] = [];
    const dotted = new Set<string>();
    for (let s = book.nuke({ dotted }); s; s = book.nuke({ dotted })) {
        nukes.push(s);
        if (s.type !== 'DamageOverTime') break;
        dotted.add(dotFamily(s));
    }
    const cc = book.cc();
    const areaMezz = book.mezz({ aoe: true });
    const rez = book.rez();
    const buffs = book.buffs();
    const songs = book.songs();
    const used = [...heals, ...nukes, ...buffs, ...songs, ...(cc ? [cc] : []), ...(areaMezz ? [areaMezz] : []), ...(rez ? [rez] : [])];
    const usedKinds = new Set(used.map(kindOf));
    const bestOfKind = new Map<string, Known>();
    for (const k of known) {
        const key = kindOf(k.info);
        if (usedKinds.has(key)) continue;
        if (!bestOfKind.has(key) || bestOfKind.get(key)!.level < k.level) bestOfKind.set(key, k);
    }
    const styles = getStylesFor(getClass(className)!.id).filter(s => s.specLevelRequirement <= specOf(s.specKeyName));
    const abilities = [...new Set(windows.flatMap(l => l.skills.filter(s => s.kind === 'ability' && s.specLevel <= specOf(l.specKey)).map(s => s.name)))];
    return { className, level, specs, known, heals, cc, areaMezz, nukes, rez, buffs, songs, unused: [...bestOfKind.values()].sort((a, b) => a.info.type.localeCompare(b.info.type)), styles, abilities };
}

/** What a build has bought by `level`, reached. */
export function reachOfBuild(build: Build, level: number, opts: { maxHealth?: number } = {}): Reach {
    return reach(build.className, level, buildPath(build)[level - 1]!.specs, opts);
}

const amount = (s: { damage: number; value: number }) => (s.damage ? `${s.damage} dmg` : s.value ? `value ${s.value}` : '');
const row = (s: SpellPick) => `${s.spell.name} (${s.spell.lineName}, ${[amount(s), s.radius ? `radius ${s.radius}` : '', s.range ? `range ${s.range}` : '', `${s.castTime} s`, `${s.power} power`, s.recast ? `recast ${s.recast}` : '', s.duration ? `${s.duration} s` : '', s.concentration ? `conc ${s.concentration}` : ''].filter(Boolean).join(', ')})`;
const openingOf = (s: StyleInfo) => (s.openingRequirementType === 2 ? 'positional' : s.openingRequirementType === 1 && s.attackResultRequirement ? 'reaction' : s.openingRequirementType === 0 && s.openingRequirementValue ? 'follow-up' : 'anytime');
const procOf = (s: StyleInfo) => (s.procs ?? []).map(p => {
    const i = getSpell(p.spellId);
    return i ? `${i.name}: ${i.type}${i.value ? ` ${i.value}` : ''}${i.damage ? ` ${i.damage} dmg` : ''}${i.duration ? ` ${i.duration} s` : ''}` : `spell ${p.spellId}`;
}).join('; ');

/** A reach as text. */
export function reachSheet(r: Reach): string {
    const list = (title: string, items: string[]) => `${title}:${items.length ? items.map(i => `\n  ${i}`).join('') : ' none'}`;
    return [
        `${r.className} at level ${r.level}: ${Object.entries(r.specs).map(([k, v]) => `${k} ${v}`).join(', ')}`,
        list('heal', r.heals.map(row)),
        list('crowdControl', r.cc ? [`${r.cc.kind}: ${row(r.cc)}`] : []),
        list('area mezz (only with aoe)', r.areaMezz?.radius ? [row(r.areaMezz)] : []),
        list('assist, in order', r.nukes.map(row)),
        list('rez', r.rez ? [row(r.rez)] : []),
        list('buff', r.buffs.map(s => `${s.slot}, ${s.target}: ${row(s)}`)),
        list('song', r.songs.map(s => `${s.kind}: ${row(s)}`)),
        list('Reached, no behaviour casts it', r.unused.map(k => `${k.name} (${k.line}, ${k.info.type}, ${k.info.target}${[amount(k.info), k.info.radius ? `radius ${k.info.radius}` : '', k.info.range ? `range ${k.info.range}` : '', `${k.info.castTime} s`, `${k.info.power} power`, k.info.duration ? `${k.info.duration} s` : '', k.info.recastDelay ? `recast ${k.info.recastDelay}` : ''].filter(Boolean).map(x => `, ${x}`).join('')})`)),
        list('Styles', r.styles.map(s => `${s.specKeyName} ${s.specLevelRequirement} ${s.name} (${openingOf(s)}, ${s.enduranceCost} end${procOf(s) ? `, ${procOf(s)}` : ''})`)),
        list('Abilities', r.abilities),
    ].join('\n');
}

if (import.meta.main) {
    const [className, name, level] = process.argv.slice(2);
    const build = className && name ? getBuild(className, name) : undefined;
    if (!build) {
        console.error('usage: bun sdk/classes/reach.ts <class> "<build>" [level]   (builds: bun bots/create-bot.ts --builds=<class>)');
        process.exit(1);
    }
    console.log(reachSheet(reachOfBuild(build, Number(level ?? 24))));
}
