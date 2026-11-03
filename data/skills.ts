// What a class can train, per line, from the static data alone: no server, no character. It mirrors
// PacketLib1105.SendTrainerWindow (0x7B codes 0, 3 and 4) and what that calls, and skills.test.ts holds it
// against real windows of every creatable class (data/fixtures/trainer-windows.json). C# refs are
// relative to server/core/GameServer.
//
// Not mirrored, because no class is affected today: the packet size caps (PacketLib1105.cs:187,197),
// line order by SpellLineID (Specialization.cs:155), the order of abilities tied on spec level
// (SkillBase.cs:567), and spells the server rejects at load (Spell.cs:368-369, SkillBase.cs:145-156).
//
//   bun data/skills.ts Enchanter Mana        one line of a class
//   bun data/skills.ts Warrior               every line of a class
//   bun data/skills.ts --table               counts for every class

import {
    getAbility, getClass, getClasses, getSpecializations, getSpell, getSpellLines, getStyles,
    type ClassInfo, type SpecializationInfo, type SpellLineInfo, type StyleInfo,
} from './index';

/** GamePlayer.MAX_LEVEL: the step every Pretend* call in PacketLib1105.cs:93,98,106 passes. */
const STEP = 50;

export interface ClassSkill {
    /** A song is a spell with an instrument requirement (Spell.cs:249). */
    kind: 'ability' | 'spell' | 'song' | 'style';
    /** As the window names it: ability names carry their tier ("Guard II"). */
    name: string;
    /** The level this line must reach. A baseline spell's is a character level instead (getBaselineSkills). */
    specLevel: number;
    /** The window's id: Ability.InternalID, Spell.TooltipId or Style.StyleID. */
    id: number;
    /** Key into the generated data: getSpell(dataId), or a style's id among getStyles(). None on an ability. */
    dataId?: number;
}

export interface TrainableLine {
    /** The line's key: what classes.json, builds and /train use. */
    specKey: string;
    /** What the skill list and the trainer window show. */
    displayName: string;
    /** classxspecialization.LevelAcquired. Zero or negative: from level 1, only a sort key (GamePlayer.cs:3081, :9933). */
    levelAcquired: number;
}

export interface ClassSkillLine extends TrainableLine {
    skills: ClassSkill[];
}

/**
 * What a specialization's C# class lets through to the window. Nothing in the data says this, it is the
 * class hierarchy: Specialization.cs:86-89,411-414 and gameutils/Specializations/*.cs. An implementation
 * missing from both tables throws, because it could be trainable and could filter anything.
 */
const TRAINABLE: ReadonlyMap<string, { spells: boolean; styles: boolean }> = new Map([
    ['', { spells: true, styles: true }], // SkillBase.cs:527-534: the base class
    ['DOL.GS.LiveSpellHybridSpecialization', { spells: true, styles: true }], // Pretend returns the full list, :50-53
    ['DOL.GS.LiveAbilitySpecialization', { spells: false, styles: false }], // :41-64
    ['DOL.GS.LiveWeaponSpecialization', { spells: false, styles: true }], // :39-52, no DB row uses it today
    ['DOL.GS.LiveSpellLineSpecialization', { spells: true, styles: false }], // :42-45, no DB row uses it today
]);
const UNTRAINABLE: ReadonlySet<string> = new Set([
    'DOL.GS.LiveCareerSpecialization', 'DOL.GS.LiveWideCareerSpecialization', 'DOL.GS.LiveMasterLevelsSpecialization',
    'DOL.GS.LiveRealmAbilitiesSpecialization', 'DOL.GS.LiveChampionsSpecialization',
]);

const memo = <T>(fn: () => T): (() => T) => {
    let v: T | undefined;
    return () => (v ??= fn());
};

const specByKey = memo(() => new Map(getSpecializations().map(s => [s.keyName, s])));
const linesBySpec = memo(() => {
    const m = new Map<string, SpellLineInfo[]>();
    for (const l of getSpellLines()) (m.get(l.spec) ?? m.set(l.spec, []).get(l.spec)!).push(l);
    return m;
});
const stylesBySpecClass = memo(() => {
    const m = new Map<string, StyleInfo[]>();
    for (const s of getStyles()) {
        const k = `${s.specKeyName}|${s.classId}`;
        (m.get(k) ?? m.set(k, []).get(k)!).push(s);
    }
    return m;
});

/** Ability.getRomanLevel, Ability.cs:186-213. */
function roman(n: number): string {
    const steps: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    if (n > 3999) return '';
    let out = '';
    for (const [v, s] of steps) while (n >= v) { out += s; n -= v; }
    return out;
}

