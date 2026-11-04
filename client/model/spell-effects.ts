// What a 0x1B's effect says about the cast: it is the spell's ClientEffect (SpellHandler.cs:1284-1291),
// the one thing on the packet that tells one spell of ours from another.

import { getSpells } from '../../data/index';

interface SpellEffects {
    summons: Set<number>;
    minions: Set<number>;
    charms: Set<number>;
    pulsingCharms: Set<number>;
}

let effects: SpellEffects | null = null;

function spellEffects(): SpellEffects {
    if (effects) return effects;
    effects = { summons: new Set(), minions: new Set(), charms: new Set(), pulsingCharms: new Set() };
    try {
        for (const sp of getSpells()) {
            if (!sp.clientEffect) continue;
            if (sp.type === 'Charm') effects.charms.add(sp.clientEffect);
            if (sp.type === 'Charm' && sp.pulse > 0 && sp.frequency > 0) effects.pulsingCharms.add(sp.clientEffect);
            else if (sp.type === 'Bomber' || sp.type.startsWith('Summon')) effects.summons.add(sp.clientEffect);
            if (sp.type === 'SummonMinion') effects.minions.add(sp.clientEffect);
        }
    } catch {
        // No spell table on this install: no cast reads as a summon or a charm.
    }
    return effects;
}

/** A summon's effect, a pet's first 0x1B (SummonSpellHandler.cs:176, :183): no heal or buff shares one with a spell a player casts. */
export function isSummonEffect(effect: number): boolean {
    return spellEffects().summons.has(effect);
}

/** A Bonedancer's minion's effect, on no other spell (spell.sql). It goes with its commander (SummonCommanderPet.cs:25-38). */
export function isMinionEffect(effect: number): boolean {
    return spellEffects().minions.has(effect);
}

/** A charm's effect, on no other spell (spell.sql). */
export function isCharmEffect(effect: number): boolean {
    return spellEffects().charms.has(effect);
}

/** A pulsing charm's: a Minstrel's Melodies, a Mentalist's Enemy line. No charm that doesn't pulse shares one (spell.sql). */
export function isPulsingCharmEffect(effect: number): boolean {
    return spellEffects().pulsingCharms.has(effect);
}
