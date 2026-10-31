// What a member can cast, from its spell list and the static spell data:
// heals, crowd control, damage and buffs. Highest-level rank wins.

import type { SpellInfo } from '../../data/index';
import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import type { Spell } from '../types';
import { songKind, type SongKind } from './songs';
import type { BuffSlot, Capabilities } from './types';

export interface SpellPick {
    spell: Spell;
    type: string;
    target: string;
    range: number;
    radius: number;
    power: number;
    castTime: number;
    /** Seconds (0 = instant/permanent). */
    duration: number;
    concentration: number;
    /** A song or chant: keeps pulsing until cancelled; casting it again stops it. */
    pulse: boolean;
    /** The spell's value (for SpeedDecrease: the slow in %, 99 = root). */
    value: number;
    /** Damage per hit, per tick for a DoT. */
    damage: number;
    /** Shared by every rank of one spell (Illusory Ache..Anguish are all 4611); 0 when the DB has none. */
    spellGroup: number;
    /** Server stacking keys: DoTs conflict by effect group, else (same type) by tick frequency. */
    effectGroup: number;
    frequency: number;
}

const NUKE_TYPES = /^(DirectDamage|Bolt|Lifedrain|DamageOverTime|DirectDamageWithDebuff|DamageSpeedDecrease)$/;
// A DoT is worth a cast only when it ticks for at least this share of our best direct damage.
const DOT_MIN_SHARE = 0.25;
const MEZZ_TYPES = /^Mesmerize$/;
// A SpeedDecrease of 99 % is a root (Druid "Webbing Vines"): the add can't walk up to us. It still
// hits whoever stands next to it, and the blackboard drops it as broken when it swings.
const ROOT_TYPES = /^(SpeedDecrease|UnbreakableSpeedDecrease)$/;
const isMezz = (s: SpellPick) => MEZZ_TYPES.test(s.type);
const isRoot = (s: SpellPick) => ROOT_TYPES.test(s.type) && s.value >= 99 && s.radius === 0;
const HEAL_TYPES = /^(Heal|CombatHeal)$/;

/** The buff slot of a spell handler type, or null when it isn't a buff we keep up. */
export function slotOf(type: string): BuffSlot | null {
    switch (type) {
        case 'BaseArmorFactorBuff': return 'af';
        case 'SpecArmorFactorBuff': case 'ArmorFactorBuff': return 'specaf';
        case 'StrengthBuff': return 'str';
        case 'ConstitutionBuff': return 'con';
        case 'DexterityBuff': return 'dex';
        case 'QuicknessBuff': return 'qui';
        case 'StrengthConstitutionBuff': return 'strcon';
        case 'DexterityQuicknessBuff': return 'dexqui';
        case 'AcuityBuff': case 'IntelligenceBuff': return 'acuity';
        case 'CombatSpeedBuff': return 'haste';
        case 'DamageShield': return 'dmgshield';
        case 'DamageAdd': return 'dmgadd';
    }
    if (/Ablative|Absorb|Bladeturn/i.test(type)) return 'absorb';
    if (/Regen/i.test(type)) return 'regen';
    if (/Resist/i.test(type) && /Buff/i.test(type)) return 'resist';
    return null;
}

/** A known spell with its static data. */
export function toPick(spell: Spell, info: SpellInfo): SpellPick {
    return {
        spell, type: info.type, target: info.target, range: info.range, radius: info.radius, power: info.power, castTime: info.castTime, duration: info.duration, concentration: info.concentration,
        pulse: (info.pulse ?? 0) > 0 && (info.frequency ?? 0) > 0, value: info.value ?? 0, damage: info.damage ?? 0, spellGroup: info.spellGroup ?? 0,
        effectGroup: info.effectGroup ?? 0, frequency: info.frequency ?? 0,
    };
}

export function spellsOf(sdk: BotSDK, bot: BotActions): SpellPick[] {
    const out: SpellPick[] = [];
    for (const spell of sdk.getSkills().spells ?? []) {
        const info = bot.getSpellInfo(spell);
        if (info) out.push(toPick(spell, info));
    }
    return out;
}

const best = (list: SpellPick[]) => [...list].sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;

/**
 * The DoTs a new one would overwrite on the server, as a key: DoTSpellHandler.HasConflictingEffectWith
 * matches on effect group when either has one, else (both DamageOverTime) on tick frequency, so a
 * Mentalist's Illusory line (frequency 50) and Mind Fade (40) stack, and all Illusory ranks don't.
 */
export const dotFamily = (s: Pick<SpellPick, 'effectGroup' | 'frequency'>): string => (s.effectGroup ? `e${s.effectGroup}` : `f${s.frequency}`);

export interface NukeOptions {
    /** DoT family keys (dotFamily) already on the target. */
    dotted?: ReadonlySet<string>;
    /** The target's health in % (default 100). */
    targetHp?: number;
    /** DoTs only while the target has more than this % health (default 40). */
    dotAbove?: number;
    /** Allow area spells (they break mezz on nearby adds). */
    aoe?: boolean;
    /** Castable now (power, cooldown); default: every spell. */
    ready?: (s: SpellPick) => boolean;
}

