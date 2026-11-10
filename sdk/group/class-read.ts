// A human's read of an enemy player's class, from what any client in view sees: its race (the name an enemy
// realm's player shows), the armour and weapons it wears (0x15), the spells it casts (0x72/0x1B effect ids)
// and the styles it swings (0xBC animations). Never a name, a roster or anything only the server knows.
//
// Every piece of evidence narrows the realm's classes by what each class can have at the enemy's level, from
// the static data (data/): armour and weapon abilities per career and line, spells per line, styles per line.
// Race is a hard limit. Gear, spells and styles are strong but soft (a factor per miss), so one odd piece
// (an item's proc, a spell effect sent with another caster) can't empty the list.

import { getClasses, getItemTemplates, getRace, getSpecialization, getSpell, getStyles, type ClassInfo, type StyleInfo } from '../../data/index';
import { getBaselineSkills, getClassSkills } from '../../data/skills';
import { loadTable } from '../../data/sql';
import type { Realm } from '../types';

/** What an enemy does in a fight, as the group plans against it. Archers count as `caster`: ranged and soft. */
export type FoeRole = 'healer' | 'caster' | 'cc' | 'tank' | 'melee' | 'support';

/** By class key, as a mid-level RvR group meets them: the first job, where a class has several. */
export const CLASS_ROLES: Readonly<Record<string, FoeRole>> = {
    // Albion
    Armsman: 'tank', Paladin: 'tank', Mercenary: 'melee', Reaver: 'melee', Infiltrator: 'melee', Scout: 'caster',
    Cleric: 'healer', Friar: 'healer', Minstrel: 'cc', Sorcerer: 'cc', Wizard: 'caster', Theurgist: 'caster',
    Cabalist: 'caster', Necromancer: 'caster', Heretic: 'melee', MaulerAlb: 'melee',
    Fighter: 'melee', Acolyte: 'healer', Elementalist: 'caster', Mage: 'caster', Disciple: 'caster', AlbionRogue: 'melee',
    // Midgard
    Warrior: 'tank', Thane: 'melee', Berserker: 'melee', Savage: 'melee', Shadowblade: 'melee', Hunter: 'caster',
    Skald: 'support', Healer: 'healer', Shaman: 'healer', Runemaster: 'caster', Spiritmaster: 'caster', Bonedancer: 'caster',
    Valkyrie: 'melee', Warlock: 'caster', MaulerMid: 'melee',
    Viking: 'melee', Seer: 'healer', Mystic: 'caster', MidgardRogue: 'melee',
    // Hibernia
    Hero: 'tank', Champion: 'melee', Blademaster: 'melee', Nightshade: 'melee', Ranger: 'caster', Valewalker: 'melee',
    Druid: 'healer', Warden: 'support', Bard: 'cc', Enchanter: 'caster', Eldritch: 'caster', Mentalist: 'caster',
    Animist: 'caster', Vampiir: 'melee', Bainshee: 'caster', MaulerHib: 'melee',
    Guardian: 'melee', Naturalist: 'healer', Magician: 'caster', Forester: 'caster', Stalker: 'melee',
};

/** The guess on a contact. */
export interface ClassGuess {
    /** Most likely first; only those within reach of the first (p at least a tenth of its), at most 5. */
    classes: string[];
    /** Each one's share, same order, rounded to 0.01. */
    p: number[];
    /** The role, when 60 % of the weight agrees on one. */
    role?: FoeRole;
    /** What it went by, for the log: "race Dwarf", "armour chain", "weapons slash+shield", "spells 3", "styles 2". */
    basis: string[];
}

/** One sighting's look at an enemy player (Sighting.look). */
export interface FoeLook {
    /** [slot, model] of what it wears and holds (0x15). */
    gear?: [number, number][];
    /** Client effect ids of the spells it started or landed (0x72, 0x1B with it as the caster). */
    effects?: number[];
    /** Style animations of its swings (0xBC), plain swings left out. */
    styles?: number[];
    /** Models of the weapons it swung or shot with (0xBC). */
    weapons?: number[];
    /** It started a cast (0x72): a spell with a cast time. */
    cast?: true;
    /** It swung a weapon (0xBC, not a spell's damage). */
    swung?: true;
}

