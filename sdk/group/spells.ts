// What a member can cast, from its spell list and the static spell data:
// heals, crowd control, damage and buffs. Highest-level rank wins, except for heals (pickHeal).

import type { SpellInfo } from '../../data/index';
import type { BotActions } from '../actions';
import { petSpellKind, worstPowerCost } from '../actions-helpers';
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
    /** Seconds until it can be cast again (0 = no timer). */
    recast: number;
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
    /** The icon its effect shows: how a pet buff is seen on the pet (PetState.icons). */
    icon: number;
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
// Of the kinds petSpellKind names, left to their own tactics: a Necromancer's servant (he goes into shade) and an Animist's fire-and-forget turret.
const NOT_AUTOMATIC = new Set(['SummonNecroPet', 'SummonAnimistFnF']);
const isSummon = (s: SpellPick, kind: 'main' | 'fnf') => petSpellKind(s.type) === kind && !NOT_AUTOMATIC.has(s.type);
// A pet buff worth keeping up lasts. That leaves out the 5-8 s pulsing damage shields.
const PET_BUFF_MIN_SECONDS = 60;

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
        spell, type: info.type, target: info.target, range: info.range, radius: info.radius, power: info.power, castTime: info.castTime, duration: info.duration, recast: info.recastDelay ?? 0, concentration: info.concentration,
        pulse: (info.pulse ?? 0) > 0 && (info.frequency ?? 0) > 0, value: info.value ?? 0, damage: info.damage ?? 0, spellGroup: info.spellGroup ?? 0,
        effectGroup: info.effectGroup ?? 0, frequency: info.frequency ?? 0, icon: info.icon ?? 0,
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

/** Hit points a heal restores: a negative value is a percent of the caster's own full health, whoever it lands on (HealSpellHandler.cs:33). */
export const healAmount = (s: Pick<SpellPick, 'value'>, casterMaxHp: number): number => (s.value < 0 ? casterMaxHp * -s.value / 100 : s.value);

/**
 * The heal for a target missing `missing` hit points: the cheapest that covers it, else the one restoring
 * most. Level says nothing here: a Healer has Minor Recovery (48) and Major Reparation (172) both at 18.
 * Without a need, the one restoring most. Cost per hit point is about even across ranks, so the bigger
 * heal also restores faster for the same power. One on a timer (Favor from Eir, 33 % for no power) waits
 * until nothing else covers the need.
 */
export function pickHeal(picks: SpellPick[], need: { missing?: number; casterMaxHp: number }): SpellPick | null {
    const amount = (s: SpellPick) => healAmount(s, need.casterMaxHp);
    const covering = (list: SpellPick[]) => (need.missing === undefined ? [] : list.filter(s => amount(s) >= need.missing!).sort((a, b) => a.power - b.power || a.castTime - b.castTime))[0];
    return covering(picks.filter(s => !s.recast)) ?? covering(picks) ?? [...picks].sort((a, b) => amount(b) - amount(a))[0] ?? null;
}

/** Spell picks for one member; `mana` is its current power (absolute). */
export class Spellbook {
    constructor(private readonly sdk: BotSDK, private readonly bot: BotActions) {}

    all(): SpellPick[] { return spellsOf(this.sdk, this.bot); }

    private ready(s: SpellPick): boolean {
        return (this.sdk.getPlayer()?.mana ?? 0) >= s.power && s.spell.cooldownRemaining <= 0;
    }

    /** Heal on a friend (Realm/Group target, no radius) we can pay for now, by what the target misses (pickHeal). */
    heal(missing?: number): SpellPick | null {
        const ok = this.all().filter(s => HEAL_TYPES.test(s.type) && !s.pulse && (s.target === 'Realm' || s.target === 'Group') && s.radius === 0 && this.ready(s));
        return pickHeal(ok, { missing, casterMaxHp: this.sdk.getPlayer()?.maxHealth ?? 0 });
    }

    /**
     * The same on our pet: a Pet-target heal, and nothing else in here casts those. With none, a heal on a friend at the pet's id (a Druid's: a Realm heal lands on a pet, live). capabilities().heal is about members and takes no notice.
     */
    petHeal(missing?: number): SpellPick | null {
        const need = { missing, casterMaxHp: this.sdk.getPlayer()?.maxHealth ?? 0 };
        const single = this.all().filter(s => HEAL_TYPES.test(s.type) && !s.pulse && s.radius === 0 && this.ready(s));
        return pickHeal(single.filter(s => s.target === 'Pet'), need) ?? pickHeal(single.filter(s => s.target === 'Realm' || s.target === 'Group'), need);
    }