/**
 * Next damage spell on one target, from the spells a member knows: the best DoT
 * whose family isn't on the target yet while it has more than `dotAbove` % health,
 * else the best direct damage. A DoT must tick for at least a quarter of our best
 * direct damage (Illusory Anguish 19 against Moon Blast 49, not Ache or Minor Mind
 * Fade at 2); without direct damage every DoT qualifies. The bar is the best direct
 * damage we know, ready or not, so low power never makes a weak DoT worth a cast.
 * Area spells are left out unless `aoe` (they break mezz on nearby adds).
 */
export function pickNuke(picks: SpellPick[], opts: NukeOptions = {}): SpellPick | null {
    const ready = opts.ready ?? (() => true);
    const ok = picks.filter(s => s.target === 'Enemy' && NUKE_TYPES.test(s.type) && s.range > 0 && (opts.aoe || s.radius === 0));
    const isDot = (s: SpellPick) => s.type === 'DamageOverTime';
    const top = best(ok.filter(s => !isDot(s)));
    const dot = best(ok.filter(s => isDot(s) && ready(s) && !opts.dotted?.has(dotFamily(s)) && (!top || s.damage >= DOT_MIN_SHARE * top.damage)));
    if (dot && (opts.targetHp ?? 100) > (opts.dotAbove ?? 40)) return dot;
    return best(ok.filter(s => !isDot(s) && ready(s)));
}

/** Spell picks for one member; `mana` is its current power (absolute). */
export class Spellbook {
    constructor(private readonly sdk: BotSDK, private readonly bot: BotActions) {}

    all(): SpellPick[] { return spellsOf(this.sdk, this.bot); }

    private ready(s: SpellPick): boolean {
        return (this.sdk.getPlayer()?.mana ?? 0) >= s.power && s.spell.cooldownRemaining <= 0;
    }

    /** Single-target heal on a friend (Realm/Group target, no radius). */
    heal(): SpellPick | null {
        return best(this.all().filter(s => HEAL_TYPES.test(s.type) && (s.target === 'Realm' || s.target === 'Group') && s.radius === 0 && this.ready(s)));
    }

    mezz(): SpellPick | null {
        return best(this.all().filter(s => isMezz(s) && s.target === 'Enemy' && this.ready(s)));
    }

    /** Crowd control for an add: a mezz when one is ready, else a root. */
    cc(): (SpellPick & { kind: 'mezz' | 'root' }) | null {
        const m = this.mezz();
        if (m) return { ...m, kind: 'mezz' };
        const r = best(this.all().filter(s => isRoot(s) && s.target === 'Enemy' && this.ready(s)));
        return r ? { ...r, kind: 'root' } : null;
    }

    /**
     * Next damage spell on one target that we can cast now (pickNuke). `dotted` holds
     * the family keys (dotFamily) of the DoTs already on it, not spell names.
     */
    nuke(opts: Omit<NukeOptions, 'ready'> = {}): SpellPick | null {
        return pickNuke(this.all(), { ...opts, ready: s => this.ready(s) });
    }

    /** Buffs worth keeping up: the top rank per slot and target, no pet or enemy spells. */
    buffs(): (SpellPick & { slot: BuffSlot })[] {
        const top = new Map<string, SpellPick & { slot: BuffSlot }>();
        for (const s of this.all()) {
            const slot = slotOf(s.type);
            // Songs are played one at a time by situation (songs.ts), not kept up like buffs.
            if (!slot || s.pulse || s.target === 'Enemy' || s.target === 'Pet') continue;
            if (s.duration <= 0 && s.concentration <= 0) continue;
            const k = `${slot}:${s.target}`;
            if (!top.has(k) || top.get(k)!.spell.level < s.spell.level) top.set(k, { ...s, slot });
        }
        return [...top.values()];
    }

    /** Friendly songs we can play, the top rank per kind (only one plays at a time). */
    songs(): (SpellPick & { kind: SongKind })[] {
        const top = new Map<SongKind, SpellPick & { kind: SongKind }>();
        for (const s of this.all()) {
            const kind = songKind(s);
            if (!kind) continue;
            if (!top.has(kind) || top.get(kind)!.spell.level < s.spell.level) top.set(kind, { ...s, kind });
        }
        return [...top.values()];
    }

    capabilities(): Capabilities {
        const all = this.all();
        const buffs = this.buffs();
        return {
            heal: all.some(s => HEAL_TYPES.test(s.type) && s.target !== 'Enemy'),
            cc: all.some(s => s.target === 'Enemy' && (isMezz(s) || isRoot(s))),
            nuke: all.some(s => s.target === 'Enemy' && NUKE_TYPES.test(s.type)),
            buffs: buffs.map(s => s.spell.name),
            buffSpells: buffs.map(s => ({ name: s.spell.name, slot: s.slot, target: s.target, concentration: s.concentration })),
        };
    }
}