/** All that is known of one enemy player: the board unions every member's looks. */
export interface FoeEvidence {
    /** The name it shows: an enemy player's race. */
    race: string;
    realm: Realm;
    level: number;
    gear: Map<number, number>;
    effects: Set<number>;
    styles: Set<number>;
    weapons: Set<number>;
    /** Seen starting a cast at least once. */
    cast: boolean;
    /** How long it has been seen swinging, in ms: a fighter that never casts in all that time is no caster. */
    swingMs: number;
    /** When a look last said it swung. */
    swungAt: number;
}

export function newEvidence(race: string, realm: Realm, level: number): FoeEvidence {
    return { race, realm, level, gear: new Map(), effects: new Set(), styles: new Set(), weapons: new Set(), cast: false, swingMs: 0, swungAt: 0 };
}

/** Swinging time a look adds at most: looks come 4 times a second per member, and a gap means it stopped. */
const SWING_STEP_MS = 1000;

/** Adds a look seen at `now`; true when it brought something new. */
export function addLook(ev: FoeEvidence, look: FoeLook | undefined, level?: number, now = Date.now()): boolean {
    let changed = false;
    if (level !== undefined && level !== ev.level) { ev.level = level; changed = true; }
    if (!look) return changed;
    if (look.cast && !ev.cast) { ev.cast = true; changed = true; }
    if (look.swung) {
        const before = quietLevel(ev);
        if (ev.swungAt && now > ev.swungAt) ev.swingMs += Math.min(SWING_STEP_MS, now - ev.swungAt);
        ev.swungAt = Math.max(ev.swungAt, now);
        if (quietLevel(ev) !== before) changed = true;
    }
    for (const [slot, model] of look.gear ?? []) if (ev.gear.get(slot) !== model) { ev.gear.set(slot, model); changed = true; }
    for (const e of look.effects ?? []) if (!ev.effects.has(e)) { ev.effects.add(e); changed = true; }
    for (const s of look.styles ?? []) if (!ev.styles.has(s)) { ev.styles.add(s); changed = true; }
    for (const w of look.weapons ?? []) if (!ev.weapons.has(w)) { ev.weapons.add(w); changed = true; }
    return changed;
}

// ── Tables from the static data ─────────────────────────────────────────────