    /**
     * The window pet we summon by ourselves, the top rank (a commander counts; its minions are never ours to summon).
     * Paid for or not, on its timer or not: a percent cost passes ready() at any power, so the caller weighs powerOf and cooldownRemaining.
     */
    summon(): SpellPick | null {
        return best(this.all().filter(s => isSummon(s, 'main')));
    }

    /** A Theurgist's pet, which fights its target alone: the top rank over its lines, weighed like summon(). */
    fnf(): SpellPick | null {
        return best(this.all().filter(s => isSummon(s, 'fnf')));
    }

    /** Whether a window pet of ours stands where it was put: an Animist's main pets (TurretBrain.cs:100-108), by the rule killNpc and petKill go by. */
    knowsTurret(): boolean {
        return this.all().some(s => petSpellKind(s.type) === 'turret');
    }

    /**
     * The most a spell can cost us (worstPowerCost): a flat cost or a percent of the pool without items, 1.2 × for a focus caster with no
     * focus. The server checks that before the cast (SpellHandler.cs:794) and takes it at the end: live, an interrupted summon cost nothing.
     */
    powerOf(s: Pick<SpellPick, 'power'>): number {
        const p = this.sdk.getPlayer();
        return p ? worstPowerCost(s.power, p) : Math.max(0, s.power);
    }

    /**
     * A mezz cast at a target: single-target first; an area mezz (it also mezzes the focus next to
     * the add) only with `aoe`; never a point-blank one (range 0, centred on us: the Spiritmaster's
     * Dark Wave, the Cleric's Heavenly Visions). The highest level used to win, so live RvR runs
     * (20261101-0903xx) cast Dark Wave at enemies 1500 away: "No cast observed", 22 times.
     */
    mezz(opts: { aoe?: boolean } = {}): SpellPick | null {
        const ok = this.all().filter(s => isMezz(s) && s.target === 'Enemy' && s.range > 0 && this.ready(s));
        return best(ok.filter(s => s.radius === 0)) ?? (opts.aoe ? best(ok) : null);
    }

    /** A root ready now: what an NPC under 75 % takes where a mezz can't (CCSpellHandler.cs:174). */
    root(): (SpellPick & { kind: 'root' }) | null {
        const r = best(this.all().filter(s => isRoot(s) && s.target === 'Enemy' && this.ready(s)));
        return r ? { ...r, kind: 'root' } : null;
    }

    /** Crowd control for an add: a mezz when one is ready (area ones only with `aoe`), else a root. */
    cc(opts: { aoe?: boolean } = {}): (SpellPick & { kind: 'mezz' | 'root' }) | null {
        const m = this.mezz(opts);
        return m ? { ...m, kind: 'mezz' } : this.root();
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

    /** Buffs worth keeping up on our pet: the top rank per slot. Never a conversion (it has no slot, and sacrifices the pet). */
    petBuffs(): (SpellPick & { slot: BuffSlot })[] {
        const top = new Map<BuffSlot, SpellPick & { slot: BuffSlot }>();
        for (const s of this.all()) {
            const slot = slotOf(s.type);
            if (!slot || s.target !== 'Pet' || s.pulse || s.duration < PET_BUFF_MIN_SECONDS) continue;
            if (!top.has(slot) || top.get(slot)!.spell.level < s.spell.level) top.set(slot, { ...s, slot });
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
            // On friends: a Cabalist with a Pet-target heal is no healer.
            heal: all.some(s => HEAL_TYPES.test(s.type) && s.target !== 'Enemy' && s.target !== 'Pet'),
            // What cc() casts at an add without aoe (crowd control is assigned by this): a single-target mezz or a root.
            cc: all.some(s => s.target === 'Enemy' && s.range > 0 && ((isMezz(s) && s.radius === 0) || isRoot(s))),
            ...(all.some(s => s.target === 'Enemy' && s.range > 0 && isRoot(s)) ? { root: true } : {}),
            nuke: all.some(s => s.target === 'Enemy' && NUKE_TYPES.test(s.type)),
            buffs: buffs.map(s => s.spell.name),
            buffSpells: buffs.map(s => ({ name: s.spell.name, slot: s.slot, target: s.target, concentration: s.concentration })),
            pet: this.summon() ? 'main' : this.fnf() ? 'fnf' : null,
        };
    }
}