/** Ability.UpdateCurrentName, Ability.cs:72-111. A parse error leaves the raw column as the name (:107-110). */
export function abilityName(keyName: string, serialized: string, level: number): string {
    const byLevel = new Map<number, string>();
    for (const part of serialized.trim().split(';').filter(p => p.length > 0)) { // Util.SplitCSV: RemoveEmptyEntries
        const pair = part.trim();
        if (!pair) continue;
        const bits = pair.split('|');
        const key = bits.length < 2 ? 0 : Number.parseInt(bits[0]!, 10);
        if (byLevel.has(key) || Number.isNaN(key)) return serialized; // Dictionary.Add or int.Parse throws
        byLevel.set(key, bits.length < 2 ? part : bits[1]!);
    }
    let name = byLevel.get(level);
    if (name === undefined) {
        const first = [...byLevel].sort((a, b) => a[0] - b[0]).find(([k]) => k <= level);
        name = first?.[1] ?? `??${keyName}`;
    }
    return name.replaceAll('%n', roman(level));
}

/** Specialization.GetSpellLinesForLiving, Specialization.cs:154-193: class-hinted rows, else hint 0. */
function hinted(lines: SpellLineInfo[], classId: number): SpellLineInfo[] {
    const own = lines.filter(l => l.classIdHint === classId);
    return own.length ? own : lines.filter(l => l.classIdHint === 0);
}

function lineSpells(line: SpellLineInfo): ClassSkill[] {
    const rows: (ClassSkill & { dataId: number })[] = [];
    for (const r of line.spells) {
        const spell = getSpell(r.spellId);
        if (!spell) continue; // SkillBase.cs:229 throws KeyNotFound, caught at :236
        const specLevel = Math.max(1, r.level); // SkillBase.cs:231
        if (specLevel > STEP) continue; // Specialization.cs:254
        rows.push({ kind: spell.instrumentRequirement !== 0 ? 'song' : 'spell', name: spell.name, specLevel, id: spell.tooltipId, dataId: spell.id });
    }
    return rows.sort((a, b) => a.specLevel - b.specLevel || a.dataId - b.dataId); // Specialization.cs:254-256
}

/** PacketLib1105.cs:91-111 for one line: abilities, then spells, then styles, stable-sorted by required level. */
function skillsOfSpec(spec: SpecializationInfo, cls: ClassInfo): ClassSkill[] {
    const caps = TRAINABLE.get(spec.implementation)!;
    const out: ClassSkill[] = [];

    // PretendAbilitiesForLiving, Specialization.cs:282-287, and GetSpecAbilityList, SkillBase.cs:2766-2772.
    for (const a of spec.abilities) {
        if (a.classId !== 0 && a.classId !== cls.id) continue;
        if (a.specLevel > STEP) continue;
        const ability = getAbility(a.abilityKey);
        if (!ability) continue; // SkillBase.cs:556 throws, caught at :559
        out.push({ kind: 'ability', name: abilityName(ability.keyName, ability.name, a.abilityLevel), specLevel: a.specLevel, id: ability.internalId });
    }

    if (caps.spells && !cls.isBaseClass) { // Specialization.cs:154; isBaseClass equals !HasAdvancedFromBaseClass today
        const specLines = (linesBySpec().get(spec.keyName) ?? []).filter(l => !l.isBaseLine); // PacketLib1105.cs:98
        for (const line of hinted(specLines, cls.id)) out.push(...lineSpells(line));
    }

    if (caps.styles) {
        // GetStylesForLiving, Specialization.cs:378-387.
        const own = stylesBySpecClass().get(`${spec.keyName}|${cls.id}`) ?? stylesBySpecClass().get(`${spec.keyName}|0`) ?? [];
        const rows = own.filter(s => s.specLevelRequirement <= STEP)
            .sort((a, b) => a.specLevelRequirement - b.specLevelRequirement || a.id - b.id);
        for (const s of rows)
            out.push({ kind: 'style', name: s.name, specLevel: Math.min(STEP, s.specLevelRequirement), id: s.styleId, dataId: s.id });
    }

    return out.sort((a, b) => a.specLevel - b.specLevel); // Array.sort is stable, like LINQ OrderBy
}

function resolveClass(className: string): ClassInfo {
    const cls = getClass(className);
    if (!cls) throw new Error(`unknown class ${JSON.stringify(className)}`);
    const k = className.toLowerCase().replace(/\s/g, '');
    const same = getClasses().filter(c => c.name.toLowerCase().replace(/\s/g, '') === k);
    if (same.length > 1) throw new Error(`${className} is ambiguous: use ${same.map(c => c.key).join(' or ')}`);
    return cls;
}

