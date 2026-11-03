// A class's facts from the DB dump, so a class guide (learnings/classes/) needn't copy them:
//
//   bun data/class-sheet.ts Mentalist
//   bun data/class-sheet.ts Mauler --realm=hibernia

import { getClass, getRacesForClass, getSpell, getSpellLines, getStylesFor, specDisplayName, type ClassInfo, type SpellInfo, type SpellLineInfo } from './index';

/** Careers and other hidden lines start far below 1; the trainable ones are what a class chooses between. */
const HIDDEN_BELOW = -50;

/** The class's trainable lines by DB key. */
export function classSpecs(cls: ClassInfo): string[] {
    return cls.specializations.filter(s => s.levelAcquired > HIDDEN_BELOW).map(s => s.spec);
}

/** A class's spell lines per spec: a line belongs to one class (classIdHint) or to every class with that spec (0). */
export function classSpellLines(cls: ClassInfo): SpellLineInfo[] {
    const specs = new Set(classSpecs(cls));
    return getSpellLines().filter(l => specs.has(l.spec) && (l.classIdHint === cls.id || l.classIdHint === 0))
        .sort((a, b) => classSpecs(cls).indexOf(a.spec) - classSpecs(cls).indexOf(b.spec) || Number(b.isBaseLine) - Number(a.isBaseLine));
}

/**
 * Spec points earned by a level: 14 by level 5, then level * multiplier / 10 per level, and half of
 * that again at each half level from 40.5 on. A list caster's 1494 at 50 is the usual 46/28/4 exactly.
 */
export function specPointsAt(level: number, multiplier: number): number {
    if (level <= 5) return Math.max(0, level * 3 - 1);
    let points = 14;
    for (let l = 6; l <= level; l++) points += Math.floor(l * multiplier / 10);
    for (let l = 40; l < level; l++) points += Math.floor(l * multiplier / 20);
    return points;
}

/** What a line costs from 1 to `level`: each level costs its own number. */
export const specCost = (level: number): number => level * (level + 1) / 2 - 1;

/**
 * The levels a weighted plan reaches by a character level, spending as a training plan does: always
 * the line furthest behind its weight, one level at a time, never above the character's level.
 */
export function specLevelsAt(weights: Record<string, number>, level: number, multiplier: number): Record<string, number> {
    const out = Object.fromEntries(Object.keys(weights).map(k => [k, 1]));
    let points = specPointsAt(level, multiplier);
    for (;;) {
        const next = Object.keys(weights)
            .filter(k => out[k]! < level && out[k]! + 1 <= points && weights[k]! > 0)
            .sort((a, b) => out[a]! / weights[a]! - out[b]! / weights[b]!)[0];
        if (!next) return out;
        out[next]! += 1;
        points -= out[next]!;
    }
}

const num = (n: number | undefined) => (n ? String(n) : '');

function spellRow(level: number, s: SpellInfo): string {
    const amount = s.damage ? `${s.damage} dmg` : s.value ? `value ${s.value}` : '';
    return `| ${level} | ${s.name} | ${s.type} | ${s.target} | ${amount} | ${num(s.radius)} | ${s.castTime} | ${s.power} | ${num(s.concentration)} | ${num(s.duration)} |`;
}

/** The class's sheet as Markdown. */
export function classSheet(cls: ClassInfo): string {
    const specs = classSpecs(cls);
    const out = [
        `# ${cls.name}`,
        '',
        `Generated from the DB dump by data/class-sheet.ts. Base class: ${cls.baseClassName ?? 'none'}. Type: ${cls.classType}.`,
        `Stats: ${cls.primaryStat} / ${cls.secondaryStat} / ${cls.tertiaryStat}; power from ${cls.manaStat ?? 'nothing'}. Spec points x${cls.specializationMultiplier / 10}: ${[10, 20, 30, 40, 50].map(l => `${specPointsAt(l, cls.specializationMultiplier)} at ${l}`).join(', ')} (a line from 1 to N costs N(N+1)/2 - 1).`,
        `Races: ${getRacesForClass(cls.id).map(r => r.name).join(', ') || 'none'}. Lines: ${specs.map(specDisplayName).join(', ')}.`,
    ];
    for (const line of classSpellLines(cls)) {
        out.push('', `## ${line.name} (${specDisplayName(line.spec)}, ${line.isBaseLine ? 'baseline' : 'specialist'})`, '',
            '| Level | Spell | Type | Target | Amount | Radius | Cast | Power | Conc | Duration |', '|---|---|---|---|---|---|---|---|---|---|');
        for (const { spellId, level } of line.spells) {
            const s = getSpell(spellId);
            if (s) out.push(spellRow(level, s));
        }
    }
    const styles = getStylesFor(cls.id);
    if (styles.length) {
        out.push('', '## Styles', '', '| Line | Level | Style | Endurance |', '|---|---|---|---|');
        for (const s of styles) out.push(`| ${specDisplayName(s.specKeyName)} | ${s.specLevelRequirement} | ${s.name} | ${s.enduranceCost} |`);
    }
    return out.join('\n');
}

if (import.meta.main) {
    const [name] = process.argv.slice(2).filter(a => !a.startsWith('-'));
    const realm = process.argv.find(a => a.startsWith('--realm='))?.slice(8) as Parameters<typeof getClass>[1];
    const cls = name ? getClass(name, realm) : undefined;
    if (!cls) {
        console.error(name ? `No class "${name}"` : 'usage: bun data/class-sheet.ts <class> [--realm=albion|midgard|hibernia]');
        process.exit(1);
    }
    console.log(classSheet(cls));
}