/** eObjectType → armour level on the realms' common scale (AbstractServerRules.CheckAbilityToUseItem: reinforced as studded, scale as chain). */
const ARMOUR_LEVEL: Record<number, number> = { 32: 1, 33: 2, 34: 3, 35: 4, 36: 5, 37: 3, 38: 4 };
const ARMOUR_NAME: Record<number, string> = { 1: 'cloth', 2: 'leather', 3: 'studded/reinforced', 4: 'chain/scale', 5: 'plate' };
/** eObjectType → weapon family, one name for the realms' versions of a weapon. */
const FAMILY: Record<number, string> = {
    2: 'crush', 3: 'slash', 4: 'thrust', 5: 'bow', 6: 'twohand', 7: 'polearm', 8: 'staff', 9: 'bow', 10: 'crossbow', 24: 'flex',
    11: 'slash', 12: 'crush', 13: 'slash', 14: 'polearm', 15: 'bow', 16: 'thrown', 17: 'leftaxe', 25: 'h2h',
    18: 'bow', 19: 'slash', 20: 'crush', 21: 'thrust', 22: 'twohand', 23: 'polearm', 26: 'scythe', 27: 'mauler', 28: 'mauler',
    42: 'shield', 45: 'instrument',
};
/** Ability key → family (Abilities.cs Weapon_*). */
function abilityFamily(key: string): string | null {
    const k = key.replace(/^Weaponry: /, '').toLowerCase();
    if (k === key.toLowerCase()) return null;
    if (/^(crushing|hammers|blunt)$/.test(k)) return 'crush';
    if (/^(slashing|swords|axes|blades)$/.test(k)) return 'slash';
    if (/^(thrusting|piercing)$/.test(k)) return 'thrust';
    if (/^(two handed|large weapons)$/.test(k)) return 'twohand';
    if (/spears?$|^polearms$/.test(k)) return 'polearm';
    if (/staves$/.test(k)) return 'staff';
    if (/bows?$|^archery$/.test(k)) return 'bow';
    if (k === 'crossbow') return 'crossbow';
    if (k === 'flexible') return 'flex';
    if (k === 'thrown') return 'thrown';
    if (k === 'left axes') return 'leftaxe';
    if (k === 'hand to hand') return 'h2h';
    if (k === 'scythe') return 'scythe';
    if (k === 'instruments') return 'instrument';
    if (/fist wraps|mauler staff/.test(k)) return 'mauler';
    return null;
}
/** Lines that put a weapon in the left hand (GameLiving.CanUseLefthandedWeapon). */
const DUAL_SPECS = new Set(['Dual Wield', 'Left Axe', 'Celtic Dual', 'Hand to Hand', 'Fist Wraps']);
/** 0xBC style values of a dual wield's plain swings: PacketLib186.cs:33-45 (1.86+), PacketLib168.cs:3788-3800 (older). */
const DUAL_ANIMS = new Set([0x3E81, 0x3E82, 0x1F5, 0x1F6]);
const ARMOUR_SLOTS = new Set([21, 22, 23, 25, 27, 28]);
const WEAPON_SLOTS = new Set([10, 11, 12, 13]);

const memo = <T>(f: () => T) => { let v: T | undefined; return () => (v ??= f()); };

/** Per model: armour levels by slot (item type), and weapon families. */
const modelTables = memo(() => {
    const armour = new Map<string, Set<number>>();
    const families = new Map<number, Set<string>>();
    /** Shields: how many items of each size (Type_Damage 1 small, 2 medium, 3 large) use the model. A model serves several sizes. */
    const shieldSizes = new Map<number, number[]>();
    for (const t of getItemTemplates()) {
        if (t.objectType === 42 && t.typeDamage >= 1 && t.typeDamage <= 3) (shieldSizes.get(t.model) ?? shieldSizes.set(t.model, [0, 0, 0, 0]).get(t.model)!)[t.typeDamage]!++;
        const lvl = ARMOUR_LEVEL[t.objectType];
        if (lvl !== undefined && ARMOUR_SLOTS.has(t.itemType)) {
            const k = `${t.itemType}:${t.model}`;
            (armour.get(k) ?? armour.set(k, new Set()).get(k)!).add(lvl);
        }
        const fam = FAMILY[t.objectType];
        if (fam && WEAPON_SLOTS.has(t.itemType)) (families.get(t.model) ?? families.set(t.model, new Set()).get(t.model)!).add(fam);
    }
    return { armour, families, shieldSizes };
});

const styleById = memo(() => new Map<number, StyleInfo>(getStyles().map(s => [s.id, s])));
/** style.TwoHandAnimation by style id: not in the generated data, so from the dump when it is there. */
const twoHandAnims = memo(() => {
    const out = new Map<number, number>();
    try {
        for (const r of loadTable('style')) if (Number(r.TwoHandAnimation)) out.set(Number(r.ID), Number(r.TwoHandAnimation));
    } catch { /* no server checkout: icons alone */ }
    return out;
});

/** What a class can have, each with the lowest character level that can have it. */
interface ClassKit {
    cls: ClassInfo;
    armour: { level: number; at: number }[];
    shield: { level: number; at: number }[];
    families: Map<string, number>;
    dualAt: number;
    effects: Map<number, number>;
    styles: Map<number, number>;
    /** Lowest level of each of its spells with a cast time: a class with several casts in a fight. */
    castTimed: number[];
}