/** The lines of a character at this level, in window order (GamePlayer.cs:3081, :9933; PacketLib1105.cs:36). */
function careerOf(cls: ClassInfo, characterLevel: number): { spec: SpecializationInfo; levelAcquired: number }[] {
    const out: { spec: SpecializationInfo; levelAcquired: number }[] = [];
    for (const row of cls.specializations) {
        const spec = specByKey().get(row.spec);
        if (!spec || characterLevel < row.levelAcquired) continue; // missing spec: SkillBase.cs:2675-2681
        if (UNTRAINABLE.has(spec.implementation)) continue;
        if (!TRAINABLE.has(spec.implementation)) throw new Error(`${spec.keyName}: unmapped implementation ${JSON.stringify(spec.implementation)}`);
        out.push({ spec, levelAcquired: row.levelAcquired });
    }
    return out.sort((a, b) => a.levelAcquired - b.levelAcquired || a.spec.id - b.spec.id);
}

const lineOf = ({ spec, levelAcquired }: { spec: SpecializationInfo; levelAcquired: number }): TrainableLine => ({
    specKey: spec.keyName, displayName: spec.name, levelAcquired,
});

/**
 * The lines a character of this class can spend points on, by default at level 50 so that every line
 * is there. Takes what getClass takes, but a display name two classes share throws: use the enum key
 * (AlbionRogue, MidgardRogue, MaulerAlb, MaulerMid, MaulerHib).
 */
export function getTrainableLines(className: string, opts: { characterLevel?: number } = {}): TrainableLine[] {
    return careerOf(resolveClass(className), opts.characterLevel ?? STEP).map(lineOf);
}

/**
 * The trainer window of a character of this class, by default at level 50 so that every line is there.
 * An advanced class is assumed promoted. Pass a base class ('Magician') to see what the window holds
 * before promotion: its lines, with no skills. Skills don't depend on the level or on what is trained.
 * The class name works as in getTrainableLines.
 */
export function getClassSkills(className: string, opts: { characterLevel?: number } = {}): ClassSkillLine[] {
    const cls = resolveClass(className);
    return careerOf(cls, opts.characterLevel ?? STEP).map(row => ({ ...lineOf(row), skills: skillsOfSpec(row.spec, cls) }));
}

/**
 * The spells on baseline lines of those same lines: never in the window (PacketLib1105.cs:98). Their specLevel
 * is a CHARACTER level, because a baseline line's level is the player's (Specialization.cs:163,171). This is the
 * catalog: a character casts only the best tier of a group on most lines (LiveSpellHybridSpecialization.cs:83-98).
 */
export function getBaselineSkills(className: string): ClassSkillLine[] {
    const cls = resolveClass(className);
    return careerOf(cls, STEP).filter(({ spec }) => TRAINABLE.get(spec.implementation)!.spells).map(row => ({
        ...lineOf(row),
        skills: hinted((linesBySpec().get(row.spec.keyName) ?? []).filter(l => l.isBaseLine), cls.id).flatMap(lineSpells),
    }));
}

if (import.meta.main) {
    const [a, b] = process.argv.slice(2);
    if (a === '--table' || !a) {
        console.log(['class', 'id', 'lines', 'later', 'abil', 'spell', 'song', 'style', 'total', 'baseline'].join('\t'));
        for (const c of getClasses()) {
            const w = getClassSkills(c.key);
            const n = (k: ClassSkill['kind']) => w.flatMap(s => s.skills).filter(s => s.kind === k).length;
            const later = w.filter(s => s.levelAcquired > 1).map(s => `${s.specKey}@${s.levelAcquired}`).join(',');
            const base = getBaselineSkills(c.key).flatMap(s => s.skills).length;
            console.log([c.key, c.id, w.length, later, n('ability'), n('spell'), n('song'), n('style'), w.flatMap(s => s.skills).length, base].join('\t'));
        }
    } else {
        const all = getClassSkills(a);
        const lines = all.filter(s => !b || s.specKey.toLowerCase() === b.toLowerCase() || s.displayName.toLowerCase() === b.toLowerCase());
        if (b && !lines.length) {
            console.error(`${a} has no line "${b}". Its lines: ${all.map(s => s.specKey).join(', ')}`);
            process.exit(1);
        }
        for (const s of lines) {
            console.log(`${a} / key=${JSON.stringify(s.specKey)} display=${JSON.stringify(s.displayName)} levelAcquired=${s.levelAcquired}: ${s.skills.length} skills`);
            for (const k of s.skills) console.log(`  ${String(k.specLevel).padStart(2)}  ${k.kind.padEnd(7)}  id=${String(k.id).padEnd(5)}  ${k.name}`);
        }
    }
}
