// What a member can cast, from its spell list and the static spell data:
// heals, crowd control, damage and buffs. Highest-level rank wins.

import type { BotActions } from '../actions';
import type { BotSDK } from '../index';
import type { Spell } from '../types';
import type { Capabilities } from './types';

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
}

const NUKE_TYPES = /^(DirectDamage|Bolt|Lifedrain|DamageOverTime|DirectDamageWithDebuff|DamageSpeedDecrease)$/;
const CC_TYPES = /^Mesmerize$/;
const HEAL_TYPES = /^(Heal|CombatHeal)$/;
const BUFF_TYPES = /Buff|DamageAdd|DamageShield|Ablative|Regen|Resist|Armor|Haste|Absorb/i;
const NOT_BUFFS = /Heal|Mesmerize|Summon|Pet|Resurrect|DirectDamage|Bolt|Lifedrain|Speed/i;

export function spellsOf(sdk: BotSDK, bot: BotActions): SpellPick[] {
    const out: SpellPick[] = [];
    for (const spell of sdk.getSkills().spells ?? []) {
        const info = bot.getSpellInfo(spell);
        if (!info) continue;
        out.push({ spell, type: info.type, target: info.target, range: info.range, radius: info.radius, power: info.power, castTime: info.castTime, duration: info.duration, concentration: info.concentration });
    }
    return out;
}

const best = (list: SpellPick[]) => [...list].sort((a, b) => b.spell.level - a.spell.level)[0] ?? null;

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
        return best(this.all().filter(s => CC_TYPES.test(s.type) && s.target === 'Enemy' && this.ready(s)));
    }

    /**
     * Next damage spell on one target: a DoT not yet on it while it has more than
     * `dotAbove` % health (DoTs don't stack), else the best direct damage.
     * Area spells are left out unless `aoe` (they break mezz on nearby adds).
     */
    nuke(opts: { dotted?: Set<string>; targetHp?: number; dotAbove?: number; aoe?: boolean } = {}): SpellPick | null {
        const ok = this.all().filter(s => s.target === 'Enemy' && NUKE_TYPES.test(s.type) && s.range > 0 && (opts.aoe || s.radius === 0) && this.ready(s));
        const dot = best(ok.filter(s => s.type === 'DamageOverTime' && !opts.dotted?.has(s.spell.name)));
        if (dot && (opts.targetHp ?? 100) > (opts.dotAbove ?? 40)) return dot;
        return best(ok.filter(s => s.type !== 'DamageOverTime'));
    }

    /** Buffs worth keeping up: the top rank per type and target, no pet or enemy spells. */
    buffs(): SpellPick[] {
        const top = new Map<string, SpellPick>();
        for (const s of this.all()) {
            if (s.target === 'Enemy' || s.target === 'Pet' || NOT_BUFFS.test(s.type) || !BUFF_TYPES.test(s.type)) continue;
            if (s.duration <= 0 && s.concentration <= 0) continue;
            const k = `${s.type}:${s.target}`;
            if (!top.has(k) || top.get(k)!.spell.level < s.spell.level) top.set(k, s);
        }
        return [...top.values()];
    }

    capabilities(): Capabilities {
        const all = this.all();
        return {
            heal: all.some(s => HEAL_TYPES.test(s.type) && s.target !== 'Enemy'),
            cc: all.some(s => CC_TYPES.test(s.type)),
            nuke: all.some(s => s.target === 'Enemy' && NUKE_TYPES.test(s.type)),
            buffs: this.buffs().map(s => s.spell.name),
        };
    }
}