const levelOf = (specLevel: number, acquired: number) => Math.max(1, specLevel, acquired);

function buildKit(cls: ClassInfo): ClassKit {
    const kit: ClassKit = { cls, armour: [], shield: [], families: new Map(), dualAt: Infinity, effects: new Map(), styles: new Map(), castTimed: [] };
    const at = (m: Map<number | string, number>, k: number | string, lvl: number) => { if (lvl < (m.get(k) ?? Infinity)) m.set(k, lvl); };
    for (const row of cls.specializations) {
        const spec = getSpecialization(row.spec);
        if (DUAL_SPECS.has(row.spec)) kit.dualAt = Math.min(kit.dualAt, levelOf(1, row.levelAcquired));
        for (const a of spec?.abilities ?? []) {
            if (a.classId && a.classId !== cls.id) continue;
            const lvl = levelOf(a.specLevel, row.levelAcquired);
            if (/^(Alb|Mid|Hib)Armor$/.test(a.abilityKey)) kit.armour.push({ level: a.abilityLevel, at: lvl });
            else if (a.abilityKey === 'Shield') kit.shield.push({ level: a.abilityLevel, at: lvl });
            else {
                const fam = abilityFamily(a.abilityKey);
                if (fam) at(kit.families as Map<string, number>, fam, lvl);
            }
        }
    }
    let lines: ReturnType<typeof getClassSkills> = [];
    let baseline: ReturnType<typeof getBaselineSkills> = [];
    try { lines = getClassSkills(cls.key, { characterLevel: 50 }); baseline = getBaselineSkills(cls.key); } catch { /* a class the skills table can't place */ }
    const spellEffects = (id: number | undefined, lvl: number) => {
        const s = id !== undefined ? getSpell(id) : undefined;
        if (!s) return;
        at(kit.effects as Map<number, number>, s.clientEffect, lvl);
        const sub = s.subSpellId ? getSpell(s.subSpellId) : undefined;
        if (sub) at(kit.effects as Map<number, number>, sub.clientEffect, lvl);
    };
    for (const line of lines) {
        for (const sk of line.skills) {
            const lvl = levelOf(sk.specLevel, line.levelAcquired);
            if (sk.kind === 'spell' || sk.kind === 'song') {
                spellEffects(sk.dataId, lvl);
                if ((getSpell(sk.dataId ?? -1)?.castTime ?? 0) > 0) kit.castTimed.push(lvl);
            }
            if (sk.kind === 'style' && sk.dataId !== undefined) {
                const st = styleById().get(sk.dataId);
                if (!st) continue;
                at(kit.styles as Map<number, number>, st.icon, lvl);
                const two = twoHandAnims().get(st.id);
                if (two) at(kit.styles as Map<number, number>, two, lvl);
                for (const pr of st.procs ?? []) if (!pr.classId || pr.classId === cls.id) spellEffects(pr.spellId, lvl);
            }
        }
    }
    for (const line of baseline) {
        for (const sk of line.skills) {
            if (sk.kind !== 'spell' && sk.kind !== 'song') continue;
            spellEffects(sk.dataId, levelOf(sk.specLevel, line.levelAcquired));
            if ((getSpell(sk.dataId ?? -1)?.castTime ?? 0) > 0) kit.castTimed.push(levelOf(sk.specLevel, line.levelAcquired));
        }
    }
    return kit;
}

const kits = memo(() => getClasses().map(buildKit));

