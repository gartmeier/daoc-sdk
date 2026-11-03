// A class's facts from the DB dump, so a class guide (learnings/classes/) needn't copy them:
//
//   bun data/class-sheet.ts Mentalist
//   bun data/class-sheet.ts Mauler --realm=hibernia

import { earnedSpecPoints } from './builds/rule';
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
        `Stats: ${cls.primaryStat} / ${cls.secondaryStat} / ${cls.tertiaryStat}; power from ${cls.manaStat ?? 'nothing'}. Spec points x${cls.specializationMultiplier / 10}: ${[10, 20, 30, 40, 50].map(l => `${earnedSpecPoints(cls.specializationMultiplier, l)} at ${l}`).join(', ')} (a line from 1 to N costs N(N+1)/2 - 1).`,
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