/** What the reader holds a class can show at `level`: spell effects, style animations, weapon families, best armour and shield. For tests and tools. */
export function classKit(classKey: string, level = 50): { effects: number[]; styles: number[]; families: string[]; armour: number; shield: number; castTimed: number } | null {
    const k = kits().find(x => x.cls.key === classKey);
    if (!k) return null;
    const upTo = <T>(m: Map<T, number>) => [...m].filter(([, at]) => at <= level).map(([v]) => v);
    return { effects: upTo(k.effects), styles: upTo(k.styles), families: upTo(k.families), armour: best(k.armour, level), shield: best(k.shield, level), castTimed: k.castTimed.filter(at => at <= level).length };
}

const best = (list: { level: number; at: number }[], level: number) => list.reduce((m, a) => a.at <= level ? Math.max(m, a.level) : m, 0);

/** The class keys of a realm whose race list has this race; all of the realm's when the race isn't one. */
function raceId(name: string): number | null {
    const norm = name.replace(/[\s-]/g, '').toLowerCase();
    const r = getRace(name) ?? getRace(norm);
    if (r) return r.id;
    for (let id = 1; id < 40; id++) { const x = getRace(id); if (x && x.name.replace(/[\s-]/g, '').toLowerCase() === norm) return x.id; }
    return null;
}

/** Seen swinging this long and never casting: 1 after QUIET_MS[0], 2 after QUIET_MS[1]. */
const QUIET_MS = [10_000, 25_000];
/** A class with this many cast-time spells at the level is one that casts in a fight: a Thane (17 at 24), not a Paladin (5) or Champion (4), whose bots go whole rounds without one. */
const CASTER_SPELLS = 8;
function quietLevel(ev: FoeEvidence): number {
    return ev.cast ? 0 : QUIET_MS.filter(ms => ev.swingMs >= ms).length;
}

/** Per evidence kind, how much a class that couldn't show it is kept. */
const MISS = { quiet: [1, 0.3, 0.1], armour: 0.02, armourBelow: 0.3, weapon: 0.02, shieldSize: 0.1, dual: 0.05, effect: 0.05, style: 0.05, base: 0.05, uncreatable: 0.3 };

/** The guess from everything known of one enemy player. Null for a realm with no classes (a monster's). */
export function readClass(ev: FoeEvidence): ClassGuess | null {
    const realmNo = ev.realm === 'albion' ? 1 : ev.realm === 'midgard' ? 2 : ev.realm === 'hibernia' ? 3 : 0;
    const race = raceId(ev.race);
    const all = kits().filter(k => k.cls.realm === realmNo && CLASS_ROLES[k.cls.key]);
    if (!all.length) return null;
    const pool = race !== null && all.some(k => k.cls.eligibleRaceIds.includes(race)) ? all.filter(k => k.cls.eligibleRaceIds.includes(race)) : all;
    const L = ev.level || 50;
    const w = new Map<ClassKit, number>(pool.map(k => [k, (k.cls.isBaseClass ? (L >= 5 ? MISS.base : 1) : (L < 5 ? MISS.base : 1)) * (k.cls.creatable ? 1 : MISS.uncreatable)]));
    const basis: string[] = [];
    if (race !== null && pool !== all) basis.push(`race ${ev.race}`);
    const { armour, families, shieldSizes } = modelTables();
    /** The share of a shield model's items a class with this shield ability could carry, at least MISS.shieldSize. */
    const shieldFits = (model: number, ability: number) => {
        const n = shieldSizes.get(model);
        const all = n ? n[1]! + n[2]! + n[3]! : 0;
        if (!all) return ability > 0 ? 1 : MISS.weapon;
        return ability <= 0 ? MISS.weapon : Math.max(MISS.shieldSize, n!.slice(1, ability + 1).reduce((a, b) => a + b, 0) / all);
    };

    // Armour: the heaviest piece it surely wears; a class that can't wear it nearly goes, one that wears below its best a little.
    let worn = 0;
    for (const [slot, model] of ev.gear) {
        if (!ARMOUR_SLOTS.has(slot)) continue;
        const lv = armour.get(`${slot}:${model}`);
        if (lv?.size) worn = Math.max(worn, Math.min(...lv));
    }
    if (worn) {
        basis.push(`armour ${ARMOUR_NAME[worn]}`);
        for (const [k, v] of w) {
            const max = best(k.armour, L);
            w.set(k, v * (max < worn ? MISS.armour : MISS.armourBelow ** (max - worn)));
        }
    }

    // Weapons: each one held or swung is a family the class must have; a shield a shield ability; a weapon in the left hand dual wielding.
    const held: string[] = [];
    const weaponModels: { model: number; left: boolean }[] = [];
    for (const [slot, model] of ev.gear) if (WEAPON_SLOTS.has(slot)) weaponModels.push({ model, left: slot === 11 });
    for (const model of ev.weapons) weaponModels.push({ model, left: false });
    for (const { model, left } of weaponModels) {
        const fams = families.get(model);
        if (!fams?.size) continue;
        held.push([...fams].sort().join('|'));
        for (const [k, v] of w) {
            let f = Math.max(...[...fams].map(fam => fam === 'shield' ? shieldFits(model, best(k.shield, L)) : (k.families.get(fam) ?? Infinity) <= L ? 1 : MISS.weapon));
            if (left && !fams.has('shield') && k.dualAt > L) f *= MISS.dual;
            w.set(k, v * f);
        }
    }
    if (held.length) basis.push(`weapons ${[...new Set(held)].join(' ')}`);

    // Spells and styles: one only some classes of the realm can have (at any level) counts against the rest.
    const realmAll = kits().filter(k => k.cls.realm === realmNo);
    const counted = (kind: 'effects' | 'styles', ids: Iterable<number>, miss: number) => {
        let n = 0;
        for (const id of ids) {
            if (!realmAll.some(k => k[kind].has(id))) continue;
            n++;
            for (const [k, v] of w) w.set(k, v * ((k[kind].get(id) ?? Infinity) <= L ? 1 : miss));
        }
        return n;
    };
    const spells = counted('effects', ev.effects, MISS.effect);
    if (spells) basis.push(`spells ${spells}`);
    const styles = counted('styles', [...ev.styles].filter(s => !DUAL_ANIMS.has(s)), MISS.style);
    if ([...ev.styles].some(s => DUAL_ANIMS.has(s))) {
        for (const [k, v] of w) if (k.dualAt > L) w.set(k, v * MISS.dual);
        basis.push('dual wield');
    }
    if (styles) basis.push(`styles ${styles}`);

    // A fighter seen swinging for a while that never once started a cast: not a class that casts in its fights.
    const quiet = quietLevel(ev);
    if (quiet) {
        for (const [k, v] of w) if (k.castTimed.filter(at => at <= L).length >= CASTER_SPELLS) w.set(k, v * MISS.quiet[quiet]!);
        basis.push(`no casts in ${Math.round(ev.swingMs / 1000)} s of swinging`);
    }

    const total = [...w.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const ranked = [...w].map(([k, v]) => ({ key: k.cls.key, p: v / total })).sort((a, b) => b.p - a.p || a.key.localeCompare(b.key));
    const top = ranked[0]!.p;
    const shown = ranked.filter(r => r.p >= top / 10).slice(0, 5);
    const byRole = new Map<FoeRole, number>();
    for (const r of ranked) byRole.set(CLASS_ROLES[r.key]!, (byRole.get(CLASS_ROLES[r.key]!) ?? 0) + r.p);
    const [role, mass] = [...byRole].sort((a, b) => b[1] - a[1])[0]!;
    return {
        classes: shown.map(r => r.key),
        p: shown.map(r => Math.round(r.p * 100) / 100),
        ...(mass >= 0.6 ? { role } : {}),
        basis,
    };
}

/** The role a class plays (CLASS_ROLES), for scoring a guess against a known class. */
export function roleOfClass(className: string): FoeRole | undefined {
    return CLASS_ROLES[className] ?? CLASS_ROLES[getClasses().find(c => c.name === className)?.key ?? ''];
}
